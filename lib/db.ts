
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
import { resolveAppUrl, type ResolvedAppUrl } from './appUrl.js';
import { permissionSatisfied } from './permissionImplications.js';
import { mayReceiveRoster } from './rosterGate.js';
import { projectSettingsForViewer } from './settingsProjection.js';
import type { ServiceTypeConfig } from '../types.js';

const log = baseLog.child({ module: 'db.barrel' });

// Re-export everything from modules
export { supabase, handleSupabaseError, getSystemRoles, broadcastToOrg };
export * from './db/adminIdentity.js';
export * from './db/clientRoleLock.js';
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
export * from './db/notifications.js';
export * from './db/securityEvents.js';
export * from './db/bans.js';
export * from './db/secretsRotation.js';
export * from './db/academy.js';
export * from './db/blueprints.js';

// --- STATE AGGREGATION (single-org: no organization_id scoping) ---

/** The viewer shape getMainState needs. SERVER-RESOLVED FACTS ONLY — never a
 *  client-supplied array. `isSystemAdmin` is stamped by getUserById
 *  (lib/db/users.ts stampSystemAdmin), which is what both callers pass. */
type MainStateViewer = { permissions?: string[] | null; isSystemAdmin?: boolean } | null | undefined;

/**
 * Everything in the `main` bundle that is ORG PERSONNEL data: the member roster, the
 * rank/unit/role tables, the classification taxonomy and the comms plan. Split out so
 * a non-staff caller never ISSUES these queries — see getMainState.
 *
 * getServiceTypes() and getOrgFeatures() are deliberately NOT in here: they are
 * issued for EVERY caller from getMainState, because a Client's request form depends
 * on both. Moving getServiceTypes in here would blank DashboardView's
 * activeServiceTypes and leave `serviceType` seeded to the hard-coded literal
 * 'Security', which may not exist in the org — a total loss of the customer's only
 * entitled flow, by a second route.
 */
async function getStaffMainState(canSeeSyncRestricted: boolean) {
    // Lite roster fetch — heavy nested fields (limiting_markers, certifications,
    // commendations, conductRecord) lazy-load via the user_detail query target.
    // Explicit cap (PostgREST silently truncates at 1000 anyway) — the
    // truncation warning below surfaces when an org outgrows it.
    //
    // USER_ROSTER_SELECT_QUERY, not USER_LIST_SELECT_QUERY: the roster projection is
    // decoupled from getUserById's degraded session-actor fallback, and it must stay
    // BYTE-IDENTICAL with getUsersByIdsLite's (lib/db/users.ts) because mergeUsersSlice
    // replaces whole rows. Both call sites move together or neither does. Pinned by
    // tests/rosterSelectProjection.test.ts.
    const userQuery = supabase.from('users').select(users.USER_ROSTER_SELECT_QUERY).is('deleted_at', null).order('id', { ascending: true }).limit(1000);
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
        securityClearances,
        limitingMarkers,
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
        system.getSecurityClearances(),
        system.getLimitingMarkers(),
    ]);

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
        securityClearances: securityClearances,
        // `syncRestricted` marks the compartments that must NEVER cross federation, and
        // owner decision D10 withholds it from every tier below admin:access — see the
        // canSeeSyncRestricted comment in getMainState for the one cosmetic consequence
        // that has (CreateOperationWizard's badge). The key is OMITTED, never `false`:
        // LimitingMarker.syncRestricted is optional, and a fabricated `false` would
        // assert "this compartment IS federatable" — the one thing it must never say by
        // accident.
        limitingMarkers: (limitingMarkers || []).map((m: any) => (canSeeSyncRestricted
            ? { id: m.id, name: m.name, code: m.code, description: m.description, syncRestricted: m.sync_restricted || false }
            : { id: m.id, name: m.name, code: m.code, description: m.description })),
    };
}

