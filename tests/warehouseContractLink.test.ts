import { describe, it, expect, vi, beforeEach } from 'vitest';

// The warehouse ledger shows movements to every `warehouse:view` holder — a Member default.
// Marketplace contract parties (seller/buyer) are a much smaller population. So anything
// contract-shaped on the ledger crosses a boundary and has to be scoped server-side.
//
// It was already crossing it. The delivery procs write the contract UUID INTO the notes
// string (`'Marketplace sale ' || p_contract_id::text`), notes is selected, mapped, and
// rendered in the notes column of the movements tab. Every member could read the id of a
// private two-party transaction on an unrelated screen.
//
// This fake gives `.in()` real behaviour and records every query. That matters: the two
// existing warehouse fakes declare `b.in = () => b`, so a party filter that selected the
// wrong rows — or never ran — would pass green against them.

const h = vi.hoisted(() => ({
    movements: [] as Array<Record<string, unknown>>,
    contracts: [] as Array<Record<string, unknown>>,
    contractQueryError: null as { message: string } | null,
    queries: [] as Array<{ table: string; in?: unknown[]; or?: string }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = { in: undefined as unknown[] | undefined, or: undefined as string | undefined };
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'not', 'order', 'limit', 'ilike', 'gte', 'lte', 'range', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = () => b;
        }
        b.in = (_col: string, vals: unknown[]) => { state.in = vals; return b; };
        b.or = (clause: string) => { state.or = clause; return b; };
        const settle = () => {
            h.queries.push({ table, in: state.in, or: state.or });
            if (table === 'warehouse_movements') return Promise.resolve({ data: h.movements, error: null });
            if (table === 'marketplace_contracts') {
                if (h.contractQueryError) return Promise.resolve({ data: null, error: h.contractQueryError });
                // Honour BOTH filters for real: the id set and the party clause.
                const ids = new Set((state.in || []) as string[]);
                const uid = /seller_id\.eq\.(\d+),buyer_id\.eq\.(\d+)/.exec(state.or || '');
                const me = uid ? Number(uid[1]) : NaN;
                const rows = h.contracts.filter((c) =>
                    ids.has(c.id as string) && (c.seller_id === me || c.buyer_id === me));
                return Promise.resolve({ data: rows, error: null });
            }
            return Promise.resolve({ data: [], error: null });
        };
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        b.single = () => settle();
        b.maybeSingle = () => settle();
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});

import { listWarehouseMovements } from '../lib/db/warehouse';
import { filterContractIdsForParty } from '../lib/db/marketplace';

const SELLER = 10, BUYER = 20, BYSTANDER = 99;
const CONTRACT = '3f1b9c4e-0000-4000-8000-000000000001';

function seed() {
    h.movements = [
        {
            id: 'mv-1', stock_id: 1, delta: -5, reason: 'withdraw_sale', actor_user_id: SELLER,
            related_request_id: null, related_movement_id: null, related_contract_id: CONTRACT,
            notes: `Marketplace sale ${CONTRACT}`, created_at: 't',
        },
        {
            id: 'mv-2', stock_id: 1, delta: 3, reason: 'restock', actor_user_id: SELLER,
            related_request_id: null, related_movement_id: null, related_contract_id: null,
            notes: 'Mining haul from Yela', created_at: 't',
        },
    ];
    h.contracts = [{ id: CONTRACT, seller_id: SELLER, buyer_id: BUYER }];
}

beforeEach(() => { h.movements = []; h.contracts = []; h.contractQueryError = null; h.queries = []; });

