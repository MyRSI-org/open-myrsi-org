import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

// api/query.ts — the UNAUTHENTICATED and BOOT surfaces, end to end through the
// router: target=config, target=manifest, every target=initial-state branch
// (needs-setup / logged-out / force-logout / revoked / banned / logged-in /
// error fallback), the API-key feed, the router's own method + target guards,
// and stripSecrets on its less-travelled branches.
//
// Real pieces on purpose: lib/auth (genuine HMAC session tokens — expiry, the
// iat-vs-watermark comparison and the force-logout predicate all run for real),
// lib/sessionCookie (cookie-vs-header precedence, Set-Cookie clearing),
// lib/supabaseKeyGuard, lib/db/userFilters (the self/roster strip),
// lib/settingsProjection, lib/feedCursor and lib/apiKeyScopes. Only the db layer,
// media signing and the logger are doubles (tests/covQueryHarness.ts).

vi.mock('../lib/db', async () => {
    const hh = await import('./covQueryHarness');
    return { supabase: hh.supabaseStub, ...hh.dbFns };
});
vi.mock('../lib/orgMediaDocs', async () => {
    const hh = await import('./covQueryHarness');
    return { signDocMediaForClient: (...a: unknown[]) => hh.signDoc(...a) };
});
vi.mock('../lib/db/system', async () => {
    const hh = await import('./covQueryHarness');
    return { isApiKeySchemaOutdated: () => hh.flags.schemaOutdated };
});
vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    const hh = await import('./covQueryHarness');
    return {
        ...actual,
        log: { ...actual.log, child: (ctx: Record<string, unknown>) => (ctx.module === 'api.query' ? hh.queryLog : actual.log.child(ctx)) },
    };
});

import handler, { stripSecrets } from '../api/query';
import { signToken } from '../lib/auth';
import { sessionCookieName, SESSION_COOKIE_IS_SECURE } from '../lib/sessionCookie';
import { dbFns, sb, signDoc, queryLog, resetHarness, mockReq, mockRes } from './covQueryHarness';
import { FAKE_PUBLISHABLE, FAKE_SECRET, FAKE_SERVICE_ROLE_JWT } from './supabaseKeyFixtures';

const COOKIE_NAME = sessionCookieName(SESSION_COOKIE_IS_SECURE);
const HOUR = 60 * 60 * 1000;
const RT_SECRET = 'realtime-jwt-secret-for-cov-query-tests';

/** A REAL session token, minted `agoMs` in the past (iat/exp shift with it). */
function tokenFor(userId: number, agoMs = 0): string {
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now - agoMs);
    try { return signToken({ userId }); } finally { spy.mockRestore(); }
}
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

const MEMBER = {
    id: 6, name: 'Mem', role: 'Member', roleId: 2, discordId: 'd6', auth_user_id: 'auth-6',
    permissions: ['operations:view', 'user:view:roster'],
    adminNotes: 'ADMIN-ONLY NOTE ABOUT 6', personnelNotes: 'my own notes', isSystemAdmin: false,
    tokensValidFrom: null as string | null,
};
const OTHER = {
    id: 7, name: 'Other', role: 'Member', roleId: 2, discordId: 'd7', auth_user_id: 'auth-7',
    permissions: ['operations:view'], adminNotes: 'note about 7', personnelNotes: 'pn7', jobTitle: 'Spy',
};
let users: Record<number, Record<string, unknown>>;

async function call(query: Record<string, unknown>, opts?: Parameters<typeof mockReq>[1]) {
    const res = mockRes();
    await handler(mockReq(query, opts), res as never);
    return res;
}
const initialState = (opts?: Parameters<typeof mockReq>[1]) => call({ target: 'initial-state' }, opts);
function setCookieOf(res: ReturnType<typeof mockRes>): string {
    const v = res.headers['Set-Cookie'];
    return Array.isArray(v) ? v.join('\n') : (v ?? '');
}

beforeEach(() => {
    resetHarness();
    users = { 6: { ...MEMBER }, 7: { ...OTHER } };
    vi.stubEnv('SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('SUPABASE_ANON_KEY', FAKE_PUBLISHABLE);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', FAKE_SERVICE_ROLE_JWT);
    vi.stubEnv('DISCORD_CLIENT_ID', '');
    vi.stubEnv('SUPABASE_JWT_SECRET', RT_SECRET);
    dbFns.isSetupCompleted.mockResolvedValue(true);
    dbFns.getPlatformSettings.mockResolvedValue({});
    dbFns.getUserById.mockImplementation(async (id: number) => (users[id] ? { ...users[id] } : null));
    dbFns.getBanNotice.mockResolvedValue(null);
    dbFns.getAllSettings.mockResolvedValue({
        brandingConfig: { name: 'Acme Org', iconUrl: '/acme.svg', loginBackgroundUrl: 'https://x/bg.png', tosText: 'internal ToS' },
        discordConfig: { clientId: 'db-client-id', newRequestChannelId: '111111111111111111', botToken: 'BOT-TOKEN-SECRET' },
        themeConfig: { enabled: true, accent: '#ABC', css: 'body{}' },
        intelSharingConfig: { maxShareableClearance: 3 },
    });
    dbFns.getState.mockResolvedValue({ users: [{ ...MEMBER }, { ...OTHER }], discordConfig: { clientId: 'db-client-id' } });
});
afterEach(() => { vi.unstubAllEnvs(); });

