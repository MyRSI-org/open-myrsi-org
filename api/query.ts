
import { Request, Response } from 'express';
import * as db from '../lib/db.js';
import { verifyToken, isSessionForceLoggedOut, isSessionRevokedByWatermark, signRealtimeToken } from '../lib/auth.js';
import { stripSensitiveUserFields, stripSensitiveUserFieldsBulk, RequesterContext } from '../lib/db/userFilters.js';
import { filterByClearance } from '../lib/clearance.js';
import type { DiscordConfig, BanNotice } from '../types.js';
import { normalizeHexColor } from '../lib/color.js';
import { CLIENT_SAFE_DISCORD_KEYS } from '../lib/discordConfigKeys.js';
import { permissionSatisfied } from '../lib/permissionImplications.js';
import { mayReceiveRoster } from '../lib/rosterGate.js';
import { projectSettingsForViewer } from '../lib/settingsProjection.js';
import { parseFeedCursor } from '../lib/feedCursor.js';
import { keyHasScope } from '../lib/apiKeyScopes.js';
import { isApiKeySchemaOutdated } from '../lib/db/system.js';
import { CLIENT_DENIED_SUBSETS, CLIENT_DENIED_MESSAGE } from '../lib/clientNamespaces.js';
import { signDocMediaForClient } from '../lib/orgMediaDocs.js';
import { log as baseLog } from '../lib/log.js';
import { credentialFromRequest, SESSION_COOKIE_IS_SECURE, clearSessionCookie , appendSetCookie } from '../lib/sessionCookie.js';

const log = baseLog.child({ module: 'api.query' });

// Build a RequesterContext from a resolved currentUser for permission-aware
// field stripping. Returns null when there's no authenticated user.
function requesterFromUser(currentUser: any): RequesterContext | null {
    if (!currentUser) return null;
    return {
        id: currentUser.id,
        role: currentUser.role,
        // Role IDENTITY, stamped server-side by getUserById. currentUser is the
        // UNSTRIPPED session actor here (requesterFromUser runs before
        // stripSensitiveUserFields on every path), so the flag is still present.
        isSystemAdmin: currentUser.isSystemAdmin === true,
        permissions: currentUser.permissions || [],
    };
}

// A logged-out visitor's boot payload carries ONLY the Discord OAuth client id
// (needed to build the login link) — never the internal newRequest/intel/eam
// channel ids that stripSecrets otherwise keeps on discordConfig. Authenticated
// paths still receive the full config.
function bootDiscordConfig(discordConfig: unknown): { clientId: string | undefined } {
    const clientId = (discordConfig as { clientId?: string } | null | undefined)?.clientId;
    // Env var wins over the DB value.
    return { clientId: process.env.DISCORD_CLIENT_ID || clientId };
}

// A logged-out visitor's boot payload carries ONLY what the login /
// first-time-setup screens render — name + icon. The full brandingConfig
// (sound URLs, hero/login styling, ToS text) ships post-auth.
function bootBrandingConfig(brandingConfig: unknown): { name: string; iconUrl: string } {
    const b = (brandingConfig || {}) as { name?: unknown; iconUrl?: unknown };
    return {
        name: typeof b.name === 'string' ? b.name : 'Organization',
        iconUrl: typeof b.iconUrl === 'string' ? b.iconUrl : '/icon.svg',
    };
}

// Pre-auth platform settings are maintenance-screen fields only —
// force_logout_timestamp and any future operational keys stay post-auth.
function bootPlatformSettings(platformSettings: unknown): { maintenance_mode: boolean; maintenance_message: string | null } {
    const p = (platformSettings || {}) as { maintenance_mode?: unknown; maintenance_message?: unknown };
    return {
        maintenance_mode: p.maintenance_mode === true,
        maintenance_message: typeof p.maintenance_message === 'string' ? p.maintenance_message : null,
    };
}

// Theme colours are public-safe (Security rule 4) — but allowlist-rebuild (like the boot
// branding projection) so a future key added to the stored blob can never ride the unauth
// boot response, and re-validate the accent to canonical #rrggbb before it can reach a CSS sink.
export function pickPublicThemeConfig(t: unknown): { enabled: boolean; accent?: string } {
    const src = (t || {}) as { enabled?: unknown; accent?: unknown };
    const out: { enabled: boolean; accent?: string } = { enabled: src.enabled === true };
    const accent = normalizeHexColor(src.accent);
    if (accent) out.accent = accent;
    return out;
}

// --- READ-PATH AUTHORIZATION ---
// Map sensitive /api/query subsets to the same permission strings used by the
// api/services.ts dispatcher and the UI nav gates, so a low-privilege member
// can't read them. Subsets not listed here are readable by any authenticated
// org member.
//
// 'main' is intentionally NOT listed, and must stay unlisted: it is auth-only by
// design because a Client legitimately reads serviceTypes, orgMeta.features and a
// PROJECTION of the settings blob (brandingConfig incl. ToS, heroCardConfig,
// radioConfig, platformSettings) out of it, and 403-ing it would silently kill their
// request form. Both of its SENSITIVE halves are withheld inside the payload rather
// than by a 403: the roster, the rank/unit/role tables and the classification taxonomy
// INSIDE getMainState by lib/rosterGate.ts mayReceiveRoster (the one predicate every
// roster surface shares), and the wiki/HR config keys by projectSettingsForViewer
// (lib/settingsProjection.ts), which gates each on the same bare permission as the
// subset it configures. So the gate here is a PROJECTION, not a 403. Ratcheted by
// tests/rosterGate.test.ts, tests/mainBundleProjection.test.ts,
// tests/rosterEgressGates.test.ts and tests/settingsProjection.test.ts.
// EXPORTED for tests/readPathPermissionCoverage.test.ts — the read-path twin of
// tests/permissionMapCoverage.test.ts, which has guarded the WRITE path for several releases
// while this map had no CI guard at all because it was module-private. The test is
// bidirectional: no servable subset may be ungated, and no map entry may name a subset that no
// longer exists. This is a gate registry, not client data, and eslint.config.js already forbids
// client code from importing `**/api/query`.
export const SUBSET_REQUIRED_PERMISSION: Record<string, string> = {
    warrants: 'warrant:view',
    // Realtime slice subset — same gate as the 'warrants' list it patches.
    warrant_slice: 'warrant:view',
    // Discord role-sync maps (synced roles + rank/role mappings) are
    // admin-console configuration — only the settings tab consumes them.
    // (discordConfig channel ids still ride boot for other domains.)
    discord: 'admin:config:discord',
    intel: 'intel:view',
    // Realtime slice subsets — same gate as the 'intel' bundle they patch
    // (the intel:view ⇄ intel:view:clearance implication applies because
    // callerHasSubsetPermission keys on the required-permission STRING —
    // lib/permissionImplications.ts).
    intel_summary: 'intel:view',
    bulletin_slice: 'intel:view',
    hr: 'hr:view',
    // Realtime slice subsets — same gate as the 'hr' bundle they patch
    // (hr_update broadcasts + hr postgres_changes carry/route per-array).
    hr_applicants: 'hr:view',
    hr_interviews: 'hr:view',
    hr_jobs: 'hr:view',
    hr_templates: 'hr:view',
    hr_transfers: 'hr:view',
    hr_positions: 'hr:view',
    // Gate the remaining restricted subsets. Each maps to a permission the
    // seeded Member role holds (so members are unaffected) while blocking the
    // lower-privilege Client tier — and any role without the corresponding nav
    // permission — from reading the raw subset directly.
    wiki: 'wiki:view',
    // Realtime slice subset — same gate as the 'wiki' list it patches.
    wiki_page_slice: 'wiki:view',
    fleet: 'fleet:view',
    // Realtime slice subsets — same gate as the 'fleet' bundle they patch
    // (fleet_update broadcasts carry a {slices:[...]} array discriminator).
    fleet_catalog: 'fleet:view',
    fleet_user_ships: 'fleet:view',
    fleet_groups: 'fleet:view',
    government: 'gov:view',
    // Realtime slice subsets — same gate as the 'government' bundle they
    // patch (government_update broadcasts carry a {slices:[...]} key-group
    // discriminator so clients refetch only the affected keys).
    government_structure: 'gov:view',
    government_elections: 'gov:view',
    government_legislation: 'gov:view',
    government_motions: 'gov:view',
    operations: 'operations:view',
    // Realtime slice subsets — same gate as the 'operations' bundle they patch.
    // (users_slice is NOT ungated any more. getMainState withholds the roster from a
    // non-staff caller, so the old "they already receive the whole lite roster in main"
    // justification is gone. It is gated INLINE in its case below — a 403, matching
    // every other capability denial in this file and matching the user_detail gate,
    // because 200-with-empty would introduce a THIRD meaning into a wire shape that two
    // in-tree docstrings assert is unambiguous: lib/db/users.ts getUsersByIdsLite and
    // lib/sliceMerge.ts both say `{users: []}` can only mean "deleted", which is why the
    // endpoint throws on error rather than returning it.)
    operation_slice: 'operations:view',
    operation_templates: 'operations:view',
    warehouse: 'warehouse:view',
    warehouse_catalog: 'warehouse:view',
    warehouse_stock: 'warehouse:view',
    warehouse_requests: 'warehouse:view',
    marketplace: 'marketplace:view',
    marketplace_listings: 'marketplace:view',
    marketplace_contracts: 'marketplace:view',
    // Academy staff bundle. academy:instruct / academy:manage satisfy this through
    // the ladder in lib/permissionImplications.ts — an Instructor who can CREATE a
    // course must be able to load the bundle that contains it. (The self-service
    // 'academy_my' subset is intentionally NOT listed — self-scoped enrolments plus
    // the published catalogue, deliberately auth-only, like 'notifications'.)
    academy: 'academy:view',
};

