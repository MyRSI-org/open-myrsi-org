import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// CATALOG-SOURCED STOCK WAS UNFINDABLE BY NAME.
//
// listInventory and listInventoryCount both filtered on `custom_name` ONLY. Every row created
// through "Add Stock -> From Catalog" — the DEFAULT way to add stock — has custom_name IS NULL,
// and `NULL ILIKE '%rifle%'` is NULL, so the row was excluded outright.
//
// The old comment claimed "catalog-name search is handled client-side on the visible page".
// It was not. QmArmoryTab client-filters by CATEGORY only; there is no name fallback anywhere.
// The comment was part of the defect, not a mitigation.
//
// Because the COUNT applied the same broken filter, totalCount also came back 0 — and the empty
// state then rendered "No inventory yet. Use Add Stock to record some." to an operator whose
// armoury was full. A search that found nothing was indistinguishable from an empty armoury.
//
// Second victim, which the plan never mentions: IssueKitModal's stock picker calls the same
// qm:list_inventory search, so a quartermaster issuing kit could not find a catalog item either.
// It is fixed by the same change, which is why the fix belongs in the db layer and not the tab.

const h = vi.hoisted(() => ({
    catalogRows: [] as Array<{ id: number }>,
    catalogError: null as { code?: string; message: string } | null,
    queries: [] as Array<{ table: string; or?: string; ilike?: [string, string]; limit?: number; orders: string[] }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const rec = { table, or: undefined as string | undefined, ilike: undefined as [string, string] | undefined, limit: undefined as number | undefined, orders: [] as string[] };
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'is', 'not', 'range', 'gte', 'lte']) b[m] = () => b;
        b.or = (clause: string) => { rec.or = clause; return b; };
        b.ilike = (col: string, val: string) => { rec.ilike = [col, val]; return b; };
        b.order = (col: string) => { rec.orders.push(col); return b; };
        b.limit = (n: number) => { rec.limit = n; return b; };
        const settle = () => {
            h.queries.push(rec);
            if (table === 'quartermaster_catalog') {
                return Promise.resolve({ data: h.catalogError ? null : h.catalogRows, error: h.catalogError, count: 0 });
            }
            return Promise.resolve({ data: [], error: null, count: 0 });
        };
        b.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => settle().then(r, j);
        b.single = () => settle();
        b.maybeSingle = () => settle();
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => ({}),
        safeFetch: async () => [],
    };
});
vi.mock('../lib/push', () => ({ sendPushToStaff: () => {}, sendPushToUsers: async () => {} }));

import { listInventory, listInventoryCount } from '../lib/db/quartermaster';

const inventoryQuery = () => h.queries.find((q) => q.table === 'quartermaster_inventory');
const catalogQuery = () => h.queries.find((q) => q.table === 'quartermaster_catalog');

beforeEach(() => { h.catalogRows = []; h.catalogError = null; h.queries = []; });

describe('armoury search reaches catalog-sourced stock', () => {
    it('THE DEFECT: the filter is no longer custom_name-only', async () => {
        h.catalogRows = [{ id: 11 }, { id: 12 }];
        await listInventory({ search: 'rifle' });

        const q = inventoryQuery()!;
        expect(q.or, 'search must be an OR across both name sources').toBeTruthy();
        expect(q.or).toContain('custom_name.ilike.%rifle%');
        expect(q.or).toContain('catalog_id.in.(11,12)');
        // The old shape was a bare .ilike on custom_name and nothing else.
        expect(q.ilike).toBeUndefined();
    });

    it('resolves catalog matches by name, capped and in a TOTAL order', async () => {
        // list and count resolve this independently, so without a stable order a broad term
        // could hand them different 500-id windows and desync the page from its own total.
        await listInventory({ search: 'rifle' });
        const c = catalogQuery()!;
        expect(c.ilike?.[0]).toBe('name');
        expect(c.orders).toContain('id');
        expect(c.limit).toBe(500);
    });

    it('the COUNT applies the identical filter, or the pager disagrees with its own page', async () => {
        h.catalogRows = [{ id: 7 }];
        await listInventory({ search: 'rifle' });
        const listOr = inventoryQuery()!.or;

        h.queries = [];
        await listInventoryCount({ search: 'rifle' });
        expect(inventoryQuery()!.or).toBe(listOr);
    });

    it('a term with no catalog matches still searches custom_name', async () => {
        h.catalogRows = [];
        await listInventory({ search: 'rifle' });
        const or = inventoryQuery()!.or!;
        expect(or).toBe('custom_name.ilike.%rifle%');
        expect(or).not.toContain('catalog_id.in.()');   // an empty IN list is a syntax error
    });

    it('no search means NO filter — not an empty one', async () => {
        await listInventory({});
        expect(inventoryQuery()!.or).toBeUndefined();
        expect(catalogQuery(), 'must not resolve catalog ids when nothing was typed').toBeUndefined();
    });

    it('a term that sanitises away matches NOTHING rather than revealing the whole armoury', async () => {
        // The dangerous fall-through: a punctuation-only term strips to '', and a naive
        // implementation would then skip the filter and return everything.
        await listInventory({ search: '%%%' });
        expect(inventoryQuery()!.or).toBe('id.eq.0');
        expect(catalogQuery()).toBeUndefined();
    });

    it('strips the .or() metacharacters so a term cannot inject sibling conditions', async () => {
        // The term lands inside a raw PostgREST .or() grammar where comma, dot and parens are
        // STRUCTURE. This is why the repair uses safeSearchTerm (an allow-list) rather than
        // escapeLikePattern (which escapes wildcards but passes punctuation through).
        await listInventory({ search: 'a,b.c(d)e' });
        const or = inventoryQuery()!.or!;
        expect(or).toBe('custom_name.ilike.%abcde%');
    });

    it('a catalog-resolve fault fails CLOSED rather than answering from a partial id set', async () => {
        h.catalogError = { message: 'connection reset' };
        await expect(listInventory({ search: 'rifle' })).rejects.toThrow(/catalog matches/i);
    });

    it('tolerates a missing catalog table (pre-migration window)', async () => {
        h.catalogError = { code: '42P01', message: 'relation does not exist' };
        await expect(listInventory({ search: 'rifle' })).resolves.toEqual([]);
    });
});

describe('the empty state no longer lies about an empty armoury', () => {
    const src = readFileSync(resolve(__dirname, '..', 'components', 'views', 'quartermaster', 'QmArmoryTab.tsx'), 'utf8');

    it('branches on whether a FILTER is active, not on totalCount', () => {
        // totalCount applies the same filters, so once search works a term that legitimately
        // matches nothing drives it to 0 — and the old branch then told the operator they had
        // no inventory at all, which is the same misleading message the defect produced.
        expect(src).toMatch(/const filtersActive\s*=/);
        expect(src).toMatch(/\{filtersActive\s*\n?\s*\?\s*'No items match the current filters\.'/);
        expect(src).not.toMatch(/\{totalCount !== 0\s*\n?\s*\?\s*'No items match/);
    });

    it('the db layer no longer has a custom_name-only ilike filter', () => {
        // Asserts the CODE, not the prose. The obvious assertion — that the stale "handled
        // client-side" comment is gone — cannot work: the replacement docblock QUOTES that
        // comment to explain why it was part of the defect, so the needle matches the
        // explanation. Stripping comments first would make it vacuous, since the thing being
        // asserted absent was itself a comment.
        const db = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'quartermaster.ts'), 'utf8');
        expect(db).not.toMatch(/\.ilike\('custom_name'/);
    });
});
