import { describe, it, expect, vi, beforeEach } from 'vitest';

// Security tests for the `requests` cluster:
//
//   Client free-text feedback is gated behind the dedicated
//   `request:view:feedback` permission (Dispatcher/Admin only). The UI honours
//   it, but the SERVER must strip it too — canSeeAllRequests admits every
//   request:accept holder (i.e. every Member), so without a server-side strip
//   the candid feedback crosses the wire to all members. Covered via the pure
//   helper redactRequestFeedbackForViewer AND through the read aggregators
//   getRequestsState / getRequestDetail (so list/detail wiring can't drift).
//
//   A member must not be able to self-service their OWN request
//   (accept→start→complete→rate) to manufacture rated 'Success' rows that feed
//   the UNAUTHENTICATED public org stats. acceptRequest refuses a
//   self-assigned responder unless the actor holds real dispatch duty.

const h = vi.hoisted(() => ({
    resolveQuery: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: null as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown },
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'lte', 'ilike', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => Promise.resolve(h.resolveQuery({ table, calls }));
        b.single = () => settle();
        b.maybeSingle = () => settle();
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        getSystemRoles: async () => ({}),
    };
});

vi.mock('../lib/push', () => ({
    sendPushToAll: async () => {},
    sendPushToUsers: async () => {},
    sendPushToRoles: async () => {},
    sendPushToStaff: async () => {},
    sendPushToPermission: async () => {},
}));

import { getRequestsState, getRequestDetail } from '../lib/db';
import { redactRequestFeedbackForViewer, acceptRequest } from '../lib/db/requests';

beforeEach(() => { h.resolveQuery = () => ({ data: null, error: null }); });

// ---------------------------------------------------------------------------
// feedback redaction
// ---------------------------------------------------------------------------

describe('redactRequestFeedbackForViewer (request:view:feedback gate)', () => {
    const base = { id: 'SR-1', clientId: 7, clientRating: 4, clientFeedback: 'candid text' };

    it('nulls feedback for a plain member lacking the permission (rating kept)', () => {
        const out = redactRequestFeedbackForViewer(base, { id: 99, role: 'Member', permissions: ['request:accept'] });
        expect(out.clientFeedback).toBeNull();
        expect(out.clientRating).toBe(4);
    });

    it('keeps feedback for a request:view:feedback holder', () => {
        const out = redactRequestFeedbackForViewer(base, { id: 1, role: 'Dispatcher', permissions: ['request:accept', 'request:view:feedback'] });
        expect(out.clientFeedback).toBe('candid text');
    });

    it('keeps feedback for Admin', () => {
        const out = redactRequestFeedbackForViewer(base, { id: 2, role: 'Admin', permissions: [] });
        expect(out.clientFeedback).toBe('candid text');
    });

    it('keeps feedback for the owning client who authored it', () => {
        const out = redactRequestFeedbackForViewer(base, { id: 7, role: 'Member', permissions: ['request:accept'] });
        expect(out.clientFeedback).toBe('candid text');
    });

    it('fails closed for an unauthenticated viewer', () => {
        const out = redactRequestFeedbackForViewer(base, null);
        expect(out.clientFeedback).toBeNull();
    });

    it('does not match an undefined viewer id against a null clientId', () => {
        const out = redactRequestFeedbackForViewer({ id: 'SR-2', clientId: null, clientFeedback: 'x' }, { permissions: [] });
        expect(out.clientFeedback).toBeNull();
    });
});

describe('getRequestsState strips feedback per viewer', () => {
    const ROW = { id: 'SR-1', client_id: 7, service_type: 'Rescue', location: 'L', description: 'D', status: 'Success', rated: true, client_rating: 4, client_feedback: 'candid text' };
    beforeEach(() => { h.resolveQuery = (q) => q.table === 'service_requests' ? { data: [ROW], error: null } : { data: null, error: null }; });

    it('a member (request:accept, not feedback) receives null feedback but keeps the rating', async () => {
        const { requests } = await getRequestsState({ id: 99, role: 'Member', permissions: ['request:accept'] });
        expect(requests[0].clientFeedback).toBeNull();
        expect(requests[0].clientRating).toBe(4);
    });

    it('a Dispatcher with request:view:feedback receives the feedback text', async () => {
        const { requests } = await getRequestsState({ id: 1, role: 'Dispatcher', permissions: ['request:accept', 'request:view:feedback'] });
        expect(requests[0].clientFeedback).toBe('candid text');
    });

    it('the owning client receives their own feedback', async () => {
        const { requests } = await getRequestsState({ id: 7, role: 'Member', permissions: ['request:accept'] });
        expect(requests[0].clientFeedback).toBe('candid text');
    });
});

describe('getRequestDetail strips feedback per viewer (mirrors list)', () => {
    const ROW = { id: 'SR-1', client_id: 7, service_type: 'Rescue', location: 'L', description: 'D', status: 'Success', rated: true, client_rating: 4, client_feedback: 'candid text', request_responders: [], statusHistory: [] };
    beforeEach(() => { h.resolveQuery = (q) => q.table === 'service_requests' ? { data: ROW, error: null } : { data: null, error: null }; });

    it('a member without request:view:feedback gets null feedback', async () => {
        const detail = await getRequestDetail('SR-1', { id: 99, role: 'Member', permissions: ['request:accept'] });
        expect(detail?.clientFeedback).toBeNull();
        expect(detail?.clientRating).toBe(4);
    });

    it('a request:view:feedback holder gets the feedback text', async () => {
        const detail = await getRequestDetail('SR-1', { id: 1, role: 'Dispatcher', permissions: ['request:accept', 'request:view:feedback'] });
        expect(detail?.clientFeedback).toBe('candid text');
    });

    it('the owning client gets their own feedback', async () => {
        const detail = await getRequestDetail('SR-1', { id: 7, role: 'Member', permissions: ['request:accept'] });
        expect(detail?.clientFeedback).toBe('candid text');
    });
});

// ---------------------------------------------------------------------------
// self-service block in acceptRequest
// ---------------------------------------------------------------------------

describe('acceptRequest blocks self-servicing a self-originated request', () => {
    const withReq = (client_id: number) => (q: { table: string }) =>
        q.table === 'service_requests' ? { data: { status: 'Submitted', client_id }, error: null } : { data: null, error: null };

    it('rejects a member becoming the responder on their OWN request', async () => {
        h.resolveQuery = withReq(5);
        await expect(acceptRequest('r1', 5, 5, { id: 5, permissions: [] }))
            .rejects.toThrow(/your own request/i);
    });

    it('still allows a member to respond to a DIFFERENT client\'s request', async () => {
        h.resolveQuery = withReq(7);
        await expect(acceptRequest('r1', 5, 5, { id: 5, permissions: [] })).resolves.toBeUndefined();
    });

    it('a dispatch-duty holder may self-assign (e.g. logging a solo run)', async () => {
        h.resolveQuery = withReq(5);
        await expect(acceptRequest('r1', 5, 5, { id: 5, permissions: ['request:set_lead'] })).resolves.toBeUndefined();
    });

    it('Admin may self-assign', async () => {
        h.resolveQuery = withReq(5);
        await expect(acceptRequest('r1', 5, 5, { id: 5, role: 'Admin', permissions: [] })).resolves.toBeUndefined();
    });
});
