
import { supabase, handleSupabaseError, getSystemRoles, broadcastToOrg } from './db/common.js';
import { toUser, toRank, toUnit, toAnnouncement, toServiceRequest, toSpecializationTag, toCertification, toCommendation } from './db/mappers.js';
import { redactRequestFeedbackForViewer } from './db/requests.js';

import * as users from './db/users.js';
import * as ops from './db/ops.js';
import { listOperationTemplates } from './db/operation-templates.js';
import * as intel from './db/intel.js';
import * as hr from './db/hr.js';
import * as system from './db/system.js';
import { log as baseLog } from './log.js';

const log = baseLog.child({ module: 'db.barrel' });

// Re-export everything from modules
export { supabase, handleSupabaseError, getSystemRoles, broadcastToOrg };
export * from './db/users.js';
export * from './db/requests.js';
export * from './db/ops.js';
export * from './db/operation-templates.js';
export * from './db/intel.js';
export * from './db/hr.js';
export * from './db/system.js';
export * from './db/platform.js';
export * from './db/wiki.js';
export * from './db/seeder.js';
export * from './db/fleet.js';
export * from './db/government.js';
export * from './db/finances.js';
export * from './db/quartermaster.js';
export * from './db/warehouse.js';
export * from './db/locations.js';
export * from './db/public.js';
export * from './db/importer.js';
export * from './db/alliances.js';
export * from './db/operations-federation.js';
export * from './db/allianceSync.js';
export * from './db/marketplace.js';

// --- STATE AGGREGATION (single-org: no organization_id scoping) ---

export async function getMainState() {
    // Lite roster fetch — heavy nested fields (limiting_markers, certifications,
    // commendations, conductRecord) lazy-load via the user_detail query target.
    // Explicit cap (PostgREST silently truncates at 1000 anyway) — the
    // truncation warning below surfaces when an org outgrows it.
    const userQuery = supabase.from('users').select(users.USER_LIST_SELECT_QUERY).is('deleted_at', null).limit(1000);
    const rankQuery = supabase.from('ranks').select('id, name, icon_url, sort_order').order('sort_order').order('name');
    const unitQuery = supabase.from('units').select('id, name, parent_unit_id, sort_order, leader_id, logo_url, banner_url, motto, description, has_radio_channel, linked_channel_id, is_restricted').order('sort_order').order('name');
    const roleQuery = supabase.from('roles').select('id, name, description, is_system').order('name');
    const locQuery = supabase.from('locations').select('id, name, parent_id, type');
    const specQuery = supabase.from('specialization_tags').select('id, name, description, icon, image_url');
    const certQuery = supabase.from('certifications').select('id, name, description, icon, image_url');
    const commQuery = supabase.from('commendations').select('id, name, description, icon, image_url');
    const radioQuery = supabase.from('radio_channels').select('id, name, color, sort_order, type');

    const [
        usersList,
        ranks,
        units,
        roles,
        locations,
        specializations,
        certifications,
        commendations,
        radioChannels,
        serviceTypes,
        securityClearances,
        limitingMarkers,
        features
    ] = await Promise.all([
        userQuery,
        rankQuery,
        unitQuery,
        roleQuery,
        locQuery,
        specQuery,
        certQuery,
        commQuery,
        radioQuery,
        system.getServiceTypes(),
        system.getSecurityClearances(),
        system.getLimitingMarkers(),
        system.getOrgFeatures()
    ]);

    // Single-org: optional modules are admin-configured via `features` (the
    // 'orgFeatures' settings blob — see system.getOrgFeatures). No member caps /
    // pricing tiers / subscriptions.
    const orgMeta = {
        memberCount: (usersList.data || []).length,
        features: features as Record<string, unknown>,
    };

    if ((usersList.data || []).length === 1000) {
        log.warn('getMainState roster hit the 1000-row cap — rows beyond it are not shipped; the roster needs pagination at this org size');
    }
    return {
        users: (usersList.data || []).map(d => toUser(d as unknown as Parameters<typeof toUser>[0])).filter(Boolean),
        ranks: (ranks.data || []).map(toRank).filter(Boolean),
        units: (units.data || []).map(toUnit).filter(Boolean),
        roles: roles.data || [],
        locations: locations.data || [],
        specializationTags: (specializations.data || []).map(toSpecializationTag),
        certifications: (certifications.data || []).map(toCertification),
        commendations: (commendations.data || []).map(toCommendation),
        radioChannels: radioChannels.data || [],
        serviceTypes: serviceTypes,
        securityClearances: securityClearances,
        limitingMarkers: (limitingMarkers || []).map((m: any) => ({ id: m.id, name: m.name, code: m.code, description: m.description, syncRestricted: m.sync_restricted || false })),
        orgMeta
    };
}

