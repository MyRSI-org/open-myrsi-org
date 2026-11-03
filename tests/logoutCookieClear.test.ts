import { describe, it, expect, vi, beforeEach } from 'vitest';

// user:logout must clear the HttpOnly session cookie on EVERY answer the dispatcher gives it,
// refusals included. The client can only remove its localStorage copy; the cookie goes only
// when a response carries the clear. The clear used to sit just above dispatch, BELOW the
// maintenance 503, the force-logout/watermark 401s, the ban-check 503 and the per-user 429 —
// so each of those answered a logout with no clear, the client redirected to `/` anyway, and
// boot signed the member straight back in on the surviving 24-hour cookie.
//
// RUNTIME, through the real handler: tests/sessionCookie.test.ts pins the source position,
// this proves the behaviour.

const h = vi.hoisted(() => ({
    decoded: { userId: 1 } as { userId: number } | null,
    user: { id: 1, role: 'Member', permissions: [] } as Record<string, unknown> | null,
    platformSettings: {} as Record<string, unknown>,
    forceLoggedOut: false,
    revokedByWatermark: false,
    banResult: (async () => null) as () => Promise<unknown>,
    rateLimit: { ok: true } as { ok: boolean; retryAfter?: number },
    revoke: vi.fn(async () => undefined),
    deletePush: vi.fn(async () => undefined),
}));

function sbBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'update', 'delete', 'insert', 'single', 'maybeSingle']) b[m] = () => b;
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return b;
}

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    isSessionForceLoggedOut: () => h.forceLoggedOut,
    isSessionRevokedByWatermark: () => h.revokedByWatermark,
    signRealtimeToken: () => 'rt-token',
}));

vi.mock('../lib/userRateLimit', () => ({
    checkUserRateLimit: () => h.rateLimit,
    pruneUserRateLimitBuckets: () => undefined,
}));

vi.mock('../lib/db/userFilters', () => ({
    stripSensitiveUserFields: (u: unknown) => u,
    stripSensitiveUserFieldsBulk: (u: unknown) => u,
}));

vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    findActiveBan: () => h.banResult(),
    getPlatformSettings: async () => h.platformSettings,
    getUserById: async () => h.user,
    isOptionalFeatureEnabled: async () => true,
    resolveIsSystemAdminFresh: async () => false,
    recordSecurityEvent: async () => undefined,
    revokeUserSessions: h.revoke,
    deleteOwnPushSubscription: h.deletePush,
}));

import servicesHandler from '../api/services';
import { clearSessionCookie } from '../lib/sessionCookie';

type Res = {
    statusCode: number; body: any; cookies: string[]; headers: Record<string, string>;
    status: (c: number) => Res; json: (b: unknown) => Res; setHeader: (k: string, v: string) => Res; append: (k: string, v: string) => Res;
};
function mockRes(): Res {
    const res = { statusCode: 0, body: undefined, cookies: [], headers: {} } as unknown as Res;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    res.append = (k: string, v: string) => { if (k === 'Set-Cookie') res.cookies.push(v); return res; };
    return res;
}
const asResponse = (r: Res) => r as unknown as import('express').Response;
const postReq = (action: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = { authorization: 'Bearer tok' }) =>
    ({ method: 'POST', secure: false, query: {}, headers, body: { action, payload } }) as any;

// SESSION_COOKIE_IS_SECURE resolves from APP_URL at import; whichever it resolved to, the
// clear is one of these two strings.
const CLEARS = [clearSessionCookie(true), clearSessionCookie(false)];
const clearedIn = (res: Res) => res.cookies.some((c) => CLEARS.includes(c));

async function logout(payload: Record<string, unknown> = {}, headers?: Record<string, string>) {
    const res = mockRes();
    await servicesHandler(postReq('user:logout', payload, headers), asResponse(res));
    return res;
}

beforeEach(() => {
    h.decoded = { userId: 1 };
    h.user = { id: 1, role: 'Member', permissions: [] };
    h.platformSettings = {};
    h.forceLoggedOut = false;
    h.revokedByWatermark = false;
    h.banResult = async () => null;
    h.rateLimit = { ok: true };
    h.revoke.mockReset();
    h.revoke.mockImplementation(async () => undefined);
    h.deletePush.mockReset();
});

