import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Least-privilege coverage for the admin:db:* / voice credential family. The
// non-Admin Dispatcher role is seeded BOTH 'admin:access' (lib/db/seeder.ts
// dispatcherPerms) and 'radio:manage', so any apex/privileged admin action gated
// only at those perms would be Dispatcher-reachable.
//
//  - admin:db:prune — gated on admin:db:destroy rather than admin:access, the
//    handler asserts the genuine Admin role, AND pruneDatabaseData rejects a
//    retentionDays of 0/negative/non-integer (which would mass-DELETE everything).
//  - admin:db:repair (RBAC re-seed / Admin promotion) — same treatment.
//  - admin:db:check (count oracle over read-gated intel/hr) — same.
//  - admin:db:reset_finances / admin:db:reset_quartermaster (raw mass DELETEs of
//    the treasury ledger / quartermaster tables) — these had NO handler guard and
//    a DOMAIN perm as their only map value, so a custom role holding finance:manage
//    or qm:manage could fire them. Same treatment as the rest of the family now,
//    plus the domain perm re-asserted in the handler (tests/adminDbResetAuthz).
//  - admin:update_radio_config (LiveKit url/apiKey/apiSecret write) — the handler
//    asserts the genuine Admin role so radio:manage (held by Dispatcher for
//    channel CRUD / reboot) can no longer overwrite the voice credentials.
// =============================================================================

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    // Real pruneDatabaseData (lib/db/system) → mocked supabase: record any DELETE.
    pruneDeletes: [] as string[],
    // Mocked db barrel spies used by the admin action handlers + dispatcher.
    spies: {
        // The org-ban gate runs on every authenticated dispatcher request; null = not banned.
        findActiveBan: async () => null,
        getPlatformSettings: vi.fn(async () => ({}) as Record<string, unknown>),
        getUserById: vi.fn(async () => h.user),
        updateRadioConfig: vi.fn(async (..._a: unknown[]) => {}),
        runDatabaseHealthCheck: vi.fn(async () => [{ check: 'x', status: 'OK', count: 1 }]),
        repairDatabase: vi.fn(async () => ({ success: true })),
        pruneDatabaseData: vi.fn(async (..._a: unknown[]) => ({})),
        resetFinancesData: vi.fn(async () => ({ success: true })),
        resetQuartermasterData: vi.fn(async () => ({ success: true })),
        // Cache-free Admin-identity re-check used by the RECOVERY family
        // (check/repair/prune, maintenance toggle, force-logout-all). Default false
        // so only the stamped flag admits — flip per-test to model the post-import
        // window where the memo is stale but the actor really is the Admin.
        resolveIsSystemAdminFresh: vi.fn(async (_roleId?: number) => false),
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

// Barrel mock — drives the admin action handlers + the dispatcher path.
vi.mock('../lib/db', () => ({
    // The org-ban gate reads this on EVERY authenticated dispatcher request.
    findActiveBan: async () => null,
    supabase: sbBuilder(),
    getPlatformSettings: h.spies.getPlatformSettings,
    getUserById: h.spies.getUserById,
    updateRadioConfig: h.spies.updateRadioConfig,
    runDatabaseHealthCheck: h.spies.runDatabaseHealthCheck,
    repairDatabase: h.spies.repairDatabase,
    pruneDatabaseData: h.spies.pruneDatabaseData,
    resetFinancesData: h.spies.resetFinancesData,
    resetQuartermasterData: h.spies.resetQuartermasterData,
    resolveIsSystemAdminFresh: h.spies.resolveIsSystemAdminFresh,
}));

// Mock the REAL system.ts's deps so importing it for the pruneDatabaseData unit
// test is side-effect-free and its supabase DELETEs are observable.
vi.mock('../lib/db/common', () => {
    const make = (table: string) => {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'order', 'limit', 'gt', 'lt', 'in', 'single', 'maybeSingle']) {
            b[m] = () => b;
        }
        b.delete = () => { h.pruneDeletes.push(table); return b; };
        (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ count: 0, error: null });
        return b;
    };
    return {
        supabase: { from: (t: string) => make(t), rpc: () => Promise.resolve({ error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});
vi.mock('../lib/push', () => ({ sendPushToAll: () => {}, sendPushToStaff: () => {}, sendPushToPermission: () => {} }));
vi.mock('../lib/cache', () => ({ cache: { invalidate: () => {}, invalidatePrefix: () => {}, get: () => undefined, set: () => {} }, TTL: {} }));
vi.mock('../lib/db/seeder', () => ({ seedNewOrganization: async () => {}, seedInstall: async () => {} }));

// Import AFTER mocks are registered.
import handler, { fullPermissionMap } from '../api/services';
import { adminActions } from '../api/actions/admin';
import { pruneDatabaseData } from '../lib/db/system';

type Handler = (p: unknown) => unknown;
const dbCheck = (adminActions as Record<string, Handler>)['admin:db:check'];
const dbRepair = (adminActions as Record<string, Handler>)['admin:db:repair'];
const dbPrune = (adminActions as Record<string, Handler>)['admin:db:prune'];
const dbResetFinances = (adminActions as Record<string, Handler>)['admin:db:reset_finances'];
const dbResetQm = (adminActions as Record<string, Handler>)['admin:db:reset_quartermaster'];
const updateRadio = (adminActions as Record<string, Handler>)['admin:update_radio_config'];

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
function mockReq(action: string, payload: unknown, token = 'tok') {
    return { method: 'POST', secure: false, query: {}, headers: { authorization: `Bearer ${token}` }, body: { action, payload } } as any;
}

beforeEach(() => {
    h.decoded = null;
    h.user = null;
    h.pruneDeletes = [];
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Permission-map: the whole admin:db:* maintenance family is off bare admin:access
// (the Dispatcher-held perm) and onto the high-bar, NOT-seeded admin:db:destroy.
// ---------------------------------------------------------------------------
describe('admin-family — admin:db:* maps to admin:db:destroy, not admin:access', () => {
    it.each(['admin:db:check', 'admin:db:repair', 'admin:db:prune', 'admin:db:reset_finances', 'admin:db:reset_quartermaster'])('%s is gated at admin:db:destroy', (action) => {
        expect(fullPermissionMap[action]).toBe('admin:db:destroy');
        // Guard against regressing to the bare admin:access value (held by Dispatcher).
        expect(fullPermissionMap[action]).not.toBe('admin:access');
        // ...or to a DOMAIN perm, which an org can delegate to a custom role: that
        // was how the two module resets sat outside the family's bar.
        expect(fullPermissionMap[action]).not.toBe('finance:manage');
        expect(fullPermissionMap[action]).not.toBe('qm:manage');
    });

    it('the danger-zone perm stays admin:db:destroy (family parity, not seeded to Dispatcher)', () => {
        expect(fullPermissionMap['admin:db:full_reset']).toBe('admin:db:destroy');
        expect(fullPermissionMap['admin:db:full_wipe']).toBe('admin:db:destroy');
    });
});

// ---------------------------------------------------------------------------
// DB maintenance handlers assert the genuine Admin role (fail-closed backstop).
// ---------------------------------------------------------------------------
describe('admin-family — DB maintenance handlers require the genuine Admin role', () => {
    // check/repair/prune are the RECOVERY family: they assert role IDENTITY and, on
    // the deny path, re-resolve it CACHE-FREE (getSystemRoles is a 5-minute memo the
    // org importer leaves pointing at deleted role ids, and repair is the tool that
    // re-stamps is_system — gating repair on that memo manufactures a lockout). They
    // are therefore async and reject rather than throwing synchronously; the danger
    // zone stays sync (tests/dangerZoneAuthz.test.ts).
    it('admin:db:prune rejects a non-Admin (Dispatcher) and never reaches the DB', async () => {
        await expect(dbPrune({ user: { role: 'Dispatcher' }, retentionDays: 30, targets: ['requests'] })).rejects.toThrow(/only an admin/i);
        expect(h.spies.pruneDatabaseData).not.toHaveBeenCalled();
    });
    it('admin:db:repair rejects a non-Admin (Dispatcher) and never reaches the DB', async () => {
        await expect(dbRepair({ user: { role: 'Dispatcher' } })).rejects.toThrow(/only an admin/i);
        expect(h.spies.repairDatabase).not.toHaveBeenCalled();
    });
    it('admin:db:check rejects a non-Admin (Dispatcher) and never reaches the DB', async () => {
        await expect(dbCheck({ user: { role: 'Dispatcher' } })).rejects.toThrow(/only an admin/i);
        expect(h.spies.runDatabaseHealthCheck).not.toHaveBeenCalled();
    });

    // ROLE NAME IS NOT AUTHORITY: `role` is inferred from the role row's free-text
    // name, so a permissionless custom role called 'Commander' ran repair and prune.
    it('rejects a forged Admin role NAME with no stamped identity', async () => {
        await expect(dbRepair({ user: { role: 'Admin' } })).rejects.toThrow(/only an admin/i);
        await expect(dbCheck({ user: { role: 'Admin' } })).rejects.toThrow(/only an admin/i);
        await expect(dbPrune({ user: { role: 'Admin' }, retentionDays: 30, targets: ['requests'] })).rejects.toThrow(/only an admin/i);
        expect(h.spies.repairDatabase).not.toHaveBeenCalled();
        expect(h.spies.runDatabaseHealthCheck).not.toHaveBeenCalled();
        expect(h.spies.pruneDatabaseData).not.toHaveBeenCalled();
    });

    // The post-import window: the stamped flag is false because getSystemRoles was
    // memoised before SEEDED_PRECLEAR rebuilt `roles`, but the actor IS the Admin.
    // Repair must still be reachable — it is the documented remedy.
    it('admits the real Admin through the cache-free re-check when the stamped flag is stale', async () => {
        h.spies.resolveIsSystemAdminFresh.mockResolvedValueOnce(true);
        await dbRepair({ user: { roleId: 77 } });
        expect(h.spies.repairDatabase).toHaveBeenCalledTimes(1);
        expect(h.spies.resolveIsSystemAdminFresh).toHaveBeenCalledWith(77);
    });
    it('the module resets reject a Dispatcher EVEN holding the domain perm, and delete nothing', () => {
        const dispatcher = { id: 50, role: 'Dispatcher', permissions: ['admin:access', 'finance:manage', 'qm:manage'] };
        expect(() => dbResetFinances({ user: dispatcher })).toThrow(/only an admin/i);
        expect(() => dbResetQm({ user: dispatcher })).toThrow(/only an admin/i);
        expect(h.spies.resetFinancesData).not.toHaveBeenCalled();
        expect(h.spies.resetQuartermasterData).not.toHaveBeenCalled();
    });
    it('rejects a missing/undefined actor (fail closed)', async () => {
        await expect(dbPrune({ retentionDays: 30, targets: ['requests'] })).rejects.toThrow(/only an admin/i);
        await expect(dbRepair({})).rejects.toThrow(/only an admin/i);
        await expect(dbCheck({})).rejects.toThrow(/only an admin/i);
        expect(() => dbResetFinances({})).toThrow(/only an admin/i);
        expect(() => dbResetQm({})).toThrow(/only an admin/i);
    });
    it('a genuine Admin is accepted by each maintenance handler', async () => {
        const admin = { id: 1, isSystemAdmin: true, permissions: ['finance:manage', 'qm:manage'] };
        await dbCheck({ user: { isSystemAdmin: true } });
        await dbRepair({ user: { isSystemAdmin: true } });
        await dbPrune({ user: { isSystemAdmin: true }, retentionDays: 30, targets: ['requests'] });
        // The resets additionally require the domain perm the map value used to
        // carry — an Admin holds every permission, so nothing is lost.
        await dbResetFinances({ user: admin });
        await dbResetQm({ user: admin });
        expect(h.spies.runDatabaseHealthCheck).toHaveBeenCalledTimes(1);
        expect(h.spies.repairDatabase).toHaveBeenCalledTimes(1);
        expect(h.spies.pruneDatabaseData).toHaveBeenCalledWith(30, ['requests']);
        expect(h.spies.resetFinancesData).toHaveBeenCalledTimes(1);
        expect(h.spies.resetQuartermasterData).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// pruneDatabaseData fails closed on a non-positive-integer retention window.
// A cutoff of now/future would DELETE every matching row (full wipe via "prune").
// ---------------------------------------------------------------------------
describe('admin-family — pruneDatabaseData rejects a destructive retention window', () => {
    it.each([0, -1, -30, 1.5, NaN, Number.POSITIVE_INFINITY])('throws on retentionDays=%p and issues NO delete', async (bad) => {
        await expect(pruneDatabaseData(bad as number, ['requests', 'intel', 'operations', 'warrants', 'hr']))
            .rejects.toThrow(/positive integer/i);
        expect(h.pruneDeletes).toEqual([]);
    });
    it.each([undefined, null, '30'])('throws on a non-number retentionDays (%p) and issues NO delete', async (bad) => {
        await expect(pruneDatabaseData(bad as unknown as number, ['requests']))
            .rejects.toThrow(/positive integer/i);
        expect(h.pruneDeletes).toEqual([]);
    });
    it('a valid positive-integer window proceeds and issues the targeted deletes', async () => {
        await pruneDatabaseData(30, ['requests', 'intel']);
        expect(h.pruneDeletes).toEqual(['service_requests', 'intel_reports']);
    });
});

// ---------------------------------------------------------------------------
// Voice-server credential write requires the genuine Admin role, so the
// Dispatcher's radio:manage (channel CRUD / reboot) cannot overwrite LiveKit creds.
// ---------------------------------------------------------------------------
describe('admin-family — LiveKit credential write is Admin-only', () => {
    it('channel CRUD / reboot stay on radio:manage; credential write is NOT loosened past it', () => {
        // Operational channel management remains delegable to Dispatcher.
        for (const a of ['admin:add_radio_channel', 'admin:update_radio_channel', 'admin:delete_radio_channel', 'radio:reboot']) {
            expect(fullPermissionMap[a]).toBe('radio:manage');
        }
        // The credential write keeps the radio:manage map value (so the BOLA gate is
        // shared) but the handler additionally enforces the Admin role (see below).
        expect(fullPermissionMap['admin:update_radio_config']).toBe('radio:manage');
        // It must never be parked in the unrelated branding bucket.
        expect(fullPermissionMap['admin:update_radio_config']).not.toBe('admin:config:branding');
    });

    it('handler rejects a non-Admin (Dispatcher) and never writes the credentials', async () => {
        await expect((updateRadio as (p: unknown) => Promise<unknown>)({
            user: { role: 'Dispatcher' }, url: 'wss://evil', apiKey: 'k', apiSecret: 's',
        })).rejects.toThrow(/only an admin/i);
        expect(h.spies.updateRadioConfig).not.toHaveBeenCalled();
    });

    it('a genuine Admin writes the credentials, with the actor plumbing stripped', async () => {
        await (updateRadio as (p: unknown) => Promise<unknown>)({
            user: { isSystemAdmin: true }, userId: 1, url: 'wss://lk', apiKey: 'k', apiSecret: 's',
        });
        expect(h.spies.updateRadioConfig).toHaveBeenCalledTimes(1);
        const arg = h.spies.updateRadioConfig.mock.calls[0][0] as Record<string, unknown>;
        expect(arg).toMatchObject({ url: 'wss://lk', apiKey: 'k', apiSecret: 's' });
        expect(arg.user).toBeUndefined();
        expect(arg.userId).toBeUndefined();
    });

    it('end-to-end: a Dispatcher holding radio:manage is blocked at the credential write', async () => {
        h.decoded = { userId: 50 };
        h.user = { id: 50, role: 'Dispatcher', permissions: ['radio:manage'], tokensValidFrom: null };
        const res = mockRes();
        await handler(mockReq('admin:update_radio_config', { url: 'wss://evil', apiKey: 'k', apiSecret: 's' }), asResponse(res));

        // radio:manage passes the BOLA gate, but the handler's Admin-role assertion
        // throws → dispatcher returns an error, NOT a 200, and no write occurs.
        expect(res.statusCode).not.toBe(200);
        expect(String(res.body?.message ?? '')).toMatch(/only an admin/i);
        expect(h.spies.updateRadioConfig).not.toHaveBeenCalled();
    });

    it('end-to-end: a genuine Admin writes the credentials (200)', async () => {
        h.decoded = { userId: 1 };
        h.user = { id: 1, isSystemAdmin: true, permissions: ['radio:manage'], tokensValidFrom: null };
        const res = mockRes();
        await handler(mockReq('admin:update_radio_config', { url: 'wss://lk', apiKey: 'k', apiSecret: 's' }), asResponse(res));

        expect(res.statusCode).toBe(200);
        expect(h.spies.updateRadioConfig).toHaveBeenCalledTimes(1);
    });
});
