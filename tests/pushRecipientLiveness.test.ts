import { describe, it, expect, vi, beforeEach } from 'vitest';

// Removed members must not keep receiving org push.
//
// deleteUser only SOFT-deletes (deleted_at + tokens_valid_from). It leaves the
// ejected member's operation_participants rows untouched (time_left stays NULL, so
// they read as an ACTIVE participant of every op they ever joined) — and until
// this change it also left their push_subscriptions rows in place. sendPushToUsers
// selected subscriptions by user_id with no join to users, so every per-user
// fan-out (operation alerts, operation reminders, dispatch pings) kept pushing org
// content — including operation NAMES — to people the org had removed.
//
// Two layers are pinned here:
//   1. sendPushToUsers filters at the QUERY (users!inner + deleted_at IS NULL), so
//      a caller cannot forget, and a lookup fault sends NOTHING rather than
//      everything.
//   2. deleteUser revokes the subscription rows outright — a push subscription is
//      a delivery capability, and a removed member should not hold one.
//   3. filterLiveRecipients (used by callers that must decide before sending, e.g.
//      the reminder job claiming rows) fails closed with null on a probe fault.

type Q = { table: string; calls: Array<{ method: string; args: unknown[] }> };

const h = vi.hoisted(() => ({
    resolveQuery: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: [] as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown },
    queries: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    sent: [] as Array<{ endpoint?: string }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'lte', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => {
            const q = { table, calls };
            h.queries.push(q);
            return Promise.resolve(h.resolveQuery(q));
        };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (res: any, rej: any) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        getSystemRoles: async () => ({}),
        safeFetch: async () => [],
    };
});

// Lets sendBatch's getWebPush() resolve, and records every actual send.
vi.mock('web-push', () => ({
    default: { setVapidDetails: () => {}, sendNotification: (sub: { endpoint?: string }) => { h.sent.push(sub); return Promise.resolve(); } },
}));

import { sendPushToUsers, filterLiveRecipients } from '../lib/push';
import { deleteUser } from '../lib/db/users';

const goodEndpoint = 'https://fcm.googleapis.com/fcm/send/tok-1';
const has = (q: Q, method: string, arg0?: unknown) =>
    q.calls.some(c => c.method === method && (arg0 === undefined || c.args[0] === arg0));

beforeEach(() => {
    h.queries = [];
    h.sent = [];
    h.resolveQuery = () => ({ data: [], error: null });
});

describe('sendPushToUsers filters removed members at the query', () => {
    it('joins users and requires deleted_at IS NULL', async () => {
        h.resolveQuery = () => ({ data: [{ id: 'sub-1', user_id: 1, subscription: { endpoint: goodEndpoint } }], error: null });

        await sendPushToUsers([1, 2], { title: 'T', body: 'B' });

        const q = h.queries.find(x => x.table === 'push_subscriptions')!;
        const select = String(q.calls.find(c => c.method === 'select')!.args[0]);
        expect(select).toContain('users!inner');
        expect(select).not.toContain('*');
        expect(q.calls).toContainEqual({ method: 'is', args: ['user.deleted_at', null] });
        expect(h.sent).toHaveLength(1);
    });

    it('falls back to an explicit live-recipient filter when the join is unresolvable', async () => {
        // An install whose push_subscriptions table predates the users FK: the
        // rule must still apply, with a round-trip, not be skipped.
        h.resolveQuery = (q) => {
            if (q.table === 'users') return { data: [{ id: 1 }], error: null };
            if (String(q.calls.find(c => c.method === 'select')?.args[0]).includes('users!inner')) {
                return { data: null, error: { code: 'PGRST200', message: 'no relationship' } };
            }
            return { data: [{ id: 'sub-1', user_id: 1, subscription: { endpoint: goodEndpoint } }], error: null };
        };

        await sendPushToUsers([1, 2], { title: 'T', body: 'B' });

        const probe = h.queries.find(x => x.table === 'users')!;
        expect(probe.calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
        const retry = h.queries.filter(x => x.table === 'push_subscriptions').at(-1)!;
        expect(retry.calls).toContainEqual({ method: 'in', args: ['user_id', [1]] });
        expect(h.sent).toHaveLength(1);
    });

    it('FAILS CLOSED: the fallback sends nothing when the liveness probe also faults', async () => {
        h.resolveQuery = (q) => {
            if (q.table === 'users') return { data: null, error: { code: '08006', message: 'connection failure' } };
            return { data: null, error: { code: 'PGRST200', message: 'no relationship' } };
        };

        await sendPushToUsers([1, 2], { title: 'T', body: 'B' });

        expect(h.sent).toHaveLength(0);
    });

    it('FAILS CLOSED: a subscription-lookup fault sends nothing', async () => {
        h.resolveQuery = () => ({ data: null, error: { code: '08006', message: 'connection failure' } });

        await sendPushToUsers([1], { title: 'T', body: 'B' });

        expect(h.sent).toHaveLength(0);
    });
});

describe('filterLiveRecipients', () => {
    it('intersects out ids that are missing or soft-deleted', async () => {
        h.resolveQuery = () => ({ data: [{ id: 7 }], error: null });
        expect(await filterLiveRecipients([7, 9])).toEqual([7]);
    });

    it('FAILS CLOSED: returns null (not the input) when the probe faults', async () => {
        h.resolveQuery = () => ({ data: null, error: { code: '08006', message: 'connection failure' } });
        expect(await filterLiveRecipients([7, 9])).toBeNull();
    });

    it('scopes the probe to the requested ids and to live users', async () => {
        h.resolveQuery = () => ({ data: [{ id: 7 }], error: null });
        await filterLiveRecipients([7, 9]);
        const q = h.queries.find(x => x.table === 'users')!;
        expect(q.calls).toContainEqual({ method: 'in', args: ['id', [7, 9]] });
        expect(q.calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    });

    it('does not query at all for an empty recipient list', async () => {
        expect(await filterLiveRecipients([])).toEqual([]);
        expect(h.queries).toHaveLength(0);
    });
});

describe('deleteUser revokes the removed member push credentials', () => {
    it('deletes the ejected user push subscriptions', async () => {
        h.resolveQuery = (q) => {
            if (q.table === 'users' && has(q, 'maybeSingle')) return { data: { id: 5 }, error: null };
            return { data: null, error: null };
        };

        await deleteUser(5);

        const del = h.queries.find(q => q.table === 'push_subscriptions' && has(q, 'delete'));
        expect(del).toBeDefined();
        expect(del!.calls).toContainEqual({ method: 'eq', args: ['user_id', 5] });
    });
});
