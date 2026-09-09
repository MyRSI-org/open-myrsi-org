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
    apiKey: null as null | { id: number; label: string },
    calls: { getWarrantsState: 0, getState: 0, getMainState: 0, getPublicFeedData: 0 },
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
// signRealtimeToken MUST be stubbed: handleInitialState calls it, and without it the
// authenticated boot path lands in the api/query.ts catch and returns the 200 ERROR
// FALLBACK — which made every res.body assertion on that path pass vacuously.
vi.mock('../lib/auth', () => ({ verifyToken: () => h.decoded, tokenIssuedAt: () => new Date(0), isSessionRevokedByWatermark: () => false, signRealtimeToken: () => 'rt-token' }));
vi.mock('../lib/db/organizations', () => ({ getAllPricingTiers: async () => [] }));
vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    // The read path now runs the ORG BAN GATE above every other gate.
    // Not banned by default; the ban tests drive the real module.
    findActiveBan: async () => null,
    getBanNotice: async () => null,
    // getAllSettings reduces EVERY settings row into one blob, so the outbound
    // federation ceiling rides `main` unless stripSecrets deletes it.
    getAllSettings: async () => ({ intelSharingConfig: { maxShareableClearance: 3 }, brandingConfig: { name: 'Org', iconUrl: '/i.svg' } }),
    getSystemRoles: async () => ({ admin: { id: 4 } }),
    getWarrantsState: async (_oid: string) => { h.calls.getWarrantsState++; return { warrants: [{ id: 'w1' }] }; },
    getMainState: async (_oid: string) => { h.calls.getMainState++; return { users: [] }; },
    getState: async (_oid: string) => { h.calls.getState++; return { warrants: [], users: [], intelSharingConfig: { maxShareableClearance: 3 } }; },
    verifyApiKey: async (_k: string) => h.apiKey,
    getPublicFeedData: async (_since?: string) => { h.calls.getPublicFeedData++; return { reports: [], warrants: [], bulletins: [], _meta: { maxShareableLevel: 0, fetchedAt: 'CLAMPED' } }; },
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
function mockFeedReq(apiKey?: string) {
    return { method: 'GET', query: { target: 'feed' }, headers: apiKey ? { 'x-api-key': apiKey } : {} } as any;
}

const TENANT = { type: 'TENANT', organizationId: 'org-1', ownerId: 'owner-auth-id', slug: 'jims' };
const clientUser = { id: 5, organizationId: 'org-1', role: 'Client', permissions: [], auth_user_id: 'u5' };
const memberUser = { id: 6, organizationId: 'org-1', role: 'Member', permissions: ['warrant:view', 'intel:view', 'hr:view'], auth_user_id: 'u6' };

beforeEach(() => {
    h.ctx = null; h.decoded = null; h.user = null; h.apiKey = null;
    h.calls = { getWarrantsState: 0, getState: 0, getMainState: 0, getPublicFeedData: 0 };
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
        // A Client with zero permissions is the strongest witness: the org's outbound
        // intel-federation ceiling must not ride the settings blob to them.
        expect(res.body.intelSharingConfig).toBeUndefined();
        // …and the rest of the blob still arrives.
        expect(res.body.brandingConfig).toBeDefined();
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
        // Assert we are on the REAL boot payload, not the 200 error fallback — every
        // body assertion below is vacuous otherwise.
        expect(res.body.error).toBeUndefined();
        expect(res.body.realtimeToken).toBe('rt-token');
        expect(res.body.intelSharingConfig).toBeUndefined();
    });
});

describe('GET /api/query?target=feed — alliance key must not bypass per-peer scoping', () => {
    it('a manual feed key → 200 with feed data', async () => {
        h.apiKey = { id: 1, label: 'partner feed' };
        const res = mockRes();
        await handler(mockFeedReq('manual-key'), res);
        expect(res.statusCode).toBe(200);
        expect(h.calls.getPublicFeedData).toBe(1);
        expect(Array.isArray(res.body.reports)).toBe(true);
        // The top-level cursor MIRRORS _meta (a consumer may read either — see
        // lib/db/intel.ts). A wall-clock value here would advance the consumer past
        // the rows a saturated/clamped page deliberately withheld.
        expect(res.body.fetchedAt).toBe('CLAMPED');
        expect(res.body._meta.fetchedAt).toBe('CLAMPED');
    });

    it('an alliance directional key (label alliance:<peerId>) → 403, feed never built', async () => {
        h.apiKey = { id: 2, label: 'alliance:peer-uuid-123' };
        const res = mockRes();
        await handler(mockFeedReq('alliance-inbound-key'), res);
        expect(res.statusCode).toBe(403);
        expect(h.calls.getPublicFeedData).toBe(0);
    });

    it('no key → 401', async () => {
        const res = mockRes();
        await handler(mockFeedReq(), res);
        expect(res.statusCode).toBe(401);
        expect(h.calls.getPublicFeedData).toBe(0);
    });

    it('unknown key → 403', async () => {
        h.apiKey = null;
        const res = mockRes();
        await handler(mockFeedReq('bogus'), res);
        expect(res.statusCode).toBe(403);
        expect(h.calls.getPublicFeedData).toBe(0);
    });
});
