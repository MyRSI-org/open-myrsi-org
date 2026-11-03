import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/warehouse.ts — the org commodity CATALOG: list/count/search, CRUD with the
// write-time CR/LF collapse (an export row break is a formula-injection vector), the
// bottom-up delete cascade, the paginated JSON export, and the import preview +
// batched bulk upsert. Every query is recorded, so these pin the exact table,
// explicit column list, filters, write payload and order — not just "it ran".

vi.mock('../lib/db/common', async () => (await import('./cov-db-warehouse-fake')).commonMock);
vi.mock('../lib/log', async () => (await import('./cov-db-warehouse-fake')).logMock);
vi.mock('../lib/db/marketplace', async () => (await import('./cov-db-warehouse-fake')).marketplaceMock);
vi.mock('../lib/db/uex', async () => (await import('./cov-db-warehouse-fake')).uexMock);

import {
    fake, resetFake, respond, queriesOf, calls, chain, selected, trail,
} from './cov-db-warehouse-fake';
import {
    listWarehouseCatalog,
    listWarehouseCatalogCount,
    searchWarehouseCatalog,
    createWarehouseCatalogItem,
    updateWarehouseCatalogItem,
    archiveWarehouseCatalogItem,
    deleteWarehouseCatalogItem,
    exportWarehouseCatalog,
    previewWarehouseCatalogImport,
    bulkUpsertWarehouseCatalog,
    MAX_WAREHOUSE_IMPORT_BATCH_SIZE,
} from '../lib/db/warehouse';
import type { WarehouseCatalogCategory } from '../types';

const NOW = '2026-01-02T03:04:05.000Z';
const CAT_COLS = 'id, name, category, quality_label, unit, description, archived_at, created_at, updated_at';
const DB_ERR = { code: 'XX000', message: 'relation detail that must not reach the client' };
const MISSING_TABLE = { code: '42P01', message: 'relation does not exist' };

function catRow(over: Record<string, unknown> = {}) {
    return {
        id: 1, name: 'Gold', category: 'ore', quality_label: 'A', unit: 'SCU',
        description: 'shiny', archived_at: null, created_at: 'c1', updated_at: 'u1', ...over,
    };
}

