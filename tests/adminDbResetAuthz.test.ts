import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// admin:db:reset_finances / admin:db:reset_quartermaster — the two module wipes.
//
// lib/db/system.ts resetFinancesData / resetQuartermasterData are raw mass
// DELETEs (every treasury_ledger_entries + treasury_accounts row; every
// quartermaster issuance / movement / inventory / location / custom-catalog row).
// They shipped with NO handler guard at all, under a family comment that claimed
// the whole admin:db:* family was genuine-Admin gated, and their permission-map
// value was a DOMAIN perm (finance:manage / qm:manage) that an org can delegate
// to a custom role. Neither is covered by the optional-feature gate either:
// api/services.ts prefix-matches the ACTION against OPTIONAL_FEATURE_NAMESPACES,
// and 'admin:db:reset_finances'.startsWith('finance:') is false — so the wipe was
// reachable even on an install where the module was never enabled. The buttons
// already render for any admin:access holder (AdminPanelView gates the tab on it;
// DatabaseToolsTab has no check of its own), so the server gates are all there is.
//
// THREE gates now, pinned here in both directions (Admin keeps access; a
// Dispatcher and a domain-perm-only custom role gain none):
//   1. dispatcher permission map -> admin:db:destroy (family parity; NOT seeded to
//      Dispatcher, and not a perm a module role would ever hold)
//   2. handler -> the genuine Admin role (assertAdminRole, as for check/repair/prune)
//   3. handler -> the domain's own management perm, the competence bar the map
//      value used to carry alone ("a finance-blind dashboard user must not erase
//      the treasury") — kept, not retired.
// =============================================================================

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    spies: {
        // The org-ban gate runs on every authenticated dispatcher request; null = not banned.
        findActiveBan: async () => null,
        getPlatformSettings: vi.fn(async () => ({}) as Record<string, unknown>),
        getUserById: vi.fn(async () => h.user),
        resetFinancesData: vi.fn(async () => ({ success: true })),
        resetQuartermasterData: vi.fn(async () => ({ success: true })),
        // Present so a regression that DID route these through the module-off gate
        // would be visible: today it is never consulted for an 'admin:' action.
        isOptionalFeatureEnabled: vi.fn(async () => false),
    },
}));

// Chainable awaitable stub for the barrel's `supabase` (the dispatcher may probe).
function sbBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'lt', 'in', 'update', 'delete', 'insert', 'single', 'maybeSingle']) {
        b[m] = () => b;
    }
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return b;
}

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    isSessionForceLoggedOut: () => false,
    isSessionRevokedByWatermark: () => false,
}));

vi.mock('../lib/db', () => ({
    // The org-ban gate reads this on EVERY authenticated dispatcher request.
    findActiveBan: async () => null,
    supabase: sbBuilder(),
    getPlatformSettings: h.spies.getPlatformSettings,
    getUserById: h.spies.getUserById,
    resetFinancesData: h.spies.resetFinancesData,
    resetQuartermasterData: h.spies.resetQuartermasterData,
    isOptionalFeatureEnabled: h.spies.isOptionalFeatureEnabled,
}));

// Import AFTER the mocks are registered.
import handler, { fullPermissionMap, OPTIONAL_FEATURE_NAMESPACES } from '../api/services';
import { adminActions } from '../api/actions/admin';

type Handler = (p: unknown) => unknown;
const resetFinances = (adminActions as Record<string, Handler>)['admin:db:reset_finances'];
const resetQm = (adminActions as Record<string, Handler>)['admin:db:reset_quartermaster'];

