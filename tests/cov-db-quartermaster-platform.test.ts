import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/quartermaster.ts — the PLATFORM catalog (UEX-sourced, admin:config:catalog):
// categories, the paginated admin reads, the UEX item + attribute syncs, the
// admin edit/delete/merge paths and the duplicate report.
//
// The properties pinned here:
//  - Platform reads/writes are pinned to source='platform' so the admin surface can
//    never rewrite or delete an org's custom row, and the search term is allow-listed
//    before it is interpolated into a raw `.or()` grammar.
//  - The admin is the SECOND writer of the facet JSONB: the same FACETABLE_ATTR_KEYS
//    allow-list + markup strip + length cap applies as on ingest.
//  - The "still referenced" guards on delete FAIL CLOSED on a read error (the FKs
//    are ON DELETE SET NULL, so deleting anyway silently unlinks every dependant).
//  - The item sync aborts when it cannot read the existing categories, instead of
//    upserting every item with platform_category_id = null.

vi.mock('../lib/db/common', async () => (await import('./cov-db-quartermaster-harness')).commonMock);
vi.mock('../lib/db/uex', async () => (await import('./cov-db-quartermaster-harness')).uex);
vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    const hh = await import('./cov-db-quartermaster-harness');
    return { ...actual, log: { ...actual.log, child: () => hh.logSpy } };
});

import {
    h, queue, settled, calls, first, trace, resetHarness, logSpy, uex,
} from './cov-db-quartermaster-harness';
import {
    listPlatformItemCategories, updatePlatformItemCategory, deletePlatformItemCategory,
    getPlatformItemCatalog, getPlatformItemCatalogWithUsage, getPlatformItemCatalogCount,
    syncPlatformItemCatalog, updatePlatformItem, deletePlatformItem, mergePlatformItems,
    repairPlatformItemCatalogDuplicates, syncPlatformItemAttributes,
} from '../lib/db/quartermaster';

const CATEGORY_COLS = 'id, uex_category_id, uex_category_name, uex_section, display_name, sort_order, is_hidden, created_at, updated_at';
const PLATFORM_COLS = 'id, slug, name, category, subcategory, attributes, thumbnail_url, wiki_url, external_uuid, external_id, is_vehicle_item, is_commodity, is_harvestable, screenshot_url, store_url, company_name, vehicle_name, quality, size_label, color, color2, game_version, platform_category_id, last_synced_at, created_at, updated_at';
const PG_MISSING = { code: '42P01', message: 'relation does not exist' };
const PG_FAULT = { code: '08006', message: 'connection failure at 10.0.0.3' };
const NOW = '2026-09-10T11:12:13.000Z';

const platRow = (id: number, over: Record<string, unknown> = {}) => ({
    id, slug: `p-${id}`, name: `Plat ${id}`, category: 'weapon', subcategory: 'Rifles', attributes: { Grade: 'A' },
    thumbnail_url: null, wiki_url: null, external_uuid: `uuid-${id}`, external_id: 1000 + id,
    is_vehicle_item: false, is_commodity: null, is_harvestable: true, screenshot_url: null, store_url: null,
    company_name: 'Behring', vehicle_name: null, quality: 3, size_label: 'S1', color: null, color2: null,
    game_version: '4.0', platform_category_id: 2, last_synced_at: 'ls', created_at: 'c-at', updated_at: 'u-at',
    ...over,
});
const platItem = (id: number, over: Record<string, unknown> = {}) => ({
    id, slug: `p-${id}`, name: `Plat ${id}`, category: 'weapon', subcategory: 'Rifles', attributes: { Grade: 'A' },
    source: 'platform', thumbnailUrl: null, wikiUrl: null, externalUuid: `uuid-${id}`, externalId: 1000 + id,
    isVehicleItem: false, isCommodity: false, isHarvestable: true, screenshotUrl: null, storeUrl: null,
    companyName: 'Behring', vehicleName: null, quality: 3, sizeLabel: 'S1', color: null, color2: null,
    gameVersion: '4.0', platformCategoryId: 2, lastSyncedAt: 'ls', createdAt: 'c-at', updatedAt: 'u-at',
    ...over,
});

beforeEach(() => resetHarness());
afterEach(() => { vi.useRealTimers(); });

const freeze = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
};