const REQUEST_SELECT = `
    id, client_id, unregistered_client_rsi_handle, service_type, location, description, status, urgency, threat_level, lead_responder_id, created_at, updated_at, uec_earned, medigel_consumed, client_rating, client_feedback, rated, party_info, secondary_client_handles,
    client:users!service_requests_client_id_fkey(id, name, avatar_url, rsi_handle, role_id, rank_id, reputation),
    request_responders(
        user:users!request_responders_user_id_fkey(id, name, avatar_url, rsi_handle, role_id, rank_id)
    ),
    statusHistory:status_history(
        id, request_id, status, updated_at, note,
        updated_by:users!status_history_updated_by_fkey(id, name, avatar_url)
    )
`;

// Request visibility is enforced server-side (client-side filters are cosmetic):
// holders of a request-duty permission (the dispatch board audience) see the
// full log; everyone else sees only requests they created. Permission-based
// rather than role-name-based so custom roles behave correctly.
function canSeeAllRequests(user?: { role?: string; permissions?: string[] } | null): boolean {
    if (!user) return false;
    if (user.role === 'Admin') return true;
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    return perms.includes('request:dispatch') || perms.includes('request:triage') || perms.includes('request:accept');
}

export async function getRequestsState(currentUser?: { id: number; role?: string; permissions?: string[] } | null) {
    let query = supabase.from('service_requests')
        .select(REQUEST_SELECT)
        .order('created_at', { ascending: false }).limit(200);
    if (!canSeeAllRequests(currentUser)) {
        // Own-requests only — scoped in SQL so other clients' rows never
        // even reach this process's response path.
        query = query.eq('client_id', currentUser?.id ?? -1);
    }
    const { data, error } = await query;

    handleSupabaseError({ error, message: 'Failed to get requests' });
    // Strip the permission-gated free-text feedback per viewer (request:view:feedback).
    // canSeeAllRequests admits any request:accept holder (every Member), so without
    // this strip the candid feedback would cross the wire to all members.
    return { requests: (data || []).map(r => redactRequestFeedbackForViewer(toServiceRequest(r as unknown as Parameters<typeof toServiceRequest>[0]), currentUser)) };
}

export async function getRequestDetail(requestId: string, currentUser?: { id: number; role?: string; permissions?: string[] } | null) {
    const { data, error } = await supabase.from('service_requests')
        .select(REQUEST_SELECT)
        .eq('id', requestId)
        .single();

    if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
    }
    const request = toServiceRequest(data as unknown as Parameters<typeof toServiceRequest>[0]);
    // Same predicate as the list — non-duty callers may only fetch their own
    // request (or one they responded to). null → 404 upstream, indistinguishable
    // from a missing row.
    if (!canSeeAllRequests(currentUser)) {
        const isOwn = request.clientId === currentUser?.id;
        const isResponder = (request.assignedMemberIds || []).includes(currentUser?.id as number);
        if (!isOwn && !isResponder) return null;
    }
    // Redact the permission-gated free-text feedback for non-feedback viewers
    // (mirrors the list path so detail/list can't drift).
    return redactRequestFeedbackForViewer(request, currentUser);
}