// Optional-feature read gate: subsets whose module is toggled OFF return an EMPTY
// payload (HTTP 200), NOT 403 — a stale or deep-linked client degrades silently (no
// error toast) instead of throwing, and never receives data for a disabled feature.
// Mirrors the write-path OPTIONAL_FEATURE_NAMESPACES gate in api/services.ts (both
// resolve via db.isOptionalFeatureEnabled). finances and quartermaster have NO read
// subset — their reads are dispatched RPC actions gated by the write path — so they
// are intentionally absent here. Kept in sync with the write registry by
// tests/featureGateParity.test.ts.
export const SUBSET_REQUIRED_FEATURE: Record<string, string> = {
    academy: 'academy', academy_my: 'academy',
    marketplace: 'marketplace', marketplace_listings: 'marketplace', marketplace_contracts: 'marketplace',
    warehouse: 'warehouse', warehouse_catalog: 'warehouse', warehouse_stock: 'warehouse', warehouse_requests: 'warehouse',
    government: 'government', government_structure: 'government', government_elections: 'government',
    government_legislation: 'government', government_motions: 'government',
};

// Empty payload per gated subset, returned when the feature is OFF. Each mirrors the
// exact key shape its aggregator returns so the client's slice-setters CLEAR (not
// merely skip) any previously-loaded rows. Fresh objects per call — the payload is
// handed to stripSecrets and must never share mutable state across requests.
function emptyGovStructureState(): Record<string, unknown> {
    return {
        governmentsConfig: { enabled: false },
        governmentConfig: null,
        governmentBranches: [],
        governmentPositions: [],
        governmentPositionHolders: [],
    };
}
export function emptyFeatureState(subset: string): Record<string, unknown> {
    switch (subset) {
        case 'academy': return { academyCourses: [], academySessions: [] };
        case 'academy_my': return { academyCatalog: [], academyMyEnrollments: [] };
        case 'marketplace': return { marketplaceCategories: [], marketplaceListings: [], marketplaceContracts: [] };
        case 'marketplace_listings': return { marketplaceListings: [] };
        case 'marketplace_contracts': return { marketplaceContracts: [] };
        case 'warehouse': return { warehouseCatalog: [], warehouseStock: [], warehouseRequests: [] };
        case 'warehouse_catalog': return { warehouseCatalog: [] };
        case 'warehouse_stock': return { warehouseStock: [] };
        case 'warehouse_requests': return { warehouseRequests: [] };
        case 'government': return { ...emptyGovStructureState(), governmentElections: [], governmentLegislation: [], governmentMotions: [] };
        case 'government_structure': return emptyGovStructureState();
        case 'government_elections': return { governmentElections: [] };
        case 'government_legislation': return { governmentLegislation: [] };
        case 'government_motions': return { governmentMotions: [] };
        default: return {};
    }
}

// Mirror the BOLA permission check in api/services.ts: org-owner bypass, then the
// shared implication table (lib/permissionImplications.ts) — intel:view:clearance
// satisfies intel:view, and manage ⊇ instruct ⊇ view on the Academy ladder. Keyed on
// the required-permission STRING, so every *_slice subset that reuses its bundle's
// string inherits the same implication and list/slice gates cannot drift.
function callerHasSubsetPermission(currentUser: any, ctx: any, requiredPerm: string): boolean {
    if (!requiredPerm) return true;
    if (ctx?.ownerId && currentUser?.auth_user_id && ctx.ownerId === currentUser.auth_user_id) return true;
    return permissionSatisfied(currentUser?.permissions, requiredPerm);
}

// --- SECURITY: Strip secrets before sending state to the browser ---
// Customer API keys must never reach the client. The portal (org:get_settings)
// has its own authenticated endpoint that returns secrets for the management UI.
export function stripSecrets(state: any): any {
    if (!state) return state;
    const cleaned = { ...state };

    // Discord: only clientId and channel/role ids are needed by the frontend.
    // ALLOWLIST REBUILD from lib/discordConfigKeys.ts, which is also the write
    // allowlist in updateDiscordSettings. A new key added to that one list reaches
    // the client automatically — the hard-coded literal that used to live here is
    // what stranded defaultOperationAnnounceChannelId (saved, never read back).
    if (cleaned.discordConfig) {
        const src = cleaned.discordConfig as Record<string, unknown>;
        const rebuilt: Record<string, unknown> = {};
        for (const key of CLIENT_SAFE_DISCORD_KEYS) rebuilt[key] = src[key];
        cleaned.discordConfig = rebuilt;
    }

    // AI config: rebuild from an allowlist (NOT a denylist) so a future
    // secret-ish field added to AIConfig drops by default instead of riding the
    // authenticated state payload to every member.
    if (cleaned.aiConfig) {
        const a = cleaned.aiConfig as { enabled?: unknown; model?: unknown };
        cleaned.aiConfig = {
            enabled: !!a.enabled,
            ...(typeof a.model === 'string' ? { model: a.model } : {}),
        };
    }

    // Radio config: strip LiveKit API key and secret, expose configured flag
    if (cleaned.radioConfig) {
        const { apiKey, apiSecret, url, ...safeRadioConfig } = cleaned.radioConfig;
        cleaned.radioConfig = {
            ...safeRadioConfig,
            configured: !!(apiKey && apiSecret && url),
        };
    }

    // Remove raw geminiKey if present (from getAllSettings)
    delete cleaned.geminiKey;

    // Alliances: the singleton local pairing code is half of a handshake secret —
    // it rides the settings blob (getAllSettings reduces every settings row), so it
    // must NEVER reach the browser. The SELF-PROFILE is no longer deleted here: the
    // three settings-carrying payloads are rebuilt one layer earlier by
    // projectSettingsForViewer (lib/settingsProjection.ts), whose allow-list does not
    // name it, and the two pre-auth boot branches below hand-build their bodies and
    // never carried it. Its authorized reader is the alliance:view-gated
    // alliance:get_self_profile RPC (api/services.ts), which AllianceManagementTab
    // already uses — the same pattern as the intelSharingConfig delete below.
    delete cleaned.allianceLocalPairingCode;
    // Belt-and-suspenders: should a raw alliance_peers row ever ride the state,
    // scrub all key material, code, and handshake fields before it leaves.
    if (Array.isArray(cleaned.alliancePeers)) {
        cleaned.alliancePeers = cleaned.alliancePeers.map((p: Record<string, unknown>) => {
            const { outbound_key_enc, outboundKeyEnc, inbound_key_id, inboundKeyId,
                entered_peer_code_enc, enteredPeerCodeEnc, handshake_nonce, handshakeNonce,
                ...safe } = p;
            return safe;
        });
    }

    // The one-time org admin setup code lives in the settings table (key
    // 'admin_setup_code') and is overlaid into the settings blob by
    // getAllSettings. It must NEVER reach the client — any tenant member who
    // read it could claim the org Admin role.
    delete cleaned.admin_setup_code;

    // The active EAM body is audience-restricted (staff or user:receive:eam)
    // but rides the settings blob to EVERY authenticated member. Strip it at the
    // wire — authorized clients fetch it via the gated broadcast:get_active_eam
    // RPC (triggered by the id-only eam_broadcast realtime ping).
    delete cleaned.active_eam;

    // The org's OUTBOUND intel-federation clearance ceiling. Same overlay story as
    // active_eam: getAllSettings reduces EVERY settings row into this blob, so
    // maxShareableClearance rode `main` / `initial-state` to every authenticated
    // member — and updateIntelSharingConfig broadcasts a settings_update, so changing
    // the ceiling actively pushed the new value out. Data minimisation, not a secret:
    // it is one integer, already disclosed to a paired peer as _meta.maxShareableLevel,
    // and nothing in the bundle renders it. The scrubSecretKeys backstop below cannot
    // catch it — that predicate matches KEY NAMES (_api_key|_secret|…) and neither
    // `intelSharingConfig` nor `maxShareableClearance` matches. Unconditional delete
    // rather than a permission-gated slice: no client tier reads it from here — the
    // Admin console fetches it via admin:get_intel_sharing_config, gated by
    // admin:config:api.
    delete cleaned.intelSharingConfig;

    // Which one-shot role-grant backfills this install has passed
    // (lib/db/roleDefaults.ts ROLE_DEFAULT_BACKFILL_MARKER_KEY). Same overlay story as
    // intelSharingConfig: getAllSettings reduces EVERY settings row into this blob, so
    // the marker rode `main` / `initial-state` to every authenticated member. Repair
    // BOOKKEEPING, not org data — no client slice setter or component reads it, and
    // publishing which repair passes an install has run only tells a reader which
    // grants Repair would decline to re-apply. Unconditional delete: the marker is
    // written and read server-side by the backfill itself.
    delete cleaned.role_permission_backfills;

    // systemConfig (appUrl / welcomeMessage) rides the settings blob but no client slice
    // setter or component consumes it, and the browser has no business knowing this
    // deployment's configured origin. Server-internal callers (getOrgTenantUrl,
    // getOurOrigin, public page data) read it via their own paths, so drop it from every
    // browser-bound payload here rather than at the source.
    delete cleaned.systemConfig;

    // The org's last org-wide operational tasking, persisted forever by
    // broadcastSystemAlert (lib/db/system.ts upserts settings.system_broadcast).
    // Same overlay story as active_eam above: getAllSettings reduces EVERY settings row
    // into this blob, so a permanently-stale copy of the message body rode `main` /
    // `initial-state` to every authenticated member — a Client included. The
    // scrubSecretKeys backstop below cannot catch it: that predicate matches KEY NAMES
    // (_api_key|_secret|…) and neither `system_broadcast` nor `message` matches.
    // Unconditional rather than permission-gated because NOTHING reads this key — the
    // live delivery path is the auth-alerts broadcast, which contexts/SessionContext.tsx
    // consumes, and the settings postgres_changes backup was narrowed to active_eam
    // only. Unlike the EAM there is no gated re-fetch RPC to point authorized readers
    // at, because none is needed.
    delete cleaned.system_broadcast;

    // A DUPLICATE, not a secret. The module-enablement blob is the authoritative
    // `orgMeta.features` (built in lib/db.ts getMainState, read by Sidebar / HelpView /
    // FeaturesSettingsTab and deliberately kept for EVERY caller); this is the raw
    // settings row it is built from, riding the blob a second time under its storage
    // key. No client slice setter or component reads `orgFeatures` — a grep over
    // components/ contexts/ hooks/ services/ returns nothing. Deleting the duplicate
    // does NOT close module-state disclosure; orgMeta.features still carries it by
    // design (HelpView is Client-reachable and reads it).
    delete cleaned.orgFeatures;

    // BOTH deletes above are redundant on the three merged paths now that
    // projectSettingsForViewer allow-lists the settings blob one layer earlier — they
    // are the belt to the projection's braces, so a future FOURTH merge site that
    // forgets the projection still cannot ship these two. tests/stripSecrets.test.ts
    // ratchets the delete list so removing one is a decision, not an accident. Same
    // posture as the regex backstop's own comment below.

    // Public page config: public-intent by design, but explicitly allowlist here so that
    // adding future fields to PublicPageConfig (e.g. internal moderation flags) will
    // silently drop rather than leak through the authenticated state endpoint.
    if (cleaned.publicPageConfig) {
        const p = cleaned.publicPageConfig;
        cleaned.publicPageConfig = {
            enabled: !!p.enabled,
            motto: typeof p.motto === 'string' ? p.motto : '',
            blurb: typeof p.blurb === 'string' ? p.blurb : '',
            heroImageUrl: typeof p.heroImageUrl === 'string' ? p.heroImageUrl : '',
            profileImageUrl: typeof p.profileImageUrl === 'string' ? p.profileImageUrl : '',
            modules: {
                stats: !!p.modules?.stats,
                testimonials: !!p.modules?.testimonials,
                services: !!p.modules?.services,
                links: !!p.modules?.links,
            },
            links: Array.isArray(p.links) ? p.links : [],
            featuredTestimonialIds: Array.isArray(p.featuredTestimonialIds) ? p.featuredTestimonialIds : [],
        };
    }

    // Platform settings are one admin-editable blob with an open key shape, and the
    // top-level secret-name check below doesn't look inside nested objects. So rebuild
    // it from a known list of fields here (like the config objects above): any new
    // secret-ish field added under platformSettings drops by default instead of
    // reaching every member. Fields are copied only when present, so the login-screen
    // projection (maintenance flag + message) is unchanged.
    if (cleaned.platformSettings && typeof cleaned.platformSettings === 'object') {
        const p = cleaned.platformSettings as Record<string, unknown>;
        const safe: Record<string, unknown> = {};
        if ('maintenance_mode' in p) safe.maintenance_mode = p.maintenance_mode === true;
        if ('maintenance_message' in p) safe.maintenance_message = typeof p.maintenance_message === 'string' ? p.maintenance_message : null;
        if (typeof p.support_discord_url === 'string') safe.support_discord_url = p.support_discord_url;
        if (typeof p.force_logout_timestamp === 'string') safe.force_logout_timestamp = p.force_logout_timestamp;
        cleaned.platformSettings = safe;
    }

    // Safety net: the settings blob contains every settings row, so a secret
    // added in the future (named like *_secret, *_api_key, *_password, *_webhook,
    // or *_token) could reach the browser unless we catch it here. Walk the WHOLE
    // object — not just the top level — and drop any string/number value whose key
    // looks like a secret, at any depth. Objects/arrays are recursed into and never
    // deleted, so the config objects and lists built above are left untouched.
    const SECRET_KEY = /(_api_key|_secret|_password|_webhook|_token)/i;
    const scrubSecretKeys = (node: unknown): void => {
        if (Array.isArray(node)) { for (const item of node) scrubSecretKeys(item); return; }
        if (!node || typeof node !== 'object') return;
        const rec = node as Record<string, unknown>;
        for (const key of Object.keys(rec)) {
            const val = rec[key];
            if ((typeof val === 'string' || typeof val === 'number') && SECRET_KEY.test(key)) {
                delete rec[key];
            } else if (val && typeof val === 'object') {
                scrubSecretKeys(val);
            }
        }
    };
    scrubSecretKeys(cleaned);

    return cleaned;
}