// ===========================================================================
// Categories
// ===========================================================================
describe('listPlatformItemCategories', () => {
    it('reads enumerated columns, sort_order → display_name ordered, mapped with defaults', async () => {
        queue('quartermaster_platform_categories', { data: [
            { id: 1, uex_category_id: 10, uex_category_name: 'Rifles', uex_section: 'Weapons', display_name: 'Rifles', sort_order: 2, is_hidden: true, created_at: 'c', updated_at: 'u' },
            { id: 2, uex_category_id: 20, uex_category_name: 'Misc', uex_section: null, display_name: 'Misc', sort_order: null, is_hidden: null, created_at: 'c', updated_at: 'u' },
        ] });
        await expect(listPlatformItemCategories()).resolves.toEqual([
            { id: 1, uexCategoryId: 10, uexCategoryName: 'Rifles', uexSection: 'Weapons', displayName: 'Rifles', sortOrder: 2, isHidden: true, createdAt: 'c', updatedAt: 'u' },
            { id: 2, uexCategoryId: 20, uexCategoryName: 'Misc', uexSection: null, displayName: 'Misc', sortOrder: 0, isHidden: false, createdAt: 'c', updatedAt: 'u' },
        ]);
        const [q] = settled('quartermaster_platform_categories');
        expect(calls(q, 'select')).toEqual([[CATEGORY_COLS]]);
        expect(calls(q, 'order')).toEqual([['sort_order', { ascending: true }], ['display_name', { ascending: true }]]);
    });

    it('[] on 42P01 or null data; high-level throw on any other error', async () => {
        queue('quartermaster_platform_categories', { error: PG_MISSING }, { data: null }, { error: PG_FAULT });
        await expect(listPlatformItemCategories()).resolves.toEqual([]);
        await expect(listPlatformItemCategories()).resolves.toEqual([]);
        await expect(listPlatformItemCategories()).rejects.toThrow(/^Failed to load quartermaster platform categories$/);
    });
});

describe('updatePlatformItemCategory', () => {
    it('refuses an empty patch before any write', async () => {
        await expect(updatePlatformItemCategory(1, {})).rejects.toThrow('No updatable fields provided');
        expect(h.queries).toHaveLength(0);
    });

    it('stamps updated_at and updates by id', async () => {
        freeze();
        await updatePlatformItemCategory(4, { display_name: 'Guns', is_hidden: true });
        const [q] = settled('quartermaster_platform_categories');
        expect(calls(q, 'update')).toEqual([[{ display_name: 'Guns', is_hidden: true, updated_at: NOW }]]);
        expect(calls(q, 'eq')).toEqual([['id', 4]]);
    });

    it('throws the high-level message on failure', async () => {
        queue('quartermaster_platform_categories', { error: PG_FAULT });
        await expect(updatePlatformItemCategory(4, { display_name: 'x' })).rejects.toThrow(/^Failed to update quartermaster platform category$/);
    });
});

describe('deletePlatformItemCategory', () => {
    it('refuses while any catalog row still references the category (head count), without deleting', async () => {
        queue('quartermaster_catalog', { count: 3 });
        await expect(deletePlatformItemCategory(4)).rejects.toThrow('Cannot delete: 3 item row(s) reference this category. Reassign first.');
        const [q] = settled('quartermaster_catalog');
        expect(calls(q, 'select')).toEqual([['id', { count: 'exact', head: true }]]);
        expect(calls(q, 'eq')).toEqual([['platform_category_id', 4]]);
        expect(settled('quartermaster_platform_categories')).toHaveLength(0);
    });

    it('FAILS CLOSED when the reference count cannot be read (SET NULL FK would silently unlink every item)', async () => {
        queue('quartermaster_catalog', { error: PG_FAULT });
        await expect(deletePlatformItemCategory(4)).rejects.toThrow(/^Failed to check quartermaster platform category usage$/);
        expect(settled('quartermaster_platform_categories')).toHaveLength(0);
    });

    it('deletes by id when unreferenced (0 or null count); throws the high-level message on delete failure', async () => {
        queue('quartermaster_catalog', { count: 0 }, { count: null });
        queue('quartermaster_platform_categories', { data: null }, { error: PG_FAULT });
        await deletePlatformItemCategory(4);
        const [del] = settled('quartermaster_platform_categories');
        expect(calls(del, 'delete')).toEqual([[]]);
        expect(calls(del, 'eq')).toEqual([['id', 4]]);
        await expect(deletePlatformItemCategory(4)).rejects.toThrow(/^Failed to delete quartermaster platform category$/);
    });
});

