import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guards for two operations-cluster leaks:
//
//  Join PIN — the Special Operation join PIN (join_code) must NOT ride the
//       operations read paths down to ordinary members. It is the only barrier to
//       joining a clearance-0 special op, so it is redacted everywhere except for
//       the owner and operations:manage holders (getOperations /
//       getOperationByIdLite / operation:get_details).
//
//  Visibility — special operations are invite-only: their existence + planning
//       content (roe / commander notes / comms plan / tasks / board) is visible
//       ONLY to the owner, operations:manage holders, and ACTIVE participants. A
//       clearance-0 special op must NOT be readable / actionable by every member.
//       Mirrored across the list (canUserSeeOpInList), the slice
//       (getOperationByIdLite), the detail handler (operation:get_details), and
//       sub-resource actions (assertOpVisibleToUser) so the gates can't drift.
//       The join path is the one exemption — a first-time joiner isn't yet a
//       participant, and the PIN is the invite.

const h = vi.hoisted(() => ({
    resolveQuery: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: null as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown },
}));

// db-layer tests drive the real lib/db/ops against a controllable supabase.
vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => Promise.resolve(h.resolveQuery({ table, calls }));
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

// handler test drives the real operation:get_details with a mocked db barrel +
// the real (pure) clearance helpers.
const dbSpies = vi.hoisted(() => ({ getFullOperationDetails: vi.fn() }));
vi.mock('../lib/db', () => dbSpies);
vi.mock('../lib/discord', () => ({
    createGuildScheduledEvent: vi.fn(), deleteGuildScheduledEvent: vi.fn(), updateGuildScheduledEvent: vi.fn(),
    listGuildChannels: vi.fn(), postOperationAnnouncementEmbed: vi.fn(), editOperationAnnouncementEmbed: vi.fn(),
    deleteDiscordChannelMessage: vi.fn(),
}));

import { getOperations, getOperationByIdLite, canUserSeeOpInList, assertOpVisibleToUser } from '../lib/db/ops';
import { operationActions } from '../api/actions/operations';
import type { User } from '../types';

const mkUser = (over: Partial<User> = {}): User => ({
    id: 6, role: 'Member', permissions: [], clearanceLevel: { level: 0 }, limitingMarkers: [],
    ...over,
} as unknown as User);

// A clearance-0 special op with a join PIN. owner is user 5.
const specialOpRow = (over: Record<string, unknown> = {}) => ({
    id: 'op-special', name: 'Black Op', owner_id: 5, status: 'Planning', type: 'Combat',
    created_at: '2026-01-01', clearance_level: 0, limiting_markers: [],
    is_special: true, join_code: 'SECRET-PIN', participants: [] as Array<Record<string, unknown>>,
    ...over,
});

beforeEach(() => {
    h.resolveQuery = () => ({ data: null, error: null });
    dbSpies.getFullOperationDetails.mockReset();
});

