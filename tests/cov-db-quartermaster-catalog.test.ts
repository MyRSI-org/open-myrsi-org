import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/quartermaster.ts — the CATALOG and LOCATION halves.
//
// What is pinned here, and why each matters:
//  - Every read enumerates its columns (Security rule 1) and is scoped the way the
//    caller relies on: tenant catalog reads see source='custom' only, the platform
//    admin reads see source='platform' only, and every write to a catalog row
//    re-asserts the source so a custom-row editor can never touch a platform row
//    (and vice versa).
//  - Writes broadcast ids, never content (Security rule 4), and do NOT broadcast
//    when the write failed.
//  - Delete paths snapshot / detach dependants BEFORE the parent row goes, in the
//    order the FKs require, and emit the companion inventory/warehouse broadcasts
//    only when there were dependants.
//  - Every `if (error)` throws the caller's high-level message (no schema detail);
//    42P01 (pre-migration window) degrades to empty where the code says so.

vi.mock('../lib/db/common', async () => (await import('./cov-db-quartermaster-harness')).commonMock);
vi.mock('../lib/db/uex', async () => (await import('./cov-db-quartermaster-harness')).uex);
vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    const hh = await import('./cov-db-quartermaster-harness');
    return { ...actual, log: { ...actual.log, child: () => hh.logSpy } };
});

import {
    h, queue, settled, calls, first, chain, trace, resetHarness, broadcastToOrg,
} from './cov-db-quartermaster-harness';
import {
    listCatalog, searchCatalog, getCatalogItemById, createCatalogItem, updateCatalogItem, deleteCatalogItem,
    listQmLocations, getQmLocationById, createQmLocation, updateQmLocation, deleteQmLocation,
} from '../lib/db/quartermaster';

const CATALOG_COLS = 'id, slug, name, category, subcategory, attributes, source, thumbnail_url, wiki_url, created_at, updated_at';
const LOCATION_COLS = 'id, name, type, parent_id, description, sort_order, created_at, updated_at';
const PG_MISSING = { code: '42P01', message: 'relation does not exist' };
const PG_FAULT = { code: 'XX000', message: 'internal: column "secret_col" of relation "x"' };

const catRow = (id: number, over: Record<string, unknown> = {}) => ({
    id, slug: `s-${id}`, name: `Item ${id}`, category: 'weapon', subcategory: 'rifle',
    attributes: { Grade: 'A' }, source: 'custom', thumbnail_url: null, wiki_url: null,
    created_at: 'c-at', updated_at: 'u-at', ...over,
});
const catItem = (id: number, over: Record<string, unknown> = {}) => ({
    id, slug: `s-${id}`, name: `Item ${id}`, category: 'weapon', subcategory: 'rifle',
    attributes: { Grade: 'A' }, source: 'custom', thumbnailUrl: null, wikiUrl: null,
    createdAt: 'c-at', updatedAt: 'u-at', ...over,
});
const locRow = (id: number, over: Record<string, unknown> = {}) => ({
    id, name: `Loc ${id}`, type: 'station', parent_id: null, description: null, sort_order: 3,
    created_at: 'c-at', updated_at: 'u-at', ...over,
});
const locItem = (id: number, over: Record<string, unknown> = {}) => ({
    id, name: `Loc ${id}`, type: 'station', parentId: null, description: null, sortOrder: 3,
    createdAt: 'c-at', updatedAt: 'u-at', ...over,
});

beforeEach(() => resetHarness());
afterEach(() => { vi.useRealTimers(); });

