import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// =============================================================================
// api/services.ts — the RPC dispatcher, exercised end to end through the REAL
// handler with the REAL session-token code (lib/auth), the REAL rate limiters,
// the REAL OAuth-state cookie helpers and the REAL session-cookie helpers. Only
// the database barrel and the logger are doubled, and individual action handlers
// are spied so each test can see exactly what the gate chain let through and
// with which payload.
//
// Gate order under test (top to bottom of handler()):
//   405 method → auth:* per-IP limit → maintenance / force-logout →
//   OAuth state cookie → PUBLIC_ACTIONS → token verify → user load →
//   tokens_valid_from watermark → org ban → payload injection + actor-field
//   overwrite → own-property check → client tier → optional feature →
//   BOLA / permission map (+ inline ownership bypasses) → per-user limit →
//   dispatch (SecurityDenial vs opaque vs business error).
// =============================================================================

const h = vi.hoisted(() => {
    // A dedicated, strong, fixed signing key so real tokens can be minted and verified.
    process.env.JWT_SECRET = 'cov-services-dispatcher-secret-0123456789abcdef';
    type LogCall = { level: string; msg: string; fields?: Record<string, unknown> };
    const logs: LogCall[] = [];
    const logStub: Record<string, unknown> = {};
    for (const level of ['debug', 'info', 'warn', 'error']) {
        logStub[level] = (msg: string, fields?: Record<string, unknown>) => { logs.push({ level, msg, fields }); };
    }
    logStub.child = () => logStub;
    return {
        logs,
        logStub,
        rows: {} as Record<string, Record<string, unknown> | null>,
        sbCalls: [] as Array<{ table: string; ops: unknown[][] }>,
        // Database doubles, re-created per test in beforeEach.
        spy: {} as Record<string, Mock<(...args: any[]) => any>>,
    };
});

function sbFrom(table: string) {
    const rec = { table, ops: [] as unknown[][] };
    h.sbCalls.push(rec);
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'update', 'delete', 'insert', 'maybeSingle']) {
        b[m] = (...args: unknown[]) => { rec.ops.push([m, ...args]); return b; };
    }
    b.single = async () => ({ data: h.rows[table] ?? null, error: null });
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return b;
}

vi.mock('../lib/log', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../lib/log')>();
    return { ...orig, log: h.logStub };
});

vi.mock('../lib/db', () => ({
    supabase: { from: (t: string) => sbFrom(t) },
    getPlatformSettings: () => h.spy.getPlatformSettings(),
    getUserById: (id: number) => h.spy.getUserById(id),
    findActiveBan: (q: unknown) => h.spy.findActiveBan(q),
    resolveIsSystemAdminFresh: (roleId: unknown) => h.spy.resolveIsSystemAdminFresh(roleId),
    getFullOperationDetails: (id: unknown) => h.spy.getFullOperationDetails(id),
    getPublicSettings: () => h.spy.getPublicSettings(),
    recordSecurityEvent: (e: unknown) => h.spy.recordSecurityEvent(e),
    isClientCaller: (u: unknown) => h.spy.isClientCaller(u),
    isOptionalFeatureEnabled: (f: string) => h.spy.isOptionalFeatureEnabled(f),
}));

import handler, {
    actions,
    fullPermissionMap,
    PUBLIC_ACTIONS,
    PROTECTED_PREFIXES,
    OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS,
    OPTIONAL_FEATURE_NAMESPACES,
    ACTOR_ID_FIELDS,
    validatePermissionMap,
} from '../api/services';
import { CLIENT_DENIED_MESSAGE } from '../lib/clientNamespaces';
import { signToken, signAdminSetupGrant, signIdentityGrant } from '../lib/auth';
import { _resetAuthRateLimit } from '../lib/authRateLimit';
import { checkUserRateLimit, USER_PER_MINUTE, __resetUserRateLimitForTest } from '../lib/userRateLimit';
import { SESSION_COOKIE_IS_SECURE, buildSessionCookie, clearSessionCookie, sessionCookieName } from '../lib/sessionCookie';
import { buildOAuthStateCookie, clearOAuthStateCookie } from '../lib/oauthStateCookie';
import { SecurityDenial } from '../lib/errors';

// ---------------------------------------------------------------------------
// req / res doubles
// ---------------------------------------------------------------------------
type Res = {
    statusCode: number;
    body: any;
    headers: Record<string, string>;
    cookies: string[];
    status: (c: number) => Res;
    json: (b: unknown) => Res;
    setHeader: (k: string, v: string) => Res;
    append: (k: string, v: string) => Res;
};
function mockRes(): Res {
    const res = { statusCode: 0, body: undefined, headers: {}, cookies: [] } as unknown as Res;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    res.append = (k: string, v: string) => { if (k === 'Set-Cookie') res.cookies.push(v); return res; };
    return res;
}

