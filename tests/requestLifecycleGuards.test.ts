import { describe, it, expect, vi, beforeEach } from 'vitest';

// THREE REQUEST-PATH BOUNDARIES THAT EXISTED ONLY IN REACT.
//
// A permission gate answers "may this caller act on requests?". It does not answer "may this
// request be cancelled RIGHT NOW?", "has this already been rated?" or "is this account allowed
// to raise requests at all?" — and those three questions were being asked exclusively by a
// button's `disabled` attribute. Every one is reachable by the LOWEST-privilege role in the
// product, which holds exactly ['request:create', 'request:cancel', 'request:rate'].
//
// The cancel and rate guards both defend the same thing: `public_stats_for_org()` is an
// UNAUTHENTICATED endpoint that counts `FILTER (WHERE status = 'Success')` and averages
// `client_rating`. A customer who dislikes an outcome could retroactively delete a finished
// job from the org's public scoreboard, or leave 5 stars to get the work done and quietly flip
// it to 1 a week later, repeatedly, with no history anywhere to reconstruct it.

const h = vi.hoisted(() => ({
    rows: {} as Record<string, Record<string, unknown> | null>,
    errors: {} as Record<string, { code?: string; message: string } | null>,
    inserted: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    count: 0,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = { op: 'select' };
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.insert = (v: Record<string, unknown>) => { state.op = 'insert'; h.inserted.push(v); return b; };
        b.update = (v: Record<string, unknown>) => { state.op = 'update'; h.updates.push(v); return b; };
        for (const m of ['eq', 'is', 'in', 'not', 'order', 'limit', 'ilike', 'range', 'gte', 'lte']) b[m] = () => b;
        const settle = (mode: 'single' | 'many') => {
            if (h.errors[table]) return Promise.resolve({ data: null, error: h.errors[table], count: null });
            if (state.op === 'insert') return Promise.resolve({ data: h.rows[table] ?? { id: 'SR-NEW' }, error: null, count: null });
            if (state.op === 'update') return Promise.resolve({ data: null, error: null, count: null });
            const row = h.rows[table] ?? null;
            return Promise.resolve({ data: mode === 'single' ? row : (row ? [row] : []), error: null, count: h.count });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => settle('many').then(r, j);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => ({}),
        safeFetch: async () => [],
    };
});
vi.mock('../lib/push', () => ({ sendPushToStaff: () => {}, sendPushToUsers: async () => {} }));
vi.mock('../lib/db/notifications', () => ({ createNotification: async () => null }));
vi.mock('../lib/db/users', () => ({ adminAdjustUserReputation: async () => undefined, getActorLabel: async () => 'X' }));

import { createServiceRequest, rateRequest } from '../lib/db/requests';
import { MIN_REQUEST_REPUTATION } from '../lib/requestLifecycle';

const CLIENT = { id: 5, permissions: ['request:rate'] };
const DUTY = { id: 6, permissions: ['request:dispatch'] };

beforeEach(() => {
    h.rows = {};
    h.errors = {};
    h.inserted = [];
    h.updates = [];
    h.count = 0;
});

describe('the standing floor — the org anti-abuse lever that did nothing', () => {
    // Both client copies refuse at reputation <= 10 and the admin console promises operators
    // that low-standing clients "are restricted from initiating new service requests". The
    // server never read the column. Worse, the client copy is not live in an open tab either:
    // adminAdjustUserReputation emits no broadcast, so a sanctioned session keeps rendering
    // the form for the rest of its 24-hour token. Meanwhile every create fans a push to EVERY
    // staff member and posts a Discord embed.
    it('refuses a create below the floor, and inserts nothing', async () => {
        h.rows.users = { reputation: MIN_REQUEST_REPUTATION - 1 };
        await expect(createServiceRequest({ serviceType: 'R', location: 'L', description: 'D' } as never, 5))
            .rejects.toThrow(/standing is too low/i);
        expect(h.inserted).toEqual([]);
    });

    it('admits a create at the floor', async () => {
        h.rows.users = { reputation: MIN_REQUEST_REPUTATION };
        await createServiceRequest({ serviceType: 'R', location: 'L', description: 'D' } as never, 5);
        // The create also writes a status_history row, so assert on the request insert itself.
        expect(h.inserted.some((r) => r.client_id === 5)).toBe(true);
    });

    it('the refusal message carries "Action Blocked" so the modal renders it specifically', async () => {
        // CreateRequestModal parses the server error by STRING and falls anything unmatched
        // through to "Please try again" — wrong advice for a permanent block, and each retry
        // writes another security_events row.
        h.rows.users = { reputation: 0 };
        await expect(createServiceRequest({ serviceType: 'R', location: 'L', description: 'D' } as never, 5))
            .rejects.toThrow(/Action Blocked/);
    });

    it('fails CLOSED when the standing read faults', async () => {
        h.errors.users = { message: 'connection reset' };
        await expect(createServiceRequest({ serviceType: 'R', location: 'L', description: 'D' } as never, 5))
            .rejects.toThrow(/verify your standing/i);
        expect(h.inserted).toEqual([]);
    });

    it('the ACTIVE-REQUEST check still takes precedence, so a busy client gets the right copy', async () => {
        // Putting the standing read first would have changed the error a rep-5 client with an
        // open request sees, from the specific "you already have an active request" copy the
        // modal matches to a standing message that is not the reason they were blocked.
        h.count = 1;
        h.rows.users = { reputation: 0 };
        await expect(createServiceRequest({ serviceType: 'R', location: 'L', description: 'D' } as never, 5))
            .rejects.toThrow(/already have an active service request/i);
    });

    it('the active-request count check FAILS CLOSED on a read fault', async () => {
        // It was `const { count } = await ...` — unbound, so a read fault yielded undefined,
        // the guard silently passed, and the one-active-request rule stopped applying at
        // exactly the moment the database was struggling.
        h.errors.service_requests = { message: 'connection reset' };
        await expect(createServiceRequest({ serviceType: 'R', location: 'L', description: 'D' } as never, 5))
            .rejects.toThrow(/verify your active requests/i);
        expect(h.inserted).toEqual([]);
    });
});

describe('one rating per request', () => {
    it('a first rating on a completed request is written', async () => {
        h.rows.service_requests = { status: 'Success', rated: false, client_rating: null };
        await rateRequest('r1', 5, 'great', CLIENT);
        expect(h.updates).toHaveLength(1);
        expect(h.updates[0]).toMatchObject({ rated: true, client_rating: 5 });
    });

    it('THE ATTACK: the client cannot overwrite a rating already given', async () => {
        h.rows.service_requests = { status: 'Success', rated: true, client_rating: 5 };
        await expect(rateRequest('r1', 1, 'changed my mind', CLIENT)).rejects.toThrow(/already been rated/i);
        expect(h.updates).toEqual([]);
    });

    it('an IMPORTED rating is protected too — rated IS NULL with a score present', async () => {
        // `rated` is `boolean DEFAULT false` and NULLABLE, and service_requests is written
        // ROW-WISE by the org importer rather than through createServiceRequest. Checking
        // `rated === true` alone would permit overwriting exactly this row: a migrated org's
        // history, which is the dataset feeding the public scoreboard.
        h.rows.service_requests = { status: 'Success', rated: null, client_rating: 4 };
        await expect(rateRequest('r1', 1, 'nope', CLIENT)).rejects.toThrow(/already been rated/i);
        expect(h.updates).toEqual([]);
    });

    it('a DUTY holder may still correct a rating — there is no rating-history table', async () => {
        // request:rate is a Dispatcher default precisely so staff can enter a rating for a
        // phoned-in job. With no history table, an absolute lock would make a mis-keyed value
        // permanently unfixable through the product. Mirrors how the cancel precondition
        // exempts duty.
        h.rows.service_requests = { status: 'Success', rated: true, client_rating: 5 };
        await rateRequest('r1', 3, 'corrected', DUTY);
        expect(h.updates).toHaveLength(1);
        expect(h.updates[0]).toMatchObject({ client_rating: 3 });
    });

    it('still refuses to rate a request that is not completed', async () => {
        h.rows.service_requests = { status: 'In-Progress', rated: false, client_rating: null };
        await expect(rateRequest('r1', 5, '', CLIENT)).rejects.toThrow(/completed request/i);
    });

    it('still clamps the star value before anything else', async () => {
        h.rows.service_requests = { status: 'Success', rated: false, client_rating: null };
        for (const bad of [0, 6, Number.NaN, Infinity]) {
            await expect(rateRequest('r1', bad, '', CLIENT)).rejects.toThrow(/1–5 stars/);
        }
        expect(h.updates).toEqual([]);
    });
});