// ===========================================================================
// listCatalog
// ===========================================================================
describe('listCatalog', () => {
    it('reads ONLY org-custom rows with an explicit column list, category→name ordered, and maps them', async () => {
        queue('quartermaster_catalog', {
            data: [catRow(1), catRow(2, { attributes: null, source: null, subcategory: undefined, thumbnail_url: 'https://x/a.png' })],
        });
        const out = await listCatalog();
        const [q] = settled('quartermaster_catalog');
        expect(first(q, 'select')).toEqual([CATALOG_COLS]);
        expect(calls(q, 'eq')).toEqual([['source', 'custom']]);
        expect(calls(q, 'order')).toEqual([['category', { ascending: true }], ['name', { ascending: true }]]);
        expect(out).toEqual([
            catItem(1),
            // mapper defaults: null attributes → {}, null source → 'custom', undefined subcategory → null
            catItem(2, { attributes: {}, source: 'custom', subcategory: null, thumbnailUrl: 'https://x/a.png' }),
        ]);
    });

    it('returns [] in the pre-migration window (42P01) instead of throwing', async () => {
        queue('quartermaster_catalog', { error: PG_MISSING });
        await expect(listCatalog()).resolves.toEqual([]);
    });

    it('fails closed with the high-level message on any other read error (no schema detail leaks)', async () => {
        queue('quartermaster_catalog', { error: PG_FAULT });
        await expect(listCatalog()).rejects.toThrow(/^Failed to load catalog$/);
    });

    it('treats a null payload as an empty catalog', async () => {
        queue('quartermaster_catalog', { data: null });
        await expect(listCatalog()).resolves.toEqual([]);
    });
});

// ===========================================================================
// searchCatalog
// ===========================================================================
describe('searchCatalog', () => {
    it('returns [] for an empty or whitespace query without touching the database', async () => {
        await expect(searchCatalog({ query: '' })).resolves.toEqual([]);
        await expect(searchCatalog({ query: '   ' })).resolves.toEqual([]);
        await expect(searchCatalog({ query: undefined as unknown as string })).resolves.toEqual([]);
        expect(h.queries).toHaveLength(0);
    });

    it('escapes every LIKE metacharacter (incl. PostgREST * alias) so the term matches literally', async () => {
        await searchCatalog({ query: '  50%_off*\\x  ' });
        const [q] = settled('quartermaster_catalog');
        expect(first(q, 'select')).toEqual([CATALOG_COLS]);
        expect(first(q, 'ilike')).toEqual(['name', '%50\\%\\_off\\*\\\\x%']);
    });

    it("source='both' (default) applies no source filter, a deterministic order and the default cap of 50", async () => {
        queue('quartermaster_catalog', { data: [catRow(4, { source: 'platform' })] });
        const out = await searchCatalog({ query: 'rifle' });
        const [q] = settled('quartermaster_catalog');
        expect(calls(q, 'eq')).toEqual([]);
        expect(calls(q, 'order')).toEqual([
            ['source', { ascending: true }], ['name', { ascending: true }], ['id', { ascending: true }],
        ]);
        expect(calls(q, 'limit')).toEqual([[50]]);
        expect(out).toEqual([catItem(4, { source: 'platform' })]);
    });

    it("source='custom' / 'platform' each pin exactly their source", async () => {
        await searchCatalog({ query: 'a', source: 'custom' });
        await searchCatalog({ query: 'a', source: 'platform' });
        const [c, p] = settled('quartermaster_catalog');
        expect(calls(c, 'eq')).toEqual([['source', 'custom']]);
        expect(calls(p, 'eq')).toEqual([['source', 'platform']]);
    });

    it('clamps the limit into [1, 200]', async () => {
        await searchCatalog({ query: 'a', limit: 0 });
        await searchCatalog({ query: 'a', limit: -9 });
        await searchCatalog({ query: 'a', limit: 5000 });
        await searchCatalog({ query: 'a', limit: 120 });
        expect(settled('quartermaster_catalog').map((q) => first(q, 'limit'))).toEqual([[1], [1], [200], [120]]);
    });

    it('returns [] on 42P01 and throws the high-level message on any other error', async () => {
        queue('quartermaster_catalog', { error: PG_MISSING }, { error: PG_FAULT });
        await expect(searchCatalog({ query: 'a' })).resolves.toEqual([]);
        await expect(searchCatalog({ query: 'a' })).rejects.toThrow(/^Failed to search catalog$/);
    });

    it('treats a null payload as no matches', async () => {
        queue('quartermaster_catalog', { data: null });
        await expect(searchCatalog({ query: 'a' })).resolves.toEqual([]);
    });
});

