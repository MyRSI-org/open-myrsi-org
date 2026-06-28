import { describe, it, expect, vi, beforeEach } from 'vitest';

// Quartermaster bulk array cap.
//   qm:issue_bulk (issueDirectBulk) and qm:return_bulk (returnIssuanceBulk)
//   reject an oversized lines[] array before touching the DB — no scope SELECT,
//   no qm_*_bulk RPC — so an unbounded array cannot write-amplify the stored
//   procs. A normal-size batch still proceeds (scope check + RPC fire).

const h = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    // every supabase.from(table)/rpc(...) touch is recorded so the test can
    // assert the oversized path never reached the DB.
    fromCalls: [] as string[],
    rpcCalls: [] as Array<{ fn: string; params: unknown }>,
    rpcReturn: [] as unknown[],
}));

function applyFilters(rows: Array<Record<string, unknown>>, filters: Record<string, unknown>, inFilter: { col: string; vals: unknown[] } | null) {
    return rows.filter((r) => {
        for (const [c, v] of Object.entries(filters)) if (r[c] !== v) return false;
        if (inFilter && !inFilter.vals.includes(r[inFilter.col])) return false;
        return true;
    });
}

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        h.fromCalls.push(table);
        const state = {
            filters: {} as Record<string, unknown>,
            inFilter: null as { col: string; vals: unknown[] } | null,
        };
        const rows = () => applyFilters(h.tables[table] ?? [], state.filters, state.inFilter);
        const b: any = {};
        b.select = () => b;
        b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.is = () => b;
        b.in = (c: string, vals: unknown[]) => { state.inFilter = { col: c, vals }; return b; };
        b.order = () => b;
        b.limit = () => b;
        const settle = (mode: 'many' | 'single') => {
            const data = rows();
            return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (resolve: any, reject: any) => settle('many').then(resolve, reject);
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, params: unknown) => {
                h.rpcCalls.push({ fn, params });
                return Promise.resolve({ data: h.rpcReturn, error: null });
            },
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
    };
});

import { issueDirectBulk, returnIssuanceBulk } from '../lib/db/quartermaster';

const ACTOR = 9;

beforeEach(() => {
    h.tables = {};
    h.fromCalls = [];
    h.rpcCalls = [];
    h.rpcReturn = [];
});

describe('qm:issue_bulk array cap', () => {
    it('rejects an oversized lines[] array before any DB read/write', async () => {
        const oversized = Array.from({ length: 5000 }, (_, i) => ({ inventoryId: i + 1, quantity: 1 }));
        await expect(issueDirectBulk(ACTOR, { issuedToUserId: 1, lines: oversized }))
            .rejects.toThrow(/capped at 200 lines/i);

        // Fail closed: never touched inventory scope check, never called the RPC.
        expect(h.fromCalls).toHaveLength(0);
        expect(h.rpcCalls).toHaveLength(0);
    });

    it('lets a normal-size batch proceed (scope check + RPC fire)', async () => {
        // Seed the inventory rows so the tenant-scope gate passes.
        h.tables.quartermaster_inventory = [{ id: 1 }, { id: 2 }];
        // Seed on-hand movements so the over-issue pre-check (getInventoryOnHandMap)
        // sees sufficient stock and lets this legitimate batch reach the RPC.
        h.tables.quartermaster_inventory_movements = [
            { inventory_id: 1, delta: 50 },
            { inventory_id: 2, delta: 50 },
        ];
        h.rpcReturn = [101, 102];

        const ids = await issueDirectBulk(ACTOR, {
            issuedToUserId: 1,
            lines: [{ inventoryId: 1, quantity: 2 }, { inventoryId: 2, quantity: 3 }],
        });

        expect(ids).toEqual([101, 102]);
        expect(h.rpcCalls.map((c) => c.fn)).toContain('qm_issue_bulk');
    });
});

describe('qm:return_bulk array cap', () => {
    it('rejects an oversized lines[] array before any DB read/write', async () => {
        const oversized = Array.from({ length: 5000 }, (_, i) => ({
            issuanceId: i + 1, returnedQuantity: 1, outcome: 'returned_on_time' as const,
        }));
        await expect(returnIssuanceBulk(ACTOR, { lines: oversized }))
            .rejects.toThrow(/capped at 200 lines/i);

        expect(h.fromCalls).toHaveLength(0);
        expect(h.rpcCalls).toHaveLength(0);
    });

    it('lets a normal-size batch proceed (scope check + RPC fire)', async () => {
        h.tables.quartermaster_issuances = [
            { id: 1, inventory_id: 11 },
            { id: 2, inventory_id: 22 },
        ];
        h.rpcReturn = 2 as unknown as unknown[]; // qm_return_bulk returns a scalar count

        const closed = await returnIssuanceBulk(ACTOR, {
            lines: [
                { issuanceId: 1, returnedQuantity: 1, outcome: 'returned_on_time' },
                { issuanceId: 2, returnedQuantity: 1, outcome: 'returned_late' },
            ],
        });

        expect(closed).toBe(2);
        expect(h.rpcCalls.map((c) => c.fn)).toContain('qm_return_bulk');
    });
});
