import { describe, it, expect, vi, beforeEach } from 'vitest';

// The maintenance-mode ADMIN BYPASS must fail closed on a DB fault.
//
// Both surfaces let an org Admin through maintenance by resolving the session
// JWT to a user row. getUserById is now fail-closed and THROWS on a read fault
// (a blip must not read as "account deleted"), and on both surfaces that call
// sits inside a broad try whose catch only log.warns — with the `return 503`
// INSIDE the same try. Left unguarded, a transient Postgres error would skip
// the maintenance gate entirely and hand the platform to every caller.
//
// So each call gets its own try/catch: an unresolvable identity is NOT an Admin.

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    userResult: null as (() => unknown) | null,
    platformSettings: {} as Record<string, unknown>,
    // Cache-free Admin-identity re-check, consulted on the DENY path only.
    freshAdmin: false,
}));

function sbBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'update', 'delete', 'insert', 'single', 'maybeSingle']) b[m] = () => b;
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ count: 1, data: null, error: null });
    return b;
}

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    isSessionForceLoggedOut: () => false,
    isSessionRevokedByWatermark: () => false,
    signRealtimeToken: () => 'rt-token',
}));

vi.mock('../lib/db/userFilters', () => ({
    stripSensitiveUserFields: (u: unknown) => u,
    stripSensitiveUserFieldsBulk: (u: unknown) => u,
}));

vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    // The org-ban gate runs on every authenticated dispatcher request; null = not banned.
    findActiveBan: async () => null,
    getPlatformSettings: async () => h.platformSettings,
    getUserById: async () => h.userResult!(),
    isOptionalFeatureEnabled: async () => true,
    resolveIsSystemAdminFresh: async () => h.freshAdmin,
}));

import servicesHandler from '../api/services';
import queryHandler from '../api/query';

type Res = { statusCode: number; body: any; headers: Record<string, string>; status: (c: number) => Res; json: (b: unknown) => Res; setHeader: (k: string, v: string) => Res };
function mockRes(): Res {
    const res = { statusCode: 0, body: undefined, headers: {} } as Res;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
const asResponse = (r: Res) => r as unknown as import('express').Response;
const postReq = (action: string) =>
    ({ method: 'POST', secure: false, query: {}, headers: { authorization: 'Bearer tok' }, body: { action, payload: {} } }) as any;
const getReq = (query: Record<string, string>) =>
    ({ method: 'GET', query, headers: { authorization: 'Bearer tok' } }) as any;

beforeEach(() => {
    h.decoded = { userId: 1 };
    h.userResult = () => ({ id: 1, role: 'Member', permissions: [] });
    h.platformSettings = { maintenance_mode: true };
    h.freshAdmin = false;
});

describe('maintenance gate — the admin bypass fails closed when identity cannot be read', () => {
    it('POST /api/services still 503s when getUserById throws', async () => {
        h.userResult = () => { throw new Error('Failed to load user'); };
        const res = mockRes();
        await servicesHandler(postReq('warehouse:list_catalog'), asResponse(res));
        expect(res.statusCode).toBe(503);
        expect(res.body.message).toMatch(/maintenance/i);
    });

    it('GET /api/query?target=state still 503s when getUserById throws', async () => {
        h.userResult = () => { throw new Error('Failed to load user'); };
        const res = mockRes();
        await queryHandler(getReq({ target: 'state', subset: 'main' }), asResponse(res));
        expect(res.statusCode).toBe(503);
        expect(res.body.message).toMatch(/maintenance/i);
    });

    it('POST /api/services 503s a resolvable non-Admin (the gate itself still works)', async () => {
        const res = mockRes();
        await servicesHandler(postReq('warehouse:list_catalog'), asResponse(res));
        expect(res.statusCode).toBe(503);
    });

    it('GET /api/query?target=state 503s a resolvable non-Admin', async () => {
        const res = mockRes();
        await queryHandler(getReq({ target: 'state', subset: 'main' }), asResponse(res));
        expect(res.statusCode).toBe(503);
    });

    // ROLE NAME IS NOT AUTHORITY. `role` is inferred from the role row's free-text
    // name (lib/db/mappers.ts), so a permissionless custom role called 'Commander' —
    // or literally 'admin' — walked through a maintenance window the operator
    // declared. Both surfaces must agree, or the dashboard loads and every mutation
    // 503s (or vice versa), so this asserts them together.
    it('503s a forged Admin role NAME on BOTH surfaces', async () => {
        h.userResult = () => ({ id: 1, role: 'Admin', roleId: 9, permissions: [] });

        const svcRes = mockRes();
        await servicesHandler(postReq('warehouse:list_catalog'), asResponse(svcRes));
        expect(svcRes.statusCode).toBe(503);

        const qRes = mockRes();
        await queryHandler(getReq({ target: 'state', subset: 'not-a-subset' }), asResponse(qRes));
        expect(qRes.statusCode).toBe(503);
    });

    // The post-import window: getSystemRoles was memoised before SEEDED_PRECLEAR
    // rebuilt `roles`, so the stamped flag is stale — but lifting maintenance is the
    // escape hatch with no other in-app exit, so the deny path re-resolves cache-free.
    it('lets the real Admin through via the cache-free re-check when the stamp is stale', async () => {
        h.userResult = () => ({ id: 1, roleId: 77, permissions: [] });
        h.freshAdmin = true;

        const svcRes = mockRes();
        await servicesHandler(postReq('warehouse:list_catalog'), asResponse(svcRes));
        expect(svcRes.statusCode).not.toBe(503);

        const qRes = mockRes();
        await queryHandler(getReq({ target: 'state', subset: 'not-a-subset' }), asResponse(qRes));
        expect(qRes.statusCode).toBe(400);
    });

    it('the stamped system Admin is still let through on both surfaces (the bypass is not broken)', async () => {
        h.userResult = () => ({ id: 1, isSystemAdmin: true, permissions: [] });

        const svcRes = mockRes();
        await servicesHandler(postReq('warehouse:list_catalog'), asResponse(svcRes));
        expect(svcRes.statusCode).not.toBe(503);

        // An unknown subset is the cheapest proof the gate was passed: 400 comes
        // from the switch default, well past the maintenance block.
        const qRes = mockRes();
        await queryHandler(getReq({ target: 'state', subset: 'not-a-subset' }), asResponse(qRes));
        expect(qRes.statusCode).toBe(400);
    });
});
