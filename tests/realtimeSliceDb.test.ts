import { describe, it, expect, vi, beforeEach } from 'vitest';

// Server half of the realtime slice-update contract:
//   1. getUsersByIdsLite / getOperationByIdLite THROW on query errors instead
//      of returning []/null — the client merge treats requested-but-absent as
//      "deleted" and EVICTS the row, so a silent fallback on a transient DB
//      blip would mass-evict live users/ops from every connected client.
//   2. canUserSeeOpInList enforces owner + clearance LEVEL + limiting MARKERS
//      (+ operations:manage / Admin bypass) — the same gate as
//      operation:get_details, shared with getOperations so list and slice
//      visibility can never drift.
//   3. Bulk mutations ship the successfully-updated userIds on their
//      user_update broadcast (and ONLY those — skipped ids must not be
//      included, or the client would request-and-evict them).
//   4. getUserById — the session resolver for both server surfaces — separates
//      "no such row" (PGRST116 → null) from "the read failed" (throw), and the
//      getActorLabel wrapper keeps post-commit audit-log attribution tolerant.

const h = vi.hoisted(() => ({
    // Called for every awaited query; tests swap it per scenario.
    resolveQuery: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: null as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown; count?: number },
    queryCount: 0,
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => { h.queryCount++; return Promise.resolve(h.resolveQuery({ table, calls })); };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        // Mirrors the real helper's contract: throws when an error is present.
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
            if (error) throw new Error(message);
        },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ event, payload }); },
        broadcastToChannel: () => {},
        getSystemRoles: async () => ({
            client: { id: 1, name: 'Client' }, member: { id: 2, name: 'Member' },
            dispatcher: { id: 3, name: 'Dispatcher' }, admin: { id: 4, name: 'Admin' },
        }),
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

import { getUsersByIdsLite, bulkSetUsersVip, getUserById, getActorLabel } from '../lib/db/users';
import { getOperationByIdLite, canUserSeeOpInList } from '../lib/db/ops';
import type { User, HydratedOperation } from '../types';

beforeEach(() => {
    h.resolveQuery = () => ({ data: null, error: null });
    h.queryCount = 0;
    h.broadcasts = [];
});

const liteRow = (id: number, name: string) => ({
    id, name, discord_id: `d${id}`, created_at: '2026-01-01',
    role: { id: 2, name: 'Member', description: '', role_permissions: [] },
});

