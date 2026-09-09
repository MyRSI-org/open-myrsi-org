import { describe, it, expect, vi, beforeEach } from 'vitest';

// Optional-feature gate parity + read-path wiring. The server closes a toggled-off
// optional module server-side in TWO mirrored places: the dispatcher write gate
// (OPTIONAL_FEATURE_NAMESPACES in api/services.ts, 403) and the read gate
// (SUBSET_REQUIRED_FEATURE in api/query.ts, EMPTY 200). This test pins that the two
// registries can't drift apart, that Government's re-enable action stays exempt (no
// self-lockout), and that a disabled subset actually returns empty without touching
// its aggregator.

const h = vi.hoisted(() => ({
    ctx: null as any,
    decoded: null as any,
    user: null as any,
    enabled: {} as Record<string, boolean>,
    enabledCalls: [] as string[],
    calls: { getMarketplaceState: 0, getMyAcademyState: 0 },
}));

function sbBuilder() {
    const b: any = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'single', 'maybeSingle']) b[m] = () => b;
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
    // The read path now runs the ORG BAN GATE above every other gate.
    // Not banned by default; the ban tests drive the real module.
    findActiveBan: async () => null,
    getBanNotice: async () => null,
    getAllSettings: async () => ({}),
    getSystemRoles: async () => ({ admin: { id: 4 } }),
    // Phase 3 item 5: the read path consults db.isClientCaller for every subset in
    // CLIENT_DENIED_SUBSETS (lib/clientNamespaces.ts) — both academy subsets this file
    // drives. A wholesale lib/db mock that omits it throws
    // `db.isClientCaller is not a function` and the failure reads like a handler bug.
    // `false` = a member, which is what memberUser below is; the client-denied direction
    // is pinned in tests/clientNamespaceDenial.test.ts, not here.
    isClientCaller: async () => false,
    isOptionalFeatureEnabled: async (f: string) => { h.enabledCalls.push(f); return h.enabled[f] ?? false; },
    getMarketplaceState: async (_uid: number) => { h.calls.getMarketplaceState++; return { marketplaceCategories: [{ id: 'cat' }], marketplaceListings: [{ id: 'l1' }], marketplaceContracts: [] }; },
    getMyAcademyState: async (_uid: number) => { h.calls.getMyAcademyState++; return { academyCatalog: [{ id: 'course' }], academyMyEnrollments: [] }; },
}));

import handler from '../api/query';
import { SUBSET_REQUIRED_FEATURE, emptyFeatureState } from '../api/query';
import { OPTIONAL_FEATURE_NAMESPACES, PROTECTED_PREFIXES } from '../api/services';

