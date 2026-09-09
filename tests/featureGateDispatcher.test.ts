import { describe, it, expect, vi, beforeEach } from 'vitest';

// End-to-end pin for the DISPATCHER write-path feature gate (api/services.ts). Drives
// the real POST /api/services handler to assert the three load-bearing behaviours the
// structural/predicate tests can't cover:
//   1. a toggled-OFF module 403s its whole namespace — even for a permission HOLDER
//      (the gate runs BEFORE the BOLA/permission gate, so it's role-independent);
//   2. the feature gate does NOT replace RBAC — an enabled module still needs the perm;
//   3. an `exempt` action (gov:update_feature_config) passes the gate while its module
//      is OFF, so a disabled module can always be turned back on (no self-lockout).

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    enabled: {} as Record<string, boolean>,
    enabledCalls: [] as string[],
    calls: { listWarehouseCatalog: 0, updateGovernmentsConfig: 0 },
}));

function sbBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'update', 'delete', 'insert', 'single', 'maybeSingle']) b[m] = () => b;
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
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
    isOptionalFeatureEnabled: async (f: string) => { h.enabledCalls.push(f); return h.enabled[f] ?? false; },
    listWarehouseCatalog: async () => { h.calls.listWarehouseCatalog++; return []; },
    updateGovernmentsConfig: async () => { h.calls.updateGovernmentsConfig++; return undefined; },
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
function mockReq(action: string, payload: unknown, token = 'tok') {
    return { method: 'POST', secure: false, query: {}, headers: { authorization: `Bearer ${token}` }, body: { action, payload } } as any;
}

beforeEach(() => {
    h.decoded = { userId: 1 };
    h.user = { id: 1, role: 'Member', permissions: [] };
    h.enabled = {};
    h.enabledCalls = [];
    h.calls = { listWarehouseCatalog: 0, updateGovernmentsConfig: 0 };
});

describe('feature gate — dispatcher write path', () => {
    it('a disabled module 403s its namespace action even for a permission HOLDER (gate precedes BOLA)', async () => {
        h.user = { id: 1, role: 'Member', permissions: ['warehouse:view', 'warehouse:manage'] };
        h.enabled = { warehouse: false };
        const res = mockRes();
        await handler(mockReq('warehouse:list_catalog', {}), asResponse(res));
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/Warehouse feature is not enabled/i);
        expect(h.calls.listWarehouseCatalog).toBe(0);
        expect(h.enabledCalls).toContain('warehouse');
    });

    it('an enabled module passes the feature gate and (with the perm) reaches the handler', async () => {
        h.user = { id: 1, role: 'Member', permissions: ['warehouse:view'] };
        h.enabled = { warehouse: true };
        const res = mockRes();
        await handler(mockReq('warehouse:list_catalog', {}), asResponse(res));
        expect(res.statusCode).toBe(200);
        expect(h.calls.listWarehouseCatalog).toBe(1);
    });

    it('the feature gate does NOT replace RBAC — an enabled module still 403s without the permission', async () => {
        h.user = { id: 1, role: 'Member', permissions: [] };
        h.enabled = { warehouse: true };
        const res = mockRes();
        await handler(mockReq('warehouse:list_catalog', {}), asResponse(res));
        expect(res.statusCode).toBe(403);
        expect(h.calls.listWarehouseCatalog).toBe(0);
    });

    it('a non-exempt gov action 403s when Government is OFF', async () => {
        h.user = { id: 1, role: 'Member', permissions: ['gov:view'] };
        h.enabled = { government: false };
        const res = mockRes();
        await handler(mockReq('gov:get_templates', {}), asResponse(res));
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/Government feature is not enabled/i);
    });

    it('the exempt re-enable action passes the gate while Government is OFF (no self-lockout)', async () => {
        h.user = { id: 1, role: 'Member', permissions: ['gov:admin'] };
        h.enabled = { government: false };
        const res = mockRes();
        await handler(mockReq('gov:update_feature_config', { config: { enabled: true } }), asResponse(res));
        expect(res.statusCode).toBe(200);
        expect(h.calls.updateGovernmentsConfig).toBe(1);
        // The exemption short-circuits BEFORE the enable check — government is never consulted.
        expect(h.enabledCalls).not.toContain('government');
    });
});