interface ReqOpts {
    token?: string | null;
    authorization?: string;
    cookie?: string;
    ip?: string | undefined;
    secure?: boolean;
    proto?: string;
    method?: string;
    noPayload?: boolean;
}
const DEFAULT_IP = '198.51.100.20';
function mkReq(action: unknown, payload: unknown, opts: ReqOpts = {}) {
    const headers: Record<string, string> = {};
    if (opts.authorization !== undefined) headers.authorization = opts.authorization;
    else if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.proto) headers['x-forwarded-proto'] = opts.proto;
    return {
        method: opts.method ?? 'POST',
        secure: opts.secure ?? false,
        ip: 'ip' in opts ? opts.ip : DEFAULT_IP,
        query: {},
        headers,
        body: opts.noPayload ? { action } : { action, payload },
    } as any;
}
async function call(action: unknown, payload: unknown = {}, opts: ReqOpts = {}) {
    const res = mockRes();
    await handler(mkReq(action, payload, opts), res as unknown as import('express').Response);
    return res;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
type U = Record<string, unknown> & { id: number };
let users: Record<number, U> = {};
function member(id: number, permissions: string[] = [], extra: Record<string, unknown> = {}): U {
    return { id, discordId: `d-${id}`, rsiHandle: `Handle${id}`, role: 'Member', roleId: 3, permissions, tokensValidFrom: null, ...extra };
}
function as(u: U) {
    users[u.id] = u;
    return signToken({ userId: u.id });
}
/** Spy a registered action and capture the payload/token it was dispatched with. */
function stub(name: string, impl?: (payload: any, token?: string) => Promise<unknown>) {
    return vi.spyOn(actions, name).mockImplementation(impl ?? (async () => ({ ok: name })));
}
const auditEvents = () => h.spy.recordSecurityEvent.mock.calls.map((c) => (c[0] as { event: string }).event);
const lastAudit = () => h.spy.recordSecurityEvent.mock.calls.at(-1)?.[0] as Record<string, any>;
const logged = (level: string, msg: string) => h.logs.filter((l) => l.level === level && l.msg === msg);

const NONCE = 'n0nce_ABCDEFGHIJKLMNOP-1234';
const SESSION_CLEAR = clearSessionCookie(SESSION_COOKIE_IS_SECURE);

beforeEach(() => {
    users = {};
    h.rows = {};
    h.sbCalls.length = 0;
    h.logs.length = 0;
    h.spy.getPlatformSettings = vi.fn(async () => ({}));
    h.spy.getUserById = vi.fn(async (id: number) => users[id] ?? null);
    h.spy.findActiveBan = vi.fn(async () => null);
    h.spy.resolveIsSystemAdminFresh = vi.fn(async () => false);
    h.spy.getFullOperationDetails = vi.fn(async () => null);
    h.spy.getPublicSettings = vi.fn(async () => ({ publicPageConfig: { featuredTestimonialIds: [] } }));
    h.spy.recordSecurityEvent = vi.fn(async () => undefined);
    h.spy.isClientCaller = vi.fn(async () => false);
    h.spy.isOptionalFeatureEnabled = vi.fn(async () => true);
    _resetAuthRateLimit();
    __resetUserRateLimitForTest();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe('method gate', () => {
    it('refuses anything but POST with 405 before touching the database', async () => {
        const res = await call('user:update_preferences', {}, { method: 'GET' });
        expect(res.statusCode).toBe(405);
        expect(res.body).toEqual({ message: 'Method not allowed' });
        expect(h.spy.getPlatformSettings).not.toHaveBeenCalled();
        expect(h.spy.getUserById).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('auth:* per-IP rate limit', () => {
    it('admits 10 auth attempts per IP per window and 429s the 11th with Retry-After, audited by IP only', async () => {
        for (let i = 0; i < 10; i++) {
            const ok = await call('auth:begin_oauth', { nonce: NONCE });
            expect(ok.statusCode).toBe(200);
        }
        const res = await call('auth:begin_oauth', { nonce: NONCE });
        expect(res.statusCode).toBe(429);
        expect(res.body).toMatchObject({ success: false, code: 'AUTH_RATE_LIMITED' });
        expect(res.body.retryAfter).toBeGreaterThanOrEqual(1);
        expect(res.headers['Retry-After']).toBe(String(res.body.retryAfter));
        // The refused attempt mints no OAuth-state cookie.
        expect(res.headers['Set-Cookie']).toBeUndefined();
        expect(lastAudit()).toMatchObject({
            event: 'auth.rate_limited',
            action: 'auth:begin_oauth',
            actorUserId: null,
            actorLabel: null,
            actorIp: DEFAULT_IP,
            details: { retryAfter: res.body.retryAfter },
        });
    });

    it('keys on the client IP: another address keeps its own budget', async () => {
        for (let i = 0; i < 11; i++) await call('auth:begin_oauth', { nonce: NONCE });
        expect((await call('auth:begin_oauth', { nonce: NONCE })).statusCode).toBe(429);
        expect((await call('auth:begin_oauth', { nonce: NONCE }, { ip: '203.0.113.99' })).statusCode).toBe(200);
    });

    it('shares one bucket across every auth:* action, so alternating callbacks cannot evade it', async () => {
        const cb = stub('auth:discord_callback');
        for (let i = 0; i < 10; i++) await call('auth:begin_oauth', { nonce: NONCE });
        const res = await call('auth:discord_callback', { state: `login:${NONCE}` }, { cookie: `oauth_state=${NONCE}` });
        expect(res.statusCode).toBe(429);
        expect(cb).not.toHaveBeenCalled();
    });

    it('does not count or block non-auth actions from an exhausted IP', async () => {
        for (let i = 0; i < 11; i++) await call('auth:begin_oauth', { nonce: NONCE });
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(200);
        expect(prefs).toHaveBeenCalledTimes(1);
    });

    it('fails open when the caller has no resolvable IP (the global limiter still applies upstream)', async () => {
        for (let i = 0; i < 15; i++) {
            expect((await call('auth:begin_oauth', { nonce: NONCE }, { ip: undefined })).statusCode).toBe(200);
        }
    });
});

// ---------------------------------------------------------------------------
describe('maintenance mode', () => {
    beforeEach(() => { h.spy.getPlatformSettings.mockImplementation(async () => ({ maintenance_mode: true })); });

    it('503s a signed-in non-Admin and never dispatches', async () => {
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(503);
        expect(res.body.message).toMatch(/maintenance/i);
        expect(prefs).not.toHaveBeenCalled();
    });

    it('runs ABOVE authentication: no token gets the 503, not a 401', async () => {
        const res = await call('user:update_preferences', {});
        expect(res.statusCode).toBe(503);
    });

    it('a token that does not verify is not an Admin (503) and never loads a user', async () => {
        const res = await call('user:update_preferences', {}, { token: 'forged.deadbeef' });
        expect(res.statusCode).toBe(503);
        expect(h.spy.getUserById).not.toHaveBeenCalled();
    });

    it('a token for a deleted account is not an Admin and skips the fresh role lookup', async () => {
        const res = await call('user:update_preferences', {}, { token: signToken({ userId: 404 }) });
        expect(res.statusCode).toBe(503);
        expect(h.spy.resolveIsSystemAdminFresh).not.toHaveBeenCalled();
    });

    it('lets the stamped system Admin through without the cache-free re-check', async () => {
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token: as(member(1, [], { isSystemAdmin: true, role: 'Admin' })) });
        expect(res.statusCode).toBe(200);
        expect(prefs).toHaveBeenCalledTimes(1);
        expect(h.spy.resolveIsSystemAdminFresh).not.toHaveBeenCalled();
    });

    it('an identity read fault is "not Admin" (503), never an escape from the gate', async () => {
        const token = as(member(1, [], { isSystemAdmin: true }));
        h.spy.getUserById.mockImplementation(async () => { throw new Error('Failed to load user'); });
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token });
        expect(res.statusCode).toBe(503);
        expect(prefs).not.toHaveBeenCalled();
        expect(logged('warn', 'maintenance admin check failed; treating as non-admin')).toHaveLength(1);
    });

    it('re-resolves Admin identity cache-free on the deny path, keyed on the role id', async () => {
        h.spy.resolveIsSystemAdminFresh.mockImplementation(async (roleId: unknown) => roleId === 77);
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token: as(member(2, [], { roleId: 77 })) });
        expect(res.statusCode).toBe(200);
        expect(h.spy.resolveIsSystemAdminFresh).toHaveBeenCalledWith(77);
        expect(prefs).toHaveBeenCalledTimes(1);
    });

    it.each(['user:heartbeat', 'user:logout'])('%s bypasses maintenance (heartbeat keeps presence, logout only drops privilege)', async (name) => {
        const spy = stub(name);
        const res = await call(name, {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('public bootstrap actions skip the platform-settings read entirely', async () => {
        const cfg = stub('system:get_push_config', async () => ({ publicKey: 'pk' }));
        const res = await call('system:get_push_config', {});
        expect(res.statusCode).toBe(200);
        expect(cfg).toHaveBeenCalledTimes(1);
        expect(h.spy.getPlatformSettings).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('platform force-logout', () => {
    const future = () => new Date(Date.now() + 60_000).toISOString();
    const past = () => new Date(Date.now() - 60_000).toISOString();

    it('401s a session issued before the watermark, clears the cookie, and loads no user', async () => {
        const token = as(member(5));
        h.spy.getPlatformSettings.mockImplementation(async () => ({ force_logout_timestamp: future() }));
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token });
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ message: 'Session expired. Please log in again.', force_logout: true });
        expect(res.cookies).toContain(SESSION_CLEAR);
        expect(prefs).not.toHaveBeenCalled();
        expect(h.spy.getUserById).not.toHaveBeenCalled();
    });

    it.each(['user:heartbeat', 'user:logout'])('still applies to %s, which only bypasses MAINTENANCE', async (name) => {
        const token = as(member(5));
        h.spy.getPlatformSettings.mockImplementation(async () => ({ force_logout_timestamp: future() }));
        const spy = stub(name);
        const res = await call(name, {}, { token });
        expect(res.statusCode).toBe(401);
        expect(res.body.force_logout).toBe(true);
        expect(spy).not.toHaveBeenCalled();
    });

    it('does not touch a session issued after the watermark', async () => {
        const token = as(member(5));
        h.spy.getPlatformSettings.mockImplementation(async () => ({ force_logout_timestamp: past() }));
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token });
        expect(res.statusCode).toBe(200);
        expect(prefs).toHaveBeenCalledTimes(1);
    });

    it('does not apply to the login bootstrap, so a logged-out member can sign back in', async () => {
        h.spy.getPlatformSettings.mockImplementation(async () => ({ force_logout_timestamp: future() }));
        const fin = stub('auth:finalize_setup', async () => ({ ok: true }));
        const res = await call('auth:finalize_setup', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(200);
        expect(fin).toHaveBeenCalledTimes(1);
    });

    it('an unverifiable token is not force-logged-out here; it falls to the signature 401 below', async () => {
        h.spy.getPlatformSettings.mockImplementation(async () => ({ force_logout_timestamp: future() }));
        const res = await call('user:update_preferences', {}, { token: 'forged.deadbeef' });
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ message: 'Unauthorized: Invalid token signature' });
    });

});

// ---------------------------------------------------------------------------
// The platform-settings read drives BOTH the maintenance and the force-logout gate, and
// both refusals live inside its try. A catch that only warned skipped both gates for the
// request; it now fails closed (twin of the api/query.ts router).
describe('platform-settings read fault fails closed', () => {
    const MAINT = { message: 'The platform is currently undergoing maintenance. Please try again later.' };
    beforeEach(() => {
        h.spy.getPlatformSettings.mockImplementation(async () => { throw new Error('settings read failed at 10.0.0.5'); });
    });

    it('refuses a member the per-user gates would ALLOW with the opaque maintenance 503, logged, never dispatched', async () => {
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual(MAINT);
        expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
        expect(prefs).not.toHaveBeenCalled();
        // Refused at the platform gate: no user load, no ban lookup.
        expect(h.spy.getUserById).not.toHaveBeenCalled();
        expect(h.spy.findActiveBan).not.toHaveBeenCalled();
        const err = logged('error', 'maintenance check failed; refusing');
        expect(err).toHaveLength(1);
        expect(err[0].fields).toMatchObject({ action: 'user:update_preferences', err: expect.any(Error) });
        expect(logged('warn', 'maintenance check failed')).toHaveLength(0);
    });

    it('nobody is an Admin when the platform state is unreadable: the stamped system Admin is refused too', async () => {
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token: as(member(1, [], { isSystemAdmin: true, role: 'Admin' })) });
        expect(res.statusCode).toBe(503);
        expect(prefs).not.toHaveBeenCalled();
    });

    it('stays ABOVE authentication like the gate it backs: no token is the 503, not a 401', async () => {
        const res = await call('admin:update_user', { targetUserId: 9 }, {});
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual(MAINT);
    });

    it('a throw AFTER a successful read is refused the same way (the whole gate block fails closed)', async () => {
        // resolveIsSystemAdminFresh is contracted never to throw; if it ever did, the old
        // catch let a non-Admin through an ACTIVE maintenance window.
        h.spy.getPlatformSettings.mockImplementation(async () => ({ maintenance_mode: true }));
        h.spy.resolveIsSystemAdminFresh.mockImplementation(async () => { throw new Error('role read failed'); });
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(503);
        expect(prefs).not.toHaveBeenCalled();
        expect(logged('error', 'maintenance check failed; refusing')).toHaveLength(1);
    });

    it.each(['user:heartbeat', 'user:logout'])('%s is in maintenanceBypass and still proceeds, warned, with every later gate intact', async (name) => {
        const spy = stub(name);
        const res = await call(name, {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toMatchObject({ userId: 5 });
        const warn = logged('warn', 'maintenance check failed');
        expect(warn).toHaveLength(1);
        expect(warn[0].fields).toMatchObject({ action: name });
        expect(logged('error', 'maintenance check failed; refusing')).toHaveLength(0);
        // The later gates still decide for the bypass actions: no token is the 401.
        const unauth = await call(name, {}, {});
        expect(unauth.statusCode).toBe(401);
        expect(unauth.body).toEqual({ message: 'Unauthorized: Missing token' });
    });

    it('the public bootstrap actions never read platform settings, so a fault cannot touch them', async () => {
        const cfg = stub('system:get_push_config', async () => ({ publicKey: 'pk' }));
        const res = await call('system:get_push_config', {});
        expect(res.statusCode).toBe(200);
        expect(cfg).toHaveBeenCalledTimes(1);
        expect(h.spy.getPlatformSettings).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('login-CSRF: OAuth state cookie (server half)', () => {
    it.each([
        ['missing', undefined],
        ['too short', 'abc'],
        ['attribute smuggling', 'abcdefghijklmnop; Domain=evil.example'],
        ['non-string', 1234567890123456],
    ])('begin_oauth refuses a %s nonce with 400 and sets no cookie', async (_label, nonce) => {
        const res = await call('auth:begin_oauth', { nonce });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ success: false, message: 'Invalid OAuth nonce.' });
        expect(res.headers['Set-Cookie']).toBeUndefined();
    });

    it('begin_oauth with a null payload is refused, not crashed', async () => {
        const res = await call('auth:begin_oauth', null);
        expect(res.statusCode).toBe(400);
    });

    it('begin_oauth mints the plain HttpOnly cookie over HTTP and returns before any handler', async () => {
        const res = await call('auth:begin_oauth', { nonce: NONCE });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, data: { ok: true } });
        expect(res.headers['Set-Cookie']).toBe(buildOAuthStateCookie(NONCE, false));
        expect(res.headers['Set-Cookie']).toMatch(/^oauth_state=.*HttpOnly/);
        expect(res.headers['Set-Cookie']).not.toMatch(/Secure/);
    });

    it.each([
        ['x-forwarded-proto https', { proto: 'https' }],
        ['req.secure', { secure: true }],
    ])('begin_oauth mints the __Host- Secure cookie behind TLS (%s)', async (_l, opts) => {
        const res = await call('auth:begin_oauth', { nonce: NONCE }, opts);
        expect(res.headers['Set-Cookie']).toBe(buildOAuthStateCookie(NONCE, true));
        expect(res.headers['Set-Cookie']).toMatch(/^__Host-oauth_state=.*; Secure$/);
    });

    it('callback without the cookie fails closed BEFORE the code exchange, clears it, and audits', async () => {
        const cb = stub('auth:discord_callback');
        const res = await call('auth:discord_callback', { code: 'c', state: `login:${NONCE}` });
        expect(res.statusCode).toBe(403);
        expect(res.body).toMatchObject({ success: false, code: 'OAUTH_STATE_INVALID' });
        expect(res.headers['Set-Cookie']).toBe(clearOAuthStateCookie(false));
        expect(cb).not.toHaveBeenCalled();
        expect(lastAudit()).toMatchObject({ event: 'auth.oauth_state.denied', action: 'auth:discord_callback', details: { hasCookie: false, hasNonce: true } });
    });

    it('callback whose echoed nonce differs from the cookie is refused', async () => {
        const cb = stub('auth:discord_callback');
        const res = await call('auth:discord_callback', { state: 'login:someone_elses_nonce_123456' }, { cookie: `oauth_state=${NONCE}` });
        expect(res.statusCode).toBe(403);
        expect(cb).not.toHaveBeenCalled();
        expect(lastAudit().details).toEqual({ hasCookie: true, hasNonce: true });
    });

    it.each([
        ['a non-string state', { state: 42 }],
        ['an empty trailing segment', { state: 'login:' }],
        ['no state at all', {}],
    ])('callback with %s has no nonce and is refused', async (_l, payload) => {
        const cb = stub('auth:discord_callback');
        const res = await call('auth:discord_callback', payload, { cookie: `oauth_state=${NONCE}` });
        expect(res.statusCode).toBe(403);
        expect(cb).not.toHaveBeenCalled();
        expect(lastAudit().details).toEqual({ hasCookie: true, hasNonce: false });
    });

    it('behind TLS only the __Host- cookie is read, so a sibling-planted plain cookie cannot satisfy it', async () => {
        const cb = stub('auth:discord_callback');
        const res = await call('auth:discord_callback', { state: `login:${NONCE}` }, { cookie: `oauth_state=${NONCE}`, proto: 'https' });
        expect(res.statusCode).toBe(403);
        expect(res.headers['Set-Cookie']).toBe(clearOAuthStateCookie(true));
        expect(cb).not.toHaveBeenCalled();
    });

    it('a matching nonce (last state segment) is consumed one-time and the callback runs', async () => {
        const cb = stub('auth:discord_callback', async () => ({ needsSetup: true }));
        const payload = { code: 'c', state: `admin_setup:SETUP-ABCDEF12:${NONCE}` };
        const res = await call('auth:discord_callback', payload, { cookie: `other=1; __Host-oauth_state=${NONCE}`, proto: 'https' });
        expect(res.statusCode).toBe(200);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][0]).toEqual(payload);
        expect(res.headers['Set-Cookie']).toBe(clearOAuthStateCookie(true));
        expect(res.body).toEqual({ success: true, data: { needsSetup: true } });
    });
});

