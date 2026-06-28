import { describe, it, expect, vi, beforeEach } from 'vitest';

// Follow-up marketplace hardening:
//   c15 — propose-dedup must include 'in_progress' so a proposer can't hold two
//         concurrent live contracts on one listing once a milestone toggle
//         advances accepted → in_progress.
//   c16 — markMarketplaceDelivered must NOT leave a completable 'delivered'
//         contract behind when the warehouse stock movement fails; and
//         confirmMarketplaceReceived must refuse to complete a warehouse-linked
//         contract with no recorded delivery movement.
//
// Mock supabase per tests/marketplaceSecurity.test.ts, but with `.in()` /
// `.is()` implemented as real filters (the dedup + delivery-movement checks rely
// on them) and configurable RPC outcomes so we can fail the stock movement.

const h = vi.hoisted(() => ({
    orgEmits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    inCalls: [] as Array<{ table: string; column: string; values: unknown[] }>,
    // rpc fn name → forced error (so warehouse_marketplace_deliver can fail).
    rpcErrors: {} as Record<string, { message: string }>,
    nextId: 1,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = {
            op: 'select' as string,
            values: null as Record<string, unknown> | Array<Record<string, unknown>> | null,
            filters: {} as Record<string, unknown>,
            inFilters: {} as Record<string, unknown[]>,
            orClause: null as string | null,
        };
        const rows = () => (h.tables[table] ?? []).filter((r) => {
            for (const [c, v] of Object.entries(state.filters)) if (r[c] !== v) return false;
            for (const [c, vals] of Object.entries(state.inFilters)) if (!vals.includes(r[c])) return false;
            if (state.orClause) {
                const parts = state.orClause.split(',').map((p) => p.split('.'));
                if (!parts.some(([col, , val]) => String(r[col]) === val)) return false;
            }
            return true;
        });
        const b: any = {};
        b.select = () => b;
        b.update = (values: Record<string, unknown>) => { state.op = 'update'; state.values = values; return b; };
        b.insert = (values: Record<string, unknown> | Array<Record<string, unknown>>) => { state.op = 'insert'; state.values = values; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.is = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.in = (c: string, vals: unknown[]) => { state.inFilters[c] = vals; h.inCalls.push({ table, column: c, values: vals }); return b; };
        b.or = (clause: string) => { state.orClause = clause; return b; };
        b.order = () => b; b.limit = () => b; b.ilike = () => b;
        const insertRows = () => {
            const list = (h.tables[table] = h.tables[table] ?? []);
            const vals = Array.isArray(state.values) ? state.values : [state.values];
            const created = vals.map((v) => {
                const row = { id: `gen-${h.nextId++}`, ...(v as Record<string, unknown>) };
                list.push(row);
                return row;
            });
            return created;
        };
        const settle = (mode: 'many' | 'single') => {
            if (state.op === 'select') {
                const data = rows();
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            if (state.op === 'insert') {
                const created = insertRows();
                return Promise.resolve({ data: mode === 'single' ? created[0] : created, error: null });
            }
            if (state.op === 'update') {
                const affected = rows();
                for (const r of affected) Object.assign(r, state.values);
                return Promise.resolve({ data: affected, error: null });
            }
            if (state.op === 'delete') {
                const doomed = new Set(rows());
                h.tables[table] = (h.tables[table] ?? []).filter((r) => !doomed.has(r));
            }
            return Promise.resolve({ data: null, error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (resolve: any, reject: any) => settle('many').then(resolve, reject);
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: Record<string, unknown>) => {
                h.rpcCalls.push({ fn, args });
                if (h.rpcErrors[fn]) return Promise.resolve({ data: null, error: h.rpcErrors[fn] });
                if (fn === 'marketplace_accept_contract') {
                    const c = (h.tables.marketplace_contracts || []).find((r) => r.id === args.p_contract_id);
                    if (c && c.status === 'proposed') { c.status = 'accepted'; c.accepted_at = 'now'; }
                    return Promise.resolve({ data: 'ok', error: null });
                }
                return Promise.resolve({ data: 'mv-1', error: null });
            },
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.orgEmits.push({ event, payload }); },
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});

import {
    proposeMarketplaceContract, acceptMarketplaceContract, toggleMarketplaceMilestone,
    markMarketplaceDelivered, confirmMarketplaceReceived,
} from '../lib/db/marketplace';

const SELLER = 10, BUYER = 20;
const WAREHOUSE_ACTOR = { permissions: ['warehouse:manage'] };

function seedListing(over: Record<string, unknown> = {}) {
    h.tables.marketplace_listings = [{
        id: 'L1', seller_id: SELLER, kind: 'item', listing_type: 'sell', title: 'Widget',
        quantity: 10, quantity_claimed: 0, status: 'active', warehouse_stock_id: null, ...over,
    }];
}
function seedContract(over: Record<string, unknown> = {}) {
    h.tables.marketplace_contracts = [{
        id: 'C1', listing_id: 'L1', seller_id: SELLER, buyer_id: BUYER, kind: 'item', quantity: 2,
        status: 'proposed', proposed_by_id: BUYER, warehouse_stock_id: null, ...over,
    }];
}

beforeEach(() => {
    h.orgEmits = []; h.rpcCalls = []; h.inCalls = []; h.tables = {}; h.rpcErrors = {}; h.nextId = 1;
});

// =============================================================================
// c15 — dedup must cover 'in_progress'
// =============================================================================
describe('c15 propose-dedup includes in_progress (one live contract per listing)', () => {
    it('refuses a second live contract once the first advanced to in_progress', async () => {
        seedListing();
        seedContract({ id: 'C1', status: 'in_progress', proposed_by_id: BUYER });
        // The dedup query matches live statuses via .in('status', [...]); because
        // that set includes in_progress, the in_progress contract is matched and a
        // second propose on the same listing is rejected.
        await expect(proposeMarketplaceContract({ listingId: 'L1', quantity: 1 }, BUYER))
            .rejects.toThrow(/already have an active contract/i);
    });

    it('drives propose → accept → milestone toggle (in_progress) → second propose is rejected', async () => {
        seedListing();
        h.tables.marketplace_contracts = [];
        // propose with a milestone so a toggle exists to advance the state machine.
        const c = await proposeMarketplaceContract(
            { listingId: 'L1', quantity: 2, milestones: [{ title: 'Phase 1' }] }, BUYER,
        );
        await acceptMarketplaceContract(c.id, SELLER);
        expect(h.tables.marketplace_contracts[0].status).toBe('accepted');
        const milestoneId = h.tables.marketplace_contract_milestones[0].id as number;
        await toggleMarketplaceMilestone(milestoneId, SELLER);   // first completion → in_progress
        expect(h.tables.marketplace_contracts[0].status).toBe('in_progress');
        // The same proposer must not be able to open a SECOND live contract now.
        await expect(proposeMarketplaceContract({ listingId: 'L1', quantity: 1 }, BUYER))
            .rejects.toThrow(/already have an active contract/i);
        expect(h.tables.marketplace_contracts).toHaveLength(1);
    });

    it('the dedup live-status set: the .in() array includes in_progress', async () => {
        seedListing();
        h.tables.marketplace_contracts = [];
        await proposeMarketplaceContract({ listingId: 'L1', quantity: 1 }, BUYER);
        const dedupIn = h.inCalls.find((c) => c.table === 'marketplace_contracts' && c.column === 'status');
        expect(dedupIn).toBeDefined();
        expect(dedupIn!.values).toEqual(expect.arrayContaining(['proposed', 'accepted', 'in_progress', 'delivered']));
        expect(dedupIn!.values).toContain('in_progress');
    });
});

// =============================================================================
// c16 — delivered status must not outlive a failed/absent stock movement
// =============================================================================
describe('c16 markMarketplaceDelivered rolls back when the stock movement fails', () => {
    it('reverts the contract to its pre-call status when warehouse_marketplace_deliver errors', async () => {
        seedContract({ status: 'accepted', kind: 'item', warehouse_stock_id: 7, quantity: 2 });
        h.rpcErrors.warehouse_marketplace_deliver = { message: 'WAREHOUSE_INSUFFICIENT_STOCK' };
        await expect(markMarketplaceDelivered('C1', SELLER, WAREHOUSE_ACTOR)).rejects.toThrow(/stock movement failed/i);
        // Without the compensating revert the contract would be stuck at 'delivered'
        // and the buyer could complete a sale whose stock was never decremented.
        expect(h.tables.marketplace_contracts[0].status).toBe('accepted');
        expect(h.tables.marketplace_contracts[0].delivered_at ?? null).toBeNull();
    });

    it('also reverts from in_progress (not just accepted) on a failed movement', async () => {
        seedContract({ status: 'in_progress', kind: 'item', warehouse_stock_id: 7, quantity: 2 });
        h.rpcErrors.warehouse_marketplace_deliver = { message: 'boom' };
        await expect(markMarketplaceDelivered('C1', SELLER, WAREHOUSE_ACTOR)).rejects.toThrow(/stock movement failed/i);
        expect(h.tables.marketplace_contracts[0].status).toBe('in_progress');
    });

    it('still delivers normally when the stock movement succeeds', async () => {
        seedContract({ status: 'accepted', kind: 'item', warehouse_stock_id: 7, quantity: 2 });
        await markMarketplaceDelivered('C1', SELLER, WAREHOUSE_ACTOR);
        expect(h.tables.marketplace_contracts[0].status).toBe('delivered');
        expect(h.rpcCalls.find((r) => r.fn === 'warehouse_marketplace_deliver')).toBeTruthy();
    });
});

describe('c16 confirmMarketplaceReceived refuses completion with no recorded delivery movement', () => {
    it('rejects a warehouse-linked item contract that has no delivery movement', async () => {
        seedContract({ status: 'delivered', kind: 'item', warehouse_stock_id: 7, quantity: 2 });
        h.tables.warehouse_movements = [];   // no movement was ever posted
        await expect(confirmMarketplaceReceived('C1', BUYER)).rejects.toThrow(/delivery has not been recorded/i);
        // Fail closed — the sale must not finalize without the stock decrement.
        expect(h.tables.marketplace_contracts[0].status).toBe('delivered');
    });

    it('allows completion when a delivery movement is recorded', async () => {
        seedContract({ status: 'delivered', kind: 'item', warehouse_stock_id: 7, quantity: 2 });
        h.tables.warehouse_movements = [{
            id: 'mv-1', related_contract_id: 'C1', reason: 'withdraw_sale', related_movement_id: null,
        }];
        await confirmMarketplaceReceived('C1', BUYER);
        expect(h.tables.marketplace_contracts[0].status).toBe('completed');
    });

    it('does not require a movement for a non-warehouse-linked contract (legitimate flow preserved)', async () => {
        seedContract({ status: 'delivered', kind: 'item', warehouse_stock_id: null, quantity: 2 });
        await confirmMarketplaceReceived('C1', BUYER);
        expect(h.tables.marketplace_contracts[0].status).toBe('completed');
    });

    it('ignores a reversal-only movement (related_movement_id set) — fails closed', async () => {
        seedContract({ status: 'delivered', kind: 'item', warehouse_stock_id: 7, quantity: 2 });
        // A chained reversal movement is not an original delivery; it must not
        // satisfy the delivery check.
        h.tables.warehouse_movements = [{
            id: 'rev-1', related_contract_id: 'C1', reason: 'restock', related_movement_id: 'mv-1',
        }];
        await expect(confirmMarketplaceReceived('C1', BUYER)).rejects.toThrow(/delivery has not been recorded/i);
        expect(h.tables.marketplace_contracts[0].status).toBe('delivered');
    });
});
