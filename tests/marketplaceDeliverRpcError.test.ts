import { describe, it, expect, vi, beforeEach } from 'vitest';

// markMarketplaceDelivered — the warehouse stock-movement RPC error must never
// reach the seller as raw Postgres text.
//
// It used to `throw new Error(\`Stock movement failed: ${rpcErr.message}\`)`: a
// PLAIN Error, so the dispatcher's opaque-error classifier (lib/errors.ts) let the
// message through verbatim — live stock counts from the RAISE, and for any other
// failure constraint / column / relation names. Now the one expected RAISE
// (WAREHOUSE_INSUFFICIENT_STOCK) maps to fixed copy and everything else goes
// through handleSupabaseError (logged server-side, fixed message thrown). Both
// branches still roll the contract back off 'delivered' first.

const h = vi.hoisted(() => ({
    contract: null as Record<string, unknown> | null,
    rpcError: null as Record<string, unknown> | null,
    handled: [] as Array<{ error: unknown; message: string }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = { op: 'select', values: null as Record<string, unknown> | null, filters: {} as Record<string, unknown> };
        const matches = () => {
            const c = h.contract;
            if (table !== 'marketplace_contracts' || !c) return [];
            return Object.entries(state.filters).every(([k, v]) => c[k] === v) ? [c] : [];
        };
        const settle = (single: boolean) => {
            const rows = matches();
            if (state.op === 'update') for (const r of rows) Object.assign(r, state.values);
            return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
        };
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.update = (values: Record<string, unknown>) => { state.op = 'update'; state.values = values; return b; };
        b.eq = (k: string, v: unknown) => { state.filters[k] = v; return b; };
        b.maybeSingle = () => settle(true);
        b.single = () => settle(true);
        b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => settle(false).then(resolve, reject);
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: async () => ({ data: h.rpcError ? null : 'mv-1', error: h.rpcError }),
        },
        // Mirrors lib/supabaseServer.handleSupabaseError: detail to logs, fixed
        // caller message thrown. Recorded so the test can pin the routing.
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
            if (error) { h.handled.push({ error, message }); throw new Error(message); }
        },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
    };
});

import { markMarketplaceDelivered } from '../lib/db/marketplace';

const SELLER = 10;
const WAREHOUSE_ACTOR = { permissions: ['warehouse:manage'] };

beforeEach(() => {
    h.contract = {
        id: 'C1', listing_id: null, seller_id: SELLER, buyer_id: 20, kind: 'item', quantity: 5,
        status: 'accepted', proposed_by_id: 20, warehouse_stock_id: 7,
    };
    h.rpcError = null;
    h.handled = [];
});

async function deliverError(): Promise<Error> {
    try {
        await markMarketplaceDelivered('C1', SELLER, WAREHOUSE_ACTOR);
    } catch (e) {
        return e as Error;
    }
    throw new Error('expected markMarketplaceDelivered to reject');
}

describe('markMarketplaceDelivered — stock-movement RPC errors are not forwarded raw', () => {
    it('WAREHOUSE_INSUFFICIENT_STOCK maps to fixed copy (no counts, no RAISE token)', async () => {
        h.rpcError = { message: 'WAREHOUSE_INSUFFICIENT_STOCK: have 3, need 5', code: 'P0001', details: null, hint: null };
        const err = await deliverError();
        expect(err.message).toBe('Stock movement failed: the linked warehouse stock does not have enough on hand to deliver this contract.');
        expect(err.message).not.toContain('WAREHOUSE_INSUFFICIENT_STOCK');
        expect(err.message).not.toMatch(/have 3|need 5/);
        // A known business failure is not routed through the generic error path.
        expect(h.handled).toHaveLength(0);
        // The compensating revert still ran.
        expect(h.contract?.status).toBe('accepted');
        expect(h.contract?.delivered_at ?? null).toBeNull();
    });

    it('any other RPC error goes through handleSupabaseError and surfaces only its fixed message', async () => {
        h.rpcError = {
            message: 'null value in column "stock_id" of relation "warehouse_movements" violates not-null constraint',
            code: '23502',
            details: 'Failing row contains (...)',
            hint: null,
        };
        const err = await deliverError();
        expect(err.message).toBe('Stock movement failed');
        expect(err.message).not.toMatch(/warehouse_movements|stock_id|constraint|null value/);
        expect(h.handled).toHaveLength(1);
        expect(h.handled[0].error).toBe(h.rpcError);   // the raw error reaches the logger, not the caller
        expect(h.contract?.status).toBe('accepted');
    });

    it('the RAISE token only counts at the START of the message (no spoofed fixed copy for other failures)', async () => {
        h.rpcError = { message: 'some wrapper: WAREHOUSE_INSUFFICIENT_STOCK: have 1, need 2', code: 'XX000' };
        const err = await deliverError();
        expect(err.message).toBe('Stock movement failed');
        expect(h.handled).toHaveLength(1);
    });

    it('a successful movement still delivers', async () => {
        await markMarketplaceDelivered('C1', SELLER, WAREHOUSE_ACTOR);
        expect(h.contract?.status).toBe('delivered');
        expect(h.handled).toHaveLength(0);
    });
});