// --- SUB-HANDLERS ---

async function handleConfig(req: Request, res: Response) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
        return res.status(500).json({ message: 'Server configuration error.' });
    }
    return res.status(200).json({ supabaseUrl, supabaseAnonKey });
}

/**
 * PWA manifest — public branding only, deliberately edge-cacheable.
 *
 * EXPORTED and called DIRECTLY by the GET /api/manifest route. That route used to
 * pin its target by rewriting the URL (`req.url += '&target=manifest'`) and then
 * calling the generic query handler, which is forgeable: a trailing `#` makes
 * Express/parseurl treat the appended text as a fragment and DISCARD it, so
 * `/api/manifest?target=state&subset=hr#` reached handleState — and config /
 * initial-state / feed the same way. Each of those still fully authenticates, so no
 * new data was readable, but the response then rode a route that sets
 * `Access-Control-Allow-Origin: *`, skips noStore(), and is the one route marked
 * edge-cacheable. Calling the sub-handler directly makes the target STRUCTURALLY
 * unforgeable rather than dependent on two URL parsers agreeing — do not
 * reintroduce the rewrite.
 *
 * `req` is unused here but stays in the signature: the `target=manifest` switch arm
 * still calls it as (req, res).
 */
export async function handleManifest(req: Request, res: Response) {
    // Helper to guess mime type
    const getMimeType = (url: string) => {
        if (!url) return 'image/png';
        if (url.startsWith('data:')) {
            const match = url.match(/data:([^;]+);/);
            return match ? match[1] : 'image/png';
        }
        const lower = url.toLowerCase();
        if (lower.endsWith('.svg')) return 'image/svg+xml';
        if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
        if (lower.endsWith('.webp')) return 'image/webp';
        if (lower.endsWith('.ico')) return 'image/x-icon';
        return 'image/png';
    };

    // Build a valid manifest from provided or default values
    const buildManifest = (branding: any = {}, meta: any = {}) => {
        const name = branding.name || "Operations Terminal";
        const shortName = name.length > 12 ? name.substring(0, 12) : name;
        const iconUrl = meta.pwaIconUrl || branding.iconUrl || '/icon.svg';
        const themeColor = meta.themeColor || "#0f172a";
        const iconType = getMimeType(iconUrl);
        const isSvg = iconType === 'image/svg+xml';

        // SVG icons must use sizes "any"; raster icons use fixed pixel sizes.
        // When using an external raster URL, always include a local SVG fallback
        // so the browser can validate at least one icon for PWA installability
        // (external icons may fail validation due to CORS or availability).
        const isExternal = !iconUrl.startsWith('/');
        const icons = isSvg
            ? [
                { src: iconUrl, sizes: "any", type: iconType, purpose: "any" },
                { src: iconUrl, sizes: "any", type: iconType, purpose: "maskable" }
            ]
            : [
                { src: iconUrl, sizes: "192x192", type: iconType, purpose: "any" },
                { src: iconUrl, sizes: "512x512", type: iconType, purpose: "any" },
                { src: iconUrl, sizes: "512x512", type: iconType, purpose: "maskable" },
                ...(isExternal ? [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }] : [])
            ];

        return {
            id: "/",
            name,
            short_name: shortName,
            description: meta.description || "Secure Operations Dashboard",
            start_url: "/?source=pwa",
            display: "standalone",
            background_color: themeColor,
            theme_color: themeColor,
            orientation: "portrait",
            scope: "/",
            categories: ["productivity", "business", "utilities"],
            icons,
            screenshots: [],
            shortcuts: [
                { name: "Dashboard", url: "/", icons: [{ src: iconUrl, sizes: isSvg ? "any" : "192x192", type: iconType }] },
                { name: "Service Requests", url: "/requests", icons: [{ src: iconUrl, sizes: isSvg ? "any" : "192x192", type: iconType }] }
            ]
        };
    };

    // Always set headers first — even if we fail, the response type is correct
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    // No Access-Control-Allow-Origin: single-org has exactly one origin. The manifest
    // is linked same-origin (index.html / api/index.ts) and CSP manifest-src 'self'
    // already forbids a cross-origin one, so the grant had no consumer.

    try {
        let branding = {};
        let meta = {};

        try {
            // Single-org: branding/OG come straight from the settings table.
            const { data, error } = await db.supabase
                .from('settings')
                .select('key, value')
                .in('key', ['brandingConfig', 'openGraphConfig']);
            if (error) {
                log.warn('manifest settings query failed', { message: error.message });
            }
            const settings = (data || []).reduce((acc: any, curr: any) => {
                acc[curr.key] = curr.value;
                return acc;
            }, {});
            branding = settings.brandingConfig || {};
            meta = settings.openGraphConfig || {};
        } catch (settingsErr) {
            log.warn('manifest settings fetch failed', { err: settingsErr });
        }

        return res.status(200).json(buildManifest(branding, meta));
    } catch (e) {
        // Absolute fallback — return a valid default manifest no matter what
        log.error('manifest critical failure, returning default manifest', { err: e });
        return res.status(200).json(buildManifest());
    }
}

