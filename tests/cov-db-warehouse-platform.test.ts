import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/warehouse.ts — the overview aggregate, the paginated stock CSV export (with
// the spreadsheet formula neutraliser at the output boundary) and the PLATFORM
// commodity catalog: categories, commodities (search allow-listing before .or()),
// the two-pass UEX sync, protected-field updates, delete/merge and the duplicate
// report. Every query is recorded so each test pins table, columns, filters and
// payloads; read errors are checked to fail closed.

vi.mock('../lib/db/common', async () => (await import('./cov-db-warehouse-fake')).commonMock);
vi.mock('../lib/log', async () => (await import('./cov-db-warehouse-fake')).logMock);
vi.mock('../lib/db/marketplace', async () => (await import('./cov-db-warehouse-fake')).marketplaceMock);
vi.mock('../lib/db/uex', async () => (await import('./cov-db-warehouse-fake')).uexMock);

import {
    fake, resetFake, respond, respondRpc, queriesOf, calls, chain, selected, trail, fetchUexCommodities,
} from './cov-db-warehouse-fake';
import {
    getWarehouseOverview,
    exportWarehouseCsv,
    listPlatformCommodityCategories,
    updatePlatformCommodityCategory,
    deletePlatformCommodityCategory,
    getPlatformCommodityCatalog,
    getPlatformCommodityCatalogWithUsage,
    getPlatformCommodityCatalogCount,
    syncPlatformCommodityCatalog,
    updatePlatformCommodity,
    deletePlatformCommodity,
    mergePlatformCommodities,
    repairPlatformCommodityCatalogDuplicates,
} from '../lib/db/warehouse';

const NOW = '2026-01-02T03:04:05.000Z';
const DB_ERR = { code: 'XX000', message: 'driver detail that must not reach the client' };
const MISSING_TABLE = { code: '42P01', message: 'relation does not exist' };
const COMMODITY_COLS = 'id, external_id, external_uuid, slug, name, code, kind, weight_scu, price_buy, price_sell, is_available, is_available_live, is_visible, is_extractable, is_mineral, is_raw, is_pure, is_refined, is_refinable, is_harvestable, is_buyable, is_sellable, is_temporary, is_illegal, is_volatile_qt, is_volatile_time, is_inert, is_explosive, is_buggy, is_fuel, wiki_url, platform_category_id, uex_date_added, uex_date_modified, last_synced_at, created_at, updated_at';

beforeEach(() => {
    resetFake();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------
describe('getWarehouseOverview', () => {
    it('reads the single SQL aggregate and coerces every figure to a number', async () => {
        respondRpc({ data: [{ total_stocks: '4', total_on_hand: 100, total_reserved: null, low_stock_count: 2, open_request_count: '3' }] });
        expect(await getWarehouseOverview()).toEqual({
            totalStocks: 4, totalOnHand: 100, totalReserved: 0, lowStockCount: 2, openRequestCount: 3,
        });
        expect(fake.rpcCalls).toEqual([{ fn: 'warehouse_overview_stats', args: {} }]);
        // One aggregate — no per-row table reads.
        expect(fake.queries).toEqual([]);
    });

    it('no row (null or empty) reads as all zeros', async () => {
        respondRpc({ data: null }, { data: [] });
        const zeros = { totalStocks: 0, totalOnHand: 0, totalReserved: 0, lowStockCount: 0, openRequestCount: 0 };
        expect(await getWarehouseOverview()).toEqual(zeros);
        expect(await getWarehouseOverview()).toEqual(zeros);
    });

    it('fails closed on an RPC error', async () => {
        respondRpc({ error: DB_ERR });
        await expect(getWarehouseOverview()).rejects.toThrow('Failed to load warehouse overview stats');
    });
});

// ---------------------------------------------------------------------------
describe('exportWarehouseCsv — paginated rows with the formula neutraliser', () => {
    function stockRow(over: Record<string, unknown> = {}) {
        return {
            id: 5, catalog_id: 3, location_id: 8, notes: 'bay 2', created_at: 'c', updated_at: 'u',
            quantity_on_hand: 12, quantity_reserved: 4,
            catalog: { id: 3, name: 'Gold', category: 'ore', quality_label: 'A', unit: 'SCU', description: 'secret desc', archived_at: null, created_at: 'c', updated_at: 'u' },
            location: { id: 8, name: 'Lorville', type: 'station' },
            ...over,
        };
    }

    it('first page: counts, reads one page, exports ONLY the CSV columns and names the file', async () => {
        respond('warehouse_stock', { count: 3 });
        respond('v_warehouse_stock_with_qty', { data: [stockRow(), stockRow({ id: 6, catalog: null, location: null, notes: null, quantity_on_hand: -5 })] });
        const page = await exportWarehouseCsv();
        expect(page).toEqual({
            rows: [
                { commodity: 'Gold', quality: 'A', category: 'ore', unit: 'SCU', location: 'Lorville', onHand: 12, reserved: 4, notes: 'bay 2' },
                // Missing embeds become empty cells; a negative NUMBER is data, not a formula.
                { commodity: '', quality: '', category: '', unit: '', location: '', onHand: -5, reserved: 4, notes: '' },
            ],
            total: 3,
            nextOffset: 2,
            filename: 'warehouse-2026-01-02.csv',
        });
        expect(JSON.stringify(page)).not.toContain('secret desc');
        expect(trail()).toEqual(['warehouse_stock:select', 'v_warehouse_stock_with_qty:select']);
        expect(calls(queriesOf('warehouse_stock')[0], 'select')).toEqual([['id', { count: 'exact', head: true }]]);
        expect(calls(queriesOf('v_warehouse_stock_with_qty')[0], 'range')).toEqual([[0, 199]]);
    });

    it.each([
        ['=1+1', "'=1+1"],
        ['+SUM(A1)', "'+SUM(A1)"],
        ['-2+3', "'-2+3"],
        ['@cmd', "'@cmd"],
        ['\tfoo', "'\tfoo"],
        ['\rfoo', "'\rfoo"],
        [' =cmd', "' =cmd"],          // trigger behind leading whitespace
        ['\n=HYPERLINK("x")', "'\n=HYPERLINK(\"x\")"],
        ['Gold', 'Gold'],
        ['a=b', 'a=b'],                // only a LEADING trigger matters
        ['\nfoo', '\nfoo'],            // leading newline without a trigger is left alone
        ['', ''],
    ])('neutralises %j -> %j in every string column', async (value, expected) => {
        respond('warehouse_stock', { count: 1 });
        respond('v_warehouse_stock_with_qty', {
            data: [stockRow({
                notes: value,
                catalog: { id: 3, name: value, category: value, quality_label: value, unit: value },
                location: { id: 8, name: value, type: 'station' },
            })],
        });
        const { rows: [row] } = await exportWarehouseCsv();
        // quality_label '' maps to null in the stock mapper, then '' in the export.
        expect(row).toEqual({
            commodity: expected, quality: expected, category: expected, unit: expected,
            location: expected, notes: expected, onHand: 12, reserved: 4,
        });
    });

    it('a later page has no filename, and the loop ends on the last or an empty page', async () => {
        respond('warehouse_stock', { count: 3 }, { count: 50 });
        respond('v_warehouse_stock_with_qty', { data: [stockRow()] }, { data: [] });
        const last = await exportWarehouseCsv({ offset: 2, limit: 2 });
        expect(last.nextOffset).toBeNull();
        expect(last).not.toHaveProperty('filename');
        expect(calls(queriesOf('v_warehouse_stock_with_qty')[0], 'range')).toEqual([[2, 3]]);
        const empty = await exportWarehouseCsv({ offset: 10 });
        expect(empty.rows).toEqual([]);
        expect(empty.nextOffset).toBeNull();
    });

    it('clamps the page size to 1..500 and a negative offset to the first page', async () => {
        await exportWarehouseCsv({ limit: 0 });
        await exportWarehouseCsv({ limit: 9999 });
        const first = await exportWarehouseCsv({ offset: -4, limit: 3 });
        expect(queriesOf('v_warehouse_stock_with_qty').map((q) => calls(q, 'range')[0])).toEqual([[0, 0], [0, 499], [0, 2]]);
        expect(first.filename).toBe('warehouse-2026-01-02.csv');
    });

    it('a failed count or page read fails closed', async () => {
        respond('warehouse_stock', { error: DB_ERR });
        await expect(exportWarehouseCsv()).rejects.toThrow('Failed to count warehouse stock');
        respond('v_warehouse_stock_with_qty', { error: DB_ERR });
        await expect(exportWarehouseCsv()).rejects.toThrow('Failed to load warehouse stock');
    });
});

// ---------------------------------------------------------------------------
describe('platform commodity categories', () => {
    it('lists with explicit columns, ordered by sort order then name, mapped with safe defaults', async () => {
        respond('warehouse_platform_categories', {
            data: [
                { id: 1, slug: 'metal', uex_kind: 'Metal', display_name: 'Metals', sort_order: 2, is_hidden: true, created_at: 'c', updated_at: 'u' },
                { id: 2, slug: 'gas', uex_kind: 'Gas', display_name: 'Gas', sort_order: null, is_hidden: null, created_at: 'c', updated_at: 'u' },
            ],
        });
        expect(await listPlatformCommodityCategories()).toEqual([
            { id: 1, slug: 'metal', uexKind: 'Metal', displayName: 'Metals', sortOrder: 2, isHidden: true, createdAt: 'c', updatedAt: 'u' },
            { id: 2, slug: 'gas', uexKind: 'Gas', displayName: 'Gas', sortOrder: 0, isHidden: false, createdAt: 'c', updatedAt: 'u' },
        ]);
        const [q] = queriesOf('warehouse_platform_categories');
        expect(selected(q)).toBe('id, slug, uex_kind, display_name, sort_order, is_hidden, created_at, updated_at');
        expect(calls(q, 'order')).toEqual([['sort_order', { ascending: true }], ['display_name', { ascending: true }]]);
    });

    it('list: 42P01 -> [], null data -> [], any other error fails closed', async () => {
        respond('warehouse_platform_categories', { error: MISSING_TABLE }, { data: null }, { error: DB_ERR });
        expect(await listPlatformCommodityCategories()).toEqual([]);
        expect(await listPlatformCommodityCategories()).toEqual([]);
        await expect(listPlatformCommodityCategories()).rejects.toThrow('Failed to load warehouse platform categories');
    });

    it('update: refuses an empty patch, otherwise stamps updated_at and scopes by id', async () => {
        await expect(updatePlatformCommodityCategory(4, {})).rejects.toThrow('No updatable fields provided');
        expect(fake.queries).toEqual([]);
        await updatePlatformCommodityCategory(4, { display_name: 'Metals', is_hidden: true });
        const [q] = queriesOf('warehouse_platform_categories');
        expect(calls(q, 'update')).toEqual([[{ display_name: 'Metals', is_hidden: true, updated_at: NOW }]]);
        expect(calls(q, 'eq')).toEqual([['id', 4]]);
    });

    it('update: a write error fails closed', async () => {
        respond('warehouse_platform_categories', { error: DB_ERR });
        await expect(updatePlatformCommodityCategory(4, { sort_order: 1 })).rejects.toThrow('Failed to update warehouse platform category');
    });

    it('delete: refuses while commodities still reference the category', async () => {
        respond('warehouse_platform_commodities', { count: 2 });
        await expect(deletePlatformCommodityCategory(4)).rejects.toThrow('Cannot delete: 2 commodity row(s) reference this category. Reassign first.');
        const [countQ] = queriesOf('warehouse_platform_commodities');
        expect(calls(countQ, 'select')).toEqual([['id', { count: 'exact', head: true }]]);
        expect(calls(countQ, 'eq')).toEqual([['platform_category_id', 4]]);
        expect(queriesOf('warehouse_platform_categories')).toEqual([]);
    });

    it('delete: FAILS CLOSED when the reference count cannot be read (FK is ON DELETE SET NULL)', async () => {
        respond('warehouse_platform_commodities', { count: null, error: DB_ERR });
        await expect(deletePlatformCommodityCategory(4)).rejects.toThrow('Failed to check warehouse platform category usage');
        expect(queriesOf('warehouse_platform_categories')).toEqual([]);
    });

    it('delete: an unreferenced category is deleted by id; a write error fails closed', async () => {
        respond('warehouse_platform_commodities', { count: 0 }, { count: null });
        respond('warehouse_platform_categories', {}, { error: DB_ERR });
        await deletePlatformCommodityCategory(4);
        expect(trail()).toEqual(['warehouse_platform_commodities:select', 'warehouse_platform_categories:delete']);
        expect(calls(queriesOf('warehouse_platform_categories')[0], 'eq')).toEqual([['id', 4]]);
        await expect(deletePlatformCommodityCategory(4)).rejects.toThrow('Failed to delete warehouse platform category');
    });
});

// ---------------------------------------------------------------------------
describe('platform commodities — list / count', () => {
    it('selects the explicit commodity columns, orders, pages (default 50) and maps', async () => {
        respond('warehouse_platform_commodities', {
            data: [{ id: 1, external_id: 77, slug: 'gold', name: 'Gold', kind: 'Metal', price_buy: '12.5', is_illegal: 0, is_fuel: null }],
        });
        const [row] = await getPlatformCommodityCatalog();
        expect(row).toMatchObject({ id: 1, externalId: 77, slug: 'gold', name: 'Gold', kind: 'Metal', priceBuy: 12.5, isIllegal: false, isFuel: null });
        const [q] = queriesOf('warehouse_platform_commodities');
        expect(selected(q)).toBe(COMMODITY_COLS);
        expect(chain(q)).toEqual(['select', 'order', 'order', 'range']);
        expect(calls(q, 'order')).toEqual([['name', { ascending: true }], ['id', { ascending: true }]]);
        expect(calls(q, 'range')).toEqual([[0, 49]]);
    });

    it('allow-lists the search term BEFORE interpolating it into .or() — no injected sibling conditions', async () => {
        await getPlatformCommodityCatalog({ search: 'gold),is_illegal.eq.true,(name.ilike.*' });
        const [q] = queriesOf('warehouse_platform_commodities');
        expect(calls(q, 'or')).toEqual([['name.ilike.%goldis_illegaleqtruenameilike%,kind.ilike.%goldis_illegaleqtruenameilike%,code.ilike.%goldis_illegaleqtruenameilike%']]);
    });

    it('a search that sanitises to nothing, or is blank, adds no filter', async () => {
        await getPlatformCommodityCatalog({ search: '***' });
        await getPlatformCommodityCatalog({ search: '   ' });
        expect(queriesOf('warehouse_platform_commodities').map((q) => calls(q, 'or'))).toEqual([[], []]);
    });

    it('category (0 is a real id), illegal-only and legal-only filters', async () => {
        await getPlatformCommodityCatalog({ platformCategoryId: 0, illegalOnly: true });
        await getPlatformCommodityCatalog({ legalOnly: true, platformCategoryId: null });
        const [a, b] = queriesOf('warehouse_platform_commodities');
        expect(calls(a, 'eq')).toEqual([['platform_category_id', 0], ['is_illegal', true]]);
        expect(calls(b, 'eq')).toEqual([]);
        expect(calls(b, 'or')).toEqual([['is_illegal.is.null,is_illegal.eq.false']]);
    });

    it('clamps limit to 1..500 and the offset to the shared ceiling', async () => {
        await getPlatformCommodityCatalog({ limit: 0 });
        await getPlatformCommodityCatalog({ limit: 9999, offset: 10 });
        await getPlatformCommodityCatalog({ offset: -1 });
        expect(queriesOf('warehouse_platform_commodities').map((q) => calls(q, 'range')[0])).toEqual([[0, 0], [10, 509], [0, 49]]);
    });

    it('list: 42P01 -> [], null data -> [], any other error fails closed', async () => {
        respond('warehouse_platform_commodities', { error: MISSING_TABLE }, { data: null }, { error: DB_ERR });
        expect(await getPlatformCommodityCatalog()).toEqual([]);
        expect(await getPlatformCommodityCatalog()).toEqual([]);
        await expect(getPlatformCommodityCatalog()).rejects.toThrow('Failed to load platform commodity catalog');
    });

    it('with-usage decorates each row with usageCount 0 and passes the options through', async () => {
        respond('warehouse_platform_commodities', { data: [{ id: 1, external_id: 1, slug: 's', name: 'A' }, { id: 2, external_id: 2, slug: 't', name: 'B' }] });
        const rows = await getPlatformCommodityCatalogWithUsage({ illegalOnly: true });
        expect(rows.map((r) => [r.id, r.usageCount])).toEqual([[1, 0], [2, 0]]);
        expect(calls(queriesOf('warehouse_platform_commodities')[0], 'eq')).toEqual([['is_illegal', true]]);
    });

    it('count: head-only exact count with the same sanitised filters', async () => {
        respond('warehouse_platform_commodities', { count: 7 }, { count: null });
        expect(await getPlatformCommodityCatalogCount({ search: 'gold,x', platformCategoryId: 3, illegalOnly: true, legalOnly: true })).toBe(7);
        expect(await getPlatformCommodityCatalogCount({ search: '%%' })).toBe(0);
        const [a, b] = queriesOf('warehouse_platform_commodities');
        expect(calls(a, 'select')).toEqual([['id', { count: 'exact', head: true }]]);
        expect(calls(a, 'or')).toEqual([
            ['name.ilike.%goldx%,kind.ilike.%goldx%,code.ilike.%goldx%'],
            ['is_illegal.is.null,is_illegal.eq.false'],
        ]);
        expect(calls(a, 'eq')).toEqual([['platform_category_id', 3], ['is_illegal', true]]);
        expect(calls(b, 'or')).toEqual([]);
        expect(calls(b, 'eq')).toEqual([]);
    });

    it('count: 42P01 -> 0, any other error fails closed', async () => {
        respond('warehouse_platform_commodities', { error: MISSING_TABLE }, { error: DB_ERR });
        expect(await getPlatformCommodityCatalogCount()).toBe(0);
        await expect(getPlatformCommodityCatalogCount({ search: '   ' })).rejects.toThrow('Failed to count platform commodities');
    });
});

// ---------------------------------------------------------------------------
describe('syncPlatformCommodityCatalog — two-pass UEX sync', () => {
    it('pass 1 refreshes existing categories WITHOUT touching display_name and inserts new ones; pass 2 threads the FK map', async () => {
        fetchUexCommodities.mockResolvedValue([
            { id: 1, name: 'Gold', kind: 'Metal' },
            { id: 2, name: 'Iron', kind: 'metal' },     // same slug — first spelling wins
            { id: 3, name: 'Hydrogen', kind: 'Gas' },
            { id: 4, name: 'Mystery', kind: null },     // no kind -> no category
        ]);
        respond('warehouse_platform_categories',
            { data: [{ id: 10, slug: 'metal', display_name: 'Metals (admin renamed)' }] },
            {},                       // update metal
            { data: { id: 11 } },     // insert gas
        );
        const out = await syncPlatformCommodityCatalog();
        expect(out).toEqual({ commoditiesSynced: 4, commodityErrors: 0, categoriesInserted: 1, categoriesUpdated: 1 });

        const [readQ, updQ, insQ] = queriesOf('warehouse_platform_categories');
        expect(selected(readQ)).toBe('id, slug, display_name');
        expect(calls(updQ, 'update')).toEqual([[{ uex_kind: 'Metal', updated_at: NOW }]]);
        expect(calls(updQ, 'eq')).toEqual([['id', 10]]);
        expect(calls(insQ, 'insert')).toEqual([[{ slug: 'gas', uex_kind: 'Gas', display_name: 'Gas' }]]);
        expect(selected(insQ)).toBe('id');

        const [upsertQ] = queriesOf('warehouse_platform_commodities');
        expect(calls(upsertQ, 'upsert')).toEqual([[
            [
                { external_id: 1, name: 'Gold', platform_category_id: 10 },
                { external_id: 2, name: 'Iron', platform_category_id: 10 },
                { external_id: 3, name: 'Hydrogen', platform_category_id: 11 },
                { external_id: 4, name: 'Mystery', platform_category_id: null },
            ],
            { onConflict: 'external_id' },
        ]]);
        expect(fake.logs.filter((l) => l.level === 'info')).toEqual([
            { level: 'info', msg: 'uex commodities fetched', fields: { count: 4 } },
            { level: 'info', msg: 'uex commodities sync done', fields: { synced: 4, errors: 0, categoriesInserted: 1, categoriesUpdated: 1 } },
        ]);
    });

    it('FAILS CLOSED before any write when the existing categories cannot be read', async () => {
        // Otherwise every insert trips UNIQUE(slug) and pass 2 upserts platform_category_id
        // = NULL onto every commodity, wiping the admin's category assignments.
        fetchUexCommodities.mockResolvedValue([{ id: 1, name: 'Gold', kind: 'Metal' }]);
        respond('warehouse_platform_categories', { data: null, error: DB_ERR });
        await expect(syncPlatformCommodityCatalog()).rejects.toThrow('Failed to load warehouse platform categories for sync');
        expect(trail()).toEqual(['warehouse_platform_categories:select']);
    });

    it('a failed category update is not counted but keeps its FK; a failed insert is neither counted nor mapped', async () => {
        fetchUexCommodities.mockResolvedValue([{ id: 1, name: 'Gold', kind: 'Metal' }, { id: 2, name: 'Neon', kind: 'Gas' }]);
        respond('warehouse_platform_categories',
            { data: [{ id: 10, slug: 'metal', display_name: 'Metal' }] },
            { error: DB_ERR },                 // update metal fails
            { data: null, error: DB_ERR },     // insert gas fails
        );
        const out = await syncPlatformCommodityCatalog();
        expect(out).toMatchObject({ categoriesInserted: 0, categoriesUpdated: 0, commoditiesSynced: 2 });
        const rows = calls(queriesOf('warehouse_platform_commodities')[0], 'upsert')[0][0] as Array<Record<string, unknown>>;
        expect(rows.map((r) => r.platform_category_id)).toEqual([10, null]);
    });

    it('an insert that returns no row is not mapped', async () => {
        fetchUexCommodities.mockResolvedValue([{ id: 2, name: 'Neon', kind: 'Gas' }]);
        respond('warehouse_platform_categories', { data: [] }, { data: null });
        const out = await syncPlatformCommodityCatalog();
        expect(out.categoriesInserted).toBe(0);
        const rows = calls(queriesOf('warehouse_platform_commodities')[0], 'upsert')[0][0] as Array<Record<string, unknown>>;
        expect(rows[0].platform_category_id).toBeNull();
    });

    it('a successful read with no rows (first ever sync) inserts every category', async () => {
        fetchUexCommodities.mockResolvedValue([{ id: 2, name: 'Neon', kind: 'Gas' }]);
        respond('warehouse_platform_categories', { data: null }, { data: { id: 12 } });
        const out = await syncPlatformCommodityCatalog();
        expect(out).toMatchObject({ categoriesInserted: 1, categoriesUpdated: 0 });
        expect(trail()).toEqual([
            'warehouse_platform_categories:select',
            'warehouse_platform_categories:insert',
            'warehouse_platform_commodities:upsert',
        ]);
    });

    it('upserts commodities in batches of 100', async () => {
        fetchUexCommodities.mockResolvedValue(Array.from({ length: 250 }, (_, i) => ({ id: i + 1, name: `C${i}`, kind: null })));
        respond('warehouse_platform_categories', { data: [] });
        const out = await syncPlatformCommodityCatalog();
        const sizes = queriesOf('warehouse_platform_commodities').map((q) => (calls(q, 'upsert')[0][0] as unknown[]).length);
        expect(sizes).toEqual([100, 100, 50]);
        expect(out.commoditiesSynced).toBe(250);
    });

    it('a failed batch falls back to per-row upserts, counts row errors and caps the warn log at 5', async () => {
        fetchUexCommodities.mockResolvedValue(Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: i === 0 ? null : `C${i}`, kind: null })));
        respond('warehouse_platform_categories', { data: [] });
        respond('warehouse_platform_commodities',
            { error: DB_ERR },                                                 // the batch
            ...Array.from({ length: 7 }, (_, i) => ({ error: { message: `row ${i} refused` } })),
            {},                                                                // last row ok
        );
        const out = await syncPlatformCommodityCatalog();
        expect(out).toEqual({ commoditiesSynced: 1, commodityErrors: 7, categoriesInserted: 0, categoriesUpdated: 0 });
        const perRow = queriesOf('warehouse_platform_commodities').slice(1);
        expect(perRow).toHaveLength(8);
        expect(calls(perRow[3], 'upsert')).toEqual([[{ external_id: 4, name: 'C3', platform_category_id: null }, { onConflict: 'external_id' }]]);
        const warns = fake.logs.filter((l) => l.level === 'warn');
        expect(warns).toHaveLength(5);
        // A nameless commodity is logged as '?', and only the short reason is logged.
        expect(warns[0]).toEqual({ level: 'warn', msg: 'uex commodity upsert failed', fields: { name: '?', reason: 'row 0 refused' } });
        expect(warns.map((w) => w.fields?.name)).toEqual(['?', 'C1', 'C2', 'C3', 'C4']);
    });
});

