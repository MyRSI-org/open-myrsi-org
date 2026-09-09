import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// getFinancesOverview summed rows in Node. PostgREST enforces `db-max-rows` SERVER-SIDE and
// returns a SHORT page with NO error, so a busy org's treasury totals were silently wrong with
// nothing anywhere to notice — the exact failure tests/uncappableReadContracts.test.ts names
// about this function ("a short read is a wrong balance presented as fact"). That contract
// could never have caught it: it asserts the absence of a `.limit()`, and not having one does
// not make a read complete. The 30-day read also discarded its error, rendering the net as a
// confident 0 on any fault.
//
// The fix moves the arithmetic into SQL. The thing worth pinning is the failure direction: an
// empty-but-errorless aggregate must THROW, not render a zero treasury.

const h = vi.hoisted(() => ({
    rpc: { data: null as unknown, error: null as unknown },
    rpcCalls: [] as string[],
}));

vi.mock('../lib/db/common', () => {
    function builder() {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'in', 'not', 'order', 'limit', 'range', 'gte', 'lte', 'ilike']) b[m] = () => b;
        const settle = () => Promise.resolve({ data: [], error: null, count: 0 });
        b.single = () => Promise.resolve({ data: null, error: null });
        b.maybeSingle = () => Promise.resolve({ data: null, error: null });
        b.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => settle().then(r, j);
        return b;
    }
    return {
        supabase: {
            from: () => builder(),
            rpc: (fn: string) => { h.rpcCalls.push(fn); return Promise.resolve(h.rpc); },
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => ({}),
        safeFetch: async () => [],
    };
});

import { getFinancesOverview } from '../lib/db/finances';

const FULL_ROW = {
    total_balance: 1_250_000,
    pending_deposits_count: 3,
    pending_deposits_amount: 40_000,
    pending_withdrawals_count: 1,
    pending_withdrawals_amount: 9_500,
    thirty_day_net: -2_500,
};

beforeEach(() => { h.rpc = { data: null, error: null }; h.rpcCalls = []; });

describe('getFinancesOverview reads its numbers from one SQL aggregate', () => {
    it('calls finance_overview_stats and maps every field', async () => {
        h.rpc = { data: [FULL_ROW], error: null };
        const out = await getFinancesOverview();
        expect(h.rpcCalls).toContain('finance_overview_stats');
        expect(out.totalBalance).toBe(1_250_000);
        expect(out.pendingDepositsCount).toBe(3);
        expect(out.pendingDepositsAmount).toBe(40_000);
        expect(out.pendingWithdrawalsCount).toBe(1);
        expect(out.pendingWithdrawalsAmount).toBe(9_500);
        // A NET, not a gross — withdrawals are negative by the sign CHECK, so this can be < 0.
        expect(out.thirtyDayNet).toBe(-2_500);
    });

    it('THROWS on an empty-but-errorless aggregate rather than showing a zero treasury', async () => {
        // The sibling aggregates use `(data && data[0]) || {}`. Copied here that shape renders
        // totalBalance 0, every pending count 0 and a 0 net — a fabricated empty treasury,
        // presented as fact, with handleSupabaseError never firing. For quartermaster that
        // produces a wrong count; here it produces a wrong BALANCE.
        h.rpc = { data: [], error: null };
        await expect(getFinancesOverview()).rejects.toThrow(/returned no row/i);

        h.rpc = { data: null, error: null };
        await expect(getFinancesOverview()).rejects.toThrow(/returned no row/i);
    });

    it('surfaces an RPC error instead of answering from a partial result', async () => {
        // Seeds a row ALONGSIDE the error, deliberately. With `data: null` the `!row` throw
        // fires anyway and the assertion passes whether or not the error is handled at all —
        // it cannot tell the two apart. Only a payload that would otherwise SUCCEED proves the
        // error is actually being surfaced.
        h.rpc = { data: [FULL_ROW], error: { message: 'connection reset' } };
        await expect(getFinancesOverview()).rejects.toThrow(/Failed to load finance overview$/);
    });

    it('no longer sums ledger rows in JavaScript', () => {
        const src = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'finances.ts'), 'utf8');
        const at = src.indexOf('export async function getFinancesOverview');
        const body = src.slice(at, src.indexOf('\n}', at));
        // Both former shapes: the pending bucket loop and the 30-day reduce.
        expect(body).not.toMatch(/\.reduce\s*\(/);
        expect(body).not.toMatch(/treasury_ledger_entries/);
        expect(body).toMatch(/supabase\.rpc\('finance_overview_stats'\)/);
    });
});

describe('the SQL aggregate preserves the behaviour it replaced', () => {
    const SQL = readFileSync(resolve(__dirname, '..', 'schema.sql'), 'utf8');
    const body = (() => {
        const at = SQL.indexOf('CREATE OR REPLACE FUNCTION public.finance_overview_stats');
        expect(at, 'finance_overview_stats is not defined in schema.sql').toBeGreaterThan(-1);
        const open = SQL.indexOf('$$', at);
        return SQL.slice(open + 2, SQL.indexOf('$$', open + 2));
    })();

    it('COALESCEs every SUM — SUM over an empty set is NULL, not 0', () => {
        const sums = body.match(/SUM\(/g) || [];
        const coalesced = body.match(/COALESCE\(\(SELECT SUM\(/g) || [];
        expect(sums.length).toBeGreaterThanOrEqual(4);
        expect(coalesced.length).toBe(sums.length);
    });

    it('uses ABS on the pending buckets, mirroring the Math.abs it replaced', () => {
        expect(body).toMatch(/SUM\(ABS\(e\.amount\)\)/);
    });

    it('filters pending buckets to deposit/withdrawal ONLY', () => {
        // The TS loop silently ignored pending transfer/payout/adjustment rows. Widening it
        // here would change every operator's numbers with no release note.
        expect(body).toContain("e.entry_type = 'deposit'");
        expect(body).toContain("e.entry_type = 'withdrawal'");
        expect(body).not.toContain("'transfer'");
        expect(body).not.toContain("'payout'");
    });

    it('sums the SIGNED amount for the 30-day net, so it is a net and not a gross', () => {
        expect(body).toMatch(/SUM\(e\.amount\)::bigint FROM public\.treasury_ledger_entries e\s*\n?\s*WHERE e\.status = 'confirmed'/);
    });

    it('is STABLE, search_path-locked and fully qualified — the qm_overview_stats shape', () => {
        const at = SQL.indexOf('CREATE OR REPLACE FUNCTION public.finance_overview_stats');
        const header = SQL.slice(at, at + 400);
        expect(header).toContain('STABLE');
        expect(header).toContain("SET search_path = ''");
        expect(header).not.toMatch(/SECURITY DEFINER/);
        // search_path is empty, so every reference must be schema-qualified or it fails at run time.
        expect(body).not.toMatch(/FROM\s+(?!public\.)[a-z_]+\s/);
    });

    it('is on the explicit service_role grant allowlist', () => {
        expect(SQL).toContain('GRANT EXECUTE ON FUNCTION public.finance_overview_stats() TO service_role;');
    });
});
