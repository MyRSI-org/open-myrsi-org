import { describe, it, expect, vi, beforeEach } from 'vitest';

// A durable notification row plus an OS web-push is a REAL side effect aimed at a person.
// Every new trigger therefore has to answer two questions the recon's proposal did not:
//   1. is the recipient id something the CALLER chose, and was it validated?
//   2. can the trigger be made to fire repeatedly on a no-op?
//
// Two of the proposed triggers failed both. `assigned_user_id` on a task or a command node is
// the client's own value round-tripped through the insert — no existence, participant or
// clearance check anywhere on that path — and `operation:add_task` is NOT in
// OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS, so anyone holding `operations:create` can make an
// operation, own it, satisfy `operations:manage` on it, and then loop add_task with arbitrary
// user ids. That is a push amplifier pointed at the whole org, gated by nothing.
//
// These tests pin the guards that close it, plus the anti-amplifier and read-fault guards on
// the sibling paths.

const h = vi.hoisted(() => ({
    notes: [] as Array<{ userId: number; type: string; title: string; body: string }>,
    rows: {} as Record<string, Array<Record<string, unknown>>>,
    readErrorTables: new Set<string>(),
}));

vi.mock('../lib/db/notifications', () => ({
    createNotification: vi.fn(async (userId: number, input: { type: string; title: string; body: string }) => {
        h.notes.push({ userId, type: input.type, title: input.title, body: input.body });
        return null;
    }),
}));

vi.mock('../lib/push', () => ({
    sendPushToStaff: vi.fn(async () => undefined),
    sendPushToUsers: vi.fn(async () => undefined),
    sendPushToPermission: vi.fn(async () => undefined),
}));

