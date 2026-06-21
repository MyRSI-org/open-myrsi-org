
import { Request, Response } from 'express';
import * as db from '../lib/db.js';
import { verifyToken, isSessionForceLoggedOut, isSessionRevokedByWatermark, signRealtimeToken } from '../lib/auth.js';
import { stripSensitiveUserFields, stripSensitiveUserFieldsBulk, RequesterContext } from '../lib/db/userFilters.js';
import { filterByClearance } from '../lib/clearance.js';
import type { DiscordConfig } from '../types.js';
import { log as baseLog } from '../lib/log.js';

const log = baseLog.child({ module: 'api.query' });

// Build a RequesterContext from a resolved currentUser for permission-aware
// field stripping. Returns null when there's no authenticated user.
function requesterFromUser(currentUser: any): RequesterContext | null {
    if (!currentUser) return null;
    return {
        id: currentUser.id,
        role: currentUser.role,
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

// --- READ-PATH AUTHORIZATION ---
// Map sensitive /api/query subsets to the same permission strings used by the
// api/services.ts dispatcher and the UI nav gates, so a low-privilege member
// can't read them. Subsets not listed here are readable by any authenticated
// org member.
const SUBSET_REQUIRED_PERMISSION: Record<string, string> = {
    warrants: 'warrant:view',
    // Realtime slice subset — same gate as the 'warrants' list it patches.
    warrant_slice: 'warrant:view',
    // Discord role-sync maps (synced roles + rank/role mappings) are
    // admin-console configuration — only the settings tab consumes them.
    // (discordConfig channel ids still ride boot for other domains.)
    discord: 'admin:config:discord',
    intel: 'intel:view',
    // Realtime slice subsets — same gate as the 'intel' bundle they patch
    // (the intel:view ⇄ intel:view:clearance synonym below applies because
    // callerHasSubsetPermission keys on the required-permission STRING).
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
    // Realtime slice subsets — same gate as the 'operations' bundle they
    // patch. (users_slice is deliberately ungated, matching 'main': any
    // authenticated member already receives the whole lite roster there, and
    // the per-field strip below applies identically.)
    operation_slice: 'operations:view',
    operation_templates: 'operations:view',
    warehouse: 'warehouse:view',
    warehouse_catalog: 'warehouse:view',
    warehouse_stock: 'warehouse:view',
    warehouse_requests: 'warehouse:view',
    marketplace: 'marketplace:view',
    marketplace_listings: 'marketplace:view',
    marketplace_contracts: 'marketplace:view',
};

// Mirror the BOLA permission check in api/services.ts: org-owner bypass, then a
// direct permission grant, plus the intel:view ⇄ intel:view:clearance synonym.
function callerHasSubsetPermission(currentUser: any, ctx: any, requiredPerm: string): boolean {
    if (!requiredPerm) return true;
    if (ctx?.ownerId && currentUser?.auth_user_id && ctx.ownerId === currentUser.auth_user_id) return true;
    const perms: string[] = currentUser?.permissions || [];
    if (perms.includes(requiredPerm)) return true;
    if (requiredPerm === 'intel:view' && perms.includes('intel:view:clearance')) return true;
    return false;
}

// --- SECURITY: Strip secrets before sending state to the browser ---
// Customer API keys must never reach the client. The portal (org:get_settings)
// has its own authenticated endpoint that returns secrets for the management UI.
export function stripSecrets(state: any): any {
    if (!state) return state;
    const cleaned = { ...state };

    // Discord: only clientId and channel IDs are needed by the frontend
    if (cleaned.discordConfig) {
        cleaned.discordConfig = {
            clientId: cleaned.discordConfig.clientId,
            newRequestChannelId: cleaned.discordConfig.newRequestChannelId,
            intelChannelId: cleaned.discordConfig.intelChannelId,
            eamChannelId: cleaned.discordConfig.eamChannelId,
        };
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
    // must NEVER reach the browser. The self-profile is public-intent and stays.
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

    // systemConfig (appUrl / welcomeMessage) rides the settings blob but no client
    // slice setter or component consumes it — the only appUrl reader derives it from
    // window.location.origin and writes via admin:update_system_config. Server-internal
    // callers (getOrgTenantUrl, public page data) read it via their own paths, so drop
    // it from every browser-bound payload here rather than at the source.
    delete cleaned.systemConfig;

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

    // Safety net: the settings blob contains every settings row, so a secret
    // added in the future (named like *_secret, *_api_key, *_password, *_webhook,
    // or *_token) could reach the browser unless we catch it here. Drop any
    // top-level text value whose key looks like a secret. Only plain strings are
    // dropped, so the config objects and lists built above are left untouched.
    for (const key of Object.keys(cleaned)) {
        if (typeof cleaned[key] === 'string' && /(_api_key|_secret|_password|_webhook|_token)/i.test(key)) {
            delete cleaned[key];
        }
    }

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

async function handleManifest(req: Request, res: Response) {
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
    // Allow cross-origin manifest fetch (tenant subdomains fetch from TLD)
    res.setHeader('Access-Control-Allow-Origin', '*');

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
    // Admin-ness is resolved server-side from the session JWT (users.role ===
    // 'Admin') and enforced by the per-action permission gate in services.ts —
    // never derived from anything sent to the client.
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
            const { count } = await db.supabase.from('users').select('*', { count: 'exact', head: true })
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
        }));
    }

    // Try to restore session from token
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    let currentUser = null;

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
                    return res.status(401).json({ message: 'Session expired. Please log in again.', force_logout: true });
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
            platformSettings: bootPlatformSettings(platformSettings),
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
    const { subset } = req.query;
    try {
        // Resolve User for Authenticated Subsets (like operations)
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
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
                    return res.status(401).json({ message: 'Session expired. Please log in again.', force_logout: true });
                }
            }
        }

        // Single-org: state subsets run under the service-role key. Require an
        // authenticated user for ALL subsets (no cross-org check — one org only).
        if (!currentUser) {
            return res.status(403).json({ message: 'Forbidden: Authentication required.' });
        }

        // Per-subset permission gate for sensitive resources (warrants / intel / hr).
        // Org membership alone is not sufficient — a Client-tier member must not be
        // able to read the warrant/KOS list, intel reports, or HR records.
        const requiredPerm = SUBSET_REQUIRED_PERMISSION[subset as string];
        if (requiredPerm && !callerHasSubsetPermission(currentUser, null, requiredPerm)) {
            log.warn('subset permission denied', { userId: currentUser.id, subset, requiredPerm });
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        let state;
        switch (subset) {
            case 'main': {
                // Fetch the settings blob alongside main so a 'main' refresh
                // carries the config keys (radioConfig, discordConfig, etc.).
                // The realtime layer re-pulls 'main' on reconnect and on
                // settings_update; getMainState alone omits these.
                const [mainState, settings] = await Promise.all([
                    db.getMainState(),
                    db.getAllSettings({ decryptSecrets: false }),
                ]);
                // Bulk roster: every member fetches every other member's record,
                // so non-privileged callers must not see others' adminNotes /
                // personnelNotes / conductRecord / limitingMarkers.
                if (mainState && Array.isArray(mainState.users)) {
                    mainState.users = stripSensitiveUserFieldsBulk(mainState.users as any, requesterFromUser(currentUser)) as any;
                }
                state = { ...mainState, ...settings };
                break;
            }
            // Request visibility is scoped per-caller inside
            // getRequestsState/getRequestDetail — duty-permission holders see
            // the full log, everyone else only their own requests.
            case 'requests': state = await db.getRequestsState(currentUser); break;
            // Realtime slice path: user_update broadcasts carry the affected
            // user id(s); the client refetches ONLY those roster rows instead of
            // the whole 'main' bundle. Same exposure as 'main' — the shared
            // stripSensitiveUserFieldsBulk below runs (this case isn't early-return).
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
                state = { users: await db.getUsersByIdsLite(ids) };
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
                const userDetail = await db.getUserById(parsedUserId);
                if (!userDetail) {
                    return res.status(404).json({ message: "User not found" });
                }
                // Permission-gate sensitive heavy fields. Self always sees
                // their own personnelNotes / conductRecord / limitingMarkers
                // (consumed by personal "My X" tabs). adminNotes is admin-only.
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
                const recruiter = db.isHrRecruiter(currentUser);
                state = { hr: { transfers: db.redactTransfersForViewer(await db.getTransferRequests(), recruiter) } };
                break;
            }
            case 'hr_jobs': state = { hr: { jobs: await db.getJobPostings() } }; break;
            case 'hr_templates': state = { hr: { templates: await db.getHRInterviewTemplates() } }; break;
            case 'hr_positions': state = { hr: { positions: await db.getPersonnelPositions() } }; break;
            // Wiki pages carry classification + limiting markers. The 'wiki'
            // subset is gated at wiki:view above; additionally filter page bodies
            // by the requester's clearance so below-clearance members (or members
            // lacking a page's marker) never receive classified SOPs.
            case 'wiki': state = { wikiPages: filterByClearance(await db.getWikiPages(), currentUser) }; break;
            // Realtime slice subset: wiki_update broadcasts carry the pageId;
            // the client refetches ONLY that page (bodies are heavy TipTap JSON).
            // Same filterByClearance gate as the bulk path above; null when
            // filtered/absent → the client removes the row.
            case 'wiki_page_slice': {
                const { id: pageId } = req.query;
                if (!pageId || typeof pageId !== 'string') return res.status(400).json({ message: 'Missing id parameter' });
                const page = await db.getWikiPageById(pageId);
                state = { wikiPage: page ? (filterByClearance([page], currentUser)[0] ?? null) : null };
                break;
            }
            case 'users_presence': state = await db.getUsersPresenceState(); break;
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
            case 'settings': state = await db.getAllSettings({ decryptSecrets: false }); break;
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

        const since = req.query.since as string;
        const feedData = await db.getPublicFeedData(since);

        return res.status(200).json({
            countReports: feedData.reports.length,
            countWarrants: feedData.warrants.length,
            countBulletins: feedData.bulletins.length,
            fetchedAt: new Date().toISOString(),
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
                const authHeader = req.headers['authorization'];
                const token = authHeader && (authHeader as string).split(' ')[1];
                if (token) {
                    const decoded = verifyToken(token);
                    // Use the shared predicate (not a hand-rolled copy) so the
                    // read path can't drift from the dispatcher if the revocation
                    // rule changes.
                    if (decoded && isSessionForceLoggedOut(decoded, platformSettings.force_logout_timestamp)) {
                        return res.status(401).json({ message: 'Session expired. Please log in again.', force_logout: true });
                    }
                }
            }

            // Maintenance mode: block non-admin data fetches (respects scope setting)
            if (isMaintenanceActive && !skipMaintenanceBlock) {
                // Single-org: maintenance blocks the dashboard whenever active.
                {
                    let isAdmin = false;
                    const authHeader = req.headers['authorization'];
                    const token = authHeader && (authHeader as string).split(' ')[1];
                    if (token) {
                        const decoded = verifyToken(token);
                        if (decoded) {
                            const adminUser = await db.getUserById(decoded.userId);
                            if (adminUser?.role === 'Admin') isAdmin = true;
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