// ===========================================================================
// Admin reads
// ===========================================================================
describe('getPlatformItemCatalog', () => {
    it('reads enumerated columns of PLATFORM rows only, name → id ordered, first page of 50, mapped', async () => {
        queue('quartermaster_catalog', { data: [platRow(1), platRow(2, { quality: '3', attributes: null })] });
        await expect(getPlatformItemCatalog()).resolves.toEqual([platItem(1), platItem(2, { quality: null, attributes: {} })]);
        const [q] = settled('quartermaster_catalog');
        expect(calls(q, 'select')).toEqual([[PLATFORM_COLS]]);
        expect(calls(q, 'eq')).toEqual([['source', 'platform']]);
        expect(calls(q, 'or')).toEqual([]);
        expect(calls(q, 'order')).toEqual([['name', { ascending: true }], ['id', { ascending: true }]]);
        expect(calls(q, 'range')).toEqual([[0, 49]]);
    });

    it('allow-lists the search term before the .or() grammar (no injected sibling conditions)', async () => {
        await getPlatformItemCatalog({ search: 'Beh,ring).or(source.eq.custom' });
        const [orArg] = first(settled('quartermaster_catalog')[0], 'or') as [string];
        expect(orArg).toBe('name.ilike.%Behringorsourceeqcustom%,subcategory.ilike.%Behringorsourceeqcustom%,company_name.ilike.%Behringorsourceeqcustom%');
    });

    it('a term that sanitises to nothing, or whitespace, applies no search filter', async () => {
        await getPlatformItemCatalog({ search: '%%' });
        await getPlatformItemCatalog({ search: '   ' });
        for (const q of settled('quartermaster_catalog')) expect(calls(q, 'or')).toEqual([]);
    });

    it('applies category (incl. 0) and hide-vehicle filters; clamps limit to [1, 500] and the offset', async () => {
        await getPlatformItemCatalog({ platformCategoryId: 0, hideVehicleItems: true, limit: 0, offset: 20 });
        await getPlatformItemCatalog({ limit: 9999, offset: -1 });
        const [a, b] = settled('quartermaster_catalog');
        expect(calls(a, 'eq')).toEqual([['source', 'platform'], ['platform_category_id', 0], ['is_vehicle_item', false]]);
        expect(calls(a, 'range')).toEqual([[20, 20]]);
        expect(calls(b, 'range')).toEqual([[0, 499]]);
    });

    it('[] on 42P01 or null data; high-level throw on any other error', async () => {
        queue('quartermaster_catalog', { error: PG_MISSING }, { data: null }, { error: PG_FAULT });
        await expect(getPlatformItemCatalog()).resolves.toEqual([]);
        await expect(getPlatformItemCatalog()).resolves.toEqual([]);
        await expect(getPlatformItemCatalog()).rejects.toThrow(/^Failed to load platform item catalog$/);
    });
});

describe('getPlatformItemCatalogWithUsage', () => {
    it('counts inventory references for the visible page only', async () => {
        queue('quartermaster_catalog', { data: [platRow(1), platRow(2), platRow(3)] });
        queue('quartermaster_inventory', { data: [{ catalog_id: 1 }, { catalog_id: 1 }, { catalog_id: 3 }, { catalog_id: null }] });
        const out = await getPlatformItemCatalogWithUsage({ search: 'x' });
        expect(out.map((i) => [i.id, i.usageCount])).toEqual([[1, 2], [2, 0], [3, 1]]);
        expect(out[0]).toEqual({ ...platItem(1), usageCount: 2 });
        const [q] = settled('quartermaster_inventory');
        expect(calls(q, 'select')).toEqual([['catalog_id']]);
        expect(calls(q, 'in')).toEqual([['catalog_id', [1, 2, 3]]]);
    });

    it('an empty page skips the usage read; a null usage payload reads as zero usage', async () => {
        await expect(getPlatformItemCatalogWithUsage()).resolves.toEqual([]);
        expect(settled('quartermaster_inventory')).toHaveLength(0);
        queue('quartermaster_catalog', { data: [platRow(1)] });
        expect((await getPlatformItemCatalogWithUsage())[0].usageCount).toBe(0);
    });
});

