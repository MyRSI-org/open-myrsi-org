import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/securityEvents.ts — the durable audit sink for SecurityDenial.
//
// tests/securityEventsEgress.test.ts pins the structural containment (no realtime,
// no query subset, the audit permission). This suite drives the module end to end
// and pins its observable behaviour:
//   * the write: exact persisted row, field clipping, actor-id hygiene, redaction
//     through the logger's walk, the three details fallbacks (redaction failure,
//     unserialisable, oversize) and the NEVER-throws contract with its warn rules;
//   * the read: explicit columns (actor_ip is PII, so the list is pinned exactly),
//     every filter, the clamp, keyset pagination and the 42P01 / fault split;
//   * the retention prune: cutoff, bounded batches, 500-id delete chunks, the
//     runaway backstop and the never-throws contract.

const logSpy = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('../lib/db/common', async () => (await import('./cov-db-users-bans-fake')).commonMock);
vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    return { ...actual, log: { ...actual.log, child: () => logSpy } };
});

import { recordSecurityEvent, listSecurityEvents, pruneSecurityEvents } from '../lib/db/securityEvents';
import { sb, resetSb, queue, on, chainOf, argsOf, has, assertNoWildcardSelect } from './cov-db-users-bans-fake';

const EVENT_COLS = 'id, created_at, actor_user_id, actor_label, actor_ip, event, action, outcome, details';
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const DAY = 86_400_000;

const insertedRow = () => argsOf(on('security_events')[0], 'insert')![0] as Record<string, unknown>;

beforeEach(() => {
    resetSb();
    for (const fn of Object.values(logSpy)) fn.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
    assertNoWildcardSelect();
});

describe('recordSecurityEvent — the persisted row', () => {
    it('writes exactly the bounded, normalised row to security_events', async () => {
        await recordSecurityEvent({
            event: '  authz.permission.denied ',
            action: 'admin:db:reset_finances',
            actorUserId: 7,
            actorLabel: '  Jenko  ',
            actorIp: '203.0.113.9',
            outcome: 'allowed',
            details: { requiredPerm: 'admin:db:destroy', apiKey: 'sk-live-123' },
        });
        const q = on('security_events')[0];
        expect(q.op).toBe('insert');
        expect(chainOf(q)).toHaveLength(1);
        expect(insertedRow()).toEqual({
            actor_user_id: 7,
            actor_label: 'Jenko',
            actor_ip: '203.0.113.9',
            event: 'authz.permission.denied',
            action: 'admin:db:reset_finances',
            outcome: 'allowed',
            details: { requiredPerm: 'admin:db:destroy', apiKey: '[REDACTED]' },
        });
        expect(logSpy.warn).not.toHaveBeenCalled();
    });

    it('a blank / missing / non-string event falls back to authz.denied; blank text fields become null', async () => {
        await recordSecurityEvent({ event: '   ', actorLabel: '  ', actorIp: '', action: null });
        await recordSecurityEvent({ event: 42 as unknown as string });
        const rows = on('security_events').map((q) => argsOf(q, 'insert')![0] as Record<string, unknown>);
        expect(rows[0]).toMatchObject({ event: 'authz.denied', actor_label: null, actor_ip: null, action: null, actor_user_id: null, outcome: 'denied', details: {} });
        expect(rows[1].event).toBe('authz.denied');
    });

    it('clips event/action/label at 256 and the IP at 64', async () => {
        await recordSecurityEvent({ event: 'e'.repeat(300), action: 'a'.repeat(300), actorLabel: 'l'.repeat(300), actorIp: '1'.repeat(100) });
        const row = insertedRow();
        expect(row.event).toBe('e'.repeat(256));
        expect(row.action).toBe('a'.repeat(256));
        expect(row.actor_label).toBe('l'.repeat(256));
        expect(row.actor_ip).toBe('1'.repeat(64));
    });

    it.each([[Number.POSITIVE_INFINITY], [Number.NaN], ['7']])('drops a non-finite / non-number actor id (%s)', async (actorUserId) => {
        await recordSecurityEvent({ event: 'x', actorUserId: actorUserId as number });
        expect(insertedRow().actor_user_id).toBeNull();
    });

    it('a non-object details value is stored as {}', async () => {
        await recordSecurityEvent({ event: 'x', details: 'not-an-object' as unknown as Record<string, unknown> });
        expect(insertedRow().details).toEqual({});
    });

    it('a hostile getter in details records _redaction_failed instead of throwing', async () => {
        const details = Object.defineProperty({}, 'boom', { enumerable: true, get() { throw new Error('hostile'); } });
        await expect(recordSecurityEvent({ event: 'x', details })).resolves.toBeUndefined();
        expect(insertedRow().details).toEqual({ _redaction_failed: true });
    });

    it('an unserialisable value (BigInt) records _unserialisable', async () => {
        await recordSecurityEvent({ event: 'x', details: { n: BigInt(5) } });
        expect(insertedRow().details).toEqual({ _unserialisable: true });
    });

    it('an oversize bag keeps only its shape: _truncated, _bytes and at most 40 keys', async () => {
        const details: Record<string, unknown> = {};
        for (let i = 0; i < 60; i++) details[`k${i}`] = 'v'.repeat(100);
        await recordSecurityEvent({ event: 'x', details });
        const stored = insertedRow().details as { _truncated: boolean; _bytes: number; keys: string[] };
        expect(stored._truncated).toBe(true);
        expect(stored._bytes).toBe(JSON.stringify(details).length);
        expect(stored.keys).toEqual(Object.keys(details).slice(0, 40));
        expect(JSON.stringify(stored)).not.toContain('v'.repeat(100));
    });

    it('a bag of exactly the limit is stored verbatim (boundary is inclusive)', async () => {
        // {"a":"…"} = 8 bytes of framing.
        const details = { a: 'x'.repeat(4096 - 8) };
        expect(JSON.stringify(details).length).toBe(4096);
        await recordSecurityEvent({ event: 'x', details });
        expect(insertedRow().details).toEqual(details);
    });
});

