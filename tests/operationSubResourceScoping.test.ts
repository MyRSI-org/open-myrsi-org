import { describe, it, expect, vi, beforeEach } from 'vitest';

// Ops scoping + clearance tests.
//
// Cross-op write scoping: the update/fulfill siblings of the scoped deletes are
//   also scoped by operation_id and fail closed when operationId is missing, so a
//   foreign childId + own operationId mutates 0 rows.
// operation:update clamp: updateOperationDetails applies the current-visibility
//   guard (passesClearance against the live row) and the author-clearance clamp
//   (assertCanClassify) before writing.
// update_participant_live_status: the handler gates on assertOpVisibleToUser, and
//   the db layer strips HTML from the status.
// operation:leave self path: gates on assertOpVisibleToUser.

const h = vi.hoisted(() => ({
    resolveQuery: (() => ({ data: null as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown },
    queries: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    broadcasts: [] as Array<{ channel: string; event: string; payload: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'lte', 'ilike', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => {
            const q = { table, calls };
            h.queries.push(q);
            return Promise.resolve(h.resolveQuery(q));
        };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: () => Promise.resolve({ data: null, error: null }),
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
            if (error) throw new Error(message);
        },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ channel: 'db-changes', event, payload }); },
        broadcastToChannel: (channel: string, event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ channel, event, payload }); },
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

// ops.ts pulls in federation + push side-effects we don't exercise here.
vi.mock('../lib/db/operations-federation', () => ({
    bumpOperationVersion: vi.fn(async () => undefined),
    pushOperationToAllies: vi.fn(async () => undefined),
    scheduleAlliedPush: vi.fn(() => undefined),
}));
vi.mock('../lib/push', () => ({ sendPushToUsers: vi.fn(async () => undefined) }));
// getActorLabel is invoked for log attribution after a successful write; it
// wraps the (fail-closed, throwing) getUserById so a read fault can't report a
// committed mutation as an error.
vi.mock('../lib/db/users', () => ({
    getUserById: vi.fn(async () => ({ id: 1, name: 'Actor' })),
    // ops.ts reads the LABEL, not the user, for post-commit log attribution.
    getActorLabel: vi.fn(async () => 'Actor'),
}));

// Handler-wiring stubs.
// operations.ts imports the db barrel (../../lib/db.js → '../lib/db' here) and
// lib/discord. The real ops.ts imports ./common (mocked above) and never the
// barrel, so the two mock layers coexist: db-layer tests call the real fns,
// handler-wiring tests assert the handler calls the barrel correctly.
const handlerSpies = vi.hoisted(() => ({
    assertOpVisibleToUser: vi.fn<(opId: string, user: unknown) => Promise<void>>(),
    verifyOperationAccess: vi.fn(async () => undefined),
    updateParticipantLiveStatus: vi.fn(async () => undefined),
    leaveOperation: vi.fn(async () => undefined),
    updateOperationDetails: vi.fn(async () => null),
    broadcastOpChange: vi.fn(async () => undefined),
    supabase: { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }) } as any,
}));
vi.mock('../lib/db', () => handlerSpies);
vi.mock('../lib/discord', () => ({
    createGuildScheduledEvent: vi.fn(), deleteGuildScheduledEvent: vi.fn(), updateGuildScheduledEvent: vi.fn(),
    listGuildChannels: vi.fn(), postOperationAnnouncementEmbed: vi.fn(), editOperationAnnouncementEmbed: vi.fn(),
    deleteDiscordChannelMessage: vi.fn(),
}));

import {
    updateOperationPhase, updateScheduleEntry, updateOperationTask, updateCommandNode,
    updateBoardElement, updateLogisticsItem, fulfillLogisticsItem, updateOperationDetails,
    updateParticipantLiveStatus,
} from '../lib/db/ops';
import { operationActions } from '../api/actions/operations';

type AnyHandler = (p: unknown) => Promise<unknown>;
const action = (name: string) => (operationActions as Record<string, AnyHandler>)[name];

beforeEach(() => {
    h.resolveQuery = () => ({ data: [], error: null });
    h.queries = [];
    h.broadcasts = [];
});

