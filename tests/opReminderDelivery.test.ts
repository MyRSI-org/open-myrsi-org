import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Pins for the operation-reminder delivery consumer (lib/db/opReminders.ts).
//
// createOperationReminders has written operation_reminders rows since day one and
// NOTHING read them, so no operation push reminder had ever fired on any
// deployment. These tests pin the consumer AND the egress rules that make it safe
// to ship:
//   1. A RESTRICTED op (clearance / limiting marker / special) never puts its NAME
//      in the push — the participant set drifts out of an op's visibility
//      (addOperationParticipant does not clearance-check the target, markers can be
//      added after people join, clearance can be revoked).
//   2. The restriction probe FAILS CLOSED: a marker-probe fault leaves the op
//      restricted, it does not collapse to "unrestricted".
//   3. Removed members are intersected out — deleteUser only soft-deletes, so they
//      stay "active participants" with live push subscriptions.
//   4. CLAIM BEFORE EGRESS, but AFTER the side-effect-free reads: a read fault
//      leaves the rows unclaimed and retryable; the claim is conditional on
//      sent=false so overlapping workers claim disjoint sets.
//   5. The delivery window is evaluated against the op's LIVE scheduled_start
//      (updateOperation never rebuilds these rows), and one push per op per tick.
//   6. The job is actually WIRED into the cron registry — the whole defect was a
//      module nobody called.

type Q = { table: string; calls: Array<{ method: string; args: unknown[] }> };

const h = vi.hoisted(() => ({
    resolveQuery: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: [] as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown },
    queries: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    // `qAt` stamps the query cursor at push time — h.queries and h.pushes are
    // otherwise separate arrays with no shared ordinal, and claim-BEFORE-egress
    // is an ordering claim.
    pushes: [] as Array<{ ids: number[]; payload: Record<string, unknown>; qAt: number }>,
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
    };
});

// Only sendPushToUsers is stubbed: filterLiveRecipients stays REAL so the
// removed-member intersect is exercised against the recorded query layer.
vi.mock('../lib/push', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/push')>();
    return {
        ...actual,
        sendPushToUsers: async (ids: number[], payload: unknown) => {
            h.pushes.push({ ids, payload: payload as Record<string, unknown>, qAt: h.queries.length });
        },
    };
});

import { sendDueOperationReminders, drainStaleOperationReminders, REMINDER_EXPIRY_MS } from '../lib/db/opReminders';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const has = (q: Q, method: string, arg0?: unknown) =>
    q.calls.some(c => c.method === method && (arg0 === undefined || c.args[0] === arg0));
const argsOf = (q: Q, method: string, arg0: unknown) =>
    q.calls.find(c => c.method === method && c.args[0] === arg0)?.args;

const isUpdate = (q: Q) => has(q, 'update');
const reminderQueries = () => h.queries.filter(q => q.table === 'operation_reminders');
const sweepQuery = () => reminderQueries().find(q => isUpdate(q) && !has(q, 'in', 'id'));
const claimQuery = () => reminderQueries().find(q => isUpdate(q) && has(q, 'in', 'id'));
const scanQuery = () => reminderQueries().find(q => !isUpdate(q));
const indexOfQuery = (q: Q | undefined) => (q ? h.queries.indexOf(q) : -1);

type World = {
    reminders: Array<{ id: string; operation_id: string; remind_at: string }>;
    operations: Array<Record<string, unknown>>;
    markers: Array<{ operation_id: string }>;
    participants: Array<{ operation_id: string; user_id: number }>;
    liveUsers: Array<{ id: number }>;
    claimed: string[] | null;
    errors: Partial<Record<'sweep' | 'scan' | 'claim' | 'ops' | 'markers' | 'participants' | 'users', unknown>>;
};

let world: World;

function baseWorld(overrides: Partial<World> = {}): World {
    return {
        reminders: [{ id: 'rem-1', operation_id: 'op-1', remind_at: iso(NOW - 60_000) }],
        operations: [{
            id: 'op-1',
            name: 'Operation Daybreak',
            scheduled_start: iso(NOW + 5 * 60_000),
            status: 'Scheduled',
            clearance_level: 0,
            is_special: false,
        }],
        markers: [],
        participants: [{ operation_id: 'op-1', user_id: 7 }, { operation_id: 'op-1', user_id: 9 }],
        liveUsers: [{ id: 7 }, { id: 9 }],
        claimed: null,
        errors: {},
        ...overrides,
    };
}