describe('recordSecurityEvent — NEVER throws, and warns only when it matters', () => {
    it('an insert error is swallowed to a warn carrying only the code and event slug', async () => {
        queue('security_events', { error: { code: '23514', message: 'check violated: actor_ip=203.0.113.9' } });
        await expect(recordSecurityEvent({ event: 'authz.denied', actorIp: '203.0.113.9' })).resolves.toBeUndefined();
        expect(logSpy.warn).toHaveBeenCalledTimes(1);
        expect(logSpy.warn).toHaveBeenCalledWith('security event write failed', { code: '23514', event: 'authz.denied' });
    });

    it('a missing table (42P01) is an expected upgrade state: no warn', async () => {
        queue('security_events', { error: { code: '42P01', message: 'relation does not exist' } });
        await expect(recordSecurityEvent({ event: 'authz.denied' })).resolves.toBeUndefined();
        expect(logSpy.warn).not.toHaveBeenCalled();
    });

    it('a driver throw is swallowed to a warn', async () => {
        const boom = new Error('socket hang up');
        sb.handler = () => { throw boom; };
        await expect(recordSecurityEvent({ event: 'authz.denied' })).resolves.toBeUndefined();
        expect(logSpy.warn).toHaveBeenCalledWith('security event write threw', { err: boom });
    });
});