describe('contract-linked movements are scoped to the contract parties', () => {
    it('a PARTY gets the contract id and the untouched notes', async () => {
        seed();
        const rows = await listWarehouseMovements({}, SELLER);
        expect(rows[0].fromContract).toBe(true);
        expect(rows[0].relatedContractId).toBe(CONTRACT);
        expect(rows[0].notes).toBe(`Marketplace sale ${CONTRACT}`);
    });

    it('the OTHER party sees it too', async () => {
        seed();
        const rows = await listWarehouseMovements({}, BUYER);
        expect(rows[0].relatedContractId).toBe(CONTRACT);
    });

    it('THE LEAK: a bystander gets the boolean, never the id — in the field OR the notes', async () => {
        seed();
        const rows = await listWarehouseMovements({}, BYSTANDER);
        expect(rows[0].fromContract).toBe(true);        // "this came from a sale" is fine
        expect(rows[0].relatedContractId).toBeNull();
        expect(rows[0].notes).toBe('Marketplace sale'); // the UUID is gone, the meaning stays
        expect(JSON.stringify(rows)).not.toContain(CONTRACT);
    });

    it('withholds it from everyone when no viewer is supplied (marketplace module off)', async () => {
        seed();
        const rows = await listWarehouseMovements({});
        expect(rows[0].relatedContractId).toBeNull();
        expect(rows[0].notes).toBe('Marketplace sale');
        // And it must not even ask the marketplace table — that is the point of the gate.
        expect(h.queries.some((q) => q.table === 'marketplace_contracts')).toBe(false);
    });

    it('leaves ordinary operator notes completely alone', async () => {
        seed();
        for (const viewer of [SELLER, BYSTANDER]) {
            const rows = await listWarehouseMovements({}, viewer);
            expect(rows[1].notes).toBe('Mining haul from Yela');
            expect(rows[1].fromContract).toBe(false);
            expect(rows[1].relatedContractId).toBeNull();
        }
    });

    it('issues exactly one marketplace lookup for a page, not one per row', async () => {
        seed();
        h.movements.push({ ...h.movements[0], id: 'mv-3' });   // same contract, second row
        await listWarehouseMovements({}, SELLER);
        expect(h.queries.filter((q) => q.table === 'marketplace_contracts')).toHaveLength(1);
        // De-duplicated before the query.
        expect(h.queries.find((q) => q.table === 'marketplace_contracts')!.in).toEqual([CONTRACT]);
    });
});

describe('filterContractIdsForParty — the shared predicate', () => {
    it('short-circuits on an empty list WITHOUT issuing a query', async () => {
        // Load-bearing: tests/readScopingAndSanitizeGuards.test.ts drives listWarehouseMovements
        // through a fake with no marketplace_contracts case. If this guard ever moves below the
        // query build, that suite starts issuing an unmocked read.
        expect(await filterContractIdsForParty([], SELLER)).toEqual(new Set());
        expect(h.queries).toEqual([]);
    });

    it('returns only the ids the user is a party to', async () => {
        const OTHER = '3f1b9c4e-0000-4000-8000-000000000002';
        h.contracts = [
            { id: CONTRACT, seller_id: SELLER, buyer_id: BUYER },
            { id: OTHER, seller_id: BYSTANDER, buyer_id: 77 },
        ];
        const mine = await filterContractIdsForParty([CONTRACT, OTHER], SELLER);
        expect([...mine]).toEqual([CONTRACT]);
    });

    it('fails CLOSED to the empty set when the lookup errors', async () => {
        h.contracts = [{ id: CONTRACT, seller_id: SELLER, buyer_id: BUYER }];
        h.contractQueryError = { message: 'connection reset' };
        expect(await filterContractIdsForParty([CONTRACT], SELLER)).toEqual(new Set());
    });

    it('refuses a non-integer user id rather than interpolating it into the filter', async () => {
        // It is exported for cross-module use, so its next caller may not be the dispatcher
        // (which guarantees a number by injecting payload.userId).
        expect(await filterContractIdsForParty([CONTRACT], Number.NaN)).toEqual(new Set());
        expect(await filterContractIdsForParty([CONTRACT], '5; drop' as unknown as number)).toEqual(new Set());
        expect(h.queries).toEqual([]);
    });
});