beforeEach(() => {
    resetFake();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------
describe('listWarehouseCatalog', () => {
    it('selects the explicit catalog columns, orders deterministically and maps every field', async () => {
        respond('warehouse_catalog', {
            data: [
                catRow(),
                catRow({ id: 2, name: 'Iron', quality_label: '', description: '', archived_at: '2025-12-01' }),
            ],
        });
        const rows = await listWarehouseCatalog();
        expect(rows).toEqual([
            { id: 1, name: 'Gold', category: 'ore', qualityLabel: 'A', unit: 'SCU', description: 'shiny', archivedAt: null, createdAt: 'c1', updatedAt: 'u1' },
            // Empty strings normalise to null rather than leaking '' into the UI.
            { id: 2, name: 'Iron', category: 'ore', qualityLabel: null, unit: 'SCU', description: null, archivedAt: '2025-12-01', createdAt: 'c1', updatedAt: 'u1' },
        ]);
        const [q] = queriesOf('warehouse_catalog');
        expect(selected(q)).toBe(CAT_COLS);
        expect(calls(q, 'order')).toEqual([
            ['category', { ascending: true }],
            ['name', { ascending: true }],
            ['id', { ascending: true }],
        ]);
        expect(calls(q, 'range')).toEqual([[0, 999]]);
    });

    it('clamps limit to 1..1000 and offset to the shared list-offset ceiling', async () => {
        await listWarehouseCatalog({ limit: 0, offset: -5 });
        await listWarehouseCatalog({ limit: 5000, offset: 20 });
        await listWarehouseCatalog({ limit: 10, offset: 10.7 });
        await listWarehouseCatalog({ limit: 10, offset: 10_000_000 });
        expect(queriesOf('warehouse_catalog').map((q) => calls(q, 'range')[0])).toEqual([
            [0, 0],
            [20, 1019],
            [10, 19],
            [100_000, 100_009],
        ]);
    });

    it('treats a missing table (42P01) as an empty catalog', async () => {
        respond('warehouse_catalog', { data: null, error: MISSING_TABLE });
        expect(await listWarehouseCatalog()).toEqual([]);
    });

    it('fails closed on any other read error with the generic message', async () => {
        respond('warehouse_catalog', { data: [catRow()], error: DB_ERR });
        await expect(listWarehouseCatalog()).rejects.toThrow('Failed to load warehouse catalog');
    });

    it('returns [] when the read yields no data', async () => {
        respond('warehouse_catalog', { data: null });
        expect(await listWarehouseCatalog()).toEqual([]);
    });
});

describe('listWarehouseCatalogCount', () => {
    it('issues a head-only exact count on the id column', async () => {
        respond('warehouse_catalog', { count: 42 });
        expect(await listWarehouseCatalogCount()).toBe(42);
        const [q] = queriesOf('warehouse_catalog');
        expect(calls(q, 'select')).toEqual([['id', { count: 'exact', head: true }]]);
    });

    it('a null count reads as 0, a missing table as 0, any other error throws', async () => {
        respond('warehouse_catalog', { count: null }, { error: MISSING_TABLE }, { error: DB_ERR });
        expect(await listWarehouseCatalogCount()).toBe(0);
        expect(await listWarehouseCatalogCount()).toBe(0);
        await expect(listWarehouseCatalogCount()).rejects.toThrow('Failed to count warehouse catalog');
    });
});

// ---------------------------------------------------------------------------
describe('searchWarehouseCatalog', () => {
    it('a blank query returns [] without touching the database', async () => {
        expect(await searchWarehouseCatalog({ query: '   ' })).toEqual([]);
        expect(await searchWarehouseCatalog({ query: undefined as unknown as string })).toEqual([]);
        expect(fake.queries).toEqual([]);
    });

    it("escapes every LIKE metacharacter, including PostgREST's * alias, before the ILIKE", async () => {
        await searchWarehouseCatalog({ query: ' 50%_off*\\ ', source: 'custom' });
        const [q] = queriesOf('warehouse_catalog');
        expect(calls(q, 'ilike')).toEqual([['name', '%50\\%\\_off\\*\\\\%']]);
    });

    it("source 'custom' reads only the tenant catalog, with explicit columns, and maps archived to a boolean", async () => {
        respond('warehouse_catalog', {
            data: [
                { id: 3, name: 'Quantanium', category: 'ore', quality_label: 'B', unit: 'SCU', archived_at: '2025-01-01' },
                { id: 4, name: 'Agricium', category: null, quality_label: null, unit: null, archived_at: null },
            ],
        });
        const out = await searchWarehouseCatalog({ query: 'ium', source: 'custom' });
        expect(out).toEqual([
            { id: 4, source: 'custom', name: 'Agricium', category: null, qualityLabel: null, unit: null, archived: false },
            { id: 3, source: 'custom', name: 'Quantanium', category: 'ore', qualityLabel: 'B', unit: 'SCU', archived: true },
        ]);
        expect(trail()).toEqual(['warehouse_catalog:select']);
        const [q] = queriesOf('warehouse_catalog');
        expect(selected(q)).toBe('id, name, category, quality_label, unit, archived_at');
        expect(calls(q, 'order')).toEqual([['name', { ascending: true }], ['id', { ascending: true }]]);
        expect(calls(q, 'limit')).toEqual([[50]]);
    });

    it("source 'platform' reads only the shared commodities and never claims a quality, unit or archive state", async () => {
        respond('warehouse_platform_commodities', {
            data: [{ id: 9, name: 'Laranite', kind: 'Mineral' }, { id: 10, name: 'Hadanite', kind: null }],
        });
        const out = await searchWarehouseCatalog({ query: 'ite', source: 'platform' });
        expect(out).toEqual([
            { id: 10, source: 'platform', name: 'Hadanite', category: null, qualityLabel: null, unit: null, archived: false },
            { id: 9, source: 'platform', name: 'Laranite', category: 'Mineral', qualityLabel: null, unit: null, archived: false },
        ]);
        expect(trail()).toEqual(['warehouse_platform_commodities:select']);
        expect(selected(queriesOf('warehouse_platform_commodities')[0])).toBe('id, name, kind');
    });

    it('merges both sources custom-first and applies the cap to the combined list', async () => {
        respond('warehouse_catalog', { data: [{ id: 2, name: 'Zinc', archived_at: null }, { id: 1, name: 'Aluminum', archived_at: null }] });
        respond('warehouse_platform_commodities', { data: [{ id: 7, name: 'Beryl', kind: 'Ore' }, { id: 8, name: 'Agricium', kind: 'Ore' }] });
        const out = await searchWarehouseCatalog({ query: 'a', limit: 3 });
        expect(out.map((r) => `${r.source}:${r.name}`)).toEqual(['custom:Aluminum', 'custom:Zinc', 'platform:Agricium']);
        // Each source is individually capped too.
        expect(calls(queriesOf('warehouse_catalog')[0], 'limit')).toEqual([[3]]);
        expect(calls(queriesOf('warehouse_platform_commodities')[0], 'limit')).toEqual([[3]]);
    });

    it('custom rows precede platform rows even when every platform name sorts first', async () => {
        // Enough rows to push the engine's sort past pure insertion into a merge pass.
        const names = Array.from({ length: 30 }, (_, i) => String.fromCharCode(65 + (i % 26)) + i);
        respond('warehouse_catalog', { data: names.map((n, i) => ({ id: i + 1, name: `z-${n}`, archived_at: null })) });
        respond('warehouse_platform_commodities', { data: names.map((n, i) => ({ id: 100 + i, name: `a-${n}`, kind: null })).reverse() });
        const out = await searchWarehouseCatalog({ query: 'x', limit: 200 });
        expect(out).toHaveLength(60);
        const firstPlatform = out.findIndex((r) => r.source === 'platform');
        expect(firstPlatform).toBe(30);
        expect(out.slice(firstPlatform).every((r) => r.source === 'platform')).toBe(true);
        const custom = out.slice(0, 30).map((r) => r.name);
        const platform = out.slice(30).map((r) => r.name);
        expect(custom).toEqual([...custom].sort((a, b) => a.localeCompare(b)));
        expect(platform).toEqual([...platform].sort((a, b) => a.localeCompare(b)));
    });

    it('clamps the cap to 1..200', async () => {
        await searchWarehouseCatalog({ query: 'x', source: 'custom', limit: 0 });
        await searchWarehouseCatalog({ query: 'x', source: 'custom', limit: 999 });
        expect(queriesOf('warehouse_catalog').map((q) => calls(q, 'limit')[0])).toEqual([[1], [200]]);
    });

    it('a missing table on either side is skipped, not fatal', async () => {
        respond('warehouse_catalog', { data: null, error: MISSING_TABLE });
        respond('warehouse_platform_commodities', { data: [{ id: 7, name: 'Beryl', kind: 'Ore' }] });
        expect((await searchWarehouseCatalog({ query: 'b' })).map((r) => r.id)).toEqual([7]);

        respond('warehouse_catalog', { data: [{ id: 1, name: 'Bexalite', archived_at: null }] });
        respond('warehouse_platform_commodities', { data: null, error: MISSING_TABLE });
        expect((await searchWarehouseCatalog({ query: 'b' })).map((r) => r.id)).toEqual([1]);
    });

    it('any other error on either side fails closed with that side\'s generic message', async () => {
        respond('warehouse_catalog', { error: DB_ERR });
        await expect(searchWarehouseCatalog({ query: 'b' })).rejects.toThrow('Failed to search warehouse custom catalog');

        respond('warehouse_platform_commodities', { error: DB_ERR });
        await expect(searchWarehouseCatalog({ query: 'b', source: 'platform' })).rejects.toThrow('Failed to search warehouse platform catalog');
    });
});

// ---------------------------------------------------------------------------
describe('createWarehouseCatalogItem', () => {
    it('collapses CR/LF in single-line fields at write time and broadcasts only the new id', async () => {
        respond('warehouse_catalog', { data: catRow({ id: 9, name: 'Gold =HYPERLINK("x")', quality_label: 'A B' }) });
        const item = await createWarehouseCatalogItem({
            name: 'Gold\r\n=HYPERLINK("x")',
            category: 'ore',
            qualityLabel: ' A\nB ',
            unit: 'SCU\r',
            description: '  multi\nline  ',
        });
        const [q] = queriesOf('warehouse_catalog');
        expect(calls(q, 'insert')).toEqual([[{
            name: 'Gold =HYPERLINK("x")',
            category: 'ore',
            quality_label: 'A B',
            unit: 'SCU',
            // description is a multi-line field: trimmed, newlines kept.
            description: 'multi\nline',
        }]]);
        expect(selected(q)).toBe(CAT_COLS);
        expect(q.terminal).toBe('single');
        expect(fake.emits).toEqual([{ event: 'warehouse:catalog_update', payload: { catalogId: 9 } }]);
        expect(item).toMatchObject({ id: 9, name: 'Gold =HYPERLINK("x")', qualityLabel: 'A B' });
    });

    it('defaults: no quality -> null, no/blank unit -> "units", blank description -> null', async () => {
        respond('warehouse_catalog', { data: catRow() }, { data: catRow() });
        await createWarehouseCatalogItem({ name: 'Iron', category: 'refined' });
        await createWarehouseCatalogItem({ name: 'Iron', category: 'refined', qualityLabel: '\n', unit: '\r\n', description: '   ' });
        const inserts = queriesOf('warehouse_catalog').map((q) => calls(q, 'insert')[0][0]);
        const expected = { name: 'Iron', category: 'refined', quality_label: null, unit: 'units', description: null };
        expect(inserts).toEqual([expected, expected]);
    });

    it('refuses a name that is blank after the collapse, before any write', async () => {
        await expect(createWarehouseCatalogItem({ name: ' \r\n ', category: 'ore' })).rejects.toThrow('Commodity name is required.');
        await expect(createWarehouseCatalogItem({ name: undefined as unknown as string, category: 'ore' })).rejects.toThrow('Commodity name is required.');
        expect(fake.queries).toEqual([]);
        expect(fake.emits).toEqual([]);
    });

    it('a write error or an empty result throws and broadcasts nothing', async () => {
        respond('warehouse_catalog', { error: DB_ERR }, { data: null });
        await expect(createWarehouseCatalogItem({ name: 'X', category: 'ore' })).rejects.toThrow('Failed to create warehouse catalog item');
        await expect(createWarehouseCatalogItem({ name: 'X', category: 'ore' })).rejects.toThrow('Failed to create warehouse catalog item');
        expect(fake.emits).toEqual([]);
    });
});

describe('updateWarehouseCatalogItem', () => {
    it('patches ONLY the supplied fields (plus updated_at), scoped by id', async () => {
        respond('warehouse_catalog', { data: catRow({ id: 4, name: 'X Y' }) });
        const item = await updateWarehouseCatalogItem({ id: 4, name: 'X\nY' });
        const [q] = queriesOf('warehouse_catalog');
        expect(calls(q, 'update')).toEqual([[{ updated_at: NOW, name: 'X Y' }]]);
        expect(calls(q, 'eq')).toEqual([['id', 4]]);
        expect(selected(q)).toBe(CAT_COLS);
        expect(q.terminal).toBe('single');
        expect(item.name).toBe('X Y');
        expect(fake.emits).toEqual([{ event: 'warehouse:catalog_update', payload: { catalogId: 4 } }]);
    });

    it('normalises every editable field the same way create does', async () => {
        respond('warehouse_catalog', { data: catRow() }, { data: catRow() }, { data: catRow() });
        await updateWarehouseCatalogItem({ id: 5, category: 'fuel', qualityLabel: '', unit: '', description: '  ' });
        await updateWarehouseCatalogItem({ id: 5, qualityLabel: 'Q\r\n1', unit: 'kg\n', description: null });
        // A unit that is nothing but a line break collapses to '' and falls back too.
        await updateWarehouseCatalogItem({ id: 5, unit: '\r\n' });
        expect(queriesOf('warehouse_catalog').map((q) => calls(q, 'update')[0][0])).toEqual([
            { updated_at: NOW, category: 'fuel', quality_label: null, unit: 'units', description: null },
            { updated_at: NOW, quality_label: 'Q 1', unit: 'kg', description: null },
            { updated_at: NOW, unit: 'units' },
        ]);
    });

    it('a write error or a missing row throws and broadcasts nothing', async () => {
        respond('warehouse_catalog', { error: DB_ERR }, { data: null });
        await expect(updateWarehouseCatalogItem({ id: 5, name: 'Z' })).rejects.toThrow('Failed to update warehouse catalog item');
        await expect(updateWarehouseCatalogItem({ id: 5, name: 'Z' })).rejects.toThrow('Failed to update warehouse catalog item');
        expect(fake.emits).toEqual([]);
    });
});

describe('archiveWarehouseCatalogItem', () => {
    it('archives by default and un-archives with archive=false, scoped by id', async () => {
        await archiveWarehouseCatalogItem(3);
        await archiveWarehouseCatalogItem(3, false);
        const qs = queriesOf('warehouse_catalog');
        expect(calls(qs[0], 'update')).toEqual([[{ archived_at: NOW, updated_at: NOW }]]);
        expect(calls(qs[1], 'update')).toEqual([[{ archived_at: null, updated_at: NOW }]]);
        expect(qs.map((q) => calls(q, 'eq'))).toEqual([[['id', 3]], [['id', 3]]]);
        expect(fake.emits).toEqual([
            { event: 'warehouse:catalog_update', payload: { catalogId: 3 } },
            { event: 'warehouse:catalog_update', payload: { catalogId: 3 } },
        ]);
    });

    it('a write error throws and broadcasts nothing', async () => {
        respond('warehouse_catalog', { error: DB_ERR });
        await expect(archiveWarehouseCatalogItem(3)).rejects.toThrow('Failed to archive warehouse catalog item');
        expect(fake.emits).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('deleteWarehouseCatalogItem — bottom-up cascade', () => {
    it('with no stock rows: deletes only the catalog row and emits only the catalog event', async () => {
        respond('warehouse_stock', { data: [] });
        await deleteWarehouseCatalogItem(7);
        expect(trail()).toEqual(['warehouse_stock:select', 'warehouse_catalog:delete']);
        const [stockQ] = queriesOf('warehouse_stock');
        expect(selected(stockQ)).toBe('id');
        expect(calls(stockQ, 'eq')).toEqual([['catalog_id', 7]]);
        expect(calls(queriesOf('warehouse_catalog')[0], 'eq')).toEqual([['id', 7]]);
        expect(fake.emits).toEqual([{ event: 'warehouse:catalog_update', payload: { catalogId: 7 } }]);
    });

    it('with stock: requests -> movements -> stock -> catalog, each scoped to exactly those stock ids', async () => {
        respond('warehouse_stock', { data: [{ id: 11 }, { id: 12 }] });
        await deleteWarehouseCatalogItem(7);
        expect(trail()).toEqual([
            'warehouse_stock:select',
            'warehouse_requests:delete',
            'warehouse_movements:delete',
            'warehouse_stock:delete',
            'warehouse_catalog:delete',
        ]);
        expect(calls(queriesOf('warehouse_requests')[0], 'in')).toEqual([['stock_id', [11, 12]]]);
        expect(calls(queriesOf('warehouse_movements')[0], 'in')).toEqual([['stock_id', [11, 12]]]);
        expect(calls(queriesOf('warehouse_stock')[1], 'in')).toEqual([['id', [11, 12]]]);
        // Ids only — the slice events carry no content.
        expect(fake.emits).toEqual([
            { event: 'warehouse:catalog_update', payload: { catalogId: 7 } },
            { event: 'warehouse:stock_update', payload: {} },
            { event: 'warehouse:request_update', payload: {} },
        ]);
    });

    it('a failed stock lookup aborts before any delete', async () => {
        respond('warehouse_stock', { error: DB_ERR });
        await expect(deleteWarehouseCatalogItem(7)).rejects.toThrow('Failed to load commodity stock');
        expect(trail()).toEqual(['warehouse_stock:select']);
        expect(fake.emits).toEqual([]);
    });

    it.each([
        ['warehouse_requests', 'Failed to delete commodity withdrawal requests', ['warehouse_stock:select', 'warehouse_requests:delete']],
        ['warehouse_movements', 'Failed to delete commodity movements', ['warehouse_stock:select', 'warehouse_requests:delete', 'warehouse_movements:delete']],
    ])('a failed %s delete stops the cascade there', async (table, message, expectedTrail) => {
        respond('warehouse_stock', { data: [{ id: 11 }] });
        respond(table, { error: DB_ERR });
        await expect(deleteWarehouseCatalogItem(7)).rejects.toThrow(message);
        expect(trail()).toEqual(expectedTrail);
        expect(fake.emits).toEqual([]);
    });

    it('a failed stock delete stops before the catalog delete', async () => {
        respond('warehouse_stock', { data: [{ id: 11 }] }, { error: DB_ERR });
        await expect(deleteWarehouseCatalogItem(7)).rejects.toThrow('Failed to delete commodity stock');
        expect(trail()).not.toContain('warehouse_catalog:delete');
        expect(fake.emits).toEqual([]);
    });

    it('a failed catalog delete throws and broadcasts nothing', async () => {
        respond('warehouse_stock', { data: null });
        respond('warehouse_catalog', { error: DB_ERR });
        await expect(deleteWarehouseCatalogItem(7)).rejects.toThrow('Failed to delete warehouse catalog item');
        expect(fake.emits).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('exportWarehouseCatalog — paginated JSON export', () => {
    it('first page: count then page, envelope metadata, archived flattened to a boolean, no ids or timestamps', async () => {
        respond('warehouse_catalog',
            { count: 3 },
            { data: [catRow(), catRow({ id: 2, name: 'Iron', quality_label: null, description: null, archived_at: '2025-01-01' })] },
        );
        const page = await exportWarehouseCatalog();
        expect(page).toEqual({
            items: [
                { name: 'Gold', category: 'ore', qualityLabel: 'A', unit: 'SCU', description: 'shiny', archived: false },
                { name: 'Iron', category: 'ore', qualityLabel: null, unit: 'SCU', description: null, archived: true },
            ],
            total: 3,
            nextOffset: 2,
            filename: 'warehouse-catalog-2026-01-02.json',
            version: 1,
            exportedAt: NOW,
        });
        const [countQ, pageQ] = queriesOf('warehouse_catalog');
        expect(calls(countQ, 'select')).toEqual([['id', { count: 'exact', head: true }]]);
        expect(calls(pageQ, 'range')).toEqual([[0, 199]]);
    });

    it('a later page carries no envelope metadata and ends the loop when the total is consumed', async () => {
        respond('warehouse_catalog', { count: 3 }, { data: [catRow()] });
        const page = await exportWarehouseCatalog({ offset: 2, limit: 2 });
        expect(page.nextOffset).toBeNull();
        expect(page).not.toHaveProperty('filename');
        expect(page).not.toHaveProperty('version');
        expect(page).not.toHaveProperty('exportedAt');
        expect(calls(queriesOf('warehouse_catalog')[1], 'range')).toEqual([[2, 3]]);
    });

    it('an empty page ends the loop even if the count says there is more (no infinite client loop)', async () => {
        respond('warehouse_catalog', { count: 50 }, { data: [] });
        const page = await exportWarehouseCatalog({ offset: 10 });
        expect(page.items).toEqual([]);
        expect(page.nextOffset).toBeNull();
    });

    it('clamps the page size to 1..500 and a negative offset to the first page', async () => {
        await exportWarehouseCatalog({ limit: 0 });
        await exportWarehouseCatalog({ limit: 10_000 });
        const page = await exportWarehouseCatalog({ offset: -9, limit: 5 });
        const pages = queriesOf('warehouse_catalog').filter((q) => calls(q, 'range').length > 0);
        expect(pages.map((q) => calls(q, 'range')[0])).toEqual([[0, 0], [0, 499], [0, 4]]);
        expect(page.filename).toBe('warehouse-catalog-2026-01-02.json');
    });
});

// ---------------------------------------------------------------------------
describe('previewWarehouseCatalogImport', () => {
    it('rejects a non-array payload before any read', async () => {
        await expect(previewWarehouseCatalogImport({ items: [] })).rejects.toThrow('items must be an array.');
        expect(fake.queries).toEqual([]);
    });

    it('an all-invalid file reports every reason and never queries the catalog', async () => {
        const out = await previewWarehouseCatalogImport([
            null,
            'not-a-row',
            { name: '   ' },
            { name: 'X', category: 'gems' },
        ]);
        expect(out).toEqual({
            newCount: 0, updateCount: 0, skipCount: 0, conflicts: [], total: 4,
            invalid: [
                { index: 0, name: undefined, reason: 'Row is not an object.' },
                { index: 1, name: undefined, reason: 'Row is not an object.' },
                { index: 2, name: '   ', reason: 'Missing name.' },
                { index: 3, name: 'X', reason: 'Invalid category "gems". Expected one of: ore, refined, fuel, rmc, munition, consumable, misc.' },
            ],
        });
        expect(fake.queries).toEqual([]);
    });

    it('classifies new / update / skip against only the names in the file and diffs every editable field', async () => {
        respond('warehouse_catalog', {
            data: [
                // Matches "gold|a" case-insensitively; every editable field differs.
                { id: 1, name: 'GOLD', quality_label: 'a', category: 'ore', unit: 'SCU', description: null, archived_at: '2025-01-01' },
                // Identical -> skip.
                { id: 2, name: 'Iron', quality_label: null, category: 'refined', unit: 'units', description: null, archived_at: null },
                // Null columns diff from null, not from undefined.
                { id: 3, name: 'Tin', quality_label: null, category: null, unit: null, description: 'old', archived_at: null },
            ],
        });
        const out = await previewWarehouseCatalogImport([
            { name: 'Gold', qualityLabel: 'A', category: 'refined', unit: 'units', description: 'd', archived: false },
            { name: 'Iron', category: 'refined' },
            { name: 'Tin', category: 'misc', archived: true },
            { name: 'Copper', category: 'ore' },
            { name: 'gold', qualityLabel: 'a', category: 'ore' }, // duplicate key within the file
        ]);
        expect(out.newCount).toBe(1);
        expect(out.skipCount).toBe(1);
        expect(out.updateCount).toBe(2);
        expect(out.total).toBe(5);
        expect(out.invalid).toEqual([{ index: 4, name: 'gold', reason: 'Duplicate (name + quality) within import file.' }]);
        expect(out.conflicts).toEqual([
            {
                name: 'Gold', qualityLabel: 'A',
                changes: {
                    category: { from: 'ore', to: 'refined' },
                    unit: { from: 'SCU', to: 'units' },
                    description: { from: null, to: 'd' },
                    archived: { from: true, to: false },
                },
            },
            {
                name: 'Tin', qualityLabel: null,
                changes: {
                    category: { from: null, to: 'misc' },
                    unit: { from: null, to: 'units' },
                    description: { from: 'old', to: null },
                    archived: { from: false, to: true },
                },
            },
        ]);
        const [q] = queriesOf('warehouse_catalog');
        expect(selected(q)).toBe('id, name, category, quality_label, unit, description, archived_at');
        // Bounded by the file (deduped), not the org's whole catalog.
        expect(calls(q, 'in')).toEqual([['name', ['Gold', 'Iron', 'Tin', 'Copper']]]);
    });

    it('no existing rows returned -> every valid row is new', async () => {
        respond('warehouse_catalog', { data: null });
        const out = await previewWarehouseCatalogImport([{ name: 'Gold', category: 'ore' }, { name: 'Iron', category: 'ore' }]);
        expect(out).toEqual({ newCount: 2, updateCount: 0, skipCount: 0, conflicts: [], invalid: [], total: 2 });
    });

    it('fails closed when the existing-catalog read errors', async () => {
        respond('warehouse_catalog', { error: DB_ERR });
        await expect(previewWarehouseCatalogImport([{ name: 'Gold', category: 'ore' }]))
            .rejects.toThrow('Failed to load existing warehouse catalog for import preview');
    });
});

// ---------------------------------------------------------------------------
describe('bulkUpsertWarehouseCatalog — one slice per call', () => {
    const row = (name: string, extra: Record<string, unknown> = {}) => ({ name, category: 'ore' as WarehouseCatalogCategory, ...extra });

    it('rejects a non-array payload', async () => {
        await expect(bulkUpsertWarehouseCatalog('nope')).rejects.toThrow('items must be an array.');
    });

    it('an offset past the end is a finished no-op with no queries', async () => {
        const out = await bulkUpsertWarehouseCatalog([row('A'), row('B')], { offset: 2 });
        expect(out).toEqual({ processed: 2, total: 2, nextOffset: null, inserted: 0, updated: 0, errors: [] });
        expect(fake.queries).toEqual([]);
        expect(fake.emits).toEqual([]);
    });

    it('processes exactly [offset, offset+limit), reports the next offset and does NOT broadcast mid-import', async () => {
        const items = ['A', 'B', 'C', 'D', 'E'].map((n) => row(n));
        const out = await bulkUpsertWarehouseCatalog(items, { offset: 1, limit: 2 });
        expect(out).toMatchObject({ processed: 3, total: 5, nextOffset: 3, inserted: 2, updated: 0, errors: [] });
        expect(calls(queriesOf('warehouse_catalog')[0], 'in')).toEqual([['name', ['B', 'C']]]);
        expect(queriesOf('warehouse_catalog').slice(1).map((q) => (calls(q, 'insert')[0][0] as { name: string }).name)).toEqual(['B', 'C']);
        expect(fake.emits).toEqual([]);
    });

    it('clamps limit to MAX_WAREHOUSE_IMPORT_BATCH_SIZE and sanitises junk offset/limit values', async () => {
        const items = Array.from({ length: MAX_WAREHOUSE_IMPORT_BATCH_SIZE + 20 }, (_, i) => row(`C${i}`));
        expect((await bulkUpsertWarehouseCatalog(items, { limit: 10_000 })).nextOffset).toBe(MAX_WAREHOUSE_IMPORT_BATCH_SIZE);
        expect((await bulkUpsertWarehouseCatalog(items, { limit: 0 })).nextOffset).toBe(MAX_WAREHOUSE_IMPORT_BATCH_SIZE);
        expect((await bulkUpsertWarehouseCatalog(items, { limit: Number.NaN })).nextOffset).toBe(MAX_WAREHOUSE_IMPORT_BATCH_SIZE);
        expect((await bulkUpsertWarehouseCatalog(items, { limit: 2.9 })).nextOffset).toBe(2);
        expect((await bulkUpsertWarehouseCatalog(items, { offset: Number.NaN, limit: 1 })).nextOffset).toBe(1);
        expect((await bulkUpsertWarehouseCatalog(items, { offset: -4, limit: 1 })).nextOffset).toBe(1);
        expect((await bulkUpsertWarehouseCatalog(items, { offset: 1.8, limit: 1 })).nextOffset).toBe(2);
    });

    it('updates a matched row (case-insensitive key) and preserves an existing archive stamp', async () => {
        respond('warehouse_catalog', {
            data: [
                { id: 21, name: 'GOLD', quality_label: 'A', category: 'ore', unit: 'SCU', description: null, archived_at: '2024-05-05' },
                { id: 22, name: 'Iron', quality_label: null, category: 'ore', unit: 'SCU', description: null, archived_at: null },
                { id: 23, name: 'Tin', quality_label: null, category: 'ore', unit: 'SCU', description: null, archived_at: '2024-05-05' },
            ],
        });
        const out = await bulkUpsertWarehouseCatalog([
            row('gold', { qualityLabel: 'a', unit: 'kg', description: 'd', archived: true }),
            row('Iron', { archived: true }),
            row('Tin', { archived: false }),
        ]);
        expect(out).toMatchObject({ processed: 3, nextOffset: null, inserted: 0, updated: 3, errors: [] });
        const updates = queriesOf('warehouse_catalog').slice(1);
        expect(updates.map((q) => calls(q, 'update')[0][0])).toEqual([
            { category: 'ore', unit: 'kg', description: 'd', archived_at: '2024-05-05', updated_at: NOW },
            { category: 'ore', unit: 'units', description: null, archived_at: NOW, updated_at: NOW },
            { category: 'ore', unit: 'units', description: null, archived_at: null, updated_at: NOW },
        ]);
        expect(updates.map((q) => calls(q, 'eq')[0])).toEqual([['id', 21], ['id', 22], ['id', 23]]);
        expect(fake.emits).toEqual([{ event: 'warehouse:catalog_update', payload: { bulk: true } }]);
    });

    it('inserts an unmatched row with sanitised fields and caches it so an in-slice repeat UPDATES', async () => {
        respond('warehouse_catalog',
            { data: [] },                                              // existing lookup
            { data: { id: 50, name: 'Gold', quality_label: 'A' } },   // insert
            {},                                                       // update of the cached row
        );
        const out = await bulkUpsertWarehouseCatalog([
            row('<b>Gold</b>\r\n', { qualityLabel: 'A', archived: true, description: '<i>d</i>' }),
            row('gold', { qualityLabel: 'a' }),
        ]);
        expect(out).toMatchObject({ inserted: 1, updated: 1, errors: [] });
        const [, ins, upd] = queriesOf('warehouse_catalog');
        expect(calls(ins, 'insert')).toEqual([[{
            name: 'Gold', category: 'ore', quality_label: 'A', unit: 'units', description: 'd', archived_at: NOW,
        }]]);
        expect(selected(ins)).toBe('id, name, quality_label');
        expect(ins.terminal).toBe('single');
        expect(calls(upd, 'eq')).toEqual([['id', 50]]);
    });

    it('collects invalid rows by ABSOLUTE index and skips the lookup when no row in the slice is valid', async () => {
        const out = await bulkUpsertWarehouseCatalog(
            [row('A'), row('B'), null, { name: 'Q', category: 'bad' }, { name: '   ' }],
            { offset: 2 },
        );
        expect(out.errors).toEqual([
            { index: 2, name: undefined, reason: 'Row is not an object.' },
            { index: 3, name: 'Q', reason: 'Invalid category "bad". Expected one of: ore, refined, fuel, rmc, munition, consumable, misc.' },
            { index: 4, name: '   ', reason: 'Missing name.' },
        ]);
        expect(fake.queries).toEqual([]);
        // Final batch, but nothing was written -> no broadcast.
        expect(out.nextOffset).toBeNull();
        expect(fake.emits).toEqual([]);
    });

    it('a failed existing-row lookup aborts the slice', async () => {
        respond('warehouse_catalog', { error: DB_ERR });
        await expect(bulkUpsertWarehouseCatalog([row('A')])).rejects.toBe(DB_ERR);
        expect(trail()).toEqual(['warehouse_catalog:select']);
    });

    it('per-row write failures are collected, the rest of the slice still lands', async () => {
        respond('warehouse_catalog',
            { data: [{ id: 1, name: 'Up', quality_label: null }] },
            { error: { message: 'update refused' } },       // Up    -> update fails
            { data: null, error: { message: 'insert refused' } }, // New1 -> insert fails
            { reject: new Error('socket hang up') },        // New2 -> driver throws
            { reject: 'bare string' },                      // New3 -> non-Error throw
            { data: null },                                 // New4 -> insert ok, nothing returned
        );
        const out = await bulkUpsertWarehouseCatalog([row('Up'), row('New1'), row('New2'), row('New3'), row('New4')]);
        expect(out.errors).toEqual([
            { index: 0, name: 'Up', reason: 'update refused' },
            { index: 1, name: 'New1', reason: 'insert refused' },
            { index: 2, name: 'New2', reason: 'socket hang up' },
            { index: 3, name: 'New3', reason: 'unknown error' },
        ]);
        expect(out).toMatchObject({ inserted: 1, updated: 0, nextOffset: null });
        expect(fake.emits).toEqual([{ event: 'warehouse:catalog_update', payload: { bulk: true } }]);
    });

    it('the selected column list for the lookup is explicit', async () => {
        await bulkUpsertWarehouseCatalog([row('A')]);
        const [lookup] = queriesOf('warehouse_catalog');
        expect(selected(lookup)).toBe('id, name, category, quality_label, unit, description, archived_at');
        expect(chain(lookup)).toEqual(['select', 'in']);
    });
});