vi.mock('../lib/db/users', () => ({
    adminAdjustUserReputation: vi.fn(async () => undefined),
    getUserById: vi.fn(async () => null),
    getActorLabel: vi.fn(async () => 'Someone'),
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = { op: 'select', filters: {} as Record<string, unknown>, values: null as unknown };
        const match = () => (h.rows[table] || []).filter((r) =>
            Object.entries(state.filters).every(([c, v]) => r[c] === v));
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'order', 'limit', 'range', 'in', 'is', 'not', 'or', 'ilike', 'gte', 'lte']) b[m] = () => b;
        b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.insert = (v: unknown) => { state.op = 'insert'; state.values = v; return b; };
        b.upsert = (v: unknown) => { state.op = 'upsert'; state.values = v; return b; };
        b.update = (v: unknown) => { state.op = 'update'; state.values = v; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        const settle = (mode: 'many' | 'single') => {
            if (h.readErrorTables.has(table) && state.op === 'select') {
                return Promise.resolve({ data: null, error: { code: '08006', message: 'connection reset' }, count: null });
            }
            if (state.op === 'delete') {
                const doomed = match();
                h.rows[table] = (h.rows[table] || []).filter((r) => !doomed.includes(r));
                return Promise.resolve({ data: doomed, error: null, count: doomed.length });
            }
            if (state.op === 'insert' || state.op === 'upsert') {
                const vals = Array.isArray(state.values) ? state.values : [state.values];
                h.rows[table] = [...(h.rows[table] || []), ...(vals as Record<string, unknown>[])];
                return Promise.resolve({ data: vals[0], error: null, count: vals.length });
            }
            if (state.op === 'update') return Promise.resolve({ data: null, error: null, count: 0 });
            const rows = match();
            return Promise.resolve({ data: mode === 'single' ? (rows[0] ?? null) : rows, error: null, count: rows.length });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle('many').then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => Promise.resolve(),
        broadcastToChannel: () => Promise.resolve(),
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});

import { notifyOperationAssignee, leaveOperation, addOperationParticipant } from '../lib/db/ops';
import { dispatchMembers, addResponderToRequest, setLeadResponder } from '../lib/db/requests';

const OP = 'op-1';
const REQ = 'req-1';
const ACTOR = 1, PARTICIPANT = 2, OUTSIDER = 3;

beforeEach(() => {
    h.notes = [];
    h.rows = {};
    h.readErrorTables = new Set();
});

describe('operation assignment — the recipient must already be a participant', () => {
    beforeEach(() => {
        h.rows.operations = [{ id: OP, name: 'Op', classification_level: 0, limiting_markers: [] }];
        h.rows.operation_participants = [{ operation_id: OP, user_id: PARTICIPANT }];
    });

    it('notifies a real participant', async () => {
        await notifyOperationAssignee(OP, PARTICIPANT, ACTOR, 'task');
        expect(h.notes).toHaveLength(1);
        expect(h.notes[0]).toMatchObject({ userId: PARTICIPANT, type: 'operation_assigned' });
    });

    it('THE AMPLIFIER: sends NOTHING for a user who is not a participant', async () => {
        // assigned_user_id is the caller's own unvalidated value. Without this precondition,
        // any operations:create holder could spray durable rows + OS pushes org-wide.
        await notifyOperationAssignee(OP, OUTSIDER, ACTOR, 'task');
        expect(h.notes).toEqual([]);
    });

    it('never self-notifies the actor', async () => {
        h.rows.operation_participants.push({ operation_id: OP, user_id: ACTOR });
        await notifyOperationAssignee(OP, ACTOR, ACTOR, 'task');
        expect(h.notes).toEqual([]);
    });

    it('ignores a null, zero or non-numeric assignee without querying', async () => {
        for (const bad of [null, undefined, 0, -1, Number.NaN, 'x' as unknown as number]) {
            await notifyOperationAssignee(OP, bad as number | null | undefined, ACTOR, 'task');
        }
        expect(h.notes).toEqual([]);
    });

    it('fails CLOSED when the participant read faults', async () => {
        h.readErrorTables.add('operation_participants');
        await notifyOperationAssignee(OP, PARTICIPANT, ACTOR, 'task');
        expect(h.notes).toEqual([]);
    });

    it('carries no operation content in the body (clearance is not applied to a push tray)', async () => {
        await notifyOperationAssignee(OP, PARTICIPANT, ACTOR, 'task');
        await notifyOperationAssignee(OP, PARTICIPANT, ACTOR, 'command');
        for (const n of h.notes) expect(n.body).not.toContain('Op');
    });
});

describe('leaveOperation reports whether a row was actually removed', () => {
    beforeEach(() => {
        h.rows.operations = [{ id: OP, name: 'Op', classification_level: 0, limiting_markers: [] }];
    });

    it('true when a participant row was deleted', async () => {
        h.rows.operation_participants = [{ operation_id: OP, user_id: PARTICIPANT }];
        expect(await leaveOperation(OP, PARTICIPANT)).toBe(true);
    });

    it('FALSE for a user who was never a participant — the no-op delete', async () => {
        // It used to return void, so the caller could not tell these apart and notifying on
        // its return would have let any operations:manage holder false-notify anyone.
        h.rows.operation_participants = [{ operation_id: OP, user_id: PARTICIPANT }];
        expect(await leaveOperation(OP, OUTSIDER)).toBe(false);
    });
});

describe('addOperationParticipant does not amplify on a re-add', () => {
    beforeEach(() => {
        h.rows.operations = [{ id: OP, name: 'Op', classification_level: 0, limiting_markers: [] }];
        h.rows.operation_participants = [];
    });

    it('notifies a genuinely new participant', async () => {
        await addOperationParticipant(OP, PARTICIPANT, ACTOR);
        expect(h.notes.map((n) => n.userId)).toEqual([PARTICIPANT]);
    });

    it('sends NOTHING when the target was already a participant', async () => {
        // The upsert uses ignoreDuplicates:false, so a re-add succeeds every time. An
        // unconditional notify here would be a repeatable amplifier on a caller-supplied id —
        // the exact defect addResponderToRequest already guards and documents.
        h.rows.operation_participants = [{ operation_id: OP, user_id: PARTICIPANT }];
        await addOperationParticipant(OP, PARTICIPANT, ACTOR);
        expect(h.notes).toEqual([]);
    });

    it('never notifies the actor for adding themselves', async () => {
        await addOperationParticipant(OP, ACTOR, ACTOR);
        expect(h.notes).toEqual([]);
    });

    it('fails CLOSED on a faulted prior-state read (treats it as a re-add)', async () => {
        h.readErrorTables.add('operation_participants');
        await addOperationParticipant(OP, PARTICIPANT, ACTOR);
        expect(h.notes).toEqual([]);
    });
});

describe('responder triggers — only genuinely new assignments, never the actor', () => {
    beforeEach(() => {
        h.rows.service_requests = [{ id: REQ, lead_responder_id: null }];
        h.rows.request_responders = [];
    });

    it('dispatchMembers notifies only members who were NOT already responders', async () => {
        h.rows.request_responders = [{ request_id: REQ, user_id: PARTICIPANT }];
        await dispatchMembers(REQ, [PARTICIPANT, OUTSIDER], ACTOR);
        // Open used to push the WHOLE memberIds array on every re-dispatch, re-pinging
        // everyone retained — even though the broadcast beside it was already deduped.
        expect(h.notes.map((n) => n.userId)).toEqual([OUTSIDER]);
    });

    it('dispatchMembers never notifies the dispatcher themselves', async () => {
        await dispatchMembers(REQ, [ACTOR, OUTSIDER], ACTOR);
        expect(h.notes.map((n) => n.userId)).toEqual([OUTSIDER]);
    });

    it('dispatchMembers sends NOTHING when the prior-responder read faults', async () => {
        // A faulted read yields an empty set, which reads as "nobody was assigned before" and
        // would notify the entire dispatched set. A duplicate toast was the old cost of that;
        // a durable row plus an OS push is not.
        h.readErrorTables.add('request_responders');
        await dispatchMembers(REQ, [OUTSIDER], ACTOR).catch(() => { /* the write path may throw */ });
        expect(h.notes).toEqual([]);
    });

    it('addResponderToRequest notifies a new responder but not a re-add', async () => {
        await addResponderToRequest(REQ, OUTSIDER, ACTOR);
        expect(h.notes.map((n) => n.userId)).toEqual([OUTSIDER]);

        h.notes = [];
        await addResponderToRequest(REQ, OUTSIDER, ACTOR);
        expect(h.notes).toEqual([]);
    });

    it('setLeadResponder notifies the new lead, never on a CLEAR, never the actor', async () => {
        await setLeadResponder(REQ, OUTSIDER, ACTOR);
        expect(h.notes.map((n) => n.userId)).toEqual([OUTSIDER]);

        h.notes = [];
        await setLeadResponder(REQ, undefined, ACTOR);
        expect(h.notes).toEqual([]);

        await setLeadResponder(REQ, ACTOR, ACTOR);
        expect(h.notes).toEqual([]);
    });

    it('every responder notification carries the type the bell has an icon for', async () => {
        await addResponderToRequest(REQ, OUTSIDER, ACTOR);
        expect(h.notes[0].type).toBe('responder');
    });

    it('no responder body interpolates the request id (it rides link + metadata instead)', async () => {
        await addResponderToRequest(REQ, OUTSIDER, ACTOR);
        await setLeadResponder(REQ, PARTICIPANT, ACTOR);
        for (const n of h.notes) expect(n.body).not.toContain(REQ);
    });
});
