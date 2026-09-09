import { describe, it, expect, vi, beforeEach } from 'vitest';

// Security checks for the quartermaster data layer:
//  - updatePlatformItem must drop sync/identity keys (mass-assignment on the
//    global QM platform catalog) while keeping operator-editable display columns.
//  - the issuance write paths (fulfil / direct / bulk) must fail closed on
//    over-issue instead of driving computed on-hand (SUM of movements) negative.
//  - the on-hand read itself must fail closed. quantityOnHand is summed ONLY
//    from the movement log, so a discarded error there made every scanned row
//    sum to 0 — a fabricated zero-stock alarm on the overview card and a 0 in
//    every quantity_on_hand cell of the qm:export_csv inventory audit.

const ctx = vi.hoisted(() => ({
    // Resolved value for terminal awaits (.then) and .single()/.maybeSingle(),
    // keyed by table so each function's distinct queries can be configured.
    // `count` models PostgREST's exact-count header for the truncation guard.
    list: {} as Record<string, { data: unknown; error: unknown; count?: number }>,
    single: {} as Record<string, { data: unknown; error: unknown }>,
    rpc: { data: 1 as unknown, error: null as unknown },
    rpcCalls: [] as Array<{ fn: string; args: unknown }>,
    updateArgs: [] as Array<{ table: string; patch: Record<string, unknown> }>,
    queries: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit', 'ilike', 'update', 'delete', 'insert', 'upsert', 'range']) {
            b[m] = (...args: unknown[]) => {
                calls.push({ method: m, args });
                if (m === 'update') ctx.updateArgs.push({ table, patch: args[0] as Record<string, unknown> });
                return b;
            };
        }
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
            ctx.queries.push({ table, calls });
            const seeded = ctx.list[table] ?? { data: [], error: null };
            // Honour .range() so a paging caller (exportInventoryCsv) reaches the
            // end of the seeded table instead of being served page 1 forever.
            const range = calls.find(c => c.method === 'range');
            if (range && Array.isArray(seeded.data)) {
                const from = Number(range.args[0]);
                const to = Number(range.args[1]);
                return Promise.resolve({ ...seeded, data: seeded.data.slice(from, to + 1) }).then(res, rej);
            }
            return Promise.resolve(seeded).then(res, rej);
        };
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
    listLowStockInventory,
    listInventory,
    exportInventoryCsv,
} from '../lib/db/quartermaster';

