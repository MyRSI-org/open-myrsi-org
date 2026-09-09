import { describe, it, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// pruneOldNotifications — retention sweep regressions
// =============================================================================
// The notifications inbox had no retention (rows accrued forever). A daily cron
// prunes rows older than 90 days. These pin the invariants that make the sweep
// both SAFE and EFFECTIVE:
//   • never deletes rows newer than the cutoff (fresh notifications survive);
//   • deletes in <=500-id chunks — postgrest serialises .in() into the request
//     URI, so a whole-batch delete of thousands of ids overflows the gateway
//     (HTTP 414) and silently no-ops (the bug this test guards against);
//   • handles a backlog larger than one 5000-id select batch (outer loop);
//   • never throws and prunes NOTHING on a degenerate `days` (NaN) arg.
//
// Behaviour-true supabase stub: models only the two calls the sweep makes —
// select(id).lt(created_at, cutoff).limit(n)  and  delete().in('id', chunk) —
// mutating the seeded row set on delete so the loop actually terminates, and
// recording every delete chunk size so we can assert the <=500 cap. Mocking
// '../lib/db/common.js' flows the stub into notifications.ts (single-org).

const h = vi.hoisted(() => {
    const state = {
        rows: [] as Array<{ id: number; created_at: string }>,
        deleteChunks: [] as number[],
    };

    function makeBuilder() {
        let verb: 'select' | 'delete' = 'select';
        let ltCol: string | null = null;
        let ltVal: string | null = null;
        let inIds: number[] | null = null;
        let lim = Infinity;

        const builder: any = {
            select: () => builder,
            delete: () => { verb = 'delete'; return builder; },
            lt: (col: string, val: string) => { ltCol = col; ltVal = val; return builder; },
            in: (_col: string, ids: number[]) => { inIds = ids; return builder; },
            order: () => builder, // capped reads carry a PK tiebreak so truncation is deterministic
            limit: (n: number) => { lim = n; return builder; },
            then: (resolve: (v: { data: unknown; error: null }) => unknown) => {
                if (verb === 'delete') {
                    const ids = inIds || [];
                    state.deleteChunks.push(ids.length);
                    const set = new Set(ids);
                    state.rows = state.rows.filter((r) => !set.has(r.id));
                    return resolve({ data: null, error: null });
                }
                let matched = state.rows;
                if (ltCol && ltVal != null) matched = matched.filter((r) => String((r as Record<string, unknown>)[ltCol as string]) < String(ltVal));
                matched = matched.slice(0, lim);
                return resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
            },
        };
        return builder;
    }

    const supabaseStub = { from: () => makeBuilder() };
    return { state, supabaseStub };
});

vi.mock('../lib/db/common.js', () => ({
    supabase: h.supabaseStub,
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
    safeFetch: async (query: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
        const { data, error } = await query;
        return error ? fallback : (data ?? fallback);
    },
    broadcastToOrg: () => Promise.resolve(),
}));
vi.mock('../lib/push.js', () => ({ sendPushToUsers: () => Promise.resolve() }));

import * as notif from '../lib/db/notifications';

const OLD = '2020-01-01T00:00:00.000Z';

const seed = (n: number, createdAt: string, startId = 1) => {
    for (let i = 0; i < n; i++) h.state.rows.push({ id: startId + i, created_at: createdAt });
};

beforeEach(() => {
    h.state.rows = [];
    h.state.deleteChunks = [];
});

describe('pruneOldNotifications — retention sweep', () => {
    it('deletes only rows older than the cutoff; fresh rows survive', async () => {
        seed(3, OLD, 1);                              // ancient → prune
        seed(2, new Date().toISOString(), 100);       // fresh → keep
        const deleted = await notif.pruneOldNotifications(90);
        expect(deleted).toBe(3);
        expect(h.state.rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([100, 101]);
    });

    it('chunks the delete at <=500 ids (never a giant .in() URI)', async () => {
        seed(1200, OLD, 1);
        const deleted = await notif.pruneOldNotifications(90);
        expect(deleted).toBe(1200);
        expect(h.state.rows.length).toBe(0);
        expect(Math.max(...h.state.deleteChunks)).toBeLessThanOrEqual(500);
        expect(h.state.deleteChunks.reduce((a, b) => a + b, 0)).toBe(1200);
        expect(h.state.deleteChunks).toEqual([500, 500, 200]);
    });

    it('handles a backlog larger than one 5000-id select batch', async () => {
        seed(5001, OLD, 1);
        const deleted = await notif.pruneOldNotifications(90);
        expect(deleted).toBe(5001);
        expect(h.state.rows.length).toBe(0);
        expect(Math.max(...h.state.deleteChunks)).toBeLessThanOrEqual(500);
    });

    it('never throws and prunes nothing on a NaN days arg', async () => {
        seed(3, OLD, 1);
        const deleted = await notif.pruneOldNotifications(NaN as unknown as number);
        expect(deleted).toBe(0);
        expect(h.state.rows.length).toBe(3);          // untouched
        expect(h.state.deleteChunks).toEqual([]);
    });

    it('no-ops cleanly on an empty table', async () => {
        const deleted = await notif.pruneOldNotifications(90);
        expect(deleted).toBe(0);
        expect(h.state.deleteChunks).toEqual([]);
    });
});