async function handleInitialState(req: Request, res: Response) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    // Admin-ness is resolved server-side from the session JWT — by role IDENTITY
    // (users.role_id vs the system Admin role, lib/db/adminIdentity.ts), never by
    // the role's NAME — and enforced by the per-action permission gate in
    // services.ts. Never derived from anything sent to the client.
    const clientConfig = { supabaseUrl, supabaseAnonKey };

    // First-run gating flag for the onboarding wizard (cheap settings read; false on db error).
    let setupCompleted = false;
    try { setupCompleted = await db.isSetupCompleted(); } catch { /* default false (e.g. db down) */ }

    // Wrapped in try/catch to handle DB connection errors (fresh install / wrong env vars).
    let adminCount = 0;
    try {
        // Single-org: does any Admin user exist at all? Find the Admin system role
        // by is_system flag (highest id = Admin per role-order convention), then
        // count non-deleted, non-pending users holding it.
        const { data: globalAdminRole } = await db.supabase.from('roles')
            .select('id').eq('is_system', true).order('id', { ascending: false }).limit(1).maybeSingle();
        if (globalAdminRole) {
            const { count } = await db.supabase.from('users').select('id', { count: 'exact', head: true })
                .eq('role_id', globalAdminRole.id)
                .is('deleted_at', null)
                .not('discord_id', 'ilike', 'pending_%');
            adminCount = count ?? 0;
        }
    } catch (e) {
        log.warn('admin check exception (likely db connection)', { err: e });
        adminCount = 0;
    }

    if (adminCount === 0) {
        let settings;
        try {
            settings = await db.getAllSettings({ decryptSecrets: false });
        } catch (e) {
            // Fallback for settings if DB is down
            log.warn('failed to fetch settings, using defaults', { err: e });
            settings = {
                brandingConfig: { name: 'Organization', iconUrl: '/icon.svg' },
                discordConfig: {}
            };
        }

        return res.status(200).json(stripSecrets({
            config: clientConfig,
            needsSetup: true,
            setupCompleted,
            discordConfig: bootDiscordConfig(settings.discordConfig),
            brandingConfig: bootBrandingConfig(settings.brandingConfig),
            themeConfig: pickPublicThemeConfig(settings.themeConfig),
        }));
    }

    // Try to restore session from token
    // DUAL-ACCEPT: cookie preferred, Authorization header still honoured for sessions issued before the cookie existed.
    const token = credentialFromRequest(req.headers['authorization'], req.headers['cookie'], SESSION_COOKIE_IS_SECURE);
    let currentUser = null;
    let bootBanNotice: BanNotice | null = null;

    if (token) {
        const decoded = verifyToken(token);
        if (decoded) {
            // The force-logout gate in the main router is skipped for
            // target=initial-state so the app can still boot a maintenance/logout
            // screen — but a revoked-but-unexpired session must NOT silently
            // re-boot into full getState content and mint a fresh realtime token.
            // Fail closed BEFORE loading the user / getState / signing a token.
            let sessionRevoked = false;
            try {
                const platformSettings = await db.getPlatformSettings();
                if (platformSettings?.force_logout_timestamp &&
                    isSessionForceLoggedOut(decoded, platformSettings.force_logout_timestamp)) {
                    appendSetCookie(res, clearSessionCookie(SESSION_COOKIE_IS_SECURE)); return res.status(401).json({ message: 'Session expired. Please log in again.', force_logout: true });
                }
            } catch (e) {
                // Fail closed: if we cannot confirm the session is still valid, do
                // not boot into authenticated state — drop to the logged-out branch.
                log.warn('failed to check force-logout on initial-state', { err: e });
                sessionRevoked = true;
            }
            if (!sessionRevoked) {
                try {
                    currentUser = await db.getUserById(decoded.userId);
                } catch (e) {
                    log.error('failed to fetch current user', { err: e });
                }
                // If this user's sessions were revoked (an admin revoke, delete, or
                // ban), a token from before that must not boot back into the app or
                // receive a new realtime token. Drop the user so the login screen
                // shows instead. This is the same check the write path runs.
                if (currentUser && isSessionRevokedByWatermark(decoded, currentUser.tokensValidFrom)) {
                    currentUser = null;
                }
            }
        }
    }

    // ───────────────────────── ORG BAN GATE (boot) ─────────────────────────
    // Deliberately BELOW the watermark drop above, which is the opposite order to
    // the dispatcher's. There, the watermark has to run first or the appeal flow
    // dies; here a pre-watermark token is genuinely stale and the correct answer is
    // the login screen — which is also how a banned member GETS their appeal
    // session (api/actions/auth.ts mints one on the banned login path).
    //
    // Nulling currentUser is what actually withholds the payload: it drops this
    // request into the logged-out branch below, so db.getState() never runs and
    // signRealtimeToken is never reached. The notice then rides that same branch.
    // It is the anonymous-SHAPED body, but this line is only reachable with a
    // VERIFIED token whose user we just loaded, so the field is self-scoped by
    // construction — an actually-anonymous visitor never gets here.
    //
    // Fails closed, and closed here means "no org data", NOT "banned": a read fault
    // drops the user WITHOUT a notice, so the login screen shows rather than an
    // accusation. Telling an innocent member they are banned because a query failed
    // is its own kind of incident.
    if (currentUser) {
        // Held separately: the assignment inside the try narrows currentUser to null
        // for the catch, and the log line still needs to say WHOSE check failed.
        const banSubjectId = currentUser.id;
        try {
            const notice = await db.getBanNotice(currentUser.id, currentUser.discordId);
            if (notice) { bootBanNotice = notice; currentUser = null; }
        } catch (e) {
            log.warn('ban check failed on initial-state; booting logged-out', { userId: banSubjectId, err: e });
            currentUser = null;
        }
    }

    // A logged-out visitor gets only the public boot data needed to render the
    // login screen (branding + Discord clientId), never full org state.
    if (!currentUser) {
        let bootSettings;
        try {
            bootSettings = await db.getAllSettings({ decryptSecrets: false });
        } catch (e) {
            log.warn('failed to fetch boot settings, using defaults', { err: e });
            bootSettings = { brandingConfig: { name: 'Organization', iconUrl: '/icon.svg' }, discordConfig: {} };
        }
        const platformSettings = await db.getPlatformSettings();
        return res.status(200).json(stripSecrets({
            config: clientConfig,
            setupCompleted,
            brandingConfig: bootBrandingConfig(bootSettings.brandingConfig),
            discordConfig: bootDiscordConfig(bootSettings.discordConfig),
            themeConfig: pickPublicThemeConfig(bootSettings.themeConfig),
            platformSettings: bootPlatformSettings(platformSettings),
            // Present ONLY for a verified session the gate above just banned.
            // stripSecrets is a rebuild-specific-keys walk that leaves unknown keys
            // alone, so this survives it unchanged.
            ...(bootBanNotice ? { banNotice: bootBanNotice } : {}),
        }));
    }

    try {
        const state = await db.getState(currentUser);
        const platformSettings = await db.getPlatformSettings();

        // Permission-aware strip on the bulk roster — same treatment as the
        // 'main' subset path. currentUser is intentionally returned UNSTRIPPED
        // (separate field on the response) so personal tabs see their own
        // adminNotes/personnelNotes/conduct/markers as today.
        if (state && Array.isArray((state as any).users)) {
            (state as any).users = stripSensitiveUserFieldsBulk((state as any).users, requesterFromUser(currentUser));
        }

        // Wiki home content may reference private-bucket images by key. Sign them for a
        // wiki:view holder so they render on first load, matching the 'main' subset path.
        // Redundant BY CONSTRUCTION for the same reason as its 'main' twin: getState()
        // already ran the settings blob through projectSettingsForViewer, so
        // state.wikiHomeConfig is absent for a caller without wiki:view by the time this
        // reads it. Kept as defence in depth — and kept ANNOTATED so a later reader who
        // deletes one copy does not leave the other looking unexplained.
        const wikiHome = (state as { wikiHomeConfig?: { welcomeContent?: unknown } }).wikiHomeConfig;
        if (wikiHome?.welcomeContent && callerHasSubsetPermission(currentUser, null, 'wiki:view')) {
            // longLived: this rides the BOOT BUNDLE, which nothing on the client re-mints on a
            // timer — a tab left visible here never triggers a `main` refetch, so the short
            // read TTL would show broken images. The lifetime differs; the gate above does not.
            wikiHome.welcomeContent = await signDocMediaForClient(wikiHome.welcomeContent, { longLived: true });
        }

        // The self record carried as `currentUser` keeps the viewer's own
        // personnel notes / conduct / markers (personal tabs) but must not echo
        // admin-only adminNotes back to a non-admin self. Strip with the user as
        // their own requester (mirrors the login return).
        const safeCurrentUser = stripSensitiveUserFields(currentUser as any, requesterFromUser(currentUser));

        return res.status(200).json(stripSecrets({
            config: clientConfig,
            needsSetup: false,
            setupCompleted,
            currentUser: safeCurrentUser, // logged-in user (self-stripped)
            // Per-user JWT authorizing subscriptions to the PRIVATE realtime
            // broadcast channels (Supabase Realtime Authorization). null when
            // SUPABASE_JWT_SECRET is unset — realtime then stays off
            // (fail-closed), the app degrades to manual/resync refreshes.
            realtimeToken: signRealtimeToken(currentUser.id),
            ...state,
            platformSettings,
            // clientId after the spread so the env var wins over the DB value.
            discordConfig: { ...state.discordConfig, clientId: process.env.DISCORD_CLIENT_ID || state.discordConfig?.clientId },
        }));
    } catch (e: any) {
        log.error('failed to fetch full state', { err: e });
        // Return minimal state to prevent a frontend crash. Even on the error
        // fallback the self record must be stripped of admin-only fields.
        return res.status(200).json({
            config: clientConfig,
            needsSetup: false,
            setupCompleted,
            currentUser: stripSensitiveUserFields(currentUser as any, requesterFromUser(currentUser)),
            error: "Database Connection Error"
        });
    }
}