beforeEach(() => {
    ctx.list = {};
    ctx.single = {};
    ctx.rpc = { data: 1, error: null };
    ctx.rpcCalls = [];
    ctx.updateArgs = [];
    ctx.queries = [];
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

// The on-hand read is the ONE source of quantityOnHand. It used to discard its
// error in two of its three callers, so a DB fault resolved to an empty map and
// every scanned row summed to 0 — the low-stock card filled with fabricated
// out-of-stock items (alphabetically first, since every quantity tied at 0) and
// the inventory audit CSV wrote 0 into every quantity_on_hand cell.
const lowStockRow = (id: number, name: string) => ({
    id, custom_name: name, catalog_id: null, catalog: null, location: null,
});
const inventoryRow = (id: number, name: string) => ({
    id, catalog_id: null, custom_name: name, location_id: null, condition: 'pristine',
    acquired_at: '2026-01-01', notes: null, is_archived: false,
    created_at: '2026-01-01', updated_at: '2026-01-01',
});

describe('listLowStockInventory fails closed on the movements read', () => {
    it('THROWS instead of publishing a fabricated zero-stock alarm when the movement log cannot be read', async () => {
        // Pre-fix this resolved to three rows each reporting quantityOnHand: 0 —
        // a wrong answer on a card whose whole purpose is to be believed.
        ctx.list['quartermaster_inventory'] = { data: [lowStockRow(1, 'Alpha'), lowStockRow(2, 'Bravo'), lowStockRow(3, 'Cobalt')], error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: null, error: { code: '08006', message: 'connection failure' } };
        await expect(listLowStockInventory()).rejects.toThrow(/on-hand quantity/i);
    });

    it('returns an empty card, not a false alarm, when the movements table is absent (42P01)', async () => {
        ctx.list['quartermaster_inventory'] = { data: [lowStockRow(1, 'Alpha')], error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: null, error: { code: '42P01', message: 'relation does not exist' } };
        expect(await listLowStockInventory()).toEqual([]);
    });

    it('THROWS when PostgREST silently truncated the movement log (short page, no error)', async () => {
        // A half-read log understates on-hand — the same fabricated zero arriving
        // through the server row cap instead of a discarded error variable.
        ctx.list['quartermaster_inventory'] = { data: [lowStockRow(1, 'Alpha')], error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: [{ inventory_id: 1, delta: 10 }], error: null, count: 5 };
        await expect(listLowStockInventory()).rejects.toThrow(/truncated by the server row cap/i);
    });

    it('sums real movements and reports only rows at or below the threshold, lowest first', async () => {
        ctx.list['quartermaster_inventory'] = { data: [lowStockRow(1, 'Alpha'), lowStockRow(2, 'Bravo'), lowStockRow(3, 'Cobalt')], error: null };
        ctx.list['quartermaster_inventory_movements'] = {
            data: [{ inventory_id: 1, delta: 10 }, { inventory_id: 1, delta: -9 }, { inventory_id: 2, delta: 50 }],
            error: null,
        };
        const rows = await listLowStockInventory();
        // 3 has no movements (a genuine 0), 1 sums to 1, 2 sums to 50 and is out.
        expect(rows.map(r => r.inventoryId)).toEqual([3, 1]);
        expect(rows.map(r => r.quantityOnHand)).toEqual([0, 1]);
    });

    it('degrades the On-issue badge but does not fail the card when the issuance read errors', async () => {
        // On-issue is neither the filter predicate nor the sort key, so a fault
        // there can dim a badge but can never create or hide a low-stock row.
        ctx.list['quartermaster_inventory'] = { data: [lowStockRow(1, 'Alpha')], error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: [{ inventory_id: 1, delta: 1 }], error: null };
        ctx.list['quartermaster_issuances'] = { data: null, error: { code: '08006', message: 'connection failure' } };
        const rows = await listLowStockInventory();
        expect(rows).toHaveLength(1);
        expect(rows[0].quantityOnIssue).toBe(0);
    });
});

describe('the armory list and its audit CSV fail closed on the same read', () => {
    it('listInventory THROWS rather than reporting every item as 0 on hand', async () => {
        ctx.list['quartermaster_inventory'] = { data: [inventoryRow(1, 'Alpha')], error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: null, error: { code: '08006', message: 'connection failure' } };
        await expect(listInventory()).rejects.toThrow(/on-hand quantity/i);
    });

    it('listInventory THROWS when the active-issuance read fails (quantity_on_issue is an audit column, not a badge)', async () => {
        ctx.list['quartermaster_inventory'] = { data: [inventoryRow(1, 'Alpha')], error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: [{ inventory_id: 1, delta: 5 }], error: null };
        ctx.list['quartermaster_issuances'] = { data: null, error: { code: '08006', message: 'connection failure' } };
        await expect(listInventory()).rejects.toThrow(/active issuances/i);
    });

    it('exportInventoryCsv THROWS rather than writing a fabricated 0 into every quantity_on_hand cell', async () => {
        ctx.list['quartermaster_inventory'] = { data: [inventoryRow(1, 'Alpha'), inventoryRow(2, 'Bravo')], error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: null, error: { code: '08006', message: 'connection failure' } };
        await expect(exportInventoryCsv()).rejects.toThrow(/on-hand quantity/i);
    });

    it('exportInventoryCsv pages the whole inventory instead of stopping at listInventory\u2019s 1000-row clamp', async () => {
        ctx.list['quartermaster_inventory'] = { data: Array.from({ length: 1200 }, (_, i) => inventoryRow(i + 1, `Item ${i + 1}`)), error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: [], error: null };
        const lines = (await exportInventoryCsv()).split('\n');
        expect(lines).toHaveLength(1201); // header + 1200
        expect(lines.some(l => l.startsWith('** TRUNCATED'))).toBe(false);
    });
});

describe('exportInventoryCsv truncation notice', () => {
    it('marks truncation IN THE FILE, full width and last, when the export ceiling is reached', async () => {
        ctx.list['quartermaster_inventory'] = { data: Array.from({ length: 10_050 }, (_, i) => inventoryRow(i + 1, `Item ${i + 1}`)), error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: [], error: null };
        const lines = (await exportInventoryCsv()).split('\n');
        const notice = lines[lines.length - 1];
        expect(lines).toHaveLength(10_002); // header + 10000 rows + notice
        expect(notice).toMatch(/^"?\*\* TRUNCATED/);
        expect(notice).toContain('ceiling 10000');
        expect(notice.split(',').length).toBe(lines[0].split(',').length);
    });

    it('does NOT mislabel an inventory of exactly the ceiling as truncated', async () => {
        ctx.list['quartermaster_inventory'] = { data: Array.from({ length: 10_000 }, (_, i) => inventoryRow(i + 1, `Item ${i + 1}`)), error: null };
        ctx.list['quartermaster_inventory_movements'] = { data: [], error: null };
        const csv = await exportInventoryCsv();
        expect(csv.split('\n')).toHaveLength(10_001);
        expect(csv).not.toContain('** TRUNCATED');
    });
});