describe('getPlatformItemCatalogCount', () => {
    it('head:true exact count over the same filter shape as the list', async () => {
        queue('quartermaster_catalog', { count: 5600 });
        await expect(getPlatformItemCatalogCount({ search: 'rifle', platformCategoryId: 3, hideVehicleItems: true })).resolves.toBe(5600);
        const [q] = settled('quartermaster_catalog');
        expect(calls(q, 'select')).toEqual([['id', { count: 'exact', head: true }]]);
        expect(calls(q, 'eq')).toEqual([['source', 'platform'], ['platform_category_id', 3], ['is_vehicle_item', false]]);
        expect(calls(q, 'or')).toEqual([['name.ilike.%rifle%,subcategory.ilike.%rifle%,company_name.ilike.%rifle%']]);
    });

    it('no filters → just the source pin; garbage search → no .or()', async () => {
        await getPlatformItemCatalogCount();
        await getPlatformItemCatalogCount({ search: '()' });
        for (const q of settled('quartermaster_catalog')) {
            expect(calls(q, 'eq')).toEqual([['source', 'platform']]);
            expect(calls(q, 'or')).toEqual([]);
        }
    });

    it('0 on 42P01 or a null count; high-level throw on any other error', async () => {
        queue('quartermaster_catalog', { error: PG_MISSING }, { count: null }, { error: PG_FAULT });
        await expect(getPlatformItemCatalogCount()).resolves.toBe(0);
        await expect(getPlatformItemCatalogCount()).resolves.toBe(0);
        await expect(getPlatformItemCatalogCount()).rejects.toThrow(/^Failed to count platform items$/);
    });
});

