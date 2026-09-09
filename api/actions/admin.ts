
import * as db from '../../lib/db.js';
import * as discord from '../../lib/discord.js';
import { assertIdArray } from '../../lib/pgrest.js';
import { MAX_IMPORT_BATCH_SIZE } from '../../lib/db/system.js';
import { SecurityDenial } from '../../lib/errors.js';
import { stripActorFields } from '../services.js';
import { invalidatePublicCache } from '../public.js';
import type {
    User,
    BrandingConfig,
    PublicPageConfig,
    DiscordConfig,
    HeroCardConfig,
    WikiHomeConfig,
    OpenGraphConfig,
    RadioConfig,
    AIConfig,
    HRConfig,
    ConductRecordType,
    LocationType,
    OrganizationalUnit,
    Rank,
    Role,
    RadioChannel,
    ExternalTool,
    SpecializationTag,
    Certification,
    Commendation,
    ServiceTypeConfig,
    Announcement,
} from '../../types.js';

// ---------------------------------------------------------------------------
// Payload shapes. Every handler receives the request body with the actor-id
// field (userId/user) injected server-side by services.ts. user/role/unit/etc.
// ids are integers. Config-update handlers forward a partial config tree, so
// those payloads extend the relevant *Config type as a Partial.
// ---------------------------------------------------------------------------

// Single-org: no per-org scoping. This empty base is retained so the many
// payloads below keep a stable shared marker without churning every signature.
type OrgScopedPayload = Record<never, never>;

// The actor the dispatcher injects, as far as the apex gates care about it.
// `isSystemAdmin` is role IDENTITY (lib/db/adminIdentity.ts), stamped by
// getUserById from users.role_id against the system Admin role — deliberately NOT
// `role`, which toUser infers from the role row's free-text NAME, so a
// permissionless custom role called "Commander" (or literally "admin") cleared
// every gate below. Absent ⇒ not Admin, which is the deny direction here.
type AdminActor = { id?: number; roleId?: number; isSystemAdmin?: boolean; permissions?: string[] | null } | undefined;

const NOT_ADMIN = 'Only an Admin may perform this action.';

// Danger-Zone (full reset / full wipe) destroys ALL data. Defense beyond the
// dispatcher's admin:db:destroy perm gate: require the genuine Admin role AND a
// confirmation phrase validated server-side — the typed phrase must never be a
// browser-only gate. Fails closed on a missing/incorrect phrase or non-Admin.
// Deliberately SYNCHRONOUS: it must throw before any DB await, so the destructive
// RPC is unreachable even in principle (pinned by tests/dangerZoneAuthz.test.ts).
interface DangerZonePayload extends OrgScopedPayload {
    user?: AdminActor;
    confirmPhrase?: string;
}

function assertDangerZone(user: AdminActor, confirmPhrase: string | undefined, expected: string): void {
    if (user?.isSystemAdmin !== true) {
        throw new Error(NOT_ADMIN);
    }
    if (typeof confirmPhrase !== 'string' || confirmPhrase.trim() !== expected) {
        throw new Error(`Confirmation phrase incorrect. Type "${expected}" exactly to proceed.`);
    }
}

// Platform-lifecycle carve-out (mirrors assertDangerZone, no confirm phrase):
// maintenance-mode toggle + force-logout-all are apex controls that can lock out
// or sign out the entire platform. They must require the genuine Admin role, not
// merely a delegated permission (admin:access was seeded to the non-Admin
// Dispatcher). This is the load-bearing fail-closed gate even if the dispatcher's
// permission mapping is ever loosened. The dispatcher injects `user`.
function assertAdminRole(user: AdminActor): void {
    if (user?.isSystemAdmin !== true) {
        throw new Error(NOT_ADMIN);
    }
}

// RECOVERY family (db check/repair/prune, the maintenance toggle, force-logout-all).
// Same bar, but re-resolved CACHE-FREE. The stamped flag comes from getSystemRoles,
// a 5-minute memo; lib/db/importer.ts full-table-deletes and rebuilds `roles`, and
// repairDatabase is the tool that re-stamps is_system. Gating repair on the memo
// repair exists to fix is the circularity that manufactures a lockout — an org
// steered at "reset the database" by a failed import would be told
// "Only an Admin may perform this action.", which is false. Accepts the stamped
// answer when it is already true (no query for the ordinary case) and only pays the
// round-trip on the deny path.
async function assertAdminRoleFresh(user: AdminActor): Promise<void> {
    if (user?.isSystemAdmin === true) return;
    if (await db.resolveIsSystemAdminFresh(user?.roleId)) return;
    throw new Error(NOT_ADMIN);
}

// Domain-scoped destructive resets (treasury / quartermaster wipes) sit on TWO
// independent bars, both load-bearing. (1) The genuine Admin role, exactly as for
// the rest of the admin:db:* family. (2) The domain's own management perm — the
// competence bar the dispatcher's permission map used to carry alone ("a
// finance-blind dashboard user must not erase the treasury"). That map value is
// now the family's high-bar admin:db:destroy, because 'admin:' is NOT one of
// OPTIONAL_FEATURE_NAMESPACES' prefixes: a domain perm there was the ONLY gate,
// and it let any holder of finance:manage / qm:manage — delegable to a custom
// role — wipe a module that had never even been enabled. Re-asserting the domain
// perm HERE narrows and retires nothing.
function assertDomainResetPerm(user: AdminActor, perm: string): void {
    assertAdminRole(user);
    if (Array.isArray(user?.permissions) && user.permissions.includes(perm)) return;
    throw new SecurityDenial('You do not have permission to reset this module.', {
        auditEvent: 'authz.db_reset.denied',
        fields: { userId: user?.id, perm },
    });
}

