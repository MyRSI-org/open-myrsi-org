import { describe, it, expect, vi, beforeEach } from 'vitest';

// Security checks for the quartermaster data layer:
//  - updatePlatformItem must drop sync/identity keys (mass-assignment on the
//    global QM platform catalog) while keeping operator-editable display columns.
//  - the issuance write paths (fulfil / direct / bulk) must fail closed on
//    over-issue instead of driving computed on-hand (SUM of movements) negative.

const ctx = vi.hoisted(() => ({
    // Resolved value for terminal awaits (.then) and .single()/.maybeSingle(),
    // keyed by table so each function's distinct queries can be configured.
    list: {} as Record<string, { data: unknown; error: unknown }>,
    single: {} as Record<string, { data: unknown; error: unknown }>,
    rpc: { data: 1 as unknown, error: null as unknown },
    rpcCalls: [] as Array<{ fn: string; args: unknown }>,
    updateArgs: [] as Array<{ table: string; patch: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit', 'ilike', 'update', 'delete', 'insert', 'upsert', 'range']) {
            b[m] = (...args: unknown[]) => {
                if (m === 'update') ctx.updateArgs.push({ table, patch: args[0] as Record<string, unknown> });
                return b;
            };
        }
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(ctx.list[table] ?? { data: [], error: null }).then(res, rej);
        b.single = () => Promise.resolve(ctx.single[table] ?? { data: null, error: null });
        b.maybeSingle = () => Promise.resolve(ctx.single[table] ?? { data: null, error: null });
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: unknown) => { ctx.rpcCalls.push({ fn, args }); return Promise.resolve(ctx.rpc); },
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
    };
});

import {
    updatePlatformItem,
    fulfilIssuance,
    issueDirect,
    issueDirectBulk,
} from '../lib/db/quartermaster';

beforeEach(() => {
    ctx.list = {};
    ctx.single = {};
    ctx.rpc = { data: 1, error: null };
    ctx.rpcCalls = [];
    ctx.updateArgs = [];
});

describe('updatePlatformItem mass-assignment deny-list', () => {
    it('drops sync/identity fields, keeps operator-editable display edits', async () => {
        await updatePlatformItem(1, {
            name: 'New', category: 'misc', is_vehicle_item: true,
            external_uuid: 'x', external_id: 999, slug: 'y', id: 5, source: 'custom',
            created_at: 'z', last_synced_at: 'w',
        });
        const upd = ctx.updateArgs.find(c => c.table === 'quartermaster_catalog');
        expect(upd).toBeDefined();
        const patch = upd!.patch;
        // legit edits survive
        expect(patch.name).toBe('New');
        expect(patch.category).toBe('misc');
        expect(patch.is_vehicle_item).toBe(true);
        // sync / identity keys are stripped
        for (const k of ['external_uuid', 'external_id', 'slug', 'id', 'source', 'created_at', 'last_synced_at']) {
            expect(k in patch).toBe(false);
        }
    });

    it('throws when only protected fields are supplied (nothing editable)', async () => {
        await expect(
            updatePlatformItem(1, { external_uuid: 'x', external_id: 999, slug: 'y', id: 5, source: 'custom', created_at: 'z', last_synced_at: 'w' }),
        ).rejects.toThrow(/no updatable fields/i);
    });
});

