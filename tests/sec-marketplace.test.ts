import { describe, it, expect, vi, beforeEach } from 'vitest';

// Marketplace milestone intra-contract authz. Milestones are the SELLER's
// service-deliverable records: only the seller may toggle them done AND only the
// seller may delete them. deleteMarketplaceMilestone must not rely on
// assertContractParty alone (which passes for EITHER party), or the BUYER could
// delete the seller's planned deliverable rows — an intra-contract authz
// asymmetry vs the seller-only toggle gate. These tests confirm the symmetric
// seller-only gate (fail-closed with the shared ERR_CONTRACT message).

const h = vi.hoisted(() => ({
    orgEmits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    tables: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = { op: 'select' as string, values: null as Record<string, unknown> | null, filters: {} as Record<string, unknown> };
        const rows = () => (h.tables[table] ?? []).filter((r) => {
            for (const [c, v] of Object.entries(state.filters)) if (r[c] !== v) return false;
            return true;
        });
        const b: any = {};
        b.select = () => b;
        b.update = (values: Record<string, unknown>) => { state.op = 'update'; state.values = values; return b; };
        b.insert = (values: Record<string, unknown>) => { state.op = 'insert'; state.values = values; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.or = () => b; b.is = () => b; b.in = () => b; b.order = () => b; b.limit = () => b; b.ilike = () => b;
        const settle = (mode: 'many' | 'single') => {
            if (state.op === 'select') {
                const data = rows();
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            const list = (h.tables[table] = h.tables[table] ?? []);
            if (state.op === 'update') for (const r of rows()) Object.assign(r, state.values);
            if (state.op === 'delete') { const doomed = new Set(rows()); h.tables[table] = list.filter((r) => !doomed.has(r)); }
            return Promise.resolve({ data: null, error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (resolve: any, reject: any) => settle('many').then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.orgEmits.push({ event, payload }); },
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});

import { deleteMarketplaceMilestone, toggleMarketplaceMilestone } from '../lib/db/marketplace';

const SELLER = 10, BUYER = 20, STRANGER = 99;

function seedContractWithMilestone(over: Record<string, unknown> = {}) {
    h.tables.marketplace_contracts = [{
        id: 'C1', listing_id: 'L1', seller_id: SELLER, buyer_id: BUYER, kind: 'service', quantity: 1,
        status: 'accepted', proposed_by_id: BUYER, warehouse_stock_id: null, ...over,
    }];
    h.tables.marketplace_contract_milestones = [{
        id: 1, contract_id: 'C1', title: 'Deliverable', description: null, sort_order: 0,
        completed_at: null, completed_by_id: null,
    }];
}

beforeEach(() => { h.orgEmits = []; h.tables = {}; });

describe('milestone delete is seller-only', () => {
    it('the BUYER party cannot delete a milestone (mirrors seller-only toggle); row survives', async () => {
        seedContractWithMilestone();
        await expect(deleteMarketplaceMilestone(1, BUYER)).rejects.toThrow(/not found or access denied/i);
        // fail-closed: the deliverable row is still present
        expect(h.tables.marketplace_contract_milestones).toHaveLength(1);
        expect(h.tables.marketplace_contract_milestones[0].id).toBe(1);
    });

    it('an outsider cannot delete a milestone (no existence disclosure)', async () => {
        seedContractWithMilestone();
        await expect(deleteMarketplaceMilestone(1, STRANGER)).rejects.toThrow(/not found or access denied/i);
        expect(h.tables.marketplace_contract_milestones).toHaveLength(1);
    });

    it('the SELLER can delete a milestone and the row is removed', async () => {
        seedContractWithMilestone();
        await deleteMarketplaceMilestone(1, SELLER);
        expect(h.tables.marketplace_contract_milestones).toHaveLength(0);
        // realtime payload carries the contract id only, never the milestone body
        const emit = h.orgEmits.find((e) => e.event === 'marketplace:update');
        expect(emit).toBeDefined();
        expect(JSON.stringify(emit)).not.toContain('Deliverable');
    });

    it('delete and toggle share the same seller-only gate (no intra-contract asymmetry)', async () => {
        seedContractWithMilestone();
        // both the buyer-facing delete AND toggle reject for the buyer party
        await expect(deleteMarketplaceMilestone(1, BUYER)).rejects.toThrow(/not found or access denied/i);
        await expect(toggleMarketplaceMilestone(1, BUYER)).rejects.toThrow(/not found or access denied/i);
        expect(h.tables.marketplace_contract_milestones[0].completed_at).toBeNull();
    });
});
