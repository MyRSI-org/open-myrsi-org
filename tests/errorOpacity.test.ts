import { describe, it, expect, vi, beforeEach } from 'vitest';

// End-to-end pin for the RPC 500 catch-alls (api/services.ts). isOpaqueServerError
// classified only Postgrest/Auth/Node-system SHAPES, so a bare native engine error
// — which carries no code/errno/details — fell through and the dispatcher echoed
// V8's machine-generated text verbatim: "Cannot read properties of undefined
// (reading 'setupCompleted')" is a crash report built out of OUR identifiers, and
// on the PUBLIC_ACTIONS path it reached an unauthenticated caller.
//
// Both catch-alls are pinned (public path + authenticated path), plus the two
// non-regressions that bound the fix: Node system errors stay opaque, and the
// deliberate `throw new Error('user copy')` business idiom still reaches the
// client (over-blocking would silently swallow every actionable refusal).
//
// server.ts's /api/admin/import-stream echoes err.message with no classifier and
// is INTENTIONALLY out of scope: Admin-gated, and the message plus the `refused`
// flag is the import wizard's client contract. See the comment at that site.

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    preflightThrows: null as unknown,
    catalogThrows: null as unknown,
}));

function sbBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'update', 'delete', 'insert', 'single', 'maybeSingle']) b[m] = () => b;
    (b as { then: unknown }).then = (done: (v: unknown) => unknown) => done({ data: null, error: null });
    return b;
}

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    isSessionForceLoggedOut: () => false,
    isSessionRevokedByWatermark: () => false,
}));

vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    // The org-ban gate runs on every authenticated dispatcher request; null = not banned.
    findActiveBan: async () => null,
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    isOptionalFeatureEnabled: async () => true,
    getPreflightStatus: async () => { if (h.preflightThrows) throw h.preflightThrows; return {}; },
    listWarehouseCatalog: async () => { if (h.catalogThrows) throw h.catalogThrows; return []; },
}));

import handler from '../api/services';

type Res = { statusCode: number; body: any; headers: Record<string, string>; status: (c: number) => Res; json: (b: unknown) => Res; setHeader: (k: string, v: string) => Res };
function mockRes(): Res {
    const res = { statusCode: 0, body: undefined, headers: {} } as Res;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
const asResponse = (r: Res) => r as unknown as import('express').Response;
function mockReq(action: string, payload: unknown, token?: string) {
    return {
        method: 'POST',
        secure: false,
        query: {},
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: { action, payload },
    } as any;
}

beforeEach(() => {
    h.decoded = null;
    h.user = null;
    h.preflightThrows = null;
    h.catalogThrows = null;
});

describe('RPC 500 catch-all — native engine errors never cross the wire', () => {
    it('PUBLIC path: an unauthenticated system:preflight crash returns a generic message + requestId', async () => {
        h.preflightThrows = new TypeError("Cannot read properties of undefined (reading 'setupCompleted')");
        const res = mockRes();
        await handler(mockReq('system:preflight', {}), asResponse(res));
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('An internal server error occurred.');
        expect(typeof res.body.requestId).toBe('string');
        expect(res.body.requestId.length).toBeGreaterThan(0);
        const wire = JSON.stringify(res.body);
        expect(wire).not.toContain('setupCompleted');
        expect(wire).not.toContain('Cannot read properties');
    });

    it('AUTHENTICATED path: a native crash in an action handler is equally opaque', async () => {
        h.decoded = { userId: 1 };
        h.user = { id: 1, role: 'Member', permissions: ['warehouse:view'] };
        h.catalogThrows = new TypeError("Cannot read properties of null (reading 'quantity')");
        const res = mockRes();
        await handler(mockReq('warehouse:list_catalog', {}, 'tok'), asResponse(res));
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('An internal server error occurred.');
        expect(typeof res.body.requestId).toBe('string');
        const wire = JSON.stringify(res.body);
        expect(wire).not.toContain('quantity');
        expect(wire).not.toContain('Cannot read properties');
    });

    it('non-regression: a Node system error stays opaque (no host/port disclosure)', async () => {
        h.decoded = { userId: 1 };
        h.user = { id: 1, role: 'Member', permissions: ['warehouse:view'] };
        h.catalogThrows = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
            code: 'ECONNREFUSED', errno: -111, syscall: 'connect',
        });
        const res = mockRes();
        await handler(mockReq('warehouse:list_catalog', {}, 'tok'), asResponse(res));
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('An internal server error occurred.');
        expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    });

    it('non-regression: deliberate business copy (plain Error) still reaches the client', async () => {
        h.decoded = { userId: 1 };
        h.user = { id: 1, role: 'Member', permissions: ['warehouse:view'] };
        h.catalogThrows = new Error('Only an Admin may perform this action.');
        const res = mockRes();
        await handler(mockReq('warehouse:list_catalog', {}, 'tok'), asResponse(res));
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('Only an Admin may perform this action.');
    });
});
