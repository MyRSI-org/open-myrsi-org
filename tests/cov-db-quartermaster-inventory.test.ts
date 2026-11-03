import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/quartermaster.ts — the INVENTORY half: the armoury list/count and their
// three search branches, facets, stock writes, the low-stock card and the CSV audit.
//
// The properties pinned here:
//  - The list read enumerates columns (rule 1); facet mode swaps to the INNER-join
//    projection; the count is a head:true query.
//  - Search input is sanitised before it reaches a raw `.or()` grammar (no sibling
//    condition injection) and a typed term that sanitises to nothing matches NOTHING
//    (`id.eq.0`) rather than falling through to the whole armoury.
//  - On-hand is summed from the movement log and FAILS CLOSED on a read error or a
//    server-truncated page; only 42P01 (no ledger yet) degrades.
//  - Stock writes validate before any RPC, call the transactional proc with the
//    exact args, and broadcast the inventory id only after success.

vi.mock('../lib/db/common', async () => (await import('./cov-db-quartermaster-harness')).commonMock);
vi.mock('../lib/db/uex', async () => (await import('./cov-db-quartermaster-harness')).uex);
vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    const hh = await import('./cov-db-quartermaster-harness');
    return { ...actual, log: { ...actual.log, child: () => hh.logSpy } };
});

import {
    h, queue, queueRpc, settled, calls, first, cols, resetHarness, broadcastToOrg, logSpy, type Query,
} from './cov-db-quartermaster-harness';
import {
    listInventory, listInventoryCount, getArmoryFacets, createInventoryItem, updateInventoryItem,
    adjustInventoryStock, setInventoryTotal, listLowStockInventory, csvEscapeQm, exportInventoryCsv,
    FACETABLE_ATTR_KEYS,
} from '../lib/db/quartermaster';
import { MAX_STOCK_TOTAL } from '../lib/stockLimits';

const ROW_COLS = 'id, catalog_id, custom_name, location_id, condition, acquired_at, notes, is_archived, created_at, updated_at';
const INVENTORY_SELECT = `${ROW_COLS}, catalog:quartermaster_catalog(id, slug, name, category, subcategory, thumbnail_url), location:quartermaster_locations(id, name, type)`;
const INVENTORY_SELECT_FACET = `${ROW_COLS}, catalog:quartermaster_catalog!inner(id, slug, name, category, subcategory, thumbnail_url, size_label, company_name, is_vehicle_item, quality, attributes), location:quartermaster_locations(id, name, type)`;
const INVENTORY_COUNT_FACET = 'id, catalog:quartermaster_catalog!inner(id, category, subcategory, size_label, company_name, is_vehicle_item, name, attributes)';
const PG_MISSING = { code: '42P01', message: 'relation does not exist' };
const PG_FAULT = { code: '08006', message: 'connection failure at 10.0.0.3' };

const invRow = (id: number, over: Record<string, unknown> = {}) => ({
    id, catalog_id: 100 + id, custom_name: null, location_id: 7, condition: 'used',
    acquired_at: 'acq', notes: null, is_archived: false, created_at: 'c-at', updated_at: 'u-at',
    catalog: { id: 100 + id, slug: `cat-${id}`, name: `Cat ${id}`, category: 'weapon', subcategory: 'rifle', thumbnail_url: null },
    location: { id: 7, name: 'Bay', type: 'station' },
    ...over,
});
const invItem = (id: number, over: Record<string, unknown> = {}) => ({
    id, catalogId: 100 + id,
    catalog: { id: 100 + id, slug: `cat-${id}`, name: `Cat ${id}`, category: 'weapon', subcategory: 'rifle', thumbnailUrl: null },
    customName: null, locationId: 7, location: { id: 7, name: 'Bay', type: 'station' },
    condition: 'used', acquiredAt: 'acq', notes: null, isArchived: false,
    quantityOnHand: 0, quantityOnIssue: 0, createdAt: 'c-at', updatedAt: 'u-at',
    ...over,
});

/** The ONE inventory query that was actually awaited (facet mode builds two). */
const invQ = (): Query => {
    const s = settled('quartermaster_inventory');
    expect(s).toHaveLength(1);
    return s[0];
};
const catQ = (): Query[] => settled('quartermaster_catalog');

beforeEach(() => resetHarness());
afterEach(() => { vi.useRealTimers(); });