export async function getAnnouncementsState(currentUser?: { role?: string; permissions?: string[] } | null) {
    const { data, error } = await supabase.from('announcements').select('id, title, body, author, type, audience, publish_date, expiry_date')
        .order('publish_date', { ascending: false }).limit(100);
    handleSupabaseError({ error, message: 'Failed to get announcements' });
    let announcements = (data || []).map(toAnnouncement);
    // Audience scoping server-side (mirrors + ENFORCES the HRNoticesTab client
    // filter): an Admin-only / staff-only notice body must not ship to a Client.
    // Managers (Admin or admin:config:notices) see all for the management tab.
    const canManage = currentUser?.role === 'Admin'
        || (Array.isArray(currentUser?.permissions) && currentUser!.permissions!.includes('admin:config:notices'));
    if (!canManage) {
        const role = currentUser?.role;
        announcements = announcements.filter((a) => {
            if (!role || !Array.isArray(a.audience)) return false;
            if (a.audience.includes(role)) return true;
            // Dispatcher inherits Member-targeted notices (mirrors the client alias).
            if (a.audience.includes('Member') && role === 'Dispatcher') return true;
            return false;
        });
    }
    return { announcements };
}

export async function getDiscordState() {
    const settingsQuery = supabase.from('settings').select('value').eq('key', 'discordConfig');
    const rolesQuery = supabase.from('synced_discord_roles').select('id, name, color');
    const mappingsQuery = supabase.from('rank_mappings').select('discord_role_id, rank_id, role_id');

    const [config, roles, mappings] = await Promise.all([
        settingsQuery.maybeSingle(),
        rolesQuery,
        mappingsQuery,
    ]);
    const rankMappings: Record<string, string> = {};
    const roleMappings: Record<string, string> = {};
    (mappings.data || []).forEach((m: any) => {
        if (m.rank_id) rankMappings[m.discord_role_id] = m.rank_id.toString();
        if (m.role_id) roleMappings[m.discord_role_id] = m.role_id.toString();
    });
    return {
        discordConfig: config.data?.value || {},
        syncedDiscordRoles: roles.data || [],
        rankMappings,
        roleMappings
    };
}

export async function getOrgTenantUrl(): Promise<string> {
    // Single-org: prefer the configured app URL, else the deployment origin.
    const { data: setting } = await supabase.from('settings').select('value').eq('key', 'systemConfig').maybeSingle();
    const appUrl = (setting?.value as { appUrl?: string } | null)?.appUrl;
    if (appUrl) return appUrl;
    return process.env.APP_URL || 'http://localhost:3000';
}

export async function getOperationsState(user?: any) {
    if (!user) return { operations: [], operationTemplates: [] };
    const [operationsRes, templatesRes] = await Promise.allSettled([
        ops.getOperations(user),
        listOperationTemplates(user),
    ]);
    const operations = operationsRes.status === 'fulfilled' ? operationsRes.value : [];
    const operationTemplates = templatesRes.status === 'fulfilled' ? templatesRes.value : [];
    if (operationsRes.status === 'rejected') {
        log.error('getoperations rejected', { err: operationsRes.reason });
    }
    if (templatesRes.status === 'rejected') {
        log.error('listoperationtemplates rejected', { err: templatesRes.reason });
    }
    return { operations, operationTemplates };
}

export async function getWarrantsState() {
    // WARRANT_SELECT is shared with the warrant_slice single-row fetch
    // (intel.getWarrantByIdHydrated) so list and slice shapes can never drift.
    const { data, error } = await supabase.from('warrants')
        .select(intel.WARRANT_SELECT)
        .order('created_at', { ascending: false })
        .limit(200);
    handleSupabaseError({ error, message: 'Failed to get warrants' });
    return { warrants: (data || []).map(w => intel.toHydratedWarrant(w as unknown as Parameters<typeof intel.toHydratedWarrant>[0])) };
}

