import { describe, it, expect, vi, beforeEach } from 'vitest';

// Ship-ownership BOLA (HANDOFF s4-2a/s4-2b): a user_ships row id is enumerable,
// so binding a ship to operation participation must verify the ship belongs to
// the user that participation is for. joinOperation/rsvpOperation check the
// caller; updateOperationParticipant checks the target + requires the target to
// already be a participant.

const h = vi.hoisted(() => ({
    resolveQuery: (() => ({ data: null as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown },
    queries: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    rpcResult: { data: null as unknown, error: null as unknown },
    rpcCalls: [] as Array<{ fn: string; args: unknown }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'lte', 'ilike', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => { const q = { table, calls }; h.queries.push(q); return Promise.resolve(h.resolveQuery(q)); };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: unknown) => { h.rpcCalls.push({ fn, args }); return Promise.resolve(h.rpcResult); },
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
    };
});
vi.mock('../lib/db/operations-federation', () => ({
    bumpOperationVersion: vi.fn(async () => undefined),
    pushOperationToAllies: vi.fn(async () => undefined),
    scheduleAlliedPush: vi.fn(() => undefined),
}));
vi.mock('../lib/push', () => ({ sendPushToUsers: vi.fn(async () => undefined) }));
vi.mock('../lib/db/users', () => ({
    getUserById: vi.fn(async () => ({ id: 1, name: 'Actor' })),
    // ops.ts reads the LABEL, not the user, for post-commit log attribution.
    getActorLabel: vi.fn(async () => 'Actor'),
}));

import { rsvpOperation, joinOperation, updateOperationParticipant, createOperation } from '../lib/db/ops';

// Route reads by table; record participation update writes.
function route(opts: { shipOwner?: number | null; participantExists?: boolean }) {
    h.resolveQuery = (q) => {
        if (q.table === 'operations') return { data: { is_joint: false, is_special: false, join_code: null, max_participants: null }, error: null };
        if (q.table === 'user_ships') return { data: opts.shipOwner == null ? null : { user_id: opts.shipOwner }, error: null };
        if (q.table === 'operation_participants') {
            // precheck select → existence; the write returns ok
            const isSelect = q.calls.some((c) => c.method === 'select') && !q.calls.some((c) => c.method === 'update' || c.method === 'upsert');
            if (isSelect) return { data: opts.participantExists ? { user_id: 7 } : null, error: null };
        }
        return { data: null, error: null };
    };
}

beforeEach(() => { h.queries = []; h.rpcCalls = []; h.rpcResult = { data: null, error: null }; route({}); });

describe('joinOperation capacity race (race-1) — atomic RPC', () => {
    it('routes the join through the op_join_participant RPC (FOR UPDATE)', async () => {
        route({ shipOwner: 1 });
        await joinOperation('op-1', 1, undefined, 'Pilot', 'Gladius', undefined, 55);
        expect(h.rpcCalls.some((c) => c.fn === 'op_join_participant')).toBe(true);
    });
    it('maps the RPC operation_full error to a friendly message', async () => {
        route({ shipOwner: 1 });
        h.rpcResult = { data: null, error: { message: 'operation_full' } };
        await expect(joinOperation('op-1', 1, undefined, 'Pilot', 'Gladius', undefined, 55)).rejects.toThrow(/operation is full/i);
    });
    it('falls back to the non-atomic path when the RPC is not deployed', async () => {
        route({ shipOwner: 1 });
        h.rpcResult = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
        // op (operations select) has no max_participants in route() → fallback upsert proceeds.
        await expect(joinOperation('op-1', 1, undefined, 'Pilot', 'Gladius', undefined, 55)).resolves.toBeUndefined();
        const upsert = h.queries.find((q) => q.table === 'operation_participants' && q.calls.some((c) => c.method === 'upsert'));
        expect(upsert).toBeTruthy();
    });
});

describe('joinOperation / rsvpOperation own-ship scoping (s4-2a)', () => {
    it('rsvpOperation rejects a ship the caller does not own', async () => {
        route({ shipOwner: 999 }); // caller is userId 1
        await expect(rsvpOperation('op-1', 1, 'Yes', undefined, 55)).rejects.toThrow(/does not belong/i);
    });
    it('rsvpOperation accepts the caller-owned ship', async () => {
        route({ shipOwner: 1 });
        await expect(rsvpOperation('op-1', 1, 'Yes', undefined, 55)).resolves.toBeUndefined();
    });
    it('joinOperation rejects a ship the caller does not own', async () => {
        route({ shipOwner: 999 });
        await expect(joinOperation('op-1', 1, undefined, 'Pilot', 'Gladius', undefined, 55)).rejects.toThrow(/does not belong/i);
    });
});

describe('createOperation owner precedence (s4-7a) — forced userId wins over client ownerId', () => {
    it('writes owner_id = authenticated userId, ignoring a spoofed client ownerId', async () => {
        h.queries = [];
        h.resolveQuery = (q) => {
            if (q.table === 'operations') return { data: { id: 'op-new', owner_id: 7, name: 'X', clearance_level: 0, status: 'Planning', is_joint: false }, error: null };
            return { data: null, error: null };
        };
        // userId 7 is the dispatcher-forced actor; ownerId 999 is an attacker-supplied victim.
        await createOperation({ userId: 7, ownerId: 999, name: 'X', type: 'PvE', clearanceLevel: 0 } as any);
        const insert = h.queries.find((q) => q.table === 'operations' && q.calls.some((c) => c.method === 'insert'));
        const payload = insert?.calls.find((c) => c.method === 'insert')?.args[0] as { owner_id?: number };
        expect(payload?.owner_id).toBe(7);
    });
});

describe('updateOperationParticipant precheck + ship ownership (s4-2b)', () => {
    it('rejects when the target is not already a participant', async () => {
        route({ participantExists: false });
        await expect(updateOperationParticipant('op-1', 7, { attendanceStatus: 'Confirmed' })).rejects.toThrow(/not a participant/i);
    });
    it('rejects a ship not owned by the target participant', async () => {
        route({ participantExists: true, shipOwner: 999 });
        await expect(updateOperationParticipant('op-1', 7, { userShipId: 55 })).rejects.toThrow(/does not belong/i);
    });
    it('accepts when target is a participant and owns the ship', async () => {
        route({ participantExists: true, shipOwner: 7 });
        await expect(updateOperationParticipant('op-1', 7, { userShipId: 55 })).resolves.toBeUndefined();
    });
});