describe('quartermaster over-issue guard', () => {
    it('fulfilIssuance fails closed when on-hand < requested, without calling the proc', async () => {
        ctx.single['quartermaster_issuances'] = { data: { id: 1, status: 'requested', inventory_id: 5, quantity: 10 }, error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: [{ inventory_id: 5, delta: 1 }], error: null }; // on-hand = 1
        await expect(fulfilIssuance(7, 1)).rejects.toThrow(/QM_INSUFFICIENT_STOCK/);
        expect(ctx.rpcCalls.find(c => c.fn === 'qm_fulfil_issuance')).toBeUndefined();
    });

    it('fulfilIssuance proceeds to the proc when on-hand covers the request', async () => {
        ctx.single['quartermaster_issuances'] = { data: { id: 1, status: 'requested', inventory_id: 5, quantity: 10 }, error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: [{ inventory_id: 5, delta: 50 }], error: null }; // on-hand = 50
        const result = await fulfilIssuance(7, 1);
        expect(result).toBe(true);
        expect(ctx.rpcCalls.find(c => c.fn === 'qm_fulfil_issuance')).toBeDefined();
    });

    it('issueDirect fails closed when on-hand < requested, without calling the proc', async () => {
        ctx.single['quartermaster_inventory'] = { data: { id: 5 }, error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: [{ inventory_id: 5, delta: 2 }], error: null }; // on-hand = 2
        await expect(
            issueDirect(7, { inventoryId: 5, issuedToUserId: 9, quantity: 10 }),
        ).rejects.toThrow(/QM_INSUFFICIENT_STOCK/);
        expect(ctx.rpcCalls.find(c => c.fn === 'qm_issue_direct')).toBeUndefined();
    });

    it('issueDirect proceeds to the proc when on-hand covers the request', async () => {
        ctx.single['quartermaster_inventory'] = { data: { id: 5 }, error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: [{ inventory_id: 5, delta: 25 }], error: null }; // on-hand = 25
        ctx.rpc = { data: 42, error: null };
        const id = await issueDirect(7, { inventoryId: 5, issuedToUserId: 9, quantity: 10 });
        expect(id).toBe(42);
        expect(ctx.rpcCalls.find(c => c.fn === 'qm_issue_direct')).toBeDefined();
    });

    it('issueDirectBulk fails closed on over-issue, without calling the proc (no movements written)', async () => {
        // Tenant-scope lookup: inventory id 5 exists.
        ctx.list['quartermaster_inventory'] = { data: [{ id: 5 }], error: null };
        // on-hand = 3 (SUM of movement deltas).
        ctx.list['quartermaster_inventory_movements'] = { data: [{ inventory_id: 5, delta: 3 }], error: null };
        await expect(
            issueDirectBulk(7, { issuedToUserId: 9, lines: [{ inventoryId: 5, quantity: 10 }] }),
        ).rejects.toThrow(/QM_INSUFFICIENT_STOCK/);
        // The over-issue never reached the movement-posting proc.
        expect(ctx.rpcCalls.find(c => c.fn === 'qm_issue_bulk')).toBeUndefined();
    });

    it('issueDirectBulk rejects when summed lines for one inventory row exceed on-hand', async () => {
        ctx.list['quartermaster_inventory'] = { data: [{ id: 5 }], error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: [{ inventory_id: 5, delta: 8 }], error: null }; // on-hand = 8
        // Two lines against the SAME row sum to 10 > 8 even though each is < 8.
        await expect(
            issueDirectBulk(7, { issuedToUserId: 9, lines: [{ inventoryId: 5, quantity: 5 }, { inventoryId: 5, quantity: 5 }] }),
        ).rejects.toThrow(/QM_INSUFFICIENT_STOCK/);
        expect(ctx.rpcCalls.find(c => c.fn === 'qm_issue_bulk')).toBeUndefined();
    });

    it('issueDirectBulk proceeds to the proc when on-hand covers every line', async () => {
        ctx.list['quartermaster_inventory'] = { data: [{ id: 5 }], error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: [{ inventory_id: 5, delta: 25 }], error: null }; // on-hand = 25
        ctx.rpc = { data: [101], error: null };
        const ids = await issueDirectBulk(7, { issuedToUserId: 9, lines: [{ inventoryId: 5, quantity: 10 }] });
        expect(ids).toEqual([101]);
        expect(ctx.rpcCalls.find(c => c.fn === 'qm_issue_bulk')).toBeDefined();
    });
});
