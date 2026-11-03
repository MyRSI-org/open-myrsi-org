import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/users.ts — the db half of the logout/push fixes, plus one error-opacity fix.
//
//   1. savePushSubscription stores a field-by-field rebuild in the jsonb `subscription`
//      column — never its argument, which is how every row came to hold a copy of the
//      subscriber's full user record.
//   2. deleteOwnPushSubscription (user:logout) deletes ONLY the caller's row for the
//      supplied endpoint, and is a silent no-op for anything that is not an endpoint.
//   3. getRatingHistoryForUser no longer forwards PostgREST's error text.

const h = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    errors: {} as Record<string, { message: string; code?: string } | undefined>,
    deletes: [] as Array<{ table: string; filters: Record<string, unknown> }>,
    inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = { op: 'select', values: null as Record<string, unknown> | null, filters: {} as Record<string, unknown>, inFilters: {} as Record<string, unknown[]> };
        const rows = () => (h.tables[table] ?? []).filter((r) => {
            for (const [c, v] of Object.entries(state.filters)) if (r[c] !== v) return false;
            for (const [c, vals] of Object.entries(state.inFilters)) if (!vals.includes(r[c])) return false;
            return true;
        });
        const b: any = {};
        b.select = () => b;
        b.insert = (v: Record<string, unknown>) => { state.op = 'insert'; state.values = v; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.in = (c: string, vals: unknown[]) => { state.inFilters[c] = vals; return b; };
        b.is = () => b; b.not = () => b; b.order = () => b; b.limit = () => b;
        const settle = () => {
            const error = h.errors[table] ?? null;
            if (error) return Promise.resolve({ data: null, error });
            if (state.op === 'insert') {
                h.inserts.push({ table, values: state.values as Record<string, unknown> });
                (h.tables[table] = h.tables[table] ?? []).push({ ...(state.values as Record<string, unknown>) });
                return Promise.resolve({ data: null, error: null });
            }
            if (state.op === 'delete') {
                h.deletes.push({ table, filters: { ...state.filters } });
                const doomed = rows();
                h.tables[table] = (h.tables[table] ?? []).filter((r) => !doomed.includes(r));
                return Promise.resolve({ data: null, error: null });
            }
            return Promise.resolve({ data: rows(), error: null });
        };
        b.single = () => settle();
        b.maybeSingle = () => settle();
        b.then = (res: any, rej: any) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        // Same contract as lib/supabaseServer.ts: detail to the log, only the caller's
        // fixed message in the thrown Error.
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
    };
});

import { savePushSubscription, deleteOwnPushSubscription, getRatingHistoryForUser } from '../lib/db/users';
import { isOpaqueServerError } from '../lib/errors';

const E = (n: number) => `https://fcm.googleapis.com/fcm/send/tok-${n}`;
const keys = { p256dh: 'BPk', auth: 'aGVsbG8' };

beforeEach(() => { h.tables = {}; h.errors = {}; h.deletes = []; h.inserts = []; });