// ───────────────────────────── router guards ─────────────────────────────
describe('router guards', () => {
    it('refuses every non-GET method with 405 before touching the db', async () => {
        for (const method of ['POST', 'PUT', 'DELETE']) {
            const res = await call({ target: 'state', subset: 'main' }, { method });
            expect(res.statusCode).toBe(405);
            expect(res.body).toEqual({ message: 'Method not allowed' });
        }
        expect(dbFns.getPlatformSettings).not.toHaveBeenCalled();
        expect(dbFns.getUserById).not.toHaveBeenCalled();
    });

    it('404s an unknown or missing target without consulting platform settings', async () => {
        for (const query of [{ target: 'settings' }, { target: 'alliances' }, {}]) {
            const res = await call(query);
            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ message: 'Unknown query target' });
        }
        expect(dbFns.getPlatformSettings).not.toHaveBeenCalled();
    });

    it('a sub-handler throw becomes an opaque 500 — the raw error text is logged, never echoed', async () => {
        // getPlatformSettings is contractually non-throwing; if it ever did, the router's
        // enforcement block swallows the first throw (warn) and the logged-out boot
        // branch's unguarded read escalates the second to the router catch.
        dbFns.getPlatformSettings.mockRejectedValue(new Error('relation "settings" does not exist at 10.0.0.5'));
        const res = await initialState();
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ message: 'Internal Server Error' });
        expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
        expect(queryLog.warn).toHaveBeenCalledWith('failed to check platform enforcement', expect.objectContaining({ err: expect.any(Error) }));
        expect(queryLog.error).toHaveBeenCalledWith('error handling query target', expect.objectContaining({ target: 'initial-state', err: expect.any(Error) }));
    });
});

// ───────────────────────────── target=config ─────────────────────────────
describe('target=config', () => {
    it('ships the URL and a publishable anon key', async () => {
        const res = await call({ target: 'config' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', supabaseAnonKey: FAKE_PUBLISHABLE });
    });

    it('fails closed to an opaque 500 when the URL is unset', async () => {
        vi.stubEnv('SUPABASE_URL', '');
        const res = await call({ target: 'config' });
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ message: 'Server configuration error.' });
    });

    it.each([['an sb_secret_ key', FAKE_SECRET], ['the service-role key itself', FAKE_SERVICE_ROLE_JWT]])(
        'never publishes %s pasted as the anon key — same opaque 500, no hint which rule tripped', async (_l, key) => {
            vi.stubEnv('SUPABASE_ANON_KEY', key);
            const res = await call({ target: 'config' });
            expect(res.statusCode).toBe(500);
            expect(res.body).toEqual({ message: 'Server configuration error.' });
            expect(JSON.stringify(res.body)).not.toContain(key);
        });
});