describe('listSecurityEvents — the admin read', () => {
    const row = (id: number, over: Record<string, unknown> = {}) => ({
        id, created_at: `2026-05-${String(id).padStart(2, '0')}T00:00:00Z`, actor_user_id: 7, actor_label: 'Jenko',
        actor_ip: '203.0.113.9', event: 'authz.denied', action: 'admin:x', outcome: 'denied', details: { a: 1 }, ...over,
    });

    it('defaults: explicit columns, newest-first by id, page of 50; maps field-by-field', async () => {
        queue('security_events', { data: [row(2), row(1, { actor_user_id: null, actor_label: null, actor_ip: null, action: null, details: null })] });
        const out = await listSecurityEvents();
        expect(chainOf(on('security_events')[0])).toEqual([
            ['select', EVENT_COLS],
            ['order', 'id', { ascending: false }],
            ['limit', 50],
        ]);
        expect(out.events).toEqual([
            { id: 2, createdAt: '2026-05-02T00:00:00Z', actorUserId: 7, actorLabel: 'Jenko', actorIp: '203.0.113.9', event: 'authz.denied', action: 'admin:x', outcome: 'denied', details: { a: 1 } },
            { id: 1, createdAt: '2026-05-01T00:00:00Z', actorUserId: undefined, actorLabel: undefined, actorIp: undefined, event: 'authz.denied', action: undefined, outcome: 'denied', details: {} },
        ]);
        // A short page is the end.
        expect(out.nextBeforeId).toBeNull();
    });

    it('applies every filter, clipped, and advertises the next keyset cursor on a full page', async () => {
        queue('security_events', { data: [row(9), row(8)] });
        const out = await listSecurityEvents({
            actorUserId: 7, event: ' authz.denied ', since: '2026-05-01T00:00:00Z', until: '2026-06-01T00:00:00Z', beforeId: 10, limit: 2,
        });
        expect(chainOf(on('security_events')[0])).toEqual([
            ['select', EVENT_COLS],
            ['order', 'id', { ascending: false }],
            ['limit', 2],
            ['eq', 'actor_user_id', 7],
            ['eq', 'event', 'authz.denied'],
            ['gte', 'created_at', '2026-05-01T00:00:00Z'],
            ['lt', 'created_at', '2026-06-01T00:00:00Z'],
            ['lt', 'id', 10],
        ]);
        expect(out.nextBeforeId).toBe(8);
    });

    it('a full page whose last row carries no id advertises no cursor (never `undefined`)', async () => {
        queue('security_events', { data: [row(3), row(2, { id: undefined })] });
        const out = await listSecurityEvents({ limit: 2 });
        expect(out.nextBeforeId).toBeNull();
    });

    it('ignores non-finite / blank filters rather than filtering on junk', async () => {
        queue('security_events', { data: [] });
        await listSecurityEvents({ actorUserId: Number.NaN, event: '  ', since: null, until: '', beforeId: Number.POSITIVE_INFINITY });
        const q = on('security_events')[0];
        for (const m of ['eq', 'gte', 'lt']) expect(has(q, m)).toBe(false);
    });

    it.each([[0, 50], [-5, 1], [500, 200], [7, 7]])('limit %s clamps to %s', async (limit, cap) => {
        queue('security_events', { data: null });
        const out = await listSecurityEvents({ limit });
        expect(argsOf(on('security_events')[0], 'limit')).toEqual([cap]);
        expect(out).toEqual({ events: [], nextBeforeId: null });
    });

    it('a missing table reads as "no events" with a warn, not a 500', async () => {
        queue('security_events', { error: { code: '42P01', message: 'missing' } });
        expect(await listSecurityEvents()).toEqual({ events: [], nextBeforeId: null });
        expect(logSpy.warn).toHaveBeenCalledWith('security_events table absent; has schema.sql been re-run?');
    });

    it('any other fault throws an opaque message and logs only the code', async () => {
        queue('security_events', { error: { code: 'XX000', message: 'internal detail: column actor_ip' } });
        await expect(listSecurityEvents()).rejects.toThrow('Could not load the security audit trail.');
        expect(logSpy.error).toHaveBeenCalledWith('listSecurityEvents failed', { code: 'XX000' });
    });
});

