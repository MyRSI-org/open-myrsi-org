import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/warehouse.ts — STOCK rows, the movement LEDGER and WITHDRAWAL requests:
// list/count/create (incl. materialising a platform commodity), the guarded delete,
// the adjust / set-total / transfer RPCs, contract-party narrowing in toMovement,
// availability-bounded withdrawal requests and the request state machine. Every
// query is recorded so each test pins table, explicit columns, filters, payload,
// order, the RPC arguments and the id-only realtime events.

vi.mock('../lib/db/common', async () => (await import('./cov-db-warehouse-fake')).commonMock);
vi.mock('../lib/log', async () => (await import('./cov-db-warehouse-fake')).logMock);
vi.mock('../lib/db/marketplace', async () => (await import('./cov-db-warehouse-fake')).marketplaceMock);
vi.mock('../lib/db/uex', async () => (await import('./cov-db-warehouse-fake')).uexMock);

import {
    fake, resetFake, respond, respondRpc, queriesOf, calls, chain, selected, trail, filterContractIdsForParty,
} from './cov-db-warehouse-fake';
import {
    listWarehouseStock,
    listWarehouseStockCount,
    createWarehouseStock,
    deleteWarehouseStock,
    adjustWarehouseStock,
    setWarehouseStockTotal,
    transferWarehouseStock,
    listWarehouseMovements,
    createWithdrawalRequest,
    listWithdrawalRequests,
    approveWithdrawalRequest,
    denyWithdrawalRequest,
    cancelWithdrawalRequest,
    fulfilWithdrawalRequest,
} from '../lib/db/warehouse';
import { MAX_STOCK_TOTAL } from '../lib/stockLimits';
import type { WarehouseMovementReason, WarehouseReasonCategory } from '../types';

const NOW = '2026-01-02T03:04:05.000Z';
const DB_ERR = { code: 'XX000', message: 'driver detail that must not reach the client' };
const MISSING_TABLE = { code: '42P01', message: 'relation does not exist' };
const CONTRACT = '3f1b9c4e-0000-4000-8000-0000000000aa';

const CAT_EMBED = 'catalog:warehouse_catalog(id, name, category, quality_label, unit, description, archived_at, created_at, updated_at)';
const STOCK_LIST_COLS = `id, catalog_id, location_id, notes, created_at, updated_at, quantity_on_hand, quantity_reserved, ${CAT_EMBED}, location:quartermaster_locations(id, name, type)`;
const STOCK_CREATE_COLS = `id, catalog_id, location_id, notes, created_at, updated_at, ${CAT_EMBED}, location:quartermaster_locations(id, name, type)`;
const SLIM_STOCK_EMBED = 'id, catalog_id, location_id, catalog:warehouse_catalog(id, name, category, quality_label, unit), location:quartermaster_locations(id, name, type) )';
const MOVEMENT_COLS = 'id, stock_id, delta, reason, actor_user_id, related_request_id, related_movement_id, related_contract_id, notes, created_at, '
    + 'actor:users!warehouse_movements_actor_user_id_fkey(id, name, avatar_url), '
    + `stock:warehouse_stock( ${SLIM_STOCK_EMBED}`;
const REQUEST_BASE_COLS = 'id, stock_id, requested_by_user_id, requested_quantity, reason_category, reason_notes, status, approved_by_user_id, approved_at, fulfilled_movement_id, fulfilled_at, denial_reason, created_at, updated_at, '
    + 'requested_by:users!warehouse_requests_requested_by_user_id_fkey(id, name, avatar_url)';
const REQUEST_LIST_COLS = `${REQUEST_BASE_COLS}, stock:warehouse_stock!warehouse_requests_stock_id_fkey( ${SLIM_STOCK_EMBED}`;

function catalogRow(over: Record<string, unknown> = {}) {
    return { id: 3, name: 'Gold', category: 'ore', quality_label: 'A', unit: 'SCU', description: null, archived_at: null, created_at: 'c', updated_at: 'u', ...over };
}

function requestRow(over: Record<string, unknown> = {}) {
    return {
        id: 'req-1', stock_id: 5, requested_by_user_id: 42, requested_quantity: 2, reason_category: 'craft',
        reason_notes: null, status: 'pending', approved_by_user_id: null, approved_at: null,
        fulfilled_movement_id: null, fulfilled_at: null, denial_reason: null, created_at: 'c', updated_at: 'u',
        requested_by: null, stock: null, ...over,
    };
}