// update/fulfill fns are operation_id-scoped: the UPDATE filters by both the
// child id and operation_id, so a foreign childId + own operationId mutates 0
// rows instead of the foreign op's child.
describe('HIGH-1 — op sub-resource UPDATE/fulfill are scoped by operation_id', () => {
    const OP = 'op-A';
    const FOREIGN_CHILD = 999;

    it('updateOperationPhase scopes the phase UPDATE by operation_id', async () => {
        await updateOperationPhase(FOREIGN_CHILD, { name: 'x' }, OP);
        const q = h.queries.find(q => q.table === 'operation_phases' && q.calls.some(c => c.method === 'update'));
        expect(q?.calls).toContainEqual({ method: 'eq', args: ['id', FOREIGN_CHILD] });
        expect(q?.calls).toContainEqual({ method: 'eq', args: ['operation_id', OP] });
    });

    it('updateOperationPhase scopes the CASCADE updates (tasks + schedule) by operation_id', async () => {
        await updateOperationPhase(FOREIGN_CHILD, { status: 'Completed' }, OP);
        const taskCascade = h.queries.filter(q => q.table === 'operation_tasks' && q.calls.some(c => c.method === 'update'));
        const schedCascade = h.queries.filter(q => q.table === 'operation_schedule_entries' && q.calls.some(c => c.method === 'update'));
        expect(taskCascade.length).toBeGreaterThan(0);
        expect(schedCascade.length).toBeGreaterThan(0);
        for (const q of [...taskCascade, ...schedCascade]) {
            expect(q.calls).toContainEqual({ method: 'eq', args: ['operation_id', OP] });
        }
    });

    it('updateScheduleEntry scopes the UPDATE by operation_id', async () => {
        await updateScheduleEntry(FOREIGN_CHILD, { label: 'x' }, OP);
        const q = h.queries.find(q => q.table === 'operation_schedule_entries' && q.calls.some(c => c.method === 'update'));
        expect(q?.calls).toContainEqual({ method: 'eq', args: ['operation_id', OP] });
    });

    it('updateOperationTask scopes the UPDATE by operation_id', async () => {
        await updateOperationTask(FOREIGN_CHILD, { title: 'x' }, OP);
        const q = h.queries.find(q => q.table === 'operation_tasks' && q.calls.some(c => c.method === 'update'));
        expect(q?.calls).toContainEqual({ method: 'eq', args: ['operation_id', OP] });
    });

    it('updateCommandNode scopes the UPDATE by operation_id', async () => {
        await updateCommandNode(FOREIGN_CHILD, { label: 'x' }, OP);
        const q = h.queries.find(q => q.table === 'operation_command_nodes' && q.calls.some(c => c.method === 'update'));
        expect(q?.calls).toContainEqual({ method: 'eq', args: ['operation_id', OP] });
    });

    it('updateBoardElement scopes the UPDATE by operation_id', async () => {
        await updateBoardElement(FOREIGN_CHILD, { label: 'x' }, OP);
        const q = h.queries.find(q => q.table === 'operation_board_elements' && q.calls.some(c => c.method === 'update'));
        expect(q?.calls).toContainEqual({ method: 'eq', args: ['operation_id', OP] });
    });

    it('updateLogisticsItem scopes the UPDATE by operation_id', async () => {
        await updateLogisticsItem(FOREIGN_CHILD, { itemName: 'x' }, OP);
        const q = h.queries.find(q => q.table === 'operation_logistics' && q.calls.some(c => c.method === 'update'));
        expect(q?.calls).toContainEqual({ method: 'eq', args: ['operation_id', OP] });
    });

    it('fulfillLogisticsItem scopes BOTH the load and the UPDATE by operation_id', async () => {
        h.resolveQuery = () => ({ data: { quantity_fulfilled: 0, quantity_needed: 10 }, error: null });
        await fulfillLogisticsItem(FOREIGN_CHILD, 5, 1, OP);
        const loads = h.queries.filter(q => q.table === 'operation_logistics' && q.calls.some(c => c.method === 'select'));
        const updates = h.queries.filter(q => q.table === 'operation_logistics' && q.calls.some(c => c.method === 'update'));
        expect(loads.length).toBeGreaterThan(0);
        expect(updates.length).toBeGreaterThan(0);
        for (const q of [...loads, ...updates]) {
            expect(q.calls).toContainEqual({ method: 'eq', args: ['operation_id', OP] });
        }
    });
});

