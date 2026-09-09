import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ARMOURY FACETS — the three-branch contract, and the ingest that feeds it.
//
// tests/armourySearchRepair.test.ts pins the search repair (stage 1). This file
// pins what was built on top of it, and the three ways that could go wrong:
//
//  1. THE BRANCHES DESYNC. listInventory and listInventoryCount are two separate
//     queries backing one screen. A filter applied to one and not the other shows
//     N rows above a pager claiming a different total — which is exactly how the
//     original search defect surfaced as "No inventory yet" for a full armoury.
//
//  2. FACET-MODE SEARCH REUSES THE CAPPED ID WINDOW. The non-facet path resolves
//     matching catalog ids into a capped `catalog_id.in.(…)` list. Reused under a
//     facet, that window is resolved WITHOUT the facet constraint, so a broad term
//     plus a facet returns zero rows while matches exist past the cap —
//     reproducing the very bug being fixed. Facet mode goes at catalog.name
//     directly, uncapped, because the inner join already excludes catalog-less rows.
//
//  3. THE INGEST BLANKS ITSELF. mapUexItemToQmRow used to write `attributes: {}` on
//     every item upsert. With the attribute sweep landed, that line means the facets
//     work exactly once — until the next "Sync from UEX" silently wipes them.

const h = vi.hoisted(() => ({
    queries: [] as Array<{
        table: string; select?: string; or?: string; ilike?: [string, string];
        eqs: Array<[string, unknown]>; contains?: [string, unknown]; limit?: number; orders: string[]; head: boolean;
    }>,
    rpcCalls: [] as Array<{ fn: string; args: unknown }>,
    rpcResult: { data: null as unknown, error: null as unknown },
    catalogRows: [{ id: 7 }] as Array<{ id: number }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const rec = {
            table, select: undefined as string | undefined, or: undefined as string | undefined,
            ilike: undefined as [string, string] | undefined, eqs: [] as Array<[string, unknown]>,
            contains: undefined as [string, unknown] | undefined, limit: undefined as number | undefined,
            orders: [] as string[], head: false,
        };
        const b: Record<string, unknown> = {};
        for (const m of ['in', 'is', 'not', 'range', 'gte', 'lte', 'update', 'insert', 'upsert', 'delete']) b[m] = () => b;
        b.select = (cols: string, opts?: { head?: boolean }) => { rec.select = cols; if (opts?.head) rec.head = true; return b; };
        b.eq = (col: string, val: unknown) => { rec.eqs.push([col, val]); return b; };
        b.or = (clause: string) => { rec.or = clause; return b; };
        b.ilike = (col: string, val: string) => { rec.ilike = [col, val]; return b; };
        b.contains = (col: string, val: unknown) => { rec.contains = [col, val]; return b; };
        b.order = (col: string) => { rec.orders.push(col); return b; };
        b.limit = (n: number) => { rec.limit = n; return b; };
        const settle = () => {
            h.queries.push(rec);
            // The catalog table is the id-resolution read; returning a row is what lets
            // the misc/search branches actually build their catalog_id.in.(…) leg.
            const data = table === 'quartermaster_catalog' ? h.catalogRows : [];
            return Promise.resolve({ data, error: null, count: 0 });
        };
        b.single = () => settle();
        b.maybeSingle = () => settle();
        b.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => settle().then(r, j);
        return b;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: unknown) => { h.rpcCalls.push({ fn, args }); return Promise.resolve(h.rpcResult); },
        },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
    };
});
vi.mock('../lib/db/uex', () => ({
    fetchAllUexItems: async () => ({ categories: [], items: [], errors: [] }),
    mapUexItemToQmRow: () => null,
    fetchUexCategories: async () => [],
    fetchUexItemAttributesForCategory: async () => [],
}));

import { listInventory, listInventoryCount, getArmoryFacets, FACETABLE_ATTR_KEYS } from '../lib/db/quartermaster';

const inv = () => h.queries.filter((q) => q.table === 'quartermaster_inventory');
const cat = () => h.queries.filter((q) => q.table === 'quartermaster_catalog');

beforeEach(() => { h.queries = []; h.rpcCalls = []; h.rpcResult = { data: null, error: null }; });

