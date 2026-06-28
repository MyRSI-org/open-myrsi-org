import { describe, it, expect, vi, beforeEach } from 'vitest';

// Warehouse withdrawal-request integrity. A pending/approved request's
// requested_quantity feeds the view-computed quantity_reserved, which is
// consumed server-side (deleteWarehouseStock refuses while reserved > 0; the
// manager UI shows available = on_hand - reserved). createWithdrawalRequest must
// therefore validate the requested amount against the stock row's REAL on-hand
// BEFORE inserting, so a warehouse:request holder cannot reserve an arbitrary
// (up to ~2.1B) quantity that pins a row against deletion / drives availability
// negative / overflows the SUM. It must also reject a non-existent stock id
// explicitly rather than relying on the FK.

const h = vi.hoisted(() => ({
    // stockId -> quantity_on_hand. Absent entry => row not found.
    stockQty: new Map<number, number>(),
    // stockId -> quantity_reserved (pending/approved requests + open sell
    // contracts). Absent entry => 0 reserved (the historical behaviour).
    stockReserved: new Map<number, number>(),
    // Every row passed to warehouse_requests.insert (proves we DID/DIDN'T reach it).
    requestInserts: [] as Array<Record<string, unknown>>,
    emits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = { op: 'select' as string, values: null as Record<string, unknown> | null, filters: {} as Record<string, unknown> };
        const b: any = {};
        b.select = () => b;
        b.insert = (values: Record<string, unknown>) => { state.op = 'insert'; state.values = values; return b; };
        b.update = (values: Record<string, unknown>) => { state.op = 'update'; state.values = values; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.in = () => b; b.is = () => b; b.or = () => b; b.ilike = () => b;
        b.order = () => b; b.limit = () => b; b.range = () => b; b.gte = () => b; b.lte = () => b;
        const settle = (mode: 'many' | 'single') => {
            if (table === 'v_warehouse_stock_with_qty' && state.op === 'select') {
                const id = Number(state.filters.id);
                const qty = h.stockQty.get(id);
                const row = qty === undefined
                    ? null
                    : { id, quantity_on_hand: qty, quantity_reserved: h.stockReserved.get(id) ?? 0 };
                return Promise.resolve({ data: mode === 'single' ? row : (row ? [row] : []), error: null });
            }
            if (table === 'warehouse_requests' && state.op === 'insert') {
                const v = state.values as Record<string, unknown>;
                h.requestInserts.push(v);
                const row = {
                    id: 'req-1',
                    stock_id: v.stock_id,
                    requested_by_user_id: v.requested_by_user_id,
                    requested_quantity: v.requested_quantity,
                    reason_category: v.reason_category,
                    reason_notes: v.reason_notes ?? null,
                    status: 'pending',
                    approved_by_user_id: null,
                    approved_at: null,
                    fulfilled_movement_id: null,
                    fulfilled_at: null,
                    denial_reason: null,
                    created_at: 't',
                    updated_at: 't',
                    requested_by: { id: v.requested_by_user_id, name: 'U', avatar_url: null },
                };
                return Promise.resolve({ data: row, error: null });
            }
            return Promise.resolve({ data: mode === 'single' ? null : [], error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (resolve: any, reject: any) => settle('many').then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.emits.push({ event, payload }); },
        broadcastToChannel: () => {},
    };
});

import { createWithdrawalRequest } from '../lib/db/warehouse';

const REQUESTER = 42;

beforeEach(() => {
    h.stockQty = new Map<number, number>();
    h.stockReserved = new Map<number, number>();
    h.requestInserts = [];
    h.emits = [];
});

describe('createWithdrawalRequest on-hand ceiling', () => {
    it('rejects an unbounded requested_quantity (> on_hand) WITHOUT reaching the insert', async () => {
        h.stockQty.set(1, 10); // stock #1 has 10 on hand
        await expect(
            createWithdrawalRequest(REQUESTER, { stockId: 1, requestedQuantity: 2_000_000_000, reasonCategory: 'other' }),
        ).rejects.toThrow(/only 10 on hand/i);
        // The bogus request never inflated quantity_reserved — no row was written.
        expect(h.requestInserts).toHaveLength(0);
    });

    it('rejects a request just above on_hand (off-by-one ceiling)', async () => {
        h.stockQty.set(1, 10);
        await expect(
            createWithdrawalRequest(REQUESTER, { stockId: 1, requestedQuantity: 11, reasonCategory: 'sale' }),
        ).rejects.toThrow(/on hand/i);
        expect(h.requestInserts).toHaveLength(0);
    });

    it('rejects a request against a non-existent stock id (does not rely on the FK)', async () => {
        // No entry for stock #999 => view lookup returns null.
        await expect(
            createWithdrawalRequest(REQUESTER, { stockId: 999, requestedQuantity: 1, reasonCategory: 'other' }),
        ).rejects.toThrow(/not found/i);
        expect(h.requestInserts).toHaveLength(0);
    });

    it('rejects a request when the stock is empty (on_hand = 0)', async () => {
        h.stockQty.set(1, 0);
        await expect(
            createWithdrawalRequest(REQUESTER, { stockId: 1, requestedQuantity: 1, reasonCategory: 'craft' }),
        ).rejects.toThrow(/on hand/i);
        expect(h.requestInserts).toHaveLength(0);
    });

    it('still rejects a non-positive / non-finite quantity before any DB call', async () => {
        h.stockQty.set(1, 10);
        await expect(
            createWithdrawalRequest(REQUESTER, { stockId: 1, requestedQuantity: 0, reasonCategory: 'other' }),
        ).rejects.toThrow(/must be positive/i);
        await expect(
            createWithdrawalRequest(REQUESTER, { stockId: 1, requestedQuantity: Number.POSITIVE_INFINITY, reasonCategory: 'other' }),
        ).rejects.toThrow(/must be positive/i);
        expect(h.requestInserts).toHaveLength(0);
    });

    it('inserts when requested_quantity <= on_hand (truncated to an integer)', async () => {
        h.stockQty.set(1, 10);
        const req = await createWithdrawalRequest(REQUESTER, { stockId: 1, requestedQuantity: 5.9, reasonCategory: 'sale' });
        expect(h.requestInserts).toHaveLength(1);
        expect(h.requestInserts[0].requested_quantity).toBe(5);
        expect(h.requestInserts[0].stock_id).toBe(1);
        expect(req.requestedQuantity).toBe(5);
    });

    it('allows reserving exactly the on-hand amount (boundary)', async () => {
        h.stockQty.set(1, 10);
        await createWithdrawalRequest(REQUESTER, { stockId: 1, requestedQuantity: 10, reasonCategory: 'transport' });
        expect(h.requestInserts).toHaveLength(1);
        expect(h.requestInserts[0].requested_quantity).toBe(10);
    });

    // Bound the new reservation by AVAILABILITY
    // (on_hand − already-reserved), not raw on_hand, so existing reservations
    // can't be over-stacked beyond what physically exists via many requests.
    it('rejects a request that exceeds availability even though it is within on_hand', async () => {
        h.stockQty.set(1, 10);
        h.stockReserved.set(1, 7); // 7 already reserved => only 3 available
        await expect(
            createWithdrawalRequest(REQUESTER, { stockId: 1, requestedQuantity: 5, reasonCategory: 'sale' }),
        ).rejects.toThrow(/only 3 available .*already reserved/i);
        // No row written — quantity_reserved was not stacked past on_hand.
        expect(h.requestInserts).toHaveLength(0);
    });

    it('allows a request up to the availability ceiling (on_hand − reserved)', async () => {
        h.stockQty.set(1, 10);
        h.stockReserved.set(1, 7); // 3 available
        await createWithdrawalRequest(REQUESTER, { stockId: 1, requestedQuantity: 3, reasonCategory: 'craft' });
        expect(h.requestInserts).toHaveLength(1);
        expect(h.requestInserts[0].requested_quantity).toBe(3);
    });

    it('rejects when the row is fully reserved (available = 0) even with on_hand > 0', async () => {
        h.stockQty.set(1, 10);
        h.stockReserved.set(1, 10); // nothing available
        await expect(
            createWithdrawalRequest(REQUESTER, { stockId: 1, requestedQuantity: 1, reasonCategory: 'other' }),
        ).rejects.toThrow(/only 0 available/i);
        expect(h.requestInserts).toHaveLength(0);
    });
});