// fulfilled_by_user_id is an attribution FK. `data` is a free-form client bag and
// the dispatcher's actor-field overwrite is top-level only (it does not recurse
// into payload.data), so a writable fulfilled_by_user_id let an operations:manage
// holder — or the op's own owner, via the api/services.ts owner bypass — forge a
// fulfilment onto any real user. fulfillLogisticsItem is the only writer.
describe('updateLogisticsItem — fulfilment attribution is not client-writable', () => {
    it('ignores a client-supplied fulfilledByUserId while still applying the real fields', async () => {
        await updateLogisticsItem(7, { itemName: 'Medpen', quantityNeeded: 5, fulfilledByUserId: 4211 }, 'op-A');
        const q = h.queries.find(q => q.table === 'operation_logistics' && q.calls.some(c => c.method === 'update'));
        const payload = q?.calls.find(c => c.method === 'update')?.args[0] as Record<string, unknown> | undefined;
        expect(payload).toBeDefined();
        expect(payload).not.toHaveProperty('fulfilled_by_user_id');
        // ...and the allowlisted fields still land, so a lazy "stop updating at all"
        // regression can't pass this.
        expect(payload?.item_name).toBe('Medpen');
        expect(payload?.quantity_needed).toBe(5);
    });

    it('fulfillLogisticsItem still writes the ACTOR as the fulfiller', async () => {
        h.resolveQuery = () => ({ data: { quantity_fulfilled: 0, quantity_needed: 10 }, error: null });
        await fulfillLogisticsItem(7, 3, 42, 'op-A');
        const q = h.queries.find(q => q.table === 'operation_logistics' && q.calls.some(c => c.method === 'update'));
        const payload = q?.calls.find(c => c.method === 'update')?.args[0] as { fulfilled_by_user_id?: number } | undefined;
        expect(payload?.fulfilled_by_user_id).toBe(42);
    });
});

// Every update/fulfill fn throws before any DB call when operationId is missing
// (mirrors the delete siblings).
describe('HIGH-1 — op sub-resource UPDATE/fulfill require operationId (fail closed)', () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
        ['updateOperationPhase', () => updateOperationPhase(1, { name: 'x' })],
        ['updateScheduleEntry', () => updateScheduleEntry(1, { label: 'x' })],
        ['updateOperationTask', () => updateOperationTask(1, { title: 'x' })],
        ['updateCommandNode', () => updateCommandNode(1, { label: 'x' })],
        ['updateBoardElement', () => updateBoardElement(1, { label: 'x' })],
        ['updateLogisticsItem', () => updateLogisticsItem(1, { itemName: 'x' })],
        ['fulfillLogisticsItem', () => fulfillLogisticsItem(1, 5, 1)],
    ];
    for (const [name, fn] of cases) {
        it(`${name} rejects without operationId and issues no DB query`, async () => {
            await expect(fn()).rejects.toThrow(/operationId is required/);
            expect(h.queries.length).toBe(0);
        });
    }
});

describe('fulfillLogisticsItem clamps the quantity increment', () => {
    beforeEach(() => { h.resolveQuery = () => ({ data: { quantity_fulfilled: 0, quantity_needed: 10 }, error: null }); });

    it('rejects a negative quantity', async () => {
        await expect(fulfillLogisticsItem(1, -5, 1, 'op-A')).rejects.toThrow(/quantity must be/i);
    });
    it('rejects NaN', async () => {
        await expect(fulfillLogisticsItem(1, Number.NaN, 1, 'op-A')).rejects.toThrow(/quantity must be/i);
    });
    it('rejects an absurdly large quantity', async () => {
        await expect(fulfillLogisticsItem(1, 1_000_000_000, 1, 'op-A')).rejects.toThrow(/quantity must be/i);
    });
    it('accepts a sane positive quantity (floored)', async () => {
        await expect(fulfillLogisticsItem(1, 3.9, 1, 'op-A')).resolves.toBeUndefined();
        const q = h.queries.find(q => q.table === 'operation_logistics' && q.calls.some(c => c.method === 'update'));
        // 0 (existing) + floor(3.9) = 3
        const upd = q?.calls.find(c => c.method === 'update')?.args[0] as { quantity_fulfilled?: number } | undefined;
        expect(upd?.quantity_fulfilled).toBe(3);
    });
});