// ===========================================================================
// syncPlatformItemCatalog
// ===========================================================================
describe('syncPlatformItemCatalog', () => {
    const cat = (id: number, name: string, section?: string | null) => ({ id, name, type: 'item', section });

    it('refreshes existing categories (preserving admin edits), inserts new ones, and upserts mapped items by external_uuid', async () => {
        freeze();
        const items = [{ name: 'A', uuid: 'u1' }, { name: 'B' }, { name: 'C', uuid: 'u3' }];
        uex.fetchAllUexItems.mockResolvedValue({ categories: [cat(10, 'Rifles', 'Weapons'), cat(20, 'Hats', '')], items, errors: [{ categoryId: 9, categoryName: 'X', message: 'm' }] });
        uex.mapUexItemToQmRow.mockImplementation((it: { uuid?: string; name: string }) => (it.uuid ? { external_uuid: it.uuid, name: it.name } : null));
        queue('quartermaster_platform_categories',
            { data: [{ id: 1, uex_category_id: 10, display_name: 'My Rifles' }] }, // existing read
            { data: null },                                                     // update of 10
            { data: { id: 2 } },                                                // insert of 20
        );

        const out = await syncPlatformItemCatalog();

        const [read, upd, ins] = settled('quartermaster_platform_categories');
        expect(calls(read, 'select')).toEqual([['id, uex_category_id, display_name']]);
        expect(calls(upd, 'update')).toEqual([[{ uex_category_name: 'Rifles', uex_section: 'Weapons', updated_at: NOW }]]); // no display_name
        expect(calls(upd, 'eq')).toEqual([['id', 1]]);
        expect(calls(ins, 'insert')).toEqual([[{ uex_category_id: 20, uex_category_name: 'Hats', uex_section: null, display_name: 'Hats' }]]);
        expect(calls(ins, 'select')).toEqual([['id']]);
        expect(ins.terminal).toBe('single');

        const lookup = uex.mapUexItemToQmRow.mock.calls[0][1] as Map<number, number>;
        expect([...lookup.entries()]).toEqual([[10, 1], [20, 2]]);
        const [ups] = settled('quartermaster_catalog');
        expect(calls(ups, 'upsert')).toEqual([[[{ external_uuid: 'u1', name: 'A' }, { external_uuid: 'u3', name: 'C' }], { onConflict: 'external_uuid' }]]);

        const expected = { itemsSynced: 2, itemsSkipped: 1, itemErrors: 0, categoriesInserted: 1, categoriesUpdated: 1, fetchErrors: [{ categoryId: 9, categoryName: 'X', message: 'm' }] };
        expect(out).toEqual(expected);
        expect(logSpy.info).toHaveBeenCalledWith('uex sync done', {
            itemsSynced: 2, itemsSkipped: 1, itemErrors: 0, categoriesInserted: 1, categoriesUpdated: 1, categoryFetchErrors: 1,
        });
    });

    it('ABORTS with no writes when the existing categories cannot be read (would otherwise null every item category)', async () => {
        uex.fetchAllUexItems.mockResolvedValue({ categories: [cat(10, 'Rifles')], items: [{ name: 'A', uuid: 'u1' }], errors: [] });
        uex.mapUexItemToQmRow.mockReturnValue({ external_uuid: 'u1', platform_category_id: null });
        queue('quartermaster_platform_categories', { error: PG_FAULT });
        await expect(syncPlatformItemCatalog()).rejects.toThrow(/^Failed to load quartermaster platform categories for sync$/);
        expect(trace()).toEqual(['quartermaster_platform_categories:select']);
        expect(uex.mapUexItemToQmRow).not.toHaveBeenCalled();
    });

    it('a failed category update still maps the FK but is not counted; a failed insert neither maps nor counts', async () => {
        uex.fetchAllUexItems.mockResolvedValue({ categories: [cat(10, 'Rifles'), cat(20, 'Hats')], items: [{ name: 'A', uuid: 'u1' }], errors: [] });
        uex.mapUexItemToQmRow.mockReturnValue({ external_uuid: 'u1' });
        queue('quartermaster_platform_categories',
            { data: [{ id: 1, uex_category_id: 10, display_name: 'R' }] },
            { error: PG_FAULT },
            { error: { code: '23505', message: 'dup' } },
        );
        const out = await syncPlatformItemCatalog();
        expect([...(uex.mapUexItemToQmRow.mock.calls[0][1] as Map<number, number>).entries()]).toEqual([[10, 1]]);
        expect(out).toMatchObject({ categoriesUpdated: 0, categoriesInserted: 0, itemsSynced: 1 });
    });

    it('a null existing-category payload means everything is new; an insert that returns no row is not counted', async () => {
        uex.fetchAllUexItems.mockResolvedValue({ categories: [cat(30, 'Boots')], items: [], errors: [] });
        queue('quartermaster_platform_categories', { data: null }, { data: null });
        const out = await syncPlatformItemCatalog();
        expect(trace()).toEqual(['quartermaster_platform_categories:select', 'quartermaster_platform_categories:insert']);
        expect(out).toEqual({ itemsSynced: 0, itemsSkipped: 0, itemErrors: 0, categoriesInserted: 0, categoriesUpdated: 0, fetchErrors: [] });
    });

    it('upserts in batches of 100; a failed batch falls back to per-row upserts, counting and logging (max 5) the bad rows', async () => {
        const items = Array.from({ length: 107 }, (_, i) => ({ name: `I${i}`, uuid: `u${i}` }));
        uex.fetchAllUexItems.mockResolvedValue({ categories: [], items, errors: [] });
        uex.mapUexItemToQmRow.mockImplementation((it: { uuid: string }) => ({ external_uuid: it.uuid }));
        // Batch 1 (100 rows) succeeds; batch 2 (7 rows) fails; per-row: rows u100..u106 → u100 ok, the other 6 fail.
        h.handlers['quartermaster_catalog'] = (q) => {
            const [payload] = first(q, 'upsert') as [unknown];
            if (Array.isArray(payload)) return payload.length === 100 ? { data: null } : { error: PG_FAULT };
            return (payload as { external_uuid: string }).external_uuid === 'u100' ? { data: null } : { error: { message: 'bad row' } };
        };
        const out = await syncPlatformItemCatalog();
        const ups = settled('quartermaster_catalog');
        expect(ups.map((q) => { const p = first(q, 'upsert')![0]; return Array.isArray(p) ? p.length : 'row'; }))
            .toEqual([100, 7, 'row', 'row', 'row', 'row', 'row', 'row', 'row']);
        expect(ups.every((q) => (first(q, 'upsert')![1] as { onConflict: string }).onConflict === 'external_uuid')).toBe(true);
        expect(out).toMatchObject({ itemsSynced: 101, itemErrors: 6, itemsSkipped: 0 });
        const warns = logSpy.warn.mock.calls.filter(([m]) => m === 'uex item upsert failed');
        expect(warns).toHaveLength(5);
        expect(warns[0][1]).toEqual({ name: 'I101', externalUuid: 'u101', error: 'bad row' });
    });

    it("logs the original item name, or '?' when the item had none", async () => {
        uex.fetchAllUexItems.mockResolvedValue({ categories: [], items: [{ name: '', uuid: 'u0' }], errors: [] });
        uex.mapUexItemToQmRow.mockReturnValue({ external_uuid: 'u0' });
        queue('quartermaster_catalog', { error: PG_FAULT }, { error: { message: 'e' } });
        await syncPlatformItemCatalog();
        expect(logSpy.warn).toHaveBeenCalledWith('uex item upsert failed', { name: '?', externalUuid: 'u0', error: 'e' });
    });
});