describe('savePushSubscription stores the subscription and nothing else', () => {
    it('drops an injected user record and every unknown field, at both levels', async () => {
        const polluted = {
            endpoint: E(1),
            keys: { ...keys, extra: 'nope' },
            expirationTime: null,
            user: { id: 1, discordId: '123', permissions: ['admin:access'], adminNotes: 'secret' },
            userId: 1,
            arbitrary: { nested: true },
        };
        await savePushSubscription(1, polluted as unknown as Parameters<typeof savePushSubscription>[1]);
        expect(h.inserts).toHaveLength(1);
        const stored = h.inserts[0].values.subscription as Record<string, unknown>;
        expect(Object.keys(stored).sort()).toEqual(['endpoint', 'expirationTime', 'keys']);
        expect(stored).not.toHaveProperty('user');
        expect(Object.keys(stored.keys as object).sort()).toEqual(['auth', 'p256dh']);
        expect(stored).toEqual({ endpoint: E(1), keys, expirationTime: null });
        // A fresh object, not the argument with keys deleted off it.
        expect(stored).not.toBe(polluted);
    });

    it.each([
        ['a number is kept', 1767225600000, true],
        ['null is kept', null, true],
        ['a string is dropped', '1767225600000', false],
        ['an object is dropped', { at: 1 }, false],
        ['absent stays absent', undefined, false],
    ])('expirationTime: %s', async (_label, expirationTime, kept) => {
        await savePushSubscription(1, { endpoint: E(1), keys, expirationTime } as unknown as Parameters<typeof savePushSubscription>[1]);
        const stored = h.inserts[0].values.subscription as Record<string, unknown>;
        expect('expirationTime' in stored).toBe(kept);
        if (kept) expect(stored.expirationTime).toBe(expirationTime);
    });

    it('rejects non-string keys rather than storing them', async () => {
        await expect(savePushSubscription(1, { endpoint: E(1), keys: { p256dh: { toString: () => 'x' }, auth: 'a' } } as unknown as Parameters<typeof savePushSubscription>[1]))
            .rejects.toThrow(/keys/i);
        expect(h.inserts).toHaveLength(0);
    });
});

describe('deleteOwnPushSubscription — the caller\'s row for that endpoint, nothing else', () => {
    beforeEach(() => {
        h.tables.push_subscriptions = [
            { id: 'a', user_id: 7, endpoint: E(1) },
            { id: 'b', user_id: 8, endpoint: E(2) },
            { id: 'c', user_id: 7, endpoint: E(3) },
        ];
    });
    const ids = () => (h.tables.push_subscriptions ?? []).map((r) => r.id);

    it('deletes only the matching row of the caller', async () => {
        await deleteOwnPushSubscription(7, E(1));
        expect(ids()).toEqual(['b', 'c']);
        expect(h.deletes).toEqual([{ table: 'push_subscriptions', filters: { user_id: 7, endpoint: E(1) } }]);
    });

    it('never deletes another member\'s row, even given their endpoint', async () => {
        await deleteOwnPushSubscription(7, E(2));
        expect(ids()).toEqual(['a', 'b', 'c']);
        expect(h.deletes[0].filters).toMatchObject({ user_id: 7 });
    });

    it.each([
        ['missing', undefined],
        ['empty', ''],
        ['a number', 42],
        ['an object', { endpoint: E(1) }],
        ['absurdly long', `https://fcm.googleapis.com/${'x'.repeat(5000)}`],
    ])('issues no delete at all when the endpoint is %s', async (_label, endpoint) => {
        await deleteOwnPushSubscription(7, endpoint);
        expect(h.deletes).toHaveLength(0);
        expect(ids()).toEqual(['a', 'b', 'c']);
    });

    it.each([[0], [-1], [1.5], [Number.NaN]])('issues no delete for user id %s', async (userId) => {
        await deleteOwnPushSubscription(userId, E(1));
        expect(h.deletes).toHaveLength(0);
    });

    it('swallows a database error — a cleanup fault must not fail the logout', async () => {
        h.errors.push_subscriptions = { message: 'connection reset', code: '08006' };
        await expect(deleteOwnPushSubscription(7, E(1))).resolves.toBeUndefined();
    });
});

describe('getRatingHistoryForUser — no raw PostgREST text past the classifier', () => {
    it('throws the fixed message, not the database error text', async () => {
        const raw = 'relation "public.request_responders" does not exist';
        h.errors.request_responders = { message: raw, code: '42P01' };
        const err = await getRatingHistoryForUser(1).then(() => null, (e: unknown) => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toBe('Failed to get rating history');
        expect(err!.message).not.toContain('request_responders');
        // The dispatcher forwards a plain Error's message verbatim (isOpaqueServerError is
        // false for it), which is exactly why the message itself must be the fixed copy.
        expect(isOpaqueServerError(err)).toBe(false);
    });
});