beforeEach(() => {
    h.queries = [];
    h.pushes = [];
    world = baseWorld();
    h.resolveQuery = (q) => {
        const e = world.errors;
        if (q.table === 'operation_reminders') {
            if (isUpdate(q)) {
                if (!has(q, 'select')) return { data: null, error: e.sweep ?? null };   // expiry sweep
                if (has(q, 'in', 'id')) {                                               // claim
                    if (e.claim) return { data: null, error: e.claim };
                    const scanned = (argsOf(q, 'in', 'id')?.[1] as string[]) || [];
                    const won = world.claimed ?? scanned;
                    return { data: scanned.filter(id => won.includes(id)).map(id => ({ id })), error: null };
                }
                return { data: world.reminders.map(r => ({ id: r.id })), error: null };  // drain
            }
            return e.scan ? { data: null, error: e.scan } : { data: world.reminders, error: null };
        }
        if (q.table === 'operations') return e.ops ? { data: null, error: e.ops } : { data: world.operations, error: null };
        if (q.table === 'operation_limiting_markers') return e.markers ? { data: null, error: e.markers } : { data: world.markers, error: null };
        if (q.table === 'operation_participants') return e.participants ? { data: null, error: e.participants } : { data: world.participants, error: null };
        if (q.table === 'users') return e.users ? { data: null, error: e.users } : { data: world.liveUsers, error: null };
        return { data: [], error: null };
    };
});

describe('a restricted operation never puts its NAME in the push', () => {
    it('withholds the name when the op is above clearance 0', async () => {
        world.operations[0].clearance_level = 3;
        world.operations[0].name = 'Operation Blackout';

        const sent = await sendDueOperationReminders(NOW);

        expect(sent).toBe(1);
        expect(h.pushes).toHaveLength(1);
        expect(JSON.stringify(h.pushes[0].payload)).not.toContain('Blackout');
        expect(h.pushes[0].payload.title).toBe('Operation Reminder');
        expect(h.pushes[0].payload.body).toMatch(/An operation you joined starts in 5 minutes/);
    });

    it('withholds the name when the op carries a limiting marker', async () => {
        world.operations[0].name = 'Operation Blackout';
        world.markers = [{ operation_id: 'op-1' }];

        await sendDueOperationReminders(NOW);

        expect(JSON.stringify(h.pushes[0].payload)).not.toContain('Blackout');
        expect(h.pushes[0].payload.title).toBe('Operation Reminder');
    });

    it('withholds the name for a Special Operation (mirrors operationIsRestricted)', async () => {
        world.operations[0].name = 'Operation Blackout';
        world.operations[0].is_special = true;

        await sendDueOperationReminders(NOW);

        expect(JSON.stringify(h.pushes[0].payload)).not.toContain('Blackout');
        expect(h.pushes[0].payload.title).toBe('Operation Reminder');
    });

    it('FAILS CLOSED: a marker-probe fault leaves the op restricted', async () => {
        world.operations[0].name = 'Operation Blackout';
        world.errors.markers = { code: '08006', message: 'connection failure' };

        await sendDueOperationReminders(NOW);

        // clearance 0 + no marker rows readable — the tempting refactor is to treat
        // that as "unrestricted". It must not.
        expect(h.pushes).toHaveLength(1);
        expect(JSON.stringify(h.pushes[0].payload)).not.toContain('Blackout');
        expect(h.pushes[0].payload.title).toBe('Operation Reminder');
    });

    it('an unrestricted op names itself and counts down', async () => {
        await sendDueOperationReminders(NOW);

        expect(h.pushes[0].payload.title).toBe('Operation Reminder: Operation Daybreak');
        expect(String(h.pushes[0].payload.body)).toMatch(/^Starting in \d+ minutes?$/);
        // Per-OP tag: api/sw.ts hands `tag` to showNotification, so a flat tag would
        // let the 5-minute reminder replace an unread 30-minute one.
        expect(h.pushes[0].payload.tag).toBe('op-reminder-op-1');
        expect(h.pushes[0].payload.renotify).toBe(true);
    });
});

describe('recipient set', () => {
    it('drops a soft-deleted (removed) member from the fan-out', async () => {
        world.liveUsers = [{ id: 7 }];   // user 9 was removed; deleteUser leaves the participant row

        await sendDueOperationReminders(NOW);

        expect(h.pushes).toHaveLength(1);
        expect(h.pushes[0].ids).toEqual([7]);
    });

    it('FAILS CLOSED: a liveness-probe fault pushes nothing and claims nothing', async () => {
        world.errors.users = { code: '08006', message: 'connection failure' };

        const sent = await sendDueOperationReminders(NOW);

        expect(sent).toBe(0);
        expect(h.pushes).toHaveLength(0);
        expect(claimQuery()).toBeUndefined();   // retryable next tick
    });

    it('skips the push entirely when every participant has been removed', async () => {
        world.liveUsers = [];

        expect(await sendDueOperationReminders(NOW)).toBe(0);
        expect(h.pushes).toHaveLength(0);
    });

    it('counts ACTIVE participants only', async () => {
        await sendDueOperationReminders(NOW);

        const q = h.queries.find(x => x.table === 'operation_participants');
        expect(q?.calls).toContainEqual({ method: 'is', args: ['time_left', null] });
    });
});