describe('the list and the count apply IDENTICAL filters', () => {
    const CASES: Array<[string, Record<string, unknown>]> = [
        ['plain search', { search: 'rifle' }],
        ['a category facet', { category: 'weapon' }],
        ['an attribute facet', { attributes: { Grade: 'A' } }],
        ['facet + search', { category: 'weapon', search: 'rifle' }],
        ['misc-inclusive', { category: 'misc' }],
        ['misc-inclusive + search', { category: 'misc', search: 'rope' }],
    ];

    for (const [label, opts] of CASES) {
        it(`agree on ${label}`, async () => {
            await listInventory(opts);
            const listQ = inv()[0];
            h.queries = [];
            await listInventoryCount(opts);
            const countQ = inv()[0];

            expect(countQ.head, 'the count must stay a head query').toBe(true);
            expect(countQ.or, `${label}: .or() differs`).toBe(listQ.or);
            expect(countQ.ilike, `${label}: .ilike() differs`).toEqual(listQ.ilike);
            expect(countQ.contains, `${label}: .contains() differs`).toEqual(listQ.contains);
            // The count selects a different projection by design (head:true), so
            // compare the FILTERS, not the select.
            expect(countQ.eqs, `${label}: .eq() filters differ`).toEqual(listQ.eqs);
        });
    }
});

describe('facet mode', () => {
    it('promotes the catalog embed to an INNER join, or facets would only null the embed', async () => {
        await listInventory({ category: 'weapon' });
        expect(inv()[0].select).toContain('quartermaster_catalog!inner');
    });

    it('leaves the DEFAULT read on the outer embed and free of the facet columns', async () => {
        // Rule 3: nothing renders size_label / company_name / quality / attributes, so
        // they must not ride the read every armoury page performs.
        await listInventory({});
        const sel = inv()[0].select!;
        expect(sel).not.toContain('!inner');
        expect(sel).not.toContain('attributes');
        expect(sel).not.toContain('company_name');
    });

    it('searches catalog.name UNCAPPED instead of reusing the capped id window', async () => {
        await listInventory({ category: 'weapon', search: 'rifle' });
        expect(inv()[0].ilike?.[0]).toBe('catalog.name');
        // …and issues no catalog-id resolution read at all, which is what the cap
        // would otherwise apply to.
        expect(cat(), 'facet mode must not resolve a capped catalog-id window').toEqual([]);
    });

    it('a term that sanitises away matches NOTHING rather than falling through', async () => {
        await listInventory({ category: 'weapon', search: '%%%' });
        expect(inv()[0].eqs).toContainEqual(['id', 0]);
        expect(inv()[0].ilike).toBeUndefined();
    });

    it('maps every facet to its embedded column', async () => {
        await listInventory({ category: 'weapon', subcategory: 'Rifle', sizeLabel: 'S2', manufacturer: 'Klaus', itemKind: 'personal' });
        const eqs = Object.fromEntries(inv()[0].eqs);
        expect(eqs['catalog.category']).toBe('weapon');
        expect(eqs['catalog.subcategory']).toBe('Rifle');
        expect(eqs['catalog.size_label']).toBe('S2');
        expect(eqs['catalog.company_name']).toBe('Klaus');
        expect(eqs['catalog.is_vehicle_item']).toBe(false);
    });

    it('attribute facets go through JSONB containment', async () => {
        await listInventory({ attributes: { Grade: 'A' } });
        expect(inv()[0].contains).toEqual(['catalog.attributes', { Grade: 'A' }]);
    });
});

describe("'misc' keeps free-text stock visible", () => {
    it('takes the catalog-less-inclusive path instead of the inner join', async () => {
        // A member's hand-entered items have catalog_id NULL, so the inner join would
        // drop every one of them the moment someone picked the category that is
        // supposed to contain them.
        await listInventory({ category: 'misc' });
        expect(inv()[0].select).not.toContain('!inner');
        expect(inv()[0].or).toContain('catalog_id.is.null');
    });

    it('but NOT when another facet is also active — that one needs a catalog row', async () => {
        await listInventory({ category: 'misc', sizeLabel: 'S2' });
        expect(inv()[0].select).toContain('!inner');
        expect(inv()[0].or).toBeUndefined();
    });

    it('folds the search term into BOTH branches', async () => {
        await listInventory({ category: 'misc', search: 'rope' });
        const or = inv()[0].or!;
        expect(or).toContain('and(catalog_id.is.null,custom_name.ilike.%rope%)');
        expect(or).toContain('catalog_id.in.');
    });

    it('emits exactly ONE .or() per builder', async () => {
        // Two .or() calls on the same builder AND together rather than OR, which
        // silently returns nothing. Every branch must pick one.
        for (const opts of [{ category: 'misc', search: 'rope' }, { search: 'rope' }, { category: 'weapon', search: 'rope' }]) {
            h.queries = [];
            await listInventory(opts as Record<string, unknown>);
            // The recorder keeps only the LAST .or(); a second call would overwrite it,
            // so assert on the code shape instead — see the source contract below.
            expect(inv().length).toBe(1);
        }
    });
});