// ===========================================================================
// updatePlatformItem / deletePlatformItem / mergePlatformItems
// ===========================================================================
describe('updatePlatformItem', () => {
    it('re-applies the facet allow-list + markup strip + 60-char cap to an admin-supplied attributes JSONB', async () => {
        freeze();
        await updatePlatformItem(3, {
            name: 'N',
            attributes: { Grade: '<b>A</b>', Class: 7, 'Armor Class': null, Mass: '10kg', 'Weapon Type': 'x'.repeat(80), 'Weapon Class': '  ' },
        });
        const [q] = settled('quartermaster_catalog');
        expect(calls(q, 'update')).toEqual([[{
            name: 'N', attributes: { Grade: 'A', Class: '7', 'Weapon Type': 'x'.repeat(60) }, updated_at: NOW,
        }]]);
        expect(calls(q, 'eq')).toEqual([['id', 3], ['source', 'platform']]);
    });

    it('never writes a sync/identity key, and refuses a patch that carries nothing else', async () => {
        freeze();
        const identity = { id: 9, source: 'custom', created_at: 'x', slug: 's', external_uuid: 'u', external_id: 1, last_synced_at: 'y' };
        await updatePlatformItem(3, { ...identity, company_name: 'Behring' });
        expect(calls(settled('quartermaster_catalog')[0], 'update')).toEqual([[{ company_name: 'Behring', updated_at: NOW }]]);
        await expect(updatePlatformItem(3, identity)).rejects.toThrow('No updatable fields provided');
        expect(settled('quartermaster_catalog')).toHaveLength(1);
    });

    it('a non-object attributes value (string / array / null) is written as an empty object', async () => {
        for (const bad of ['Grade=A', [['Grade', 'A']], null]) {
            await updatePlatformItem(3, { attributes: bad });
        }
        expect(settled('quartermaster_catalog').map((q) => (first(q, 'update')![0] as { attributes: unknown }).attributes)).toEqual([{}, {}, {}]);
    });

    it('throws the high-level message on failure', async () => {
        queue('quartermaster_catalog', { error: PG_FAULT });
        await expect(updatePlatformItem(3, { name: 'x' })).rejects.toThrow(/^Failed to update platform item$/);
    });
});

describe('deletePlatformItem', () => {
    it('refuses while inventory references the item, without deleting', async () => {
        queue('quartermaster_inventory', { count: 2 });
        await expect(deletePlatformItem(8)).rejects.toThrow('Cannot delete: 2 inventory row(s) reference this item. Use merge to reassign them first.');
        const [q] = settled('quartermaster_inventory');
        expect(calls(q, 'select')).toEqual([['id', { count: 'exact', head: true }]]);
        expect(calls(q, 'eq')).toEqual([['catalog_id', 8]]);
        expect(settled('quartermaster_catalog')).toHaveLength(0);
    });

    it('FAILS CLOSED when the reference count cannot be read (SET NULL FK would silently detach stock)', async () => {
        queue('quartermaster_inventory', { error: PG_FAULT });
        await expect(deletePlatformItem(8)).rejects.toThrow(/^Failed to check platform item usage$/);
        expect(settled('quartermaster_catalog')).toHaveLength(0);
    });

    it('deletes the PLATFORM row by id when unreferenced; throws the high-level message on delete failure', async () => {
        queue('quartermaster_inventory', { count: 0 }, { count: null });
        queue('quartermaster_catalog', { data: null }, { error: PG_FAULT });
        await deletePlatformItem(8);
        const [del] = settled('quartermaster_catalog');
        expect(calls(del, 'delete')).toEqual([[]]);
        expect(calls(del, 'eq')).toEqual([['id', 8], ['source', 'platform']]);
        await expect(deletePlatformItem(8)).rejects.toThrow(/^Failed to delete platform item$/);
    });
});