// ===========================================================================
// getCatalogItemById
// ===========================================================================
describe('getCatalogItemById', () => {
    it('fetches one CUSTOM row by id (platform rows never ride the tenant slice) and maps it', async () => {
        queue('quartermaster_catalog', { data: catRow(9) });
        await expect(getCatalogItemById(9)).resolves.toEqual(catItem(9));
        const [q] = settled('quartermaster_catalog');
        expect(q.terminal).toBe('maybeSingle');
        expect(first(q, 'select')).toEqual([CATALOG_COLS]);
        expect(calls(q, 'eq')).toEqual([['id', 9], ['source', 'custom']]);
    });

    it('returns null when absent (deleted → removed client-side)', async () => {
        await expect(getCatalogItemById(9)).resolves.toBeNull();
    });

    it('THROWS on a read error rather than reporting the row deleted', async () => {
        queue('quartermaster_catalog', { error: PG_MISSING });
        await expect(getCatalogItemById(9)).rejects.toThrow(/^Failed to get catalog item slice$/);
    });
});

// ===========================================================================
// createCatalogItem
// ===========================================================================
describe('createCatalogItem', () => {
    it('rejects a missing/blank name before any write', async () => {
        await expect(createCatalogItem({ name: '   ', category: 'weapon' })).rejects.toThrow('Item name is required.');
        await expect(createCatalogItem({ name: undefined as unknown as string, category: 'weapon' })).rejects.toThrow('Item name is required.');
        expect(h.queries).toHaveLength(0);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });

    it('inserts a custom row with a slugified, time-suffixed slug and safe defaults, then broadcasts the id only', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
        const ts = Date.now().toString(36);
        queue('quartermaster_catalog', { data: catRow(77, { name: 'Laser Rifle!! Mk-II' }) });

        const out = await createCatalogItem({
            name: '  Laser Rifle!! Mk-II  ', category: 'weapon', thumbnailUrl: ' https://cdn.example.com/a.PNG ',
        });

        const [q] = settled('quartermaster_catalog');
        expect(q.terminal).toBe('single');
        expect(first(q, 'insert')).toEqual([{
            slug: `laser-rifle-mk-ii-${ts}`,
            name: 'Laser Rifle!! Mk-II',
            category: 'weapon',
            subcategory: null,
            attributes: {},
            source: 'custom',
            thumbnail_url: 'https://cdn.example.com/a.PNG',
            wiki_url: null,
        }]);
        expect(first(q, 'select')).toEqual([CATALOG_COLS]);
        expect(broadcastToOrg).toHaveBeenCalledTimes(1);
        expect(broadcastToOrg).toHaveBeenCalledWith('qm:catalog_update', { catalogId: 77 });
        expect(out).toEqual(catItem(77, { name: 'Laser Rifle!! Mk-II' }));
    });

    it('nulls an unsafe thumbnail (non-https / script scheme / non-raster) and passes optional fields through', async () => {
        for (const bad of ['javascript:alert(1)//x.png', 'http://cdn.example.com/a.png', 'https://cdn.example.com/a.svg']) {
            queue('quartermaster_catalog', { data: catRow(1) });
            await createCatalogItem({
                name: 'x', category: 'armor', subcategory: 'helmet', attributes: { Grade: 'B' },
                thumbnailUrl: bad, wikiUrl: 'https://wiki/x',
            });
        }
        for (const q of settled('quartermaster_catalog')) {
            const ins = first(q, 'insert')![0] as Record<string, unknown>;
            expect(ins.thumbnail_url).toBeNull();
            expect(ins.subcategory).toBe('helmet');
            expect(ins.attributes).toEqual({ Grade: 'B' });
            expect(ins.wiki_url).toBe('https://wiki/x');
        }
    });

    it("falls back to an 'item' slug base for an all-punctuation name and caps the base at 80 chars", async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
        const ts = Date.now().toString(36);
        queue('quartermaster_catalog', { data: catRow(1) }, { data: catRow(2) });
        await createCatalogItem({ name: '!!!', category: 'misc' });
        await createCatalogItem({ name: 'a'.repeat(120), category: 'misc' });
        const [p, l] = settled('quartermaster_catalog').map((q) => (first(q, 'insert')![0] as { slug: string }).slug);
        expect(p).toBe(`item-${ts}`);
        expect(l).toBe(`${'a'.repeat(80)}-${ts}`);
    });

    it('throws the high-level message on insert failure and does NOT broadcast', async () => {
        queue('quartermaster_catalog', { error: PG_FAULT });
        await expect(createCatalogItem({ name: 'x', category: 'misc' })).rejects.toThrow(/^Failed to create catalog item$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// updateCatalogItem
// ===========================================================================
describe('updateCatalogItem', () => {
    it('patches only the supplied fields, sanitises the thumbnail, and is scoped to CUSTOM rows', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
        queue('quartermaster_catalog', { data: catRow(5, { name: 'New' }) });

        const out = await updateCatalogItem({
            id: 5, name: '  New  ', category: 'armor', subcategory: null, attributes: { Grade: 'C' },
            thumbnailUrl: 'data:image/png;base64,AAAA', wikiUrl: null,
        });

        const [q] = settled('quartermaster_catalog');
        expect(first(q, 'update')).toEqual([{
            updated_at: '2026-03-04T05:06:07.000Z',
            name: 'New', category: 'armor', subcategory: null, attributes: { Grade: 'C' },
            thumbnail_url: null, wiki_url: null,
        }]);
        expect(calls(q, 'eq')).toEqual([['id', 5], ['source', 'custom']]);
        expect(first(q, 'select')).toEqual([CATALOG_COLS]);
        expect(q.terminal).toBe('single');
        expect(broadcastToOrg).toHaveBeenCalledWith('qm:catalog_update', { catalogId: 5 });
        expect(out).toEqual(catItem(5, { name: 'New' }));
    });

    it('an id-only update writes just updated_at (no undefined keys reach the patch)', async () => {
        queue('quartermaster_catalog', { data: catRow(5) });
        await updateCatalogItem({ id: 5 });
        const patch = first(settled('quartermaster_catalog')[0], 'update')![0] as Record<string, unknown>;
        expect(Object.keys(patch)).toEqual(['updated_at']);
    });

    it('throws the high-level message on failure (e.g. a platform row matched nothing) and does NOT broadcast', async () => {
        queue('quartermaster_catalog', { error: { code: 'PGRST116', message: '0 rows' } });
        await expect(updateCatalogItem({ id: 5, name: 'x' })).rejects.toThrow(/^Failed to update catalog item$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// deleteCatalogItem
// ===========================================================================
describe('deleteCatalogItem', () => {
    it('snapshots the catalog name into name-less inventory, detaches, deletes the CUSTOM row, then broadcasts ids', async () => {
        queue('quartermaster_catalog', { data: { name: '  Plasma Rifle  ' } }, { data: null });
        queue('quartermaster_inventory',
            { data: [{ id: 11 }, { id: 12 }] }, // custom_name IS NULL snapshot
            { data: [{ id: 13 }] },             // custom_name = '' snapshot
            { data: [{ id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }] }, // detach
        );

        await deleteCatalogItem(3);

        expect(trace()).toEqual([
            'quartermaster_catalog:select',
            'quartermaster_inventory:update',
            'quartermaster_inventory:update',
            'quartermaster_inventory:update',
            'quartermaster_catalog:delete',
        ]);
        const [lookup, del] = settled('quartermaster_catalog');
        expect(first(lookup, 'select')).toEqual(['name']);
        expect(calls(lookup, 'eq')).toEqual([['id', 3], ['source', 'custom']]);
        expect(calls(del, 'eq')).toEqual([['id', 3], ['source', 'custom']]);

        const [snapNull, snapEmpty, detach] = settled('quartermaster_inventory');
        expect(first(snapNull, 'update')).toEqual([{ custom_name: 'Plasma Rifle' }]);
        expect(calls(snapNull, 'eq')).toEqual([['catalog_id', 3]]);
        expect(calls(snapNull, 'is')).toEqual([['custom_name', null]]);
        expect(first(snapNull, 'select')).toEqual(['id']);
        expect(first(snapEmpty, 'update')).toEqual([{ custom_name: 'Plasma Rifle' }]);
        expect(calls(snapEmpty, 'eq')).toEqual([['catalog_id', 3], ['custom_name', '']]);
        expect(first(detach, 'update')).toEqual([{ catalog_id: null }]);
        expect(calls(detach, 'eq')).toEqual([['catalog_id', 3]]);

        expect(broadcastToOrg.mock.calls).toEqual([
            ['qm:catalog_update', { catalogId: 3 }],
            ['qm:inventory_update', { inventoryIds: [11, 12, 13, 14] }], // de-duplicated
        ]);
    });

    it("uses 'Deleted catalog item' when the row is missing or its name is blank, and skips the inventory broadcast when nothing was touched", async () => {
        queue('quartermaster_catalog', { data: null }, { data: null }, { data: { name: '   ' } }, { data: null });
        await deleteCatalogItem(4);
        await deleteCatalogItem(5);
        const snaps = settled('quartermaster_inventory').filter((q) => calls(q, 'is').length || calls(q, 'eq').some(([c]) => c === 'custom_name'));
        expect(snaps.map((q) => first(q, 'update')![0])).toEqual([
            { custom_name: 'Deleted catalog item' }, { custom_name: 'Deleted catalog item' },
            { custom_name: 'Deleted catalog item' }, { custom_name: 'Deleted catalog item' },
        ]);
        expect(broadcastToOrg.mock.calls).toEqual([
            ['qm:catalog_update', { catalogId: 4 }],
            ['qm:catalog_update', { catalogId: 5 }],
        ]);
    });

    it('throws the high-level message when the delete fails and emits NO broadcast', async () => {
        queue('quartermaster_catalog', { data: { name: 'x' } }, { error: PG_FAULT });
        queue('quartermaster_inventory', { data: [{ id: 1 }] });
        await expect(deleteCatalogItem(3)).rejects.toThrow(/^Failed to delete catalog item$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// Locations
// ===========================================================================
describe('listQmLocations / getQmLocationById', () => {
    it('lists with an explicit column list, sort_order→name ordered, mapped', async () => {
        queue('quartermaster_locations', { data: [locRow(1), locRow(2, { type: null, sort_order: null, parent_id: 1 })] });
        const out = await listQmLocations();
        const [q] = settled('quartermaster_locations');
        expect(first(q, 'select')).toEqual([LOCATION_COLS]);
        expect(calls(q, 'order')).toEqual([['sort_order', { ascending: true }], ['name', { ascending: true }]]);
        expect(out).toEqual([locItem(1), locItem(2, { type: 'custom', sortOrder: 0, parentId: 1 })]);
    });

    it('list: [] on 42P01 or null data, high-level throw on any other error', async () => {
        queue('quartermaster_locations', { error: PG_MISSING }, { data: null }, { error: PG_FAULT });
        await expect(listQmLocations()).resolves.toEqual([]);
        await expect(listQmLocations()).resolves.toEqual([]);
        await expect(listQmLocations()).rejects.toThrow(/^Failed to load locations$/);
    });

    it('get-by-id: maps a hit, null on miss, THROWS on error', async () => {
        queue('quartermaster_locations', { data: locRow(8) }, { data: null }, { error: PG_FAULT });
        await expect(getQmLocationById(8)).resolves.toEqual(locItem(8));
        const [q] = settled('quartermaster_locations');
        expect(first(q, 'select')).toEqual([LOCATION_COLS]);
        expect(calls(q, 'eq')).toEqual([['id', 8]]);
        expect(q.terminal).toBe('maybeSingle');
        await expect(getQmLocationById(8)).resolves.toBeNull();
        await expect(getQmLocationById(8)).rejects.toThrow(/^Failed to get location slice$/);
    });
});

describe('createQmLocation', () => {
    it('collapses CR/LF (CSV row-injection defence), trims, applies defaults and broadcasts the id', async () => {
        queue('quartermaster_locations', { data: locRow(21, { name: 'Port Olisar Bay 2' }) });
        const out = await createQmLocation({ name: '  Port Olisar\r\n\r\nBay 2 ' });
        const [q] = settled('quartermaster_locations');
        expect(first(q, 'insert')).toEqual([{
            name: 'Port Olisar Bay 2', type: 'custom', parent_id: null, description: null, sort_order: 0,
        }]);
        expect(first(q, 'select')).toEqual([LOCATION_COLS]);
        expect(q.terminal).toBe('single');
        expect(broadcastToOrg.mock.calls).toEqual([['qm:location_update', { locationId: 21 }]]);
        expect(out).toEqual(locItem(21, { name: 'Port Olisar Bay 2' }));
    });

    it('passes supplied type/parent/description/sortOrder through', async () => {
        queue('quartermaster_locations', { data: locRow(1) });
        await createQmLocation({ name: 'A', type: 'ship', parentId: 4, description: 'd', sortOrder: 7 });
        expect(first(settled('quartermaster_locations')[0], 'insert')).toEqual([{
            name: 'A', type: 'ship', parent_id: 4, description: 'd', sort_order: 7,
        }]);
    });

    it('rejects a name that is empty after line-break collapsing, before any write', async () => {
        await expect(createQmLocation({ name: '\r\n \n' })).rejects.toThrow('Location name is required.');
        await expect(createQmLocation({ name: undefined as unknown as string })).rejects.toThrow('Location name is required.');
        expect(h.queries).toHaveLength(0);
    });

    it('throws the high-level message on insert failure without broadcasting', async () => {
        queue('quartermaster_locations', { error: PG_FAULT });
        await expect(createQmLocation({ name: 'A' })).rejects.toThrow(/^Failed to create location$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

describe('updateQmLocation', () => {
    it('patches only supplied fields (name line-break collapsed) and broadcasts the id', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-05-06T07:08:09.000Z'));
        queue('quartermaster_locations', { data: locRow(3, { name: 'A B' }) });
        const out = await updateQmLocation({ id: 3, name: 'A\nB', type: 'hangar', parentId: null, description: 'x', sortOrder: 2 });
        const [q] = settled('quartermaster_locations');
        expect(first(q, 'update')).toEqual([{
            updated_at: '2026-05-06T07:08:09.000Z', name: 'A B', type: 'hangar', parent_id: null, description: 'x', sort_order: 2,
        }]);
        expect(calls(q, 'eq')).toEqual([['id', 3]]);
        expect(first(q, 'select')).toEqual([LOCATION_COLS]);
        expect(broadcastToOrg.mock.calls).toEqual([['qm:location_update', { locationId: 3 }]]);
        expect(out).toEqual(locItem(3, { name: 'A B' }));
    });

    it('an id-only update writes just updated_at', async () => {
        queue('quartermaster_locations', { data: locRow(3) });
        await updateQmLocation({ id: 3 });
        expect(Object.keys(first(settled('quartermaster_locations')[0], 'update')![0] as object)).toEqual(['updated_at']);
    });

    it('throws the high-level message on failure without broadcasting', async () => {
        queue('quartermaster_locations', { error: PG_FAULT });
        await expect(updateQmLocation({ id: 3, name: 'x' })).rejects.toThrow(/^Failed to update location$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

describe('deleteQmLocation', () => {
    it('orphans inventory, tears warehouse rows down bottom-up (requests → movements → stock), deletes, then broadcasts ids', async () => {
        queue('quartermaster_inventory', { data: [{ id: 31 }, { id: 32 }] });
        queue('warehouse_stock', { data: [{ id: 501 }, { id: 502 }] }, { data: null });
        await deleteQmLocation(6);

        expect(trace()).toEqual([
            'quartermaster_inventory:update',
            'warehouse_stock:select',
            'warehouse_requests:delete',
            'warehouse_movements:delete',
            'warehouse_stock:delete',
            'quartermaster_locations:delete',
        ]);
        const [orphan] = settled('quartermaster_inventory');
        expect(first(orphan, 'update')).toEqual([{ location_id: null }]);
        expect(calls(orphan, 'eq')).toEqual([['location_id', 6]]);
        expect(first(orphan, 'select')).toEqual(['id']);

        const [stockList, stockDel] = settled('warehouse_stock');
        expect(first(stockList, 'select')).toEqual(['id']);
        expect(calls(stockList, 'eq')).toEqual([['location_id', 6]]);
        expect(calls(settled('warehouse_requests')[0], 'in')).toEqual([['stock_id', [501, 502]]]);
        expect(calls(settled('warehouse_movements')[0], 'in')).toEqual([['stock_id', [501, 502]]]);
        expect(calls(stockDel, 'in')).toEqual([['id', [501, 502]]]);
        expect(calls(settled('quartermaster_locations')[0], 'eq')).toEqual([['id', 6]]);

        expect(broadcastToOrg.mock.calls).toEqual([
            ['qm:location_update', { locationId: 6 }],
            ['qm:inventory_update', { inventoryIds: [31, 32] }],
            ['warehouse:stock_update', { locationId: 6 }],
            ['warehouse:request_update', { locationId: 6 }],
        ]);
    });

    it('with no dependants: no warehouse teardown, and only the location broadcast', async () => {
        await deleteQmLocation(6);
        expect(trace()).toEqual([
            'quartermaster_inventory:update', 'warehouse_stock:select', 'quartermaster_locations:delete',
        ]);
        expect(broadcastToOrg.mock.calls).toEqual([['qm:location_update', { locationId: 6 }]]);
    });

    it('stops BEFORE deleting anything when the warehouse stock lookup fails', async () => {
        queue('warehouse_stock', { error: PG_FAULT });
        await expect(deleteQmLocation(6)).rejects.toThrow(/^Failed to load warehouse stock for location$/);
        expect(trace()).toEqual(['quartermaster_inventory:update', 'warehouse_stock:select']);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });

    const STEPS: Array<[string, string, string[]]> = [
        ['warehouse_requests', 'Failed to delete withdrawal requests for location', ['warehouse_requests:delete']],
        ['warehouse_movements', 'Failed to delete movements for location', ['warehouse_requests:delete', 'warehouse_movements:delete']],
        ['warehouse_stock', 'Failed to delete warehouse stock for location', ['warehouse_requests:delete', 'warehouse_movements:delete', 'warehouse_stock:delete']],
    ];
    for (const [table, message, ran] of STEPS) {
        it(`aborts the teardown on a ${table} delete failure, never reaching the location delete`, async () => {
            queue('warehouse_stock', { data: [{ id: 9 }] });
            if (table === 'warehouse_stock') queue('warehouse_stock', { error: PG_FAULT });
            else queue(table, { error: PG_FAULT });
            await expect(deleteQmLocation(6)).rejects.toThrow(new RegExp(`^${message}$`));
            expect(trace()).toEqual(['quartermaster_inventory:update', 'warehouse_stock:select', ...ran]);
            expect(broadcastToOrg).not.toHaveBeenCalled();
        });
    }

    it('throws the high-level message when the location delete itself fails, with no broadcast', async () => {
        queue('quartermaster_locations', { error: { code: '23503', message: 'fk' } });
        await expect(deleteQmLocation(6)).rejects.toThrow(/^Failed to delete location$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });

    it('the inventory orphan step always runs first and its select is id-only', async () => {
        await deleteQmLocation(1);
        expect(chain(settled('quartermaster_inventory')[0])).toEqual(['update', 'eq', 'select']);
    });
});
