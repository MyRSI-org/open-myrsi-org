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
        getPlatformSettings: vi.fn(async () => ({}) as Record<string, unknown>),
        getUserById: vi.fn(async () => h.user),
        updateRadioConfig: vi.fn(async (..._a: unknown[]) => {}),
        runDatabaseHealthCheck: vi.fn(async () => [{ check: 'x', status: 'OK', count: 1 }]),
        repairDatabase: vi.fn(async () => ({ success: true })),
        pruneDatabaseData: vi.fn(async (..._a: unknown[]) => ({})),
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
    supabase: sbBuilder(),
    getPlatformSettings: h.spies.getPlatformSettings,
    getUserById: h.spies.getUserById,
    updateRadioConfig: h.spies.updateRadioConfig,
    runDatabaseHealthCheck: h.spies.runDatabaseHealthCheck,
    repairDatabase: h.spies.repairDatabase,
    pruneDatabaseData: h.spies.pruneDatabaseData,
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
    it.each(['admin:db:check', 'admin:db:repair', 'admin:db:prune'])('%s is gated at admin:db:destroy', (action) => {
        expect(fullPermissionMap[action]).toBe('admin:db:destroy');
        // Guard against regressing to the bare admin:access value (held by Dispatcher).
        expect(fullPermissionMap[action]).not.toBe('admin:access');
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
    it('admin:db:prune rejects a non-Admin (Dispatcher) and never reaches the DB', () => {
        expect(() => dbPrune({ user: { role: 'Dispatcher' }, retentionDays: 30, targets: ['requests'] })).toThrow(/only an admin/i);
        expect(h.spies.pruneDatabaseData).not.toHaveBeenCalled();
    });
    it('admin:db:repair rejects a non-Admin (Dispatcher) and never reaches the DB', () => {
        expect(() => dbRepair({ user: { role: 'Dispatcher' } })).toThrow(/only an admin/i);
        expect(h.spies.repairDatabase).not.toHaveBeenCalled();
    });
    it('admin:db:check rejects a non-Admin (Dispatcher) and never reaches the DB', () => {
        expect(() => dbCheck({ user: { role: 'Dispatcher' } })).toThrow(/only an admin/i);
        expect(h.spies.runDatabaseHealthCheck).not.toHaveBeenCalled();
    });
    it('rejects a missing/undefined actor (fail closed)', () => {
        expect(() => dbPrune({ retentionDays: 30, targets: ['requests'] })).toThrow(/only an admin/i);
        expect(() => dbRepair({})).toThrow(/only an admin/i);
        expect(() => dbCheck({})).toThrow(/only an admin/i);
    });
    it('a genuine Admin is accepted by each maintenance handler', async () => {
        await dbCheck({ user: { role: 'Admin' } });
        await dbRepair({ user: { role: 'Admin' } });
        await dbPrune({ user: { role: 'Admin' }, retentionDays: 30, targets: ['requests'] });
        expect(h.spies.runDatabaseHealthCheck).toHaveBeenCalledTimes(1);
        expect(h.spies.repairDatabase).toHaveBeenCalledTimes(1);
        expect(h.spies.pruneDatabaseData).toHaveBeenCalledWith(30, ['requests']);
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
            user: { role: 'Admin' }, userId: 1, url: 'wss://lk', apiKey: 'k', apiSecret: 's',
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
        h.user = { id: 1, role: 'Admin', permissions: ['radio:manage'], tokensValidFrom: null };
        const res = mockRes();
        await handler(mockReq('admin:update_radio_config', { url: 'wss://lk', apiKey: 'k', apiSecret: 's' }), asResponse(res));

        expect(res.statusCode).toBe(200);
        expect(h.spies.updateRadioConfig).toHaveBeenCalledTimes(1);
    });
});
