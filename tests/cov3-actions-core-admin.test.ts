import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// =============================================================================
// api/actions/admin.ts — handler-level behaviour suite (coverage phase 3,
// unit actions-core). Every handler is driven with the payload the dispatcher
// would hand it (actor fields + the injected `user` record present), and the
// suite pins:
//   · the exact db-layer function and args — and for config writes, that
//     stripActorFields (REAL, from api/services) removed userId / user / every
//     ACTOR_ID_FIELDS name before the blob reaches the db, and that the handler
//     returns NOTHING (a settings write never echoes stored config/secrets);
//   · the in-handler apex gates: genuine-Admin by role IDENTITY (never role
//     name), the cache-free re-check for the recovery family, the two-bar
//     domain reset, the Danger-Zone phrase, the client-feedback read gate;
//   · the role-write guards (promote ceiling, mapping guards, Client lock,
//     escalation guard, protected system roles) run BEFORE the write;
//   · input validation: bulk id arrays, Discord channel snowflakes, import size.
// =============================================================================

const h = vi.hoisted(() => ({
    // Every db-barrel function admin.ts calls (grep -o "db.[a-zA-Z]*" api/actions/admin.ts).
    dbFns: [
        'addAnnouncement', 'addCertification', 'addCommendation', 'addConductEntry', 'addExternalTool', 'addLimitingMarker',
        'addLocation', 'addRadioChannel', 'addRank', 'addRole', 'addServiceType', 'addSpecializationTag', 'addUnit',
        'adminAdjustUserReputation', 'assertCanAssignRole', 'assertCanChangeUsersRole', 'assertCanManageRolePermissions',
        'assertRoleIsMappable', 'assertRoleIsNotClient', 'awardCertification', 'awardCommendation', 'bulkAssignUsersPosition',
        'bulkAssignUsersRank', 'bulkAssignUsersUnit', 'bulkAwardCertification', 'bulkAwardCommendation', 'bulkDemoteUsersToClient',
        'bulkPromoteUsersToMember', 'bulkSetUsersAffiliate', 'bulkSetUsersVip', 'bulkUpdateUserClearances', 'bulkUpsertAchievements',
        'deleteAnnouncement', 'deleteCertification', 'deleteCommendation', 'deleteConductEntry', 'deleteExternalTool',
        'deleteLimitingMarker', 'deleteLocation', 'deleteRadioChannel', 'deleteRank', 'deleteRole', 'deleteServiceType',
        'deleteSpecializationTag', 'deleteUnit', 'fullResetOrg', 'fullWipeOrg', 'getIntelSharingConfig', 'getPlatformSettings',
        'getRatingHistoryForUser', 'getReputationHistoryForUser', 'getRoleDetails', 'getSystemRoles', 'getTestimonialCandidates',
        'importOrgData', 'listSecurityEvents', 'previewAchievementImport', 'promoteUserToMember', 'pruneDatabaseData',
        'recordSecurityEvent', 'reorderExternalTool', 'repairDatabase', 'resetFinancesData', 'resetQuartermasterData',
        'resolveIsSystemAdminFresh', 'revokeCertification', 'revokeCommendation', 'revokeUserSessions', 'rotateSecretsEncryption',
        'runDatabaseHealthCheck', 'seedDefaultLocations', 'syncAllMemberRoles', 'syncUserRoles', 'toggleUserAffiliateStatus',
        'toggleUserDutyStatus', 'toggleUserVipStatus', 'updateAIConfig', 'updateAnnouncement', 'updateBrandingConfig',
        'updateCertification', 'updateCommendation', 'updateDiscordSettings', 'updateExternalTool', 'updateHRConfig',
        'updateHeroCardConfig', 'updateIntelSharingConfig', 'updateLimitingMarker', 'updateLocation', 'updateOpenGraphConfig',
        'updateOrgFeatures', 'updatePlatformSettings', 'updatePublicPageConfig', 'updateRadioChannel', 'updateRadioConfig',
        'updateRank', 'updateRankMapping', 'updateRole', 'updateRolePermissions', 'updateSecurityClearance', 'updateServiceType',
        'updateSpecializationTag', 'updateThemeConfig', 'updateUnit', 'updateUser', 'updateUserClearance', 'updateWikiHomeConfig',
    ] as const,
    db: {} as Record<string, Mock<(...args: any[]) => any>>,
    sbCalls: [] as Array<{ table: string; ops: unknown[][] }>,
    roleRow: { data: null as unknown, error: null as unknown },
    syncDiscordRoles: vi.fn(),
    invalidatePublicCache: vi.fn(),
}));

function sbFrom(table: string) {
    const rec = { table, ops: [] as unknown[][] };
    h.sbCalls.push(rec);
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) b[m] = (...args: unknown[]) => { rec.ops.push([m, ...args]); return b; };
    b.single = async () => { rec.ops.push(['single']); return h.roleRow; };
    return b;
}

vi.mock('../lib/db', () => {
    const mod: Record<string, unknown> = { supabase: { from: (t: string) => sbFrom(t) } };
    // Lazily resolved so each test's fresh vi.fn (beforeEach) is what the handler calls.
    for (const name of h.dbFns) {
        mod[name] = (...args: unknown[]) => h.db[name](...args);
    }
    return mod;
});
vi.mock('../lib/discord', () => ({ syncDiscordRoles: h.syncDiscordRoles }));
vi.mock('../api/public', () => ({ invalidatePublicCache: h.invalidatePublicCache }));

import { adminActions } from '../api/actions/admin';
import { ACTOR_ID_FIELDS } from '../api/services';
import { SecurityDenial } from '../lib/errors';

type AnyHandler = (p?: any) => any;
const act = (name: string) => (adminActions as unknown as Record<string, AnyHandler>)[name];

const NOT_ADMIN = 'Only an Admin may perform this action.';
// Genuine Admin = the STAMPED system Admin role (role identity), never a role name.
const ADMIN = { id: 1, roleId: 4, role: 'Admin', isSystemAdmin: true, permissions: ['admin:access', 'finance:manage', 'qm:manage', 'request:view:feedback'] };
// The seeded Dispatcher holds admin:access — a delegated perm, not Admin identity.
const DISPATCHER = { id: 50, roleId: 2, role: 'Dispatcher', isSystemAdmin: false, permissions: ['admin:access', 'finance:manage', 'qm:manage'] };
// A permissionless custom role literally NAMED Admin.
const FORGED_NAME = { id: 51, roleId: 9, role: 'Admin', permissions: [] };