describe('claim before egress, after the reads', () => {
    it('claims conditionally on sent=false and only then pushes', async () => {
        await sendDueOperationReminders(NOW);

        const claim = claimQuery();
        expect(claim).toBeDefined();
        expect(claim!.calls).toContainEqual({ method: 'update', args: [{ sent: true }] });
        expect(claim!.calls).toContainEqual({ method: 'eq', args: ['sent', false] });
        expect(h.pushes[0].qAt).toBeGreaterThan(indexOfQuery(claim));
    });

    it('pushes only the rows this worker actually won', async () => {
        world.reminders = [
            { id: 'rem-1', operation_id: 'op-1', remind_at: iso(NOW - 60_000) },
            { id: 'rem-2', operation_id: 'op-2', remind_at: iso(NOW - 60_000) },
        ];
        world.operations.push({ ...world.operations[0], id: 'op-2', name: 'Operation Nightfall' });
        world.participants.push({ operation_id: 'op-2', user_id: 7 });
        world.claimed = ['rem-2'];   // another worker took rem-1

        const sent = await sendDueOperationReminders(NOW);

        expect(sent).toBe(1);
        expect(h.pushes).toHaveLength(1);
        expect(h.pushes[0].payload.title).toBe('Operation Reminder: Operation Nightfall');
    });

    it('pushes nothing when the claim itself faults', async () => {
        world.errors.claim = { code: '08006', message: 'connection failure' };

        expect(await sendDueOperationReminders(NOW)).toBe(0);
        expect(h.pushes).toHaveLength(0);
    });

    it('sends ONE push per op even when both lead-time rows come due together', async () => {
        // The >25-minute-outage case: the 30-min and 5-min rows are both due and
        // both pass the (live scheduled_start) predicate.
        world.reminders = [
            { id: 'rem-30', operation_id: 'op-1', remind_at: iso(NOW - 26 * 60_000) },
            { id: 'rem-5', operation_id: 'op-1', remind_at: iso(NOW - 60_000) },
        ];

        const sent = await sendDueOperationReminders(NOW);

        expect(sent).toBe(1);
        expect(h.pushes).toHaveLength(1);
        // Both rows are still consumed, so the duplicate cannot come back next tick.
        expect(argsOf(claimQuery()!, 'in', 'id')?.[1]).toEqual(['rem-30', 'rem-5']);
    });
});

describe('the delivery window reads the LIVE operation', () => {
    it('drops a reminder whose op was rescheduled hours later', async () => {
        world.operations[0].scheduled_start = iso(NOW + 3 * 60 * 60_000);

        expect(await sendDueOperationReminders(NOW)).toBe(0);
        expect(h.pushes).toHaveLength(0);
        expect(claimQuery()).toBeDefined();   // consumed, not left to re-fire
    });

    it('drops a reminder for an op that already started long ago', async () => {
        world.operations[0].scheduled_start = iso(NOW - 2 * 60 * 60_000);

        expect(await sendDueOperationReminders(NOW)).toBe(0);
        expect(h.pushes).toHaveLength(0);
    });

    it('drops a reminder for a Concluded op', async () => {
        world.operations[0].status = 'Concluded';

        expect(await sendDueOperationReminders(NOW)).toBe(0);
        expect(h.pushes).toHaveLength(0);
    });

    it('drops a reminder whose op no longer exists', async () => {
        world.operations = [];

        expect(await sendDueOperationReminders(NOW)).toBe(0);
        expect(h.pushes).toHaveLength(0);
    });
});