/** INFERRED, never hand-written. A hand-written domain-typed interface produces three
 *  TS2322s against this repo's own TypeScript: toUser returns `User | undefined` and
 *  `.filter(Boolean)` does not narrow; roles.description / is_system and
 *  security_clearances.description are `| null` on the DB row and `?:` on the domain
 *  type. lib/db.ts is typechecked by BOTH tsconfig targets, so hand-writing it turns a
 *  green tree red on `npx tsc --noEmit` AND `npm run build:server`. */
type StaffMainState = Awaited<ReturnType<typeof getStaffMainState>>;

export type MainState = Partial<StaffMainState> & {
    // Every authenticated caller. A Client's request form renders the service picker,
    // and their own request rows' icon/colour, from this.
    serviceTypes: ServiceTypeConfig[];
    // PHASE 3 ITEM 2'S DELIVERABLE — DO NOT DELETE. A boolean|null, NOT a count, and
    // NOT derived from the roster array this function has just stopped shipping.
    // Sourced from users.isAnyStaffOnDuty(). It lives in the ALWAYS-PRESENT half: a
    // non-staff caller is the only caller who cannot derive it, so putting it inside
    // getStaffMainState would delete the entire point. Without it every Client
    // permanently sees "Services Unavailable" and cannot raise a request.
    anyStaffOnDuty: boolean | null;
    orgMeta: { features: Record<string, unknown> };
};