// The testimonial candidate list is a searchable dump of the SAME free-text
// service_requests.client_feedback column that every other read path redacts
// per-viewer via redactRequestFeedbackForViewer (lib/db/requests.ts), gated on
// request:view:feedback. Its mapped perm, admin:config:branding, is a delegatable
// comms/PR bucket — so branding alone would be a second route around that boundary.
// The dispatcher denies this before the DB round-trip; asserting it here too keeps
// the handler safe for any future in-process caller. Predicate matches
// redactRequestFeedbackForViewer's maySee exactly (the perm alone — no role-name
// bypass) so the two cannot drift.
function assertMayReadClientFeedback(user: { id?: number; permissions?: string[] | null } | undefined): void {
    if (Array.isArray(user?.permissions) && user.permissions.includes('request:view:feedback')) return;
    throw new SecurityDenial('You do not have permission to read client feedback.', {
        auditEvent: 'authz.feedback.denied',
        fields: { userId: user?.id },
    });
}

// Config-update handlers: spread `...rest` into the matching db.update*Config
// call. rest is a partial config tree.
type DiscordConfigPayload = OrgScopedPayload & Partial<DiscordConfig>;
type HeroConfigPayload = OrgScopedPayload & Partial<HeroCardConfig>;
type BrandingConfigPayload = OrgScopedPayload & Partial<BrandingConfig>;
type PublicPageConfigPayload = OrgScopedPayload & Partial<PublicPageConfig>;
type OpenGraphConfigPayload = OrgScopedPayload & Partial<OpenGraphConfig>;
type AIConfigPayload = OrgScopedPayload & Partial<AIConfig>;
// Voice-server (LiveKit) credentials — url/apiKey/apiSecret. The dispatcher
// injects `user`; the handler asserts the genuine Admin role so this
// credential-bearing write is not reachable via the operational radio:manage
// perm (held by the non-Admin Dispatcher for channel CRUD / reboot).
type RadioConfigPayload = OrgScopedPayload & Partial<RadioConfig> & { user?: AdminActor };
type WikiHomeConfigPayload = OrgScopedPayload & Partial<WikiHomeConfig>;

interface ListTestimonialCandidatesPayload extends OrgScopedPayload {
    search?: string;
    limit?: number;
    offset?: number;
    // Dispatcher-injected actor — read by assertMayReadClientFeedback, never client-supplied.
    user?: AdminActor;
}

interface IntelSharingConfigPayload extends OrgScopedPayload {
    config: Record<string, unknown>;
}

interface HRConfigPayload extends OrgScopedPayload {
    config: HRConfig;
}

interface AddAnnouncementPayload extends OrgScopedPayload {
    noticeData: Partial<Announcement>;
    userId: number;
}

interface UpdateAnnouncementPayload extends OrgScopedPayload {
    noticeData: Partial<Announcement>;
}

interface DeleteAnnouncementPayload extends OrgScopedPayload {
    noticeId: string;
}

interface AdjustRepPayload extends OrgScopedPayload {
    targetUserId: number;
    newReputation: number;
    reason: string;
    userId: number;
}

interface UpdateUserPayload extends OrgScopedPayload {
    targetUserId: number;
    user: User;
    [key: string]: unknown;
}

interface UpdateUserClearancePayload extends OrgScopedPayload {
    targetUserId: number;
    userId: number;
    // Authenticated actor injected by services.ts — threaded so updateUserClearance
    // can author-clamp the requested grant against the actor's own clearance.
    user: User;
    levelId: number | null;
    markerIds: number[];
}

interface BulkUpdateUserClearancesPayload extends OrgScopedPayload {
    targetUserIds: number[];
    userId: number;
    // Authenticated actor injected by services.ts — threaded for the clearance clamp.
    user: User;
    levelId: number | null;
    markerIds: number[];
    markerMode: 'replace' | 'add';
}

interface BulkUsersWithActorPayload extends OrgScopedPayload {
    targetUserIds: number[];
    user: User;
}

interface BulkSetFlagPayload extends OrgScopedPayload {
    targetUserIds: number[];
    value: boolean;
}

interface BulkAssignUnitPayload extends OrgScopedPayload {
    targetUserIds: number[];
    unitId: number | null;
}

interface BulkAssignRankPayload extends OrgScopedPayload {
    targetUserIds: number[];
    rankId: number | null;
}

interface BulkAssignPositionPayload extends OrgScopedPayload {
    targetUserIds: number[];
    positionId: number | null;
}

interface BulkGrantCertificationPayload extends OrgScopedPayload {
    targetUserIds: number[];
    certificationId: number;
    userId: number;
}

interface BulkGrantCommendationPayload extends OrgScopedPayload {
    targetUserIds: number[];
    commendationId: number;
    reason?: string;
    userId: number;
}

interface TargetUserPayload extends OrgScopedPayload {
    targetUserId: number;
}