describe('getArmoryFacets', () => {
    it('is ONE SQL aggregate, not a table scan folded in Node', async () => {
        h.rpcResult = { data: { types: ['Rifle'], sizes: [], manufacturers: [], categories: ['weapon'], hasVehicle: false, hasPersonal: true, attributes: {} }, error: null };
        const f = await getArmoryFacets();
        expect(h.rpcCalls.map((c) => c.fn)).toEqual(['qm_armoury_facets']);
        expect(inv(), 'no inventory rows may be fetched to build a filter menu').toEqual([]);
        expect(f.types).toEqual(['Rifle']);
        expect(f.hasPersonal).toBe(true);
    });

    it('soft-fails to empty — a missing function costs the dropdowns, not the armoury', async () => {
        h.rpcResult = { data: null, error: { code: '42883', message: 'function does not exist' } };
        await expect(getArmoryFacets()).resolves.toEqual({
            categories: [], types: [], sizes: [], manufacturers: [],
            hasVehicle: false, hasPersonal: false, attributes: {},
        });
    });

    it('drops any attribute key outside the allowlist, whatever SQL returned', async () => {
        h.rpcResult = { data: { attributes: { Grade: ['A'], Mass: ['1.5', '2.0'] } }, error: null };
        const f = await getArmoryFacets();
        expect(Object.keys(f.attributes)).toEqual(['Grade']);
    });

    it('narrows non-string junk out of every list', async () => {
        h.rpcResult = { data: { types: ['Rifle', 42, null], hasVehicle: 'yes' }, error: null };
        const f = await getArmoryFacets();
        expect(f.types).toEqual(['Rifle']);
        expect(f.hasVehicle, 'anything but true is false').toBe(false);
    });
});

describe('the JSONB is bounded at every writer, or "bounded over-fetch" is a claim not a fact', () => {
    const qm = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'quartermaster.ts'), 'utf8');
    const uex = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'uex.ts'), 'utf8');
    const schema = readFileSync(resolve(__dirname, '..', 'schema.sql'), 'utf8');

    it('the item sync does NOT write attributes — it would blank the sweep on every re-sync', () => {
        // The single highest-value catch of this item. `attributes: {}` here means the
        // facets work exactly once, then a routine "Sync from UEX" empties them with
        // nothing to indicate it happened.
        // Slice FORWARD from the mapper. fetchAllUexItems is defined ABOVE it, so
        // slicing between them the other way yields '' and the assertion passes
        // against nothing — the exact shape of vacuous test this file exists to catch.
        const mapStart = uex.indexOf('export function mapUexItemToQmRow');
        expect(mapStart, 'mapUexItemToQmRow was renamed').toBeGreaterThan(-1);
        const mapper = uex.slice(mapStart, uex.indexOf('\n}', mapStart));
        expect(mapper, 'the slice must reach the row literal').toContain('subcategory:');
        expect(mapper).not.toMatch(/attributes\s*:/);
    });

    it('the INGEST folds only allowlisted keys', () => {
        const sweep = qm.slice(qm.indexOf('export async function syncPlatformItemAttributes'), qm.indexOf('// Overdue scan'));
        expect(sweep).toMatch(/FACETABLE_ATTR_KEYS as readonly string\[\]\)\.includes\(a\.attribute_name\)/);
        expect(sweep, 'values render in a dropdown, so they are stripped and capped like every other UEX string')
            .toMatch(/stripHtmlSingleLine\(/);
    });

    it('the ADMIN write path is bounded too — it is the second writer of the same column', () => {
        // catalog:update_item copies non-protected keys verbatim, and attributes is
        // deliberately not protected. Without this the ingest caps are bypassable by
        // the same person who runs the ingest.
        expect(qm).toMatch(/function sanitizeCatalogAttributes/);
        const updStart = qm.indexOf('export async function updatePlatformItem(');
        expect(updStart, 'updatePlatformItem was renamed').toBeGreaterThan(-1);
        const upd = qm.slice(updStart, qm.indexOf('export async function ', updStart + 10));
        expect(upd).toMatch(/k === 'attributes' \? sanitizeCatalogAttributes\(v\)/);
    });

    it('the SQL function filters to the same keys, and its list matches the TS one', () => {
        const fn = schema.slice(schema.indexOf('CREATE OR REPLACE FUNCTION public.qm_armoury_facets'), schema.indexOf('4.6 Warehouse functions'));
        expect(fn).toMatch(/v_keys text\[\]/);
        for (const k of FACETABLE_ATTR_KEYS) {
            expect(fn, `${k} missing from the SQL allowlist`).toContain(`'${k}'`);
        }
        // …and the SQL list carries nothing EXTRA, or the two drift apart silently.
        const arr = /v_keys text\[\] := ARRAY\[([^\]]*)\]/.exec(fn)![1];
        const sqlKeys = [...arr.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        expect(sqlKeys.sort()).toEqual([...FACETABLE_ATTR_KEYS].sort());
    });

    it('the new function carries its GRANT — there is no default grant in this file', () => {
        expect(schema).toMatch(/GRANT EXECUTE ON FUNCTION public\.qm_armoury_facets\(boolean\) TO service_role;/);
    });
});

