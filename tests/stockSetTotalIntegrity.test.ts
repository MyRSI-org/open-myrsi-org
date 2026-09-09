import { describe, it, expect, vi, beforeEach } from 'vitest';

// THE CLIENT MUST NEVER COMPUTE THE DELTA.
//
// Both "Set total" dialogs used to send (target - onHand) where onHand came from a
// useState snapshot frozen when the dialog opened — QmArmoryTab sets adjustTarget and
// nothing re-syncs it, and WarehouseView does the same. The server procs locked the row
// and serialised the WRITES perfectly, but the ARITHMETIC had already been done against a
// stale read, so the lock could not help. Three reachable shapes, all through the normal
// UI, on a row whose movement log sums to 10:
//
//   (a) duplicate correction — two managers both open at 10, both physically count 8,
//       both submit "set total 8", both send -2. The row lands on SIX.
//   (b) concurrent issue — A opens at 10, B issues 4, A sets total 12 and sends +2.
//       On-hand becomes 8, not 12, and nothing says so.
//   (c) negative ledger — A opens at 10, B issues all 10, A sets total 0 and sends -10.
//       On-hand becomes MINUS TEN. qm_adjust_inventory had no on-hand guard at all, so
//       the only thing that had ever blocked this was a client-side check computed from
//       the same stale number.
//
// The fix is not "re-fetch before submitting" — that is the same race with a smaller
// window. It is to send the TARGET and let the server subtract under the row lock.
//
// These tests pin the property that matters: the RPC payload carries an absolute target
// and no delta of any kind. A regression that reintroduces client arithmetic would still
// pass a test that only checked "the RPC was called".

const ctx = vi.hoisted(() => ({
    rpc: { data: 'movement-1' as unknown, error: null as unknown },
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    single: {} as Record<string, { data: unknown; error: unknown }>,
    emits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit', 'ilike', 'update', 'delete', 'insert', 'upsert', 'range']) {
            b[m] = () => b;
        }
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(res, rej);
        b.single = () => Promise.resolve(ctx.single[table] ?? { data: null, error: null });
        b.maybeSingle = () => Promise.resolve(ctx.single[table] ?? { data: null, error: null });
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: Record<string, unknown>) => {
                ctx.rpcCalls.push({ fn, args });
                return Promise.resolve(ctx.rpc);
            },
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { ctx.emits.push({ event, payload }); },
        broadcastToChannel: () => {},
    };
});

import { setInventoryTotal } from '../lib/db/quartermaster';
import { setWarehouseStockTotal } from '../lib/db/warehouse';
import { MAX_STOCK_TOTAL } from '../lib/stockLimits';

const ACTOR = 7;

beforeEach(() => {
    ctx.rpc = { data: 'movement-1', error: null };
    ctx.rpcCalls = [];
    ctx.single = {};
    ctx.emits = [];
});

/** Any key that would carry a client-computed change rather than an absolute total. */
const DELTA_KEYS = ['p_delta', 'delta', 'p_change', 'change', 'p_diff', 'diff'];

describe('setInventoryTotal — sends an absolute target, never a delta', () => {
    it('calls qm_set_inventory_total with p_target_total and no delta key', async () => {
        await setInventoryTotal(ACTOR, { inventoryId: 42, targetTotal: 8, reason: 'adjust', notes: 'recount' });

        expect(ctx.rpcCalls).toHaveLength(1);
        expect(ctx.rpcCalls[0].fn).toBe('qm_set_inventory_total');
        expect(ctx.rpcCalls[0].args.p_target_total).toBe(8);
        expect(ctx.rpcCalls[0].args.p_inventory_id).toBe(42);
        expect(ctx.rpcCalls[0].args.p_actor_id).toBe(ACTOR);
        for (const k of DELTA_KEYS) expect(ctx.rpcCalls[0].args).not.toHaveProperty(k);
    });

    it('shape (a): two callers correcting 10 -> 8 both send the TARGET 8, not -2', async () => {
        // The whole regression in one assertion. Under the old code both of these were
        // `{ p_delta: -2 }` and the second one silently took a correct row to 6.
        await setInventoryTotal(ACTOR, { inventoryId: 42, targetTotal: 8, reason: 'adjust' });
        await setInventoryTotal(ACTOR + 1, { inventoryId: 42, targetTotal: 8, reason: 'adjust' });
        expect(ctx.rpcCalls.map((c) => c.args.p_target_total)).toEqual([8, 8]);
    });

    it('refuses a negative target without touching the database', async () => {
        await expect(setInventoryTotal(ACTOR, { inventoryId: 42, targetTotal: -1, reason: 'adjust' }))
            .rejects.toThrow(/non-negative/i);
        expect(ctx.rpcCalls).toEqual([]);
    });

    it('refuses a target above the ledger ceiling without touching the database', async () => {
        await expect(setInventoryTotal(ACTOR, { inventoryId: 42, targetTotal: MAX_STOCK_TOTAL + 1, reason: 'adjust' }))
            .rejects.toThrow(/must not exceed/i);
        expect(ctx.rpcCalls).toEqual([]);
        // The boundary itself is allowed.
        await setInventoryTotal(ACTOR, { inventoryId: 42, targetTotal: MAX_STOCK_TOTAL, reason: 'adjust' });
        expect(ctx.rpcCalls).toHaveLength(1);
    });

    it('refuses a non-numeric target rather than sending NaN', async () => {
        await expect(setInventoryTotal(ACTOR, { inventoryId: 42, targetTotal: Number.NaN, reason: 'adjust' }))
            .rejects.toThrow(/non-negative/i);
        expect(ctx.rpcCalls).toEqual([]);
    });

    it('truncates a fractional target instead of sending a float into an integer column', async () => {
        await setInventoryTotal(ACTOR, { inventoryId: 42, targetTotal: 8.9, reason: 'adjust' });
        expect(ctx.rpcCalls[0].args.p_target_total).toBe(8);
    });

    it('fails closed on an RPC error and emits no broadcast', async () => {
        ctx.rpc = { data: null, error: { message: 'QM_INSUFFICIENT_STOCK: current 0, delta -10' } };
        await expect(setInventoryTotal(ACTOR, { inventoryId: 42, targetTotal: 0, reason: 'adjust' })).rejects.toThrow();
        expect(ctx.emits).toEqual([]);
    });

    it('broadcasts the row id only (rule 4: realtime carries ids, never content)', async () => {
        await setInventoryTotal(ACTOR, { inventoryId: 42, targetTotal: 8, reason: 'adjust', notes: 'secret recount note' });
        expect(ctx.emits).toEqual([{ event: 'qm:inventory_update', payload: { inventoryId: 42 } }]);
    });
});