interface PromoteUserPayload extends OrgScopedPayload {
    targetUserId: number;
    // Authenticated actor injected by services.ts. promoteUserToMember is a bare
    // role write with no guard of its own (it is also the HR hire primitive, called
    // internally with no actor), so the target-side ceiling is asserted here.
    user: User;
}

interface RepHistoryPayload {
    targetUserId: number;
}

interface RatingHistoryPayload {
    userId: number;
}

// add/update unit & rank & radio channel: the whole payload IS the entity
// data object.
type UnitPayload = Partial<OrganizationalUnit> & OrgScopedPayload;
type RankPayload = Partial<Rank> & OrgScopedPayload;
type RadioChannelPayload = Partial<RadioChannel> & OrgScopedPayload;

interface DeleteUnitPayload extends OrgScopedPayload {
    unitId: number;
}

interface DeleteRankPayload extends OrgScopedPayload {
    rankId: number;
}

interface AddSpecializationPayload extends OrgScopedPayload {
    tagData: Partial<SpecializationTag>;
}

interface UpdateSpecializationPayload {
    tagData: Partial<SpecializationTag>;
}

interface DeleteSpecializationPayload extends OrgScopedPayload {
    tagId: number;
}

interface AddCertificationPayload extends OrgScopedPayload {
    certData: Partial<Certification>;
}

interface UpdateCertificationPayload {
    certData: Partial<Certification>;
}

interface DeleteCertificationPayload extends OrgScopedPayload {
    certId: number;
}

interface AwardCertificationPayload extends OrgScopedPayload {
    targetUserId: number;
    certificationId: number;
    userId: number;
}

interface RevokeCertificationPayload extends OrgScopedPayload {
    targetUserId: number;
    certificationId: number;
}

interface AddCommendationPayload extends OrgScopedPayload {
    commendData: Partial<Commendation>;
}

interface UpdateCommendationPayload {
    commendData: Partial<Commendation>;
}

interface DeleteCommendationPayload extends OrgScopedPayload {
    commendId: number;
}

interface AwardCommendationPayload extends OrgScopedPayload {
    targetUserId: number;
    commendationId: number;
    reason: string;
    userId: number;
}

interface RevokeCommendationPayload extends OrgScopedPayload {
    awardedCommendationId: number;
}

interface AddConductEntryPayload {
    targetUserId: number;
    type: ConductRecordType;
    reason: string;
    userId: number;
}

interface DeleteConductEntryPayload extends OrgScopedPayload {
    entryId: number;
}

interface PreviewImportPayload extends OrgScopedPayload {
    items: unknown[];
}

interface BulkImportPayload extends OrgScopedPayload {
    items: unknown[];
    offset: number;
    limit: number;
}

interface SyncDiscordRolesPayload {
    userId?: number;
}

interface SyncUserRolesPayload extends OrgScopedPayload {
    targetUserId: number;
}

interface UpdateRankMappingPayload extends OrgScopedPayload {
    discordRoleId: string;
    rankId: number | string;
    roleId?: number | string;
    user: User;
}

interface AddRolePayload extends OrgScopedPayload {
    roleData: Partial<Role>;
}

interface UpdateRolePayload {
    roleData: Partial<Role>;
}

interface DeleteRolePayload extends OrgScopedPayload {
    roleId: number;
}

interface GetRoleDetailsPayload {
    roleId: number;
}

interface UpdateRolePermissionsPayload extends OrgScopedPayload {
    roleId: number;
    permissionNames: string[];
    user: User;
}

type ServiceTypePayload = Partial<ServiceTypeConfig> & OrgScopedPayload;

interface DeleteServiceTypePayload extends OrgScopedPayload {
    id: number;
}

interface UpdateClearancePayload {
    id: number;
    name: string;
    description: string;
}

interface AddMarkerPayload extends OrgScopedPayload {
    name: string;
    code: string;
    description: string;
    syncRestricted: boolean;
}

interface UpdateMarkerPayload {
    id: number;
    name: string;
    code: string;
    description: string;
    syncRestricted: boolean;
}

interface DeleteMarkerPayload extends OrgScopedPayload {
    id: number;
}

interface AddToolPayload extends OrgScopedPayload {
    toolData: Partial<ExternalTool>;
}

interface UpdateToolPayload {
    toolData: Partial<ExternalTool>;
}

interface DeleteToolPayload extends OrgScopedPayload {
    toolId: number;
}

interface ReorderToolPayload {
    toolId: number;
    sortOrder: number;
}

interface UpdateRadioChannelPayload {
    id: string;
    name: string;
    color: string;
}

interface DeleteRadioChannelPayload extends OrgScopedPayload {
    channelId: string;
}

interface AddLocationPayload extends OrgScopedPayload {
    name: string;
    type: LocationType;
    parent_id?: number;
}

interface UpdateLocationPayload {
    id: number;
    name: string;
    type: LocationType;
    parent_id?: number;
}

interface DeleteLocationPayload extends OrgScopedPayload {
    locationId: number;
}

// admin:db:* maintenance family. The dispatcher injects the authenticated `user`;
// these handlers assert the genuine Admin role (fail-closed backstop beyond the
// admin:db:destroy perm gate) before touching the DB.
interface DbMaintenancePayload extends OrgScopedPayload {
    user?: AdminActor;
}
interface DbPrunePayload extends DbMaintenancePayload {
    retentionDays: number;
    targets: string[];
}