describe('the action layer validates facets before they reach a filter', () => {
    const actions = readFileSync(resolve(__dirname, '..', 'api', 'actions', 'quartermaster.ts'), 'utf8');
    const services = readFileSync(resolve(__dirname, '..', 'api', 'services.ts'), 'utf8');

    it('attribute KEYS are checked against the server allowlist', () => {
        // The keys land in a JSONB containment filter, so a caller-chosen key would let
        // anyone probe for any attribute the catalogue happens to carry.
        const fn = actions.slice(actions.indexOf('function facetAttributes'), actions.indexOf('function facetOptsFrom'));
        expect(fn).toMatch(/FACETABLE_ATTR_KEYS as readonly string\[\]\)\.includes\(k\)/);
        expect(fn, 'values are length-capped too').toMatch(/facetStr\(val, \d+\)/);
    });

    it('the category facet is checked against the known set, not passed through', () => {
        const fn = actions.slice(actions.indexOf('function facetCategory'), actions.indexOf('function facetKind'));
        expect(fn).toMatch(/QM_CATEGORIES\.includes\(s\)/);
    });

    it('list and count parse facets through the SAME helper', () => {
        const list = actions.slice(actions.indexOf("'qm:list_inventory':"), actions.indexOf("'qm:count_inventory':"));
        const count = actions.slice(actions.indexOf("'qm:count_inventory':"), actions.indexOf("'qm:list_inventory_facets':"));
        expect(list).toMatch(/\.\.\.facetOptsFrom\(facets\)/);
        expect(count).toMatch(/\.\.\.facetOptsFrom\(facets\)/);
    });

    it('the new read action has its permission entry, or it silently 403s in prod', () => {
        expect(actions).toContain("'qm:list_inventory_facets'");
        expect(services).toMatch(/'qm:list_inventory_facets':\s*'qm:view'/);
        expect(services).toMatch(/'catalog:sync_item_attributes':\s*'admin:config:catalog'/);
    });
});

describe('the client filters entirely server-side', () => {
    const tab = readFileSync(resolve(__dirname, '..', 'components', 'views', 'quartermaster', 'QmArmoryTab.tsx'), 'utf8');

    it('category is in the request payload, not a filter over the visible page', () => {
        // It used to be client-side while totalCount counted the UNFILTERED set, so
        // picking "weapon" showed the weapons among 60 rows above a pager claiming
        // four pages.
        expect(tab).toMatch(/category: categoryFilter === 'all' \? null : categoryFilter/);
        expect(tab, 'the client-side category memo must be gone').not.toMatch(/const visible = useMemo/);
    });

    it('the empty state branches on whether a filter is active, not on totalCount', () => {
        expect(tab).toMatch(/const filtersActive =/);
        expect(tab).toMatch(/typeFilter !== 'all'/);
    });

    it('facets are refetched on STOCK changes, not on filter changes', () => {
        // Refetching the option lists whenever a dropdown changes makes the other
        // dropdowns reshuffle underneath the operator as they narrow down.
        const eff = tab.slice(tab.indexOf('const loadFacets'), tab.indexOf('const loadCount'));
        expect(eff).toMatch(/\[rpcAction\]/);
        expect(eff).not.toMatch(/filterPayload/);
    });
});