async function handleState(req: Request, res: Response) {
    // NORMALISE ONCE. `req.query.subset` is `string | string[] | ParsedQs | ParsedQs[]`.
    // The two pre-existing gates below index a Record with a COERCING bracket lookup, so
    // `?subset[]=academy_my` reaches them as 'academy_my' and still matches. An
    // `Array.includes` membership test — which is what the new fail-closed client-denial
    // gate is — does NOT coerce, so writing it against the raw value would put the one
    // new fail-closed gate on this path in the only shape that fails OPEN, with its
    // correctness resting on a `default:` branch four hundred lines away. Any non-string
    // form collapses to a sentinel that matches no gate and no `case`, so it falls
    // through to the switch's `default:` 400 exactly as today — the array form is
    // REJECTED, not silently served.
    const rawSubset = req.query.subset;
    const subset: string | undefined =
        rawSubset === undefined ? undefined
            : typeof rawSubset === 'string' ? rawSubset
                : '__non_string_subset__';
    try {
        // Resolve User for Authenticated Subsets (like operations)
        // DUAL-ACCEPT: cookie preferred, Authorization header still honoured for sessions issued before the cookie existed.
        const token = credentialFromRequest(req.headers['authorization'], req.headers['cookie'], SESSION_COOKIE_IS_SECURE);
        let currentUser = null;

        if (token) {
            const decoded = verifyToken(token);
            if (decoded) {
                try {
                    currentUser = await db.getUserById(decoded.userId);
                } catch (e) {
                    log.warn('failed to resolve user for subset fetch', { err: e });
                }
                // If this user's sessions were revoked, stop them reading data here
                // too — otherwise the revoke wouldn't take effect until the token
                // expired on its own. Same check the write path runs.
                if (currentUser && isSessionRevokedByWatermark(decoded, currentUser.tokensValidFrom)) {
                    appendSetCookie(res, clearSessionCookie(SESSION_COOKIE_IS_SECURE)); return res.status(401).json({ message: 'Session expired. Please log in again.', force_logout: true });
                }
            }
        }

        // Single-org: state subsets run under the service-role key. Require an
        // authenticated user for ALL subsets (no cross-org check — one org only).
        if (!currentUser) {
            return res.status(403).json({ message: 'Forbidden: Authentication required.' });
        }

        // ───────────────────────── ORG BAN GATE ─────────────────────────
        // FIRST gate on the read path, mirroring api/services.ts — see the long note
        // there for why the write half sits where it does.
        //
        // Refuses EVERY subset, including the realtime slices: a banned member needs
        // nothing from handleState, and refusing here is what stops an already-open
        // tab from continuing to receive org content until its token expires. There
        // is no exemption list on this surface, because the two actions a banned
        // member is still entitled to are both MUTATIONS on the dispatcher; the ban
        // notice itself reaches the client through target=initial-state, which is a
        // different handler with its own gate.
        //
        // Fails closed, but never INTO a ban screen: a read fault is a retryable 503,
        // not an accusation.
        try {
            const activeBan = await db.findActiveBan({ userId: currentUser.id, discordId: currentUser.discordId });
            if (activeBan) {
                log.warn('org ban denied a read', { userId: currentUser.id, subset, banId: activeBan.id });
                return res.status(403).json({ code: 'ORG_BANNED', message: 'Your access to this organization has been suspended.' });
            }
        } catch (e) {
            // Not a bare catch, for the same reason as the dispatcher's: an unexpected
            // throw in the gate ITSELF would otherwise be a permanent, silent 503 for
            // every user on every read. Checked by NAME, not instanceof — the class
            // crosses a barrel re-export.
            if ((e as Error)?.name !== 'BanCheckUnavailable') {
                log.error('ban gate failed unexpectedly on the read path', { userId: currentUser.id, subset, err: e });
            }
            return res.status(503).json({ code: 'BAN_CHECK_UNAVAILABLE', message: 'Unable to verify account status. Please try again.' });
        }

        // CLIENT-TIER SUBSET DENIAL — the READ half of the dispatcher's
        // CLIENT_DENIED_NAMESPACES gate, off the same registry (lib/clientNamespaces.ts)
        // so the two cannot drift.
        //
        // SECOND, below the ORG BAN GATE above and ABOVE BOTH gates below — and
        // api/services.ts puts its half in exactly the same position, so the two
        // surfaces still carry ONE ordering invariant rather than two. (It was FIRST
        // until org bans landed; a ban is a harder boundary than a tier, and unlike a
        // tier it must also survive the member's row being deleted.)
        //   · Above the PERMISSION gate because 'academy_my' has no entry there and must
        //     never get one: academy:view is the STAFF read in this build and the member
        //     surface is deliberately permission-less (lib/roleDefaultPermissions.ts;
        //     tests/seederRoleDefaults.test.ts pins the absence).
        //   · Above the FEATURE gate because that one answers 200-with-an-empty-body, and
        //     a customer who is denied this data should be told so once, in one shape,
        //     rather than handed a silent empty Academy whenever the module happens to be
        //     off. NOT a module-state non-disclosure control: orgMeta.features and the raw
        //     'orgFeatures' settings key already ship every module's enable state to every
        //     caller on the `main` bundle. Phase 3 item 8 owns that; do not re-justify
        //     this ordering as secrecy.
        //
        // includes() on the ARRAY, never a bracket lookup into
        // CLIENT_DENIED_SUBSET_NAMESPACE, which is prototype-reachable. `subset` is the
        // normalised string above, so the array form cannot slip past this by type.
        if (subset !== undefined && CLIENT_DENIED_SUBSETS.includes(subset) && await db.isClientCaller(currentUser)) {
            log.warn('client subset denied', { userId: currentUser.id, subset });
            return res.status(403).json({ message: CLIENT_DENIED_MESSAGE });
        }

        // Per-subset permission gate for sensitive resources (warrants / intel / hr).
        // Org membership alone is not sufficient — a Client-tier member must not be
        // able to read the warrant/KOS list, intel reports, or HR records.
        const requiredPerm = SUBSET_REQUIRED_PERMISSION[subset as string];
        if (requiredPerm && !callerHasSubsetPermission(currentUser, null, requiredPerm)) {
            log.warn('subset permission denied', { userId: currentUser.id, subset, requiredPerm });
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        // Optional-feature read gate (mirrors the dispatcher's OPTIONAL_FEATURE_NAMESPACES):
        // if the subset's module is toggled OFF, return its EMPTY shape at 200 — never
        // 403 (avoids an error toast for the member-facing marketplace/government/
        // academy_my subsets) and never real data for a disabled feature. Runs AFTER the
        // permission gate so a caller lacking the module's *:view perm still 403s first.
        // Wrapped in stripSecrets like the shared return below.
        const requiredFeature = SUBSET_REQUIRED_FEATURE[subset as string];
        if (requiredFeature && !(await db.isOptionalFeatureEnabled(requiredFeature))) {
            log.warn('subset feature-disabled', { userId: currentUser.id, subset, requiredFeature });
            return res.status(200).json(stripSecrets(emptyFeatureState(subset as string)));
        }

        let state;
        switch (subset) {
            case 'main': {
                // Fetch the settings blob alongside main so a 'main' refresh
                // carries the config keys this viewer is entitled to (radioConfig,
                // discordConfig, brandingConfig, platformSettings, …). The realtime
                // layer re-pulls 'main' on reconnect and on settings_update;
                // getMainState alone omits these. The blob is PROJECTED before it
                // merges — see the projectSettingsForViewer call below.
                const [mainState, settings] = await Promise.all([
                    db.getMainState(currentUser),
                    db.getAllSettings({ decryptSecrets: false }),
                ]);
                // Bulk roster: every member fetches every other member's record,
                // so non-privileged callers must not see others' adminNotes /
                // personnelNotes / conductRecord / limitingMarkers.
                if (mainState && Array.isArray(mainState.users)) {
                    mainState.users = stripSensitiveUserFieldsBulk(mainState.users as any, requesterFromUser(currentUser)) as any;
                }
                // The settings blob is EVERY settings row reduced by key (getAllSettings),
                // so rebuild it as this viewer's projection BEFORE the signing block and
                // the merge — an unlisted key (a future setting, an imported one this fork
                // has never heard of) drops by default instead of riding `main` to an
                // external customer. lib/db.ts's getState does the same for
                // initial-state / the no-subset full state; the two must stay in step.
                const viewerSettings = projectSettingsForViewer(settings, currentUser?.permissions);
                // Wiki home content may reference private-bucket images by key. Sign them only
                // for a caller who can view the wiki, so a member without wiki:view never gets
                // readable URLs even though the config rides this shared subset. The projection
                // above has already removed wikiHomeConfig outright for such a caller, so this
                // check is redundant BY CONSTRUCTION — kept as defence in depth because if the
                // projection were ever removed the signing would become ungated AND the key
                // would return, and because drift between the two can only ever narrow the
                // payload (fail-broken and immediately visible: images stop rendering), never
                // widen it. Do not "fix" the redundancy by widening either side.
                const wikiHome = (viewerSettings as { wikiHomeConfig?: { welcomeContent?: unknown } }).wikiHomeConfig;
                if (wikiHome?.welcomeContent && callerHasSubsetPermission(currentUser, null, 'wiki:view')) {
                    // longLived — same reason as the initial-state twin above: `main` is not
                    // re-minted on a timer, so this content outlives the short read TTL.
                    wikiHome.welcomeContent = await signDocMediaForClient(wikiHome.welcomeContent, { longLived: true });
                }
                state = { ...mainState, ...viewerSettings };
                // OPERATOR ALARM, admin-only. When the running code needs api_keys columns the
                // database does not have, API-key authentication is refused — which from the
                // outside looks like "our ally is down", with nothing in the app to say
                // otherwise. Surfacing it here means the operator sees it on their next page
                // load instead of having to think to click Run Diagnostics.
                //
                // Gated on admin:db:destroy, the same high bar as Database Tools — this names
                // internal schema detail and must never reach a member. It is a cached boolean
                // set by verifyApiKey's own error path, so it costs no query.
                if (isApiKeySchemaOutdated() && callerHasSubsetPermission(currentUser, null, 'admin:db:destroy')) {
                    (state as Record<string, unknown>).schemaUpdateRequired = true;
                }
                break;
            }
            // Request visibility is scoped per-caller inside
            // getRequestsState/getRequestDetail — duty-permission holders see
            // the full log, everyone else only their own requests.
            case 'requests': state = await db.getRequestsState(currentUser); break;
            // Realtime slice path: user_update broadcasts carry the affected
            // user id(s); the client refetches ONLY those roster rows instead of
            // the whole 'main' bundle. The shared stripSensitiveUserFieldsBulk below
            // still runs (this case isn't early-return), but "same exposure as 'main'"
            // is no longer true: 'main' now withholds the roster from a non-staff
            // caller, so this case carries the SAME entitlement gate, evaluated with the
            // SAME predicate, so the bundle gate and the slice gate cannot drift.
            case 'users_slice': {
                const rawIds = req.query.ids;
                // Express yields string for ?ids=1,2 but string[] for
                // ?ids=1&ids=2 — normalize both before validating.
                const tokens = (Array.isArray(rawIds)
                    ? rawIds.flatMap((s) => String(s).split(','))
                    : typeof rawIds === 'string' ? rawIds.split(',') : []
                ).map((t) => t.trim());
                if (tokens.length === 0) return res.status(400).json({ message: 'Missing ids parameter' });
                // Strict positive-int parse (mirrors user_detail): reject the
                // whole request on ANY malformed token rather than silently
                // dropping it — a partial match would mask client bugs.
                if (tokens.some((t) => !/^\d+$/.test(t))) {
                    return res.status(400).json({ message: 'Invalid ids parameter' });
                }
                const ids = [...new Set(tokens.map((t) => parseInt(t, 10)))];
                // Matches BULK_ACTION_MAX — bulk broadcasts never carry more.
                if (ids.length > 100) return res.status(400).json({ message: 'Too many ids (max 100)' });
                // CLIENT-TIER READ BOUNDARY. Same predicate as getMainState, so the
                // bundle gate and the slice gate cannot drift. Placed AFTER the id
                // validation above on purpose: a capability gate must never mask a
                // client bug (pinned by the malformed-ids test).
                //
                // 403, not 200-with-empty. An empty/denied response evicts exactly the
                // REQUESTED ids, not the whole array (lib/sliceMerge.ts preserves rows
                // outside `requested`). A viewer demoted staff -> non-staff mid-session
                // CAN reach this branch with a POPULATED prev, for the ids named in one
                // broadcast, until the channel rebuilds — bounded and acceptable, but
                // NOT impossible, and 200-with-empty would introduce a third meaning
                // into a wire shape lib/db/users.ts and lib/sliceMerge.ts both document
                // as unambiguous. The cost of the 403 is one caught error: the
                // coalescer's fallback is a NON-force full 'main' refetch, which the 2 s
                // dedupe collapses, and with the client-side attachment gating in
                // contexts/DataCoreContext.tsx a non-staff caller never issues this
                // request at all.
                //
                // No self carve-out. A non-staff viewer's own record reaches them
                // through user_detail (the identity path), and adding a self branch here
                // would couple this gate to the availability discriminator for no gain.
                if (!mayReceiveRoster(currentUser)) {
                    log.warn('users_slice denied', { userId: currentUser.id, requested: ids.length });
                    return res.status(403).json({ message: 'Insufficient permissions' });
                }
                // The availability scalar rides EVERY response a user_update or a
                // duty_update can trigger — main, initial-state, users_presence and
                // here — because role changes and soft-deletes change the answer and
                // emit `user_update`, which the client dispatches to users_slice (or,
                // id-less, to main) and NEVER to users_presence
                // (contexts/DataCoreContext.tsx user_update handler). Emitters:
                // lib/db/users.ts bulkDemoteUsersToClient / bulkPromoteUsersToMember.
                const [sliceUsers, anyStaffOnDuty] = await Promise.all([
                    db.getUsersByIdsLite(ids),
                    db.isAnyStaffOnDuty(),
                ]);
                state = { users: sliceUsers, anyStaffOnDuty };
                break;
            }
            // Realtime slice path: operation_update broadcasts carry the
            // operationId; the client refetches ONLY that list row. null means
            // "absent or not visible to this caller" — the client removes the
            // row. Visibility re-applies the shared list predicate inside
            // getOperationByIdLite (owner / clearance / markers / manage).
            case 'operation_slice': {
                const { id: opId } = req.query;
                if (!opId || typeof opId !== 'string') return res.status(400).json({ message: 'Missing id parameter' });
                state = { operation: await db.getOperationByIdLite(opId, currentUser) };
                break;
            }
            // Realtime slice path: operation_templates_changed broadcasts no
            // longer refetch the whole ops list just to pick up a template
            // change — templates are a tiny standalone slice.
            case 'operation_templates': {
                state = { operationTemplates: await db.listOperationTemplates(currentUser) };
                break;
            }
            case 'user_detail': {
                const { id: userId } = req.query;
                if (!userId) return res.status(400).json({ message: "Missing id parameter" });
                const parsedUserId = parseInt(userId as string, 10);
                if (!Number.isFinite(parsedUserId)) return res.status(400).json({ message: "Invalid id parameter" });
                // CLIENT-TIER READ BOUNDARY. SELF IS ALWAYS ALLOWED — SessionContext
                // hydrates the caller's own record through exactly this route
                // (fetchUserDetail / refreshSelfIdentity), and that is THE identity path
                // once the roster leaves the bundle. Cross-user needs a staff
                // capability: without this, a non-staff caller walks ?id=1..N and
                // reassembles the roster one row at a time, defeating the bundle
                // projection entirely.
                //
                // 403, not 404: the id space is dense and sequential so a 404 would leak
                // existence anyway, the caller is authenticated, and the denial is about
                // CAPABILITY — matching every other SUBSET_REQUIRED_PERMISSION denial in
                // this file. Placed BEFORE the fetch: don't fetch what you will refuse.
                //
                // The gate belongs HERE, on the read route, and must NOT migrate into
                // lib/db/users.ts getUserById — POST /api/admin/import-stream
                // re-implements its session resolve around that function.
                if (parsedUserId !== currentUser.id && !mayReceiveRoster(currentUser)) {
                    log.warn('user_detail cross-user denied', { userId: currentUser.id, targetId: parsedUserId });
                    return res.status(403).json({ message: 'Insufficient permissions' });
                }
                const userDetail = await db.getUserById(parsedUserId);
                if (!userDetail) {
                    return res.status(404).json({ message: "User not found" });
                }
                // Auth-only by design for SELF, staff-gated for anyone else — so this
                // subset has no SUBSET_REQUIRED_PERMISSION entry (a flat entry would
                // deny a Client their own record and break the identity path). The
                // payload is ALSO made safe per-viewer — stripSensitiveUserFields
                // rebuilds an allow-list for a non-self / non-admin viewer, so HR/session
                // metadata (probation, tenure, jobTitle, rsiVerified, voiceChannelName,
                // tokensValidFrom, auth_user_id) never leaves the server for them.
                // Self always sees their own personnelNotes / conductRecord /
                // limitingMarkers (the personal "My X" tabs); adminNotes is admin-only.
                const filtered = stripSensitiveUserFields(userDetail as any, requesterFromUser(currentUser));
                return res.status(200).json(filtered);
            }
            case 'request_detail': {
                const { id } = req.query;
                if (!id) return res.status(400).json({ message: "Missing id parameter" });
                // null when absent OR not visible to this caller (non-duty
                // callers may only fetch their own request) — both surface as an
                // indistinguishable 404.
                state = await db.getRequestDetail(id as string, currentUser);
                if (!state) return res.status(404).json({ message: "Request not found" });
                return res.status(200).json(state);
            }
            case 'announcements': state = await db.getAnnouncementsState(currentUser); break;
            case 'discord': state = await db.getDiscordState(); break;
            case 'operations': state = await db.getOperationsState(currentUser); break;
            case 'warrants': state = await db.getWarrantsState(); break;
            // Realtime slice subset: warrant_update broadcasts carry the
            // warrantId(s); the client refetches ONLY those rows. null means
            // deleted — the client removes the row.
            case 'warrant_slice': {
                const { id: warrantId } = req.query;
                if (!warrantId || typeof warrantId !== 'string') return res.status(400).json({ message: 'Missing id parameter' });
                state = { warrant: await db.getWarrantByIdHydrated(warrantId) };
                break;
            }
            case 'external_tools': state = await db.getExternalToolsState(currentUser); break;
            case 'hr': state = await db.getHRState(currentUser); break;
            // Realtime slice subsets: hr_update broadcasts and the hr
            // postgres_changes tables route per-array, so one HR mutation
            // refetches one array instead of all six. Responses keep the
            // { hr: { <array> } } envelope. applicants / interviews / transfers
            // re-apply the SAME viewer redaction as the full bundle via the
            // shared helpers — never raw rows.
            case 'hr_applicants': {
                const recruiter = db.isHrRecruiter(currentUser);
                state = { hr: { applicants: db.redactApplicantsForViewer(await db.getHRApplications(), recruiter) } };
                break;
            }
            case 'hr_interviews': {
                const recruiter = db.isHrRecruiter(currentUser);
                state = { hr: { interviews: db.redactInterviewsForViewer(await db.getAllHRInterviews(), recruiter) } };
                break;
            }
            case 'hr_transfers': {
                // The WIDER staff predicate — an hr:manager or hr:admin runs HR too, and
                // scoping transfers on hr:recruiter alone would hide every row from them.
                state = { hr: { transfers: db.redactTransfersForViewer(await db.getTransferRequests(), db.isHrStaff(currentUser), currentUser?.id) } };
                break;
            }
            case 'hr_jobs': state = { hr: { jobs: await db.getJobPostings() } }; break;
            case 'hr_templates': state = { hr: { templates: await db.getHRInterviewTemplates() } }; break;
            case 'hr_positions': state = { hr: { positions: await db.getPersonnelPositions() } }; break;
            // Wiki pages carry classification + limiting markers. The 'wiki'
            // subset is gated at wiki:view above; additionally filter page bodies
            // by the requester's clearance so below-clearance members (or members
            // lacking a page's marker) never receive classified SOPs.
            case 'wiki': {
                const wikiPages = filterByClearance(await db.getWikiPages(), currentUser);
                // Swap private-bucket image keys for signed URLs in each visible page's content.
                await Promise.all(wikiPages.map(async (p: { content?: unknown }) => { if (p.content) p.content = await signDocMediaForClient(p.content); }));
                state = { wikiPages };
                break;
            }
            // Realtime slice subset: wiki_update broadcasts carry the pageId;
            // the client refetches ONLY that page (bodies are heavy TipTap JSON).
            // Same filterByClearance gate as the bulk path above; null when
            // filtered/absent → the client removes the row.
            case 'wiki_page_slice': {
                const { id: pageId } = req.query;
                if (!pageId || typeof pageId !== 'string') return res.status(400).json({ message: 'Missing id parameter' });
                const page = await db.getWikiPageById(pageId);
                const visible = page ? (filterByClearance([page], currentUser)[0] ?? null) : null;
                if (visible?.content) visible.content = await signDocMediaForClient(visible.content);
                state = { wikiPage: visible };
                break;
            }
            // Realtime duty-flip hydration. contexts/DataContext re-pulls this on EVERY
            // duty_update broadcast, and that handler is attached UNCONDITIONALLY for
            // every member on the base channel (contexts/DataCoreContext.tsx duty_update),
            // so this subset must answer 200 for every authenticated tier: a 403 here
            // costs a caught console error, a wasted round-trip on every duty flip in
            // the org for every rosterless caller, and — decisively — the loss of the
            // one scalar those callers are entitled to. (It is NOT an unhandled
            // rejection: contexts/DataContext.tsx wraps the whole subset switch in a
            // try/catch and services/apiService.ts handleResponseError special-cases 401
            // only. The conclusion stands; the mechanism is a caught error.)
            //
            // AUTH-ONLY BY DESIGN, and only for the `anyStaffOnDuty` scalar: one boolean
            // answering "is anyone available to take my request?", which is the org's
            // external customers' entire entitlement here and the gate on their only
            // flow. It carries no identity and no staffing level. It rides this subset
            // because duty_update dispatches SOLELY users_presence — a scalar that only
            // rode `main` would freeze at its page-load reading for the whole session.
            //
            // The `usersPresence` LIST is a different thing: it enumerates every live
            // user id in the org plus each one's lastActiveAt, i.e. it is a ROSTER
            // surface and an org-wide user-id enumeration that would make a
            // ?id=1..N user_detail walk trivial. It is therefore withheld from a
            // non-staff caller by the SAME predicate as the `main` bundle projection and
            // the users_slice / user_detail gates (lib/rosterGate.ts mayReceiveRoster,
            // whose first disjunct is the isSystemAdmin identity flag), so the four
            // roster surfaces cannot drift apart. 200 on BOTH branches — never a 403,
            // see above. The GATE moved to the shared predicate; the SHAPE is unchanged
            // and owner decision D1 still holds: the fetch is never gated on the client,
            // only this payload is, and a non-staff caller still gets one boolean plus
            // an empty array.
            case 'users_presence': {
                const isRosterViewer = mayReceiveRoster(currentUser);
                const [presenceState, anyStaffOnDuty] = await Promise.all([
                    isRosterViewer
                        ? db.getUsersPresenceState()
                        : Promise.resolve({ usersPresence: [] as Array<{ userId: number; isDuty: boolean; lastActiveAt: string | null }> }),
                    db.isAnyStaffOnDuty(),
                ]);
                state = { ...presenceState, anyStaffOnDuty };
                break;
            }
            case 'warehouse': {
                const [warehouseCatalog, warehouseStock, warehouseRequests] = await Promise.all([
                    db.listWarehouseCatalog(),
                    db.listWarehouseStock(),
                    db.listWithdrawalRequests({ status: 'open' }),
                ]);
                state = { warehouseCatalog, warehouseStock, warehouseRequests };
                break;
            }
            // Single-slice subsets so realtime broadcasts can refresh ONLY the
            // affected slice instead of the whole warehouse bundle (3× egress
            // amplification per mutation otherwise).
            case 'warehouse_catalog': {
                state = { warehouseCatalog: await db.listWarehouseCatalog() };
                break;
            }
            case 'warehouse_stock': {
                state = { warehouseStock: await db.listWarehouseStock() };
                break;
            }
            case 'warehouse_requests': {
                state = { warehouseRequests: await db.listWithdrawalRequests({ status: 'open' }) };
                break;
            }
            // Marketplace: the board (active listings + categories) is org-wide;
            // contracts are scoped to the caller (party-only) inside the db layer.
            case 'marketplace': {
                state = await db.getMarketplaceState(currentUser.id);
                break;
            }
            case 'marketplace_listings': {
                state = { marketplaceListings: await db.browseMarketplaceListings({}) };
                break;
            }
            case 'marketplace_contracts': {
                state = { marketplaceContracts: await db.getMyMarketplaceContracts(currentUser.id) };
                break;
            }
            // Notification Center: the caller's OWN inbox (capped list + unread
            // count). Self-scoped by currentUser.id inside the db layer — a member
            // only ever receives their own rows — so it has NO
            // SUBSET_REQUIRED_PERMISSION entry (every authenticated member has a
            // personal inbox, gated by user_id scoping, not by a role permission).
            case 'notifications': {
                state = await db.getUserNotificationState(currentUser.id);
                break;
            }
            // Academy staff management bundle (gated academy:view above; feature-gated
            // to an empty payload by the SUBSET_REQUIRED_FEATURE gate before the switch).
            case 'academy': {
                state = await db.getAcademyStaffState();
                break;
            }
            // Academy self-service bundle: the published catalog + the caller's own
            // enrolments, scoped by currentUser.id in the db layer (no
            // SUBSET_REQUIRED_PERMISSION entry — every member has a My Academy;
            // feature-gated to empty before the switch).
            case 'academy_my': {
                state = await db.getMyAcademyState(currentUser.id);
                break;
            }
            case 'intel': state = await db.getIntelState(currentUser); break;
            // Realtime slice subsets: intel_update {kind:'report'} refetches
            // ONLY the report aggregates (index + hub stats — full-recompute
            // by nature); bulletin broadcasts refetch ONE clearance-filtered
            // bulletin row instead of the whole bundle.
            case 'intel_summary': {
                // Same per-viewer clearance ceiling as the 'intel' bundle — the
                // aggregates must not reveal classified targets.
                const [intelTargetIndex, intelHubStats] = await Promise.all([
                    db.getIntelTargetIndex(currentUser),
                    db.getIntelHubStats(currentUser),
                ]);
                state = { intelTargetIndex, intelHubStats };
                break;
            }
            case 'bulletin_slice': {
                const { id: bulletinId } = req.query;
                if (!bulletinId || typeof bulletinId !== 'string') return res.status(400).json({ message: 'Missing id parameter' });
                // Re-applies the same clearance/marker filter as the bulk
                // activeBulletins path — null when filtered.
                state = { bulletin: await db.getBulletinByIdForViewer(bulletinId, currentUser) };
                break;
            }
            // (No 'alliances' subset: the directory UI lazy-fetches via the
            // alliance:get_directory RPC — same db.getAllianceDirectory() — so this
            // subset was a dead round-trip with no client consumer. An ?subset=alliances
            // probe now falls through to the unknown-subset reject below.)
            case 'fleet': state = await db.getFleetState(); break;
            // Realtime slice subsets: fleet_update broadcasts carry
            // {slices:[...]} naming the touched array(s) — the ~static ship
            // catalog no longer re-egresses on every hangar/group edit.
            case 'fleet_catalog': state = { shipCatalog: await db.getShipCatalog() }; break;
            case 'fleet_user_ships': state = { userShips: await db.getUserShips() }; break;
            case 'fleet_groups': state = { fleetGroups: await db.getFleetGroups() }; break;
            case 'government': state = await db.getGovernmentState(); break;
            // Realtime slice subsets: government_update broadcasts carry a
            // {slices:[...]} key-group discriminator; each subset returns only
            // its key(s) so a legislation vote doesn't re-pull elections +
            // motions + structure. Producers are the SAME functions that back
            // the full bundle (vote-count zeroing + withdrawn-candidate
            // stripping included) — never raw rows.
            case 'government_structure': state = await db.getGovernmentStructureState(); break;
            case 'government_elections': state = { governmentElections: await db.getElectionsState().catch(() => []) }; break;
            case 'government_legislation': state = { governmentLegislation: await db.getLegislationState().catch(() => []) }; break;
            case 'government_motions': state = { governmentMotions: await db.getMotionsState().catch(() => []) }; break;
            // (No 'settings' subset: the client refreshes config keys via the
            // 'main' subset — see contexts/DataCoreContext.tsx "there is no
            // separate 'settings' subset". This branch reduced EVERY settings row
            // into one blob, had no SUBSET_REQUIRED_PERMISSION gate, and relied
            // solely on stripSecrets, so it was a dead, ungated round-trip. An
            // ?subset=settings probe now falls through to the unknown-subset
            // reject below — mirroring the removed 'alliances' subset above.)
            // No subset → legacy "full state" refresh (now permission-gated inside
            // getState). A non-empty UNKNOWN subset string is rejected rather than
            // silently falling through to the full aggregate (defence-in-depth so a
            // typo / probe can never widen the response).
            case undefined:
            case '':
                state = await db.getState(currentUser);
                break;
            default:
                return res.status(400).json({ message: 'Unknown subset' });
        }
        // Permission-aware strip if this state response carries the bulk
        // user roster (handled here in addition to the 'main' case to cover
        // the default fallback that returns full getState()).
        if (state && Array.isArray((state as any).users)) {
            (state as any).users = stripSensitiveUserFieldsBulk((state as any).users, requesterFromUser(currentUser));
        }
        // Only decorate discordConfig when the subset actually loaded it.
        // Subsets like 'main' / 'requests' don't fetch discord settings, and
        // unconditionally writing { clientId: undefined } caused a race where
        // a settings-change broadcast (which refreshes both main + discord)
        // could land main last and clobber the real discordConfig in the
        // dashboard, briefly showing "Discord Bot Not Configured" until reload.
        const responseBody: Record<string, unknown> = { ...(state as Record<string, unknown>) };
        const stateDiscord = (state as { discordConfig?: DiscordConfig } | null)?.discordConfig;
        if (stateDiscord !== undefined) {
            // clientId after the spread so the env var wins over the DB value.
            responseBody.discordConfig = {
                ...stateDiscord,
                clientId: process.env.DISCORD_CLIENT_ID || stateDiscord?.clientId,
            };
        }
        return res.status(200).json(stripSecrets(responseBody));
    } catch (e: any) {
        log.error('failed to fetch subset', { subset, err: e });
        return res.status(500).json({ message: "Database Error" });
    }
}

async function handleFeed(req: Request, res: Response) {
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) return res.status(401).json({ message: 'Missing API Key' });

    try {
        const keyData = await db.verifyApiKey(apiKey);
        if (!keyData) return res.status(403).json({ message: 'Invalid API Key' });

        // Alliance keys (label "alliance:<peerId>") aren't allowed on this legacy
        // feed: it returns the org-wide feed with every channel, which would skip the
        // per-peer clearance limit and channel choices that /api/alliance/data applies.
        // Paired allies must use that endpoint instead. "alliance:" is a reserved
        // label prefix, so manually created keys must not start with it.
        if (typeof (keyData as { label?: string }).label === 'string' && (keyData as { label: string }).label.startsWith('alliance:')) {
            return res.status(403).json({ message: 'Use the alliance data channel for this key' });
        }

        // SCOPE ENFORCEMENT. The label check above is the historical, incidental gate — one
        // direction only, and keyed on a naming convention. This is the declared capability: a
        // key reaches this surface because it SAYS it may, not because its label happens not to
        // start with a reserved prefix. A key with no scopes at all (issued before the column
        // existed) is grandfathered; see lib/apiKeyScopes.ts for why that fail-open is bounded.
        if (!keyHasScope((keyData as { scopes?: unknown }).scopes, 'feed')) {
            return res.status(403).json({ message: 'This key is not scoped for the intel feed' });
        }

        // Validate the cursor rather than passing it through. An unhonourable
        // cursor does not fail loudly: it returns an empty page, and the consumer
        // stores our _meta.fetchedAt as its next cursor and moves PAST rows it never
        // received. A 400 is the only outcome that does not lose the peer's data.
        const cursor = parseFeedCursor(req.query.since);
        if (!cursor.ok) {
            log.warn('feed cursor rejected', { reason: cursor.reason });
            return res.status(400).json({ message: cursor.message });
        }
        const feedData = await db.getPublicFeedData(cursor.since);

        return res.status(200).json({
            countReports: feedData.reports.length,
            countWarrants: feedData.warrants.length,
            countBulletins: feedData.bulletins.length,
            // MIRROR _meta, never the wall clock — see the same field on
            // /api/alliance/data: a consumer that falls back to this one would
            // advance its cursor past the rows a saturated page withheld.
            fetchedAt: feedData._meta.fetchedAt,
            reports: feedData.reports,
            warrants: feedData.warrants,
            bulletins: feedData.bulletins,
            _meta: feedData._meta
        });
    } catch (e) {
        log.error('feed error', { err: e });
        return res.status(500).json({ message: "Internal Error" });
    }
}