describe('user:logout clears the session cookie on every dispatcher answer', () => {
    it('on success', async () => {
        const res = await logout();
        expect(res.statusCode).toBe(200);
        expect(clearedIn(res)).toBe(true);
    });

    it('on the platform force-logout 401', async () => {
        h.platformSettings = { force_logout_timestamp: '2026-01-01T00:00:00Z' };
        h.forceLoggedOut = true;
        const res = await logout();
        expect(res.statusCode).toBe(401);
        expect(clearedIn(res)).toBe(true);
    });

    it('on the missing-token 401', async () => {
        const res = await logout({}, {});
        expect(res.statusCode).toBe(401);
        expect(clearedIn(res)).toBe(true);
    });

    it('on the revocation-watermark 401', async () => {
        h.revokedByWatermark = true;
        const res = await logout();
        expect(res.statusCode).toBe(401);
        expect(clearedIn(res)).toBe(true);
    });

    it('on the ban-check 503 (a read fault in the ban gate)', async () => {
        h.banResult = async () => { const e = new Error('ban check failed'); e.name = 'BanCheckUnavailable'; throw e; };
        const res = await logout();
        expect(res.statusCode).toBe(503);
        expect(res.body.code).toBe('BAN_CHECK_UNAVAILABLE');
        expect(clearedIn(res)).toBe(true);
    });

    it('on the per-user 429', async () => {
        h.rateLimit = { ok: false, retryAfter: 30 };
        const res = await logout();
        expect(res.statusCode).toBe(429);
        expect(h.revoke).not.toHaveBeenCalled();
        expect(clearedIn(res)).toBe(true);
    });

    it('when the handler itself throws', async () => {
        h.revoke.mockImplementation(async () => { throw new Error('Failed to revoke user sessions'); });
        const res = await logout();
        expect(res.statusCode).toBe(500);
        expect(clearedIn(res)).toBe(true);
    });

    it('clears it exactly once on a successful logout', async () => {
        const res = await logout();
        expect(res.cookies.filter((c) => CLEARS.includes(c))).toHaveLength(1);
    });

    it('does NOT clear the cookie for any other action refused by the same gate', async () => {
        h.platformSettings = { maintenance_mode: true };
        const res = mockRes();
        await servicesHandler(postReq('warehouse:list_catalog'), asResponse(res));
        expect(res.statusCode).toBe(503);
        expect(clearedIn(res)).toBe(false);
    });
});

// user:logout is in maintenanceBypass. It used to 503 for a non-admin during a maintenance
// window: the cookie clear above still ran, but the handler never did, so tokens_valid_from
// was not moved, the client reported "Sign-out failed", and any other copy of the token
// (another tab, a stolen header) stayed live. A logout only ever drops privilege, so it is
// let through — and ONLY the maintenance gate is skipped.
describe('user:logout during a maintenance window', () => {
    beforeEach(() => { h.platformSettings = { maintenance_mode: true }; });

    it('a non-admin logout reaches the handler: 200, the watermark moves, the cookie is cleared', async () => {
        const res = await logout();
        expect(res.statusCode).toBe(200);
        expect(h.revoke).toHaveBeenCalledWith(1);
        expect(clearedIn(res)).toBe(true);
    });

    it('the bypass is logout only: other user:* actions still 503 for a non-admin', async () => {
        for (const action of ['user:delete_self', 'user:update_display_name']) {
            const res = mockRes();
            await servicesHandler(postReq(action), asResponse(res));
            expect(res.statusCode, action).toBe(503);
            expect(res.body.message).toMatch(/maintenance/i);
        }
        expect(h.revoke).not.toHaveBeenCalled();
    });

    it('it is NOT a force-logout bypass: a force-logged-out session still gets the 401', async () => {
        h.platformSettings = { maintenance_mode: true, force_logout_timestamp: '2026-01-01T00:00:00Z' };
        h.forceLoggedOut = true;
        const res = await logout();
        expect(res.statusCode).toBe(401);
        expect(res.body.force_logout).toBe(true);
        expect(h.revoke).not.toHaveBeenCalled();
        expect(clearedIn(res)).toBe(true);
    });

    it('every later gate still runs: a watermark-revoked token gets the 401, not the handler', async () => {
        h.revokedByWatermark = true;
        const res = await logout();
        expect(res.statusCode).toBe(401);
        expect(h.revoke).not.toHaveBeenCalled();
    });

    it('and a request with no token still gets the missing-token 401', async () => {
        const res = await logout({}, {});
        expect(res.statusCode).toBe(401);
        expect(h.revoke).not.toHaveBeenCalled();
    });
});

describe('user:logout through the dispatcher — push cleanup is pinned to the caller', () => {
    it('passes the dispatcher-forced userId with the endpoint, never a payload-supplied one', async () => {
        const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
        const res = await logout({ userId: 999, pushEndpoint: endpoint });
        expect(res.statusCode).toBe(200);
        expect(h.deletePush).toHaveBeenCalledWith(1, endpoint);
        expect(h.revoke).toHaveBeenCalledWith(1);
    });
});
