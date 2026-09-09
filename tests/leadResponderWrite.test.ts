import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression: lead_responder_id was never actually written on either accept path.
 *
 * `updateRequestStatus` takes an `updates` bag and allowlists exactly one field out
 * of it (`urgency`) as a mass-assignment guard. But `acceptRequest` and
 * `adminAcceptAndAssignRequest` both passed `{ lead_responder_id: … }` through that
 * same bag — so it was silently dropped on every accept and the column stayed null.
 *
 * That is not cosmetic. api/services.ts grants request:add_responder /
 * request:remove_responder to whoever holds lead_responder_id, WITHOUT the
 * request:manage_responders permission ("isRequestLead"). A lead that is never
 * persisted means that bypass was dead — and the mirror half, dispatchMembers
 * replacing the whole responder set without ever clearing a departed lead, means
 * the bypass could OUTLIVE the assignment that justified it.
 *
 * The fix routes both directions through dedicated compare-and-swap helpers rather
 * than widening the allowlist. These tests assert the WRITE ITSELF (an in-memory
 * row store, with the accumulated .eq()/.is() predicates applied as a WHERE and
 * every matching UPDATE recorded together with its predicates), because the
 * call-recording stubs in tests/sec-requests.test.ts and
 * tests/requestResponderGate.test.ts cannot see a write land — which is exactly why
 * this bug survived them.
 */
const h = vi.hoisted(() => {
    const state = {
        rows: {} as Record<string, Array<Record<string, unknown>>>,
        /** Every UPDATE that matched >= 1 row, in order, with its WHERE predicates. */
        writes: [] as Array<{ table: string; payload: Record<string, unknown>; preds: Array<[string, unknown]> }>,
    };

    function makeBuilder(table: string) {
        const preds: Array<[string, unknown]> = [];
        let verb: 'select' | 'update' | 'delete' | null = null;
        let payload: Record<string, unknown> = {};

        const matched = () => (state.rows[table] || []).filter(r =>
            preds.every(([col, val]) => (val === null ? r[col] == null : String(r[col]) === String(val))));

        const settle = () => {
            const rows = matched();
            if (verb === 'update') {
                // Record the predicates too — the compare-and-swap on the lead write
                // is a correctness property a payload-only assertion cannot see.
                if (rows.length) state.writes.push({ table, payload, preds: [...preds] });
                for (const r of rows) Object.assign(r, payload);
            }
            return verb === 'select' ? rows : null;
        };

        const builder: Record<string, unknown> = {
            select: () => { verb = verb ?? 'select'; return builder; },
            update: (p: Record<string, unknown>) => { verb = 'update'; payload = p; return builder; },
            delete: () => { verb = 'delete'; return builder; },
            insert: () => { verb = 'select'; return builder; },
            upsert: () => { verb = 'select'; return builder; },
            eq: (col: string, val: unknown) => { preds.push([col, val]); return builder; },
            is: (col: string, val: unknown) => { preds.push([col, val]); return builder; },
            in: () => builder,
            order: () => builder,
            limit: () => builder,
            single: async () => ({ data: settle()?.[0] ?? null, error: null }),
            maybeSingle: async () => ({ data: settle()?.[0] ?? null, error: null }),
            then: (res: (v: unknown) => unknown) => Promise.resolve({ data: settle(), error: null, count: matched().length }).then(res),
        };
        return builder;
    }

    return { state, supabase: { from: (t: string) => makeBuilder(t) } };
});

