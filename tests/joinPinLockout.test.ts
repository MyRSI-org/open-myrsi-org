import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// SPECIAL OPERATION JOIN PIN — the only gate on joining a Special Operation
// (operation:join / join_with_role pass { isJoinAttempt: true }, which skips the
// participation gate). Pins:
//   * fail-closed: an operations read fault or a missing row refuses the join, where the
//     old `if (op && op.is_special)` skipped the PIN check entirely;
//   * brute-force lockout: 5 wrong PINs per user + op in 15 minutes locks that pair out
//     for the window, the CORRECT PIN included, with the same copy as a wrong PIN; a
//     success resets the counter; the trip is audited exactly once; the op half of the
//     key is the canonical id READ BACK from the database, so re-spelling the uuid in
//     the request (case, braces, hyphens) does not buy a fresh budget;
//   * the compare goes through the constant-time helper;
//   * the 6-character floor on create and on an edit that SETS the PIN, while an edit
//     that leaves a legacy short PIN alone still saves and the PIN still works;
//   * the lockout table stays bounded.

const h = vi.hoisted(() => ({
    joinRow: { data: null as unknown, error: null as unknown },
    liveRow: null as unknown,
    queries: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    rpcCalls: [] as Array<{ fn: string; args: unknown }>,
    securityEvents: [] as Array<Record<string, unknown>>,
    compareCalls: 0,
}));

const selectArg = (q: { calls: Array<{ method: string; args: unknown[] }> }) =>
    String(q.calls.find((c) => c.method === 'select')?.args[0] ?? '');
const has = (q: { calls: Array<{ method: string }> }, m: string) => q.calls.some((c) => c.method === m);

function resolve(q: { table: string; calls: Array<{ method: string; args: unknown[] }> }): { data: unknown; error: unknown } {
    if (q.table === 'operations') {
        if (has(q, 'insert')) return { data: { id: 'op-new', owner_id: 7, name: 'X', clearance_level: 0, status: 'Planning', is_joint: false }, error: null };
        if (has(q, 'update')) return { data: null, error: null };
        const cols = selectArg(q);
        if (cols.includes('is_special, join_code, max_participants')) {
            // A fixture row without an explicit id gets the queried id back, as Postgres
            // would for an already-canonical spelling ('op-1', 'op-2' stay distinct ops).
            // The id is only present when the select asked for it, like the real read.
            const row = h.joinRow as { data: unknown; error: unknown };
            if (!row.data || typeof row.data !== 'object') return row;
            const eqId = q.calls.find((c) => c.method === 'eq' && c.args[0] === 'id')?.args[1];
            const { id, ...rest } = { id: eqId, ...(row.data as Record<string, unknown>) };
            return { ...row, data: cols.split(',').map((c) => c.trim()).includes('id') ? { id, ...rest } : rest };
        }
        if (cols.startsWith('id, clearance_level')) return { data: h.liveRow, error: null };
        if (cols === 'is_joint') return { data: { is_joint: false }, error: null };
    }
    return { data: null, error: null };
}

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'lte', 'ilike', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => { const q = { table, calls }; h.queries.push(q); return Promise.resolve(resolve(q)); };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (res: any, rej: any) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: unknown) => { h.rpcCalls.push({ fn, args }); return Promise.resolve({ data: null, error: null }); },
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
    };
});
vi.mock('../lib/db/operations-federation', () => ({
    bumpOperationVersion: vi.fn(async () => undefined),
    pushOperationToAllies: vi.fn(async () => undefined),
    scheduleAlliedPush: vi.fn(() => undefined),
}));
vi.mock('../lib/push', () => ({ sendPushToUsers: vi.fn(async () => undefined) }));
vi.mock('../lib/db/users', () => ({
    getUserById: vi.fn(async () => ({ id: 1, name: 'Actor' })),
    getActorLabel: vi.fn(async () => 'Actor'),
}));
// No verifyOperationAccess caching across tests: each join re-reads.
vi.mock('../lib/cache', () => ({ cache: { get: () => undefined, set: () => {}, invalidate: () => {}, invalidatePrefix: () => {} }, TTL: {} }));
vi.mock('../lib/db/securityEvents', () => ({
    recordSecurityEvent: vi.fn(async (ev: Record<string, unknown>) => { h.securityEvents.push(ev); }),
}));
// The real constant-time compare, counted, so the join path is pinned to it.
vi.mock('../lib/constantTime', async (importOriginal) => {
    const real = await importOriginal<typeof import('../lib/constantTime')>();
    return { constantTimeEqual: (a: string, b: string) => { h.compareCalls++; return real.constantTimeEqual(a, b); } };
});