// ───────────────────────────── target=manifest ─────────────────────────────
describe('target=manifest', () => {
    function withSettings(branding: unknown, og: unknown) {
        sb.tables.settings = () => ({ data: [{ key: 'brandingConfig', value: branding }, { key: 'openGraphConfig', value: og }], error: null });
    }

    it('builds a PWA manifest from public branding only, with public cache headers and no CORS grant', async () => {
        withSettings({ name: 'Very Long Organization Name', iconUrl: 'https://cdn.example/icon.webp' }, { themeColor: '#112233', description: 'Our ops' });
        const res = await call({ target: 'manifest' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Type']).toBe('application/manifest+json');
        expect(res.headers['Cache-Control']).toBe('public, s-maxage=60, stale-while-revalidate=300');
        expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
        expect(res.body).toMatchObject({
            id: '/', name: 'Very Long Organization Name', short_name: 'Very Long Or', description: 'Our ops',
            background_color: '#112233', theme_color: '#112233', start_url: '/?source=pwa', display: 'standalone',
        });
        // External raster: fixed sizes, plus a local SVG fallback for installability.
        expect(res.body.icons).toEqual([
            { src: 'https://cdn.example/icon.webp', sizes: '192x192', type: 'image/webp', purpose: 'any' },
            { src: 'https://cdn.example/icon.webp', sizes: '512x512', type: 'image/webp', purpose: 'any' },
            { src: 'https://cdn.example/icon.webp', sizes: '512x512', type: 'image/webp', purpose: 'maskable' },
            { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ]);
        expect(res.body.shortcuts[0].icons[0]).toEqual({ src: 'https://cdn.example/icon.webp', sizes: '192x192', type: 'image/webp' });
        // Only the two public keys are read — never the whole settings table.
        expect(sb.queries).toHaveLength(1);
        expect(sb.queries[0].table).toBe('settings');
        expect(sb.queries[0].calls).toEqual([['select', ['key, value']], ['in', ['key', ['brandingConfig', 'openGraphConfig']]]]);
        // Public target: no session or platform-settings work at all.
        expect(dbFns.getPlatformSettings).not.toHaveBeenCalled();
        expect(dbFns.getUserById).not.toHaveBeenCalled();
    });

    it('an SVG icon uses sizes "any" (any + maskable) and the OG pwaIconUrl wins over the branding icon', async () => {
        withSettings({ name: 'Short', iconUrl: '/ignored.png' }, { pwaIconUrl: '/pwa.SVG' });
        const res = await call({ target: 'manifest' });
        expect(res.body.short_name).toBe('Short');
        expect(res.body.icons).toEqual([
            { src: '/pwa.SVG', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
            { src: '/pwa.SVG', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ]);
        expect(res.body.shortcuts[1].icons[0].sizes).toBe('any');
    });

    it('a LOCAL raster icon gets no external-fallback entry', async () => {
        withSettings({ name: 'Org', iconUrl: '/logo.png' }, {});
        const res = await call({ target: 'manifest' });
        expect(res.body.icons).toHaveLength(3);
        expect(res.body.icons.every((i: { type: string }) => i.type === 'image/png')).toBe(true);
    });

    it.each([
        ['https://x/a.JPG', 'image/jpeg'],
        ['https://x/a.jpeg', 'image/jpeg'],
        ['https://x/a.ico', 'image/x-icon'],
        ['https://x/a.bmp', 'image/png'],
        ['data:image/gif;base64,R0lGOD', 'image/gif'],
        ['data:nonsense', 'image/png'],
    ])('derives the icon MIME type for %s → %s', async (iconUrl, type) => {
        withSettings({ name: 'Org', iconUrl }, {});
        const res = await call({ target: 'manifest' });
        expect(res.body.icons[0].type).toBe(type);
    });

    const DEFAULT_ICONS = [
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ];

    it('a settings query error still returns the valid default manifest (logged, not echoed)', async () => {
        sb.tables.settings = () => ({ data: null, error: { message: 'permission denied for table settings' } });
        const res = await call({ target: 'manifest' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ name: 'Operations Terminal', short_name: 'Operations T', theme_color: '#0f172a', description: 'Secure Operations Dashboard' });
        expect(res.body.icons).toEqual(DEFAULT_ICONS);
        expect(JSON.stringify(res.body)).not.toContain('permission denied');
        expect(queryLog.warn).toHaveBeenCalledWith('manifest settings query failed', { message: 'permission denied for table settings' });
    });

    it('a throwing settings read still returns the default manifest', async () => {
        sb.tables.settings = () => { throw new Error('ECONNREFUSED'); };
        const res = await call({ target: 'manifest' });
        expect(res.statusCode).toBe(200);
        expect(res.body.name).toBe('Operations Terminal');
        expect(res.body.icons).toEqual(DEFAULT_ICONS);
        expect(queryLog.warn).toHaveBeenCalledWith('manifest settings fetch failed', expect.objectContaining({ err: expect.any(Error) }));
    });

    it('a malformed stored icon (non-string) cannot break the route — absolute fallback to the default manifest', async () => {
        withSettings({ name: 'Org' }, { pwaIconUrl: 42 });
        const res = await call({ target: 'manifest' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Type']).toBe('application/manifest+json');
        expect(res.body.name).toBe('Operations Terminal');
        expect(res.body.icons).toEqual(DEFAULT_ICONS);
        expect(queryLog.error).toHaveBeenCalledWith('manifest critical failure, returning default manifest', expect.objectContaining({ err: expect.any(TypeError) }));
    });
});

// ───────────────────────────── initial-state: needs setup ─────────────────────────────
describe('target=initial-state — first boot (no Admin yet)', () => {
    const NEEDS_SETUP_KEYS = ['brandingConfig', 'config', 'discordConfig', 'needsSetup', 'setupCompleted', 'themeConfig'];

    it('no Admin system role → the setup payload: projections only, never the session or org state', async () => {
        sb.tables.roles = () => ({ data: null, error: null });
        const res = await initialState({ bearer: tokenFor(6) });
        expect(res.statusCode).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(NEEDS_SETUP_KEYS);
        expect(res.body.needsSetup).toBe(true);
        expect(res.body.setupCompleted).toBe(true);
        expect(res.body.config).toEqual({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', supabaseAnonKey: FAKE_PUBLISHABLE });
        // Only the OAuth client id — not channel ids, never the bot token.
        expect(res.body.discordConfig).toEqual({ clientId: 'db-client-id' });
        // Name + icon only — login styling / ToS ship post-auth.
        expect(res.body.brandingConfig).toEqual({ name: 'Acme Org', iconUrl: '/acme.svg' });
        // Allowlist rebuild + canonical accent.
        expect(res.body.themeConfig).toEqual({ enabled: true, accent: '#aabbcc' });
        // No Admin role → the users count is never even issued, and the token is ignored.
        expect(sb.queries.map((q) => q.table)).toEqual(['roles']);
        expect(dbFns.getUserById).not.toHaveBeenCalled();
        expect(dbFns.getState).not.toHaveBeenCalled();
        expect(dbFns.getAllSettings).toHaveBeenCalledWith({ decryptSecrets: false });
    });

    it('counts only LIVE, non-pending holders of the Admin role — zero of them is still first boot', async () => {
        sb.tables.users = () => ({ count: 0, error: null });
        const res = await initialState();
        expect(res.body.needsSetup).toBe(true);
        const usersQuery = sb.queries.find((q) => q.table === 'users')!;
        expect(usersQuery.calls).toEqual([
            ['select', ['id', { count: 'exact', head: true }]],
            ['eq', ['role_id', 4]],
            ['is', ['deleted_at', null]],
            ['not', ['discord_id', 'ilike', 'pending_%']],
        ]);
        const rolesQuery = sb.queries.find((q) => q.table === 'roles')!;
        expect(rolesQuery.calls).toContainEqual(['eq', ['is_system', true]]);
    });

    it('a null count is treated as zero', async () => {
        sb.tables.users = () => ({ count: null, error: null });
        const res = await initialState();
        expect(res.body.needsSetup).toBe(true);
    });

    it('a throwing admin probe (db down / fresh install) drops to the setup screen, logged', async () => {
        sb.tables.roles = () => { throw new Error('ENOTFOUND db'); };
        const res = await initialState();
        expect(res.body.needsSetup).toBe(true);
        expect(dbFns.getUserById).not.toHaveBeenCalled();
        expect(queryLog.warn).toHaveBeenCalledWith('admin check exception (likely db connection)', expect.objectContaining({ err: expect.any(Error) }));
    });

    it('a settings read fault falls back to the default branding; a setup-flag fault reads as not completed', async () => {
        sb.tables.roles = () => ({ data: null, error: null });
        dbFns.getAllSettings.mockRejectedValue(new Error('boom'));
        dbFns.isSetupCompleted.mockRejectedValue(new Error('boom'));
        vi.stubEnv('DISCORD_CLIENT_ID', 'env-client-id');
        const res = await initialState();
        expect(res.statusCode).toBe(200);
        expect(res.body.setupCompleted).toBe(false);
        expect(res.body.brandingConfig).toEqual({ name: 'Organization', iconUrl: '/icon.svg' });
        expect(res.body.discordConfig).toEqual({ clientId: 'env-client-id' });
        expect(res.body.themeConfig).toEqual({ enabled: false });
    });

    it('non-string branding fields and an absent branding blob project to safe defaults', async () => {
        sb.tables.roles = () => ({ data: null, error: null });
        dbFns.getAllSettings.mockResolvedValueOnce({ brandingConfig: { name: 7, iconUrl: { evil: true } } });
        let res = await initialState();
        expect(res.body.brandingConfig).toEqual({ name: 'Organization', iconUrl: '/icon.svg' });
        expect(res.body.discordConfig).toEqual({ clientId: undefined });
        dbFns.getAllSettings.mockResolvedValueOnce({});
        res = await initialState();
        expect(res.body.brandingConfig).toEqual({ name: 'Organization', iconUrl: '/icon.svg' });
    });

    it('omits (not nulls) a refused anon key so the app still boots without realtime', async () => {
        sb.tables.roles = () => ({ data: null, error: null });
        vi.stubEnv('SUPABASE_ANON_KEY', FAKE_SECRET);
        const res = await initialState();
        expect(res.body.config).toEqual({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co' });
        expect(JSON.stringify(res.body)).not.toContain(FAKE_SECRET);
    });
});

// ───────────────────────────── initial-state: logged out ─────────────────────────────
describe('target=initial-state — logged-out boot', () => {
    const LOGGED_OUT_KEYS = ['brandingConfig', 'config', 'discordConfig', 'platformSettings', 'setupCompleted', 'themeConfig'];

    function expectLoggedOut(res: ReturnType<typeof mockRes>) {
        expect(res.statusCode).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(LOGGED_OUT_KEYS);
        expect(res.body.currentUser).toBeUndefined();
        expect(res.body.realtimeToken).toBeUndefined();
        expect(dbFns.getState).not.toHaveBeenCalled();
    }

    it('no credential → login-screen projections only; maintenance fields survive, force_logout_timestamp does not', async () => {
        vi.stubEnv('DISCORD_CLIENT_ID', 'env-client-id');
        dbFns.getPlatformSettings.mockResolvedValue({ maintenance_mode: true, maintenance_message: 'Back soon', force_logout_timestamp: isoAgo(HOUR), support_discord_url: 'https://discord.gg/x' });
        const res = await initialState();
        expectLoggedOut(res);
        expect(res.body.platformSettings).toEqual({ maintenance_mode: true, maintenance_message: 'Back soon' });
        expect(res.body.discordConfig).toEqual({ clientId: 'env-client-id' });
        expect(res.body.brandingConfig).toEqual({ name: 'Acme Org', iconUrl: '/acme.svg' });
        expect(JSON.stringify(res.body)).not.toContain('BOT-TOKEN-SECRET');
        expect(JSON.stringify(res.body)).not.toContain('maxShareableClearance');
        expect(dbFns.getUserById).not.toHaveBeenCalled();
    });

    it('maintenance never blocks the boot call itself (the app must render the maintenance screen)', async () => {
        dbFns.getPlatformSettings.mockResolvedValue({ maintenance_mode: true });
        const res = await initialState();
        expect(res.statusCode).toBe(200);
        expect(res.body.platformSettings).toEqual({ maintenance_mode: true, maintenance_message: null });
    });

    it('a router settings fault keeps the initial-state exemption: warned, not refused, and the boot still renders', async () => {
        // The router's read fails closed for target=state; initial-state is exempt from
        // both gates it drives, so a fault there must not stop the app booting.
        dbFns.getPlatformSettings.mockRejectedValueOnce(new Error('router read fault')).mockResolvedValue({ maintenance_mode: true });
        const res = await initialState();
        expectLoggedOut(res);
        expect(res.body.platformSettings).toEqual({ maintenance_mode: true, maintenance_message: null });
        expect(queryLog.warn).toHaveBeenCalledWith('failed to check platform enforcement', expect.objectContaining({ err: expect.any(Error) }));
        expect(queryLog.error).not.toHaveBeenCalledWith('failed to check platform enforcement; refusing', expect.anything());
    });

    it('null platform settings and a settings read fault both degrade to safe defaults', async () => {
        dbFns.getPlatformSettings.mockResolvedValue(null);
        dbFns.getAllSettings.mockRejectedValue(new Error('down'));
        const res = await initialState();
        expectLoggedOut(res);
        expect(res.body.platformSettings).toEqual({ maintenance_mode: false, maintenance_message: null });
        expect(res.body.brandingConfig).toEqual({ name: 'Organization', iconUrl: '/icon.svg' });
        expect(res.body.discordConfig).toEqual({ clientId: undefined });
        expect(queryLog.warn).toHaveBeenCalledWith('failed to fetch boot settings, using defaults', expect.objectContaining({ err: expect.any(Error) }));
    });

    it('a forged signature, an expired token and a bare "Bearer" header all boot logged-out without loading a user', async () => {
        const good = tokenFor(6);
        const forged = good.slice(0, -2) + (good.endsWith('00') ? '11' : '00');
        for (const opts of [{ bearer: forged }, { bearer: tokenFor(6, 25 * HOUR) }, { authorization: 'Bearer' }]) {
            const res = await initialState(opts);
            expectLoggedOut(res);
        }
        expect(dbFns.getUserById).not.toHaveBeenCalled();
    });

    it('a deleted user (null row) and a user-read fault both boot logged-out', async () => {
        users = {};
        expectLoggedOut(await initialState({ bearer: tokenFor(6) }));
        dbFns.getUserById.mockRejectedValue(new Error('read fault'));
        expectLoggedOut(await initialState({ bearer: tokenFor(6) }));
        expect(queryLog.error).toHaveBeenCalledWith('failed to fetch current user', expect.objectContaining({ err: expect.any(Error) }));
    });

    it('a token issued before the user\'s tokens_valid_from watermark boots logged-out (no realtime token minted)', async () => {
        users[6].tokensValidFrom = isoAgo(30 * 60 * 1000);
        const res = await initialState({ bearer: tokenFor(6, HOUR) });
        expectLoggedOut(res);
        expect(dbFns.getBanNotice).not.toHaveBeenCalled();
    });

    it('fails closed when the force-logout check itself faults: no user load, logged-out payload', async () => {
        dbFns.getPlatformSettings
            .mockResolvedValueOnce({})                                  // router enforcement
            .mockRejectedValueOnce(new Error('settings unavailable'))   // boot revocation check
            .mockResolvedValueOnce({});                                 // logged-out projection
        const res = await initialState({ bearer: tokenFor(6) });
        expectLoggedOut(res);
        expect(dbFns.getUserById).not.toHaveBeenCalled();
        expect(queryLog.warn).toHaveBeenCalledWith('failed to check force-logout on initial-state', expect.objectContaining({ err: expect.any(Error) }));
    });
});

// ───────────────────────────── initial-state: revoked / banned ─────────────────────────────
describe('target=initial-state — force-logout and org ban', () => {
    it('a token issued before force_logout_timestamp gets 401 + a cleared cookie, before any user load', async () => {
        dbFns.getPlatformSettings.mockResolvedValue({ force_logout_timestamp: isoAgo(30 * 60 * 1000) });
        const res = await initialState({ cookie: `${COOKIE_NAME}=${tokenFor(6, HOUR)}` });
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ message: 'Session expired. Please log in again.', force_logout: true });
        expect(setCookieOf(res)).toContain(`${COOKIE_NAME}=;`);
        expect(setCookieOf(res)).toContain('Max-Age=0');
        expect(dbFns.getUserById).not.toHaveBeenCalled();
        expect(dbFns.getState).not.toHaveBeenCalled();
    });

    it('a token issued AFTER the force-logout boots normally', async () => {
        dbFns.getPlatformSettings.mockResolvedValue({ force_logout_timestamp: isoAgo(2 * HOUR) });
        const res = await initialState({ bearer: tokenFor(6, HOUR) });
        expect(res.statusCode).toBe(200);
        expect(res.body.currentUser.id).toBe(6);
    });

    it('a banned member gets the logged-out shape plus THEIR ban notice — never org state', async () => {
        const notice = { reason: 'Griefing', bannedAt: '2026-10-01T00:00:00Z', appealable: true };
        dbFns.getBanNotice.mockResolvedValue(notice);
        const res = await initialState({ bearer: tokenFor(6) });
        expect(res.statusCode).toBe(200);
        expect(res.body.banNotice).toEqual(notice);
        expect(res.body.currentUser).toBeUndefined();
        expect(res.body.realtimeToken).toBeUndefined();
        expect(dbFns.getBanNotice).toHaveBeenCalledWith(6, 'd6');
        expect(dbFns.getState).not.toHaveBeenCalled();
    });

    it('a ban-check fault boots logged-out WITHOUT an accusation', async () => {
        dbFns.getBanNotice.mockRejectedValue(new Error('bans table unavailable'));
        const res = await initialState({ bearer: tokenFor(6) });
        expect(res.statusCode).toBe(200);
        expect(res.body.banNotice).toBeUndefined();
        expect(res.body.currentUser).toBeUndefined();
        expect(dbFns.getState).not.toHaveBeenCalled();
        expect(queryLog.warn).toHaveBeenCalledWith('ban check failed on initial-state; booting logged-out', expect.objectContaining({ userId: 6 }));
    });
});

// ───────────────────────────── initial-state: logged in ─────────────────────────────
describe('target=initial-state — authenticated boot', () => {
    it('ships full state with the self record self-stripped, the roster viewer-stripped and secrets removed', async () => {
        dbFns.getState.mockResolvedValue({
            users: [{ ...MEMBER }, { ...OTHER }],
            discordConfig: { clientId: 'db-client-id', newRequestChannelId: '111111111111111111', botToken: 'BOT-TOKEN-SECRET' },
            radioConfig: { apiKey: 'lk-key', apiSecret: 'lk-secret', url: 'wss://lk', enabled: true },
            geminiKey: 'raw-gemini', admin_setup_code: { code: 'SETUP-DEADBEEF' }, partner_api_key: 'sk-live',
        });
        dbFns.getPlatformSettings.mockResolvedValue({ maintenance_mode: false, force_logout_timestamp: isoAgo(48 * HOUR), internal_flag: 'x' });
        const res = await initialState({ bearer: tokenFor(6) });
        expect(res.statusCode).toBe(200);
        expect(res.body.needsSetup).toBe(false);
        expect(res.body.setupCompleted).toBe(true);
        expect(res.body.config.supabaseAnonKey).toBe(FAKE_PUBLISHABLE);
        expect(dbFns.getState).toHaveBeenCalledWith(expect.objectContaining({ id: 6 }));

        // Self: own notes kept, admin-only notes and the server-internal identity flag dropped.
        expect(res.body.currentUser.id).toBe(6);
        expect(res.body.currentUser.personnelNotes).toBe('my own notes');
        expect(res.body.currentUser.adminNotes).toBeUndefined();
        expect(res.body.currentUser.isSystemAdmin).toBeUndefined();
        // Roster: another member's private fields never reach a rank-and-file viewer.
        const other = res.body.users.find((u: { id: number }) => u.id === 7);
        expect(other.adminNotes).toBeUndefined();
        expect(other.personnelNotes).toBeUndefined();
        expect(other.auth_user_id).toBeUndefined();
        expect(other.jobTitle).toBeUndefined();
        expect(other.name).toBe('Other');

        // Secrets.
        expect(res.body.geminiKey).toBeUndefined();
        expect(res.body.admin_setup_code).toBeUndefined();
        expect(res.body.partner_api_key).toBeUndefined();
        expect(res.body.radioConfig).toEqual({ enabled: true, configured: true });
        expect(res.body.discordConfig).toEqual(expect.objectContaining({ clientId: 'db-client-id', newRequestChannelId: '111111111111111111' }));
        expect(res.body.discordConfig.botToken).toBeUndefined();
        // Authenticated platform settings keep the force-logout watermark, drop unknown keys.
        expect(res.body.platformSettings).toEqual({ maintenance_mode: false, force_logout_timestamp: expect.any(String) });
    });

    it('mints a genuine realtime JWT for exactly this user when SUPABASE_JWT_SECRET is set', async () => {
        const res = await initialState({ bearer: tokenFor(6) });
        const [hdr, payload, sig] = res.body.realtimeToken.split('.');
        expect(createHmac('sha256', RT_SECRET).update(`${hdr}.${payload}`).digest('base64url')).toBe(sig);
        expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ role: 'authenticated', user_id: 6 });
    });

    it('realtime stays off (null token) when SUPABASE_JWT_SECRET is unset — the boot still succeeds', async () => {
        vi.stubEnv('SUPABASE_JWT_SECRET', '');
        const res = await initialState({ bearer: tokenFor(6) });
        expect(res.statusCode).toBe(200);
        expect(res.body.realtimeToken).toBeNull();
        expect(res.body.currentUser.id).toBe(6);
    });

    it('DISCORD_CLIENT_ID in the environment wins over the stored client id', async () => {
        vi.stubEnv('DISCORD_CLIENT_ID', 'env-client-id');
        const res = await initialState({ bearer: tokenFor(6) });
        expect(res.body.discordConfig.clientId).toBe('env-client-id');
    });

    it('the session cookie is preferred over the Authorization header', async () => {
        users[5] = { ...OTHER, id: 5, name: 'HeaderUser' };
        const res = await initialState({ cookie: `other=1; ${COOKIE_NAME}=${tokenFor(6)}`, bearer: tokenFor(5) });
        expect(res.body.currentUser.id).toBe(6);
        expect(dbFns.getUserById).toHaveBeenCalledWith(6);
        expect(dbFns.getUserById).not.toHaveBeenCalledWith(5);
    });

    it('a malformed session cookie is discarded and the header credential still works', async () => {
        const res = await initialState({ cookie: `${COOKIE_NAME}=not-a-token`, bearer: tokenFor(6) });
        expect(res.body.currentUser.id).toBe(6);
    });

    it('signs wiki-home media (long-lived) only for a wiki:view holder', async () => {
        const welcome = { type: 'doc', content: [] };
        dbFns.getState.mockImplementation(async () => ({ users: [], wikiHomeConfig: { welcomeContent: welcome } }));

        let res = await initialState({ bearer: tokenFor(6) });
        expect(signDoc).not.toHaveBeenCalled();
        expect(res.body.wikiHomeConfig.welcomeContent).toEqual(welcome);

        users[6].permissions = ['wiki:view'];
        res = await initialState({ bearer: tokenFor(6) });
        expect(signDoc).toHaveBeenCalledWith(welcome, { longLived: true });
        expect(res.body.wikiHomeConfig.welcomeContent).toEqual({ signed: true, longLived: true, doc: welcome });
    });

    it('a full-state fault returns the minimal 200 fallback: self still stripped, no internals', async () => {
        dbFns.getState.mockRejectedValue(new Error('canceling statement due to statement timeout on users_pkey'));
        const res = await initialState({ bearer: tokenFor(6) });
        expect(res.statusCode).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['config', 'currentUser', 'error', 'needsSetup', 'setupCompleted']);
        expect(res.body.error).toBe('Database Connection Error');
        expect(res.body.currentUser.id).toBe(6);
        expect(res.body.currentUser.adminNotes).toBeUndefined();
        expect(res.body.currentUser.isSystemAdmin).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toContain('statement timeout');
        expect(queryLog.error).toHaveBeenCalledWith('failed to fetch full state', expect.objectContaining({ err: expect.any(Error) }));
    });
});

// ───────────────────────────── target=feed ─────────────────────────────
describe('target=feed (API-key surface)', () => {
    const FEED = { reports: [{ id: 'r1' }, { id: 'r2' }], warrants: [{ id: 'w1' }], bulletins: [], _meta: { maxShareableLevel: 2, fetchedAt: '2026-11-01T00:00:00.000Z' } };
    async function feed(apiKey?: string, since?: unknown) {
        const res = mockRes();
        const query = { target: 'feed', ...(since !== undefined ? { since } : {}) };
        await handler({ method: 'GET', query, headers: apiKey ? { 'x-api-key': apiKey } : {} } as never, res as never);
        return res;
    }

    beforeEach(() => {
        dbFns.verifyApiKey.mockResolvedValue({ id: 1, label: 'partner', scopes: ['feed'] });
        dbFns.getPublicFeedData.mockResolvedValue(FEED);
    });

    it('401s a request with no API key, before any key lookup', async () => {
        const res = await feed();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ message: 'Missing API Key' });
        expect(dbFns.verifyApiKey).not.toHaveBeenCalled();
    });

    it('403s an unknown key', async () => {
        dbFns.verifyApiKey.mockResolvedValue(null);
        const res = await feed('k-bad');
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ message: 'Invalid API Key' });
        expect(dbFns.verifyApiKey).toHaveBeenCalledWith('k-bad');
        expect(dbFns.getPublicFeedData).not.toHaveBeenCalled();
    });

    it('refuses an alliance-labelled key (it must use the per-peer alliance channel)', async () => {
        dbFns.verifyApiKey.mockResolvedValue({ id: 2, label: 'alliance:peer-9', scopes: ['feed'] });
        const res = await feed('k-ally');
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ message: 'Use the alliance data channel for this key' });
        expect(dbFns.getPublicFeedData).not.toHaveBeenCalled();
    });

    it.each([
        ['scoped only for alliance', ['alliance']],
        ['scoped to nothing', []],
        ['a malformed (string) scope', 'feed'],
    ])('refuses a key %s', async (_l, scopes) => {
        dbFns.verifyApiKey.mockResolvedValue({ id: 3, label: 'partner', scopes });
        const res = await feed('k');
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ message: 'This key is not scoped for the intel feed' });
        expect(dbFns.getPublicFeedData).not.toHaveBeenCalled();
    });

    it('serves a grandfathered pre-scopes key, mirroring _meta.fetchedAt (never the wall clock)', async () => {
        dbFns.verifyApiKey.mockResolvedValue({ id: 4, label: 'legacy', scopes: null });
        const res = await feed('k-legacy');
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            countReports: 2, countWarrants: 1, countBulletins: 0, fetchedAt: '2026-11-01T00:00:00.000Z',
            reports: FEED.reports, warrants: FEED.warrants, bulletins: [], _meta: FEED._meta,
        });
        expect(dbFns.getPublicFeedData).toHaveBeenCalledWith(undefined);
    });

    it('normalises a valid cursor before it reaches the query; a repeated cursor serves from the beginning', async () => {
        const since = new Date(Date.now() - HOUR);
        await feed('k', `  ${since.toISOString()}  `);
        expect(dbFns.getPublicFeedData).toHaveBeenLastCalledWith(since.toISOString());
        await feed('k', ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z']);
        expect(dbFns.getPublicFeedData).toHaveBeenLastCalledWith(undefined);
    });

    it.each([
        ['malformed', 'yesterday-ish'],
        ['future', new Date(Date.now() + 24 * HOUR).toISOString()],
    ])('400s a %s cursor instead of serving a page the peer would skip past', async (reason, since) => {
        const res = await feed('k', since);
        expect(res.statusCode).toBe(400);
        expect(typeof res.body.message).toBe('string');
        expect(dbFns.getPublicFeedData).not.toHaveBeenCalled();
        expect(queryLog.warn).toHaveBeenCalledWith('feed cursor rejected', { reason });
    });

    it('a key-lookup fault is an opaque 500', async () => {
        dbFns.verifyApiKey.mockRejectedValue(new Error('column api_keys.scopes does not exist'));
        const res = await feed('k');
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ message: 'Internal Error' });
        expect(queryLog.error).toHaveBeenCalledWith('feed error', expect.objectContaining({ err: expect.any(Error) }));
    });
});