type Res = {
    statusCode: number;
    body: any;
    headers: Record<string, string>;
    status: (c: number) => Res;
    json: (b: unknown) => Res;
    setHeader: (k: string, v: string) => Res;
};
function mockRes(): Res {
    const res = { statusCode: 0, body: undefined, headers: {} } as Res;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
const asResponse = (r: Res) => r as unknown as import('express').Response;
function mockReq(action: string, payload: unknown = {}, token = 'tok') {
    return { method: 'POST', secure: false, query: {}, headers: { authorization: `Bearer ${token}` }, body: { action, payload } } as any;
}

// The seeded Dispatcher (lib/db/seeder.ts) already holds admin:access, so it sees
// the Database Tools tab. The two module perms are what an org hands a "Treasurer"
// or a quartermaster lead — the escalation this file exists to refuse.
const DISPATCHER = { id: 50, role: 'Dispatcher', permissions: ['admin:access', 'finance:manage', 'qm:manage'], tokensValidFrom: null };
const TREASURER = { id: 51, role: 'Treasurer', permissions: ['finance:view', 'finance:manage'], tokensValidFrom: null };
const QM_LEAD = { id: 52, role: 'Quartermaster', permissions: ['qm:view', 'qm:manage'], tokensValidFrom: null };
// The genuine Admin is the STAMPED system Admin role (isSystemAdmin, role IDENTITY
// resolved by getUserById) — never the role NAME, which is operator-supplied free
// text the mapper collapses into a tier.
const ADMIN = { id: 1, role: 'Admin', isSystemAdmin: true, permissions: ['admin:access', 'admin:db:destroy', 'finance:manage', 'qm:manage'], tokensValidFrom: null };

beforeEach(() => {
    h.decoded = null;
    h.user = null;
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Permission map: family parity, off the delegable domain perms.
// ---------------------------------------------------------------------------
describe('admin:db reset actions — permission map', () => {
    it.each(['admin:db:reset_finances', 'admin:db:reset_quartermaster'])('%s is gated at admin:db:destroy', (action) => {
        expect(fullPermissionMap[action]).toBe('admin:db:destroy');
        // The three values that would re-open it: the delegable domain perms and
        // the bare dashboard perm the Dispatcher is seeded.
        expect(fullPermissionMap[action]).not.toBe('finance:manage');
        expect(fullPermissionMap[action]).not.toBe('qm:manage');
        expect(fullPermissionMap[action]).not.toBe('admin:access');
    });

    it('the whole admin:db:* family shares one high bar (no odd one out)', () => {
        const family = Object.keys(fullPermissionMap).filter(a => a.startsWith('admin:db:'));
        expect(family.length).toBeGreaterThanOrEqual(7);
        for (const a of family) expect(fullPermissionMap[a]).toBe('admin:db:destroy');
    });

    it('the optional-feature gate does NOT cover them (so the map is the only dispatcher gate)', () => {
        for (const action of ['admin:db:reset_finances', 'admin:db:reset_quartermaster']) {
            expect(Object.keys(OPTIONAL_FEATURE_NAMESPACES).some(p => action.startsWith(p))).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// 2. Handler bar 1 — the genuine Admin role (the backstop the family comment
//    always claimed, and these two never had).
// ---------------------------------------------------------------------------
describe('admin:db reset handlers — genuine Admin role required', () => {
    it('rejects a Dispatcher holding finance:manage + qm:manage, and never reaches the DB', () => {
        expect(() => resetFinances({ user: DISPATCHER })).toThrow(/only an admin/i);
        expect(() => resetQm({ user: DISPATCHER })).toThrow(/only an admin/i);
        expect(h.spies.resetFinancesData).not.toHaveBeenCalled();
        expect(h.spies.resetQuartermasterData).not.toHaveBeenCalled();
    });

    it('rejects a custom role that holds ONLY the domain perm', () => {
        expect(() => resetFinances({ user: TREASURER })).toThrow(/only an admin/i);
        expect(() => resetQm({ user: QM_LEAD })).toThrow(/only an admin/i);
        expect(h.spies.resetFinancesData).not.toHaveBeenCalled();
        expect(h.spies.resetQuartermasterData).not.toHaveBeenCalled();
    });

    it('rejects a missing/undefined actor and a near-miss role string (fail closed)', () => {
        expect(() => resetFinances({})).toThrow(/only an admin/i);
        expect(() => resetQm({})).toThrow(/only an admin/i);
        expect(() => resetFinances({ user: { role: 'admin', permissions: ['finance:manage'] } })).toThrow(/only an admin/i);
        expect(h.spies.resetFinancesData).not.toHaveBeenCalled();
        expect(h.spies.resetQuartermasterData).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 3. Handler bar 2 — the domain-competence perm, preserved rather than retired
//    when the map value moved to the generic high bar.
// ---------------------------------------------------------------------------
describe('admin:db reset handlers — the domain management perm is still required', () => {
    it('an Admin without the domain perm is refused, and nothing is deleted', () => {
        const financeBlind = { id: 2, isSystemAdmin: true, permissions: ['admin:db:destroy', 'qm:manage'] };
        const qmBlind = { id: 3, isSystemAdmin: true, permissions: ['admin:db:destroy', 'finance:manage'] };
        expect(() => resetFinances({ user: financeBlind })).toThrow(/permission to reset this module/i);
        expect(() => resetQm({ user: qmBlind })).toThrow(/permission to reset this module/i);
        expect(h.spies.resetFinancesData).not.toHaveBeenCalled();
        expect(h.spies.resetQuartermasterData).not.toHaveBeenCalled();
    });

    it('the bars are per-domain — finance:manage does not unlock the quartermaster wipe', async () => {
        const financeOnlyAdmin = { id: 4, isSystemAdmin: true, permissions: ['finance:manage'] };
        expect(() => resetQm({ user: financeOnlyAdmin })).toThrow(/permission to reset this module/i);
        expect(h.spies.resetQuartermasterData).not.toHaveBeenCalled();
        await (resetFinances as (p: unknown) => Promise<unknown>)({ user: financeOnlyAdmin });
        expect(h.spies.resetFinancesData).toHaveBeenCalledTimes(1);
    });

    it('a null/absent permissions array fails closed', () => {
        expect(() => resetFinances({ user: { id: 5, isSystemAdmin: true, permissions: null } })).toThrow(/permission to reset this module/i);
        expect(() => resetQm({ user: { id: 5, isSystemAdmin: true } })).toThrow(/permission to reset this module/i);
        expect(h.spies.resetFinancesData).not.toHaveBeenCalled();
        expect(h.spies.resetQuartermasterData).not.toHaveBeenCalled();
    });

    // Bar 1 is role IDENTITY, not the role NAME: a permissionless custom role called
    // 'Commander' (or one literally named 'admin') used to clear assertAdminRole with
    // the domain perm and wipe the treasury.
    it('a forged Admin role NAME holding both domain perms is refused by bar 1', () => {
        const forged = { id: 6, role: 'Admin', permissions: ['finance:manage', 'qm:manage'] };
        expect(() => resetFinances({ user: forged })).toThrow(/only an admin/i);
        expect(() => resetQm({ user: forged })).toThrow(/only an admin/i);
        expect(h.spies.resetFinancesData).not.toHaveBeenCalled();
        expect(h.spies.resetQuartermasterData).not.toHaveBeenCalled();
    });

    it('a genuine Admin holding the domain perm still performs both resets', async () => {
        await (resetFinances as (p: unknown) => Promise<unknown>)({ user: ADMIN });
        await (resetQm as (p: unknown) => Promise<unknown>)({ user: ADMIN });
        expect(h.spies.resetFinancesData).toHaveBeenCalledTimes(1);
        expect(h.spies.resetQuartermasterData).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// 4. End-to-end through the dispatcher — the shape the browser actually takes.
// ---------------------------------------------------------------------------
describe('admin:db reset — end-to-end dispatcher gating', () => {
    it('a Dispatcher granted finance:manage / qm:manage is blocked, and nothing is deleted', async () => {
        for (const action of ['admin:db:reset_finances', 'admin:db:reset_quartermaster']) {
            h.decoded = { userId: DISPATCHER.id };
            h.user = { ...DISPATCHER };
            const res = mockRes();
            await handler(mockReq(action), asResponse(res));
            expect(res.statusCode).toBe(403);
            expect(String(res.body?.message ?? '')).toMatch(/insufficient permissions/i);
        }
        expect(h.spies.resetFinancesData).not.toHaveBeenCalled();
        expect(h.spies.resetQuartermasterData).not.toHaveBeenCalled();
    });

    it('a custom role holding only the domain perm is blocked at the BOLA gate', async () => {
        h.decoded = { userId: TREASURER.id };
        h.user = { ...TREASURER };
        const res = mockRes();
        await handler(mockReq('admin:db:reset_finances'), asResponse(res));
        expect(res.statusCode).toBe(403);
        expect(h.spies.resetFinancesData).not.toHaveBeenCalled();
    });

    it('a non-Admin holding admin:db:destroy is still stopped by the handler backstop', async () => {
        h.decoded = { userId: 60 };
        h.user = { id: 60, role: 'Dispatcher', permissions: ['admin:db:destroy', 'finance:manage'], tokensValidFrom: null };
        const res = mockRes();
        await handler(mockReq('admin:db:reset_finances'), asResponse(res));
        expect(res.statusCode).not.toBe(200);
        expect(String(res.body?.message ?? '')).toMatch(/only an admin/i);
        expect(h.spies.resetFinancesData).not.toHaveBeenCalled();
    });

    it('a genuine Admin still resets both modules (200)', async () => {
        for (const action of ['admin:db:reset_finances', 'admin:db:reset_quartermaster']) {
            h.decoded = { userId: ADMIN.id };
            h.user = { ...ADMIN };
            const res = mockRes();
            await handler(mockReq(action), asResponse(res));
            expect(res.statusCode).toBe(200);
        }
        expect(h.spies.resetFinancesData).toHaveBeenCalledTimes(1);
        expect(h.spies.resetQuartermasterData).toHaveBeenCalledTimes(1);
        // Documented residual: the module-off gate never runs for an 'admin:' action,
        // which is exactly why the dispatcher bar must be the high-bar perm and not
        // the module's own. isOptionalFeatureEnabled returns false here throughout.
        expect(h.spies.isOptionalFeatureEnabled).not.toHaveBeenCalled();
    });
});
