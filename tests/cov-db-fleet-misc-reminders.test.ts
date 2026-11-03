import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Supplementary pins for the two timer-driven egress jobs, covering the branches
// tests/opReminderDelivery.test.ts and tests/discordFeatureLayer.test.ts leave
// open: null-data reads (supabase-js resolves `{ data: null, error: null }`), the
// "now"/singular wording, an op with no start time, latest-row selection when the
// rows arrive out of order, and the start-notice per-op skip/failure paths.
//
// The push/Discord edges are stubbed here; the liveness intersect and the real
// claim ordering are pinned by the two dedicated suites above.

const h = vi.hoisted(() => ({
    pushes: [] as Array<{ ids: number[]; payload: Record<string, unknown> }>,
    live: vi.fn(async (ids: number[]) => ids as number[] | null),
    embed: vi.fn(async (_id: string) => ({ name: 'Op', restricted: false }) as unknown),
    post: vi.fn(async (_channel: string, _input: unknown) => ({ messageId: 'm1' }) as { messageId?: string | null }),
}));

vi.mock('../lib/log', async () => (await import('./cov-db-fleet-misc-sb')).logModule);
vi.mock('../lib/db/common', async () => ({ supabase: (await import('./cov-db-fleet-misc-sb')).fakeSupabase }));
vi.mock('../lib/push', () => ({
    filterLiveRecipients: h.live,
    sendPushToUsers: async (ids: number[], payload: Record<string, unknown>) => { h.pushes.push({ ids, payload }); },
}));
vi.mock('../lib/db/opAnnouncement', () => ({ buildAnnouncementEmbedInput: h.embed }));
vi.mock('../lib/discord', () => ({ postOperationStartingEmbed: h.post }));

import { resetAll, route, queriesFor, filterValue, assertExplicitColumns, logged, type Q } from './cov-db-fleet-misc-sb';
import { sendDueOperationReminders, drainStaleOperationReminders } from '../lib/db/opReminders';
import { sendDueOperationStartNotices } from '../lib/db/opStartNotices';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
    resetAll();
    h.pushes = [];
    h.live.mockReset();
    h.live.mockImplementation(async (ids: number[]) => ids);
    h.embed.mockReset();
    h.embed.mockResolvedValue({ name: 'Op', restricted: false });
    h.post.mockReset();
    h.post.mockResolvedValue({ messageId: 'm1' });
});