/** The actor fields the dispatcher would have injected / overwritten on every payload. */
const injected = (user: Record<string, unknown> = ADMIN) => ({
    userId: user.id, adminId: user.id, creatorId: user.id, authorId: user.id, interviewerId: 77, user,
});

function expectNoActorFields(blob: Record<string, unknown>) {
    for (const f of [...ACTOR_ID_FIELDS, 'user', 'interviewerId']) expect(blob, f).not.toHaveProperty(f);
}

beforeEach(() => {
    h.db = Object.fromEntries(h.dbFns.map((n) => [n, vi.fn(async () => ({ from: n }))]));
    h.sbCalls.length = 0;
    h.roleRow = { data: null, error: null };
    h.syncDiscordRoles.mockReset();
    h.invalidatePublicCache.mockReset();
});
afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe('security audit trail read', () => {
    it('admin:security:list_events forwards the filters only (actorUserId is a FILTER and survives; the injected actor does not)', async () => {
        const out = await act('admin:security:list_events')({ ...injected(), actorUserId: 33, event: 'authz.denied', since: 's', until: 'u', limit: 50, beforeId: 9 });
        expect(out).toEqual({ from: 'listSecurityEvents' });
        const filters = h.db.listSecurityEvents.mock.calls[0][0];
        expect(filters).toEqual({ actorUserId: 33, event: 'authz.denied', since: 's', until: 'u', limit: 50, beforeId: 9 });
    });
});

// ---------------------------------------------------------------------------
describe('settings & config writes — stripped blob in, nothing out', () => {
    it.each([
        ['admin:update_discord_config', 'updateDiscordSettings', { clientId: 'cid', clientSecret: 'NEW-SECRET', botToken: 'NEW-BOT' }],
        ['admin:update_hero_config', 'updateHeroCardConfig', { title: 'Hero', enabled: true }],
        ['admin:update_branding_config', 'updateBrandingConfig', { orgName: 'Org', primaryColor: '#123456' }],
        ['admin:update_theme_config', 'updateThemeConfig', { enabled: true, accent: 'teal' }],
        ['admin:update_opengraph_config', 'updateOpenGraphConfig', { title: 'OG', description: 'd' }],
        ['admin:update_ai_config', 'updateAIConfig', { enabled: true, apiKey: 'GEMINI-NEW' }],
        ['admin:update_wiki_home_config', 'updateWikiHomeConfig', { heroTitle: 'Wiki' }],
    ])('%s → db.%s(stripped config) and returns undefined', async (action, dbFn, config) => {
        h.db[dbFn].mockResolvedValue({ clientSecret: 'STORED-SECRET', apiKey: 'STORED-KEY' });
        const out = await act(action)({ ...injected(), ...config });
        expect(out).toBeUndefined();
        expect(h.db[dbFn]).toHaveBeenCalledTimes(1);
        const blob = h.db[dbFn].mock.calls[0][0];
        expect(blob).toEqual(config);
        expectNoActorFields(blob);
    });

    it('admin:update_public_page_config writes the stripped config, THEN invalidates the public cache', async () => {
        const out = await act('admin:update_public_page_config')({ ...injected(), enabled: true, featuredTestimonialIds: ['t1'] });
        expect(out).toBeUndefined();
        expect(h.db.updatePublicPageConfig).toHaveBeenCalledWith({ enabled: true, featuredTestimonialIds: ['t1'] });
        expect(h.invalidatePublicCache).toHaveBeenCalledTimes(1);
        expect(h.db.updatePublicPageConfig.mock.invocationCallOrder[0]).toBeLessThan(h.invalidatePublicCache.mock.invocationCallOrder[0]);
    });

    it('admin:update_public_page_config keeps the cache when the write fails', async () => {
        h.db.updatePublicPageConfig.mockRejectedValue(new Error('write failed'));
        await expect(act('admin:update_public_page_config')({ ...injected(), enabled: false })).rejects.toThrow('write failed');
        expect(h.invalidatePublicCache).not.toHaveBeenCalled();
    });

    it('admin:update_intel_sharing_config / admin:update_hr_config forward only the nested config object', async () => {
        const intel = { shareWithAllies: true };
        const hr = { probationDays: 30 } as Record<string, unknown>;
        await expect(act('admin:update_intel_sharing_config')({ ...injected(), config: intel, junk: 1 })).resolves.toBeUndefined();
        await expect(act('admin:update_hr_config')({ ...injected(), config: hr, junk: 1 })).resolves.toBeUndefined();
        expect(h.db.updateIntelSharingConfig.mock.calls).toEqual([[intel]]);
        expect(h.db.updateHRConfig.mock.calls).toEqual([[hr]]);
    });

    it('admin:get_intel_sharing_config returns the stored config', async () => {
        h.db.getIntelSharingConfig.mockResolvedValue({ shareWithAllies: false });
        await expect(act('admin:get_intel_sharing_config')(injected())).resolves.toEqual({ shareWithAllies: false });
    });
});

// ---------------------------------------------------------------------------
describe('admin:update_radio_config — credential write is genuine-Admin only', () => {
    it.each([
        ['the Dispatcher (admin:access + radio:manage)', { ...DISPATCHER, permissions: ['admin:access', 'radio:manage'] }],
        ['a role NAMED Admin without identity', FORGED_NAME],
        ['a missing actor', undefined],
    ])('refuses %s before any write', async (_label, user) => {
        await expect(act('admin:update_radio_config')({ url: 'wss://lk', apiKey: 'k', apiSecret: 's', user })).rejects.toThrow(NOT_ADMIN);
        expect(h.db.updateRadioConfig).not.toHaveBeenCalled();
    });

    it('lets the stamped system Admin write the stripped credentials, returning nothing', async () => {
        await expect(act('admin:update_radio_config')({ ...injected(), url: 'wss://lk', apiKey: 'k', apiSecret: 's' })).resolves.toBeUndefined();
        const blob = h.db.updateRadioConfig.mock.calls[0][0];
        expect(blob).toEqual({ url: 'wss://lk', apiKey: 'k', apiSecret: 's' });
        expectNoActorFields(blob);
    });
});