describe('pruneSecurityEvents — bounded retention sweep', () => {
    const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

    it('selects ids older than the cutoff (ordered, capped) and deletes them', async () => {
        queue('security_events', { data: ids(1, 3) }, {});
        expect(await pruneSecurityEvents(30)).toBe(3);
        const [select, del] = on('security_events');
        expect(chainOf(select)).toEqual([
            ['select', 'id'],
            ['lt', 'created_at', new Date(NOW - 30 * DAY).toISOString()],
            ['order', 'id', { ascending: true }],
            ['limit', 5000],
        ]);
        expect(del.op).toBe('delete');
        expect(chainOf(del)).toEqual([['delete'], ['in', 'id', [1, 2, 3]]]);
    });

    it('defaults to 365 days and clamps a sub-day retention to one day', async () => {
        queue('security_events', { data: [] }, { data: [] });
        await pruneSecurityEvents();
        await pruneSecurityEvents(0);
        const cutoffs = on('security_events').map((q) => argsOf(q, 'lt')![1]);
        expect(cutoffs).toEqual([new Date(NOW - 365 * DAY).toISOString(), new Date(NOW - DAY).toISOString()]);
    });

    it('a full batch deletes in 500-id chunks and re-selects until a short batch', async () => {
        queue('security_events', { data: ids(1, 5000) });
        for (let i = 0; i < 10; i++) queue('security_events', {});
        queue('security_events', { data: ids(5001, 2) }, {});
        expect(await pruneSecurityEvents(30)).toBe(5002);
        const qs = on('security_events');
        const deletes = qs.filter((q) => q.op === 'delete');
        expect(deletes).toHaveLength(11);
        expect(deletes.slice(0, 10).every((q) => (argsOf(q, 'in')![1] as unknown[]).length === 500)).toBe(true);
        expect(argsOf(deletes[10], 'in')).toEqual(['id', [5001, 5002]]);
        expect(qs.filter((q) => q.op === 'select')).toHaveLength(2);
    });

    it('stops at the runaway backstop of 500 batches', async () => {
        const full = ids(1, 5000);
        sb.handler = (q) => (q.op === 'select' ? { data: full } : {});
        expect(await pruneSecurityEvents(30)).toBe(500 * 5000);
        expect(on('security_events').filter((q) => q.op === 'select')).toHaveLength(500);
    });

    it('a delete fault returns the rows already deleted, with a warn', async () => {
        queue('security_events', { data: ids(1, 1200) }, {}, { error: { code: '57014' } });
        expect(await pruneSecurityEvents(30)).toBe(500);
        expect(logSpy.warn).toHaveBeenCalledWith('pruneSecurityEvents delete failed', { code: '57014' });
        expect(on('security_events').filter((q) => q.op === 'delete')).toHaveLength(2);
    });

    it('a select fault warns (except a missing table) and deletes nothing', async () => {
        queue('security_events', { error: { code: '57014' } });
        expect(await pruneSecurityEvents(30)).toBe(0);
        expect(logSpy.warn).toHaveBeenCalledWith('pruneSecurityEvents select failed', { code: '57014' });

        logSpy.warn.mockReset();
        queue('security_events', { error: { code: '42P01' } });
        expect(await pruneSecurityEvents(30)).toBe(0);
        expect(logSpy.warn).not.toHaveBeenCalled();
    });

    it('null data is an empty batch', async () => {
        queue('security_events', { data: null });
        expect(await pruneSecurityEvents(30)).toBe(0);
        expect(on('security_events')).toHaveLength(1);
    });

    it('a nonsense retention value is caught and returns 0 without querying', async () => {
        expect(await pruneSecurityEvents(Number.NaN)).toBe(0);
        expect(sb.queries).toEqual([]);
        expect(logSpy.warn).toHaveBeenCalledWith('pruneSecurityEvents threw', expect.objectContaining({ err: expect.any(RangeError) }));
    });
});