describe('mergePlatformItems', () => {
    it('refuses a self-merge before any read', async () => {
        await expect(mergePlatformItems(4, 4)).rejects.toThrow('Cannot merge an item with itself');
        expect(h.queries).toHaveLength(0);
    });

    it('verifies both rows are platform rows, reassigns inventory, then deletes the loser (platform-pinned)', async () => {
        queue('quartermaster_catalog', { data: [{ id: 4, source: 'platform' }, { id: 5, source: 'platform' }] }, { data: null });
        await expect(mergePlatformItems(4, 5)).resolves.toEqual({ merged: true });
        expect(trace()).toEqual(['quartermaster_catalog:select', 'quartermaster_inventory:update', 'quartermaster_catalog:delete']);
        const [lookup, del] = settled('quartermaster_catalog');
        expect(calls(lookup, 'select')).toEqual([['id, source']]);
        expect(calls(lookup, 'in')).toEqual([['id', [4, 5]]]);
        const [re] = settled('quartermaster_inventory');
        expect(calls(re, 'update')).toEqual([[{ catalog_id: 4 }]]);
        expect(calls(re, 'eq')).toEqual([['catalog_id', 5]]);
        expect(calls(del, 'eq')).toEqual([['id', 5], ['source', 'platform']]);
    });

    it('refuses when a row is missing or is an org CUSTOM row — before touching inventory', async () => {
        queue('quartermaster_catalog', { data: [{ id: 4, source: 'platform' }] }, { data: [{ id: 4, source: 'platform' }, { id: 5, source: 'custom' }] }, { data: null });
        for (let i = 0; i < 3; i++) {
            await expect(mergePlatformItems(4, 5)).rejects.toThrow('Both items must exist and be platform rows.');
        }
        expect(settled('quartermaster_inventory')).toHaveLength(0);
    });

    it('fails closed at each step with the step-specific message', async () => {
        queue('quartermaster_catalog', { error: PG_FAULT });
        await expect(mergePlatformItems(4, 5)).rejects.toThrow(/^Failed to look up items to merge$/);

        resetHarness();
        queue('quartermaster_catalog', { data: [{ id: 4, source: 'platform' }, { id: 5, source: 'platform' }] });
        queue('quartermaster_inventory', { error: PG_FAULT });
        await expect(mergePlatformItems(4, 5)).rejects.toThrow(/^Failed to reassign inventory during merge$/);
        expect(trace()).toEqual(['quartermaster_catalog:select', 'quartermaster_inventory:update']); // loser NOT deleted

        resetHarness();
        queue('quartermaster_catalog', { data: [{ id: 4, source: 'platform' }, { id: 5, source: 'platform' }] }, { error: PG_FAULT });
        await expect(mergePlatformItems(4, 5)).rejects.toThrow(/^Failed to delete merged item$/);
    });
});

describe('repairPlatformItemCatalogDuplicates', () => {
    it('reports slug groups shared by more than one platform row (informational only, no writes)', async () => {
        queue('quartermaster_catalog', { data: [
            { id: 1, slug: 'a', name: 'A', external_uuid: 'u1' },
            { id: 2, slug: 'b', name: 'B', external_uuid: 'u2' },
            { id: 3, slug: 'a', name: 'A2', external_uuid: null },
        ] });
        await expect(repairPlatformItemCatalogDuplicates()).resolves.toEqual({
            groupsFound: 1,
            summary: ['Slug "a" used by 2 platform rows: id=1(uuid=u1), id=3(uuid=null)'],
        });
        const [q] = settled('quartermaster_catalog');
        expect(calls(q, 'select')).toEqual([['id, slug, name, external_uuid']]);
        expect(calls(q, 'eq')).toEqual([['source', 'platform']]);
        expect(trace()).toEqual(['quartermaster_catalog:select']);
    });

    it('no rows → no groups', async () => {
        await expect(repairPlatformItemCatalogDuplicates()).resolves.toEqual({ groupsFound: 0, summary: [] });
    });
});