describe('MED — updateOperationDetails clearance clamp + visibility guard', () => {
    // Live op is classified at level 3 with one compartment marker.
    const liveRow = {
        id: 'op-A',
        clearance_level: 3,
        limiting_markers: [{ marker: { id: 7, code: 'NOFORN', name: 'NOFORN' } }],
    };
    beforeEach(() => { h.resolveQuery = () => ({ data: liveRow, error: null }); });

    const lowActor = { id: 5, role: 'Member', permissions: ['operations:create'], clearanceLevel: { level: 1 }, limitingMarkers: [] };
    const clearedActor = { id: 5, role: 'Member', permissions: ['operations:create'], clearanceLevel: { level: 3 }, limitingMarkers: [{ id: 7 }] };
    const manageActor = { id: 9, role: 'Member', permissions: ['operations:manage'], clearanceLevel: { level: 0 }, limitingMarkers: [] };

    it('rejects when the caller cannot currently SEE the op (downgrade-to-disclose guard)', async () => {
        await expect(updateOperationDetails('op-A', { clearanceLevel: 0 }, 5, lowActor))
            .rejects.toThrow(/not cleared to edit/i);
        // No write reached the operations table.
        expect(h.queries.some(q => q.table === 'operations' && q.calls.some(c => c.method === 'update'))).toBe(false);
    });

    it('rejects relabeling the op ABOVE the actor clearance even when they can see it', async () => {
        await expect(updateOperationDetails('op-A', { clearanceLevel: 9 }, 5, clearedActor))
            .rejects.toThrow(/above your own clearance/i);
    });

    it('rejects attaching a marker the actor does not hold', async () => {
        await expect(updateOperationDetails('op-A', { markerIds: [42] }, 5, clearedActor))
            .rejects.toThrow(/marker you do not hold/i);
    });

    it('allows a cleared author to edit within their clearance + held markers', async () => {
        await expect(updateOperationDetails('op-A', { name: 'renamed', markerIds: [7] }, 5, clearedActor))
            .resolves.toBeUndefined();
        expect(h.queries.some(q => q.table === 'operations' && q.calls.some(c => c.method === 'update'))).toBe(true);
    });

    it('operations:manage bypasses both guards (can relabel up + downgrade)', async () => {
        await expect(updateOperationDetails('op-A', { clearanceLevel: 9, markerIds: [42] }, 9, manageActor))
            .resolves.toBeUndefined();
    });
});

describe('MED — updateParticipantLiveStatus strips HTML from the status', () => {
    beforeEach(() => { h.resolveQuery = () => ({ data: { is_ready: false }, error: null }); });

    it('strips tags before writing live_status and the log entry', async () => {
        await updateParticipantLiveStatus('op-A', 5, '<img src=x onerror=alert(1)>Engaging');
        const upd = h.queries.find(q => q.table === 'operation_participants' && q.calls.some(c => c.method === 'update'));
        const payload = upd?.calls.find(c => c.method === 'update')?.args[0] as { live_status?: string } | undefined;
        expect(payload?.live_status).toBeDefined();
        expect(payload?.live_status).not.toContain('<');
        expect(payload?.live_status).not.toContain('onerror');
        // The log entry rides the sanitized status too.
        const log = h.queries.find(q => q.table === 'operation_log_entries' && q.calls.some(c => c.method === 'insert'));
        const logPayload = log?.calls.find(c => c.method === 'insert')?.args[0] as { log_entry?: string } | undefined;
        expect(logPayload?.log_entry).not.toContain('<');
    });
});