// ---------------------------------------------------------------------------
describe('PUBLIC_ACTIONS', () => {
    it('is exactly the pre-login bootstrap set (every entry is reachable with no session)', () => {
        expect([...PUBLIC_ACTIONS].sort()).toEqual([
            'auth:begin_oauth', 'auth:discord_callback', 'auth:finalize_setup', 'auth:redeem_setup_code',
            'system:get_push_config', 'system:preflight',
        ]);
    });

    it('dispatches without a session and passes the payload through untouched (no user record injected)', async () => {
        const pre = stub('system:preflight', async () => ({ ready: false }));
        const payload = { userId: 999 };
        const res = await call('system:preflight', payload);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, data: { ready: false } });
        expect(pre).toHaveBeenCalledWith({ userId: 999 }, undefined);
        expect(h.spy.getUserById).not.toHaveBeenCalled();
        expect(res.cookies).toEqual([]);
    });

    it('a public action never loads or injects the caller even when a valid session is presented', async () => {
        const token = as(member(5, ['admin:access'], { adminNotes: 'PRIVATE' }));
        const pre = stub('system:preflight', async (p) => p);
        const res = await call('system:preflight', { probe: true }, { token });
        expect(pre.mock.calls[0][1]).toBe(token);
        expect(res.body.data).toEqual({ probe: true });
        expect(h.spy.getUserById).not.toHaveBeenCalled();
        expect(JSON.stringify(res.body)).not.toContain('PRIVATE');
    });

    it('mints the 24h HttpOnly session cookie when a login action returns a token', async () => {
        const fin = stub('auth:finalize_setup', async () => ({ token: 'issued-session-token', user: { id: 3 } }));
        const res = await call('auth:finalize_setup', { discordId: 'd' });
        expect(fin).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(200);
        expect(res.cookies).toEqual([buildSessionCookie('issued-session-token', SESSION_COOKIE_IS_SECURE, 86400)]);
        // Dual-accept: the token also stays in the body.
        expect(res.body.data.token).toBe('issued-session-token');
    });

    it.each([
        ['an empty token', { token: '' }],
        ['a non-string token', { token: 123 }],
        ['a null result', null],
    ])('sets no session cookie for %s', async (_l, result) => {
        stub('auth:finalize_setup', async () => result);
        const res = await call('auth:finalize_setup', {});
        expect(res.statusCode).toBe(200);
        expect(res.cookies).toEqual([]);
    });

    it('a SecurityDenial returns its status + safe message, while ids stay in the audit row only', async () => {
        stub('auth:redeem_setup_code', async () => {
            throw new SecurityDenial('Setup code not accepted.', { auditEvent: 'auth.setup_code.denied', fields: { codeId: 'SECRET-ID-7' }, status: 409 });
        });
        const res = await call('auth:redeem_setup_code', { code: 'x' });
        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({ success: false, message: 'Setup code not accepted.' });
        expect(JSON.stringify(res.body)).not.toContain('SECRET-ID-7');
        expect(lastAudit()).toMatchObject({ event: 'auth.setup_code.denied', action: 'auth:redeem_setup_code', actorUserId: null, details: { codeId: 'SECRET-ID-7' } });
    });

    it('a cross-realm SecurityDenial shape with no event/status defaults to 403 + authz.denied', async () => {
        stub('auth:redeem_setup_code', async () => { throw { name: 'SecurityDenial', message: 'No.' }; });
        const res = await call('auth:redeem_setup_code', {});
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toBe('No.');
        expect(auditEvents()).toEqual(['authz.denied']);
    });

    it('an infrastructure error is opaque: generic message + a request id, never the SQL text', async () => {
        stub('system:preflight', async () => { throw { code: '42P01', message: 'relation "public.users" does not exist' }; });
        const res = await call('system:preflight', {});
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('An internal server error occurred.');
        expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(JSON.stringify(res.body)).not.toContain('public.users');
        expect(logged('error', 'error executing public action')[0].fields).toMatchObject({ requestId: res.body.requestId, action: 'system:preflight' });
    });

    it('deliberate business copy still reaches the client; an empty message falls back to generic', async () => {
        stub('auth:finalize_setup', async () => { throw new Error('That handle is already taken.'); });
        expect((await call('auth:finalize_setup', {})).body.message).toBe('That handle is already taken.');
        stub('auth:finalize_setup', async () => { throw new Error(''); });
        expect((await call('auth:finalize_setup', {})).body.message).toBe('An internal server error occurred.');
    });

    it('a PUBLIC_ACTIONS name with no registered handler is a 400, never a crash', async () => {
        const saved = actions['system:preflight'];
        delete actions['system:preflight'];
        try {
            const res = await call('system:preflight', {});
            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ message: 'Invalid action: system:preflight' });
        } finally {
            actions['system:preflight'] = saved;
        }
    });
});

