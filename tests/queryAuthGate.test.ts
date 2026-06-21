import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression tests for the GET /api/query authorization gate (security incident:
// an old build's target=initial-state and the subset=warrants read path leaked
// cross-tenant / cross-permission data). These assert, at the handler level:
//   1. Non-tenant contexts (apex / manage / unknown host) get NO org data.
//   2. Sensitive subsets (warrants/intel/hr) require the matching permission —
//      a Client-tier member is rejected; a Member-tier member is allowed.
//   3. initial-state never reaches getState() without an authenticated same-org user.

const h = vi.hoisted(() => ({
    ctx: null as any,
    decoded: null as any,
    user: null as any,
    calls: { getWarrantsState: 0, getState: 0, getMainState: 0 },
}));

// Chainable, awaitable Supabase stub so handleInitialState's admin-count probe
// resolves (count > 0 → "system is set up", so we exercise the real auth gate
// rather than the needsSetup short-circuit).
function sbBuilder() {
    const b: any = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'single', 'maybeSingle']) {
        b[m] = () => b;
    }
    b.then = (resolve: any) => resolve({ count: 1, data: { id: 4 }, error: null });
    return b;
}

vi.mock('../lib/context', () => ({ resolveContext: async () => h.ctx }));
vi.mock('../lib/auth', () => ({ verifyToken: () => h.decoded, tokenIssuedAt: () => new Date(0), isSessionRevokedByWatermark: () => false }));
vi.mock('../lib/db/organizations', () => ({ getAllPricingTiers: async () => [] }));
vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    getAllSettings: async () => ({}),
    getSystemRoles: async () => ({ admin: { id: 4 } }),
    getWarrantsState: async (_oid: string) => { h.calls.getWarrantsState++; return { warrants: [{ id: 'w1' }] }; },
    getMainState: async (_oid: string) => { h.calls.getMainState++; return { users: [] }; },
    getState: async (_oid: string) => { h.calls.getState++; return { warrants: [], users: [] }; },
}));

import handler from '../api/query';

function mockRes() {
    const res: any = { statusCode: 0, body: undefined, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
function mockReq(query: any, token?: string) {
    return { method: 'GET', query, headers: token ? { authorization: `Bearer ${token}` } : {} } as any;
}

const TENANT = { type: 'TENANT', organizationId: 'org-1', ownerId: 'owner-auth-id', slug: 'jims' };
const clientUser = { id: 5, organizationId: 'org-1', role: 'Client', permissions: [], auth_user_id: 'u5' };
const memberUser = { id: 6, organizationId: 'org-1', role: 'Member', permissions: ['warrant:view', 'intel:view', 'hr:view'], auth_user_id: 'u6' };

beforeEach(() => {
    h.ctx = null; h.decoded = null; h.user = null;
    h.calls = { getWarrantsState: 0, getState: 0, getMainState: 0 };
});

describe('GET /api/query — non-tenant contexts get no org data', () => {
    it('LANDING + subset=warrants with no token → 403 and no DB read', async () => {
        h.ctx = { type: 'LANDING' };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'warrants' }), res);
        expect(res.statusCode).toBe(403);
        expect(h.calls.getWarrantsState).toBe(0);
    });

    it('PORTAL + subset=main with no token → 403 and no DB read', async () => {
        h.ctx = { type: 'PORTAL' };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        expect(res.statusCode).toBe(403);
        expect(h.calls.getMainState).toBe(0);
    });
});

describe('GET /api/query — per-subset permission gate', () => {
    it('TENANT + Client (no warrant:view) + subset=warrants → 403, warrants never fetched', async () => {
        h.ctx = TENANT; h.decoded = { userId: 5 }; h.user = clientUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'warrants' }, 'tok'), res);
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/permission/i);
        expect(h.calls.getWarrantsState).toBe(0);
    });

    it('TENANT + Member (has warrant:view) + subset=warrants → 200 with warrants', async () => {
        h.ctx = TENANT; h.decoded = { userId: 6 }; h.user = memberUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'warrants' }, 'tok'), res);
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(res.body.warrants)).toBe(true);
        expect(h.calls.getWarrantsState).toBe(1);
    });

    it('TENANT + Client + subset=main (non-sensitive) → 200 (membership is enough)', async () => {
        h.ctx = TENANT; h.decoded = { userId: 5 }; h.user = clientUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }, 'tok'), res);
        expect(res.statusCode).toBe(200);
        expect(h.calls.getMainState).toBe(1);
    });
});

describe('GET /api/query?target=initial-state — never dumps full state without auth', () => {
    it('PORTAL + no token → getState is never called', async () => {
        h.ctx = { type: 'PORTAL' };
        const res = mockRes();
        await handler(mockReq({ target: 'initial-state' }), res);
        expect(h.calls.getState).toBe(0);
        expect(res.body?.warrants).toBeUndefined();
    });

    it('TENANT + no token (system set up) → boot-only, getState never called', async () => {
        h.ctx = TENANT; h.decoded = null; h.user = null;
        const res = mockRes();
        await handler(mockReq({ target: 'initial-state' }), res);
        expect(h.calls.getState).toBe(0);
        expect(res.body?.warrants).toBeUndefined();
    });

    it('TENANT + authenticated same-org member → getState is called', async () => {
        h.ctx = TENANT; h.decoded = { userId: 6 }; h.user = memberUser;
        const res = mockRes();
        await handler(mockReq({ target: 'initial-state' }, 'tok'), res);
        expect(h.calls.getState).toBe(1);
        expect(res.statusCode).toBe(200);
    });
});