// ===========================================================================
// syncPlatformItemAttributes
// ===========================================================================
describe('syncPlatformItemAttributes', () => {
    it('folds ONLY allow-listed, non-empty, sanitised attributes per item and updates platform rows by external_id', async () => {
        freeze();
        uex.fetchUexCategories.mockResolvedValue([
            { id: 1, name: 'Weapons', type: 'item' }, { id: 2, name: 'Services', type: 'service' }, { id: 3, name: 'Armor', type: 'item' },
        ]);
        uex.fetchUexItemAttributesForCategory.mockImplementation(async (id: number) => {
            if (id === 1) {
                return [
                    { id: 1, id_item: 100, attribute_name: 'Grade', value: '<b>A</b>' },
                    { id: 2, id_item: 100, attribute_name: 'Mass', value: '10' },          // not a facet
                    { id: 3, id_item: null, attribute_name: 'Grade', value: 'B' },         // no item
                    { id: 4, id_item: 101, attribute_name: '', value: 'B' },               // no name
                    { id: 5, id_item: 101, attribute_name: 'Class', value: null },         // empty value
                    { id: 6, id_item: 101, attribute_name: 'Weapon Type', value: 7 },
                    { id: 7, id_item: 100, attribute_name: 'Class', value: 'Military\nGrade' },
                ];
            }
            throw new Error('UEX 500');
        });

        const out = await syncPlatformItemAttributes();

        expect(uex.fetchUexItemAttributesForCategory.mock.calls).toEqual([[1], [3]]); // service category never fetched
        const ups = settled('quartermaster_catalog');
        expect(ups.map((q) => calls(q, 'update')[0][0])).toEqual([
            { attributes: { Grade: 'A', Class: 'Military Grade' }, updated_at: NOW },
            { attributes: { 'Weapon Type': '7' }, updated_at: NOW },
        ]);
        expect(ups.map((q) => calls(q, 'eq'))).toEqual([
            [['external_id', 100], ['source', 'platform']],
            [['external_id', 101], ['source', 'platform']],
        ]);
        expect(out).toEqual({
            categoriesScanned: 2, itemsUpdated: 2, itemErrors: 0, attributesKept: 3,
            fetchErrors: [{ categoryId: 3, categoryName: 'Armor', message: 'UEX 500' }],
        });
        expect(logSpy.warn).toHaveBeenCalledWith('item attributes category fetch failed', { categoryId: 3, message: 'UEX 500' });
        expect(logSpy.info).toHaveBeenCalledWith('platform item attributes synced', {
            categoriesScanned: 2, itemsUpdated: 2, itemErrors: 0, attributesKept: 3,
        });
    });

    it('records a non-Error rejection as its string form', async () => {
        uex.fetchUexCategories.mockResolvedValue([{ id: 4, name: 'Odd', type: 'item' }]);
        uex.fetchUexItemAttributesForCategory.mockRejectedValue('timeout');
        const out = await syncPlatformItemAttributes();
        expect(out.fetchErrors).toEqual([{ categoryId: 4, categoryName: 'Odd', message: 'timeout' }]);
        expect(settled('quartermaster_catalog')).toHaveLength(0);
    });

    it('counts per-row update failures separately and updates every item across 25-row chunks', async () => {
        uex.fetchUexCategories.mockResolvedValue([{ id: 1, name: 'W', type: 'item' }]);
        uex.fetchUexItemAttributesForCategory.mockResolvedValue(
            Array.from({ length: 27 }, (_, i) => ({ id: i, id_item: 500 + i, attribute_name: 'Grade', value: 'A' })),
        );
        h.handlers['quartermaster_catalog'] = (q) => {
            const extId = calls(q, 'eq').find(([c]) => c === 'external_id')![1];
            return extId === 503 || extId === 526 ? { error: PG_FAULT } : { data: null };
        };
        const out = await syncPlatformItemAttributes();
        expect(settled('quartermaster_catalog')).toHaveLength(27);
        expect(out).toMatchObject({ itemsUpdated: 25, itemErrors: 2, attributesKept: 27, categoriesScanned: 1 });
    });
});