// ───────────────────────────── stripSecrets (direct) ─────────────────────────────
describe('stripSecrets — remaining branches', () => {
    it('passes null / undefined through untouched', () => {
        expect(stripSecrets(null)).toBeNull();
        expect(stripSecrets(undefined)).toBeUndefined();
    });

    it('scrubs every key-material / handshake field off any alliance peer row, keeping the rest', () => {
        const out = stripSecrets({
            alliancePeers: [{
                id: 'p1', name: 'Ally', status: 'active',
                outbound_key_enc: 'a', outboundKeyEnc: 'b', inbound_key_id: 'c', inboundKeyId: 'd',
                entered_peer_code_enc: 'e', enteredPeerCodeEnc: 'f', handshake_nonce: 'g', handshakeNonce: 'h',
            }],
            allianceLocalPairingCode: 'PAIR-123',
        });
        expect(out.alliancePeers).toEqual([{ id: 'p1', name: 'Ally', status: 'active' }]);
        expect(out.allianceLocalPairingCode).toBeUndefined();
    });

    it('rebuilds publicPageConfig from its allowlist, coercing wrong-typed fields to safe empties', () => {
        const out = stripSecrets({
            publicPageConfig: { enabled: 1, motto: 5, blurb: null, heroImageUrl: {}, profileImageUrl: [], links: 'x', featuredTestimonialIds: 'y', moderationFlag: 'internal' },
        });
        expect(out.publicPageConfig).toEqual({
            enabled: true, motto: '', blurb: '', heroImageUrl: '', profileImageUrl: '',
            modules: { stats: false, testimonials: false, services: false, links: false },
            links: [], featuredTestimonialIds: [],
        });
    });

    it('keeps well-typed public fields through the allowlist rebuilds', () => {
        const out = stripSecrets({
            publicPageConfig: { enabled: true, motto: 'M', blurb: 'B', heroImageUrl: '/h.png', profileImageUrl: '/p.png', modules: { stats: true, links: true }, links: [{ url: 'https://x' }], featuredTestimonialIds: ['t1'] },
            platformSettings: { maintenance_mode: true, maintenance_message: 'm', support_discord_url: 'https://discord.gg/x', force_logout_timestamp: '2026-01-01T00:00:00.000Z' },
            aiConfig: { enabled: 1, model: 'gemini-pro', apiKey: 'k' },
        });
        expect(out.publicPageConfig).toEqual({
            enabled: true, motto: 'M', blurb: 'B', heroImageUrl: '/h.png', profileImageUrl: '/p.png',
            modules: { stats: true, testimonials: false, services: false, links: true },
            links: [{ url: 'https://x' }], featuredTestimonialIds: ['t1'],
        });
        expect(out.platformSettings).toEqual({ maintenance_mode: true, maintenance_message: 'm', support_discord_url: 'https://discord.gg/x', force_logout_timestamp: '2026-01-01T00:00:00.000Z' });
        expect(out.aiConfig).toEqual({ enabled: true, model: 'gemini-pro' });
    });

    it('rebuilds platformSettings: a non-string message becomes null, unknown keys drop', () => {
        const out = stripSecrets({ platformSettings: { maintenance_mode: 'yes', maintenance_message: 42, support_discord_url: 7, ops_secret_hint: 'x' } });
        expect(out.platformSettings).toEqual({ maintenance_mode: false, maintenance_message: null });
    });

    it('drops secret-named string AND number values at any depth, including inside arrays, without deleting containers', () => {
        const out = stripSecrets({
            integrations: [{ name: 'n1', partner_api_key: 'sk-1' }, { name: 'n2', nested: { pin_password: 1234, smtp_token: 'tok', keep: 'k' } }],
            billing_webhook: { url: 'kept-because-object' },
        });
        expect(out.integrations).toEqual([{ name: 'n1' }, { name: 'n2', nested: { keep: 'k' } }]);
        expect(out.billing_webhook).toEqual({ url: 'kept-because-object' });
    });
});