// Handler-wiring: the handler delegates to the per-op visibility gate and threads
// the actor. Uses the db barrel mock above.
const lowPriv = { id: 6, role: 'Member', permissions: ['operations:view'], clearanceLevel: { level: 0 }, limitingMarkers: [] };

beforeEach(() => {
    handlerSpies.assertOpVisibleToUser.mockReset().mockResolvedValue(undefined);
    handlerSpies.updateParticipantLiveStatus.mockReset().mockResolvedValue(undefined);
    handlerSpies.leaveOperation.mockReset().mockResolvedValue(undefined);
    handlerSpies.updateOperationDetails.mockReset().mockResolvedValue(null);
    handlerSpies.verifyOperationAccess.mockReset().mockResolvedValue(undefined);
});

describe('MED — operation:update_participant_live_status gates on assertOpVisibleToUser', () => {
    it('rejects on an op the caller cannot see, BEFORE writing status', async () => {
        handlerSpies.assertOpVisibleToUser.mockRejectedValue(new Error('Insufficient clearance to act on this operation.'));
        await expect(action('operation:update_participant_live_status')({ operationId: 'op1', userId: 6, liveStatus: 'x', user: lowPriv }))
            .rejects.toThrow(/clearance/i);
        expect(handlerSpies.assertOpVisibleToUser).toHaveBeenCalledWith('op1', lowPriv);
        expect(handlerSpies.updateParticipantLiveStatus).not.toHaveBeenCalled();
    });
    it('writes once the op is visible', async () => {
        await action('operation:update_participant_live_status')({ operationId: 'op1', userId: 6, liveStatus: 'Engaging', user: lowPriv });
        expect(handlerSpies.assertOpVisibleToUser).toHaveBeenCalledWith('op1', lowPriv);
        expect(handlerSpies.updateParticipantLiveStatus).toHaveBeenCalledWith('op1', 6, 'Engaging');
    });
});

describe('LOW — operation:leave self-path gates on assertOpVisibleToUser', () => {
    it('rejects self-leave on an op the caller cannot see', async () => {
        handlerSpies.assertOpVisibleToUser.mockRejectedValue(new Error('Insufficient clearance to act on this operation.'));
        await expect(action('operation:leave')({ operationId: 'op1', userId: 6, user: lowPriv }))
            .rejects.toThrow(/clearance/i);
        expect(handlerSpies.leaveOperation).not.toHaveBeenCalled();
    });
    it('self-leave proceeds once the op is visible', async () => {
        await action('operation:leave')({ operationId: 'op1', userId: 6, user: lowPriv });
        expect(handlerSpies.assertOpVisibleToUser).toHaveBeenCalledWith('op1', lowPriv);
        expect(handlerSpies.leaveOperation).toHaveBeenCalledWith('op1', 6);
    });
    it('admin-leave of ANOTHER participant uses the operations:manage branch (no visibility call needed)', async () => {
        const admin = { id: 9, role: 'Admin', permissions: ['operations:manage'] };
        await action('operation:leave')({ operationId: 'op1', userId: 9, targetUserId: 6, user: admin });
        expect(handlerSpies.leaveOperation).toHaveBeenCalledWith('op1', 6);
    });
    it('non-manage caller removing ANOTHER participant is rejected', async () => {
        await expect(action('operation:leave')({ operationId: 'op1', userId: 6, targetUserId: 7, user: lowPriv }))
            .rejects.toThrow(/operations:manage/);
        expect(handlerSpies.leaveOperation).not.toHaveBeenCalled();
    });
});

describe('MED — operation:update threads the acting user into updateOperationDetails', () => {
    it('passes user as the 4th arg (so the db-layer clamp can run)', async () => {
        await action('operation:update')({ operationId: 'op1', updates: { name: 'x' }, userId: 6, user: lowPriv });
        expect(handlerSpies.updateOperationDetails).toHaveBeenCalledWith('op1', { name: 'x' }, 6, lowPriv);
    });
});