// ---------------------------------------------------------------------------
describe('session-token verification', () => {
    it('401s a request with no credential', async () => {
        const res = await call('user:update_preferences', {});
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ message: 'Unauthorized: Missing token' });
    });

    it('a bare "Bearer" header carries no credential', async () => {
        const res = await call('user:update_preferences', {}, { authorization: 'Bearer' });
        expect(res.body).toEqual({ message: 'Unauthorized: Missing token' });
    });

    it('a tampered signature is rejected without loading the user', async () => {
        const token = as(member(5));
        const flipped = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
        const res = await call('user:update_preferences', {}, { token: flipped });
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ message: 'Unauthorized: Invalid token signature' });
        expect(h.spy.getUserById).not.toHaveBeenCalled();
    });

    it('a forged payload re-using a real signature (privilege swap) is rejected', async () => {
        const [, sig] = as(member(5)).split('.');
        const forgedBody = Buffer.from(JSON.stringify({ userId: 1, iat: Date.now(), exp: Date.now() + 1e6 })).toString('base64');
        const res = await call('user:update_preferences', {}, { token: `${forgedBody}.${sig}` });
        expect(res.statusCode).toBe(401);
    });

    it('an expired session is rejected', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
        const token = as(member(5));
        vi.setSystemTime(new Date('2026-06-02T00:00:01Z'));
        const res = await call('user:update_preferences', {}, { token });
        expect(res.statusCode).toBe(401);
        expect(res.body.message).toMatch(/Invalid token/);
    });

    it.each([
        ['an admin-setup grant', () => signAdminSetupGrant('d-5')],
        ['a signup identity grant', () => signIdentityGrant('d-5', 'MYRSI-1')],
    ])('%s cannot be replayed as a session', async (_l, mint) => {
        const res = await call('user:update_preferences', {}, { token: mint() });
        expect(res.statusCode).toBe(401);
        expect(h.spy.getUserById).not.toHaveBeenCalled();
    });

    it('prefers the HttpOnly cookie over the Authorization header (dual-accept)', async () => {
        const cookieToken = as(member(5));
        as(member(6));
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, {
            cookie: `${sessionCookieName(SESSION_COOKIE_IS_SECURE)}=${cookieToken}`,
            authorization: 'Bearer garbage-header-token',
        });
        expect(res.statusCode).toBe(200);
        expect(prefs.mock.calls[0][0].userId).toBe(5);
        expect(prefs.mock.calls[0][1]).toBe(cookieToken);
    });

    it('a valid token for an account that no longer exists is a 401', async () => {
        const res = await call('user:update_preferences', {}, { token: signToken({ userId: 404 }) });
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ message: 'Unauthorized: User account not found.' });
        expect(h.spy.getUserById).toHaveBeenCalledWith(404);
    });

    it('a token issued before the user\'s tokens_valid_from watermark is revoked, with the cookie cleared', async () => {
        const token = as(member(5, [], { tokensValidFrom: new Date(Date.now() + 60_000).toISOString() }));
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token });
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ message: 'Session expired. Please log in again.', force_logout: true });
        expect(res.cookies).toContain(SESSION_CLEAR);
        expect(prefs).not.toHaveBeenCalled();
        expect(h.spy.findActiveBan).not.toHaveBeenCalled();
    });

    it('a token issued after the watermark is accepted', async () => {
        const token = as(member(5, [], { tokensValidFrom: new Date(Date.now() - 60_000).toISOString() }));
        stub('user:update_preferences');
        expect((await call('user:update_preferences', {}, { token })).statusCode).toBe(200);
    });
});

