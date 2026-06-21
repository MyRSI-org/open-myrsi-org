
import * as db from '../../lib/db.js';
import * as discord from '../../lib/discord.js';
import { assertIdArray } from '../../lib/pgrest.js';
import { MAX_IMPORT_BATCH_SIZE } from '../../lib/db/system.js';
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

// Danger-Zone (full reset / full wipe) destroys ALL data. Defense beyond the
// dispatcher's admin:db:destroy perm gate: require the genuine Admin role AND a
// confirmation phrase validated server-side — the typed phrase must never be a
// browser-only gate. Fails closed on a missing/incorrect phrase or non-Admin.
interface DangerZonePayload extends OrgScopedPayload {
    user?: { role?: string };
    confirmPhrase?: string;
}

function assertDangerZone(user: { role?: string } | undefined, confirmPhrase: string | undefined, expected: string): void {
    if (user?.role !== 'Admin') {
        throw new Error('Only an Admin may perform this action.');
    }
    if (typeof confirmPhrase !== 'string' || confirmPhrase.trim() !== expected) {
        throw new Error(`Confirmation phrase incorrect. Type "${expected}" exactly to proceed.`);
    }
}

// Config-update handlers: spread `...rest` into the matching db.update*Config
// call. rest is a partial config tree.
type DiscordConfigPayload = OrgScopedPayload & Partial<DiscordConfig>;
type HeroConfigPayload = OrgScopedPayload & Partial<HeroCardConfig>;
type BrandingConfigPayload = OrgScopedPayload & Partial<BrandingConfig>;
type PublicPageConfigPayload = OrgScopedPayload & Partial<PublicPageConfig>;
type OpenGraphConfigPayload = OrgScopedPayload & Partial<OpenGraphConfig>;
type AIConfigPayload = OrgScopedPayload & Partial<AIConfig>;
type RadioConfigPayload = OrgScopedPayload & Partial<RadioConfig>;
type WikiHomeConfigPayload = OrgScopedPayload & Partial<WikiHomeConfig>;

interface ListTestimonialCandidatesPayload extends OrgScopedPayload {
    search?: string;
    limit?: number;
    offset?: number;
}

interface UpdateSystemConfigPayload extends OrgScopedPayload {
    appUrl?: string;
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

interface DbPrunePayload extends OrgScopedPayload {
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
    // --- SETTINGS & CONFIG ---
    'admin:update_discord_config': async (payload: DiscordConfigPayload) => { await db.updateDiscordSettings(stripActorFields(payload)); },
    'admin:update_hero_config': async (payload: HeroConfigPayload) => { await db.updateHeroCardConfig(stripActorFields(payload)); },
    'admin:update_branding_config': async (payload: BrandingConfigPayload) => { await db.updateBrandingConfig(stripActorFields(payload)); },
    'admin:update_public_page_config': async (payload: PublicPageConfigPayload) => { await db.updatePublicPageConfig(stripActorFields(payload)); invalidatePublicCache(); },
    'admin:list_testimonial_candidates': async ({ search, limit, offset }: ListTestimonialCandidatesPayload) => db.getTestimonialCandidates({ search, limit, offset }),
    'admin:update_system_config': async ({ appUrl }: UpdateSystemConfigPayload) => { await db.updateSystemConfig({ appUrl }); },
    'admin:update_intel_sharing_config': async ({ config }: IntelSharingConfigPayload) => { await db.updateIntelSharingConfig(config); },
    'admin:update_hr_config': async ({ config }: HRConfigPayload) => { await db.updateHRConfig(config); },
    'admin:get_intel_sharing_config': async () => { return db.getIntelSharingConfig(); },
    'admin:update_opengraph_config': async (payload: OpenGraphConfigPayload) => { await db.updateOpenGraphConfig(stripActorFields(payload)); },
    'admin:update_ai_config': async (payload: AIConfigPayload) => { await db.updateAIConfig(stripActorFields(payload)); },
    'admin:update_radio_config': async (payload: RadioConfigPayload) => { await db.updateRadioConfig(stripActorFields(payload)); },
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
    // Bulk demote N users to the org's Client system role. Wraps updateUser
    // per-target so assertCanAssignRole's privilege guard applies; tier
    // hierarchy permits demote-down. Used by the over-cap grace banner's
    // bulk-demote tool to bring an org back under its tier's member cap.
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
    'admin:promote_user': ({ targetUserId }: TargetUserPayload) => db.promoteUserToMember(targetUserId),
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
        if (roleId) {
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
        const sysRoles = await db.getSystemRoles();
        if (sysRoles.client && sysRoles.client.id === roleId) {
            throw new Error('The Client role is locked. Its permissions cannot be modified.');
        }
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
    'admin:db:check': () => db.runDatabaseHealthCheck(),
    'admin:db:repair': () => db.repairDatabase(),
    'admin:db:prune': ({ retentionDays, targets }: DbPrunePayload) => db.pruneDatabaseData(retentionDays, targets),
    'admin:db:reset_finances': () => db.resetFinancesData(),
    'admin:db:reset_quartermaster': () => db.resetQuartermasterData(),
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
    'admin:update_platform_settings': ({ maintenanceMode, maintenanceMessage }: { maintenanceMode?: boolean; maintenanceMessage?: string }) => {
        const patch: Record<string, unknown> = {};
        if (maintenanceMode !== undefined) patch.maintenance_mode = !!maintenanceMode;
        if (maintenanceMessage !== undefined) patch.maintenance_message = String(maintenanceMessage);
        return db.updatePlatformSettings(patch);
    },
    // Timestamp is set server-side (now) so a client can't backdate it; tokens
    // issued before it are 401'd by the dispatcher/read-path enforcement.
    'admin:force_logout_all': () => db.updatePlatformSettings({ force_logout_timestamp: new Date().toISOString() }),
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