vi.mock('../lib/db/common', () => ({
    supabase: h.supabase,
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
    broadcastToOrg: vi.fn(),
}));
vi.mock('../lib/db/notifications', () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('../lib/push', () => ({ sendPushToStaff: vi.fn(async () => undefined), sendPushToUsers: vi.fn(async () => undefined) }));
vi.mock('../lib/db/users', () => ({ adminAdjustUserReputation: vi.fn(async () => undefined) }));

import {
    acceptRequest, adminAcceptAndAssignRequest, updateRequestStatus,
    dispatchMembers, addResponderToRequest,
} from '../lib/db/requests';

const REQ = 'req-1';
// The acting dispatcher. Deliberately not 8 or 9 — the responder notifications
// suppress a self-ping, and reusing a member id here would hide that.
const ACTOR = 77;
// A dispatch-duty actor, needed only where a test accepts on someone else's behalf
// (acceptRequest's own self-scope throw fires first otherwise).
const DUTY = { id: 7, permissions: ['request:set_lead'] };

/** One acceptable request, owned by a client who is NOT any of the responders. */
function seed(leadResponderId: number | null = null) {
    h.state.rows = {
        service_requests: [{ id: REQ, status: 'Submitted', client_id: 100, service_type: 'Medical', lead_responder_id: leadResponderId }],
        request_responders: [],
    };
    h.state.writes = [];
}

/** The lead_responder_id values the service_requests table actually received. */
const leadWrites = () => h.state.writes
    .filter(w => w.table === 'service_requests' && 'lead_responder_id' in w.payload)
    .map(w => w.payload.lead_responder_id);

beforeEach(() => seed());

describe('acceptRequest — persists the lead responder', () => {
    it('actually writes lead_responder_id (the bug: it was dropped by the updates allowlist)', async () => {
        await acceptRequest(REQ, 7, 7);
        expect(leadWrites()).toEqual([7]);
        expect(h.state.rows.service_requests[0].lead_responder_id).toBe(7);
    });

    it('does not steal the lead from an existing lead responder', async () => {
        seed(8);
        await acceptRequest(REQ, 7, 7);
        expect(leadWrites()).toEqual([]);
        expect(h.state.rows.service_requests[0].lead_responder_id).toBe(8);
    });

    // Two members accepting at once both read null; without `.is('lead_responder_id',
    // null)` on the UPDATE the second would overwrite the first's lead.
    it('the lead claim is a compare-and-swap, not a blind update', async () => {
        await acceptRequest(REQ, 7, 7);
        const write = h.state.writes.find(w => w.table === 'service_requests' && 'lead_responder_id' in w.payload);
        expect(write).toBeDefined();
        expect(write?.preds).toContainEqual(['lead_responder_id', null]);
        expect(write?.preds).toContainEqual(['id', REQ]);
    });
});

describe('adminAcceptAndAssignRequest — persists the named lead responder', () => {
    it('actually writes the lead the dispatcher named', async () => {
        await adminAcceptAndAssignRequest(REQ, 9, 7, 'assigned');
        expect(leadWrites()).toEqual([9]);
        expect(h.state.rows.service_requests[0].lead_responder_id).toBe(9);
    });

    // Unlike acceptRequest: an explicit request:dispatch designation overrides.
    it('overrides an existing lead, because a dispatcher named this one', async () => {
        seed(8);
        await adminAcceptAndAssignRequest(REQ, 9, 7, 'reassigned');
        expect(h.state.rows.service_requests[0].lead_responder_id).toBe(9);
    });

    it('still applies urgency through the allowlisted updates bag', async () => {
        await adminAcceptAndAssignRequest(REQ, 9, 7, 'assigned', 'High' as never);
        const urgencyWrite = h.state.writes.find(w => w.table === 'service_requests' && 'urgency' in w.payload);
        expect(urgencyWrite?.payload.urgency).toBe('High');
    });
});

/**
 * The lead is privilege-bearing, so these pin the design decisions that keep it from
 * being handed out — none of which the "does it persist" tests above can see.
 */
describe('lead_responder_id stays a privileged write', () => {
    // `memberId` is a target-identity field the dispatcher does NOT force to the
    // actor. request:triage alone satisfies hasRequestDuty, so without the strict
    // `memberId === userId` claim condition a triage-only holder could confer the
    // isRequestLead bypass on anyone. Naming someone else's lead is
    // adminAcceptAndAssignRequest (request:dispatch), which sets it unconditionally.
    it('accepting on behalf of someone else does NOT make them lead', async () => {
        await acceptRequest(REQ, 8, 7, DUTY);
        expect(leadWrites()).toEqual([]);
        expect(h.state.rows.service_requests[0].lead_responder_id).toBeNull();
    });

    it('self-accept still claims the lead (the guard is not just "never write")', async () => {
        await acceptRequest(REQ, 7, 7);
        expect(h.state.rows.service_requests[0].lead_responder_id).toBe(7);
    });

    // The mirror image of the claim: the bypass must not OUTLIVE the assignment.
    // dispatchMembers replaces the whole responder set but used to leave
    // lead_responder_id alone, so a member dropped by a re-dispatch kept
    // request:add_responder / request:remove_responder on a request they were off.
    it('a re-dispatch that DROPS the lead clears the lead', async () => {
        seed(8);
        await dispatchMembers(REQ, [9], ACTOR);
        // Cleared, then the vacancy is filled by the first newly-dispatched member.
        expect(leadWrites()).toEqual([null, 9]);
        expect(h.state.rows.service_requests[0].lead_responder_id).toBe(9);
    });

    it('a re-dispatch that RETAINS the lead leaves the lead alone', async () => {
        seed(8);
        await dispatchMembers(REQ, [8, 9], ACTOR);
        expect(leadWrites()).toEqual([]);
        expect(h.state.rows.service_requests[0].lead_responder_id).toBe(8);
    });

    it('clearing the responder list entirely also clears the lead', async () => {
        seed(8);
        await dispatchMembers(REQ, [], ACTOR);
        expect(h.state.rows.service_requests[0].lead_responder_id).toBeNull();
    });

    // A dispatcher who named a NEW lead between our read and our write must not get
    // theirs nulled out from under them.
    it('the lead clear is a compare-and-swap on the lead we read', async () => {
        seed(8);
        await dispatchMembers(REQ, [9], ACTOR);
        const clear = h.state.writes.find(w => w.table === 'service_requests' && w.payload.lead_responder_id === null);
        expect(clear).toBeDefined();
        expect(clear?.preds).toContainEqual(['lead_responder_id', 8]);
        expect(clear?.preds).toContainEqual(['id', REQ]);
    });

    it('addResponderToRequest claims a vacant lead but never steals an occupied one', async () => {
        await addResponderToRequest(REQ, 9, ACTOR);
        expect(h.state.rows.service_requests[0].lead_responder_id).toBe(9);
        seed(8);
        await addResponderToRequest(REQ, 9, ACTOR);
        expect(leadWrites()).toEqual([]);
        expect(h.state.rows.service_requests[0].lead_responder_id).toBe(8);
    });

    // The obvious wrong fix is to widen updateRequestStatus's allowlist. Every call
    // site passes `undefined` or a server-constructed `{ urgency }` today, so this is
    // defence in depth: the bag is a `Record<string, unknown>` a future handler could
    // wire straight to a client payload, and widening it would let a request:update
    // holder confer the isRequestLead bypass through any status transition.
    it('updateRequestStatus refuses to carry lead_responder_id in its updates bag', async () => {
        await updateRequestStatus(REQ, 'In-Progress', 7, undefined, undefined, { lead_responder_id: 8, urgency: 'High' });
        const write = h.state.writes.find(w => w.table === 'service_requests');
        expect(write?.payload).not.toHaveProperty('lead_responder_id');
        expect(write?.payload.urgency).toBe('High');
        expect(h.state.rows.service_requests[0].lead_responder_id).toBeNull();
    });
});