// ---------------------------------------------------------------------------
describe('org ban gate', () => {
    const ban = { id: 'ban-1' };

    it('refuses a banned member with ORG_BANNED, audits the ban id, and looks up by id AND discord id', async () => {
        h.spy.findActiveBan.mockImplementation(async () => ban);
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(403);
        expect(res.body).toMatchObject({ success: false, code: 'ORG_BANNED' });
        expect(prefs).not.toHaveBeenCalled();
        expect(h.spy.findActiveBan).toHaveBeenCalledWith({ userId: 5, discordId: 'd-5' });
        expect(lastAudit()).toMatchObject({ event: 'authz.org_ban.denied', actorUserId: 5, actorLabel: 'Handle5', details: { banId: 'ban-1' } });
    });

    it('outranks every permission: a banned member holding admin perms is still refused', async () => {
        h.spy.findActiveBan.mockImplementation(async () => ban);
        const upd = stub('admin:update_user');
        const res = await call('admin:update_user', {}, { token: as(member(5, ['admin:user:update'])) });
        expect(res.body.code).toBe('ORG_BANNED');
        expect(upd).not.toHaveBeenCalled();
    });

    it.each(['user:logout', 'ban:my_notice', 'ban:submit_appeal'])('the exempt action %s stays reachable while banned', async (name) => {
        h.spy.findActiveBan.mockImplementation(async () => ban);
        const spy = stub(name);
        const res = await call(name, {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('a ban-store fault is a retryable 503, never a ban screen, and the expected shape is not logged as a bug', async () => {
        h.spy.findActiveBan.mockImplementation(async () => { const e = new Error('read failed'); e.name = 'BanCheckUnavailable'; throw e; });
        const res = await call('user:update_preferences', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(503);
        expect(res.body).toMatchObject({ success: false, code: 'BAN_CHECK_UNAVAILABLE' });
        expect(res.body.code).not.toBe('ORG_BANNED');
        expect(logged('error', 'ban gate failed unexpectedly')).toHaveLength(0);
    });

    it('an unexpected fault in the gate itself still fails closed (503) and is logged loudly', async () => {
        h.spy.findActiveBan.mockImplementation(async () => { throw new TypeError('x is not a function'); });
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(503);
        expect(prefs).not.toHaveBeenCalled();
        expect(logged('error', 'ban gate failed unexpectedly')[0].fields).toMatchObject({ action: 'user:update_preferences', userId: 5 });
    });
});

// ---------------------------------------------------------------------------
describe('payload injection + identity-spoofing mitigation', () => {
    it('overwrites every actor-identity field with the session user and leaves target fields alone', async () => {
        const token = as(member(42));
        const prefs = stub('user:update_preferences');
        const payload: Record<string, unknown> = {
            userId: 1, adminId: 1, creatorId: 1, authorId: 1, issuerId: 1, appointedById: 1,
            targetUserId: 7, memberId: 8, recruiterId: 9, interviewerId: 10, theme: 'dark',
        };
        const res = await call('user:update_preferences', payload, { token });
        expect(res.statusCode).toBe(200);
        const seen = prefs.mock.calls[0][0];
        for (const f of ['userId', 'adminId', 'creatorId', 'authorId', 'issuerId', 'appointedById']) expect(seen[f], f).toBe(42);
        expect(seen).toMatchObject({ targetUserId: 7, memberId: 8, recruiterId: 9, interviewerId: 10, theme: 'dark' });
        expect(seen.user).toMatchObject({ id: 42, rsiHandle: 'Handle42' });
    });

    it('always injects userId, but never invents the other actor fields', async () => {
        const prefs = stub('user:update_preferences');
        await call('user:update_preferences', { theme: 'x' }, { token: as(member(42)) });
        const seen = prefs.mock.calls[0][0];
        expect(seen.userId).toBe(42);
        for (const f of ACTOR_ID_FIELDS.filter((f) => f !== 'userId')) expect(f in seen, f).toBe(false);
    });

    it('ACTOR_ID_FIELDS covers the actor names and excludes the target-identity names', () => {
        expect(ACTOR_ID_FIELDS).toEqual(expect.arrayContaining(['userId', 'adminId', 'creatorId', 'createdById', 'authorId', 'issuedById', 'issuerId', 'reporterId', 'senderId', 'requesterId', 'actorId', 'performedById', 'appointedById']));
        for (const target of ['targetUserId', 'memberId', 'recruiterId', 'interviewerId', 'newInterviewerId', 'allyOrgId']) {
            expect(ACTOR_ID_FIELDS).not.toContain(target);
        }
    });

    it('hr:save_interview forces interviewerId to the caller (they ARE the interviewer)', async () => {
        const save = stub('hr:save_interview');
        await call('hr:save_interview', { interviewerId: 99, interviewId: 'i1' }, { token: as(member(42, ['hr:recruiter'])) });
        expect(save.mock.calls[0][0].interviewerId).toBe(42);
    });

    it('hr:save_interview keeps an explicit reassignment (newInterviewerId present)', async () => {
        const save = stub('hr:save_interview');
        await call('hr:save_interview', { interviewerId: 99, newInterviewerId: 100 }, { token: as(member(42, ['hr:recruiter'])) });
        expect(save.mock.calls[0][0]).toMatchObject({ interviewerId: 99, newInterviewerId: 100 });
    });

    it('other HR actions keep the admin-selected interviewer', async () => {
        const upd = stub('hr:update_interview');
        await call('hr:update_interview', { interviewerId: 99 }, { token: as(member(42, ['hr:recruiter'])) });
        expect(upd.mock.calls[0][0].interviewerId).toBe(99);
    });
});

// ---------------------------------------------------------------------------
// A present payload that is not a plain object used to either crash the identity loop
// (`field in payload` on a truthy primitive: an unaudited 500) or reach its handler with
// no actor ids at all (a falsy primitive / null skipped both injection blocks).
describe('non-object payload', () => {
    const INVALID = { success: false, message: 'Invalid request payload.' };

    it.each([
        ['a string', 'SECRET-PAYLOAD-VALUE', 'string'],
        ['an empty string', '', 'string'],
        ['a number', 42, 'number'],
        ['zero', 0, 'number'],
        ['true', true, 'boolean'],
        ['false', false, 'boolean'],
        ['null', null, 'null'],
        ['an array', [{ userId: 1 }], 'array'],
        ['an empty array', [], 'array'],
    ])('%s is an explicit, audited 400 that never reaches the handler', async (_label, payload, payloadType) => {
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', payload, { token: as(member(5)) });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(INVALID);
        expect(prefs).not.toHaveBeenCalled();
        expect(lastAudit()).toMatchObject({
            event: 'request.invalid_payload.denied',
            action: 'user:update_preferences',
            actorUserId: 5,
            actorLabel: 'Handle5',
            actorIp: DEFAULT_IP,
            details: { payloadType },
        });
        // The TYPE is recorded, never the value.
        expect(JSON.stringify(lastAudit())).not.toContain('SECRET-PAYLOAD-VALUE');
        expect(logged('warn', 'request.invalid_payload.denied')).toHaveLength(1);
        expect(logged('error', 'error executing action')).toHaveLength(0);
    });

    it('is refused before the permission gate and dispatch, so a protected action cannot 500 on it either', async () => {
        const upd = stub('admin:update_user');
        const res = await call('admin:update_user', 'x', { token: as(member(5, ['admin:user:update'])) });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(INVALID);
        expect(res.body.requestId).toBeUndefined();
        expect(upd).not.toHaveBeenCalled();
        expect(auditEvents()).toEqual(['request.invalid_payload.denied']);
    });

    it('a non-string action is audited with a null action, not the raw value', async () => {
        const res = await call({ evil: true }, 7, { token: as(member(5)) });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(INVALID);
        expect(lastAudit()).toMatchObject({ event: 'request.invalid_payload.denied', action: null, details: { payloadType: 'number' } });
    });

    it('authentication still answers first: an unauthenticated primitive is the 401, unaudited as a payload fault', async () => {
        const res = await call('user:update_preferences', 'x', {});
        expect(res.statusCode).toBe(401);
        expect(auditEvents()).not.toContain('request.invalid_payload.denied');
    });

    it('a MISSING payload keeps today\'s behaviour: dispatched with undefined, no 400', async () => {
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', undefined, { token: as(member(5)), noPayload: true });
        expect(res.statusCode).toBe(200);
        expect(prefs).toHaveBeenCalledTimes(1);
        expect(prefs.mock.calls[0][0]).toBeUndefined();
        expect(auditEvents()).toEqual([]);
    });

    it('a plain object still flows through injection untouched by the shape check', async () => {
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', { theme: 'dark', authorId: 1 }, { token: as(member(5)) });
        expect(res.statusCode).toBe(200);
        expect(prefs.mock.calls[0][0]).toMatchObject({ theme: 'dark', authorId: 5, userId: 5 });
    });
});

// ---------------------------------------------------------------------------
describe('action-name validation', () => {
    it.each([
        ['an unknown action', 'admin:does_not_exist'],
        ['a prototype member', 'toString'],
        ['a non-string action', 123],
    ])('%s is a 400 that echoes no user data', async (_l, action) => {
        const res = await call(action, {}, { token: as(member(5, [], { adminNotes: 'PRIVATE NOTE' })) });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe(`Invalid action: ${action}`);
        expect(JSON.stringify(res.body)).not.toContain('PRIVATE NOTE');
    });

    it('every registered action is either public or under a protected prefix (none escapes the gate)', () => {
        const escaped = Object.keys(actions).filter((a) => !PUBLIC_ACTIONS.includes(a) && !PROTECTED_PREFIXES.some((p) => a.startsWith(p)));
        expect(escaped).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('client-tier namespace denial', () => {
    it('an external customer (seeded Client role) is refused the Academy outright, audited with the prefix', async () => {
        h.spy.isClientCaller.mockImplementation(async () => true);
        const enrol = stub('academy:self_enroll');
        const res = await call('academy:self_enroll', { courseId: 'c' }, { token: as(member(5, ['academy:manage'])) });
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ success: false, message: CLIENT_DENIED_MESSAGE });
        expect(enrol).not.toHaveBeenCalled();
        expect(h.spy.isClientCaller.mock.calls[0][0]).toMatchObject({ id: 5 });
        expect(lastAudit()).toMatchObject({ event: 'authz.client_namespace.denied', details: { prefix: 'academy:' } });
    });

    it('sits above the feature gate: a Client gets ONE answer whatever the module state, with no settings read', async () => {
        h.spy.isClientCaller.mockImplementation(async () => true);
        h.spy.isOptionalFeatureEnabled.mockImplementation(async () => false);
        const res = await call('academy:self_enroll', {}, { token: as(member(5)) });
        expect(res.body.message).toBe(CLIENT_DENIED_MESSAGE);
        expect(h.spy.isOptionalFeatureEnabled).not.toHaveBeenCalled();
    });

    it('a member (not the Client role) passes through to the self-service gate', async () => {
        const enrol = stub('academy:self_enroll');
        const res = await call('academy:self_enroll', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(200);
        expect(enrol).toHaveBeenCalledTimes(1);
    });

    it('the role-slot lookup is only paid for a denied namespace', async () => {
        stub('user:update_preferences');
        await call('user:update_preferences', {}, { token: as(member(5)) });
        expect(h.spy.isClientCaller).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('optional-feature gate', () => {
    const representative = (prefix: string, exempt: readonly string[] = []) =>
        Object.keys(fullPermissionMap).find((a) => a.startsWith(prefix) && !exempt.includes(a))!;

    it.each(Object.entries(OPTIONAL_FEATURE_NAMESPACES))('%s fails closed when its module is OFF, even for a full Admin', async (prefix, gate) => {
        h.spy.isOptionalFeatureEnabled.mockImplementation(async () => false);
        const name = representative(prefix, gate.exempt);
        const spy = stub(name);
        const allPerms = [...new Set(Object.values(fullPermissionMap))];
        const res = await call(name, {}, { token: as(member(1, allPerms, { isSystemAdmin: true })) });
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ success: false, message: `The ${gate.label} feature is not enabled.` });
        expect(h.spy.isOptionalFeatureEnabled).toHaveBeenCalledWith(gate.feature);
        expect(spy).not.toHaveBeenCalled();
    });

    it('the government re-enable action stays reachable while government is OFF (no self-lockout)', async () => {
        h.spy.isOptionalFeatureEnabled.mockImplementation(async () => false);
        const cfg = stub('gov:update_feature_config');
        const res = await call('gov:update_feature_config', {}, { token: as(member(1, ['gov:admin'])) });
        expect(res.statusCode).toBe(200);
        expect(cfg).toHaveBeenCalledTimes(1);
        expect(h.spy.isOptionalFeatureEnabled).not.toHaveBeenCalled();
    });

    it('a module that is ON hands over to the permission gate (which still decides)', async () => {
        const browse = stub('marketplace:browse');
        expect((await call('marketplace:browse', {}, { token: as(member(5)) })).statusCode).toBe(403);
        expect((await call('marketplace:browse', {}, { token: as(member(6, ['marketplace:view'])) })).statusCode).toBe(200);
        expect(h.spy.isOptionalFeatureEnabled).toHaveBeenCalledWith('marketplace');
        expect(browse).toHaveBeenCalledTimes(1);
    });

    it('non-module namespaces never read the feature flags', async () => {
        stub('admin:update_user');
        await call('admin:update_user', {}, { token: as(member(5, ['admin:user:update'])) });
        expect(h.spy.isOptionalFeatureEnabled).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('BOLA / permission gate', () => {
    it('a protected action with NO fullPermissionMap entry is denied for everyone, audited as unmapped', async () => {
        const name = 'admin:cov_unmapped_probe';
        const impl = vi.fn(async () => 'should-not-run');
        actions[name] = impl;
        try {
            const res = await call(name, {}, { token: as(member(5, ['admin:access', 'admin:db:destroy'], { isSystemAdmin: true })) });
            expect(res.statusCode).toBe(403);
            expect(res.body).toEqual({ message: 'Insufficient permissions' });
            expect(impl).not.toHaveBeenCalled();
            expect(lastAudit()).toMatchObject({ event: 'authz.unmapped_action.denied', action: name, actorUserId: 5 });
        } finally {
            delete actions[name];
        }
    });

    it('user:manage:self admits any authenticated session with zero permissions', async () => {
        expect(fullPermissionMap['user:update_preferences']).toBe('user:manage:self');
        const prefs = stub('user:update_preferences');
        const res = await call('user:update_preferences', {}, { token: as(member(5, [])) });
        expect(res.statusCode).toBe(200);
        expect(prefs).toHaveBeenCalledTimes(1);
    });

    it('a caller missing the mapped permission gets a generic 403; the required perm is in the audit row only', async () => {
        const upd = stub('admin:update_user');
        const res = await call('admin:update_user', {}, { token: as(member(5, ['admin:access'])) });
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ message: 'Insufficient permissions' });
        expect(upd).not.toHaveBeenCalled();
        expect(lastAudit()).toMatchObject({ event: 'authz.permission.denied', action: 'admin:update_user', actorUserId: 5, details: { requiredPerm: 'admin:user:update' } });
    });

    it('a caller holding the mapped permission is dispatched and gets the handler result', async () => {
        stub('admin:update_user', async () => ({ updated: true }));
        const res = await call('admin:update_user', {}, { token: as(member(5, ['admin:user:update'])) });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, data: { updated: true } });
    });

    it('applies the shared implication table (intel:view:clearance satisfies intel:view)', async () => {
        const get = stub('intel:get_reports');
        const res = await call('intel:get_reports', {}, { token: as(member(5, ['intel:view:clearance'])) });
        expect(res.statusCode).toBe(200);
        expect(get).toHaveBeenCalledTimes(1);
    });

    describe('op-owner bypass', () => {
        it('the owner of THIS op may run an owner-appropriate edit without operations:manage', async () => {
            h.spy.getFullOperationDetails.mockImplementation(async (id: unknown) => (id === 'op-1' ? { ownerId: 5 } : null));
            const add = stub('operation:add_phase');
            const res = await call('operation:add_phase', { operationId: 'op-1' }, { token: as(member(5, ['operations:view'])) });
            expect(res.statusCode).toBe(200);
            expect(add).toHaveBeenCalledTimes(1);
            expect(h.spy.getFullOperationDetails).toHaveBeenCalledWith('op-1');
        });

        it('a non-owner, or an op that does not exist, is denied', async () => {
            h.spy.getFullOperationDetails.mockImplementation(async (id: unknown) => (id === 'op-1' ? { ownerId: 6 } : null));
            const add = stub('operation:add_phase');
            const token = as(member(5, ['operations:view']));
            expect((await call('operation:add_phase', { operationId: 'op-1' }, { token })).statusCode).toBe(403);
            expect((await call('operation:add_phase', { operationId: 'op-missing' }, { token })).statusCode).toBe(403);
            expect(add).not.toHaveBeenCalled();
        });

        it('no operationId means no ownership lookup and a denial', async () => {
            const res = await call('operation:add_phase', {}, { token: as(member(5, ['operations:view'])) });
            expect(res.statusCode).toBe(403);
            expect(h.spy.getFullOperationDetails).not.toHaveBeenCalled();
        });

        // Before the fix each of these four inline bypass probes read `payload.<id>` on an
        // absent payload, threw a TypeError out of the gate, and server.ts turned it into
        // an UNAUDITED 500 — a permission probe that left no security_events row.
        it.each([
            ['operation:add_phase', ['operations:view']],
            ['unit:update_details', []],
            ['intel:delete_bulletin', ['intel:view']],
            ['request:add_responder', []],
        ])('a %s probe with NO payload at all is denied 403 and audited, not crashed into an unaudited 500', async (name, perms) => {
            const spy = stub(name as string);
            const res = await call(name, undefined, { token: as(member(5, perms as string[])), noPayload: true });
            expect(res.statusCode).toBe(403);
            expect(spy).not.toHaveBeenCalled();
            expect(auditEvents()).toEqual(['authz.permission.denied']);
            expect(h.sbCalls).toHaveLength(0);
            expect(h.spy.getFullOperationDetails).not.toHaveBeenCalled();
        });

        it.each([...OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS])('%s always needs the real operations:manage, even for the owner', async (name) => {
            h.spy.getFullOperationDetails.mockImplementation(async () => ({ ownerId: 5 }));
            const spy = stub(name);
            const res = await call(name, { operationId: 'op-1' }, { token: as(member(5, ['operations:view', 'operations:create'])) });
            expect(res.statusCode).toBe(403);
            expect(spy).not.toHaveBeenCalled();
            // The ownership fetch is not even attempted for an excluded action.
            expect(h.spy.getFullOperationDetails).not.toHaveBeenCalled();
        });

        it.each([
            ['a status value', { status: 'Concluded' }],
            ['an explicit null status (clearing it is still a status change)', { status: null }],
        ])('operation:update carrying %s is forced onto the operations:manage path, owner or not', async (_l, updates) => {
            h.spy.getFullOperationDetails.mockImplementation(async () => ({ ownerId: 5 }));
            const upd = stub('operation:update');
            const res = await call('operation:update', { operationId: 'op-1', updates }, { token: as(member(5, ['operations:create'])) });
            expect(res.statusCode).toBe(403);
            expect(upd).not.toHaveBeenCalled();
            expect(h.spy.getFullOperationDetails).not.toHaveBeenCalled();
        });

        it.each([
            ['an ordinary field edit', { name: 'New name' }],
            ['a status key that is undefined', { status: undefined }],
            ['no updates object', null],
        ])('operation:update with %s keeps the owner bypass', async (_l, updates) => {
            h.spy.getFullOperationDetails.mockImplementation(async () => ({ ownerId: 5 }));
            const upd = stub('operation:update');
            const res = await call('operation:update', { operationId: 'op-1', updates }, { token: as(member(5, ['operations:create'])) });
            expect(res.statusCode).toBe(200);
            expect(upd).toHaveBeenCalledTimes(1);
        });

        it('a holder of operations:manage never pays for the ownership fetch', async () => {
            stub('operation:add_phase');
            const res = await call('operation:add_phase', { operationId: 'op-1' }, { token: as(member(5, ['operations:manage'])) });
            expect(res.statusCode).toBe(200);
            expect(h.spy.getFullOperationDetails).not.toHaveBeenCalled();
        });
    });

    describe('unit-leader bypass (unit:update_details)', () => {
        const leader = () => member(5, [], { unit: { id: 'u-1', leaderId: 5 } });

        it('the leader of the named unit may update it without unit:manage:own', async () => {
            const upd = stub('unit:update_details');
            const res = await call('unit:update_details', { unitId: 'u-1' }, { token: as(leader()) });
            expect(res.statusCode).toBe(200);
            expect(upd).toHaveBeenCalledTimes(1);
        });

        it.each([
            ['another unit', { unitId: 'u-2' }, leader],
            ['no unitId', {}, leader],
            ['a non-leader member of the unit', { unitId: 'u-1' }, () => member(5, [], { unit: { id: 'u-1', leaderId: 6 } })],
            ['a caller with no unit', { unitId: 'u-1' }, () => member(5)],
        ])('is denied for %s', async (_l, payload, who) => {
            const upd = stub('unit:update_details');
            const res = await call('unit:update_details', payload, { token: as(who()) });
            expect(res.statusCode).toBe(403);
            expect(upd).not.toHaveBeenCalled();
        });

        it('does not extend to any other unit:* action', async () => {
            const post = stub('unit:create_post');
            const res = await call('unit:create_post', { unitId: 'u-1' }, { token: as(leader()) });
            expect(res.statusCode).toBe(403);
            expect(post).not.toHaveBeenCalled();
        });
    });

    describe('bulletin-author bypass (intel:delete_bulletin)', () => {
        it('the author may delete their own bulletin without intel:manage, looked up by id', async () => {
            h.rows.intel_bulletins = { created_by_id: 5 };
            const del = stub('intel:delete_bulletin');
            const res = await call('intel:delete_bulletin', { bulletinId: 'b-1' }, { token: as(member(5, ['intel:view'])) });
            expect(res.statusCode).toBe(200);
            expect(del).toHaveBeenCalledTimes(1);
            const q = h.sbCalls.find((c) => c.table === 'intel_bulletins')!;
            expect(q.ops).toEqual([['select', 'created_by_id'], ['eq', 'id', 'b-1']]);
        });

        it.each([
            ['someone else\'s bulletin', { created_by_id: 6 }],
            ['a missing bulletin', null],
        ])('is denied for %s', async (_l, row) => {
            h.rows.intel_bulletins = row;
            const del = stub('intel:delete_bulletin');
            const res = await call('intel:delete_bulletin', { bulletinId: 'b-1' }, { token: as(member(5, ['intel:view'])) });
            expect(res.statusCode).toBe(403);
            expect(del).not.toHaveBeenCalled();
        });

        it('no bulletinId means no lookup and a denial', async () => {
            const res = await call('intel:delete_bulletin', {}, { token: as(member(5, ['intel:view'])) });
            expect(res.statusCode).toBe(403);
            expect(h.sbCalls).toHaveLength(0);
        });

        it('does not extend to deleting reports', async () => {
            h.rows.intel_bulletins = { created_by_id: 5 };
            const res = await call('intel:delete_report', { bulletinId: 'b-1', reportId: 'r-1' }, { token: as(member(5, ['intel:view'])) });
            expect(res.statusCode).toBe(403);
            expect(h.sbCalls).toHaveLength(0);
        });
    });

    describe('request-lead bypass (add/remove_responder)', () => {
        it.each(['request:add_responder', 'request:remove_responder'])('the lead responder may run %s on their request', async (name) => {
            h.rows.service_requests = { lead_responder_id: 5 };
            const spy = stub(name);
            const res = await call(name, { requestId: 'SR-1' }, { token: as(member(5, ['request:accept'])) });
            expect(res.statusCode).toBe(200);
            expect(spy).toHaveBeenCalledTimes(1);
            const q = h.sbCalls.find((c) => c.table === 'service_requests')!;
            expect(q.ops).toEqual([['select', 'lead_responder_id'], ['eq', 'id', 'SR-1']]);
        });

        it.each([
            ['another responder is lead', { lead_responder_id: 6 }],
            ['the request does not exist', null],
        ])('is denied when %s', async (_l, row) => {
            h.rows.service_requests = row;
            const spy = stub('request:add_responder');
            const res = await call('request:add_responder', { requestId: 'SR-1' }, { token: as(member(5, ['request:accept'])) });
            expect(res.statusCode).toBe(403);
            expect(spy).not.toHaveBeenCalled();
        });

        it('no requestId means no lookup and a denial', async () => {
            const res = await call('request:remove_responder', {}, { token: as(member(5)) });
            expect(res.statusCode).toBe(403);
            expect(h.sbCalls).toHaveLength(0);
        });

        it('does not extend to set_lead (the lead cannot crown a successor)', async () => {
            h.rows.service_requests = { lead_responder_id: 5 };
            const spy = stub('request:set_lead');
            const res = await call('request:set_lead', { requestId: 'SR-1' }, { token: as(member(5, ['request:accept'])) });
            expect(res.statusCode).toBe(403);
            expect(spy).not.toHaveBeenCalled();
            expect(h.sbCalls).toHaveLength(0);
        });
    });

    describe('additional gates layered on top of the map', () => {
        it('warrant:generate_report needs warrant:view on top of intel:create', async () => {
            const gen = stub('warrant:generate_report');
            const denied = await call('warrant:generate_report', { warrantId: 'w' }, { token: as(member(5, ['intel:create'])) });
            expect(denied.statusCode).toBe(403);
            expect(lastAudit()).toMatchObject({ event: 'authz.permission.denied', details: { requiredPerm: 'warrant:view' } });
            const ok = await call('warrant:generate_report', { warrantId: 'w' }, { token: as(member(6, ['intel:create', 'warrant:view'])) });
            expect(ok.statusCode).toBe(200);
            expect(gen).toHaveBeenCalledTimes(1);
        });

        it('listing testimonial candidates needs request:view:feedback on top of the branding perm', async () => {
            const list = stub('admin:list_testimonial_candidates');
            const denied = await call('admin:list_testimonial_candidates', {}, { token: as(member(5, ['admin:config:branding'])) });
            expect(denied.statusCode).toBe(403);
            expect(denied.body).toEqual({ message: 'Insufficient permissions' });
            expect(logged('warn', 'permission denied')[0].fields).toMatchObject({ userId: 5, requiredPerm: 'request:view:feedback' });
            const ok = await call('admin:list_testimonial_candidates', {}, { token: as(member(6, ['admin:config:branding', 'request:view:feedback'])) });
            expect(ok.statusCode).toBe(200);
            expect(list).toHaveBeenCalledTimes(1);
        });

        it('re-ordering already-published testimonials needs no feedback read (non-string ids are ignored)', async () => {
            h.spy.getPublicSettings.mockImplementation(async () => ({ publicPageConfig: { featuredTestimonialIds: ['SR-1', 'SR-2'] } }));
            const upd = stub('admin:update_public_page_config');
            const res = await call('admin:update_public_page_config', { featuredTestimonialIds: ['SR-2', 7, 'SR-1'] }, { token: as(member(5, ['admin:config:branding'])) });
            expect(res.statusCode).toBe(200);
            expect(upd).toHaveBeenCalledTimes(1);
        });

        it('an unreadable featured-list baseline is a diagnosable 403, never "already published"', async () => {
            h.spy.getPublicSettings.mockImplementation(async () => { throw new Error('settings read failed'); });
            const upd = stub('admin:update_public_page_config');
            const res = await call('admin:update_public_page_config', { featuredTestimonialIds: ['SR-1'] }, { token: as(member(5, ['admin:config:branding'])) });
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toMatch(/View Client Feedback/);
            expect(upd).not.toHaveBeenCalled();
            expect(logged('warn', 'permission denied — featured testimonial baseline unreadable')).toHaveLength(1);
        });

        it('publishing a testimonial when the stored featured list is absent treats every id as an ADD (fail closed)', async () => {
            h.spy.getPublicSettings.mockImplementation(async () => ({ publicPageConfig: {} }));
            const upd = stub('admin:update_public_page_config');
            const res = await call('admin:update_public_page_config', { featuredTestimonialIds: ['SR-1'] }, { token: as(member(5, ['admin:config:branding'])) });
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toMatch(/View Client Feedback/);
            expect(upd).not.toHaveBeenCalled();
        });
    });
});

// ---------------------------------------------------------------------------
describe('per-user throttle', () => {
    it('keys on the AUTHENTICATED id: a spoofed payload userId neither escapes nor frames another member', async () => {
        const now = Date.now();
        for (let i = 0; i < USER_PER_MINUTE; i++) checkUserRateLimit(42, now);
        const prefs = stub('user:update_preferences');

        const res = await call('user:update_preferences', { userId: 7 }, { token: as(member(42)) });
        expect(res.statusCode).toBe(429);
        expect(res.body).toMatchObject({ success: false });
        expect(Number(res.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
        expect(prefs).not.toHaveBeenCalled();
        expect(lastAudit()).toMatchObject({ event: 'auth.user_rate_limited', actorUserId: 42 });

        const other = await call('user:update_preferences', {}, { token: as(member(7)) });
        expect(other.statusCode).toBe(200);
    });
});

// ---------------------------------------------------------------------------
describe('authenticated dispatch errors', () => {
    it('a SecurityDenial from the db layer is a 403/its status with the safe message; diagnostics stay server-side', async () => {
        stub('user:update_preferences', async () => {
            throw new SecurityDenial('Not found.', { auditEvent: 'authz.bola.denied', fields: { resourceId: 'R-SECRET' }, status: 404 });
        });
        const res = await call('user:update_preferences', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ success: false, message: 'Not found.' });
        expect(JSON.stringify(res.body)).not.toContain('R-SECRET');
        expect(lastAudit()).toMatchObject({ event: 'authz.bola.denied', action: 'user:update_preferences', actorUserId: 5, actorLabel: 'Handle5', details: { resourceId: 'R-SECRET' } });
    });

    it('a SecurityDenial-shaped error with no event or status defaults to 403 + authz.denied', async () => {
        stub('user:update_preferences', async () => { throw { name: 'SecurityDenial', message: 'Denied.' }; });
        const res = await call('user:update_preferences', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(403);
        expect(auditEvents()).toEqual(['authz.denied']);
    });

    it('a native crash is opaque with a correlatable request id', async () => {
        stub('user:update_preferences', async () => { throw new TypeError("Cannot read properties of undefined (reading 'tokensValidFrom')"); });
        const res = await call('user:update_preferences', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('An internal server error occurred.');
        expect(JSON.stringify(res.body)).not.toContain('tokensValidFrom');
        expect(logged('error', 'error executing action')[0].fields).toMatchObject({ requestId: res.body.requestId });
    });

    it('business copy passes through; an empty message falls back to the generic one', async () => {
        stub('user:update_preferences', async () => { throw new Error('Display name taken.'); });
        expect((await call('user:update_preferences', {}, { token: as(member(5)) })).body.message).toBe('Display name taken.');
        stub('user:update_preferences', async () => { throw new Error(''); });
        expect((await call('user:update_preferences', {}, { token: as(member(6)) })).body.message).toBe('An internal server error occurred.');
    });

    it('an audit emitter that throws synchronously cannot turn a denial into a 500', async () => {
        h.spy.recordSecurityEvent.mockImplementation(() => { throw new Error('emitter missing'); });
        const res = await call('admin:update_user', {}, { token: as(member(5)) });
        expect(res.statusCode).toBe(403);
        expect(logged('warn', 'security event emit threw')).toHaveLength(1);
        // The operational log line still carries the denial.
        expect(logged('warn', 'authz.permission.denied')[0].fields).toMatchObject({ userId: 5, action: 'admin:update_user', requiredPerm: 'admin:user:update' });
    });
});

// ---------------------------------------------------------------------------
describe('validatePermissionMap drift detection', () => {
    it('reports a protected action with no map entry as missing, and a map entry with no action as stale', () => {
        actions['finance:cov_unmapped'] = async () => null;
        actions['zz:cov_unprotected'] = async () => null;
        fullPermissionMap['qm:cov_stale_entry'] = 'qm:view';
        try {
            const { missing, stale } = validatePermissionMap();
            expect(missing).toEqual(['finance:cov_unmapped']);
            expect(stale).toEqual(['qm:cov_stale_entry']);
        } finally {
            delete actions['finance:cov_unmapped'];
            delete actions['zz:cov_unprotected'];
            delete fullPermissionMap['qm:cov_stale_entry'];
        }
    });

    it('public actions are never reported missing even under a protected prefix', () => {
        const { missing } = validatePermissionMap();
        expect(missing.filter((a) => PUBLIC_ACTIONS.includes(a))).toEqual([]);
        expect(PUBLIC_ACTIONS.some((a) => PROTECTED_PREFIXES.some((p) => a.startsWith(p)))).toBe(true);
    });
});