describe('getUsersByIdsLite', () => {
    it('returns roster-shaped users filtered to the requested ids + deleted_at null', async () => {
        let captured: any = null;
        h.resolveQuery = (q) => { captured = q; return { data: [liteRow(7, 'Seven')], error: null }; };
        const users = await getUsersByIdsLite([7]);
        expect(users).toHaveLength(1);
        expect(users[0].id).toBe(7);
        expect(users[0].name).toBe('Seven');
        expect(users[0].role).toBe('Member');
        expect(captured.table).toBe('users');
        expect(captured.calls).toContainEqual({ method: 'in', args: ['id', [7]] });
        expect(captured.calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    });

    it('THROWS on a query error (never a silent [] that would evict live users)', async () => {
        h.resolveQuery = () => ({ data: null, error: { message: 'transient blip' } });
        await expect(getUsersByIdsLite([1, 2, 3])).rejects.toThrow(/users slice/i);
    });

    it('returns [] for an empty id list without querying', async () => {
        h.resolveQuery = () => { throw new Error('should not query'); };
        expect(await getUsersByIdsLite([])).toEqual([]);
        expect(h.queryCount).toBe(0);
    });
});

// getUserById is the session resolver on BOTH server surfaces. Returning null
// for a read FAULT as well as for genuine absence let a DB blip masquerade as a
// deletion: api/services.ts turns null into a 401 whose only client handling is
// to CLEAR the session token, so a transient Postgres error logged the whole org
// out; api/query.ts turns it into a user_detail 404 reading "member deleted".
describe('getUserById fail-closed identity resolution', () => {
    it('THROWS when the read fails — a DB fault must never read as "account not found"', async () => {
        h.resolveQuery = () => ({ data: null, error: { code: '08006', message: 'connection failure' } });
        await expect(getUserById(7)).rejects.toThrow(/failed to load user/i);
    });

    it('returns null on genuine absence (PGRST116) without a wasted fallback round-trip', async () => {
        h.resolveQuery = () => ({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
        expect(await getUserById(7)).toBeNull();
        // The fallback runs the same filters and the same role:roles!inner join,
        // so it cannot find a row the first query missed.
        expect(h.queryCount).toBe(1);
    });

    it('still falls back to the lite projection when only the full query fails', async () => {
        h.resolveQuery = () => (h.queryCount === 1
            ? { data: null, error: { code: '42703', message: 'column does not exist' } }
            : { data: liteRow(7, 'Seven'), error: null });
        expect((await getUserById(7))?.id).toBe(7);
        expect(h.queryCount).toBe(2);
    });

    it('returns null — not a throw — when the fallback PROVES absence after a real first error', async () => {
        h.resolveQuery = () => (h.queryCount === 1
            ? { data: null, error: { code: '42703', message: 'column does not exist' } }
            : { data: null, error: { code: 'PGRST116', message: 'no rows' } });
        expect(await getUserById(7)).toBeNull();
        expect(h.queryCount).toBe(2);
    });

    it('THROWS when BOTH queries fail for a real reason', async () => {
        h.resolveQuery = () => ({ data: null, error: { code: '42703', message: 'column does not exist' } });
        await expect(getUserById(7)).rejects.toThrow(/failed to load user/i);
        expect(h.queryCount).toBe(2);
    });

    it('getActorLabel degrades to "Unknown" instead of throwing — an audit label is not an authorization input', async () => {
        // ops.ts looks the actor up AFTER the mutation committed, and
        // add_uec_to_operation / add_cost_to_operation are not idempotent: a throw
        // here would report a successful aUEC deposit as failed and invite a
        // double-crediting retry.
        h.resolveQuery = () => ({ data: null, error: { code: '08006', message: 'connection failure' } });
        expect(await getActorLabel(7)).toBe('Unknown');
    });

    it('getActorLabel still returns the real name when the read succeeds', async () => {
        h.resolveQuery = () => ({ data: liteRow(7, 'Seven'), error: null });
        expect(await getActorLabel(7)).toBe('Seven');
    });
});

const opRow = (over: Record<string, unknown> = {}) => ({
    id: 'op-1', name: 'Op', owner_id: 5, status: 'active', type: 'general',
    created_at: '2026-01-01', clearance_level: 3, limiting_markers: [],
    ...over,
});

const mkUser = (over: Partial<User> = {}): User => ({
    id: 6, role: 'Member', permissions: [], clearanceLevel: { level: 0 }, limitingMarkers: [],
    ...over,
} as unknown as User);

describe('getOperationByIdLite', () => {
    it('returns the list-shaped op for its owner regardless of clearance', async () => {
        h.resolveQuery = () => ({ data: opRow(), error: null });
        const op = await getOperationByIdLite('op-1', mkUser({ id: 5 }));
        expect(op?.id).toBe('op-1');
        expect(op?.clearanceLevel).toBe(3);
    });

    it('returns null for a non-owner below the clearance level', async () => {
        h.resolveQuery = () => ({ data: opRow(), error: null });
        expect(await getOperationByIdLite('op-1', mkUser())).toBeNull();
    });

    it('returns null when the caller lacks a limiting marker, even at clearance', async () => {
        h.resolveQuery = () => ({ data: opRow({ limiting_markers: [{ marker: { id: 9, name: 'NEEDLE', code: 'NDL' } }] }), error: null });
        const cleared = mkUser({ clearanceLevel: { level: 5 } } as Partial<User>);
        expect(await getOperationByIdLite('op-1', cleared)).toBeNull();
    });

    it('returns the op when the caller holds the limiting marker', async () => {
        h.resolveQuery = () => ({ data: opRow({ limiting_markers: [{ marker: { id: 9, name: 'NEEDLE', code: 'NDL' } }] }), error: null });
        const marked = mkUser({ clearanceLevel: { level: 5 }, limitingMarkers: [{ id: 9, name: 'NEEDLE', code: 'NDL' }] } as Partial<User>);
        expect((await getOperationByIdLite('op-1', marked))?.id).toBe('op-1');
    });

    it('returns null when the row is absent (deleted op)', async () => {
        h.resolveQuery = () => ({ data: null, error: null });
        expect(await getOperationByIdLite('op-gone', mkUser({ permissions: ['operations:manage'] }))).toBeNull();
    });

    it('returns null without querying when user is missing', async () => {
        h.resolveQuery = () => { throw new Error('should not query'); };
        expect(await getOperationByIdLite('op-1', null)).toBeNull();
        expect(h.queryCount).toBe(0);
    });

    it('THROWS on a query error (never a silent null that would evict a live op)', async () => {
        h.resolveQuery = () => ({ data: null, error: { message: 'transient blip' } });
        await expect(getOperationByIdLite('op-1', mkUser())).rejects.toThrow(/operation slice/i);
    });
});

describe('canUserSeeOpInList', () => {
    const opWith = (over: Partial<HydratedOperation> = {}): HydratedOperation => ({
        id: 'op-1', ownerId: 5, clearanceLevel: 3, limitingMarkers: [], ...over,
    } as unknown as HydratedOperation);

    it('owner bypass', () => {
        expect(canUserSeeOpInList(mkUser({ id: 5 }), opWith())).toBe(true);
    });
    it('stamped system Admin bypass (role IDENTITY, not the role name)', () => {
        expect(canUserSeeOpInList(mkUser({ isSystemAdmin: true } as Partial<User>), opWith())).toBe(true);
    });
    it('a forged Admin role NAME with no permissions gets NO bypass', () => {
        expect(canUserSeeOpInList(mkUser({ role: 'Admin' } as Partial<User>), opWith())).toBe(false);
    });
    it('operations:manage bypass', () => {
        expect(canUserSeeOpInList(mkUser({ permissions: ['operations:manage'] }), opWith())).toBe(true);
    });
    it('clearance level gate', () => {
        expect(canUserSeeOpInList(mkUser(), opWith())).toBe(false);
        expect(canUserSeeOpInList(mkUser({ clearanceLevel: { level: 3 } } as Partial<User>), opWith())).toBe(true);
    });
    it('limiting marker gate (level alone is not enough)', () => {
        const markedOp = opWith({ limitingMarkers: [{ id: 9 }] as unknown as HydratedOperation['limitingMarkers'] });
        expect(canUserSeeOpInList(mkUser({ clearanceLevel: { level: 5 } } as Partial<User>), markedOp)).toBe(false);
        expect(canUserSeeOpInList(mkUser({ clearanceLevel: { level: 5 }, limitingMarkers: [{ id: 9 }] } as Partial<User>), markedOp)).toBe(true);
    });
});

describe('bulk user_update broadcasts carry the successfully-updated userIds', () => {
    it('bulkSetUsersVip ships only updated ids — skipped (wrong-role / no-op) ids are excluded', async () => {
        // 10 → Client + not yet VIP → updated; 11 → Member → skipped (role);
        // 12 → Client + already VIP → skipped (no-op).
        h.resolveQuery = (q) => {
            const isSelect = q.calls.some(c => c.method === 'select');
            if (q.table === 'users' && isSelect) {
                const eq = q.calls.find(c => c.method === 'eq');
                const userId = eq?.args[1];
                if (userId === 10) return { data: { role_id: 1, is_vip: false }, error: null };
                if (userId === 11) return { data: { role_id: 2, is_vip: false }, error: null };
                if (userId === 12) return { data: { role_id: 1, is_vip: true }, error: null };
            }
            return { data: null, error: null }; // the update write succeeds
        };
        const result = await bulkSetUsersVip([10, 11, 12], true);
        expect(result).toEqual({ updated: 1, total: 3, skipped: 2 });
        const emit = h.broadcasts.find(b => b.event === 'user_update');
        expect(emit).toBeDefined();
        expect(emit!.payload).toEqual({ bulk: true, count: 1, userIds: [10] });
    });
});