// ---------------------------------------------------------------------------
describe('platform commodity admin writes', () => {
    it('update strips every identity / sync-key field before writing', async () => {
        await updatePlatformCommodity(9, {
            id: 1, external_id: 2, external_uuid: 'u', slug: 's', created_at: 'c', last_synced_at: 'l',
            name: 'Renamed', is_illegal: true,
        });
        const [q] = queriesOf('warehouse_platform_commodities');
        expect(calls(q, 'update')).toEqual([[{ name: 'Renamed', is_illegal: true, updated_at: NOW }]]);
        expect(calls(q, 'eq')).toEqual([['id', 9]]);
    });

    it('update refuses a patch made only of protected fields, before any write', async () => {
        await expect(updatePlatformCommodity(9, { external_id: 5, slug: 'x' })).rejects.toThrow('No updatable fields provided');
        await expect(updatePlatformCommodity(9, {})).rejects.toThrow('No updatable fields provided');
        expect(fake.queries).toEqual([]);
    });

    it('update: a write error fails closed', async () => {
        respond('warehouse_platform_commodities', { error: DB_ERR });
        await expect(updatePlatformCommodity(9, { name: 'x' })).rejects.toThrow('Failed to update platform commodity');
    });

    it('delete is scoped by id; a write error fails closed', async () => {
        respond('warehouse_platform_commodities', {}, { error: DB_ERR });
        await deletePlatformCommodity(9);
        expect(trail()).toEqual(['warehouse_platform_commodities:delete']);
        expect(calls(queriesOf('warehouse_platform_commodities')[0], 'eq')).toEqual([['id', 9]]);
        await expect(deletePlatformCommodity(9)).rejects.toThrow('Failed to delete platform commodity');
    });

    it('merge refuses a self-merge, otherwise deletes only the loser', async () => {
        await expect(mergePlatformCommodities(3, 3)).rejects.toThrow('Cannot merge a commodity with itself');
        expect(fake.queries).toEqual([]);
        expect(await mergePlatformCommodities(3, 4)).toEqual({ merged: true });
        expect(trail()).toEqual(['warehouse_platform_commodities:delete']);
        expect(calls(queriesOf('warehouse_platform_commodities')[0], 'eq')).toEqual([['id', 4]]);
    });

    it('merge propagates a failed delete', async () => {
        respond('warehouse_platform_commodities', { error: DB_ERR });
        await expect(mergePlatformCommodities(3, 4)).rejects.toThrow('Failed to delete platform commodity');
    });
});

