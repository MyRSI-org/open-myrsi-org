import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/notifications.ts — the per-user inbox.
//
// The notifications table is service-role only, so app code is the ONLY boundary:
// every query must be scoped by the server-derived user id, every mutation must
// prove ownership first, and the realtime signal must carry ids, never content.
// This suite pins each of those against a recording Supabase double, plus the
// best-effort contracts (a not-yet-migrated table degrades rather than breaking the
// triggering mutation; a dead push endpoint never fails it) and the bounded
// retention sweep.

const h = vi.hoisted(() => ({
    push: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../lib/db/common', async () => (await import('./cov-db-users-bans-fake')).commonMock);
vi.mock('../lib/push', () => ({ sendPushToUsers: (...a: unknown[]) => h.push(...a) }));
vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    return { ...actual, log: { ...actual.log, child: () => h.log } };
});

import {
    getUserNotifications, getUnreadCount, createNotification, markNotificationsRead,
    markAllNotificationsRead, deleteNotification, getUserNotificationState, pruneOldNotifications,
} from '../lib/db/notifications';
import { SecurityDenial } from '../lib/errors';
import { sb, resetSb, queue, on, chainOf, argsOf, has, assertNoWildcardSelect } from './cov-db-users-bans-fake';

const COLS = 'id, user_id, type, title, body, link, metadata, read_at, created_at';
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const DAY = 86_400_000;

const nrow = (id: number, over: Record<string, unknown> = {}) => ({
    id, user_id: 5, type: 'request_update', title: `T${id}`, body: 'B', link: '/r/1', metadata: { requestId: 1 },
    read_at: null, created_at: '2026-05-01T00:00:00Z', ...over,
});

beforeEach(() => {
    resetSb();
    h.push.mockReset();
    h.push.mockResolvedValue(undefined);
    for (const fn of Object.values(h.log)) fn.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
    assertNoWildcardSelect();
});

describe('userId is mandatory on every entry point (never client-supplied, never absent)', () => {
    it.each([[0], [-1], [Number.NaN]])('rejects userId %s before any query', async (bad) => {
        await expect(getUserNotifications(bad)).rejects.toThrow('getUserNotifications: userId is required');
        await expect(getUnreadCount(bad)).rejects.toThrow('getUnreadCount: userId is required');
        await expect(createNotification(bad, { type: 't', title: 'x' })).rejects.toThrow('createNotification: userId is required');
        await expect(markNotificationsRead(bad, [1])).rejects.toThrow('markNotificationsRead: userId is required');
        await expect(markAllNotificationsRead(bad)).rejects.toThrow('markAllNotificationsRead: userId is required');
        await expect(deleteNotification(bad, 1)).rejects.toThrow('deleteNotification: userId is required');
        expect(sb.queries).toEqual([]);
    });
});

describe('getUserNotifications', () => {
    it('self-scoped, newest-first with id tiebreak, capped at 50; user_id never surfaced', async () => {
        queue('notifications', {
            data: [
                nrow(2),
                nrow(1, { body: null, link: null, metadata: ['not', 'an', 'object'] }),
                nrow(0, { metadata: null, read_at: '2026-05-02T00:00:00Z' }),
            ],
        });
        const out = await getUserNotifications(5);
        expect(chainOf(on('notifications')[0])).toEqual([
            ['select', COLS],
            ['eq', 'user_id', 5],
            ['order', 'created_at', { ascending: false }],
            ['order', 'id', { ascending: false }],
            ['limit', 50],
        ]);
        expect(out).toEqual([
            { id: 2, type: 'request_update', title: 'T2', body: 'B', link: '/r/1', metadata: { requestId: 1 }, readAt: null, createdAt: '2026-05-01T00:00:00Z' },
            { id: 1, type: 'request_update', title: 'T1', body: '', link: null, metadata: {}, readAt: null, createdAt: '2026-05-01T00:00:00Z' },
            { id: 0, type: 'request_update', title: 'T0', body: 'B', link: '/r/1', metadata: {}, readAt: '2026-05-02T00:00:00Z', createdAt: '2026-05-01T00:00:00Z' },
        ]);
        for (const n of out) expect(n).not.toHaveProperty('user_id');
    });

    it('unreadOnly adds read_at IS NULL; offset pages with range(); limit clamps to [1, 100]', async () => {
        queue('notifications', { data: [] }, { data: [] }, { data: [] });
        await getUserNotifications(5, { unreadOnly: true, limit: 500, offset: 20 });
        await getUserNotifications(5, { limit: 0 });
        await getUserNotifications(5, { limit: 10 });
        const [a, b, c] = on('notifications');
        expect(chainOf(a)).toEqual([
            ['select', COLS],
            ['eq', 'user_id', 5],
            ['is', 'read_at', null],
            ['order', 'created_at', { ascending: false }],
            ['order', 'id', { ascending: false }],
            ['limit', 100],
            ['range', 20, 119],
        ]);
        expect(argsOf(b, 'limit')).toEqual([1]);
        expect(has(b, 'range')).toBe(false);
        expect(argsOf(c, 'limit')).toEqual([10]);
    });

    it('a not-yet-migrated table degrades to [] with a warn; a null page is []', async () => {
        queue('notifications', { error: { code: '42P01', message: 'relation missing' } }, { data: null });
        expect(await getUserNotifications(5)).toEqual([]);
        expect(sb.safeFetchLogs).toEqual([{
            level: 'warn', msg: 'safeFetch returning fallback',
            fields: { target: 'getUserNotifications', code: '42P01', errMessage: 'relation missing', hint: '', details: '' },
        }]);
        expect(await getUserNotifications(5)).toEqual([]);
        expect(sb.safeFetchLogs).toHaveLength(1);
    });

    // safeFetch never throws: a real DB fault ALSO degrades to the [] fallback (the
    // inbox shows nothing rather than another user's rows or a crash), but it is
    // LOGGED as an error, never swallowed silently, and the query stayed user-scoped.
    it('any other DB fault also degrades to [] — logged as an error, query still self-scoped', async () => {
        queue('notifications', { data: [nrow(1)], error: { code: 'XX000', message: 'internal', hint: 'h', details: 'd' } });
        expect(await getUserNotifications(5)).toEqual([]);
        expect(argsOf(on('notifications')[0], 'eq')).toEqual(['user_id', 5]);
        expect(sb.handledErrors).toEqual([{ message: 'getUserNotifications', error: expect.objectContaining({ code: 'XX000' }) }]);
        expect(sb.safeFetchLogs).toEqual([
            {
                level: 'error', msg: 'safeFetch DB error',
                fields: { target: 'getUserNotifications', code: 'XX000', errMessage: 'internal', hint: 'h', details: 'd' },
            },
            {
                level: 'error', msg: 'safeFetch fatal',
                fields: { target: 'getUserNotifications', err: expect.objectContaining({ message: 'getUserNotifications' }) },
            },
        ]);
    });

    it('a rejecting query (network failure) degrades to [] and is logged as fatal', async () => {
        const boom = new Error('socket hang up');
        sb.handler = () => { throw boom; };
        expect(await getUserNotifications(5)).toEqual([]);
        expect(argsOf(on('notifications')[0], 'eq')).toEqual(['user_id', 5]);
        expect(sb.safeFetchLogs).toEqual([{ level: 'error', msg: 'safeFetch fatal', fields: { target: 'getUserNotifications', err: boom } }]);
    });
});

describe('getUnreadCount', () => {
    it('head-only exact count scoped to the user and unread', async () => {
        queue('notifications', { count: 4 });
        expect(await getUnreadCount(5)).toBe(4);
        expect(chainOf(on('notifications')[0])).toEqual([
            ['select', 'id', { count: 'exact', head: true }],
            ['eq', 'user_id', 5],
            ['is', 'read_at', null],
        ]);
    });

    it('null count → 0; missing table → 0; other fault throws', async () => {
        queue('notifications', { count: null }, { error: { code: '42P01' } }, { error: { code: 'XX000' } });
        expect(await getUnreadCount(5)).toBe(0);
        expect(await getUnreadCount(5)).toBe(0);
        await expect(getUnreadCount(5)).rejects.toThrow('Failed to count notifications');
    });
});

describe('createNotification — durable row + id-only signal + best-effort push', () => {
    it('validates type and title', async () => {
        await expect(createNotification(5, { type: '', title: 'x' })).rejects.toThrow('createNotification: type and title are required');
        await expect(createNotification(5, { type: 't', title: '' })).rejects.toThrow('createNotification: type and title are required');
        await expect(createNotification(5, undefined as unknown as { type: string; title: string })).rejects.toThrow(/type and title/);
        expect(sb.queries).toEqual([]);
    });

    it('inserts, broadcasts ONLY ids, and pushes the non-sensitive summary', async () => {
        queue('notifications', { data: nrow(77, { title: 'Request accepted', body: 'Your request was accepted', link: '/requests/9' }) });
        const out = await createNotification(5, {
            type: 'request_update', title: 'Request accepted', body: 'Your request was accepted', link: '/requests/9', metadata: { requestId: 9 },
        });
        expect(chainOf(on('notifications')[0])).toEqual([
            ['insert', { user_id: 5, type: 'request_update', title: 'Request accepted', body: 'Your request was accepted', link: '/requests/9', metadata: { requestId: 9 } }],
            ['select', COLS],
            ['single'],
        ]);
        expect(out).toMatchObject({ id: 77, title: 'Request accepted', link: '/requests/9' });
        // Rule 4: exactly two id fields, no title / body / link on the wire.
        expect(sb.broadcasts).toEqual([{ event: 'notification_update', payload: { notificationId: 77, targetUserId: 5 } }]);
        expect(h.push).toHaveBeenCalledTimes(1);
        expect(h.push).toHaveBeenCalledWith([5], {
            title: 'Request accepted', body: 'Your request was accepted', tag: 'notification-77', data: { url: '/requests/9' },
        });
    });

    it('defaults body/link to null and metadata to {}; push falls back to a generic body and "/"', async () => {
        queue('notifications', { data: nrow(8, { body: null, link: null, metadata: {} }) });
        await createNotification(5, { type: 't', title: 'Hi' });
        expect(argsOf(on('notifications')[0], 'insert')).toEqual([{ user_id: 5, type: 't', title: 'Hi', body: null, link: null, metadata: {} }]);
        expect(h.push).toHaveBeenCalledWith([5], { title: 'T8', body: 'Open the dashboard to view.', tag: 'notification-8', data: { url: '/' } });
    });

    it('a rejecting push never fails the triggering mutation', async () => {
        h.push.mockRejectedValue(new Error('push endpoint 410'));
        queue('notifications', { data: nrow(9) });
        await expect(createNotification(5, { type: 't', title: 'x' })).resolves.toMatchObject({ id: 9 });
        // Let the swallowed rejection settle.
        await Promise.resolve();
        expect(sb.broadcasts).toHaveLength(1);
    });

    it('a missing table returns null — no broadcast, no push', async () => {
        queue('notifications', { error: { code: '42P01' } });
        expect(await createNotification(5, { type: 't', title: 'x' })).toBeNull();
        expect(sb.broadcasts).toEqual([]);
        expect(h.push).not.toHaveBeenCalled();
    });

    it('any other insert fault throws — no broadcast, no push', async () => {
        queue('notifications', { error: { code: '23502' } });
        await expect(createNotification(5, { type: 't', title: 'x' })).rejects.toThrow('Failed to create notification');
        expect(sb.broadcasts).toEqual([]);
        expect(h.push).not.toHaveBeenCalled();
    });

    it('no row back without an error → null, no signal', async () => {
        queue('notifications', { data: null });
        expect(await createNotification(5, { type: 't', title: 'x' })).toBeNull();
        expect(sb.broadcasts).toEqual([]);
        expect(h.push).not.toHaveBeenCalled();
    });
});

describe('markNotificationsRead — ownership asserted BEFORE the write (BOLA)', () => {
    it('drops non-positive / non-integer ids; an empty set is a no-op with no query', async () => {
        expect(await markNotificationsRead(5, [0, -1, 1.5])).toBe(0);
        expect(await markNotificationsRead(5, undefined as unknown as number[])).toBe(0);
        expect(sb.queries).toEqual([]);
    });

    it('owned ids: ownership probe, then a self-scoped update of unread rows only', async () => {
        queue('notifications', { data: [{ id: 1 }, { id: 2 }] }, { data: [{ id: 1 }] });
        expect(await markNotificationsRead(5, [1, 2, 0])).toBe(1);
        const [probe, write] = on('notifications');
        expect(chainOf(probe)).toEqual([['select', 'id'], ['eq', 'user_id', 5], ['in', 'id', [1, 2]]]);
        expect(chainOf(write)).toEqual([
            ['update', { read_at: new Date(NOW).toISOString() }],
            ['eq', 'user_id', 5],
            ['in', 'id', [1, 2]],
            ['is', 'read_at', null],
            ['select', 'id'],
        ]);
    });

    it('a foreign id is a SecurityDenial and NOTHING is written', async () => {
        queue('notifications', { data: [{ id: 1 }] });
        const err = await markNotificationsRead(5, [1, 2, 3]).catch((e: unknown) => e) as SecurityDenial;
        expect(err).toBeInstanceOf(SecurityDenial);
        expect(err.message).toBe('One or more notifications do not belong to this user.');
        expect(err.auditEvent).toBe('authz.cross_user.denied');
        // The count only — the foreign ids themselves are not echoed into the audit bag.
        expect(err.fields).toEqual({ userId: 5, count: 2 });
        expect(on('notifications').some((q) => q.op === 'update')).toBe(false);
    });

    it('a missing table FAILS CLOSED into a denial (no owned ids), never a blind write', async () => {
        queue('notifications', { data: null, error: { code: '42P01' } });
        await expect(markNotificationsRead(5, [1])).rejects.toBeInstanceOf(SecurityDenial);
        expect(on('notifications')).toHaveLength(1);
    });

    it('an ownership-probe fault throws an opaque error', async () => {
        queue('notifications', { error: { code: 'XX000' } });
        await expect(markNotificationsRead(5, [1])).rejects.toThrow('Failed to validate notifications');
        expect(on('notifications')).toHaveLength(1);
    });

    it('an update fault throws; null data counts as 0', async () => {
        queue('notifications', { data: [{ id: 1 }] }, { error: { code: 'XX000' } });
        await expect(markNotificationsRead(5, [1])).rejects.toThrow('Failed to mark notifications read');
        queue('notifications', { data: [{ id: 1 }] }, { data: null });
        expect(await markNotificationsRead(5, [1])).toBe(0);
    });
});

describe('markAllNotificationsRead / deleteNotification', () => {
    it('mark-all is self-scoped to unread rows and returns the count', async () => {
        queue('notifications', { data: [{ id: 1 }, { id: 2 }] });
        expect(await markAllNotificationsRead(5)).toBe(2);
        expect(chainOf(on('notifications')[0])).toEqual([
            ['update', { read_at: new Date(NOW).toISOString() }],
            ['eq', 'user_id', 5],
            ['is', 'read_at', null],
            ['select', 'id'],
        ]);
    });

    it('mark-all: missing table → 0; other fault throws', async () => {
        queue('notifications', { data: null, error: { code: '42P01' } }, { error: { code: 'XX000' } });
        expect(await markAllNotificationsRead(5)).toBe(0);
        await expect(markAllNotificationsRead(5)).rejects.toThrow('Failed to mark all notifications read');
    });

    it('delete is pinned to BOTH user_id and id, so a foreign id no-ops', async () => {
        await deleteNotification(5, 9);
        const q = on('notifications')[0];
        expect(q.op).toBe('delete');
        expect(chainOf(q)).toEqual([['delete'], ['eq', 'user_id', 5], ['eq', 'id', 9]]);
    });

    it('delete validates the id and surfaces a fault', async () => {
        await expect(deleteNotification(5, 0)).rejects.toThrow('deleteNotification: valid notificationId is required');
        await expect(deleteNotification(5, 1.5)).rejects.toThrow('deleteNotification: valid notificationId is required');
        expect(sb.queries).toEqual([]);
        queue('notifications', { error: { code: 'XX000' } });
        await expect(deleteNotification(5, 9)).rejects.toThrow('Failed to delete notification');
    });
});

describe('getUserNotificationState — the self-scoped read-subset bundle', () => {
    it('returns the capped list and the unread badge, both scoped to the same user', async () => {
        // The badge query is the one carrying select options ({ count, head }).
        sb.handler = (q) => (argsOf(q, 'select')?.[1] ? { count: 3 } : { data: [nrow(1)] });
        const out = await getUserNotificationState(5);
        expect(out.unreadCount).toBe(3);
        expect(out.notifications.map((n) => n.id)).toEqual([1]);
        const qs = on('notifications');
        expect(qs).toHaveLength(2);
        expect(qs.every((q) => JSON.stringify(argsOf(q, 'eq')) === JSON.stringify(['user_id', 5]))).toBe(true);
    });

    it('a list fault degrades the list to [] while the badge still reads', async () => {
        sb.handler = (q) => (argsOf(q, 'select')?.[1] ? { count: 2 } : { error: { code: 'XX000', message: 'internal' } });
        expect(await getUserNotificationState(5)).toEqual({ notifications: [], unreadCount: 2 });
        expect(sb.safeFetchLogs.map((l) => l.msg)).toEqual(['safeFetch DB error', 'safeFetch fatal']);
    });
});

describe('pruneOldNotifications — bounded retention sweep', () => {
    const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

    it('default 90 days: ordered capped select, then chunked deletes', async () => {
        queue('notifications', { data: ids(1, 2) }, {});
        expect(await pruneOldNotifications()).toBe(2);
        const [select, del] = on('notifications');
        expect(chainOf(select)).toEqual([
            ['select', 'id'],
            ['lt', 'created_at', new Date(NOW - 90 * DAY).toISOString()],
            ['order', 'id', { ascending: true }],
            ['limit', 5000],
        ]);
        expect(chainOf(del)).toEqual([['delete'], ['in', 'id', [1, 2]]]);
    });

    it('clamps a sub-day retention to one day', async () => {
        queue('notifications', { data: [] });
        await pruneOldNotifications(-3);
        expect(argsOf(on('notifications')[0], 'lt')).toEqual(['created_at', new Date(NOW - DAY).toISOString()]);
    });

    it('a full batch is deleted in ten 500-id chunks, then the sweep re-selects', async () => {
        queue('notifications', { data: ids(1, 5000) });
        for (let i = 0; i < 10; i++) queue('notifications', {});
        queue('notifications', { data: [] });
        expect(await pruneOldNotifications(30)).toBe(5000);
        const deletes = on('notifications').filter((q) => q.op === 'delete');
        expect(deletes.map((q) => (argsOf(q, 'in')![1] as unknown[]).length)).toEqual(Array(10).fill(500));
        expect(on('notifications').filter((q) => q.op === 'select')).toHaveLength(2);
    });

    it('stops at the runaway backstop of 500 batches', async () => {
        const full = ids(1, 5000);
        sb.handler = (q) => (q.op === 'select' ? { data: full } : {});
        expect(await pruneOldNotifications(30)).toBe(500 * 5000);
        expect(on('notifications').filter((q) => q.op === 'select')).toHaveLength(500);
    });

    it('a delete fault stops the sweep (no re-select) and reports what was deleted', async () => {
        queue('notifications', { data: ids(1, 5000) }, {}, { error: { code: '57014' } });
        expect(await pruneOldNotifications(30)).toBe(500);
        expect(h.log.warn).toHaveBeenCalledWith('pruneOldNotifications delete failed', { code: '57014' });
        expect(on('notifications').filter((q) => q.op === 'select')).toHaveLength(1);
    });

    it('a select fault warns (not for a missing table) and returns 0', async () => {
        queue('notifications', { error: { code: '57014' } });
        expect(await pruneOldNotifications(30)).toBe(0);
        expect(h.log.warn).toHaveBeenCalledWith('pruneOldNotifications select failed', { code: '57014' });
        h.log.warn.mockReset();
        queue('notifications', { error: { code: '42P01' } }, { data: null });
        expect(await pruneOldNotifications(30)).toBe(0);
        expect(await pruneOldNotifications(30)).toBe(0);
        expect(h.log.warn).not.toHaveBeenCalled();
    });

    it('NaN retention is caught and returns 0 without querying', async () => {
        expect(await pruneOldNotifications(Number.NaN)).toBe(0);
        expect(sb.queries).toEqual([]);
        expect(h.log.warn).toHaveBeenCalledWith('pruneOldNotifications threw', expect.objectContaining({ err: expect.any(RangeError) }));
    });
});