describe('setWarehouseStockTotal — the twin, same contract', () => {
    beforeEach(() => { ctx.single.warehouse_stock = { data: { id: 9 }, error: null }; });

    it('calls warehouse_set_stock_total with p_target_total and no delta key', async () => {
        await setWarehouseStockTotal(9, 120, 'adjust', ACTOR, ' recount ');

        expect(ctx.rpcCalls).toHaveLength(1);
        expect(ctx.rpcCalls[0].fn).toBe('warehouse_set_stock_total');
        expect(ctx.rpcCalls[0].args.p_target_total).toBe(120);
        expect(ctx.rpcCalls[0].args.p_stock_id).toBe(9);
        expect(ctx.rpcCalls[0].args.p_notes).toBe('recount');
        for (const k of DELTA_KEYS) expect(ctx.rpcCalls[0].args).not.toHaveProperty(k);
    });

    it('returns NULL as SUCCESS when the row is already at the target', async () => {
        // movements carries CHECK (delta <> 0), so a no-op posts nothing and the proc
        // returns NULL. A caller that read null as failure would show a spurious error
        // on the most ordinary outcome there is: the count was already right.
        ctx.rpc = { data: null, error: null };
        await expect(setWarehouseStockTotal(9, 120, 'adjust', ACTOR)).resolves.toBeNull();
        expect(ctx.emits).toEqual([{ event: 'warehouse:stock_update', payload: { stockId: 9 } }]);
    });

    it('refuses a set-total against a stock row that does not exist, before the RPC', async () => {
        ctx.single.warehouse_stock = { data: null, error: null };
        await expect(setWarehouseStockTotal(404, 5, 'adjust', ACTOR)).rejects.toThrow(/not found/i);
        expect(ctx.rpcCalls).toEqual([]);
    });

    it("refuses 'initial' — a set-total is a correction, never the seeding movement", async () => {
        await expect(setWarehouseStockTotal(9, 5, 'initial', ACTOR)).rejects.toThrow(/Invalid adjustment reason/i);
        expect(ctx.rpcCalls).toEqual([]);
    });

    it('refuses a transfer/withdraw reason that belongs to another code path', async () => {
        await expect(setWarehouseStockTotal(9, 5, 'transfer_out', ACTOR)).rejects.toThrow(/Invalid adjustment reason/i);
        await expect(setWarehouseStockTotal(9, 5, 'withdraw_sale', ACTOR)).rejects.toThrow(/Invalid adjustment reason/i);
        expect(ctx.rpcCalls).toEqual([]);
    });

    it('refuses a negative target and one above the ceiling, without touching the database', async () => {
        await expect(setWarehouseStockTotal(9, -1, 'adjust', ACTOR)).rejects.toThrow(/non-negative/i);
        await expect(setWarehouseStockTotal(9, MAX_STOCK_TOTAL + 1, 'adjust', ACTOR)).rejects.toThrow(/must not exceed/i);
        expect(ctx.rpcCalls).toEqual([]);
    });

    it('fails closed on an RPC error and emits no broadcast', async () => {
        ctx.rpc = { data: null, error: { message: 'WAREHOUSE_INSUFFICIENT_STOCK: current 0, delta -10' } };
        await expect(setWarehouseStockTotal(9, 0, 'adjust', ACTOR)).rejects.toThrow();
        expect(ctx.emits).toEqual([]);
    });
});
