import { describe, it, expect, vi, beforeEach } from 'vitest';

// Request responder gate (red-team disp-gate-1): request:start / request:complete
// are Member-default but act on a caller-supplied request id, so the caller must
// be a responder on (or have duty over) the request. Independently, the
// completion report's reputation write is honored ONLY for a duty holder, so a
// member-reachable completion cannot reach the admin reputation RPC.

const h = vi.hoisted(() => ({
    resolveQuery: (() => ({ data: null as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown },
    adjustRepCalls: [] as unknown[],
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'ilike', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => Promise.resolve(h.resolveQuery({ table, calls }));
        b.single = () => settle(); b.maybeSingle = () => settle();
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
    };
});
vi.mock('../lib/db/users', () => ({
    adminAdjustUserReputation: vi.fn(async (...args: unknown[]) => { h.adjustRepCalls.push(args); }),
}));
vi.mock('../lib/push', () => ({ sendPushToStaff: vi.fn(async () => undefined), sendPushToUsers: vi.fn(async () => undefined) }));

import { assertRequestResponderOrDuty, completeRequest, acceptRequest } from '../lib/db/requests';

beforeEach(() => { h.adjustRepCalls = []; h.resolveQuery = () => ({ data: null, error: null }); });

describe('assertRequestResponderOrDuty (disp-gate-1)', () => {
    it('allows a duty holder (request:dispatch) without touching the request', async () => {
        await expect(assertRequestResponderOrDuty('r1', { id: 5, permissions: ['request:dispatch'] })).resolves.toBeUndefined();
    });
    it('allows Admin', async () => {
        await expect(assertRequestResponderOrDuty('r1', { id: 5, role: 'Admin' })).resolves.toBeUndefined();
    });
    it('allows the lead responder', async () => {
        h.resolveQuery = (q) => q.table === 'service_requests' ? { data: { lead_responder_id: 5 }, error: null } : { data: null, error: null };
        await expect(assertRequestResponderOrDuty('r1', { id: 5, permissions: [] })).resolves.toBeUndefined();
    });
    it('allows an assigned responder', async () => {
        h.resolveQuery = (q) => {
            if (q.table === 'service_requests') return { data: { lead_responder_id: 99 }, error: null };
            if (q.table === 'request_responders') return { data: { user_id: 5 }, error: null };
            return { data: null, error: null };
        };
        await expect(assertRequestResponderOrDuty('r1', { id: 5, permissions: [] })).resolves.toBeUndefined();
    });
    it('rejects a plain member who is neither responder nor duty', async () => {
        h.resolveQuery = (q) => q.table === 'service_requests' ? { data: { lead_responder_id: 99 }, error: null } : { data: null, error: null };
        await expect(assertRequestResponderOrDuty('r1', { id: 5, permissions: ['request:complete'] })).rejects.toThrow(/not assigned/i);
    });
});

describe('acceptRequest terminal-status guard', () => {
    const withStatus = (status: string | null) => (q: { table: string }) =>
        q.table === 'service_requests' ? { data: status === null ? null : { status }, error: null } : { data: null, error: null };

    it('throws when the request does not exist', async () => {
        h.resolveQuery = withStatus(null);
        await expect(acceptRequest('r1', 5, 5)).rejects.toThrow(/not found/i);
    });
    it('rejects accepting a terminal / in-progress request (no state resurrection)', async () => {
        for (const status of ['Success', 'Failed', 'Cancelled', 'Refused', 'Aborted', 'In-Progress', 'Accepted']) {
            h.resolveQuery = withStatus(status);
            await expect(acceptRequest('r1', 5, 5), `status=${status}`).rejects.toThrow(/no longer be accepted/i);
        }
    });
    it('allows accepting a Submitted request', async () => {
        h.resolveQuery = withStatus('Submitted');
        await expect(acceptRequest('r1', 5, 5)).resolves.toBeUndefined();
    });
    it('allows accepting a Triaged request', async () => {
        h.resolveQuery = withStatus('Triaged');
        await expect(acceptRequest('r1', 5, 5)).resolves.toBeUndefined();
    });

    // memberId scoping: only self, unless the caller has real dispatch duty.
    it('a plain member can accept a request for THEMSELVES', async () => {
        h.resolveQuery = withStatus('Submitted');
        await expect(acceptRequest('r1', 5, 5, { id: 5, permissions: [] })).resolves.toBeUndefined();
    });
    it('a plain member CANNOT assign a different member as responder', async () => {
        await expect(acceptRequest('r1', 99, 5, { id: 5, permissions: [] }))
            .rejects.toThrow(/only accept a request for yourself/i);
    });
    it('a dispatch-duty holder CAN assign a different member', async () => {
        h.resolveQuery = withStatus('Submitted');
        await expect(acceptRequest('r1', 99, 5, { id: 5, permissions: ['request:set_lead'] })).resolves.toBeUndefined();
    });
});

describe('completeRequest reputation write is duty-gated', () => {
    it('a non-duty actor cannot move client reputation via the completion report', async () => {
        h.resolveQuery = (q) => q.table === 'service_requests' ? { data: { client_id: 7, service_type: 'x' }, error: null } : { data: null, error: null };
        await completeRequest('r1', { outcome: 'Success', clientReputationChange: -50 } as any, 5, { id: 5, permissions: ['request:complete'] });
        expect(h.adjustRepCalls.length).toBe(0);
    });
    it('a duty actor can move client reputation', async () => {
        h.resolveQuery = (q) => q.table === 'service_requests' ? { data: { client_id: 7, service_type: 'x', reputation: 50 }, error: null }
            : q.table === 'users' ? { data: { reputation: 50 }, error: null } : { data: null, error: null };
        await completeRequest('r1', { outcome: 'Success', clientReputationChange: -50 } as any, 5, { id: 5, role: 'Admin' });
        expect(h.adjustRepCalls.length).toBe(1);
    });
});