export async function getExternalToolsState(currentUser?: { role?: string; permissions?: string[] } | null) {
    const { data, error } = await supabase.from('external_tools').select('id, title, description, url, icon, audience, category, sort_order');
    handleSupabaseError({ error, message: 'Failed to get tools' });
    let rows = (data || []).map((r: any) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        url: r.url,
        icon: r.icon,
        audience: r.audience,
        category: r.category || undefined,
        sortOrder: typeof r.sort_order === 'number' ? r.sort_order : 0,
    }));
    // Audience scoping server-side (mirrors — and now enforces — the
    // ExternalToolsView client filter): a tool aimed at members/staff must
    // not ship its title/url to a Client. The management tab needs the full
    // list, so Admins AND admin:config:tools holders are exempt.
    const canManageTools = currentUser?.role === 'Admin'
        || (Array.isArray(currentUser?.permissions) && currentUser!.permissions!.includes('admin:config:tools'));
    if (!canManageTools) {
        const role = currentUser?.role;
        rows = rows.filter((t) => (Array.isArray(t.audience) && role) ? t.audience.includes(role) : false);
    }
    rows.sort((a, b) => {
        const ca = a.category || '￿';
        const cb = b.category || '￿';
        if (ca !== cb) return ca.localeCompare(cb);
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.title.localeCompare(b.title);
    });
    return { externalTools: rows };
}

export async function getIntelState(currentUser?: any) {
    const [intelTargetIndex, intelHubStats, activeBulletins] = await Promise.all([
        // The index/stats aggregates are clearance-ceilinged per viewer — a
        // low-clearance member must not learn which targets appear only in
        // classified reports (or their threat levels/counts).
        intel.getIntelTargetIndex(currentUser),
        intel.getIntelHubStats(currentUser),
        intel.getActiveBulletins(),
    ]);
    // Bulletin bodies carry classification + limiting markers. Filter them by the
    // requester's clearance before they reach the browser.
    return { intelTargetIndex, intelHubStats, activeBulletins: intel.filterIntelByClearance(activeBulletins, currentUser) };
}

// Permission helper for the aggregate read path. Admin bypasses (mirrors the
// services.ts dispatcher + userFilters behaviour); otherwise the perm must be
// explicitly granted on the resolved user.
function aggHasPerm(currentUser: any, perm: string): boolean {
    if (!currentUser) return false;
    if (currentUser.role === 'Admin') return true;
    return Array.isArray(currentUser.permissions) && currentUser.permissions.includes(perm);
}

// getState() is the aggregate used by BOTH the boot response
// (handleInitialState) and the no-subset "full state" refresh. Gate each
// sensitive slice by the SAME permission the dedicated subset requires in
// api/query.ts, so a low-privilege member (e.g. a Client) never receives
// warrants/KOS, intel, or HR via boot or the legacy full-state path. (HR is
// additionally redacted inside getHRState for hr:view-without-hr:recruiter
// callers.)
export async function getState(currentUser?: any) {
    const empty = Promise.resolve({} as Record<string, never>);
    const wantWarrants = aggHasPerm(currentUser, 'warrant:view');
    const wantIntel = aggHasPerm(currentUser, 'intel:view') || aggHasPerm(currentUser, 'intel:view:clearance');
    const wantHr = aggHasPerm(currentUser, 'hr:view');
    // Operations: the dedicated subset requires operations:view, so gate the
    // boot aggregate's list identically.
    const wantOps = aggHasPerm(currentUser, 'operations:view');

    // NOTE: getDiscordState() is gone from the aggregate. Its discordConfig
    // was always overwritten by the settings spread below anyway (stripSecrets
    // reduces it to clientId + channel ids at the wire), and the role-sync
    // maps (syncedDiscordRoles/rankMappings/roleMappings) are admin-console
    // data — they ride the now-gated 'discord' subset, fetched by the
    // Discord settings tab on mount.
    const [main, reqs, anns, operations, tools, settings, warrants, hrState, intelState] = await Promise.all([
        getMainState(), getRequestsState(currentUser), getAnnouncementsState(currentUser),
        wantOps ? getOperationsState(currentUser) : empty,
        getExternalToolsState(currentUser), system.getAllSettings({ decryptSecrets: false }),
        wantWarrants ? getWarrantsState() : empty,
        wantHr ? hr.getHRState(currentUser) : empty,
        wantIntel ? getIntelState(currentUser) : empty,
    ]);
    return { ...main, ...reqs, ...anns, ...operations, ...warrants, ...tools, ...settings, ...hrState, ...intelState };
}
