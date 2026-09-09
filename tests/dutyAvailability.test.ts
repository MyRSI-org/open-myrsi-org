import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Phase 3 item 2 — the availability scalar, DB half.
//
// `isAnyStaffOnDuty()` is the single boolean the org's EXTERNAL CUSTOMERS (the
// Client tier) need in order to raise a service request at all. It exists so a
// caller with no roster entitlement can be told yes/no without being handed the
// personnel list. This file pins the three things that are easy to regress:
//
//   1. THE FAIL DIRECTION. A read error resolves to `null` ("unknown"), never
//      `false`. A probe fault that read as "nobody is on duty" would silently kill
//      the org's only customer flow, and CLAUDE.md's fail-closed rule at the layer
//      the user actually sees means "deny the form", not "assert a falsehood".
//   2. THE NULL-INCLUSIVE ROLE FILTER. PostgREST `.neq('role_id', id)` is
//      `role_id <> $1`, which is NULL for a NULL left side, so the row is FILTERED
//      OUT — an on-duty user with a NULL role_id would read as not-on-duty. That is
//      an UNDER-count. users.role_id is NOT NULL only on fresh installs (schema.sql's
//      NOT NULL sits inside a CREATE TABLE IF NOT EXISTS body), which is why
//      lib/db/system.ts still repairs `.is('role_id', null)` rows.
//   3. THAT getMainState / getState STILL CARRY IT. Phase 3 item 3 rewrites
//      getMainState wholesale; without this ratchet the scalar can be deleted
//      silently and every Client is pinned at "Services Unavailable" forever.
//
// The HANDLER half (users_presence / users_slice response shapes) lives in
// tests/dutyAvailabilityQuery.test.ts — it needs a mocked `../lib/db`, which is
// incompatible with this file's real-barrel import.

const h = vi.hoisted(() => ({
    fromTables: [] as string[],
    callsByTable: {} as Record<string, Array<{ method: string; args: unknown[] }>>,
    resolveQuery: (() => ({ data: [] as unknown, error: null as unknown })) as
        (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown; count?: number },
    sysRoles: {} as Record<string, unknown>,
    sysRolesThrows: false,
    warns: [] as unknown[][],
}));

vi.mock('../lib/log', () => {
    const mk = (): Record<string, unknown> => ({
        debug: () => {}, info: () => {},
        warn: (...args: unknown[]) => { h.warns.push(args); },
        error: () => {},
        child: () => mk(),
    });
    return { log: mk() };
});

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        h.fromTables.push(table);
        h.callsByTable[table] = calls;
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'gt', 'gte',
            'lt', 'lte', 'contains', 'overlaps', 'range', 'ilike', 'like', 'filter',
            'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => Promise.resolve(h.resolveQuery({ table, calls }));
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        getSystemRoles: async () => {
            if (h.sysRolesThrows) throw new Error('roles read failed');
            return h.sysRoles;
        },
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

import { isAnyStaffOnDuty } from '../lib/db/users';
import { getMainState, getState } from '../lib/db';

const CLIENT_ROLE = { client: { id: 1, name: 'Client' }, member: { id: 2, name: 'Member' } };

beforeEach(() => {
    h.fromTables = [];
    h.callsByTable = {};
    h.resolveQuery = () => ({ data: [], error: null });
    h.sysRoles = { ...CLIENT_ROLE };
    h.sysRolesThrows = false;
    h.warns = [];
});

const usersChain = () => h.callsByTable['users'] || [];