// --- MAIN ROUTER ---

export default async function handler(req: Request, res: Response) {
    if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });

    const { target } = req.query;

    // Maintenance mode + force logout enforcement on authenticated data queries
    if (target === 'state' || target === 'initial-state') {
        try {
            const platformSettings = await db.getPlatformSettings();
            const isMaintenanceActive = platformSettings?.maintenance_mode === true;

            // initial-state must ALWAYS pass through so the frontend can boot and render
            // the maintenance screen. Only 'state' (subset refresh) calls are blocked.
            const skipMaintenanceBlock = target === 'initial-state';

            // Force logout: enforce regardless of maintenance state on 'state' calls
            // (skipped on initial-state so the app can boot and render a maintenance/
            // logout screen). The platform admin needs to revoke compromised sessions
            // without taking the entire platform offline.
            if (platformSettings?.force_logout_timestamp && !skipMaintenanceBlock) {
                // DUAL-ACCEPT: cookie preferred, Authorization header still honoured for sessions issued before the cookie existed.
                const token = credentialFromRequest(req.headers['authorization'], req.headers['cookie'], SESSION_COOKIE_IS_SECURE);
                if (token) {
                    const decoded = verifyToken(token);
                    // Use the shared predicate (not a hand-rolled copy) so the
                    // read path can't drift from the dispatcher if the revocation
                    // rule changes.
                    if (decoded && isSessionForceLoggedOut(decoded, platformSettings.force_logout_timestamp)) {
                        appendSetCookie(res, clearSessionCookie(SESSION_COOKIE_IS_SECURE)); return res.status(401).json({ message: 'Session expired. Please log in again.', force_logout: true });
                    }
                }
            }

            // Maintenance mode: block non-admin data fetches (respects scope setting)
            if (isMaintenanceActive && !skipMaintenanceBlock) {
                // Single-org: maintenance blocks the dashboard whenever active.
                {
                    let isAdmin = false;
                    // DUAL-ACCEPT: cookie preferred, Authorization header still honoured for sessions issued before the cookie existed.
                    const token = credentialFromRequest(req.headers['authorization'], req.headers['cookie'], SESSION_COOKIE_IS_SECURE);
                    if (token) {
                        const decoded = verifyToken(token);
                        if (decoded) {
                            // Own try/catch: getUserById is fail-closed and THROWS on
                            // a read fault. The outer catch below only warns, and the
                            // 503 return lives inside it — so letting the throw escape
                            // here would skip the maintenance gate entirely and serve
                            // the dashboard to everyone on a DB blip. Unknown ⇒ not
                            // Admin.
                            let adminUser: Awaited<ReturnType<typeof db.getUserById>> = null;
                            try { adminUser = await db.getUserById(decoded.userId); }
                            catch (err) { log.warn('maintenance admin check failed; treating as non-admin', { err }); }
                            // Role IDENTITY (stamped by getUserById), with a
                            // cache-free re-resolve on the DENY path only. Must stay
                            // byte-identical to the api/services.ts twin: if the two
                            // surfaces disagree about who is an Admin during
                            // maintenance, the dashboard loads and every mutation
                            // 503s (or vice versa). Unknown ⇒ not Admin.
                            if (adminUser?.isSystemAdmin === true) isAdmin = true;
                            else if (adminUser) isAdmin = await db.resolveIsSystemAdminFresh(adminUser.roleId);
                        }
                    }
                    if (!isAdmin) {
                        return res.status(503).json({ message: 'The organization dashboard is currently undergoing maintenance. Please try again later.' });
                    }
                }
            }
        } catch (e) {
            log.warn('failed to check platform enforcement', { err: e });
        }
    }

    try {
        switch (target) {
            case 'config': return await handleConfig(req, res);
            case 'manifest': return await handleManifest(req, res);
            case 'initial-state': return await handleInitialState(req, res);
            case 'state': return await handleState(req, res);
            case 'feed': return await handleFeed(req, res);
            default: return res.status(404).json({ message: 'Unknown query target' });
        }
    } catch (error: any) {
        log.error('error handling query target', { target, err: error });
        // Don't echo raw error.message to the client (it can disclose internals);
        // the real error is logged above.
        return res.status(500).json({ message: 'Internal Server Error' });
    }
}