import { joinOperation, createOperation, updateOperationDetails } from '../lib/db/ops';
import {
    isJoinPinLocked, recordJoinPinFailure, clearJoinPinFailures,
    JOIN_PIN_MAX_FAILURES, JOIN_PIN_WINDOW_MS, JOIN_PIN_LOCKOUT_MAX_KEYS,
    _resetJoinPinLockoutForTests, _joinPinLockoutSizeForTests,
} from '../lib/joinPinLockout';
import { validateJoinPin, JOIN_PIN_MIN_LENGTH, JOIN_PIN_MAX_LENGTH } from '../lib/joinPinPolicy';

const PIN = 'Kestrel-42';
const special = (joinCode: string | null = PIN) => ({ data: { is_special: true, join_code: joinCode, max_participants: null }, error: null });
const joined = () => h.rpcCalls.filter((c) => c.fn === 'op_join_participant').length;
const lockoutEvents = () => h.securityEvents.filter((e) => e.event === 'auth.join_pin.locked_out');

async function failTimes(n: number, userId = 1, opId = 'op-1') {
    for (let i = 0; i < n; i++) {
        await expect(joinOperation(opId, userId, `wrong-${i}`)).rejects.toThrow('Invalid Join Code.');
    }
}

beforeEach(() => {
    _resetJoinPinLockoutForTests();
    h.queries = [];
    h.rpcCalls = [];
    h.securityEvents = [];
    h.compareCalls = 0;
    h.joinRow = special();
    h.liveRow = null;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('joinOperation — fail closed on the operations read', () => {
    it('refuses the join when the read errors (no longer reads a null op as "not special")', async () => {
        h.joinRow = { data: null, error: { code: '57014', message: 'statement timeout' } };
        // The fault's own message (via handleSupabaseError), not the missing-row one:
        // pins that the error is READ rather than collapsed into "no row".
        await expect(joinOperation('op-1', 1, undefined)).rejects.toThrow('Failed to join operation');
        expect(joined()).toBe(0);
        expect(h.queries.some((q) => q.table === 'operation_participants' && has(q, 'upsert'))).toBe(false);
    });

    it('refuses the join when the row is missing', async () => {
        h.joinRow = { data: null, error: null };
        await expect(joinOperation('op-1', 1, undefined)).rejects.toThrow(/not found/i);
        expect(joined()).toBe(0);
    });

    it('a Special op with no stored PIN admits nobody — empty or any submitted PIN', async () => {
        h.joinRow = special(null);
        await expect(joinOperation('op-1', 1, undefined)).rejects.toThrow('Invalid Join Code.');
        await expect(joinOperation('op-1', 1, '')).rejects.toThrow('Invalid Join Code.');
        await expect(joinOperation('op-1', 1, 'anything-at-all')).rejects.toThrow('Invalid Join Code.');
        expect(joined()).toBe(0);
    });
});

describe('joinOperation — PIN compare', () => {
    it('admits the correct PIN through the constant-time compare', async () => {
        await expect(joinOperation('op-1', 1, PIN)).resolves.toBeUndefined();
        expect(joined()).toBe(1);
        expect(h.compareCalls).toBe(1);
    });

    it('a non-special op needs no PIN', async () => {
        h.joinRow = { data: { is_special: false, join_code: null, max_participants: null }, error: null };
        await expect(joinOperation('op-1', 1, undefined)).resolves.toBeUndefined();
        expect(joined()).toBe(1);
    });
});

describe('joinOperation — brute-force lockout', () => {
    it(`locks the user + op out after ${JOIN_PIN_MAX_FAILURES} wrong PINs`, async () => {
        await failTimes(JOIN_PIN_MAX_FAILURES - 1);
        expect(isJoinPinLocked(1, 'op-1')).toBe(false);
        await failTimes(1);
        expect(isJoinPinLocked(1, 'op-1')).toBe(true);
        expect(joined()).toBe(0);
    });

    it('refuses the CORRECT PIN during a lockout, with the same copy as a wrong PIN', async () => {
        await failTimes(JOIN_PIN_MAX_FAILURES);
        await expect(joinOperation('op-1', 1, PIN)).rejects.toThrow('Invalid Join Code.');
        expect(joined()).toBe(0);
    });

    it('lifts after the window passes', async () => {
        await failTimes(JOIN_PIN_MAX_FAILURES);
        vi.setSystemTime(Date.now() + JOIN_PIN_WINDOW_MS - 1000);
        await expect(joinOperation('op-1', 1, PIN)).rejects.toThrow('Invalid Join Code.');
        vi.setSystemTime(Date.now() + 1000);
        await expect(joinOperation('op-1', 1, PIN)).resolves.toBeUndefined();
        expect(joined()).toBe(1);
    });

    it('a success resets the counter', async () => {
        await failTimes(JOIN_PIN_MAX_FAILURES - 1);
        await expect(joinOperation('op-1', 1, PIN)).resolves.toBeUndefined();
        // Without the reset these would be failures 5..8 and trip the lockout.
        await failTimes(JOIN_PIN_MAX_FAILURES - 1);
        expect(isJoinPinLocked(1, 'op-1')).toBe(false);
        await expect(joinOperation('op-1', 1, PIN)).resolves.toBeUndefined();
        expect(joined()).toBe(2);
    });

    it('is scoped per user AND per operation', async () => {
        await failTimes(JOIN_PIN_MAX_FAILURES, 1, 'op-1');
        await expect(joinOperation('op-1', 2, PIN)).resolves.toBeUndefined(); // other user, same op
        await expect(joinOperation('op-2', 1, PIN)).resolves.toBeUndefined(); // same user, other op
        expect(joined()).toBe(2);
    });

    it('keys on the canonical op id from the database, so re-spelling the uuid buys no fresh budget', async () => {
        // Postgres resolves every one of these to the same uuid row; the read returns the
        // canonical form whatever the request spelled.
        const CANON = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
        h.joinRow = { data: { id: CANON, is_special: true, join_code: PIN, max_participants: null }, error: null };
        const spellings = [
            CANON,
            CANON.toUpperCase(),
            CANON.replace(/-/g, ''),
            `{${CANON}}`,
            'a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11',
        ];
        expect(spellings).toHaveLength(JOIN_PIN_MAX_FAILURES);
        for (const [i, spelling] of spellings.entries()) {
            await expect(joinOperation(spelling, 1, `wrong-${i}`)).rejects.toThrow('Invalid Join Code.');
        }
        // The correct PIN under yet another spelling is still refused.
        await expect(joinOperation('A0EEBC999C0B4EF8BB6D6BB9BD380A11', 1, PIN)).rejects.toThrow('Invalid Join Code.');
        expect(joined()).toBe(0);
        expect(isJoinPinLocked(1, CANON)).toBe(true);
        // One trip, audited once, under the canonical id.
        expect(lockoutEvents()).toHaveLength(1);
        expect(lockoutEvents()[0].details).toMatchObject({ operationId: CANON });
    });

    it('a success under another spelling still resets the canonical counter', async () => {
        const CANON = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
        h.joinRow = { data: { id: CANON, is_special: true, join_code: PIN, max_participants: null }, error: null };
        await failTimes(JOIN_PIN_MAX_FAILURES - 1, 1, CANON);
        await expect(joinOperation(CANON.toUpperCase(), 1, PIN)).resolves.toBeUndefined();
        // Without the reset landing on the canonical key these would trip the lockout.
        await failTimes(JOIN_PIN_MAX_FAILURES - 1, 1, CANON);
        expect(isJoinPinLocked(1, CANON)).toBe(false);
    });

    it('a Special op row read back without an id refuses rather than falling back to the request string', async () => {
        h.joinRow = { data: { id: null, is_special: true, join_code: PIN, max_participants: null }, error: null };
        await expect(joinOperation('op-1', 1, PIN)).rejects.toThrow('Failed to join operation');
        expect(joined()).toBe(0);
    });

    it('records the security event exactly once, when the lockout trips — never the PIN', async () => {
        await failTimes(JOIN_PIN_MAX_FAILURES - 1);
        expect(lockoutEvents()).toHaveLength(0);
        await failTimes(1);
        expect(lockoutEvents()).toHaveLength(1);
        // Further refused attempts during the lockout do not re-audit.
        await failTimes(3);
        await expect(joinOperation('op-1', 1, PIN)).rejects.toThrow('Invalid Join Code.');
        expect(lockoutEvents()).toHaveLength(1);
        const ev = lockoutEvents()[0];
        expect(ev).toMatchObject({ actorUserId: 1, outcome: 'denied', action: 'operation:join' });
        expect(ev.details).toMatchObject({ operationId: 'op-1' });
        const json = JSON.stringify(ev);
        expect(json).not.toContain('wrong-');
        expect(json).not.toContain(PIN);
    });
});

describe('createOperation — join PIN floor', () => {
    const insertPayload = () => h.queries
        .find((q) => q.table === 'operations' && has(q, 'insert'))
        ?.calls.find((c) => c.method === 'insert')?.args[0] as Record<string, unknown> | undefined;

    it('rejects a short PIN on a Special op before anything is written', async () => {
        await expect(createOperation({ userId: 7, name: 'X', type: 'PvE', isSpecial: true, joinCode: '1234' })).rejects.toThrow(/at least 6/);
        await expect(createOperation({ userId: 7, name: 'X', type: 'PvE', isSpecial: true, joinCode: '   12345   ' })).rejects.toThrow(/at least 6/);
        await expect(createOperation({ userId: 7, name: 'X', type: 'PvE', isSpecial: true })).rejects.toThrow(/at least 6/);
        await expect(createOperation({ userId: 7, name: 'X', type: 'PvE', isSpecial: true, joinCode: 'x'.repeat(JOIN_PIN_MAX_LENGTH + 1) })).rejects.toThrow(/at most 64/);
        expect(insertPayload()).toBeUndefined();
    });

    it('stores a valid PIN trimmed', async () => {
        await createOperation({ userId: 7, name: 'X', type: 'PvE', isSpecial: true, joinCode: '  123456  ' });
        expect(insertPayload()?.join_code).toBe('123456');
    });

    it('a non-Special op stores no PIN, so a later isSpecial flip cannot arm an unvalidated one', async () => {
        await createOperation({ userId: 7, name: 'X', type: 'PvE', isSpecial: false, joinCode: '1' });
        expect(insertPayload()?.join_code).toBeNull();
    });
});

describe('updateOperationDetails — join PIN floor only when the edit SETS the PIN', () => {
    const updatePayload = () => h.queries
        .find((q) => q.table === 'operations' && has(q, 'update'))
        ?.calls.find((c) => c.method === 'update')?.args[0] as Record<string, unknown> | undefined;
    const live = (over: Record<string, unknown> = {}) => ({ id: 'op-1', clearance_level: 0, is_special: true, join_code: '1234', limiting_markers: [], ...over });

    it('rejects an edit that changes the PIN to a short one, with no write (markers included)', async () => {
        h.liveRow = live({ join_code: 'Kestrel-42' });
        await expect(updateOperationDetails('op-1', { joinCode: '9999', markerIds: [] }, 7, null)).rejects.toThrow(/at least 6/);
        expect(updatePayload()).toBeUndefined();
        expect(h.queries.some((q) => q.table === 'operation_limiting_markers')).toBe(false);
    });

    it('accepts a valid new PIN and stores it trimmed', async () => {
        h.liveRow = live();
        await updateOperationDetails('op-1', { joinCode: '  New-PIN-1  ' }, 7, null);
        expect(updatePayload()?.join_code).toBe('New-PIN-1');
    });

    it('an unrelated edit keeps an existing short PIN — and the PIN still admits', async () => {
        h.liveRow = live({ join_code: '1234' });
        await expect(updateOperationDetails('op-1', { name: 'Renamed' }, 7, null)).resolves.toBeUndefined();
        expect(updatePayload()).toEqual({ name: 'Renamed' });

        // OpAdministerTab re-sends isSpecial + the unchanged PIN on every save.
        h.queries = [];
        await expect(updateOperationDetails('op-1', { name: 'Again', isSpecial: true, joinCode: '1234' }, 7, null)).resolves.toBeUndefined();
        expect(updatePayload()).not.toHaveProperty('join_code');

        h.joinRow = special('1234');
        await expect(joinOperation('op-1', 1, '1234')).resolves.toBeUndefined();
    });

    it('turning an op Special is held to the floor, whether the PIN is supplied or left stored', async () => {
        h.liveRow = live({ is_special: false, join_code: '1234' });
        await expect(updateOperationDetails('op-1', { isSpecial: true }, 7, null)).rejects.toThrow(/at least 6/);
        await expect(updateOperationDetails('op-1', { isSpecial: true, joinCode: '1234' }, 7, null)).rejects.toThrow(/at least 6/);
        expect(updatePayload()).toBeUndefined();
    });

    it('clearing the PIN of an op that is being made non-Special is allowed', async () => {
        h.liveRow = live({ join_code: '1234' });
        await updateOperationDetails('op-1', { isSpecial: false, joinCode: '' }, 7, null);
        expect(updatePayload()).toMatchObject({ is_special: false, join_code: null });
    });
});

describe('lib/joinPinPolicy — the shared floor (server + both op forms)', () => {
    it('enforces 6..64 trimmed characters', () => {
        expect(JOIN_PIN_MIN_LENGTH).toBe(6);
        expect(validateJoinPin('12345')).toMatchObject({ ok: false });
        expect(validateJoinPin('      ')).toMatchObject({ ok: false });
        expect(validateJoinPin(undefined)).toMatchObject({ ok: false });
        expect(validateJoinPin(123456)).toMatchObject({ ok: false });
        expect(validateJoinPin(' 123456 ')).toEqual({ ok: true, pin: '123456' });
        expect(validateJoinPin('x'.repeat(64))).toMatchObject({ ok: true });
        expect(validateJoinPin('x'.repeat(65))).toMatchObject({ ok: false });
    });
});

describe('lib/joinPinLockout — bounded in-memory table', () => {
    it('never exceeds the key cap, prunes expired entries, and evicts unlocked entries before lockouts', () => {
        const t0 = Date.now();
        // An active lockout, inserted FIRST so it is the oldest key.
        for (let i = 0; i < JOIN_PIN_MAX_FAILURES; i++) recordJoinPinFailure(99, 'op-locked', t0);
        expect(isJoinPinLocked(99, 'op-locked', t0)).toBe(true);

        for (let i = 0; i < JOIN_PIN_LOCKOUT_MAX_KEYS + 50; i++) recordJoinPinFailure(1, `op-${i}`, t0);
        expect(_joinPinLockoutSizeForTests()).toBeLessThanOrEqual(JOIN_PIN_LOCKOUT_MAX_KEYS);
        // The oldest key was a lockout; eviction took unlocked entries instead.
        expect(isJoinPinLocked(99, 'op-locked', t0)).toBe(true);

        // Once the window has passed every entry is expired and is pruned on the next insert.
        const later = t0 + JOIN_PIN_WINDOW_MS + 1;
        recordJoinPinFailure(2, 'op-fresh', later);
        expect(_joinPinLockoutSizeForTests()).toBeLessThan(10);
    });

    it('clearJoinPinFailures wipes a pair', () => {
        recordJoinPinFailure(5, 'op-x');
        expect(_joinPinLockoutSizeForTests()).toBe(1);
        clearJoinPinFailures(5, 'op-x');
        expect(_joinPinLockoutSizeForTests()).toBe(0);
    });
});