describe('isAnyStaffOnDuty — the customer-facing availability probe', () => {
    it('1. one non-Client on-duty row → true', async () => {
        h.resolveQuery = () => ({ data: [{ id: 7 }], error: null });
        await expect(isAnyStaffOnDuty()).resolves.toBe(true);
    });

    it('2. no matching row → false, and the query carries the Client role_id exclusion', async () => {
        h.resolveQuery = () => ({ data: [], error: null });
        await expect(isAnyStaffOnDuty()).resolves.toBe(false);
        // Keyed on the Client SYSTEM ROLE ID, never on the NAME-inferred role tier:
        // inferUserRoleTier falls through to Client for any unrecognised role name, so
        // a tier-based probe would answer "nobody" while the org is fully crewed.
        const or = usersChain().find(c => c.method === 'or');
        expect(or).toBeDefined();
        expect(String(or!.args[0])).toContain('role_id.neq.1');
    });

    it('3. soft-deleted and off-duty rows are excluded by the query, not by the mapper', async () => {
        await isAnyStaffOnDuty();
        const chain = usersChain();
        expect(chain).toContainEqual({ method: 'is', args: ['deleted_at', null] });
        expect(chain).toContainEqual({ method: 'eq', args: ['is_duty', true] });
        // Existence probe, not a count: one row is the whole answer.
        expect(chain).toContainEqual({ method: 'limit', args: [1] });
        // Explicit column — never a wildcard (the wildcardSelectRatchet baseline for
        // lib/** + api/** is EMPTY).
        expect(chain).toContainEqual({ method: 'select', args: ['id'] });
    });

    it('4. a query error resolves to null — NOT false ("a read error must never read as nobody on duty")', async () => {
        h.resolveQuery = () => ({ data: null, error: { message: 'boom' } });
        const answer = await isAnyStaffOnDuty();
        expect(answer).toBeNull();
        expect(answer).not.toBe(false);
    });

    it('5. getSystemRoles throwing resolves to null and never throws out of the probe', async () => {
        h.sysRolesThrows = true;
        // It runs inside getMainState's Promise.all — a flaky availability probe must
        // not take down the whole boot payload.
        await expect(isAnyStaffOnDuty()).resolves.toBeNull();
    });

    it('6. an unresolvable Client system role answers WITHOUT the exclusion and warns (over-count, never under-count)', async () => {
        // pickSystemRole returns `undefined`, never `null` — an { client: null } stub is
        // impossible in this tree.
        h.sysRoles = {};
        h.resolveQuery = () => ({ data: [{ id: 3 }], error: null });
        await expect(isAnyStaffOnDuty()).resolves.toBe(true);
        expect(usersChain().some(c => c.method === 'or')).toBe(false);
        expect(h.warns.length).toBeGreaterThan(0);

        h.fromTables = []; h.callsByTable = {}; h.warns = [];
        h.sysRoles = { client: undefined } as unknown as Record<string, unknown>;
        await expect(isAnyStaffOnDuty()).resolves.toBe(true);
        expect(usersChain().some(c => c.method === 'or')).toBe(false);
    });

    it('AC-T8. the role filter is NULL-INCLUSIVE — a bare .neq() would drop on-duty rows whose role_id is NULL', async () => {
        await isAnyStaffOnDuty();
        const chain = usersChain();
        const or = chain.find(c => c.method === 'or');
        expect(or).toBeDefined();
        // `role_id <> $1` is NULL for a NULL left side and PostgREST drops the row: an
        // on-duty user with a NULL role_id would read as not-on-duty. That UNDER-count is
        // the one failure this whole function's fail direction forbids.
        expect(String(or!.args[0])).toContain('role_id.is.null');
        expect(chain.some(c => c.method === 'neq')).toBe(false);
    });
});

describe('the scalar rides the bundle', () => {
    it('7. getMainState returns anyStaffOnDuty alongside the roster (item 3 must not delete it)', async () => {
        h.resolveQuery = ({ table }) => (table === 'users' ? { data: [{ id: 9 }], error: null } : { data: [], error: null });
        const state = await getMainState({ isSystemAdmin: true, permissions: ['admin:access'] } as never);
        expect(state).toHaveProperty('anyStaffOnDuty');
        expect(state.anyStaffOnDuty).toBe(true);
    });

    it('7b. a probe fault leaves anyStaffOnDuty null on the bundle, never false', async () => {
        h.resolveQuery = ({ table, calls }) => (
            table === 'users' && calls.some(c => c.method === 'eq' && c.args[0] === 'is_duty')
                ? { data: null, error: { message: 'boom' } }
                : { data: [], error: null }
        );
        const state = await getMainState({ isSystemAdmin: true, permissions: ['admin:access'] } as never);
        expect(state.anyStaffOnDuty).toBeNull();
    });

    it('8. the probe is CONSTRUCTED inside getMainState\'s Promise.all (parallel, not a serial hop)', () => {
        // "called exactly once" does not distinguish parallel from serial, so this is a
        // structural assertion on the call site instead of a timing one.
        const src = readFileSync(resolve(__dirname, '..', 'lib', 'db.ts'), 'utf8');
        const start = src.indexOf('export async function getMainState');
        expect(start).toBeGreaterThan(-1);
        // Column-0 closing brace, matched CRLF-tolerantly — same idiom as
        // tests/userUpdateBroadcasts.test.ts and tests/rosterEgressGates.test.ts.
        // lib/db.ts is CRLF on a Windows checkout, so `indexOf('\n}\n')` returns -1 and
        // `slice(start, -1)` silently widens the body to nearly the whole file: every
        // assertion below then searches the wrong region and the ratchet passes for the
        // wrong reason. Assert the end marker was found so it can never widen silently.
        const end = src.slice(start).search(/\r?\n\}\r?\n/);
        expect(end).toBeGreaterThan(-1);
        const body = src.slice(start, start + end);
        const allStart = body.indexOf('await Promise.all([');
        const allEnd = body.indexOf(']);', allStart);
        const probe = body.indexOf('users.isAnyStaffOnDuty()');
        expect(allStart).toBeGreaterThan(-1);
        expect(probe).toBeGreaterThan(allStart);
        expect(probe).toBeLessThan(allEnd);
    });

    it('AC-T9. getState (the target=initial-state aggregate) carries anyStaffOnDuty', async () => {
        // initial-state is the ONLY page-load carrier of the scalar for a caller with no
        // roster to derive it from — nothing else covered getState's spread.
        h.resolveQuery = ({ table }) => (table === 'users' ? { data: [{ id: 9 }], error: null } : { data: [], error: null });
        const state = await getState({ id: 5, role: 'Client', permissions: [] });
        expect(state).toHaveProperty('anyStaffOnDuty');
        expect(state.anyStaffOnDuty).toBe(true);
    });
});