export async function getMainState(viewer: MainStateViewer): Promise<MainState> {
    // CLIENT-TIER READ BOUNDARY. The `main` bundle's audience model used to be
    // "anonymous vs authenticated", and the org's EXTERNAL CUSTOMERS (the Client
    // system role) are authenticated — so a customer received the member roster, the
    // rank/unit/role tables, the classification ladder and the compartment codeword
    // catalogue.
    //
    // A PERMISSION test plus the server-stamped role IDENTITY, never a role-tier test:
    // inferUserRoleTier (lib/db/mappers.ts) falls THROUGH to UserRole.Client for any
    // custom role holding no tier-marking permission, so a tier test would deny real
    // staff on customised roles their own org's directory.
    //
    // THREE disjuncts, not two (owner decision D4): the third,
    // ROSTER_AUTHORITY_PERMS, exists because a hand-built role holding ONLY
    // admin:view:roster / admin:user:update / admin:user:manage_clearance /
    // hr:recruiter|manager|admin holds nothing in STAFF_VIEW_PERMS, and
    // lib/permissionImplications.ts has three keys only, so none of those reaches
    // hasAnyStaffViewPerm by implication. Without it this build would assert both
    // "this caller may read another member's clearanceLevel" (CLEARANCE_VISIBLE_PERMS,
    // lib/db/userFilters.ts) and "this caller is an external customer with no roster
    // to read" of the same role. Every SEEDED role passes on the second disjunct
    // alone: Member holds user:view:roster + user:toggle_duty + hr:view +
    // warrant:view; Dispatcher holds radio:manage + request:dispatch; Admin is
    // isSystemAdmin; Client holds only request:create|cancel|rate.
    //
    // The staff half is NOT FETCHED AT ALL for a non-staff caller — deliberately not a
    // post-fetch delete pass: a query that was never issued cannot leak, and the roster
    // query alone is 1000 rows x ~44 columns. This aggregator already gates by not
    // fetching elsewhere (wantOps ? getOperationsState(...) : empty), and that
    // placement is the guardrail being defended, not an implementation detail.
    //
    // NOT CLOSED HERE, and no longer open either: the `settings` blob spread over this
    // projection at the two call sites used to carry wikiHomeConfig, hrConfig,
    // system_broadcast and a SECOND copy of the module-enablement map (`orgFeatures`).
    // Phase 3 item 8 closed that one layer out, in projectSettingsForViewer
    // (lib/settingsProjection.ts), which both merge sites now run the blob through — so
    // this function still owns only the personnel half, by design. Keeping the two
    // boundaries in separate modules is deliberate: they gate on different things (this
    // one on roster authority, that one on the per-domain read permission).
    const isRosterViewer = mayReceiveRoster({
        isSystemAdmin: viewer?.isSystemAdmin === true,
        permissions: viewer?.permissions ?? null,
    });

    // The per-type Discord routing snowflake is admin config, not request-form data.
    // Its only reader/writer is the Service Types admin tab. The SAVE is safe not
    // because the tab is unreachable — a custom role holding admin:access but not
    // admin:config:servicetypes DOES render it, because the CLIENT hasPermission
    // short-circuits on role === 'Admin' — but because the server dispatcher has no
    // Admin role bypass (api/services.ts gates on permissionSatisfied alone), so a save
    // from that role 403s rather than wiping the routing. Residual: that role sees every
    // routed type as unrouted.
    const canSeeServiceRouting = permissionSatisfied(viewer?.permissions ?? [], 'admin:config:servicetypes');

    // OWNER DECISION D10, as written: admin-only for every tier below admin:access.
    // Two disjuncts, and do not add a third without the owner amending D10 on the
    // record — a code comment is not the place to overturn a decision.
    //
    // KNOWN, REPORTED CONSEQUENCE (not a bug to "fix" by widening): the flag has THREE
    // client consumers, not the one D10's stated premise named.
    // ClearanceManagementTab and BulkAssignClearanceModal sit behind admin:access, but
    // CreateOperationWizard renders the "SYNC RESTRICTED" marker-chip badge and the
    // "(sync-restricted)" review-step suffix, and its entry gate is operations:create.
    // So an ops planner without admin:access loses those two labels. That is COSMETIC:
    // the actual federation withholding is enforced server-side against the DB column
    // (lib/db/operations-federation.ts), never against this projected field.
    const canSeeSyncRestricted = viewer?.isSystemAdmin === true
        || permissionSatisfied(viewer?.permissions ?? [], 'admin:access');

    const [staff, serviceTypes, features, anyStaffOnDuty] = await Promise.all([
        isRosterViewer ? getStaffMainState(canSeeSyncRestricted) : Promise.resolve(null),
        system.getServiceTypes(),
        // getOrgFeatures now THROWS on a read fault (it used to swallow the error and
        // return {}). Caught here so a settings-row blip degrades exactly as it always
        // did — the optional-module nav entries hide — instead of failing the entire
        // main-state read and blocking boot. Safe because this value is cosmetic at this
        // call site: the server-side gate is isOptionalFeatureEnabled, which does its own
        // fail-closed catch and never consults this projection.
        system.getOrgFeatures().catch((e) => {
            log.error('org features read failed; optional-module nav will hide', { err: e });
            return {} as Record<string, unknown>;
        }),
        // Inside the Promise.all so the availability probe parallelises with the other
        // queries rather than adding a serial hop.
        users.isAnyStaffOnDuty(),
    ]);

    return {
        // Spread, not per-key assignment: the staff keys are ABSENT for a non-staff
        // caller, not empty. Every client slice-setter is `if (data.<key>)`
        // (contexts/MembersContext.tsx, contexts/ConfigContext.tsx), so omission is a
        // no-op, and an empty array would be indistinguishable from "an org with no
        // members" — which would make a genuine roster-fetch failure read as valid data.
        ...(staff ?? {}),
        serviceTypes: canSeeServiceRouting
            ? serviceTypes
            // Rebuild by allow-list rather than deleting one key, so a future column
            // added to service_types cannot ride to a non-admin. Assignable to
            // ServiceTypeConfig because discordChannelId is optional. Do NOT filter by
            // isActive: RequestCard and ServiceRequestDetailView look a request's type
            // up BY NAME across the unfiltered array, so filtering server-side would
            // blank the icon/colour on any historic request whose type the org later
            // deactivated. Both Client call sites already filter client-side.
            : serviceTypes.map(t => ({
                id: t.id, name: t.name, icon: t.icon, color: t.color,
                description: t.description, isActive: t.isActive,
            })),
        // Server-side answer to "is anyone available to take a request?", for callers
        // with no roster to derive it from. Rides `main` (and therefore `initial-state`,
        // which spreads getMainState in getState below) so the value is present at page
        // load; the users_presence and users_slice subsets carry it too so it stays live
        // between page loads. `null` = the probe could not answer — the client keeps its
        // last known value and never renders that as "nobody on duty". Caller-agnostic:
        // the answer is identical for every tier, so there is no per-viewer branch.
        anyStaffOnDuty,
        // memberCount is GONE — zero consumers anywhere in components/ contexts/ hooks/
        // services/ (every `memberCount` hit in the tree is a locally-derived admin-tab
        // count, Role.memberCount, or AllyRosterData.memberCount, which is the
        // FEDERATION roster and a different type — do not conflate). It was derived from
        // the roster array this function no longer ships, and org headcount is not a
        // customer's business.
        //
        // `features` STAYS for every caller: HelpView is Client-reachable and reads it,
        // and a client-side nav hide is cosmetic, never a boundary. Single-org: optional
        // modules are admin-configured via the 'orgFeatures' settings blob (see
        // system.getOrgFeatures). No member caps / pricing tiers / subscriptions.
        orgMeta: { features: features as Record<string, unknown> },
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
// rather than role-name-based so custom roles behave correctly — the
// `role === 'Admin'` disjunct this comment used to contradict is gone. Admin and
// Dispatcher hold request:dispatch/triage and Member holds request:accept, so the
// permissions alone take nothing away. Replicated at api/actions/intel.ts (dossier
// requests) — keep the two in lock-step.
function canSeeAllRequests(user?: { permissions?: string[] } | null): boolean {
    if (!user) return false;
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    return perms.includes('request:dispatch') || perms.includes('request:triage') || perms.includes('request:accept');
}

export async function getRequestsState(currentUser?: { id: number; role?: string; permissions?: string[] } | null) {
    let query = supabase.from('service_requests')
        .select(REQUEST_SELECT)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(200);
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
        .order('publish_date', { ascending: false }).order('id', { ascending: false }).limit(100);
    handleSupabaseError({ error, message: 'Failed to get announcements' });
    let announcements = (data || []).map(toAnnouncement);
    // Audience scoping server-side (mirrors + ENFORCES the HRNoticesTab client
    // filter): an Admin-only / staff-only notice body must not ship to a Client.
    // Managers (admin:config:notices holders — Admin and Dispatcher are both seeded
    // with it) see all for the management tab. NO ROLE-NAME BYPASS here; the
    // audience filter BELOW still keys on the role string on purpose — that is
    // stored DATA (announcements.audience holds the literal tier names), not a
    // privilege fact, and must not be "finished" by a later sweep.
    const canManage = Array.isArray(currentUser?.permissions) && currentUser!.permissions!.includes('admin:config:notices');
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

// Pre-auth twin of getAnnouncementsState. That helper scopes by the viewer's
// ROLE and — correctly — drops every row when there is no viewer, so calling it
// for the anonymous public page yielded a permanently empty Notices card.
// 'Login Screen' is the one audience that is public by definition ("Shown on the
// login screen for all visitors"), so this scopes to that audience IN THE QUERY
// rather than bypassing the filter — an anonymous caller can never reach a
// Client/Member/Admin-audience notice through this path.
export async function getLoginScreenAnnouncements() {
    const { data, error } = await supabase.from('announcements')
        .select('id, title, body, author, type, audience, publish_date, expiry_date')
        .contains('audience', ['Login Screen'])
        .order('publish_date', { ascending: false }).order('id', { ascending: false })
        .limit(50);
    handleSupabaseError({ error, message: 'Failed to get login screen announcements' });
    return { announcements: (data || []).map(toAnnouncement) };
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

/**
 * Resolve this deployment's public base URL, with the diagnostic detail (which
 * source won, which candidates were skipped) the boot check in server.ts reports.
 *
 * ENV WINS over the stored `settings.systemConfig.appUrl` — see lib/appUrl.ts for
 * why. Most callers want getOrgTenantUrl() below; this variant exists so the boot
 * log can name the source without re-deriving it.
 */
export async function resolveOrgAppUrl(): Promise<ResolvedAppUrl> {
    const { data: setting } = await supabase.from('settings').select('value').eq('key', 'systemConfig').maybeSingle();
    const stored = (setting?.value as { appUrl?: string } | null)?.appUrl;
    return resolveAppUrl(process.env.APP_URL, stored);
}

/** This deployment's public base URL — Discord deep links, scheduled-event location. */
export async function getOrgTenantUrl(): Promise<string> {
    return (await resolveOrgAppUrl()).url;
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
        .order('created_at', { ascending: false }).order('id', { ascending: false })
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
    // list, so admin:config:tools holders are exempt. NO ROLE-NAME BYPASS; as with
    // announcements, the audience filter below is stored DATA and stays.
    const canManageTools = Array.isArray(currentUser?.permissions) && currentUser!.permissions!.includes('admin:config:tools');
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

// Permission helper for the aggregate read path. The perm must be satisfied on the
// resolved user — directly, or through the shared implication table
// (lib/permissionImplications.ts), so boot answers the same question the dedicated
// subset does in api/query.ts. permissionSatisfied keeps the Array.isArray guard
// this helper used to carry inline. The `role === 'Admin'` bypass is gone: it made
// boot WIDER than SUBSET_REQUIRED_PERMISSION (which is permission-only), so a
// name-forged Admin tier received warrants/intel/HR through boot that the dedicated
// subset would have refused. This is now exactly the subset gate's model.
function aggHasPerm(currentUser: any, perm: string): boolean {
    if (!currentUser) return false;
    return permissionSatisfied(currentUser.permissions, perm);
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
    // intel:view:clearance satisfies intel:view through the shared implication
    // table — the second call this line used to make is now redundant.
    const wantIntel = aggHasPerm(currentUser, 'intel:view');
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
        getMainState(currentUser), getRequestsState(currentUser), getAnnouncementsState(currentUser),
        wantOps ? getOperationsState(currentUser) : empty,
        getExternalToolsState(currentUser), system.getAllSettings({ decryptSecrets: false }),
        wantWarrants ? getWarrantsState() : empty,
        wantHr ? hr.getHRState(currentUser) : empty,
        wantIntel ? getIntelState(currentUser) : empty,
    ]);
    // The settings half is PROJECTED, not spread raw. getAllSettings reduces every row
    // of the `settings` table into one blob with no filter, so the raw spread published
    // schema_version, setup_completed, allianceSelfProfile, allianceSyncConfig,
    // system_broadcast, orgFeatures — and any key an import inserted that this fork has
    // never heard of — to every authenticated caller, a Client included. The allow-list
    // lives in lib/settingsProjection.ts; wikiHomeConfig/hrConfig ride the same bare
    // permission as the subset they configure, so the config cannot outrun it.
    //
    // ONE EDIT COVERS TWO EGRESS PATHS: target=initial-state (the boot payload) and the
    // no-subset full state both come through here. api/query.ts's `main` case does the
    // same for the refresh path — the two must stay in step, or a browser sees
    // wikiHomeConfig at boot and loses it on the first settings_update (or the reverse).
    // Pinned by tests/dbGetStateProjection.test.ts and tests/settingsProjection.test.ts.
    return { ...main, ...reqs, ...anns, ...operations, ...warrants, ...tools, ...projectSettingsForViewer(settings, currentUser?.permissions), ...hrState, ...intelState };
}