afterEach(() => {
    assertExplicitColumns();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('sendDueOperationReminders — supplementary', () => {
    const op = (over: Record<string, unknown> = {}) => ({
        id: 'op1', name: 'Nightfall', scheduled_start: iso(NOW), status: 'Scheduled', clearance_level: 0, is_special: false, ...over,
    });
    /** Wire one tick: due rows, ops, markers, participants, and a claim that wins every row. */
    function wire(opts: {
        due?: unknown; ops?: unknown; markers?: unknown; parts?: unknown; claimed?: unknown | ((q: Q) => unknown);
    }) {
        route('operation_reminders:select', { data: opts.due });
        route('operations:select', { data: opts.ops });
        route('operation_limiting_markers:select', { data: opts.markers });
        route('operation_participants:select', { data: opts.parts });
        route('operation_reminders:update', (q) => {
            if (!q.selectCalled) return {}; // the expiry sweep
            const c = typeof opts.claimed === 'function' ? (opts.claimed as (q: Q) => unknown)(q) : opts.claimed;
            return { data: c };
        });
    }
    const claimAll = (q: Q) => (filterValue(q, 'in', 'id') as string[]).map((id) => ({ id }));

    it('returns 0 without any op lookup when the scan yields null data', async () => {
        wire({ due: null });
        await expect(sendDueOperationReminders(NOW)).resolves.toBe(0);
        expect(queriesFor('operations')).toEqual([]);
        expect(h.pushes).toEqual([]);
    });

    it('an op starting right now (or just started, within grace) reads "Starting now!"', async () => {
        wire({
            due: [{ id: 'r1', operation_id: 'op1', remind_at: iso(NOW - 60_000) }, { id: 'r2', operation_id: 'op2', remind_at: iso(NOW - 60_000) }],
            ops: [op(), op({ id: 'op2', name: 'Dawn', scheduled_start: iso(NOW - 5 * 60_000) })],
            markers: [], parts: [{ operation_id: 'op1', user_id: 5 }, { operation_id: 'op2', user_id: 6 }], claimed: claimAll,
        });
        await expect(sendDueOperationReminders(NOW)).resolves.toBe(2);
        expect(h.pushes.map((p) => [p.ids, p.payload.title, p.payload.body])).toEqual([
            [[5], 'Operation Reminder: Nightfall', 'Starting now!'],
            [[6], 'Operation Reminder: Dawn', 'Starting now!'],
        ]);
        expect(h.pushes[0].payload).toMatchObject({ tag: 'op-reminder-op1', renotify: true, data: { type: 'operation_reminder', operationId: 'op1', url: '/operations' } });
    });

    it('a restricted op starting now gets the generic, name-free body', async () => {
        wire({
            due: [{ id: 'r1', operation_id: 'op1', remind_at: iso(NOW - 60_000) }],
            ops: [op({ clearance_level: 2 })], markers: [], parts: [{ operation_id: 'op1', user_id: 5 }], claimed: claimAll,
        });
        await sendDueOperationReminders(NOW);
        expect(h.pushes[0].payload.title).toBe('Operation Reminder');
        expect(h.pushes[0].payload.body).toBe('An operation you joined starts now. Open the dashboard to view.');
        expect(JSON.stringify(h.pushes[0].payload)).not.toContain('Nightfall');
    });

    it('uses the singular for a one-minute lead', async () => {
        wire({
            due: [{ id: 'r1', operation_id: 'op1', remind_at: iso(NOW - 60_000) }],
            ops: [op({ scheduled_start: iso(NOW + 60_000) })], markers: null, parts: [{ operation_id: 'op1', user_id: 5 }], claimed: claimAll,
        });
        await sendDueOperationReminders(NOW);
        // Null marker data (no error) is "no markers" — clearance 0, not special → named.
        expect(h.pushes[0].payload).toMatchObject({ title: 'Operation Reminder: Nightfall', body: 'Starting in 1 minute' });
    });

    // Which of the op's rows is kept is not observable — the push is built from the
    // op's LIVE scheduled_start, not the row — so this pins the observable half:
    // one push per op, whatever order the due rows arrive in.
    it('sends ONE push per op when its later row arrives before the earlier one', async () => {
        wire({
            due: [
                { id: 'r-late', operation_id: 'op1', remind_at: iso(NOW - 60_000) },
                { id: 'r-early', operation_id: 'op1', remind_at: iso(NOW - 26 * 60_000) },
            ],
            ops: [op({ scheduled_start: iso(NOW + 4 * 60_000) })], markers: [], parts: [{ operation_id: 'op1', user_id: 5 }], claimed: claimAll,
        });
        await expect(sendDueOperationReminders(NOW)).resolves.toBe(1);
        expect(h.pushes).toHaveLength(1);
        expect(h.pushes[0].payload.body).toBe('Starting in 4 minutes');
        // Both rows were claimed (consumed) even though only one push went out.
        const claim = queriesFor('operation_reminders', 'update').find((q) => q.selectCalled)!;
        expect(filterValue(claim, 'in', 'id')).toEqual(['r-late', 'r-early']);
    });

    it('skips an op with no scheduled start, and an op with no participants', async () => {
        wire({
            due: [{ id: 'r1', operation_id: 'op1', remind_at: iso(NOW - 60_000) }, { id: 'r2', operation_id: 'op2', remind_at: iso(NOW - 60_000) }],
            ops: [op({ scheduled_start: null }), op({ id: 'op2' })], markers: [], parts: [{ operation_id: 'op1', user_id: 5 }], claimed: claimAll,
        });
        await expect(sendDueOperationReminders(NOW)).resolves.toBe(0);
        expect(h.pushes).toEqual([]);
    });

    it('null op/participant reads push nothing (no op, no audience)', async () => {
        wire({ due: [{ id: 'r1', operation_id: 'op1', remind_at: iso(NOW - 60_000) }], ops: null, markers: [], parts: null, claimed: claimAll });
        await expect(sendDueOperationReminders(NOW)).resolves.toBe(0);
        expect(h.live).toHaveBeenCalledWith([]);
        expect(h.pushes).toEqual([]);
    });

    it('a null claim result wins nothing and pushes nothing', async () => {
        wire({ due: [{ id: 'r1', operation_id: 'op1', remind_at: iso(NOW - 60_000) }], ops: [op()], markers: [], parts: [{ operation_id: 'op1', user_id: 5 }], claimed: null });
        await expect(sendDueOperationReminders(NOW)).resolves.toBe(0);
        expect(h.pushes).toEqual([]);
    });

    it('drainStaleOperationReminders reports 0 quietly when nothing was stale', async () => {
        route('operation_reminders:update', { data: null });
        await expect(drainStaleOperationReminders(NOW)).resolves.toBe(0);
        expect(logged('info', 'drained stale operation reminders')).toBeUndefined();
        const [q] = queriesFor('operation_reminders', 'update');
        expect(q.payload).toEqual({ sent: true });
        expect(q.filters).toEqual([['eq', 'sent', false], ['lt', 'remind_at', iso(NOW - 60 * 60 * 1000)]]);
        expect(q.columns).toBe('id');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('sendDueOperationStartNotices — supplementary', () => {
    const due = (over: Record<string, unknown> = {}) => ({
        id: 'op-1', scheduled_start: iso(NOW + 10 * 60_000), status: 'Scheduled', discord_announcement_channel_id: '123456789012345678', ...over,
    });
    function wire(rows: unknown, claimed: unknown | ((q: Q) => unknown) = (q: Q) => (filterValue(q, 'in', 'id') as string[]).map((id) => ({ id }))) {
        route('operations:select', { data: rows });
        route('operations:update', (q) => ({ data: typeof claimed === 'function' ? (claimed as (q: Q) => unknown)(q) : claimed }));
    }

    it('scans the exact consent + window predicate, bounded and totally ordered', async () => {
        wire([]);
        await sendDueOperationStartNotices(NOW);
        const [scan] = queriesFor('operations', 'select');
        expect(scan.columns).toBe('id, scheduled_start, status, discord_announcement_channel_id');
        expect(scan.filters).toEqual([
            ['eq', 'discord_start_notice', true],
            ['in', 'status', ['Planning', 'Scheduled']],
            ['is', 'discord_start_notice_sent_at', null],
            ['gt', 'scheduled_start', iso(NOW)],
            ['lte', 'scheduled_start', iso(NOW + 15 * 60_000)],
        ]);
        expect(scan.orders).toEqual([['scheduled_start', { ascending: true }], ['id', { ascending: true }]]);
        expect(scan.limit).toBe(25);
        expect(queriesFor('operations', 'update')).toEqual([]);
    });

    it('null scan data claims nothing', async () => {
        wire(null);
        await expect(sendDueOperationStartNotices(NOW)).resolves.toBe(0);
        expect(queriesFor('operations', 'update')).toEqual([]);
    });

    it('a null claim result posts nothing', async () => {
        wire([due()], null);
        await expect(sendDueOperationStartNotices(NOW)).resolves.toBe(0);
        expect(h.post).not.toHaveBeenCalled();
    });

    it('skips (without falling back) an op whose channel is blank, and one whose embed cannot be built', async () => {
        wire([due({ id: 'a', discord_announcement_channel_id: '   ' }), due({ id: 'b', discord_announcement_channel_id: null }), due({ id: 'c' }), due({ id: 'd' })]);
        h.embed.mockImplementation(async (id: string) => (id === 'c' ? null : { name: id, restricted: true }));
        await expect(sendDueOperationStartNotices(NOW)).resolves.toBe(1);
        // a/b never even build an embed; c builds none; only d posts, to its own channel.
        expect(h.embed.mock.calls.map((c) => c[0])).toEqual(['c', 'd']);
        expect(h.post.mock.calls).toEqual([['123456789012345678', { name: 'd', restricted: true }]]);
    });

    it('a post that throws is logged and does not count; a post with no message id does not count', async () => {
        wire([due({ id: 'x' }), due({ id: 'y' }), due({ id: 'z' })]);
        h.post.mockImplementation(async (_c: string, input: unknown) => {
            const name = (input as { name: string }).name;
            if (name === 'x') throw new Error('discord 500');
            if (name === 'y') return { messageId: null };
            return { messageId: 'm-z' };
        });
        h.embed.mockImplementation(async (id: string) => ({ name: id, restricted: false }));
        await expect(sendDueOperationStartNotices(NOW)).resolves.toBe(1);
        expect(logged('warn', 'start notice post threw')).toBeDefined();
        // The claim is never rolled back after a failed post (quiet beats duplicated).
        expect(queriesFor('operations', 'update')).toHaveLength(1);
    });
});