beforeEach(() => {
    resetFake();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------
describe('listWarehouseStock', () => {
    it('reads the qty view with explicit columns + embeds and maps both hydrated and bare rows', async () => {
        respond('v_warehouse_stock_with_qty', {
            data: [
                {
                    id: 5, catalog_id: 3, location_id: 8, notes: 'bay 2', created_at: 'c', updated_at: 'u',
                    quantity_on_hand: 12, quantity_reserved: 4,
                    catalog: catalogRow(), location: { id: 8, name: 'Lorville', type: 'station' },
                },
                {
                    id: 6, catalog_id: 3, location_id: 9, notes: '', created_at: 'c', updated_at: 'u',
                    quantity_on_hand: null, quantity_reserved: '7', catalog: null, location: null,
                },
            ],
        });
        const rows = await listWarehouseStock();
        expect(rows).toEqual([
            {
                id: 5, catalogId: 3, locationId: 8, notes: 'bay 2', quantityOnHand: 12, quantityReserved: 4, createdAt: 'c', updatedAt: 'u',
                catalog: { id: 3, name: 'Gold', category: 'ore', qualityLabel: 'A', unit: 'SCU', description: null, archivedAt: null, createdAt: 'c', updatedAt: 'u' },
                location: { id: 8, name: 'Lorville', type: 'station' },
            },
            // A non-numeric quantity never leaks through as a string — it reads as 0.
            { id: 6, catalogId: 3, locationId: 9, notes: null, quantityOnHand: 0, quantityReserved: 0, createdAt: 'c', updatedAt: 'u', catalog: undefined, location: undefined },
        ]);
        const [q] = queriesOf('v_warehouse_stock_with_qty');
        expect(selected(q)).toBe(STOCK_LIST_COLS);
        expect(chain(q)).toEqual(['select', 'order', 'order', 'range']);
        expect(calls(q, 'order')).toEqual([['updated_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(calls(q, 'range')).toEqual([[0, 999]]);
    });

    it('applies catalog/location filters only when supplied (0 is a real id)', async () => {
        await listWarehouseStock({ catalogId: 0, locationId: 5 });
        await listWarehouseStock({ catalogId: null, locationId: undefined });
        const [withFilters, without] = queriesOf('v_warehouse_stock_with_qty');
        expect(calls(withFilters, 'eq')).toEqual([['catalog_id', 0], ['location_id', 5]]);
        expect(calls(without, 'eq')).toEqual([]);
    });

    it('clamps limit and offset', async () => {
        await listWarehouseStock({ limit: 0, offset: -1 });
        await listWarehouseStock({ limit: 2000, offset: 3 });
        expect(queriesOf('v_warehouse_stock_with_qty').map((q) => calls(q, 'range')[0])).toEqual([[0, 0], [3, 1002]]);
    });

    it('42P01 -> [], any other error fails closed', async () => {
        respond('v_warehouse_stock_with_qty', { error: MISSING_TABLE }, { error: DB_ERR });
        expect(await listWarehouseStock()).toEqual([]);
        await expect(listWarehouseStock()).rejects.toThrow('Failed to load warehouse stock');
    });
});

describe('listWarehouseStockCount', () => {
    it('head-only exact count with the same optional filters', async () => {
        respond('warehouse_stock', { count: 9 }, { count: null });
        expect(await listWarehouseStockCount({ catalogId: 3, locationId: 0 })).toBe(9);
        expect(await listWarehouseStockCount()).toBe(0);
        const [first, second] = queriesOf('warehouse_stock');
        expect(calls(first, 'select')).toEqual([['id', { count: 'exact', head: true }]]);
        expect(calls(first, 'eq')).toEqual([['catalog_id', 3], ['location_id', 0]]);
        expect(calls(second, 'eq')).toEqual([]);
    });

    it('42P01 -> 0, any other error fails closed', async () => {
        respond('warehouse_stock', { error: MISSING_TABLE }, { error: DB_ERR });
        expect(await listWarehouseStockCount()).toBe(0);
        await expect(listWarehouseStockCount()).rejects.toThrow('Failed to count warehouse stock');
    });
});

// ---------------------------------------------------------------------------
describe('createWarehouseStock — custom catalog row', () => {
    it('inserts with collapsed notes, returns zero quantities and broadcasts only the stock id', async () => {
        respond('warehouse_stock', {
            data: { id: 77, catalog_id: 3, location_id: 4, notes: 'a b', created_at: 'c', updated_at: 'u', catalog: catalogRow(), location: { id: 4, name: 'Area18', type: 'city' } },
        });
        const stock = await createWarehouseStock({ catalogId: 3, locationId: 4, notes: 'a\r\nb' });
        expect(trail()).toEqual(['warehouse_stock:insert']);
        const [q] = queriesOf('warehouse_stock');
        expect(calls(q, 'insert')).toEqual([[{ catalog_id: 3, location_id: 4, notes: 'a b' }]]);
        expect(selected(q)).toBe(STOCK_CREATE_COLS);
        expect(q.terminal).toBe('single');
        expect(stock).toMatchObject({ id: 77, quantityOnHand: 0, quantityReserved: 0, location: { id: 4, name: 'Area18', type: 'city' } });
        expect(stock.catalog?.name).toBe('Gold');
        expect(fake.emits).toEqual([{ event: 'warehouse:stock_update', payload: { stockId: 77 } }]);
    });

    it('blank notes store null; a write error throws and broadcasts nothing', async () => {
        respond('warehouse_stock', { data: { id: 1 } }, { error: DB_ERR });
        await createWarehouseStock({ catalogId: 3, locationId: 4 });
        expect(calls(queriesOf('warehouse_stock')[0], 'insert')[0][0]).toEqual({ catalog_id: 3, location_id: 4, notes: null });
        fake.emits = [];
        await expect(createWarehouseStock({ catalogId: 3, locationId: 4, notes: 'x' })).rejects.toThrow('Failed to create warehouse stock');
        expect(fake.emits).toEqual([]);
    });
});

describe("createWarehouseStock — source 'platform' materialises the commodity first", () => {
    const PC_COLS = 'id, name, is_fuel, is_refined, is_extractable, is_raw, is_mineral';

    it('reuses an existing (name, quality) catalog row instead of inserting a duplicate', async () => {
        respond('warehouse_platform_commodities', { data: { id: 90, name: '  Laranite ' } });
        respond('warehouse_catalog', { data: { id: 31 } });
        respond('warehouse_stock', { data: { id: 70 } });
        await createWarehouseStock({ source: 'platform', catalogId: 90, locationId: 4, qualityLabel: ' Q\n1 ' });
        expect(trail()).toEqual(['warehouse_platform_commodities:select', 'warehouse_catalog:select', 'warehouse_stock:insert']);
        const [pcQ] = queriesOf('warehouse_platform_commodities');
        expect(selected(pcQ)).toBe(PC_COLS);
        expect(calls(pcQ, 'eq')).toEqual([['id', 90]]);
        expect(pcQ.terminal).toBe('maybeSingle');
        const [lookupQ] = queriesOf('warehouse_catalog');
        expect(selected(lookupQ)).toBe('id');
        // The quality label is collapsed to a single line BEFORE it is used as a key.
        expect(calls(lookupQ, 'eq')).toEqual([['name', 'Laranite'], ['quality_label', 'Q 1']]);
        expect(lookupQ.terminal).toBe('maybeSingle');
        expect(calls(queriesOf('warehouse_stock')[0], 'insert')[0][0]).toMatchObject({ catalog_id: 31 });
        expect(fake.emits).toEqual([{ event: 'warehouse:stock_update', payload: { stockId: 70 } }]);
    });

    it('matches a NULL quality with IS NULL, not = NULL', async () => {
        respond('warehouse_platform_commodities', { data: { id: 90, name: 'Laranite' } });
        respond('warehouse_catalog', { data: { id: 31 } });
        await createWarehouseStock({ source: 'platform', catalogId: 90, locationId: 4 });
        const [lookupQ] = queriesOf('warehouse_catalog');
        expect(calls(lookupQ, 'eq')).toEqual([['name', 'Laranite']]);
        expect(calls(lookupQ, 'is')).toEqual([['quality_label', null]]);
    });

    it.each([
        [{ is_fuel: true, is_refined: true, is_raw: true }, 'fuel'],
        [{ is_refined: true, is_raw: true }, 'refined'],
        [{ is_extractable: true }, 'ore'],
        [{ is_raw: true }, 'ore'],
        [{ is_mineral: true }, 'ore'],
        [{}, 'misc'],
    ])('inserts a new catalog row with the derived category (%o -> %s)', async (flags, category) => {
        respond('warehouse_platform_commodities', { data: { id: 90, name: ' Laranite ', ...flags } });
        respond('warehouse_catalog', { data: null }, { data: { id: 40 } });
        respond('warehouse_stock', { data: { id: 71 } });
        await createWarehouseStock({ source: 'platform', catalogId: 90, locationId: 4, qualityLabel: '' });
        const insertQ = queriesOf('warehouse_catalog')[1];
        expect(calls(insertQ, 'insert')).toEqual([[{ name: 'Laranite', category, quality_label: null, unit: 'SCU', description: null }]]);
        expect(selected(insertQ)).toBe('id');
        expect(calls(queriesOf('warehouse_stock')[0], 'insert')[0][0]).toMatchObject({ catalog_id: 40 });
        expect(fake.emits).toEqual([
            { event: 'warehouse:catalog_update', payload: { catalogId: 40 } },
            { event: 'warehouse:stock_update', payload: { stockId: 71 } },
        ]);
    });

    it('fails closed on every lookup/insert error and never creates the stock row', async () => {
        respond('warehouse_platform_commodities', { error: DB_ERR });
        await expect(createWarehouseStock({ source: 'platform', catalogId: 90, locationId: 4 })).rejects.toThrow('Failed to look up platform commodity');

        respond('warehouse_platform_commodities', { data: null });
        await expect(createWarehouseStock({ source: 'platform', catalogId: 90, locationId: 4 })).rejects.toThrow('Platform commodity not found.');

        respond('warehouse_platform_commodities', { data: { id: 90, name: '   ' } }, { data: { id: 90, name: null } });
        await expect(createWarehouseStock({ source: 'platform', catalogId: 90, locationId: 4 })).rejects.toThrow('Platform commodity has no name.');
        await expect(createWarehouseStock({ source: 'platform', catalogId: 90, locationId: 4 })).rejects.toThrow('Platform commodity has no name.');

        respond('warehouse_platform_commodities', { data: { id: 90, name: 'Laranite' } });
        respond('warehouse_catalog', { error: DB_ERR });
        await expect(createWarehouseStock({ source: 'platform', catalogId: 90, locationId: 4 })).rejects.toThrow('Failed to look up existing catalog row');

        respond('warehouse_platform_commodities', { data: { id: 90, name: 'Laranite' } });
        respond('warehouse_catalog', { data: null }, { error: DB_ERR });
        await expect(createWarehouseStock({ source: 'platform', catalogId: 90, locationId: 4 })).rejects.toThrow('Failed to materialise platform commodity into catalog');

        expect(queriesOf('warehouse_stock')).toEqual([]);
        expect(fake.emits).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('deleteWarehouseStock', () => {
    it('validates, checks reservations, then deletes requests -> movements -> stock, scoped to that id', async () => {
        respond('warehouse_stock', { data: { id: 5 } });
        respond('v_warehouse_stock_with_qty', { data: { quantity_reserved: 0 } });
        await deleteWarehouseStock(5);
        expect(trail()).toEqual([
            'warehouse_stock:select',
            'v_warehouse_stock_with_qty:select',
            'warehouse_requests:delete',
            'warehouse_movements:delete',
            'warehouse_stock:delete',
        ]);
        const [lookup, del] = queriesOf('warehouse_stock');
        expect(selected(lookup)).toBe('id');
        expect(calls(lookup, 'eq')).toEqual([['id', 5]]);
        const [qty] = queriesOf('v_warehouse_stock_with_qty');
        expect(selected(qty)).toBe('quantity_reserved');
        expect(calls(qty, 'eq')).toEqual([['id', 5]]);
        expect(calls(queriesOf('warehouse_requests')[0], 'eq')).toEqual([['stock_id', 5]]);
        expect(calls(queriesOf('warehouse_movements')[0], 'eq')).toEqual([['stock_id', 5]]);
        expect(calls(del, 'eq')).toEqual([['id', 5]]);
        expect(fake.emits).toEqual([
            { event: 'warehouse:stock_update', payload: { stockId: 5 } },
            { event: 'warehouse:request_update', payload: {} },
        ]);
    });

    it('a missing qty row reads as nothing reserved', async () => {
        respond('warehouse_stock', { data: { id: 5 } });
        respond('v_warehouse_stock_with_qty', { data: null });
        await deleteWarehouseStock(5);
        expect(trail()).toContain('warehouse_stock:delete');
    });

    it('refuses while anything is reserved, before deleting anything', async () => {
        respond('warehouse_stock', { data: { id: 5 } });
        respond('v_warehouse_stock_with_qty', { data: { quantity_reserved: '3' } });
        await expect(deleteWarehouseStock(5)).rejects.toThrow(
            'Cannot delete: 3 unit(s) are reserved by open withdrawals or marketplace contracts. Resolve those first.',
        );
        expect(trail()).toEqual(['warehouse_stock:select', 'v_warehouse_stock_with_qty:select']);
        expect(fake.emits).toEqual([]);
    });

    it('fails closed on lookup / not-found / reservation-read errors', async () => {
        respond('warehouse_stock', { error: DB_ERR }, { data: null }, { data: { id: 5 } });
        respond('v_warehouse_stock_with_qty', { error: DB_ERR });
        await expect(deleteWarehouseStock(5)).rejects.toThrow('Failed to validate stock row');
        await expect(deleteWarehouseStock(5)).rejects.toThrow('Stock row not found in this organization.');
        await expect(deleteWarehouseStock(5)).rejects.toThrow('Failed to read stock reservations');
        expect(trail().filter((t) => t.endsWith(':delete'))).toEqual([]);
    });

    it.each([
        ['warehouse_requests', 'Failed to delete withdrawal requests', 'warehouse_requests:delete'],
        ['warehouse_movements', 'Failed to delete movement ledger', 'warehouse_movements:delete'],
    ])('a failed %s delete stops the cascade', async (table, message, last) => {
        respond('warehouse_stock', { data: { id: 5 } });
        respond(table, { error: DB_ERR });
        await expect(deleteWarehouseStock(5)).rejects.toThrow(message);
        expect(trail().at(-1)).toBe(last);
        expect(fake.emits).toEqual([]);
    });

    it('a failed stock delete throws and broadcasts nothing', async () => {
        respond('warehouse_stock', { data: { id: 5 } }, { error: DB_ERR });
        await expect(deleteWarehouseStock(5)).rejects.toThrow('Failed to delete warehouse stock');
        expect(fake.emits).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('adjustWarehouseStock', () => {
    it.each([0, Number.NaN, Number.POSITIVE_INFINITY])('rejects delta %s before any query', async (delta) => {
        await expect(adjustWarehouseStock(5, delta, 'adjust', 42)).rejects.toThrow('Delta must be a non-zero integer.');
        expect(fake.queries).toEqual([]);
        expect(fake.rpcCalls).toEqual([]);
    });

    it.each(['withdraw_sale', 'transfer_in', 'bogus'])('rejects the non-adjustment reason %s', async (reason) => {
        await expect(adjustWarehouseStock(5, 1, reason as WarehouseMovementReason, 42)).rejects.toThrow(`Invalid adjustment reason: ${reason}`);
        expect(fake.queries).toEqual([]);
    });

    it.each(['initial', 'adjust', 'restock', 'loss', 'destruction'] as WarehouseMovementReason[])('accepts %s', async (reason) => {
        respond('warehouse_stock', { data: { id: 5 } });
        await adjustWarehouseStock(5, 1, reason, 42);
        expect(fake.rpcCalls[0].args.p_reason).toBe(reason);
    });

    it('existence-checks the row, truncates the delta, trims notes and broadcasts the stock id', async () => {
        respond('warehouse_stock', { data: { id: 5 } }, { data: { id: 5 } }, { data: { id: 5 } });
        respondRpc({ data: 'mv-1' }, { data: 'mv-2' }, { data: 'mv-3' });
        expect(await adjustWarehouseStock(5, 3.9, 'restock', 42, '  topped up  ')).toBe('mv-1');
        expect(await adjustWarehouseStock(5, -2.7, 'loss', 42, '   ')).toBe('mv-2');
        expect(await adjustWarehouseStock(5, 1, 'adjust', 42)).toBe('mv-3');
        expect(fake.rpcCalls).toEqual([
            { fn: 'warehouse_adjust_stock', args: { p_stock_id: 5, p_delta: 3, p_reason: 'restock', p_actor_id: 42, p_notes: 'topped up' } },
            { fn: 'warehouse_adjust_stock', args: { p_stock_id: 5, p_delta: -2, p_reason: 'loss', p_actor_id: 42, p_notes: null } },
            { fn: 'warehouse_adjust_stock', args: { p_stock_id: 5, p_delta: 1, p_reason: 'adjust', p_actor_id: 42, p_notes: null } },
        ]);
        const [lookup] = queriesOf('warehouse_stock');
        expect(selected(lookup)).toBe('id');
        expect(calls(lookup, 'eq')).toEqual([['id', 5]]);
        expect(lookup.terminal).toBe('maybeSingle');
        expect(fake.emits).toEqual(Array(3).fill({ event: 'warehouse:stock_update', payload: { stockId: 5 } }));
    });

    it('fails closed on lookup error / missing row (no RPC) and on RPC error (no broadcast)', async () => {
        respond('warehouse_stock', { error: DB_ERR }, { data: null });
        await expect(adjustWarehouseStock(5, 1, 'adjust', 42)).rejects.toThrow('Failed to validate stock row');
        await expect(adjustWarehouseStock(5, 1, 'adjust', 42)).rejects.toThrow('Stock row not found.');
        expect(fake.rpcCalls).toEqual([]);

        respond('warehouse_stock', { data: { id: 5 } });
        respondRpc({ error: DB_ERR });
        await expect(adjustWarehouseStock(5, 1, 'adjust', 42)).rejects.toThrow('Failed to adjust warehouse stock');
        expect(fake.emits).toEqual([]);
    });
});

describe('setWarehouseStockTotal', () => {
    it.each([-1, Number.NaN, 'abc'])('rejects target %s before any query', async (target) => {
        await expect(setWarehouseStockTotal(5, target as number, 'adjust', 42)).rejects.toThrow('Target total must be a non-negative integer.');
        expect(fake.queries).toEqual([]);
    });

    it('caps the target at MAX_STOCK_TOTAL (inclusive)', async () => {
        await expect(setWarehouseStockTotal(5, MAX_STOCK_TOTAL + 1, 'adjust', 42)).rejects.toThrow(`Target total must not exceed ${MAX_STOCK_TOTAL}.`);
        expect(fake.queries).toEqual([]);
        respond('warehouse_stock', { data: { id: 5 } });
        await setWarehouseStockTotal(5, MAX_STOCK_TOTAL, 'adjust', 42);
        expect(fake.rpcCalls[0].args.p_target_total).toBe(MAX_STOCK_TOTAL);
    });

    it("refuses 'initial' — a set-total is a correction, never the seeding movement", async () => {
        await expect(setWarehouseStockTotal(5, 3, 'initial', 42)).rejects.toThrow('Invalid adjustment reason: initial');
        expect(fake.queries).toEqual([]);
    });

    it('sends the truncated absolute target (never a delta) and maps a no-op to null', async () => {
        respond('warehouse_stock', { data: { id: 5 } }, { data: { id: 5 } });
        respondRpc({ data: 'mv-9' }, { data: null });
        expect(await setWarehouseStockTotal(5, 7.9, 'restock', 42, ' recount ')).toBe('mv-9');
        expect(await setWarehouseStockTotal(5, '12' as unknown as number, 'loss', 42)).toBeNull();
        expect(fake.rpcCalls).toEqual([
            { fn: 'warehouse_set_stock_total', args: { p_stock_id: 5, p_target_total: 7, p_reason: 'restock', p_actor_id: 42, p_notes: 'recount' } },
            { fn: 'warehouse_set_stock_total', args: { p_stock_id: 5, p_target_total: 12, p_reason: 'loss', p_actor_id: 42, p_notes: null } },
        ]);
        expect(fake.emits).toEqual(Array(2).fill({ event: 'warehouse:stock_update', payload: { stockId: 5 } }));
    });

    it('fails closed on lookup error / missing row / RPC error', async () => {
        respond('warehouse_stock', { error: DB_ERR }, { data: null }, { data: { id: 5 } });
        respondRpc({ error: DB_ERR });
        await expect(setWarehouseStockTotal(5, 1, 'adjust', 42)).rejects.toThrow('Failed to validate stock row');
        await expect(setWarehouseStockTotal(5, 1, 'adjust', 42)).rejects.toThrow('Stock row not found.');
        await expect(setWarehouseStockTotal(5, 1, 'adjust', 42)).rejects.toThrow('Failed to set warehouse stock total');
        expect(fake.rpcCalls).toHaveLength(1);
        expect(fake.emits).toEqual([]);
    });
});

describe('transferWarehouseStock', () => {
    it.each([0, -1, Number.NaN])('rejects quantity %s before any query', async (qty) => {
        await expect(transferWarehouseStock(1, 2, qty, 42)).rejects.toThrow('Quantity must be positive.');
        expect(fake.queries).toEqual([]);
    });

    it('validates BOTH endpoints in one read, then calls the proc with the truncated quantity', async () => {
        respond('warehouse_stock', { data: [{ id: 1 }, { id: 2 }] });
        respondRpc({ data: 'mv-t' });
        expect(await transferWarehouseStock(1, 2, 4.6, 42, ' move ')).toBe('mv-t');
        const [lookup] = queriesOf('warehouse_stock');
        expect(selected(lookup)).toBe('id');
        expect(calls(lookup, 'in')).toEqual([['id', [1, 2]]]);
        expect(fake.rpcCalls).toEqual([{
            fn: 'warehouse_transfer_stock',
            args: { p_from_stock_id: 1, p_to_stock_id: 2, p_quantity: 4, p_actor_id: 42, p_notes: 'move' },
        }]);
        expect(fake.emits).toEqual([{ event: 'warehouse:stock_update', payload: {} }]);
    });

    it('refuses when an endpoint is missing — including a self-transfer, which resolves to one row', async () => {
        respond('warehouse_stock', { data: [{ id: 1 }] }, { data: null }, { data: [{ id: 5 }] });
        await expect(transferWarehouseStock(1, 2, 1, 42)).rejects.toThrow('One or both stock rows not found.');
        await expect(transferWarehouseStock(1, 2, 1, 42)).rejects.toThrow('One or both stock rows not found.');
        await expect(transferWarehouseStock(5, 5, 1, 42)).rejects.toThrow('One or both stock rows not found.');
        expect(fake.rpcCalls).toEqual([]);
    });

    it('fails closed on lookup error and RPC error', async () => {
        respond('warehouse_stock', { error: DB_ERR }, { data: [{ id: 1 }, { id: 2 }] });
        respondRpc({ error: DB_ERR });
        await expect(transferWarehouseStock(1, 2, 1, 42)).rejects.toThrow('Failed to validate transfer endpoints');
        await expect(transferWarehouseStock(1, 2, 1, 42, null)).rejects.toThrow('Failed to transfer warehouse stock');
        expect(fake.emits).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('listWarehouseMovements — ledger with contract-party narrowing', () => {
    const contractRow = {
        id: 'mv-1', stock_id: 5, delta: -2, reason: 'withdraw_sale', actor_user_id: 10,
        related_request_id: 'req-9', related_movement_id: 'mv-0', related_contract_id: CONTRACT,
        notes: `Sale ${CONTRACT} for  ${CONTRACT} done`, created_at: 't1',
        actor: { id: 10, name: 'Seller', avatar_url: 'a.png' },
        stock: {
            id: 5, catalog_id: 3, location_id: 8,
            catalog: { id: 3, name: 'Gold', category: 'ore', quality_label: '', unit: 'SCU' },
            location: { id: 8, name: 'Lorville', type: 'station' },
        },
    };
    const plainRow = {
        id: 'mv-2', stock_id: 6, delta: 3, reason: 'restock', actor_user_id: 11,
        related_request_id: null, related_movement_id: null, related_contract_id: null,
        notes: null, created_at: 't2', actor: null, stock: { id: 6, catalog_id: 4, location_id: 9, catalog: null, location: null },
    };
    const onlyIdRow = { ...plainRow, id: 'mv-3', related_contract_id: CONTRACT, notes: ` ${CONTRACT} `, stock: null };

    it('selects explicit columns + embeds, and a PARTY sees the id and the untouched notes', async () => {
        respond('warehouse_movements', { data: [contractRow, plainRow] });
        filterContractIdsForParty.mockResolvedValueOnce(new Set([CONTRACT]));
        const rows = await listWarehouseMovements({}, 10);
        // Only the non-null contract ids are offered to the party predicate.
        expect(filterContractIdsForParty).toHaveBeenCalledWith([CONTRACT], 10);
        expect(rows).toEqual([
            {
                fromContract: true, relatedContractId: CONTRACT, id: 'mv-1', stockId: 5, delta: -2, reason: 'withdraw_sale', actorUserId: 10,
                actor: { id: 10, name: 'Seller', avatarUrl: 'a.png' },
                stock: {
                    id: 5, catalogId: 3,
                    catalog: { id: 3, name: 'Gold', category: 'ore', qualityLabel: null, unit: 'SCU' },
                    location: { id: 8, name: 'Lorville', type: 'station' },
                },
                relatedRequestId: 'req-9', relatedMovementId: 'mv-0',
                notes: `Sale ${CONTRACT} for  ${CONTRACT} done`, createdAt: 't1',
            },
            {
                fromContract: false, relatedContractId: null, id: 'mv-2', stockId: 6, delta: 3, reason: 'restock', actorUserId: 11,
                actor: undefined, stock: { id: 6, catalogId: 4, catalog: undefined, location: undefined },
                relatedRequestId: null, relatedMovementId: null, notes: null, createdAt: 't2',
            },
        ]);
        const [q] = queriesOf('warehouse_movements');
        expect(selected(q)).toBe(MOVEMENT_COLS);
        expect(calls(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(calls(q, 'range')).toEqual([[0, 199]]);
    });

    it('a NON-party gets the boolean only: every occurrence of the id is cut from the notes', async () => {
        respond('warehouse_movements', { data: [contractRow, onlyIdRow] });
        const rows = await listWarehouseMovements({}, 99);
        expect(rows[0]).toMatchObject({ fromContract: true, relatedContractId: null, notes: 'Sale for done' });
        // Notes that were nothing BUT the id collapse to null, not ''.
        expect(rows[1]).toMatchObject({ fromContract: true, relatedContractId: null, notes: null, stock: undefined });
        expect(JSON.stringify(rows)).not.toContain(CONTRACT);
    });

    it('with no viewer (marketplace module off) offers the predicate NO ids at all', async () => {
        respond('warehouse_movements', { data: [contractRow] });
        const rows = await listWarehouseMovements();
        expect(filterContractIdsForParty).toHaveBeenCalledWith([], undefined);
        expect(rows[0].relatedContractId).toBeNull();
        expect(JSON.stringify(rows)).not.toContain(CONTRACT);
    });

    it('a contract row with null notes stays null for a non-party', async () => {
        respond('warehouse_movements', { data: [{ ...plainRow, related_contract_id: CONTRACT, notes: null }] });
        const [row] = await listWarehouseMovements({}, 99);
        expect(row).toMatchObject({ fromContract: true, relatedContractId: null, notes: null });
    });

    it('applies every supplied filter (0 is a real id) and none when absent', async () => {
        await listWarehouseMovements({ stockId: 0, reason: 'loss', actorUserId: 0, sinceIso: '2026-01-01', untilIso: '2026-02-01' });
        await listWarehouseMovements({});
        const [filtered, bare] = queriesOf('warehouse_movements');
        expect(calls(filtered, 'eq')).toEqual([['stock_id', 0], ['reason', 'loss'], ['actor_user_id', 0]]);
        expect(calls(filtered, 'gte')).toEqual([['created_at', '2026-01-01']]);
        expect(calls(filtered, 'lte')).toEqual([['created_at', '2026-02-01']]);
        expect(calls(bare, 'eq')).toEqual([]);
        expect(calls(bare, 'gte')).toEqual([]);
        expect(calls(bare, 'lte')).toEqual([]);
    });

    it('clamps the page to 1..500 rows and the offset to the shared ceiling', async () => {
        await listWarehouseMovements({ limit: 0 });
        await listWarehouseMovements({ limit: 9999, offset: 5 });
        await listWarehouseMovements({ offset: -3 });
        expect(queriesOf('warehouse_movements').map((q) => calls(q, 'range')[0])).toEqual([[0, 0], [5, 504], [0, 199]]);
    });

    it('42P01 -> [] and an error fails closed — neither consults the party predicate', async () => {
        respond('warehouse_movements', { error: MISSING_TABLE }, { error: DB_ERR });
        expect(await listWarehouseMovements({}, 10)).toEqual([]);
        await expect(listWarehouseMovements({}, 10)).rejects.toThrow('Failed to load warehouse movements');
        expect(filterContractIdsForParty).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('createWithdrawalRequest — reservation bounded by AVAILABILITY', () => {
    const input = (over: Record<string, unknown> = {}) => ({ stockId: 5, requestedQuantity: 2, reasonCategory: 'craft' as WarehouseReasonCategory, ...over });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects quantity %s before any query', async (q) => {
        await expect(createWithdrawalRequest(42, input({ requestedQuantity: q }))).rejects.toThrow('Requested quantity must be positive.');
        expect(fake.queries).toEqual([]);
    });

    it('rejects an unknown reason category before any query', async () => {
        await expect(createWithdrawalRequest(42, input({ reasonCategory: 'steal' }))).rejects.toThrow('Invalid reason category: steal');
        expect(fake.queries).toEqual([]);
    });

    it('reads on-hand + reserved from the qty view and inserts the truncated quantity', async () => {
        respond('v_warehouse_stock_with_qty', { data: { id: 5, quantity_on_hand: 10, quantity_reserved: 8 } });
        respond('warehouse_requests', {
            data: requestRow({ requested_by: { id: 42, name: 'Req', avatar_url: null }, reason_notes: 'for armour' }),
        });
        // 2.9 truncates to 2 BEFORE the availability check (2 available), so it passes.
        const req = await createWithdrawalRequest(42, input({ requestedQuantity: 2.9, reasonNotes: '  for armour  ' }));
        const [qty] = queriesOf('v_warehouse_stock_with_qty');
        expect(selected(qty)).toBe('id, quantity_on_hand, quantity_reserved');
        expect(calls(qty, 'eq')).toEqual([['id', 5]]);
        expect(qty.terminal).toBe('maybeSingle');
        const [ins] = queriesOf('warehouse_requests');
        expect(calls(ins, 'insert')).toEqual([[{
            stock_id: 5, requested_by_user_id: 42, requested_quantity: 2, reason_category: 'craft', reason_notes: 'for armour',
        }]]);
        expect(selected(ins)).toBe(REQUEST_BASE_COLS);
        expect(ins.terminal).toBe('single');
        expect(req).toEqual({
            id: 'req-1', stockId: 5, stock: undefined, requestedByUserId: 42,
            requestedBy: { id: 42, name: 'Req', avatarUrl: null },
            requestedQuantity: 2, reasonCategory: 'craft', reasonNotes: 'for armour', status: 'pending',
            approvedByUserId: null, approvedAt: null, fulfilledMovementId: null, fulfilledAt: null, denialReason: null,
            createdAt: 'c', updatedAt: 'u',
        });
        expect(fake.emits).toEqual([
            { event: 'warehouse:request_update', payload: { requestId: 'req-1' } },
            { event: 'warehouse:stock_update', payload: {} },
        ]);
    });

    it('blank notes insert null; a returned stock embed is narrowed field-by-field', async () => {
        respond('v_warehouse_stock_with_qty', { data: { id: 5, quantity_on_hand: 5, quantity_reserved: 0 } });
        respond('warehouse_requests', {
            data: requestRow({
                stock: {
                    id: 5, catalog_id: 3, location_id: 8, quantity_on_hand: 5, notes: 'internal',
                    catalog: { id: 3, name: 'Gold', category: 'ore', quality_label: '', unit: 'SCU', description: 'not shipped' },
                    location: { id: 8, name: 'Lorville', type: 'station' },
                },
            }),
        });
        const req = await createWithdrawalRequest(42, input({ reasonNotes: '   ' }));
        expect(calls(queriesOf('warehouse_requests')[0], 'insert')[0][0]).toMatchObject({ reason_notes: null });
        expect(req.stock).toEqual({
            id: 5, catalogId: 3,
            catalog: { id: 3, name: 'Gold', category: 'ore', qualityLabel: null, unit: 'SCU' },
            location: { id: 8, name: 'Lorville', type: 'station' },
            quantityOnHand: 5,
        });
    });

    it('over on-hand with nothing reserved: plain wording, no insert', async () => {
        respond('v_warehouse_stock_with_qty', { data: { id: 5, quantity_on_hand: 10, quantity_reserved: null } });
        await expect(createWithdrawalRequest(42, input({ requestedQuantity: 11 }))).rejects.toThrow('Cannot reserve 11 unit(s): only 10 on hand.');
        expect(queriesOf('warehouse_requests')).toEqual([]);
    });

    it('over availability because of existing reservations: breakdown wording, no insert', async () => {
        respond('v_warehouse_stock_with_qty', { data: { id: 5, quantity_on_hand: '10', quantity_reserved: '4' } });
        await expect(createWithdrawalRequest(42, input({ requestedQuantity: 7 }))).rejects.toThrow(
            'Cannot reserve 7 unit(s): only 6 available (10 on hand, 4 already reserved).',
        );
        expect(queriesOf('warehouse_requests')).toEqual([]);
        expect(fake.emits).toEqual([]);
    });

    it('a non-numeric on-hand reads as 0 — fails closed, never as unlimited', async () => {
        respond('v_warehouse_stock_with_qty', { data: { id: 5, quantity_on_hand: null, quantity_reserved: undefined } });
        await expect(createWithdrawalRequest(42, input({ requestedQuantity: 1 }))).rejects.toThrow('Cannot reserve 1 unit(s): only 0 on hand.');
    });

    it('fails closed on a stock read error / missing stock / insert error / empty insert', async () => {
        respond('v_warehouse_stock_with_qty', { error: DB_ERR }, { data: null });
        await expect(createWithdrawalRequest(42, input())).rejects.toThrow('Failed to validate stock row');
        await expect(createWithdrawalRequest(42, input())).rejects.toThrow('Stock row not found.');
        expect(queriesOf('warehouse_requests')).toEqual([]);

        respond('v_warehouse_stock_with_qty', { data: { id: 5, quantity_on_hand: 9, quantity_reserved: 0 } }, { data: { id: 5, quantity_on_hand: 9, quantity_reserved: 0 } });
        respond('warehouse_requests', { error: DB_ERR }, { data: null });
        await expect(createWithdrawalRequest(42, input())).rejects.toThrow('Failed to submit withdrawal request');
        await expect(createWithdrawalRequest(42, input())).rejects.toThrow('Failed to submit withdrawal request');
        expect(fake.emits).toEqual([]);
    });
});

describe('listWithdrawalRequests', () => {
    it('selects explicit columns + embeds, newest first, default cap 200', async () => {
        await listWithdrawalRequests();
        const [q] = queriesOf('warehouse_requests');
        expect(selected(q)).toBe(REQUEST_LIST_COLS);
        expect(calls(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(calls(q, 'limit')).toEqual([[200]]);
        expect(calls(q, 'eq')).toEqual([]);
        expect(calls(q, 'in')).toEqual([]);
        // No rows -> no qty hydration query.
        expect(queriesOf('v_warehouse_stock_with_qty')).toEqual([]);
    });

    it("'open' means pending OR approved; any other status is an exact match; owner/stock filters apply", async () => {
        await listWithdrawalRequests({ status: 'open', requesterUserId: 0, stockId: 5 });
        await listWithdrawalRequests({ status: 'denied' });
        const [open, denied] = queriesOf('warehouse_requests');
        expect(calls(open, 'in')).toEqual([['status', ['pending', 'approved']]]);
        expect(calls(open, 'eq')).toEqual([['requested_by_user_id', 0], ['stock_id', 5]]);
        expect(calls(denied, 'eq')).toEqual([['status', 'denied']]);
    });

    it('clamps the cap to 1..500', async () => {
        await listWithdrawalRequests({ limit: 0 });
        await listWithdrawalRequests({ limit: 999 });
        expect(queriesOf('warehouse_requests').map((q) => calls(q, 'limit')[0])).toEqual([[1], [500]]);
    });

    it('42P01 -> [], any other error fails closed', async () => {
        respond('warehouse_requests', { error: MISSING_TABLE }, { error: DB_ERR });
        expect(await listWithdrawalRequests()).toEqual([]);
        await expect(listWithdrawalRequests()).rejects.toThrow('Failed to load withdrawal requests');
    });

    it('hydrates on-hand for each DISTINCT stock in one read; rows without a stock embed are left alone', async () => {
        const stockEmbed = (id: number) => ({
            id, catalog_id: 3, location_id: 8,
            catalog: { id: 3, name: 'Gold', category: 'ore', quality_label: 'A', unit: 'SCU' },
            location: { id: 8, name: 'Lorville', type: 'station' },
        });
        respond('warehouse_requests', {
            data: [
                requestRow({ id: 'r1', stock_id: 5, stock: stockEmbed(5), requested_by: { id: 42, name: 'Req', avatar_url: 'x' } }),
                requestRow({ id: 'r2', stock_id: 5, stock: { ...stockEmbed(5), catalog: null, location: null } }),
                requestRow({ id: 'r3', stock_id: 6, stock: null }),
                requestRow({ id: 'r4', stock_id: 7, stock: stockEmbed(7), reason_notes: 'n', approved_by_user_id: 1, approved_at: 'a', fulfilled_movement_id: 'mv', fulfilled_at: 'f', denial_reason: 'd' }),
            ],
        });
        respond('v_warehouse_stock_with_qty', { data: [{ id: 5, quantity_on_hand: '12' }, { id: 7, quantity_on_hand: 'n/a' }] });
        const rows = await listWithdrawalRequests();
        const [qty] = queriesOf('v_warehouse_stock_with_qty');
        expect(selected(qty)).toBe('id, quantity_on_hand');
        expect(calls(qty, 'in')).toEqual([['id', [5, 6, 7]]]);
        expect(rows[0].stock).toEqual({
            id: 5, catalogId: 3,
            catalog: { id: 3, name: 'Gold', category: 'ore', qualityLabel: 'A', unit: 'SCU' },
            location: { id: 8, name: 'Lorville', type: 'station' },
            quantityOnHand: 12,
        });
        expect(rows[0].requestedBy).toEqual({ id: 42, name: 'Req', avatarUrl: 'x' });
        expect(rows[1].stock).toMatchObject({ catalog: undefined, location: undefined, quantityOnHand: 12 });
        expect(rows[2].stock).toBeUndefined();
        // A non-numeric quantity shows 0, never NaN.
        expect(rows[3].stock?.quantityOnHand).toBe(0);
        expect(rows[3]).toMatchObject({
            reasonNotes: 'n', approvedByUserId: 1, approvedAt: 'a', fulfilledMovementId: 'mv', fulfilledAt: 'f', denialReason: 'd',
        });
    });

    it('a failed qty hydration degrades to 0 on-hand rather than failing the list', async () => {
        respond('warehouse_requests', { data: [requestRow({ stock: { id: 5, catalog_id: 3, location_id: 8 } })] });
        respond('v_warehouse_stock_with_qty', { error: DB_ERR });
        const [row] = await listWithdrawalRequests();
        expect(row.stock?.quantityOnHand).toBe(0);
    });
});

describe('withdrawal request state machine', () => {
    it('approve: pending -> approved only, stamped with the approver', async () => {
        await approveWithdrawalRequest('req-1', 7);
        const [q] = queriesOf('warehouse_requests');
        expect(calls(q, 'update')).toEqual([[{ status: 'approved', approved_by_user_id: 7, approved_at: NOW, updated_at: NOW }]]);
        expect(calls(q, 'eq')).toEqual([['id', 'req-1'], ['status', 'pending']]);
        expect(fake.emits).toEqual([{ event: 'warehouse:request_update', payload: { requestId: 'req-1' } }]);
    });

    it('deny: pending/approved -> denied with a trimmed reason, and releases the reservation', async () => {
        await denyWithdrawalRequest('req-1', 7, '  no stock  ');
        await denyWithdrawalRequest('req-2', 7, '   ');
        await denyWithdrawalRequest('req-3', 7);
        const qs = queriesOf('warehouse_requests');
        expect(calls(qs[0], 'update')).toEqual([[{ status: 'denied', approved_by_user_id: 7, approved_at: NOW, denial_reason: 'no stock', updated_at: NOW }]]);
        expect((calls(qs[1], 'update')[0][0] as Record<string, unknown>).denial_reason).toBeNull();
        expect((calls(qs[2], 'update')[0][0] as Record<string, unknown>).denial_reason).toBeNull();
        expect(calls(qs[0], 'eq')).toEqual([['id', 'req-1']]);
        expect(calls(qs[0], 'in')).toEqual([['status', ['pending', 'approved']]]);
        expect(fake.emits.slice(0, 2)).toEqual([
            { event: 'warehouse:request_update', payload: { requestId: 'req-1' } },
            { event: 'warehouse:stock_update', payload: {} },
        ]);
    });

    it('cancel: scoped to the REQUESTER and to open states', async () => {
        await cancelWithdrawalRequest('req-1', 42);
        const [q] = queriesOf('warehouse_requests');
        expect(calls(q, 'update')).toEqual([[{ status: 'cancelled', updated_at: NOW }]]);
        expect(calls(q, 'eq')).toEqual([['id', 'req-1'], ['requested_by_user_id', 42]]);
        expect(calls(q, 'in')).toEqual([['status', ['pending', 'approved']]]);
        expect(fake.emits).toEqual([
            { event: 'warehouse:request_update', payload: { requestId: 'req-1' } },
            { event: 'warehouse:stock_update', payload: {} },
        ]);
    });

    it.each([
        ['approve', () => approveWithdrawalRequest('req-1', 7), 'Failed to approve withdrawal request'],
        ['deny', () => denyWithdrawalRequest('req-1', 7, 'x'), 'Failed to deny withdrawal request'],
        ['cancel', () => cancelWithdrawalRequest('req-1', 42), 'Failed to cancel withdrawal request'],
    ])('%s: a write error throws and broadcasts nothing', async (_name, run, message) => {
        respond('warehouse_requests', { error: DB_ERR });
        await expect(run()).rejects.toThrow(message);
        expect(fake.emits).toEqual([]);
    });

    it('fulfil: existence-checks the request, then runs the proc and emits both slices', async () => {
        respond('warehouse_requests', { data: { id: 'req-1' } });
        respondRpc({ data: 'mv-f' });
        expect(await fulfilWithdrawalRequest('req-1', 7)).toBe('mv-f');
        const [lookup] = queriesOf('warehouse_requests');
        expect(selected(lookup)).toBe('id');
        expect(calls(lookup, 'eq')).toEqual([['id', 'req-1']]);
        expect(lookup.terminal).toBe('maybeSingle');
        expect(fake.rpcCalls).toEqual([{ fn: 'warehouse_fulfil_request', args: { p_request_id: 'req-1', p_actor_id: 7 } }]);
        expect(fake.emits).toEqual([
            { event: 'warehouse:request_update', payload: { requestId: 'req-1' } },
            { event: 'warehouse:stock_update', payload: {} },
        ]);
    });

    it('fulfil: fails closed on lookup error / unknown request (no RPC) and on RPC error (no broadcast)', async () => {
        respond('warehouse_requests', { error: DB_ERR }, { data: null }, { data: { id: 'req-1' } });
        respondRpc({ error: DB_ERR });
        await expect(fulfilWithdrawalRequest('req-1', 7)).rejects.toThrow('Failed to validate request');
        await expect(fulfilWithdrawalRequest('req-1', 7)).rejects.toThrow('Request not found in this organization.');
        await expect(fulfilWithdrawalRequest('req-1', 7)).rejects.toThrow('Failed to fulfil withdrawal request');
        expect(fake.rpcCalls).toHaveLength(1);
        expect(fake.emits).toEqual([]);
    });
});