interface ImportOrgPayload extends OrgScopedPayload {
    /** Raw NDJSON text of a hosted org export. Parsed/validated server-side. */
    ndjson: string;
}

// Discord channel IDs are snowflakes — 17–19 digit numeric strings. Empty
// string normalises to null (clear override). Anything else is rejected so
// the modal surfaces an actionable error rather than silently storing junk.
const DISCORD_SNOWFLAKE_RE = /^\d{17,19}$/;
function validateDiscordChannelIdField(data: { discordChannelId?: string | null }): void {
    if (data == null || !('discordChannelId' in data)) return;
    const raw = data.discordChannelId;
    if (raw == null || raw === '') {
        data.discordChannelId = null;
        return;
    }
    const str = String(raw).trim();
    if (str === '') {
        data.discordChannelId = null;
        return;
    }
    if (!DISCORD_SNOWFLAKE_RE.test(str)) {
        throw new Error('Invalid Discord channel ID. Must be a 17–19 digit numeric snowflake (or empty to clear).');
    }
    data.discordChannelId = str;
}

export const adminActions = {
    // --- SECURITY AUDIT TRAIL ---
    // Read-only, and deliberately an RPC rather than an /api/query subset: the rows
    // carry actor IPs and user ids, so keeping them off the state machinery entirely
    // means they can never ride the boot bundle or a realtime slice by accident.
    // Gated on admin:security:view_audit, NOT admin:access - admin:access is a
    // DISPATCHER default (lib/roleDefaultPermissions.ts), and handing every dispatcher
    // a queryable log of member IP addresses is not what the admin console implies.
    'admin:security:list_events': async (payload: {
        actorUserId?: number; event?: string; since?: string; until?: string;
        limit?: number; beforeId?: number;
    }) => db.listSecurityEvents(stripActorFields(payload)),
    // --- SETTINGS & CONFIG ---
    'admin:update_discord_config': async (payload: DiscordConfigPayload) => { await db.updateDiscordSettings(stripActorFields(payload)); },
    'admin:update_hero_config': async (payload: HeroConfigPayload) => { await db.updateHeroCardConfig(stripActorFields(payload)); },
    'admin:update_branding_config': async (payload: BrandingConfigPayload) => { await db.updateBrandingConfig(stripActorFields(payload)); },
    'admin:update_theme_config': async (payload: { enabled?: boolean; accent?: string }) => { await db.updateThemeConfig(stripActorFields(payload)); },
    'admin:update_public_page_config': async (payload: PublicPageConfigPayload) => { await db.updatePublicPageConfig(stripActorFields(payload)); invalidatePublicCache(); },
    'admin:list_testimonial_candidates': async ({ search, limit, offset, user }: ListTestimonialCandidatesPayload) => {
        assertMayReadClientFeedback(user);
        return db.getTestimonialCandidates({ search, limit, offset });
    },
    'admin:update_intel_sharing_config': async ({ config }: IntelSharingConfigPayload) => { await db.updateIntelSharingConfig(config); },
    'admin:update_hr_config': async ({ config }: HRConfigPayload) => { await db.updateHRConfig(config); },
    'admin:get_intel_sharing_config': async () => { return db.getIntelSharingConfig(); },
    'admin:update_opengraph_config': async (payload: OpenGraphConfigPayload) => { await db.updateOpenGraphConfig(stripActorFields(payload)); },
    'admin:update_ai_config': async (payload: AIConfigPayload) => { await db.updateAIConfig(stripActorFields(payload)); },
    'admin:update_radio_config': async (payload: RadioConfigPayload) => { assertAdminRole(payload.user); await db.updateRadioConfig(stripActorFields(payload)); },
    'admin:update_wiki_home_config': async (payload: WikiHomeConfigPayload) => { await db.updateWikiHomeConfig(stripActorFields(payload)); },

    // --- ANNOUNCEMENTS ---
    'admin:add_announcement': ({ noticeData, userId }: AddAnnouncementPayload) => db.addAnnouncement(noticeData, userId),
    'admin:update_announcement': ({ noticeData }: UpdateAnnouncementPayload) => db.updateAnnouncement(noticeData),
    'admin:delete_announcement': ({ noticeId }: DeleteAnnouncementPayload) => db.deleteAnnouncement(noticeId),

    // --- USERS & REPUTATION ---
    'admin:adjust_rep': ({ targetUserId, newReputation, reason, userId }: AdjustRepPayload) => db.adminAdjustUserReputation(targetUserId, newReputation, userId, reason),
    'admin:update_user': (payload: UpdateUserPayload) => {
        const { targetUserId, user, ...rest } = payload;
        // This handler only needs the weaker admin:user:update permission, so it
        // must never change a user's clearance. Clearance can only be set through
        // admin:update_user_clearance, which needs the stronger manage_clearance
        // permission and records an audit entry. Remove it from the payload here;
        // updateUser also re-checks clearance as a backstop for any other caller.
        delete (rest as { clearanceLevelId?: unknown }).clearanceLevelId;
        // Pass the authenticated actor (injected by services.ts) so updateUser
        // can enforce the role-escalation guard when `details.roleId` is set.
        return db.updateUser(targetUserId, stripActorFields(rest), user);
    },
    // Forward the authenticated actor (user) so the db layer can author-clamp
    // the grant against the actor's own clearance/markers.
    'admin:update_user_clearance': ({ targetUserId, userId, user, levelId, markerIds }: UpdateUserClearancePayload) => db.updateUserClearance(targetUserId, userId, levelId, markerIds, user),
    // Bulk version. Loops the same per-user contract; returns
    // { updated, total } so the UI can toast partial-success counts.
    'admin:bulk_update_user_clearances': ({ targetUserIds, userId, user, levelId, markerIds, markerMode }: BulkUpdateUserClearancesPayload) => {
        assertIdArray(targetUserIds, MAX_IMPORT_BATCH_SIZE, 'targetUserIds');
        return db.bulkUpdateUserClearances(targetUserIds, userId, levelId, markerIds, markerMode, user);
    },
    // Bulk demote N users to the org's Client system role. The db layer hoists
    // assertCanAssignRole (fixed target role) and runs assertCanChangeUsersRole per
    // target with blockPeers, so an Admin-tier row or the actor's own row is counted
    // as `skipped` rather than written — matching the roster UI, which hides their
    // checkboxes. Partial success is the contract: one refusal never aborts the batch.
    'admin:bulk_demote_to_client': ({ targetUserIds, user }: BulkUsersWithActorPayload) => {
        assertIdArray(targetUserIds, MAX_IMPORT_BATCH_SIZE, 'targetUserIds');
        return db.bulkDemoteUsersToClient(targetUserIds, user);
    },
    // Bulk promote N Client/lower-tier users to Member.
    'admin:bulk_promote_users': ({ targetUserIds, user }: BulkUsersWithActorPayload) => {
        assertIdArray(targetUserIds, MAX_IMPORT_BATCH_SIZE, 'targetUserIds');
        return db.bulkPromoteUsersToMember(targetUserIds, user);
    },
    // Bulk explicit setters for is_affiliate / is_vip flags. Bulk action
    // takes a value (true/false) rather than toggling, since toggling
    // mixed-state selections produces confusing outcomes.
    'admin:bulk_set_affiliate': ({ targetUserIds, value }: BulkSetFlagPayload) => {
        assertIdArray(targetUserIds, MAX_IMPORT_BATCH_SIZE, 'targetUserIds');
        return db.bulkSetUsersAffiliate(targetUserIds, !!value);
    },
    'admin:bulk_set_vip': ({ targetUserIds, value }: BulkSetFlagPayload) => {
        assertIdArray(targetUserIds, MAX_IMPORT_BATCH_SIZE, 'targetUserIds');
        return db.bulkSetUsersVip(targetUserIds, !!value);
    },
    // Bulk scalar field assignments — unit, rank, primary position. Pass
    // null to clear the field. These don't touch tier so no member-count
    // recompute is performed inside the loop.
    'admin:bulk_assign_unit': ({ targetUserIds, unitId }: BulkAssignUnitPayload) => {
        assertIdArray(targetUserIds, MAX_IMPORT_BATCH_SIZE, 'targetUserIds');
        return db.bulkAssignUsersUnit(targetUserIds, unitId ?? null);
    },
    'admin:bulk_assign_rank': ({ targetUserIds, rankId }: BulkAssignRankPayload) => {
        assertIdArray(targetUserIds, MAX_IMPORT_BATCH_SIZE, 'targetUserIds');
        return db.bulkAssignUsersRank(targetUserIds, rankId ?? null);
    },
    'admin:bulk_assign_position': ({ targetUserIds, positionId }: BulkAssignPositionPayload) => {
        assertIdArray(targetUserIds, MAX_IMPORT_BATCH_SIZE, 'targetUserIds');
        return db.bulkAssignUsersPosition(targetUserIds, positionId ?? null);
    },
    // Bulk grant a single cert/commendation to N users. Allows duplicates
    // — matches the single-user semantics. userId is the awardedBy actor.
    'admin:bulk_grant_certification': ({ targetUserIds, certificationId, userId }: BulkGrantCertificationPayload) => {
        assertIdArray(targetUserIds, MAX_IMPORT_BATCH_SIZE, 'targetUserIds');
        return db.bulkAwardCertification(targetUserIds, certificationId, userId);
    },
    'admin:bulk_grant_commendation': ({ targetUserIds, commendationId, reason, userId }: BulkGrantCommendationPayload) => {
        assertIdArray(targetUserIds, MAX_IMPORT_BATCH_SIZE, 'targetUserIds');
        return db.bulkAwardCommendation(targetUserIds, commendationId, reason ?? null, userId);
    },
    // Target-side ceiling only. The action is already gated on
    // admin:user:update_role and the role it grants is the fixed Member role, so
    // the missing half was "who may be written OVER" — an unguarded promote is a
    // demotion by another name against an Admin. assertCanAssignRole is
    // deliberately NOT added: its tier ladder does not recognise admin:user:update_role
    // or any hr:* permission, so a delegated Recruiter role scores tier 1 and the
    // Clients-tab promote plus the HR case-file approval would both start failing.
    'admin:promote_user': async ({ targetUserId, user }: PromoteUserPayload) => {
        const sysRoles = await db.getSystemRoles();
        if (!sysRoles.member) throw new Error('Cannot promote user: Member role not found');
        await db.assertCanChangeUsersRole(user, targetUserId, sysRoles.member.id);
        return db.promoteUserToMember(targetUserId);
    },
    'admin:get_rep_history': ({ targetUserId }: RepHistoryPayload) => db.getReputationHistoryForUser(targetUserId),
    'admin:get_rating_history': ({ userId }: RatingHistoryPayload) => db.getRatingHistoryForUser(userId),
    'admin:toggle_duty': ({ targetUserId }: TargetUserPayload) => db.toggleUserDutyStatus(targetUserId),
    'admin:toggle_affiliate': ({ targetUserId }: TargetUserPayload) => db.toggleUserAffiliateStatus(targetUserId),
    'admin:toggle_vip': ({ targetUserId }: TargetUserPayload) => db.toggleUserVipStatus(targetUserId),

    // --- UNITS & RANKS ---
    'admin:add_unit': (unitData: UnitPayload) => db.addUnit(unitData),
    'admin:update_unit': (unitData: UnitPayload) => db.updateUnit(unitData),
    'admin:delete_unit': ({ unitId }: DeleteUnitPayload) => db.deleteUnit(unitId),
    'admin:add_rank': (rankData: RankPayload) => db.addRank(rankData),
    'admin:update_rank': (rankData: RankPayload) => db.updateRank(rankData),
    'admin:delete_rank': ({ rankId }: DeleteRankPayload) => db.deleteRank(rankId),

    // --- SPECIALIZATIONS & CERTS ---
    'admin:add_specialization': ({ tagData }: AddSpecializationPayload) => db.addSpecializationTag(tagData),
    'admin:update_specialization': ({ tagData }: UpdateSpecializationPayload) => db.updateSpecializationTag(tagData),
    'admin:delete_specialization': ({ tagId }: DeleteSpecializationPayload) => db.deleteSpecializationTag(tagId),
    'admin:add_certification': ({ certData }: AddCertificationPayload) => db.addCertification(certData),
    'admin:update_certification': ({ certData }: UpdateCertificationPayload) => db.updateCertification(certData),
    'admin:delete_certification': ({ certId }: DeleteCertificationPayload) => db.deleteCertification(certId),
    'admin:award_certification': ({ targetUserId, certificationId, userId }: AwardCertificationPayload) => db.awardCertification(targetUserId, certificationId, userId),
    'admin:revoke_certification': ({ targetUserId, certificationId }: RevokeCertificationPayload) => db.revokeCertification(targetUserId, certificationId),

    // --- COMMENDATIONS & CONDUCT ---
    'admin:add_commendation': ({ commendData }: AddCommendationPayload) => db.addCommendation(commendData),
    'admin:update_commendation': ({ commendData }: UpdateCommendationPayload) => db.updateCommendation(commendData),
    'admin:delete_commendation': ({ commendId }: DeleteCommendationPayload) => db.deleteCommendation(commendId),
    'admin:award_commendation': ({ targetUserId, commendationId, reason, userId }: AwardCommendationPayload) => db.awardCommendation(targetUserId, commendationId, reason, userId),
    'admin:revoke_commendation': ({ awardedCommendationId }: RevokeCommendationPayload) => db.revokeCommendation(awardedCommendationId),
    'admin:add_conduct_entry': ({ targetUserId, type, reason, userId }: AddConductEntryPayload) => db.addConductEntry(targetUserId, type, reason, userId),
    'admin:delete_conduct_entry': ({ entryId }: DeleteConductEntryPayload) => db.deleteConductEntry(entryId),

    // --- ACHIEVEMENT CATALOG IMPORT (specializations / certifications / commendations) ---
    // Preview: pure read; computes "X new, Y will update, Z will skip" + diff
    // for the confirm step. Bulk: client-driven offset/limit chunks; server
    // clamps `limit` to MAX_IMPORT_BATCH_SIZE so misuse can't pin the request.
    'admin:preview_specializations_import': ({ items }: PreviewImportPayload) => db.previewAchievementImport('specializations', items),
    'admin:preview_certifications_import': ({ items }: PreviewImportPayload) => db.previewAchievementImport('certifications', items),
    'admin:preview_commendations_import': ({ items }: PreviewImportPayload) => db.previewAchievementImport('commendations', items),
    'admin:bulk_import_specializations': ({ items, offset, limit }: BulkImportPayload) => db.bulkUpsertAchievements('specializations', items, offset, limit),
    'admin:bulk_import_certifications': ({ items, offset, limit }: BulkImportPayload) => db.bulkUpsertAchievements('certifications', items, offset, limit),
    'admin:bulk_import_commendations': ({ items, offset, limit }: BulkImportPayload) => db.bulkUpsertAchievements('commendations', items, offset, limit),

    // --- DISCORD & ROLES ---
    'admin:sync_discord_roles': async (_payload: SyncDiscordRolesPayload) => {
        return discord.syncDiscordRoles();
    },
    'admin:sync_all_member_roles': () => db.syncAllMemberRoles(),
    'admin:sync_user_roles': ({ targetUserId }: SyncUserRolesPayload) => db.syncUserRoles(targetUserId, { bypassCooldown: true }),
    'admin:update_rank_mapping': async ({ discordRoleId, rankId, roleId, user }: UpdateRankMappingPayload) => {
        // When a roleId is being written, gate by assertCanAssignRole — a
        // Discord-role → platform-role mapping is an indirect role-write path
        // (the next sync escalates anyone holding the Discord role).
        // assertRoleIsMappable additionally refuses the two roles the mapping
        // dropdown has never offered: Client (shadows every other mapping on the
        // account and pins its holder off the ladder) and Admin (a standing
        // escalation primitive administered outside this app — assertCanAssignRole
        // only blocks that for NON-Admin actors). Clearing a mapping (no rankId and
        // no roleId) is untouched.
        if (roleId) {
            await db.assertRoleIsMappable(roleId);
            await db.assertCanAssignRole(user, parseInt(roleId.toString()));
        }
        return db.updateRankMapping(discordRoleId, rankId, roleId);
    },
    'admin:add_role': ({ roleData }: AddRolePayload) => db.addRole(roleData),
    'admin:update_role': ({ roleData }: UpdateRolePayload) => db.updateRole(roleData),
    'admin:delete_role': async ({ roleId }: DeleteRolePayload) => {
        const { data: role, error } = await db.supabase.from('roles').select('name, is_system').eq('id', roleId).single();
        if (error || !role) throw new Error('Role not found');
        if (role.is_system) {
            throw new Error('Cannot delete protected system roles.');
        }
        return db.deleteRole(roleId);
    },
    'admin:get_role_details': ({ roleId }: GetRoleDetailsPayload) => db.getRoleDetails(roleId),
    'admin:update_role_permissions': async ({ roleId, permissionNames, user }: UpdateRolePermissionsPayload) => {
        // The Client role's permission set is code-owned. The predicate coerces the
        // id and fails CLOSED on an unresolvable system role — the `if (sysRoles.client
        // && …)` shape it replaces silently LIFTED the lock on a getSystemRoles read
        // fault, which is the one state where it matters most. updateRolePermissions
        // asserts the same predicate, so the two cannot drift.
        await db.assertRoleIsNotClient(roleId);
        // Privilege-escalation guard: a non-Admin role manager must not grant
        // permissions they lack (e.g. admin:access) or edit a role at/above their tier.
        await db.assertCanManageRolePermissions(user, roleId, permissionNames);
        return db.updateRolePermissions(roleId, permissionNames);
    },

    // --- OTHER CONFIG ---
    'admin:add_service_type': (data: ServiceTypePayload) => {
        validateDiscordChannelIdField(data);
        return db.addServiceType(data);
    },
    'admin:update_service_type': (data: ServiceTypePayload) => {
        validateDiscordChannelIdField(data);
        return db.updateServiceType(data);
    },
    'admin:delete_service_type': ({ id }: DeleteServiceTypePayload) => db.deleteServiceType(id),

    'admin:update_clearance': ({ id, name, description }: UpdateClearancePayload) => db.updateSecurityClearance(id, name, description),
    'admin:add_marker': ({ name, code, description, syncRestricted }: AddMarkerPayload) => db.addLimitingMarker(name, code, description, syncRestricted),
    'admin:update_marker': ({ id, name, code, description, syncRestricted }: UpdateMarkerPayload) => db.updateLimitingMarker(id, name, code, description, syncRestricted),
    'admin:delete_marker': ({ id }: DeleteMarkerPayload) => db.deleteLimitingMarker(id),

    'admin:add_tool': ({ toolData }: AddToolPayload) => db.addExternalTool(toolData),
    'admin:update_tool': ({ toolData }: UpdateToolPayload) => db.updateExternalTool(toolData),
    'admin:delete_tool': ({ toolId }: DeleteToolPayload) => db.deleteExternalTool(toolId),
    'admin:reorder_tool': ({ toolId, sortOrder }: ReorderToolPayload) => db.reorderExternalTool(toolId, sortOrder),

    'admin:add_radio_channel': (channelData: RadioChannelPayload) => db.addRadioChannel(channelData),
    'admin:update_radio_channel': ({ id, name, color }: UpdateRadioChannelPayload) => db.updateRadioChannel(id, name, color),
    'admin:delete_radio_channel': ({ channelId }: DeleteRadioChannelPayload) => db.deleteRadioChannel(channelId),

    // --- LOCATIONS ---
    'admin:add_location': ({ name, type, parent_id }: AddLocationPayload) => db.addLocation({ name, type, parent_id }),
    'admin:update_location': ({ id, name, type, parent_id }: UpdateLocationPayload) => db.updateLocation({ id, name, type, parent_id }),
    'admin:delete_location': ({ locationId }: DeleteLocationPayload) => db.deleteLocation(locationId),
    'admin:seed_default_locations': () => db.seedDefaultLocations(),

    // --- DB MAINTENANCE ---
    // Genuine-Admin gate on the whole family (load-bearing fail-closed backstop to
    // the admin:db:destroy perm enforced by the dispatcher): check is a count oracle
    // over read-gated domains, repair re-seeds RBAC / promotes an Admin, prune
    // issues raw mass DELETEs, and the two module resets delete every treasury /
    // quartermaster row outright. None may be triggered by a non-Admin (e.g.
    // Dispatcher).
    'admin:db:check': async ({ user }: DbMaintenancePayload) => { await assertAdminRoleFresh(user); return db.runDatabaseHealthCheck(); },
    'admin:db:repair': async ({ user }: DbMaintenancePayload) => { await assertAdminRoleFresh(user); return db.repairDatabase(); },
    'admin:db:prune': async ({ user, retentionDays, targets }: DbPrunePayload) => { await assertAdminRoleFresh(user); return db.pruneDatabaseData(retentionDays, targets); },
    // Re-encrypt every at-rest secret under the CURRENT SECRETS_ENCRYPTION_KEY, so the
    // previous key can be removed from the environment. Same genuine-Admin bar as the rest
    // of this family. Values that decrypt under NEITHER key are counted and SKIPPED, never
    // written back — a rotation tool must not be able to destroy the credentials it was
    // pointed at.
    'admin:db:rotate_secrets': async ({ user }: DbMaintenancePayload) => {
        await assertAdminRoleFresh(user);
        const result = await db.rotateSecretsEncryption();
        // Structural guard, same shape as the dispatcher's auditDenial: `void` protects a
        // caller from a REJECTED promise, not from an absent export in a partial test double.
        // A failed audit write must never fail the rotation that already happened.
        try {
            void db.recordSecurityEvent({
                event: result.failed > 0 ? 'secrets.rotation.incomplete' : 'secrets.rotation.completed',
                action: 'admin:db:rotate_secrets',
                actorUserId: user?.id ?? null,
                outcome: 'allowed',
                details: { ...result },
            });
        } catch { /* audit is best-effort; it must never fail the operation */ }
        return result;
    },
    // These two carried NO guard at all — only the dispatcher's map entry, and that
    // entry was the domain perm rather than the family's high bar, so the comment
    // above was false for exactly the two rawest DELETEs in it. Both bars now apply.
    'admin:db:reset_finances': ({ user }: DbMaintenancePayload) => { assertDomainResetPerm(user, 'finance:manage'); return db.resetFinancesData(); },
    'admin:db:reset_quartermaster': ({ user }: DbMaintenancePayload) => { assertDomainResetPerm(user, 'qm:manage'); return db.resetQuartermasterData(); },
    // Danger Zone. userId is the dispatcher-injected acting admin (ACTOR_ID_FIELDS),
    // never client-supplied — full_reset restores exactly that account. The typed
    // confirmation phrase is validated HERE (server-side) — never trust the
    // browser-only gate — and the action requires the genuine Admin role in
    // addition to the admin:db:destroy perm enforced by the dispatcher.
    'admin:db:full_reset': ({ userId, user, confirmPhrase }: DangerZonePayload & { userId: number }) => {
        assertDangerZone(user, confirmPhrase, 'RESET');
        return db.fullResetOrg(userId);
    },
    'admin:db:full_wipe': ({ user, confirmPhrase }: DangerZonePayload) => {
        assertDangerZone(user, confirmPhrase, 'WIPE EVERYTHING');
        return db.fullWipeOrg();
    },

    // --- Maintenance mode + force-logout (org-wide operational settings) ---
    'admin:get_platform_settings': () => db.getPlatformSettings(),
    'admin:update_platform_settings': async ({ user, maintenanceMode, maintenanceMessage }: { user?: AdminActor; maintenanceMode?: boolean; maintenanceMessage?: string }) => {
        // Genuine-Admin gate: enabling maintenance mode locks out every non-Admin
        // (including the actor) until a true Admin lifts it — a non-Admin must never
        // be able to trigger that irreversible-to-them lockout.
        await assertAdminRoleFresh(user);
        const patch: Record<string, unknown> = {};
        if (maintenanceMode !== undefined) patch.maintenance_mode = !!maintenanceMode;
        if (maintenanceMessage !== undefined) patch.maintenance_message = String(maintenanceMessage);
        return db.updatePlatformSettings(patch);
    },
    // Timestamp is set server-side (now) so a client can't backdate it; tokens
    // issued before it are 401'd by the dispatcher/read-path enforcement. Advancing
    // it kills EVERY live session platform-wide — genuine Admin only.
    'admin:force_logout_all': async ({ user }: { user?: AdminActor }) => {
        await assertAdminRoleFresh(user);
        return db.updatePlatformSettings({ force_logout_timestamp: new Date().toISOString() });
    },
    // Revoke ONE user's live sessions (compromised/leaked token) without removing
    // the account. targetUserId is a target-identity field (not actor-forced).
    'admin:revoke_user_sessions': ({ targetUserId }: { targetUserId: number }) => db.revokeUserSessions(targetUserId),

    // --- Optional module toggles (warehouse/quartermaster/finances/leaderboard/
    // externalTools) — local on/off switches stored in the 'orgFeatures' blob,
    // read back via getMainState → orgMeta.features. (Government has its own
    // admin:update_governments_config path.)
    'admin:update_features': ({ patch }: { patch: Record<string, unknown> }) => db.updateOrgFeatures(patch || {}),

    // --- ORG IMPORT (self-hosted bootstrap from a hosted org export) ---
    // One-time ingest of the customer-portal NDJSON export. The importer refuses
    // if this instance already has org data; the actor is irrelevant (import is
    // not attributed). The raw NDJSON is parsed/validated server-side.
    'admin:import_org': async ({ ndjson }: ImportOrgPayload) => {
        if (typeof ndjson !== 'string' || ndjson.trim().length === 0) {
            throw new Error('No import data provided.');
        }
        // Hard cap to avoid OOM on a hostile payload (~64 MB of text).
        if (ndjson.length > 64 * 1024 * 1024) {
            throw new Error('Import file too large (max 64 MB).');
        }
        return db.importOrgData(ndjson);
    },
};