// ---------------------------------------------------------------------------
// pure predicate: special-op participation gate
// ---------------------------------------------------------------------------
describe('canUserSeeOpInList — special-op participation gate', () => {
    const opViewer = (over: Record<string, unknown> = {}) =>
        ({ ownerId: 5, clearanceLevel: 0, limitingMarkers: [], isSpecial: true, participants: [], ...over }) as unknown as Parameters<typeof canUserSeeOpInList>[1];

    it('DENIES a clearance-0 special op to a non-owner / non-manager / non-participant member', () => {
        expect(canUserSeeOpInList(mkUser(), opViewer())).toBe(false);
    });
    it('allows the owner', () => {
        expect(canUserSeeOpInList(mkUser({ id: 5 }), opViewer())).toBe(true);
    });
    it('allows an operations:manage holder', () => {
        expect(canUserSeeOpInList(mkUser({ permissions: ['operations:manage'] }), opViewer())).toBe(true);
    });
    it('allows an Admin', () => {
        expect(canUserSeeOpInList(mkUser({ role: 'Admin' } as Partial<User>), opViewer())).toBe(true);
    });
    it('allows an ACTIVE participant', () => {
        expect(canUserSeeOpInList(mkUser(), opViewer({ participants: [{ userId: 6, timeLeft: null }] }))).toBe(true);
    });
    it('still DENIES a participant who has LEFT (timeLeft set)', () => {
        expect(canUserSeeOpInList(mkUser(), opViewer({ participants: [{ userId: 6, timeLeft: '2026-01-02' }] }))).toBe(false);
    });
    it('regression: a NON-special clearance-0 op stays visible to an ordinary member', () => {
        expect(canUserSeeOpInList(mkUser(), opViewer({ isSpecial: false }))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// list path (getOperations / getOperationsState)
// ---------------------------------------------------------------------------
describe('getOperations — list redaction + special-op exclusion', () => {
    it('EXCLUDES a clearance-0 special op for a non-participant member', async () => {
        h.resolveQuery = () => ({ data: [specialOpRow({ participants: [] })], error: null });
        const ops = await getOperations(mkUser());
        expect(ops).toHaveLength(0);
    });

    it('shows the special op to an active participant but REDACTS the join PIN', async () => {
        h.resolveQuery = () => ({ data: [specialOpRow({ participants: [{ user_id: 6 }] })], error: null });
        const ops = await getOperations(mkUser());
        expect(ops).toHaveLength(1);
        expect(ops[0].joinCode).toBeUndefined();
    });

    it('gives the owner the real join PIN', async () => {
        h.resolveQuery = () => ({ data: [specialOpRow()], error: null });
        const ops = await getOperations(mkUser({ id: 5 }));
        expect(ops).toHaveLength(1);
        expect(ops[0].joinCode).toBe('SECRET-PIN');
    });

    it('gives an operations:manage holder the real join PIN', async () => {
        h.resolveQuery = () => ({ data: [specialOpRow()], error: null });
        const ops = await getOperations(mkUser({ permissions: ['operations:manage'] }));
        expect(ops).toHaveLength(1);
        expect(ops[0].joinCode).toBe('SECRET-PIN');
    });
});

// ---------------------------------------------------------------------------
// slice path (operation_slice → getOperationByIdLite)
// ---------------------------------------------------------------------------
describe('getOperationByIdLite — slice redaction + special-op exclusion', () => {
    it('returns null for a non-participant member on a clearance-0 special op', async () => {
        h.resolveQuery = () => ({ data: specialOpRow({ participants: [] }), error: null });
        expect(await getOperationByIdLite('op-special', mkUser())).toBeNull();
    });

    it('redacts the join PIN for an active participant', async () => {
        h.resolveQuery = () => ({ data: specialOpRow({ participants: [{ user_id: 6 }] }), error: null });
        const op = await getOperationByIdLite('op-special', mkUser());
        expect(op?.id).toBe('op-special');
        expect(op?.joinCode).toBeUndefined();
    });

    it('gives the owner the real PIN', async () => {
        h.resolveQuery = () => ({ data: specialOpRow(), error: null });
        expect((await getOperationByIdLite('op-special', mkUser({ id: 5 })))?.joinCode).toBe('SECRET-PIN');
    });
});

// ---------------------------------------------------------------------------
// sub-resource action gate (assertOpVisibleToUser)
// ---------------------------------------------------------------------------
describe('assertOpVisibleToUser — special-op action gate', () => {
    const opRowFixture = (over: Record<string, unknown> = {}) =>
        ({ id: 'op1', owner_id: 5, is_special: true, clearance_level: 0, limiting_markers: [], ...over });

    it('DENIES a non-participant member from acting on a special op', async () => {
        h.resolveQuery = ({ table }) => {
            if (table === 'operations') return { data: opRowFixture(), error: null };
            return { data: null, error: null }; // operation_participants → no membership
        };
        await expect(assertOpVisibleToUser('op1', mkUser())).rejects.toThrow(/special operation/i);
    });

    it('ALLOWS an active participant to act on a special op', async () => {
        h.resolveQuery = ({ table }) => {
            if (table === 'operations') return { data: opRowFixture(), error: null };
            if (table === 'operation_participants') return { data: { user_id: 6 }, error: null };
            return { data: null, error: null };
        };
        await expect(assertOpVisibleToUser('op1', mkUser())).resolves.toBeUndefined();
    });

    it('EXEMPTS the join path from the participation gate (PIN is the invite)', async () => {
        let participantQueried = false;
        h.resolveQuery = ({ table }) => {
            if (table === 'operations') return { data: opRowFixture(), error: null };
            if (table === 'operation_participants') { participantQueried = true; return { data: null, error: null }; }
            return { data: null, error: null };
        };
        await expect(assertOpVisibleToUser('op1', mkUser(), { isJoinAttempt: true })).resolves.toBeUndefined();
        expect(participantQueried).toBe(false);
    });

    it('regression: a NON-special clearance-0 op stays actionable by an ordinary member', async () => {
        h.resolveQuery = ({ table }) => {
            if (table === 'operations') return { data: opRowFixture({ is_special: false }), error: null };
            return { data: null, error: null };
        };
        await expect(assertOpVisibleToUser('op1', mkUser())).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// detail handler (operation:get_details)
// ---------------------------------------------------------------------------
describe('operation:get_details — special-op deny + PIN redaction', () => {
    const actions = operationActions as Record<string, (p: unknown) => Promise<any>>;
    const detailUser = { id: 6, role: 'Member', permissions: ['operations:view'], clearanceLevel: { level: 0 }, limitingMarkers: [] };

    it('DENIES a non-participant member opening a clearance-0 special op', async () => {
        dbSpies.getFullOperationDetails.mockResolvedValue({
            ownerId: 5, isSpecial: true, clearanceLevel: 0, limitingMarkers: [], participants: [], joinCode: 'PIN', roe: 'secret',
        });
        await expect(actions['operation:get_details']({ operationId: 'op1', user: detailUser }))
            .rejects.toThrow(/special operation/i);
    });

    it('returns the op to an active participant with the PIN redacted', async () => {
        dbSpies.getFullOperationDetails.mockResolvedValue({
            ownerId: 5, isSpecial: true, clearanceLevel: 0, limitingMarkers: [], participants: [{ userId: 6, timeLeft: null }], joinCode: 'PIN',
        });
        const op = await actions['operation:get_details']({ operationId: 'op1', user: detailUser });
        expect(op.joinCode).toBeUndefined();
    });

    it('gives the owner the op with the PIN intact', async () => {
        dbSpies.getFullOperationDetails.mockResolvedValue({
            ownerId: 6, isSpecial: true, clearanceLevel: 0, limitingMarkers: [], participants: [], joinCode: 'PIN',
        });
        const op = await actions['operation:get_details']({ operationId: 'op1', user: detailUser });
        expect(op.joinCode).toBe('PIN');
    });
});