describe('repairPlatformCommodityCatalogDuplicates', () => {
    it('reports every slug shared by more than one row, without modifying anything', async () => {
        respond('warehouse_platform_commodities', {
            data: [
                { id: 1, slug: 'gold', name: 'Gold', external_id: 11 },
                { id: 2, slug: 'gold', name: 'Gold (dup)', external_id: 12 },
                { id: 3, slug: 'iron', name: 'Iron', external_id: 13 },
                { id: 4, slug: 'tin', name: 'Tin', external_id: 14 },
                { id: 5, slug: 'tin', name: 'Tin', external_id: 15 },
                { id: 6, slug: 'tin', name: 'Tin', external_id: 16 },
            ],
        });
        expect(await repairPlatformCommodityCatalogDuplicates()).toEqual({
            groupsFound: 2,
            summary: [
                'Slug "gold" used by 2 rows: id=1(ext=11), id=2(ext=12)',
                'Slug "tin" used by 3 rows: id=4(ext=14), id=5(ext=15), id=6(ext=16)',
            ],
        });
        expect(trail()).toEqual(['warehouse_platform_commodities:select']);
        expect(selected(queriesOf('warehouse_platform_commodities')[0])).toBe('id, slug, name, external_id');
    });

    it('no rows -> nothing found', async () => {
        respond('warehouse_platform_commodities', { data: null });
        expect(await repairPlatformCommodityCatalogDuplicates()).toEqual({ groupsFound: 0, summary: [] });
    });
});