// ===========================================================================
// listInventory — base read + quantities
// ===========================================================================
describe('listInventory — the default read', () => {
    it('selects the enumerated projection, hides archived rows, orders by a total order and pages 0..999', async () => {
        await listInventory();
        const q = invQ();
        expect(cols(first(q, 'select')![0])).toBe(INVENTORY_SELECT);
        expect(calls(q, 'eq')).toEqual([['is_archived', false]]);
        expect(calls(q, 'or')).toEqual([]);
        expect(calls(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(calls(q, 'range')).toEqual([[0, 999]]);
        // No search ⇒ no catalog id-resolution read.
        expect(catQ()).toHaveLength(0);
    });

    it('applies includeArchived / locationId (incl. 0) / catalogId filters exactly', async () => {
        await listInventory({ includeArchived: true, locationId: 0, catalogId: 55 });
        expect(calls(invQ(), 'eq')).toEqual([['location_id', 0], ['catalog_id', 55]]);
    });

    it('clamps limit into [1, 1000] and the offset to a non-negative integer', async () => {
        const cases: Array<[Record<string, unknown>, [number, number]]> = [
            [{ limit: 0 }, [0, 0]],
            [{ limit: 5000 }, [0, 999]],
            [{ limit: 25, offset: 50 }, [50, 74]],
            [{ limit: 10, offset: -5 }, [0, 9]],
            [{ limit: 10, offset: 2.9 }, [2, 11]],
            [{ limit: 10, offset: 'x' }, [0, 9]],
        ];
        for (const [opts, range] of cases) {
            resetHarness();
            await listInventory(opts);
            expect(calls(invQ(), 'range'), JSON.stringify(opts)).toEqual([range]);
        }
    });

    it('sums movement deltas and ACTIVE issuance quantities for exactly the returned ids', async () => {
        queue('quartermaster_inventory', { data: [invRow(1), invRow(2, { custom_name: 'Rope', catalog: null, catalog_id: null, location: null })] });
        queue('quartermaster_inventory_movements', {
            data: [{ inventory_id: 1, delta: 10 }, { inventory_id: 1, delta: '-3' }, { inventory_id: 2, delta: 4 }], count: 3,
        });
        queue('quartermaster_issuances', { data: [{ inventory_id: 1, quantity: 2 }, { inventory_id: 1, quantity: '1' }] });

        const out = await listInventory();

        const [mov] = settled('quartermaster_inventory_movements');
        expect(calls(mov, 'select')).toEqual([['inventory_id, delta', { count: 'exact' }]]);
        expect(calls(mov, 'in')).toEqual([['inventory_id', [1, 2]]]);
        const [iss] = settled('quartermaster_issuances');
        expect(calls(iss, 'select')).toEqual([['inventory_id, quantity']]);
        expect(calls(iss, 'in')).toEqual([['inventory_id', [1, 2]]]);
        expect(calls(iss, 'eq')).toEqual([['status', 'active']]);

        expect(out).toEqual([
            invItem(1, { quantityOnHand: 7, quantityOnIssue: 3 }),
            invItem(2, { catalogId: null, catalog: undefined, customName: 'Rope', location: undefined, quantityOnHand: 4, quantityOnIssue: 0 }),
        ]);
    });

    it('reads on-hand in 500-id chunks (URI-length bound) and sums across them', async () => {
        const rows = Array.from({ length: 501 }, (_, i) => invRow(i + 1));
        queue('quartermaster_inventory', { data: rows });
        h.handlers['quartermaster_inventory_movements'] = (q) => {
            const ids = first(q, 'in')![1] as number[];
            return { data: ids.map((id) => ({ inventory_id: id, delta: 2 })), count: ids.length };
        };
        const out = await listInventory();
        const movs = settled('quartermaster_inventory_movements');
        expect(movs.map((m) => (first(m, 'in')![1] as number[]).length)).toEqual([500, 1]);
        expect((first(movs[1], 'in')![1] as number[])).toEqual([501]);
        expect(out).toHaveLength(501);
        expect(out.every((r) => r.quantityOnHand === 2)).toBe(true);
    });

    it('returns [] on 42P01 and does not run the aggregate reads', async () => {
        queue('quartermaster_inventory', { error: PG_MISSING });
        await expect(listInventory()).resolves.toEqual([]);
        expect(settled('quartermaster_inventory_movements')).toHaveLength(0);
    });

    it('throws the high-level message on any other inventory read error', async () => {
        queue('quartermaster_inventory', { error: PG_FAULT });
        await expect(listInventory()).rejects.toThrow(/^Failed to load inventory$/);
    });

    it('an empty page short-circuits: no movement or issuance read', async () => {
        queue('quartermaster_inventory', { data: [] });
        await expect(listInventory()).resolves.toEqual([]);
        expect(settled('quartermaster_inventory_movements')).toHaveLength(0);
        expect(settled('quartermaster_issuances')).toHaveLength(0);
    });

    it('pre-migration movement ledger (42P01): reports 0 on hand with a warning, still reads issuances', async () => {
        queue('quartermaster_inventory', { data: [invRow(1)] });
        queue('quartermaster_inventory_movements', { error: PG_MISSING });
        queue('quartermaster_issuances', { data: [{ inventory_id: 1, quantity: 4 }] });
        const out = await listInventory();
        expect(out).toEqual([invItem(1, { quantityOnHand: 0, quantityOnIssue: 4 })]);
        expect(logSpy.warn).toHaveBeenCalledWith('inventory list: movements table not present — quantities reported as 0');
    });

    it('FAILS CLOSED when the movement log was silently truncated by the server row cap', async () => {
        queue('quartermaster_inventory', { data: [invRow(1)] });
        queue('quartermaster_inventory_movements', { data: [{ inventory_id: 1, delta: 1 }], count: 9 });
        await expect(listInventory()).rejects.toThrow('Failed to compute on-hand quantity: the movement log was truncated by the server row cap');
    });

    it('a full page with a matching exact count is accepted (the cap check is strict)', async () => {
        queue('quartermaster_inventory', { data: [invRow(1)] });
        queue('quartermaster_inventory_movements', { data: [{ inventory_id: 1, delta: 6 }], count: 1 });
        expect((await listInventory())[0].quantityOnHand).toBe(6);
    });

    it('pre-migration issuance table (42P01): reports 0 on issue with a warning', async () => {
        queue('quartermaster_inventory', { data: [invRow(1)] });
        queue('quartermaster_inventory_movements', { data: [{ inventory_id: 1, delta: 3 }] });
        queue('quartermaster_issuances', { error: PG_MISSING });
        const out = await listInventory();
        expect(out[0]).toMatchObject({ quantityOnHand: 3, quantityOnIssue: 0 });
        expect(logSpy.warn).toHaveBeenCalledWith('inventory list: issuances table not present — on-issue reported as 0');
    });

    it('FAILS CLOSED on any other issuance read error (quantity_on_issue is an audit column, not a badge)', async () => {
        queue('quartermaster_inventory', { data: [invRow(1)] });
        queue('quartermaster_inventory_movements', { data: [{ inventory_id: 1, delta: 3 }] });
        queue('quartermaster_issuances', { error: PG_FAULT });
        await expect(listInventory()).rejects.toThrow(/^Failed to load active issuances for inventory$/);
        expect(logSpy.warn).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// listInventory — default-mode search (catalog id resolution + .or())
// ===========================================================================
describe('listInventory — default-mode search', () => {
    it('resolves catalog-name matches into a capped, deterministic id set and ORs it with the custom_name leg', async () => {
        queue('quartermaster_catalog', { data: [{ id: 7 }, { id: 8 }] });
        await listInventory({ search: '  rifle ' });
        const [c] = catQ();
        expect(calls(c, 'select')).toEqual([['id']]);
        expect(calls(c, 'ilike')).toEqual([['name', '%rifle%']]);
        expect(calls(c, 'order')).toEqual([['id', { ascending: true }]]);
        expect(calls(c, 'limit')).toEqual([[500]]);
        expect(calls(invQ(), 'or')).toEqual([['custom_name.ilike.%rifle%,catalog_id.in.(7,8)']]);
    });

    it('with no catalog matches the filter is the custom_name leg alone', async () => {
        queue('quartermaster_catalog', { data: [] });
        await listInventory({ search: 'rope' });
        expect(calls(invQ(), 'or')).toEqual([['custom_name.ilike.%rope%']]);
    });

    it('strips .or() grammar characters from the term — a crafted search cannot inject sibling conditions', async () => {
        await listInventory({ search: 'x%,id.gt.0),is_archived.eq.true' });
        const [orArg] = first(invQ(), 'or') as [string];
        // Exactly one condition survives: our own custom_name leg, with the punctuation gone.
        expect(orArg).toBe('custom_name.ilike.%xidgt0is_archivedeqtrue%');
        expect(orArg.split(',')).toHaveLength(1);
    });

    it('LIKE-escapes the catalog leg while the .or() leg carries the unescaped allow-listed term', async () => {
        await listInventory({ search: 'a_b' });
        expect(calls(catQ()[0], 'ilike')).toEqual([['name', '%a\\_b%']]);
        expect(calls(invQ(), 'or')).toEqual([['custom_name.ilike.%a_b%']]);
    });

    it('a typed term that sanitises to nothing matches NOTHING (id.eq.0) — never the whole armoury — and skips the catalog read', async () => {
        await listInventory({ search: '%%%' });
        expect(calls(invQ(), 'or')).toEqual([['id.eq.0']]);
        expect(catQ()).toHaveLength(0);
    });

    it('a whitespace-only search is treated as no search', async () => {
        await listInventory({ search: '   ' });
        expect(calls(invQ(), 'or')).toEqual([]);
        expect(catQ()).toHaveLength(0);
    });

    it('fails closed when catalog-match resolution errors (other than 42P01)', async () => {
        queue('quartermaster_catalog', { error: PG_FAULT });
        await expect(listInventory({ search: 'rifle' })).rejects.toThrow(/^Failed to resolve catalog matches for search$/);
        expect(settled('quartermaster_inventory')).toHaveLength(0);
    });

    it('tolerates a missing catalog table (42P01) by searching custom names only', async () => {
        queue('quartermaster_catalog', { error: PG_MISSING });
        await listInventory({ search: 'rifle' });
        expect(calls(invQ(), 'or')).toEqual([['custom_name.ilike.%rifle%']]);
    });
});

// ===========================================================================
// listInventory — facet mode
// ===========================================================================
describe('listInventory — facet mode', () => {
    it('a single facet switches to the INNER-join projection and filters the embedded column; no .or()/catalog read', async () => {
        await listInventory({ category: 'weapon' });
        const q = invQ();
        expect(cols(first(q, 'select')![0])).toBe(INVENTORY_SELECT_FACET);
        expect(calls(q, 'eq')).toEqual([['is_archived', false], ['catalog.category', 'weapon']]);
        expect(calls(q, 'or')).toEqual([]);
        expect(calls(q, 'ilike')).toEqual([]);
        expect(catQ()).toHaveLength(0);
    });

    it('every facet maps to its embedded column; attributes become a JSONB containment', async () => {
        await listInventory({
            category: 'armor', subcategory: 'helmet', sizeLabel: 'S2', manufacturer: 'Behring', itemKind: 'vehicle',
            attributes: { Grade: 'A', Class: 'Military' },
        });
        const q = invQ();
        expect(calls(q, 'eq')).toEqual([
            ['is_archived', false],
            ['catalog.category', 'armor'], ['catalog.subcategory', 'helmet'], ['catalog.size_label', 'S2'],
            ['catalog.company_name', 'Behring'], ['catalog.is_vehicle_item', true],
        ]);
        expect(calls(q, 'contains')).toEqual([['catalog.attributes', { Grade: 'A', Class: 'Military' }]]);
    });

    it("itemKind 'personal' filters is_vehicle_item = false", async () => {
        await listInventory({ itemKind: 'personal' });
        expect(calls(invQ(), 'eq')).toEqual([['is_archived', false], ['catalog.is_vehicle_item', false]]);
    });

    it('an attribute facet alone activates facet mode; an EMPTY attributes object does not', async () => {
        await listInventory({ attributes: { Grade: 'B' } });
        expect(cols(first(invQ(), 'select')![0])).toBe(INVENTORY_SELECT_FACET);
        resetHarness();
        await listInventory({ attributes: {} });
        expect(cols(first(invQ(), 'select')![0])).toBe(INVENTORY_SELECT);
        expect(calls(invQ(), 'contains')).toEqual([]);
    });

    it('facet + search goes straight at catalog.name (uncapped), LIKE-escaped', async () => {
        await listInventory({ category: 'weapon', search: ' a_b ' });
        expect(calls(invQ(), 'ilike')).toEqual([['catalog.name', '%a\\_b%']]);
        expect(catQ()).toHaveLength(0);
    });

    it('facet + a term that sanitises to nothing matches NOTHING (id = 0)', async () => {
        await listInventory({ manufacturer: 'X', search: '%%' });
        const q = invQ();
        expect(calls(q, 'eq')).toContainEqual(['id', 0]);
        expect(calls(q, 'ilike')).toEqual([]);
    });
});

// ===========================================================================
// listInventory — misc-inclusive mode
// ===========================================================================
describe("listInventory — 'misc' category also surfaces free-text stock", () => {
    it('keeps the LEFT-join projection and ORs catalog-less rows with misc catalog ids', async () => {
        queue('quartermaster_catalog', { data: [{ id: 3 }, { id: 4 }] });
        await listInventory({ category: 'misc' });
        const q = invQ();
        expect(cols(first(q, 'select')![0])).toBe(INVENTORY_SELECT);
        expect(calls(q, 'or')).toEqual([['catalog_id.is.null,catalog_id.in.(3,4)']]);
        expect(calls(q, 'eq')).toEqual([['is_archived', false]]); // NOT catalog.category — that would drop free text
        const [c] = catQ();
        expect(calls(c, 'select')).toEqual([['id']]);
        expect(calls(c, 'eq')).toEqual([['category', 'misc']]);
        expect(calls(c, 'ilike')).toEqual([]);
        expect(calls(c, 'order')).toEqual([['source', { ascending: true }], ['id', { ascending: true }]]);
        expect(calls(c, 'limit')).toEqual([[500]]);
    });

    it('folds a search term into BOTH branches', async () => {
        queue('quartermaster_catalog', { data: [{ id: 3 }] });
        await listInventory({ category: 'misc', search: 'rope_x' });
        expect(calls(catQ()[0], 'ilike')).toEqual([['name', '%rope\\_x%']]);
        expect(calls(invQ(), 'or')).toEqual([['and(catalog_id.is.null,custom_name.ilike.%rope_x%),catalog_id.in.(3)']]);
    });

    it('with no misc catalog rows only the catalog-less branch remains', async () => {
        await listInventory({ category: 'misc' });
        expect(calls(invQ(), 'or')).toEqual([['catalog_id.is.null']]);
    });

    it('a typed term that sanitises to nothing matches NOTHING and skips the catalog read', async () => {
        await listInventory({ category: 'misc', search: '((' });
        expect(calls(invQ(), 'or')).toEqual([['id.eq.0']]);
        expect(catQ()).toHaveLength(0);
    });

    it('misc plus any other facet is ordinary facet mode (catalogued stock only)', async () => {
        await listInventory({ category: 'misc', subcategory: 'tools' });
        const q = invQ();
        expect(cols(first(q, 'select')![0])).toBe(INVENTORY_SELECT_FACET);
        expect(calls(q, 'eq')).toEqual([['is_archived', false], ['catalog.category', 'misc'], ['catalog.subcategory', 'tools']]);
        expect(calls(q, 'or')).toEqual([]);
    });

    it('fails closed on a misc catalog read error; tolerates 42P01', async () => {
        queue('quartermaster_catalog', { error: PG_FAULT });
        await expect(listInventory({ category: 'misc' })).rejects.toThrow(/^Failed to resolve misc catalog matches$/);
        resetHarness();
        queue('quartermaster_catalog', { error: PG_MISSING });
        await listInventory({ category: 'misc' });
        expect(calls(invQ(), 'or')).toEqual([['catalog_id.is.null']]);
    });
});

// ===========================================================================
// listInventoryCount
// ===========================================================================
describe('listInventoryCount', () => {
    it('is a head:true exact count over the default filters and returns the count', async () => {
        queue('quartermaster_inventory', { count: 42 });
        await expect(listInventoryCount()).resolves.toBe(42);
        const q = invQ();
        expect(calls(q, 'select')).toEqual([['id', { count: 'exact', head: true }]]);
        expect(calls(q, 'eq')).toEqual([['is_archived', false]]);
    });

    it('applies includeArchived / location / catalog filters like the list', async () => {
        await listInventoryCount({ includeArchived: true, locationId: 2, catalogId: 0 });
        expect(calls(invQ(), 'eq')).toEqual([['location_id', 2], ['catalog_id', 0]]);
    });

    it('facet mode counts through the inner-join projection with identical facet filters', async () => {
        await listInventoryCount({ sizeLabel: 'S1', itemKind: 'personal', attributes: { Grade: 'C' }, search: 'mk' });
        const q = invQ();
        expect(calls(q, 'select')).toEqual([[INVENTORY_COUNT_FACET, { count: 'exact', head: true }]]);
        expect(calls(q, 'eq')).toEqual([['is_archived', false], ['catalog.size_label', 'S1'], ['catalog.is_vehicle_item', false]]);
        expect(calls(q, 'contains')).toEqual([['catalog.attributes', { Grade: 'C' }]]);
        expect(calls(q, 'ilike')).toEqual([['catalog.name', '%mk%']]);
    });

    it('facet + garbage term counts NOTHING (id = 0)', async () => {
        await listInventoryCount({ category: 'weapon', search: '!!' });
        expect(calls(invQ(), 'eq')).toContainEqual(['id', 0]);
    });

    it('misc-inclusive and default search use the same .or() filters as the list', async () => {
        queue('quartermaster_catalog', { data: [{ id: 5 }] });
        await listInventoryCount({ category: 'misc' });
        expect(calls(invQ(), 'or')).toEqual([['catalog_id.is.null,catalog_id.in.(5)']]);
        resetHarness();
        queue('quartermaster_catalog', { data: [{ id: 6 }] });
        await listInventoryCount({ search: 'gun' });
        expect(calls(invQ(), 'or')).toEqual([['custom_name.ilike.%gun%,catalog_id.in.(6)']]);
    });

    it('0 on 42P01 or a null count; high-level throw on any other error', async () => {
        queue('quartermaster_inventory', { error: PG_MISSING }, { count: null }, { error: PG_FAULT });
        await expect(listInventoryCount()).resolves.toBe(0);
        await expect(listInventoryCount()).resolves.toBe(0);
        await expect(listInventoryCount()).rejects.toThrow(/^Failed to count inventory$/);
    });
});

// ===========================================================================
// getArmoryFacets
// ===========================================================================
describe('getArmoryFacets', () => {
    const EMPTY = { categories: [], types: [], sizes: [], manufacturers: [], hasVehicle: false, hasPersonal: false, attributes: {} };

    it('calls the SQL aggregate with the archived flag coerced to a boolean', async () => {
        await getArmoryFacets();
        await getArmoryFacets({ includeArchived: true });
        expect(h.rpcCalls).toEqual([
            { fn: 'qm_armoury_facets', args: { p_include_archived: false } },
            { fn: 'qm_armoury_facets', args: { p_include_archived: true } },
        ]);
    });

    it('soft-fails to empty facets with a warning when the aggregate errors', async () => {
        queueRpc('qm_armoury_facets', { error: { code: '42883', message: 'function does not exist' } });
        await expect(getArmoryFacets()).resolves.toEqual(EMPTY);
        expect(logSpy.warn).toHaveBeenCalledWith('armoury facets unavailable', { code: '42883', message: 'function does not exist' });
    });

    it('null data maps to empty facets', async () => {
        await expect(getArmoryFacets()).resolves.toEqual(EMPTY);
    });

    it('keeps only string values, only allow-listed attribute keys, and only literal-true booleans', async () => {
        queueRpc('qm_armoury_facets', {
            data: {
                categories: ['weapon', 7, null, 'armor'],
                types: 'not-an-array',
                sizes: ['S1'],
                manufacturers: ['Behring', { x: 1 }],
                hasVehicle: 'true',
                hasPersonal: true,
                attributes: { Grade: ['A', 2, 'B'], Class: [], Mass: ['10kg'], __proto__x: ['p'], 'Weapon Type': 'Rifle' },
            },
        });
        await expect(getArmoryFacets()).resolves.toEqual({
            categories: ['weapon', 'armor'],
            types: [],
            sizes: ['S1'],
            manufacturers: ['Behring'],
            hasVehicle: false,
            hasPersonal: true,
            attributes: { Grade: ['A', 'B'] },
        });
    });

    it('ignores an attributes payload that is an array rather than an object', async () => {
        queueRpc('qm_armoury_facets', { data: { attributes: [['Grade', ['A']]], hasVehicle: true } });
        await expect(getArmoryFacets()).resolves.toEqual({ ...EMPTY, hasVehicle: true });
    });

    it('the allow-list is exactly the five enum facets', () => {
        expect([...FACETABLE_ATTR_KEYS]).toEqual(['Grade', 'Class', 'Armor Class', 'Weapon Class', 'Weapon Type']);
    });
});

// ===========================================================================
// createInventoryItem
// ===========================================================================
describe('createInventoryItem', () => {
    it('requires a catalog item or a non-blank custom name, before any write', async () => {
        await expect(createInventoryItem(1, { customName: '   ', initialQuantity: 1 })).rejects.toThrow('Select a catalog item or provide a custom name.');
        await expect(createInventoryItem(1, { catalogId: 0, initialQuantity: 1 })).rejects.toThrow('Select a catalog item or provide a custom name.');
        await expect(createInventoryItem(1, { catalogId: null, customName: null, initialQuantity: 1 })).rejects.toThrow('Select a catalog item or provide a custom name.');
        expect(h.queries).toHaveLength(0);
    });

    it('rejects a negative, non-numeric or non-finite initial quantity, before any write', async () => {
        for (const bad of [-1, Number.NaN, 'abc', Infinity]) {
            await expect(createInventoryItem(1, { catalogId: 3, initialQuantity: bad as number }))
                .rejects.toThrow('Initial quantity must be a non-negative integer.');
        }
        expect(h.queries).toHaveLength(0);
    });

    it('inserts the row, seeds an initial movement attributed to the actor (truncated), and broadcasts the id', async () => {
        queue('quartermaster_inventory', { data: invRow(41, { custom_name: 'Medpen', catalog: null, catalog_id: null }) });
        const out = await createInventoryItem(9, { customName: '  Medpen  ', locationId: 7, condition: 'used', initialQuantity: 3.9, notes: 'n' });

        const [ins] = settled('quartermaster_inventory');
        expect(first(ins, 'insert')).toEqual([{
            catalog_id: null, custom_name: 'Medpen', location_id: 7, condition: 'used', notes: 'n',
        }]);
        expect(cols(first(ins, 'select')![0])).toBe(INVENTORY_SELECT);
        expect(ins.terminal).toBe('single');
        const [mov] = settled('quartermaster_inventory_movements');
        expect(first(mov, 'insert')).toEqual([{ inventory_id: 41, delta: 3, reason: 'initial', actor_user_id: 9 }]);
        expect(broadcastToOrg.mock.calls).toEqual([['qm:inventory_update', { inventoryId: 41 }]]);
        expect(out).toEqual(invItem(41, {
            catalogId: null, catalog: undefined, customName: 'Medpen', quantityOnHand: 3, quantityOnIssue: 0,
        }));
    });

    it('catalog-sourced stock with zero quantity: defaults applied, blank custom name nulled, NO movement row', async () => {
        queue('quartermaster_inventory', { data: invRow(42) });
        const out = await createInventoryItem(9, { catalogId: 142, customName: '  ', initialQuantity: 0 });
        expect(first(settled('quartermaster_inventory')[0], 'insert')).toEqual([{
            catalog_id: 142, custom_name: null, location_id: null, condition: 'pristine', notes: null,
        }]);
        expect(settled('quartermaster_inventory_movements')).toHaveLength(0);
        expect(out.quantityOnHand).toBe(0);
    });

    it('throws the high-level message on insert error, and when the insert returns no row', async () => {
        queue('quartermaster_inventory', { error: PG_FAULT }, { data: null });
        await expect(createInventoryItem(9, { catalogId: 1, initialQuantity: 1 })).rejects.toThrow(/^Failed to create inventory item$/);
        await expect(createInventoryItem(9, { catalogId: 1, initialQuantity: 1 })).rejects.toThrow(/^Failed to create inventory item$/);
        expect(settled('quartermaster_inventory_movements')).toHaveLength(0);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });

    it('throws when the initial movement cannot be recorded, without broadcasting', async () => {
        queue('quartermaster_inventory', { data: invRow(43) });
        queue('quartermaster_inventory_movements', { error: PG_FAULT });
        await expect(createInventoryItem(9, { catalogId: 1, initialQuantity: 2 })).rejects.toThrow(/^Failed to record initial stock$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// updateInventoryItem / adjustInventoryStock / setInventoryTotal
// ===========================================================================
describe('updateInventoryItem', () => {
    it('patches only supplied fields, scoped by id, and broadcasts the id', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-02-03T04:05:06.000Z'));
        await updateInventoryItem({ id: 4, locationId: null, condition: 'damaged', notes: 'x', customName: 'N', isArchived: true });
        const [q] = settled('quartermaster_inventory');
        expect(first(q, 'update')).toEqual([{
            updated_at: '2026-02-03T04:05:06.000Z', location_id: null, condition: 'damaged', notes: 'x', custom_name: 'N', is_archived: true,
        }]);
        expect(calls(q, 'eq')).toEqual([['id', 4]]);
        expect(broadcastToOrg.mock.calls).toEqual([['qm:inventory_update', { inventoryId: 4 }]]);
    });

    it('an id-only update writes just updated_at', async () => {
        await updateInventoryItem({ id: 4 });
        expect(Object.keys(first(settled('quartermaster_inventory')[0], 'update')![0] as object)).toEqual(['updated_at']);
    });

    it('throws the high-level message on failure without broadcasting', async () => {
        queue('quartermaster_inventory', { error: PG_FAULT });
        await expect(updateInventoryItem({ id: 4, notes: 'x' })).rejects.toThrow(/^Failed to update inventory item$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

describe('adjustInventoryStock', () => {
    it('rejects a zero / non-numeric / sub-unit delta before calling the proc', async () => {
        for (const bad of [0, 0.4, -0.9, Number.NaN, 'x', Infinity]) {
            await expect(adjustInventoryStock(1, { inventoryId: 2, delta: bad as number, reason: 'adjust' }))
                .rejects.toThrow('Adjustment delta must be a non-zero integer.');
        }
        expect(h.rpcCalls).toEqual([]);
    });

    it('calls qm_adjust_inventory with the truncated delta and the actor, then broadcasts the id', async () => {
        await adjustInventoryStock(5, { inventoryId: 2, delta: -2.9, reason: 'loss' });
        await adjustInventoryStock(5, { inventoryId: 3, delta: 4, reason: 'destruction', notes: 'boom' });
        expect(h.rpcCalls).toEqual([
            { fn: 'qm_adjust_inventory', args: { p_inventory_id: 2, p_delta: -2, p_reason: 'loss', p_actor_id: 5, p_notes: null } },
            { fn: 'qm_adjust_inventory', args: { p_inventory_id: 3, p_delta: 4, p_reason: 'destruction', p_actor_id: 5, p_notes: 'boom' } },
        ]);
        expect(broadcastToOrg.mock.calls).toEqual([
            ['qm:inventory_update', { inventoryId: 2 }], ['qm:inventory_update', { inventoryId: 3 }],
        ]);
    });

    it('surfaces a proc failure (e.g. QM_INSUFFICIENT_STOCK) as the high-level message, no broadcast', async () => {
        queueRpc('qm_adjust_inventory', { error: { message: 'QM_INSUFFICIENT_STOCK' } });
        await expect(adjustInventoryStock(5, { inventoryId: 2, delta: -9, reason: 'adjust' })).rejects.toThrow(/^Failed to adjust stock$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

describe('setInventoryTotal', () => {
    it('rejects negative / non-numeric totals and totals above MAX_STOCK_TOTAL before calling the proc', async () => {
        await expect(setInventoryTotal(1, { inventoryId: 2, targetTotal: -1, reason: 'adjust' })).rejects.toThrow('Target total must be a non-negative integer.');
        await expect(setInventoryTotal(1, { inventoryId: 2, targetTotal: Number.NaN, reason: 'adjust' })).rejects.toThrow('Target total must be a non-negative integer.');
        await expect(setInventoryTotal(1, { inventoryId: 2, targetTotal: MAX_STOCK_TOTAL + 1, reason: 'adjust' }))
            .rejects.toThrow(`Target total must not exceed ${MAX_STOCK_TOTAL}.`);
        expect(h.rpcCalls).toEqual([]);
    });

    it('sends the ABSOLUTE truncated target (never a client delta) and broadcasts; MAX itself is allowed; 0 is allowed', async () => {
        await setInventoryTotal(3, { inventoryId: 2, targetTotal: 8.7, reason: 'adjust' });
        await setInventoryTotal(3, { inventoryId: 2, targetTotal: MAX_STOCK_TOTAL, reason: 'loss', notes: 'n' });
        await setInventoryTotal(3, { inventoryId: 2, targetTotal: 0, reason: 'destruction' });
        expect(h.rpcCalls).toEqual([
            { fn: 'qm_set_inventory_total', args: { p_inventory_id: 2, p_target_total: 8, p_reason: 'adjust', p_actor_id: 3, p_notes: null } },
            { fn: 'qm_set_inventory_total', args: { p_inventory_id: 2, p_target_total: MAX_STOCK_TOTAL, p_reason: 'loss', p_actor_id: 3, p_notes: 'n' } },
            { fn: 'qm_set_inventory_total', args: { p_inventory_id: 2, p_target_total: 0, p_reason: 'destruction', p_actor_id: 3, p_notes: null } },
        ]);
        expect(broadcastToOrg).toHaveBeenCalledTimes(3);
        expect(broadcastToOrg).toHaveBeenCalledWith('qm:inventory_update', { inventoryId: 2 });
    });

    it('surfaces a proc failure as the high-level message, no broadcast', async () => {
        queueRpc('qm_set_inventory_total', { error: { message: 'boom' } });
        await expect(setInventoryTotal(3, { inventoryId: 2, targetTotal: 1, reason: 'adjust' })).rejects.toThrow(/^Failed to set stock total$/);
        expect(broadcastToOrg).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// listLowStockInventory
// ===========================================================================
describe('listLowStockInventory', () => {
    const LOW_SELECT = 'id, custom_name, catalog_id, catalog:quartermaster_catalog(id, name, thumbnail_url), location:quartermaster_locations(id, name)';
    const low = (id: number, over: Record<string, unknown> = {}) => ({
        id, custom_name: null, catalog_id: 200 + id,
        catalog: { id: 200 + id, name: `Cat ${id}`, thumbnail_url: `https://t/${id}.png` },
        location: { id: 1, name: 'Bay' },
        ...over,
    });

    it('scans non-archived rows with an enumerated projection and returns at/below-threshold rows, lowest first', async () => {
        queue('quartermaster_inventory', { data: [
            low(1), low(2, { catalog: null, catalog_id: null, custom_name: 'Zed rope', location: null }),
            low(3, { catalog: { id: 203, name: null, thumbnail_url: null }, custom_name: null }), low(4),
        ] });
        queue('quartermaster_inventory_movements', { data: [
            { inventory_id: 1, delta: 2 }, { inventory_id: 2, delta: 1 }, { inventory_id: 4, delta: 3 },
        ] });
        queue('quartermaster_issuances', { data: [{ inventory_id: 1, quantity: 5 }] });

        const out = await listLowStockInventory();

        const [q] = settled('quartermaster_inventory');
        expect(cols(first(q, 'select')![0])).toBe(LOW_SELECT);
        expect(calls(q, 'eq')).toEqual([['is_archived', false]]);
        const [iss] = settled('quartermaster_issuances');
        expect(calls(iss, 'select')).toEqual([['inventory_id, quantity']]);
        expect(calls(iss, 'in')).toEqual([['inventory_id', [1, 2, 3, 4]]]);
        expect(calls(iss, 'eq')).toEqual([['status', 'active']]);

        expect(out).toEqual([
            // id 3: no movements (a genuine 0), no catalog name and no custom name ⇒ 'Item'
            { inventoryId: 3, name: 'Item', quantityOnHand: 0, quantityOnIssue: 0, locationName: 'Bay', catalogId: 203, thumbnailUrl: null },
            { inventoryId: 2, name: 'Zed rope', quantityOnHand: 1, quantityOnIssue: 0, locationName: null, catalogId: null, thumbnailUrl: null },
            { inventoryId: 1, name: 'Cat 1', quantityOnHand: 2, quantityOnIssue: 5, locationName: 'Bay', catalogId: 201, thumbnailUrl: 'https://t/1.png' },
            // id 4 (3 on hand) is above the default threshold of 2
        ]);
    });

    it('ties on quantity break alphabetically; threshold is truncated and floored at 0; limit clamps to [1, 50]', async () => {
        const rows = [low(1, { catalog: { id: 1, name: 'Bravo', thumbnail_url: null } }), low(2, { catalog: { id: 2, name: 'Alpha', thumbnail_url: null } }), low(3)];
        const seed = () => {
            queue('quartermaster_inventory', { data: rows });
            queue('quartermaster_inventory_movements', { data: [{ inventory_id: 3, delta: 3 }] });
        };
        seed();
        expect((await listLowStockInventory()).map((r) => r.name)).toEqual(['Alpha', 'Bravo']);
        seed();
        expect((await listLowStockInventory({ threshold: 3.9 })).map((r) => r.inventoryId)).toEqual([2, 1, 3]);
        seed();
        expect((await listLowStockInventory({ threshold: -4 })).map((r) => r.inventoryId)).toEqual([2, 1]);
        seed();
        expect(await listLowStockInventory({ limit: 0 })).toHaveLength(1);
        const many = Array.from({ length: 60 }, (_, i) => low(i + 1));
        queue('quartermaster_inventory', { data: many });
        expect(await listLowStockInventory({ limit: 500 })).toHaveLength(50);
    });

    it('returns [] on 42P01 or an empty scan (no movement read); throws on any other scan error', async () => {
        queue('quartermaster_inventory', { error: PG_MISSING }, { data: [] }, { data: null }, { error: PG_FAULT });
        await expect(listLowStockInventory()).resolves.toEqual([]);
        await expect(listLowStockInventory()).resolves.toEqual([]);
        await expect(listLowStockInventory()).resolves.toEqual([]);
        expect(settled('quartermaster_inventory_movements')).toHaveLength(0);
        await expect(listLowStockInventory()).rejects.toThrow(/^Failed to load inventory for low-stock scan$/);
    });

    it('reports NO low stock (never a false alarm) when the ledger is absent, with a warning', async () => {
        queue('quartermaster_inventory', { data: [low(1)] });
        queue('quartermaster_inventory_movements', { error: PG_MISSING });
        await expect(listLowStockInventory()).resolves.toEqual([]);
        expect(logSpy.warn).toHaveBeenCalledWith('low-stock scan: movements table not present — reporting no low stock rather than a false alarm');
        expect(settled('quartermaster_issuances')).toHaveLength(0);
    });

    it('degrades the On-issue badge with a warning when the issuance read fails', async () => {
        queue('quartermaster_inventory', { data: [low(1)] });
        queue('quartermaster_issuances', { error: PG_FAULT });
        const out = await listLowStockInventory();
        expect(out).toEqual([expect.objectContaining({ inventoryId: 1, quantityOnHand: 0, quantityOnIssue: 0 })]);
        expect(logSpy.warn).toHaveBeenCalledWith('low-stock scan: active-issuance read failed; On-issue badges will read 0', { err: PG_FAULT });
    });
});

// ===========================================================================
// CSV
// ===========================================================================
describe('csvEscapeQm', () => {
    it('neutralises formula triggers AND quote-wraps when the cell also carries a delimiter', () => {
        expect(csvEscapeQm('-1,2')).toBe('"\'-1,2"');
        expect(csvEscapeQm('@SUM(A1)')).toBe("'@SUM(A1)");
        expect(csvEscapeQm('\tcmd')).toBe("'\tcmd");
        expect(csvEscapeQm('\rcmd')).toBe('"\'\rcmd"');
    });

    it('only a LEADING trigger is neutralised; mid-string operators and plain numbers pass through', () => {
        expect(csvEscapeQm('a=b+c')).toBe('a=b+c');
        expect(csvEscapeQm(0)).toBe('0');
        expect(csvEscapeQm(-3)).toBe("'-3");
        expect(csvEscapeQm(false)).toBe('false');
        expect(csvEscapeQm('cr\rhere')).toBe('"cr\rhere"');
    });
});

describe('exportInventoryCsv', () => {
    it('writes the header and one escaped row per item with computed quantities', async () => {
        queue('quartermaster_inventory',
            { data: [
                invRow(1, { notes: 'note, with comma' }),
                invRow(2, { catalog: null, catalog_id: null, custom_name: '=evil()', location: null, notes: null, acquired_at: null }),
                invRow(3, { catalog: null, catalog_id: null, custom_name: null }),
            ] },
            { data: [] },
        );
        queue('quartermaster_inventory_movements', { data: [{ inventory_id: 1, delta: 5 }] });
        queue('quartermaster_issuances', { data: [{ inventory_id: 1, quantity: 2 }] });

        const lines = (await exportInventoryCsv()).split('\n');
        expect(lines).toEqual([
            'id,name,category,subcategory,location,condition,quantity_on_hand,quantity_on_issue,acquired_at,notes',
            '1,Cat 1,weapon,rifle,Bay,used,5,2,acq,"note, with comma"',
            "2,'=evil(),,,,used,0,0,,",
            '3,,,,Bay,used,0,0,acq,',
        ]);
        // Paged non-archived reads of listInventory's hard clamp, advancing by rows received.
        const pages = settled('quartermaster_inventory');
        expect(pages.map((p) => calls(p, 'range')[0])).toEqual([[0, 999], [3, 1002]]);
        expect(pages.every((p) => calls(p, 'eq').some(([c, v]) => c === 'is_archived' && v === false))).toBe(true);
    });

    it('stops after 32 round-trips when the server keeps returning tiny pages, and marks the file truncated', async () => {
        let n = 0;
        h.handlers['quartermaster_inventory'] = () => ({ data: [invRow(++n)] });
        const lines = (await exportInventoryCsv()).split('\n');
        expect(settled('quartermaster_inventory')).toHaveLength(32);
        expect(lines).toHaveLength(1 + 32 + 1);
        const notice = lines[lines.length - 1];
        expect(notice).toBe('** TRUNCATED — this export contains only the 32 most recently added items (ceiling 10000). Older items are NOT included. Archive stock you no longer need to audit. **,,,,,,,,,');
        expect(logSpy.warn).toHaveBeenCalledWith(
            'inventory CSV export hit its row ceiling — the file is a partial (newest-first) window',
            { ceiling: 10000, exported: 32 },
        );
    });

    it('an empty inventory exports just the header', async () => {
        await expect(exportInventoryCsv()).resolves.toBe('id,name,category,subcategory,location,condition,quantity_on_hand,quantity_on_issue,acquired_at,notes');
    });
});