describe('backlog handling', () => {
    it('sweeps expired rows in one unbounded statement before scanning', async () => {
        await sendDueOperationReminders(NOW);

        const sweep = sweepQuery();
        expect(sweep).toBeDefined();
        expect(sweep!.calls).toContainEqual({ method: 'update', args: [{ sent: true }] });
        expect(sweep!.calls).toContainEqual({ method: 'eq', args: ['sent', false] });
        const cutoff = argsOf(sweep!, 'lt', 'remind_at')?.[1] as string;
        expect(Math.abs(Date.parse(cutoff) - (NOW - REMINDER_EXPIRY_MS))).toBeLessThan(1000);
        // The sweep must run first, or a big imported backlog starves fresh rows.
        expect(indexOfQuery(sweep)).toBeLessThan(indexOfQuery(scanQuery()));
    });

    it('scans only rows that are due AND still fresh', async () => {
        await sendDueOperationReminders(NOW);

        const scan = scanQuery()!;
        expect(scan.calls).toContainEqual({ method: 'eq', args: ['sent', false] });
        expect(argsOf(scan, 'lte', 'remind_at')?.[1]).toBe(iso(NOW));
        expect(argsOf(scan, 'gte', 'remind_at')?.[1]).toBe(iso(NOW - REMINDER_EXPIRY_MS));
        expect(scan.calls).toContainEqual({ method: 'limit', args: [50] });
    });

    it('the repairDatabase drain retires stale unsent rows and reports the count', async () => {
        world.reminders = [
            { id: 'old-1', operation_id: 'op-1', remind_at: iso(NOW - 5 * 60 * 60_000) },
            { id: 'old-2', operation_id: 'op-1', remind_at: iso(NOW - 6 * 60 * 60_000) },
        ];

        expect(await drainStaleOperationReminders(NOW)).toBe(2);

        const drain = h.queries.find(q => q.table === 'operation_reminders' && isUpdate(q) && has(q, 'select'))!;
        expect(drain.calls).toContainEqual({ method: 'update', args: [{ sent: true }] });
        expect(drain.calls).toContainEqual({ method: 'eq', args: ['sent', false] });
        expect(argsOf(drain, 'lt', 'remind_at')?.[1]).toBe(iso(NOW - REMINDER_EXPIRY_MS));
    });

    it('the drain reports 0 rather than throwing when it faults', async () => {
        h.resolveQuery = () => ({ data: null, error: { code: '08006', message: 'connection failure' } });
        expect(await drainStaleOperationReminders(NOW)).toBe(0);
    });
});

describe('every read fault fails closed with the rows left unclaimed', () => {
    it('scan fault', async () => {
        world.errors.scan = { code: '08006', message: 'connection failure' };
        expect(await sendDueOperationReminders(NOW)).toBe(0);
        expect(h.pushes).toHaveLength(0);
        expect(claimQuery()).toBeUndefined();
    });

    it('operation-lookup fault', async () => {
        world.errors.ops = { code: '08006', message: 'connection failure' };
        expect(await sendDueOperationReminders(NOW)).toBe(0);
        expect(h.pushes).toHaveLength(0);
        expect(claimQuery()).toBeUndefined();
    });

    it('participant-lookup fault', async () => {
        world.errors.participants = { code: '08006', message: 'connection failure' };
        expect(await sendDueOperationReminders(NOW)).toBe(0);
        expect(h.pushes).toHaveLength(0);
        expect(claimQuery()).toBeUndefined();
    });

    it('an expiry-sweep fault does not stop delivery', async () => {
        world.errors.sweep = { code: '08006', message: 'connection failure' };
        expect(await sendDueOperationReminders(NOW)).toBe(1);
    });
});

describe('no wildcard reaches the wire on this path', () => {
    it('every recorded select enumerates columns', async () => {
        await sendDueOperationReminders(NOW);

        const selects = h.queries.flatMap(q => q.calls.filter(c => c.method === 'select').map(c => c.args[0]));
        expect(selects.length).toBeGreaterThan(0);
        for (const s of selects) {
            expect(typeof s).toBe('string');
            expect(String(s)).not.toContain('*');
        }
    });
});

describe('the consumer is actually wired up', () => {
    // Without this the module can exist, pass every unit test above, and still
    // deliver nothing — which is precisely the defect being fixed.
    const SERVER_SRC = readFileSync(resolve(__dirname, '..', 'server.ts'), 'utf8');
    const SYSTEM_SRC = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'system.ts'), 'utf8');

    it('runs as a leased cron job in server.ts', () => {
        expect(SERVER_SRC).toContain("withCronLease('op_reminders'");
        expect(SERVER_SRC).toContain('sendDueOperationReminders(');
    });

    it('does NOT opt into the fail-closed lease (the conditional claim is the mutual exclusion)', () => {
        const block = SERVER_SRC.slice(SERVER_SRC.indexOf("withCronLease('op_reminders'"));
        expect(block.slice(0, block.indexOf('cron.schedule', 1))).not.toContain('failClosed');
    });

    it('repairDatabase drains the pre-existing backlog', () => {
        expect(SYSTEM_SRC).toContain('drainStaleOperationReminders(');
    });
});