// ---------------------------------------------------------------------------
describe('admin:list_testimonial_candidates — client-feedback read gate', () => {
    it('serves a holder of request:view:feedback with the search window only', async () => {
        await expect(act('admin:list_testimonial_candidates')({ search: 'great', limit: 10, offset: 20, user: ADMIN, userId: 1 }))
            .resolves.toEqual({ from: 'getTestimonialCandidates' });
        expect(h.db.getTestimonialCandidates).toHaveBeenCalledWith({ search: 'great', limit: 10, offset: 20 });
    });

    it.each([
        ['branding-only staff', { id: 5, permissions: ['admin:config:branding'] }],
        ['the stamped Admin WITHOUT the feedback perm (perm alone, no identity bypass)', { id: 1, isSystemAdmin: true, permissions: ['admin:access'] }],
        ['null permissions', { id: 6, permissions: null }],
    ])('refuses %s with a SecurityDenial carrying the actor id in audit fields only', async (_label, user) => {
        const err = await act('admin:list_testimonial_candidates')({ user }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('You do not have permission to read client feedback.');
        expect((err as SecurityDenial).auditEvent).toBe('authz.feedback.denied');
        expect((err as SecurityDenial).fields).toEqual({ userId: user.id });
        expect(h.db.getTestimonialCandidates).not.toHaveBeenCalled();
    });

    it('refuses a missing actor (fail closed)', async () => {
        const err = await act('admin:list_testimonial_candidates')({}).catch((e: unknown) => e) as SecurityDenial;
        expect(err.auditEvent).toBe('authz.feedback.denied');
        expect(err.fields).toEqual({ userId: undefined });
    });
});

// ---------------------------------------------------------------------------
describe('straight passthroughs — exact db call and args, result returned', () => {
    it.each([
        ['admin:add_announcement', { noticeData: { title: 'T' }, userId: 1 }, 'addAnnouncement', [{ title: 'T' }, 1]],
        ['admin:update_announcement', { noticeData: { id: 'n1', title: 'T2' } }, 'updateAnnouncement', [{ id: 'n1', title: 'T2' }]],
        ['admin:delete_announcement', { noticeId: 'n1' }, 'deleteAnnouncement', ['n1']],
        ['admin:adjust_rep', { targetUserId: 8, newReputation: 60, reason: 'help', userId: 1 }, 'adminAdjustUserReputation', [8, 60, 1, 'help']],
        ['admin:get_rep_history', { targetUserId: 8 }, 'getReputationHistoryForUser', [8]],
        ['admin:get_rating_history', { userId: 1 }, 'getRatingHistoryForUser', [1]],
        ['admin:toggle_duty', { targetUserId: 8 }, 'toggleUserDutyStatus', [8]],
        ['admin:toggle_affiliate', { targetUserId: 8 }, 'toggleUserAffiliateStatus', [8]],
        ['admin:toggle_vip', { targetUserId: 8 }, 'toggleUserVipStatus', [8]],
        ['admin:delete_unit', { unitId: 3 }, 'deleteUnit', [3]],
        ['admin:delete_rank', { rankId: 4 }, 'deleteRank', [4]],
        ['admin:add_specialization', { tagData: { name: 'Medic' } }, 'addSpecializationTag', [{ name: 'Medic' }]],
        ['admin:update_specialization', { tagData: { id: 1, name: 'Medic' } }, 'updateSpecializationTag', [{ id: 1, name: 'Medic' }]],
        ['admin:delete_specialization', { tagId: 1 }, 'deleteSpecializationTag', [1]],
        ['admin:add_certification', { certData: { name: 'EVA' } }, 'addCertification', [{ name: 'EVA' }]],
        ['admin:update_certification', { certData: { id: 2, name: 'EVA' } }, 'updateCertification', [{ id: 2, name: 'EVA' }]],
        ['admin:delete_certification', { certId: 2 }, 'deleteCertification', [2]],
        ['admin:award_certification', { targetUserId: 8, certificationId: 2, userId: 1 }, 'awardCertification', [8, 2, 1]],
        ['admin:revoke_certification', { targetUserId: 8, certificationId: 2 }, 'revokeCertification', [8, 2]],
        ['admin:add_commendation', { commendData: { name: 'Valor' } }, 'addCommendation', [{ name: 'Valor' }]],
        ['admin:update_commendation', { commendData: { id: 3 } }, 'updateCommendation', [{ id: 3 }]],
        ['admin:delete_commendation', { commendId: 3 }, 'deleteCommendation', [3]],
        ['admin:award_commendation', { targetUserId: 8, commendationId: 3, reason: 'brave', userId: 1 }, 'awardCommendation', [8, 3, 'brave', 1]],
        ['admin:revoke_commendation', { awardedCommendationId: 30 }, 'revokeCommendation', [30]],
        ['admin:add_conduct_entry', { targetUserId: 8, type: 'warning', reason: 'late', userId: 1 }, 'addConductEntry', [8, 'warning', 'late', 1]],
        ['admin:delete_conduct_entry', { entryId: 40 }, 'deleteConductEntry', [40]],
        ['admin:preview_specializations_import', { items: [{ a: 1 }] }, 'previewAchievementImport', ['specializations', [{ a: 1 }]]],
        ['admin:preview_certifications_import', { items: [] }, 'previewAchievementImport', ['certifications', []]],
        ['admin:preview_commendations_import', { items: [1] }, 'previewAchievementImport', ['commendations', [1]]],
        ['admin:bulk_import_specializations', { items: [1], offset: 0, limit: 50 }, 'bulkUpsertAchievements', ['specializations', [1], 0, 50]],
        ['admin:bulk_import_certifications', { items: [1], offset: 50, limit: 50 }, 'bulkUpsertAchievements', ['certifications', [1], 50, 50]],
        ['admin:bulk_import_commendations', { items: [1], offset: 5, limit: 5 }, 'bulkUpsertAchievements', ['commendations', [1], 5, 5]],
        ['admin:sync_all_member_roles', {}, 'syncAllMemberRoles', []],
        // The ADMIN path bypasses the per-user sync cooldown (the self path does not).
        ['admin:sync_user_roles', { targetUserId: 8 }, 'syncUserRoles', [8, { bypassCooldown: true }]],
        ['admin:add_role', { roleData: { name: 'Pilot' } }, 'addRole', [{ name: 'Pilot' }]],
        ['admin:update_role', { roleData: { id: 9, name: 'Pilot' } }, 'updateRole', [{ id: 9, name: 'Pilot' }]],
        ['admin:get_role_details', { roleId: 9 }, 'getRoleDetails', [9]],
        ['admin:delete_service_type', { id: 6 }, 'deleteServiceType', [6]],
        ['admin:update_clearance', { id: 1, name: 'Secret', description: 'd' }, 'updateSecurityClearance', [1, 'Secret', 'd']],
        ['admin:add_marker', { name: 'Black', code: 'BLK', description: 'd', syncRestricted: true }, 'addLimitingMarker', ['Black', 'BLK', 'd', true]],
        ['admin:update_marker', { id: 2, name: 'Black', code: 'BLK', description: 'd', syncRestricted: false }, 'updateLimitingMarker', [2, 'Black', 'BLK', 'd', false]],
        ['admin:delete_marker', { id: 2 }, 'deleteLimitingMarker', [2]],
        ['admin:add_tool', { toolData: { name: 'Erkul' } }, 'addExternalTool', [{ name: 'Erkul' }]],
        ['admin:update_tool', { toolData: { id: 7 } }, 'updateExternalTool', [{ id: 7 }]],
        ['admin:delete_tool', { toolId: 7 }, 'deleteExternalTool', [7]],
        ['admin:reorder_tool', { toolId: 7, sortOrder: 2 }, 'reorderExternalTool', [7, 2]],
        ['admin:update_radio_channel', { id: 'c1', name: 'Ops', color: '#f00' }, 'updateRadioChannel', ['c1', 'Ops', '#f00']],
        ['admin:delete_radio_channel', { channelId: 'c1' }, 'deleteRadioChannel', ['c1']],
        ['admin:delete_location', { locationId: 11 }, 'deleteLocation', [11]],
        ['admin:seed_default_locations', {}, 'seedDefaultLocations', []],
        ['admin:get_platform_settings', {}, 'getPlatformSettings', []],
        // targetUserId is a TARGET field: revoking another member's sessions.
        ['admin:revoke_user_sessions', { targetUserId: 8, userId: 1 }, 'revokeUserSessions', [8]],
    ])('%s → db.%s', async (action, payload, dbFn, args) => {
        await expect(act(action)(payload)).resolves.toEqual({ from: dbFn });
        expect(h.db[dbFn]).toHaveBeenCalledTimes(1);
        expect(h.db[dbFn].mock.calls[0]).toEqual(args);
    });

    it.each([
        ['admin:add_unit', 'addUnit'], ['admin:update_unit', 'updateUnit'],
        ['admin:add_rank', 'addRank'], ['admin:update_rank', 'updateRank'],
        ['admin:add_radio_channel', 'addRadioChannel'],
    ])('%s hands the whole entity payload to db.%s', async (action, dbFn) => {
        const payload = { id: 3, name: 'Alpha' };
        await act(action)(payload);
        expect(h.db[dbFn]).toHaveBeenCalledWith(payload);
    });

    it('admin:add_location / admin:update_location rebuild the row from the four known fields only', async () => {
        await act('admin:add_location')({ ...injected(), name: 'Port Olisar', type: 'station', parent_id: 2, deleted_at: null });
        expect(h.db.addLocation).toHaveBeenCalledWith({ name: 'Port Olisar', type: 'station', parent_id: 2 });
        await act('admin:update_location')({ ...injected(), id: 5, name: 'GrimHEX', type: 'station', parent_id: undefined, secret: 1 });
        expect(h.db.updateLocation.mock.calls[0]).toEqual([{ id: 5, name: 'GrimHEX', type: 'station', parent_id: undefined }]);
    });

    it('admin:sync_discord_roles runs the Discord sync and ignores the payload', async () => {
        h.syncDiscordRoles.mockResolvedValue({ synced: 4 });
        await expect(act('admin:sync_discord_roles')({ userId: 1 })).resolves.toEqual({ synced: 4 });
        expect(h.syncDiscordRoles).toHaveBeenCalledWith();
    });

    it('admin:update_features forwards the patch, defaulting a missing one to {}', async () => {
        await act('admin:update_features')({ patch: { warehouse: true } });
        expect(h.db.updateOrgFeatures).toHaveBeenLastCalledWith({ warehouse: true });
        await act('admin:update_features')({});
        expect(h.db.updateOrgFeatures).toHaveBeenLastCalledWith({});
    });
});

// ---------------------------------------------------------------------------
describe('user record writes', () => {
    it('admin:update_user never forwards clearance or actor fields, and passes the injected actor for the role guard', async () => {
        await act('admin:update_user')({ ...injected(), targetUserId: 8, rankId: 3, notes: 'n', clearanceLevelId: 5 });
        const [target, rest, actor] = h.db.updateUser.mock.calls[0];
        expect(target).toBe(8);
        expect(rest).toEqual({ rankId: 3, notes: 'n' });
        expect(rest).not.toHaveProperty('clearanceLevelId');
        expectNoActorFields(rest);
        expect(actor).toBe(ADMIN);
    });

    it('admin:update_user_clearance threads the actor for the author clamp', async () => {
        await act('admin:update_user_clearance')({ targetUserId: 8, userId: 1, user: ADMIN, levelId: 3, markerIds: [1, 2] });
        expect(h.db.updateUserClearance).toHaveBeenCalledWith(8, 1, 3, [1, 2], ADMIN);
    });

    it('admin:promote_user asserts the target-side ceiling against the Member role, then promotes', async () => {
        h.db.getSystemRoles.mockResolvedValue({ member: { id: 3 }, admin: { id: 4 } });
        await expect(act('admin:promote_user')({ targetUserId: 8, user: ADMIN })).resolves.toEqual({ from: 'promoteUserToMember' });
        expect(h.db.assertCanChangeUsersRole).toHaveBeenCalledWith(ADMIN, 8, 3);
        expect(h.db.promoteUserToMember).toHaveBeenCalledWith(8);
        expect(h.db.assertCanChangeUsersRole.mock.invocationCallOrder[0]).toBeLessThan(h.db.promoteUserToMember.mock.invocationCallOrder[0]);
    });

    it('admin:promote_user refuses when no Member role exists, before any guard or write', async () => {
        h.db.getSystemRoles.mockResolvedValue({ admin: { id: 4 } });
        await expect(act('admin:promote_user')({ targetUserId: 8, user: ADMIN })).rejects.toThrow('Cannot promote user: Member role not found');
        expect(h.db.assertCanChangeUsersRole).not.toHaveBeenCalled();
        expect(h.db.promoteUserToMember).not.toHaveBeenCalled();
    });

    it('admin:promote_user writes nothing when the ceiling refuses (e.g. promoting over an Admin)', async () => {
        h.db.getSystemRoles.mockResolvedValue({ member: { id: 3 } });
        h.db.assertCanChangeUsersRole.mockRejectedValue(new Error('You cannot change this user\'s role.'));
        await expect(act('admin:promote_user')({ targetUserId: 1, user: DISPATCHER })).rejects.toThrow('You cannot change this user\'s role.');
        expect(h.db.promoteUserToMember).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('bulk roster actions — id-array validation before any write', () => {
    const BULK: Array<[string, Record<string, unknown>, string, unknown[]]> = [
        ['admin:bulk_update_user_clearances', { userId: 1, user: ADMIN, levelId: 2, markerIds: [5], markerMode: 'add' }, 'bulkUpdateUserClearances', [[8, 9], 1, 2, [5], 'add', ADMIN]],
        ['admin:bulk_demote_to_client', { user: ADMIN }, 'bulkDemoteUsersToClient', [[8, 9], ADMIN]],
        ['admin:bulk_promote_users', { user: ADMIN }, 'bulkPromoteUsersToMember', [[8, 9], ADMIN]],
        ['admin:bulk_set_affiliate', { value: 1 }, 'bulkSetUsersAffiliate', [[8, 9], true]],
        ['admin:bulk_set_vip', { value: 0 }, 'bulkSetUsersVip', [[8, 9], false]],
        ['admin:bulk_assign_unit', { unitId: 3 }, 'bulkAssignUsersUnit', [[8, 9], 3]],
        ['admin:bulk_assign_rank', { rankId: 4 }, 'bulkAssignUsersRank', [[8, 9], 4]],
        ['admin:bulk_assign_position', { positionId: 5 }, 'bulkAssignUsersPosition', [[8, 9], 5]],
        ['admin:bulk_grant_certification', { certificationId: 2, userId: 1 }, 'bulkAwardCertification', [[8, 9], 2, 1]],
        ['admin:bulk_grant_commendation', { commendationId: 3, reason: 'brave', userId: 1 }, 'bulkAwardCommendation', [[8, 9], 3, 'brave', 1]],
    ];

    it.each(BULK)('%s → db.%s with exact args', (action, extra, dbFn, args) => {
        act(action)({ targetUserIds: [8, 9], ...extra });
        expect(h.db[dbFn]).toHaveBeenCalledTimes(1);
        expect(h.db[dbFn].mock.calls[0]).toEqual(args);
    });

    it.each(BULK)('%s refuses a non-array, empty, oversized or malformed id list without calling db.%s', (action, extra, dbFn) => {
        const call = (targetUserIds: unknown) => () => act(action)({ targetUserIds, ...extra });
        expect(call('8,9')).toThrow('Invalid targetUserIds: not an array');
        expect(call(undefined)).toThrow('Invalid targetUserIds: not an array');
        expect(call([])).toThrow('Invalid targetUserIds: empty array');
        expect(call(Array.from({ length: 101 }, (_, i) => i + 1))).toThrow('Invalid targetUserIds: array too large (max 100)');
        expect(call([8, { id: 9 }])).toThrow('Invalid targetUserIds: elements must be string or number');
        expect(h.db[dbFn]).not.toHaveBeenCalled();
    });

    it('accepts exactly the batch cap (100 ids)', () => {
        const ids = Array.from({ length: 100 }, (_, i) => i + 1);
        act('admin:bulk_set_vip')({ targetUserIds: ids, value: true });
        expect(h.db.bulkSetUsersVip).toHaveBeenCalledWith(ids, true);
    });

    it('defaults a missing unit / rank / position / reason to null (clear), never undefined', () => {
        act('admin:bulk_assign_unit')({ targetUserIds: [8] });
        act('admin:bulk_assign_rank')({ targetUserIds: [8] });
        act('admin:bulk_assign_position')({ targetUserIds: [8] });
        act('admin:bulk_grant_commendation')({ targetUserIds: [8], commendationId: 3, userId: 1 });
        expect(h.db.bulkAssignUsersUnit.mock.calls[0]).toEqual([[8], null]);
        expect(h.db.bulkAssignUsersRank.mock.calls[0]).toEqual([[8], null]);
        expect(h.db.bulkAssignUsersPosition.mock.calls[0]).toEqual([[8], null]);
        expect(h.db.bulkAwardCommendation.mock.calls[0]).toEqual([[8], 3, null, 1]);
    });
});

// ---------------------------------------------------------------------------
describe('roles & mappings — guards run before the write', () => {
    it('admin:update_rank_mapping with a role asserts mappable + assignable (role id parsed) before writing', async () => {
        await act('admin:update_rank_mapping')({ discordRoleId: 'dr1', rankId: 2, roleId: '7', user: DISPATCHER });
        expect(h.db.assertRoleIsMappable).toHaveBeenCalledWith('7');
        expect(h.db.assertCanAssignRole).toHaveBeenCalledWith(DISPATCHER, 7);
        expect(h.db.updateRankMapping).toHaveBeenCalledWith('dr1', 2, '7');
        expect(h.db.assertCanAssignRole.mock.invocationCallOrder[0]).toBeLessThan(h.db.updateRankMapping.mock.invocationCallOrder[0]);
    });

    it('admin:update_rank_mapping refuses an unmappable role (Client / Admin) without writing', async () => {
        h.db.assertRoleIsMappable.mockRejectedValue(new Error('That role cannot be mapped.'));
        await expect(act('admin:update_rank_mapping')({ discordRoleId: 'dr1', rankId: 2, roleId: 4, user: ADMIN })).rejects.toThrow('That role cannot be mapped.');
        expect(h.db.assertCanAssignRole).not.toHaveBeenCalled();
        expect(h.db.updateRankMapping).not.toHaveBeenCalled();
    });

    it('admin:update_rank_mapping refuses an escalating role without writing', async () => {
        h.db.assertCanAssignRole.mockRejectedValue(new Error('You cannot assign a role above your own.'));
        await expect(act('admin:update_rank_mapping')({ discordRoleId: 'dr1', rankId: 2, roleId: 5, user: DISPATCHER })).rejects.toThrow('You cannot assign a role above your own.');
        expect(h.db.updateRankMapping).not.toHaveBeenCalled();
    });

    it('admin:update_rank_mapping with no role (rank-only or clear) skips the role guards', async () => {
        await act('admin:update_rank_mapping')({ discordRoleId: 'dr1', rankId: 2, user: DISPATCHER });
        expect(h.db.assertRoleIsMappable).not.toHaveBeenCalled();
        expect(h.db.assertCanAssignRole).not.toHaveBeenCalled();
        expect(h.db.updateRankMapping).toHaveBeenCalledWith('dr1', 2, undefined);
    });

    it('admin:delete_role reads the role narrowly and deletes a non-system role', async () => {
        h.roleRow = { data: { name: 'Pilot', is_system: false }, error: null };
        await expect(act('admin:delete_role')({ roleId: 9 })).resolves.toEqual({ from: 'deleteRole' });
        expect(h.sbCalls).toEqual([{ table: 'roles', ops: [['select', 'name, is_system'], ['eq', 'id', 9], ['single']] }]);
        expect(h.db.deleteRole).toHaveBeenCalledWith(9);
    });

    it('admin:delete_role refuses a protected system role', async () => {
        h.roleRow = { data: { name: 'Client', is_system: true }, error: null };
        await expect(act('admin:delete_role')({ roleId: 1 })).rejects.toThrow('Cannot delete protected system roles.');
        expect(h.db.deleteRole).not.toHaveBeenCalled();
    });

    it.each([
        ['a read error', { data: { name: 'x', is_system: false }, error: { message: 'boom' } }],
        ['a missing row', { data: null, error: null }],
    ])('admin:delete_role fails closed on %s ("Role not found", nothing deleted)', async (_label, row) => {
        h.roleRow = row;
        await expect(act('admin:delete_role')({ roleId: 9 })).rejects.toThrow('Role not found');
        expect(h.db.deleteRole).not.toHaveBeenCalled();
    });

    it('admin:update_role_permissions runs the Client lock, then the escalation guard, then writes', async () => {
        await act('admin:update_role_permissions')({ roleId: 9, permissionNames: ['fleet:view'], user: DISPATCHER });
        expect(h.db.assertRoleIsNotClient).toHaveBeenCalledWith(9);
        expect(h.db.assertCanManageRolePermissions).toHaveBeenCalledWith(DISPATCHER, 9, ['fleet:view']);
        expect(h.db.updateRolePermissions).toHaveBeenCalledWith(9, ['fleet:view']);
        const order = ['assertRoleIsNotClient', 'assertCanManageRolePermissions', 'updateRolePermissions'].map((n) => h.db[n].mock.invocationCallOrder[0]);
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('admin:update_role_permissions never writes the code-owned Client role', async () => {
        h.db.assertRoleIsNotClient.mockRejectedValue(new Error('The Client role\'s permissions are fixed.'));
        await expect(act('admin:update_role_permissions')({ roleId: 1, permissionNames: ['admin:access'], user: ADMIN })).rejects.toThrow('fixed');
        expect(h.db.assertCanManageRolePermissions).not.toHaveBeenCalled();
        expect(h.db.updateRolePermissions).not.toHaveBeenCalled();
    });

    it('admin:update_role_permissions never writes a grant the actor lacks', async () => {
        h.db.assertCanManageRolePermissions.mockRejectedValue(new Error('You cannot grant permissions you do not hold.'));
        await expect(act('admin:update_role_permissions')({ roleId: 9, permissionNames: ['admin:access'], user: DISPATCHER })).rejects.toThrow('do not hold');
        expect(h.db.updateRolePermissions).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('service types — Discord channel snowflake validation', () => {
    it.each([['admin:add_service_type', 'addServiceType'], ['admin:update_service_type', 'updateServiceType']])('%s trims a valid snowflake and writes it', async (action, dbFn) => {
        await act(action)({ name: 'Rescue', discordChannelId: '  123456789012345678 ' });
        expect(h.db[dbFn]).toHaveBeenCalledWith({ name: 'Rescue', discordChannelId: '123456789012345678' });
    });

    it.each([['admin:add_service_type', 'addServiceType'], ['admin:update_service_type', 'updateServiceType']])('%s rejects junk with the actionable message and writes nothing', (action, dbFn) => {
        expect(() => act(action)({ name: 'Rescue', discordChannelId: 'general' }))
            .toThrow('Invalid Discord channel ID. Must be a 17–19 digit numeric snowflake (or empty to clear).');
        expect(h.db[dbFn]).not.toHaveBeenCalled();
    });

    it.each([
        ['16 digits', '1234567890123456'],
        ['20 digits', '12345678901234567890'],
        ['an embedded space', '1234567890 12345678'],
    ])('rejects %s', (_label, discordChannelId) => {
        expect(() => act('admin:add_service_type')({ discordChannelId })).toThrow(/^Invalid Discord channel ID/);
    });

    it.each([['17 digits', '12345678901234567'], ['19 digits', '1234567890123456789']])('accepts %s', (_label, discordChannelId) => {
        act('admin:add_service_type')({ discordChannelId });
        expect(h.db.addServiceType).toHaveBeenCalledWith({ discordChannelId });
    });

    it.each([['null', null], ['an empty string', ''], ['whitespace only', '   ']])('normalises %s to null (clear the override)', (_label, discordChannelId) => {
        act('admin:update_service_type')({ id: 6, discordChannelId });
        expect(h.db.updateServiceType).toHaveBeenCalledWith({ id: 6, discordChannelId: null });
    });

    it('stringifies a numeric snowflake', () => {
        act('admin:add_service_type')({ discordChannelId: 123456789012345680 });
        expect(h.db.addServiceType.mock.calls[0][0].discordChannelId).toBe('123456789012345680');
    });

    it('leaves a payload without the field untouched (no key invented)', () => {
        act('admin:update_service_type')({ id: 6, name: 'Escort' });
        expect(h.db.updateServiceType.mock.calls[0][0]).toEqual({ id: 6, name: 'Escort' });
    });

    it('tolerates an absent payload (validator no-ops)', () => {
        act('admin:add_service_type')(undefined);
        expect(h.db.addServiceType).toHaveBeenCalledWith(undefined);
    });
});

// ---------------------------------------------------------------------------
describe('DB maintenance family — genuine Admin, re-resolved cache-free on the deny path', () => {
    const FAMILY: Array<[string, Record<string, unknown>, string, unknown[]]> = [
        ['admin:db:check', {}, 'runDatabaseHealthCheck', []],
        ['admin:db:repair', {}, 'repairDatabase', []],
        ['admin:db:prune', { retentionDays: 30, targets: ['notifications'] }, 'pruneDatabaseData', [30, ['notifications']]],
    ];

    it.each(FAMILY)('%s: the stamped Admin passes WITHOUT a fresh lookup', async (action, extra, dbFn, args) => {
        await expect(act(action)({ user: ADMIN, ...extra })).resolves.toEqual({ from: dbFn });
        expect(h.db.resolveIsSystemAdminFresh).not.toHaveBeenCalled();
        expect(h.db[dbFn].mock.calls[0]).toEqual(args);
    });

    it.each(FAMILY)('%s: a stale stamp is re-checked by role id and passes when the fresh read says Admin', async (action, extra, dbFn) => {
        h.db.resolveIsSystemAdminFresh.mockResolvedValue(true);
        await act(action)({ user: { id: 1, roleId: 4, isSystemAdmin: false }, ...extra });
        expect(h.db.resolveIsSystemAdminFresh).toHaveBeenCalledWith(4);
        expect(h.db[dbFn]).toHaveBeenCalledTimes(1);
    });

    it.each(FAMILY)('%s: refuses the Dispatcher and a forged role name when the fresh read says not-Admin', async (action, extra, dbFn) => {
        h.db.resolveIsSystemAdminFresh.mockResolvedValue(false);
        await expect(act(action)({ user: DISPATCHER, ...extra })).rejects.toThrow(NOT_ADMIN);
        await expect(act(action)({ user: FORGED_NAME, ...extra })).rejects.toThrow(NOT_ADMIN);
        expect(h.db.resolveIsSystemAdminFresh.mock.calls).toEqual([[2], [9]]);
        expect(h.db[dbFn]).not.toHaveBeenCalled();
    });

    it('a missing actor is re-checked with no role id and refused', async () => {
        h.db.resolveIsSystemAdminFresh.mockResolvedValue(false);
        await expect(act('admin:db:repair')({})).rejects.toThrow(NOT_ADMIN);
        expect(h.db.resolveIsSystemAdminFresh).toHaveBeenCalledWith(undefined);
        expect(h.db.repairDatabase).not.toHaveBeenCalled();
    });

    it('a fresh-lookup fault propagates (never read as Admin)', async () => {
        h.db.resolveIsSystemAdminFresh.mockRejectedValue(new Error('roles unreadable'));
        await expect(act('admin:db:check')({ user: DISPATCHER })).rejects.toThrow('roles unreadable');
        expect(h.db.runDatabaseHealthCheck).not.toHaveBeenCalled();
    });
});

describe('admin:db:rotate_secrets', () => {
    it('refuses a non-Admin before touching any secret', async () => {
        h.db.resolveIsSystemAdminFresh.mockResolvedValue(false);
        await expect(act('admin:db:rotate_secrets')({ user: DISPATCHER })).rejects.toThrow(NOT_ADMIN);
        expect(h.db.rotateSecretsEncryption).not.toHaveBeenCalled();
        expect(h.db.recordSecurityEvent).not.toHaveBeenCalled();
    });

    it('returns the counts and audits a clean rotation as completed (counts only, no values)', async () => {
        h.db.rotateSecretsEncryption.mockResolvedValue({ rotated: 3, skipped: 1, failed: 0 });
        await expect(act('admin:db:rotate_secrets')({ user: ADMIN })).resolves.toEqual({ rotated: 3, skipped: 1, failed: 0 });
        expect(h.db.recordSecurityEvent).toHaveBeenCalledWith({
            event: 'secrets.rotation.completed', action: 'admin:db:rotate_secrets', actorUserId: 1, outcome: 'allowed',
            details: { rotated: 3, skipped: 1, failed: 0 },
        });
    });

    it('audits a rotation with undecryptable values as incomplete', async () => {
        h.db.rotateSecretsEncryption.mockResolvedValue({ rotated: 1, skipped: 0, failed: 2 });
        await act('admin:db:rotate_secrets')({ user: ADMIN });
        expect(h.db.recordSecurityEvent.mock.calls[0][0]).toMatchObject({ event: 'secrets.rotation.incomplete', details: { failed: 2 } });
    });

    it('records a null actor id when the fresh check passed for an actor with no id', async () => {
        h.db.resolveIsSystemAdminFresh.mockResolvedValue(true);
        h.db.rotateSecretsEncryption.mockResolvedValue({ rotated: 0, skipped: 0, failed: 0 });
        await act('admin:db:rotate_secrets')({ user: { roleId: 4 } });
        expect(h.db.recordSecurityEvent.mock.calls[0][0].actorUserId).toBeNull();
    });

    it('a throwing audit emitter never fails a rotation that already happened', async () => {
        h.db.rotateSecretsEncryption.mockResolvedValue({ rotated: 2, skipped: 0, failed: 0 });
        h.db.recordSecurityEvent.mockImplementation(() => { throw new Error('partial double'); });
        await expect(act('admin:db:rotate_secrets')({ user: ADMIN })).resolves.toEqual({ rotated: 2, skipped: 0, failed: 0 });
    });
});

describe('domain resets — genuine Admin AND the domain perm', () => {
    it.each([
        ['admin:db:reset_finances', 'finance:manage', 'resetFinancesData'],
        ['admin:db:reset_quartermaster', 'qm:manage', 'resetQuartermasterData'],
    ])('%s: the Admin holding %s resets', async (action, _perm, dbFn) => {
        await expect(act(action)({ user: ADMIN })).resolves.toEqual({ from: dbFn });
    });

    it.each([
        ['admin:db:reset_finances', 'resetFinancesData'],
        ['admin:db:reset_quartermaster', 'resetQuartermasterData'],
    ])('%s: a non-Admin domain manager is refused on the identity bar first (plain NOT_ADMIN)', (action, dbFn) => {
        expect(() => act(action)({ user: DISPATCHER })).toThrow(NOT_ADMIN);
        expect(() => act(action)({ user: FORGED_NAME })).toThrow(NOT_ADMIN);
        expect(h.db[dbFn]).not.toHaveBeenCalled();
    });

    it.each([
        ['admin:db:reset_finances', 'finance:manage', 'resetFinancesData'],
        ['admin:db:reset_quartermaster', 'qm:manage', 'resetQuartermasterData'],
    ])('%s: the Admin WITHOUT %s gets an audited SecurityDenial', (action, perm, dbFn) => {
        let err: unknown;
        try { act(action)({ user: { id: 1, isSystemAdmin: true, permissions: ['admin:access'] } }); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('You do not have permission to reset this module.');
        expect((err as SecurityDenial).auditEvent).toBe('authz.db_reset.denied');
        expect((err as SecurityDenial).fields).toEqual({ userId: 1, perm });
        expect(h.db[dbFn]).not.toHaveBeenCalled();
    });

    it('an Admin record with a non-array permissions value is refused', () => {
        expect(() => act('admin:db:reset_finances')({ user: { id: 1, isSystemAdmin: true, permissions: 'finance:manage' } }))
            .toThrow('You do not have permission to reset this module.');
    });
});

describe('Danger Zone — full reset / full wipe', () => {
    it('admin:db:full_reset restores exactly the dispatcher-injected acting admin, phrase trimmed', async () => {
        await expect(act('admin:db:full_reset')({ userId: 1, user: ADMIN, confirmPhrase: '  RESET  ' })).resolves.toEqual({ from: 'fullResetOrg' });
        expect(h.db.fullResetOrg).toHaveBeenCalledWith(1);
    });

    it('admin:db:full_wipe wipes for the Admin with the exact phrase', async () => {
        await expect(act('admin:db:full_wipe')({ user: ADMIN, confirmPhrase: 'WIPE EVERYTHING' })).resolves.toEqual({ from: 'fullWipeOrg' });
        expect(h.db.fullWipeOrg).toHaveBeenCalledWith();
    });

    it('a non-string phrase is refused with the phrase prompt, synchronously', () => {
        expect(() => act('admin:db:full_wipe')({ user: ADMIN, confirmPhrase: ['WIPE EVERYTHING'] }))
            .toThrow('Confirmation phrase incorrect. Type "WIPE EVERYTHING" exactly to proceed.');
        expect(() => act('admin:db:full_reset')({ userId: 1, user: ADMIN, confirmPhrase: 'WIPE EVERYTHING' }))
            .toThrow('Confirmation phrase incorrect. Type "RESET" exactly to proceed.');
        expect(h.db.fullWipeOrg).not.toHaveBeenCalled();
        expect(h.db.fullResetOrg).not.toHaveBeenCalled();
    });

    it('the Dispatcher is refused on identity even with the right phrase', () => {
        expect(() => act('admin:db:full_wipe')({ user: DISPATCHER, confirmPhrase: 'WIPE EVERYTHING' })).toThrow(NOT_ADMIN);
        expect(h.db.fullWipeOrg).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('platform lifecycle controls', () => {
    it('admin:update_platform_settings writes only the provided keys, coerced', async () => {
        await act('admin:update_platform_settings')({ user: ADMIN, maintenanceMode: 1, maintenanceMessage: 42 });
        expect(h.db.updatePlatformSettings).toHaveBeenLastCalledWith({ maintenance_mode: true, maintenance_message: '42' });

        await act('admin:update_platform_settings')({ user: ADMIN, maintenanceMode: false });
        expect(h.db.updatePlatformSettings).toHaveBeenLastCalledWith({ maintenance_mode: false });

        await act('admin:update_platform_settings')({ user: ADMIN, maintenanceMessage: 'Back soon', force_logout_timestamp: '1970-01-01' });
        expect(h.db.updatePlatformSettings).toHaveBeenLastCalledWith({ maintenance_message: 'Back soon' });

        await act('admin:update_platform_settings')({ user: ADMIN });
        expect(h.db.updatePlatformSettings).toHaveBeenLastCalledWith({});
    });

    it('admin:update_platform_settings refuses a non-Admin (maintenance lockout is Admin-only)', async () => {
        h.db.resolveIsSystemAdminFresh.mockResolvedValue(false);
        await expect(act('admin:update_platform_settings')({ user: DISPATCHER, maintenanceMode: true })).rejects.toThrow(NOT_ADMIN);
        expect(h.db.updatePlatformSettings).not.toHaveBeenCalled();
    });

    it('admin:force_logout_all stamps the SERVER clock (a client value is ignored)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-02T03:04:05.678Z'));
        await act('admin:force_logout_all')({ user: ADMIN, force_logout_timestamp: '2000-01-01T00:00:00.000Z' });
        expect(h.db.updatePlatformSettings).toHaveBeenCalledWith({ force_logout_timestamp: '2026-11-02T03:04:05.678Z' });
    });

    it('admin:force_logout_all refuses a non-Admin', async () => {
        h.db.resolveIsSystemAdminFresh.mockResolvedValue(false);
        await expect(act('admin:force_logout_all')({ user: DISPATCHER })).rejects.toThrow(NOT_ADMIN);
        expect(h.db.updatePlatformSettings).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('admin:import_org — input validation', () => {
    it.each([['a non-string', { rows: [] }], ['an absent value', undefined], ['an empty string', ''], ['whitespace', ' \n\t ']])('refuses %s', async (_label, ndjson) => {
        await expect(act('admin:import_org')({ ndjson })).rejects.toThrow('No import data provided.');
        expect(h.db.importOrgData).not.toHaveBeenCalled();
    });

    it('imports a valid document', async () => {
        const ndjson = '{"type":"org"}\n';
        await expect(act('admin:import_org')({ ndjson })).resolves.toEqual({ from: 'importOrgData' });
        expect(h.db.importOrgData).toHaveBeenCalledWith(ndjson);
    });

    it('accepts exactly 64 MiB and refuses one character more', async () => {
        const cap = 64 * 1024 * 1024;
        const atCap = 'x'.repeat(cap);
        await act('admin:import_org')({ ndjson: atCap });
        expect(h.db.importOrgData).toHaveBeenCalledTimes(1);
        await expect(act('admin:import_org')({ ndjson: atCap + 'x' })).rejects.toThrow('Import file too large (max 64 MB).');
        expect(h.db.importOrgData).toHaveBeenCalledTimes(1);
    });
});