function mockRes() {
    const res: any = { statusCode: 0, body: undefined, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
function mockReq(query: any, token = 'tok') {
    return { method: 'GET', query, headers: token ? { authorization: `Bearer ${token}` } : {} } as any;
}

const TENANT = { type: 'TENANT', organizationId: 'org-1', ownerId: 'owner', slug: 'jims' };
// Member holds marketplace:view (in the seeded Member role) so the perm gate passes
// and the FEATURE gate is what decides marketplace visibility.
const memberUser = { id: 6, organizationId: 'org-1', role: 'Member', permissions: ['marketplace:view'], auth_user_id: 'u6' };

beforeEach(() => {
    h.ctx = TENANT; h.decoded = { userId: 6 }; h.user = memberUser;
    h.enabled = {}; h.enabledCalls = [];
    h.calls = { getMarketplaceState: 0, getMyAcademyState: 0 };
});

describe('optional-feature gate — write/read registry parity (drift guard)', () => {
    const writeFeatures = new Set(Object.values(OPTIONAL_FEATURE_NAMESPACES).map(g => g.feature));

    it('every write-gate prefix is a protected prefix (RBAC still applies after the feature gate)', () => {
        for (const prefix of Object.keys(OPTIONAL_FEATURE_NAMESPACES)) {
            expect(PROTECTED_PREFIXES).toContain(prefix);
        }
    });

    it('every write-gate entry has a feature key, label, and valid source', () => {
        for (const [prefix, gate] of Object.entries(OPTIONAL_FEATURE_NAMESPACES)) {
            expect(gate.feature, `${prefix} feature`).toBeTruthy();
            expect(typeof gate.label, `${prefix} label`).toBe('string');
            expect(['features', 'government'], `${prefix} source`).toContain(gate.source);
        }
    });

    it('only Government uses the governmentsConfig source, and it exempts its own re-enable action', () => {
        const govSourced = Object.entries(OPTIONAL_FEATURE_NAMESPACES).filter(([, g]) => g.source === 'government');
        expect(govSourced.map(([p]) => p)).toEqual(['gov:']);
        const gov = OPTIONAL_FEATURE_NAMESPACES['gov:'];
        expect(gov.feature).toBe('government');
        // Without this exemption, disabling Government would 403 the very action that
        // turns it back on — an irreversible lockout.
        expect(gov.exempt ?? []).toContain('gov:update_feature_config');
    });

    it('features-sourced modules carry no exempt actions; every exempt action sits under its prefix', () => {
        for (const [prefix, gate] of Object.entries(OPTIONAL_FEATURE_NAMESPACES)) {
            if (gate.source === 'features') expect(gate.exempt ?? [], `${prefix} exempt`).toHaveLength(0);
            for (const action of gate.exempt ?? []) expect(action.startsWith(prefix), `${action} under ${prefix}`).toBe(true);
        }
    });

    it('every read-gated feature has a write gate; finances/quartermaster are write-only (no read subset)', () => {
        for (const feature of Object.values(SUBSET_REQUIRED_FEATURE)) {
            expect(writeFeatures, `read feature ${feature}`).toContain(feature);
        }
        const readFeatures = new Set(Object.values(SUBSET_REQUIRED_FEATURE));
        // finances/quartermaster have no /api/query surface — dispatcher-gated only.
        expect(readFeatures.has('finances')).toBe(false);
        expect(readFeatures.has('quartermaster')).toBe(false);
        // Everything else with a read surface is covered.
        expect(readFeatures.has('marketplace')).toBe(true);
        expect(readFeatures.has('warehouse')).toBe(true);
        expect(readFeatures.has('academy')).toBe(true);
        expect(readFeatures.has('government')).toBe(true);
    });

    it('emptyFeatureState returns a non-empty shape for every gated read subset, {} otherwise', () => {
        for (const subset of Object.keys(SUBSET_REQUIRED_FEATURE)) {
            const shape = emptyFeatureState(subset);
            expect(Object.keys(shape).length, `${subset} empty shape`).toBeGreaterThan(0);
        }
        expect(emptyFeatureState('main')).toEqual({});
        expect(emptyFeatureState('warrants')).toEqual({});
    });
});

describe('optional-feature gate — read path returns EMPTY (never data) when disabled', () => {
    it('marketplace OFF → 200 empty payload, aggregator never called', async () => {
        h.enabled = { marketplace: false };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'marketplace' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ marketplaceCategories: [], marketplaceListings: [], marketplaceContracts: [] });
        expect(h.calls.getMarketplaceState).toBe(0);
        expect(h.enabledCalls).toContain('marketplace');
    });

    it('marketplace ON → 200 with real data (aggregator called once)', async () => {
        h.enabled = { marketplace: true };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'marketplace' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.marketplaceListings).toHaveLength(1);
        expect(h.calls.getMarketplaceState).toBe(1);
    });

    it('academy_my (permission-LESS member surface) OFF → 200 empty, aggregator never called', async () => {
        h.enabled = { academy: false };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'academy_my' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ academyCatalog: [], academyMyEnrollments: [] });
        expect(h.calls.getMyAcademyState).toBe(0);
    });

    it('academy_my ON → 200 with the catalog (aggregator called)', async () => {
        h.enabled = { academy: true };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'academy_my' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.academyCatalog).toHaveLength(1);
        expect(h.calls.getMyAcademyState).toBe(1);
    });
});
