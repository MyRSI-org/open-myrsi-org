import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// MARKETPLACE BARTER — mixed aUEC + goods terms.
//
// A leg is a LABEL AND A QUANTITY: a documented term of the deal, in the same
// trust class as price_uec. It never touches warehouse stock, and it carries no
// catalog reference. Three properties carry the weight:
//
//  1. THE REPLACE MUST BE COMPLETE. updateMarketplaceListing holds no lock. The
//     obvious shape — read the old ids, insert, delete those ids — needs a CAPPED
//     read to satisfy the order ratchet, and a capped delete is an incomplete
//     delete: two concurrent updates both read the same <=10 old ids, both insert
//     <=10, both delete the same 10, and the surplus is permanent. MAX_CONSIDERATIONS
//     would stop being a bound at all, on a surface reachable with a
//     CUSTOMER-GRANTABLE permission and re-read on every board refresh. Deleting by
//     EXCLUSION is complete however many stale rows exist.
//
//  2. VALIDATION RUNS BEFORE THE WRITE IT GATES. Hosted validates the legs after
//     the parent UPDATE has committed, so a bad bundle leaves a half-updated
//     listing and tells the caller it failed.
//
//  3. THE AGREED TERMS ARE PARTY-ONLY. They ride CONTRACT_SELECT, which is reached
//     only through the two party-gated reads. REPORT_SELECT must never carry them —
//     a marketplace:admin moderator is not a party to the contract.

const h = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    nextId: 1,
    deletes: [] as Array<{ table: string; filters: Record<string, unknown>; notIn?: string[] }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = {
            op: 'select' as string,
            values: null as unknown,
            filters: {} as Record<string, unknown>,
            isFilters: {} as Record<string, unknown>,
            inFilters: {} as Record<string, Set<unknown>>,
            notInFilters: {} as Record<string, Set<string>>,
        };
        const rows = () => (h.tables[table] ?? []).filter((r) => {
            for (const [c, v] of Object.entries(state.filters)) if (r[c] !== v) return false;
            for (const [c, v] of Object.entries(state.isFilters)) {
                if (v === null && r[c] !== null && r[c] !== undefined) return false;
            }
            for (const [c, set] of Object.entries(state.inFilters)) if (!set.has(r[c])) return false;
            for (const [c, set] of Object.entries(state.notInFilters)) if (set.has(String(r[c]))) return false;
            return true;
        });
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.update = (v: Record<string, unknown>) => { state.op = 'update'; state.values = v; return b; };
        b.insert = (v: unknown) => { state.op = 'insert'; state.values = v; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.is = (c: string, v: unknown) => { state.isFilters[c] = v; return b; };
        b.in = (c: string, vals: unknown[]) => { state.inFilters[c] = new Set(vals); return b; };
        b.not = (c: string, op: string, val: string) => {
            if (op === 'in') state.notInFilters[c] = new Set(String(val).replace(/^\(|\)$/g, '').split(',').filter(Boolean));
            return b;
        };
        b.or = () => b; b.order = () => b; b.limit = () => b; b.ilike = () => b;
        const settle = (mode: 'many' | 'single') => {
            const list = (h.tables[table] = h.tables[table] ?? []);
            if (state.op === 'select') {
                const data = rows().map((r) => ({
                    ...r,
                    // Emulate the to-many embeds the real selects carry.
                    ...(table === 'marketplace_listings'
                        ? { considerations: (h.tables.marketplace_listing_considerations ?? []).filter((c) => c.listing_id === r.id) }
                        : {}),
                    ...(table === 'marketplace_contracts'
                        ? { considerations: (h.tables.marketplace_contract_considerations ?? []).filter((c) => c.contract_id === r.id) }
                        : {}),
                }));
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            if (state.op === 'insert') {
                const incoming = Array.isArray(state.values)
                    ? (state.values as Array<Record<string, unknown>>)
                    : [state.values as Record<string, unknown>];
                const written = incoming.map((v) => { const row = { id: h.nextId++, ...v }; list.push(row); return row; });
                return Promise.resolve({ data: mode === 'single' ? (written[0] ?? null) : written, error: null });
            }
            if (state.op === 'update') {
                const affected = rows();
                for (const r of affected) Object.assign(r, state.values as Record<string, unknown>);
                const ids = affected.map((r) => ({ id: r.id }));
                return Promise.resolve({ data: mode === 'single' ? (ids[0] ?? null) : ids, error: null });
            }
            if (state.op === 'delete') {
                h.deletes.push({
                    table,
                    filters: { ...state.filters },
                    notIn: Object.values(state.notInFilters).flatMap((set) => [...set]),
                });
                const doomed = new Set(rows());
                h.tables[table] = list.filter((r) => !doomed.has(r));
            }
            return Promise.resolve({ data: null, error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => settle('many').then(r, j);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: 'ok', error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {},
        safeFetch: async () => [], getSystemRoles: async () => ({}),
    };
});

import {
    createMarketplaceListing, updateMarketplaceListing, proposeMarketplaceContract, getMarketplaceListing,
} from '../lib/db/marketplace';

const SELLER = 10, BUYER = 20;
const legs = () => h.tables.marketplace_listing_considerations ?? [];

function seedListing(over: Record<string, unknown> = {}) {
    h.tables.marketplace_listings = [{
        id: 'L1', seller_id: SELLER, kind: 'item', listing_type: 'sell', title: 'Widget',
        quantity: 10, quantity_claimed: 0, status: 'active', warehouse_stock_id: null,
        moderation_closed_at: null, ...over,
    }];
}

beforeEach(() => { h.tables = {}; h.nextId = 1; h.deletes = []; });

describe('creating a listing with barter terms', () => {
    it('writes the legs and returns them on the listing', async () => {
        const listing = await createMarketplaceListing({
            kind: 'item', listingType: 'sell', title: 'Ore', quantity: 5,
            considerations: [{ label: 'Titanium', quantity: 500 }, { componentType: 'offer', label: 'Laranite', quantity: 200 }],
        }, SELLER);
        expect(legs().length).toBe(2);
        expect(listing.considerations?.map((c) => c.label)).toEqual(['Titanium', 'Laranite']);
        expect(listing.considerations?.[1].componentType).toBe('offer');
    });

    it('sanitises the label AND the notes — this board is customer-readable', async () => {
        await createMarketplaceListing({
            kind: 'item', listingType: 'sell', title: 'Ore', quantity: 5,
            considerations: [{ label: '<b>Titanium</b>', quantity: 1, notes: '<script>x</script>pure' }],
        }, SELLER);
        expect(String(legs()[0].label)).not.toContain('<');
        expect(String(legs()[0].notes)).not.toContain('<');
    });

    it('refuses an invalid bundle BEFORE writing the listing', async () => {
        // Hosted validates after the parent write, leaving a half-created row.
        await expect(createMarketplaceListing({
            kind: 'item', listingType: 'sell', title: 'Ore', quantity: 5,
            considerations: [{ label: 'Titanium', quantity: 0 }],
        }, SELLER)).rejects.toThrow(/quantity/i);
        expect(h.tables.marketplace_listings ?? [], 'nothing may be written').toEqual([]);
    });

    it('bounds the bundle', async () => {
        const many = Array.from({ length: 11 }, (_, i) => ({ label: `Item ${i}`, quantity: 1 }));
        await expect(createMarketplaceListing({
            kind: 'item', listingType: 'sell', title: 'Ore', quantity: 5, considerations: many,
        }, SELLER)).rejects.toThrow(/at most 10/i);
    });

    it('requires a name on every leg', async () => {
        await expect(createMarketplaceListing({
            kind: 'item', listingType: 'sell', title: 'Ore', quantity: 5,
            considerations: [{ label: '   ', quantity: 1 }],
        }, SELLER)).rejects.toThrow(/needs a name/i);
    });
});

describe('replacing the legs on an update', () => {
    it('deletes by EXCLUSION, not by a capped list of old ids', async () => {
        // The property that makes the replace complete however many stale rows
        // exist — and therefore the property that keeps MAX_CONSIDERATIONS a bound.
        seedListing();
        h.tables.marketplace_listing_considerations = Array.from({ length: 25 }, (_, i) => ({
            id: 1000 + i, listing_id: 'L1', component_type: 'want', label: `Old ${i}`, quantity: 1, notes: null, sort_order: i,
        }));
        h.nextId = 5000;
        await updateMarketplaceListing('L1', { considerations: [{ label: 'New', quantity: 1 }] }, SELLER);
        expect(legs().length, '25 stale rows must all go, not 10 of them').toBe(1);
        expect(legs()[0].label).toBe('New');

        const del = h.deletes.find((d) => d.table === 'marketplace_listing_considerations')!;
        expect(del, 'no delete was issued').toBeTruthy();
        expect(del.notIn, 'the delete must exclude the rows just inserted').toEqual(['5000']);
    });

    it('inserts BEFORE deleting, so a failure cannot leave the listing bare', async () => {
        seedListing();
        h.tables.marketplace_listing_considerations = [
            { id: 1, listing_id: 'L1', component_type: 'want', label: 'Old', quantity: 1, notes: null, sort_order: 0 },
        ];
        // Above the seeded ids, or the mock hands the new row the same id as the stale
        // one and the exclusion filter spares it — a harness artefact, not a defect.
        h.nextId = 100;
        await updateMarketplaceListing('L1', { considerations: [{ label: 'New', quantity: 2 }] }, SELLER);
        expect(legs().map((r) => r.label)).toEqual(['New']);
    });

    it('an EMPTY array clears them', async () => {
        seedListing();
        h.tables.marketplace_listing_considerations = [
            { id: 1, listing_id: 'L1', component_type: 'want', label: 'Old', quantity: 1, notes: null, sort_order: 0 },
        ];
        await updateMarketplaceListing('L1', { considerations: [] }, SELLER);
        expect(legs()).toEqual([]);
    });

    it('NULL means unchanged — not "wipe the bundle"', async () => {
        // `updates` reaches the db layer as an untyped Record and null is a very
        // ordinary "unchanged" encoding. Treating it as a clear would silently delete
        // the seller's whole advertised bundle and report success.
        seedListing();
        h.tables.marketplace_listing_considerations = [
            { id: 1, listing_id: 'L1', component_type: 'want', label: 'Keep', quantity: 1, notes: null, sort_order: 0 },
        ];
        await updateMarketplaceListing('L1', { title: 'Renamed', considerations: null }, SELLER);
        expect(legs().map((r) => r.label)).toEqual(['Keep']);
    });

    it('an omitted field also means unchanged', async () => {
        seedListing();
        h.tables.marketplace_listing_considerations = [
            { id: 1, listing_id: 'L1', component_type: 'want', label: 'Keep', quantity: 1, notes: null, sort_order: 0 },
        ];
        await updateMarketplaceListing('L1', { title: 'Renamed' }, SELLER);
        expect(legs().map((r) => r.label)).toEqual(['Keep']);
    });

    it('a bad bundle refuses with the PARENT ROW UNTOUCHED', async () => {
        // The whole reason validation is hoisted above every write in this function.
        seedListing();
        await expect(updateMarketplaceListing('L1', {
            title: 'Renamed', considerations: [{ label: 'Titanium', quantity: -5 }],
        }, SELLER)).rejects.toThrow(/quantity/i);
        expect(h.tables.marketplace_listings[0].title, 'the title change must not have committed').toBe('Widget');
    });

    it('a non-owner is refused before any of it', async () => {
        seedListing();
        await expect(updateMarketplaceListing('L1', { considerations: [{ label: 'X', quantity: 1 }] }, BUYER))
            .rejects.toThrow(/not found or access denied/i);
        expect(legs()).toEqual([]);
    });
});

describe('a proposal freezes its terms onto the contract', () => {
    it('copies the legs rather than referencing the listing', async () => {
        // The listing can be edited or deleted afterwards; a signed deal cannot.
        seedListing();
        const contract = await proposeMarketplaceContract({
            listingId: 'L1', quantity: 1,
            considerations: [{ label: 'Laranite', quantity: 200 }],
        }, BUYER);
        const frozen = h.tables.marketplace_contract_considerations ?? [];
        expect(frozen.length).toBe(1);
        expect(frozen[0].contract_id).toBe(contract.id);
        expect(contract.considerations?.[0].label).toBe('Laranite');
    });

    it('records them as the PROPOSER offer side', async () => {
        seedListing();
        await proposeMarketplaceContract({
            listingId: 'L1', quantity: 1, considerations: [{ componentType: 'want', label: 'Laranite', quantity: 1 }],
        }, BUYER);
        expect((h.tables.marketplace_contract_considerations ?? [])[0].component_type).toBe('offer');
    });

    it('refuses a bad bundle before the contract is written', async () => {
        seedListing();
        await expect(proposeMarketplaceContract({
            listingId: 'L1', quantity: 1, considerations: [{ label: '', quantity: 1 }],
        }, BUYER)).rejects.toThrow(/needs a name/i);
        expect(h.tables.marketplace_contracts ?? []).toEqual([]);
    });
});

describe('display order is imposed, not inherited from the planner', () => {
    it('sorts by sort_order then id', async () => {
        seedListing();
        h.tables.marketplace_listing_considerations = [
            { id: 3, listing_id: 'L1', component_type: 'want', label: 'C', quantity: 1, notes: null, sort_order: 2 },
            { id: 1, listing_id: 'L1', component_type: 'want', label: 'A', quantity: 1, notes: null, sort_order: 0 },
            { id: 2, listing_id: 'L1', component_type: 'want', label: 'B', quantity: 1, notes: null, sort_order: 1 },
        ];
        const listing = await getMarketplaceListing('L1', BUYER);
        expect(listing?.considerations?.map((c) => c.label)).toEqual(['A', 'B', 'C']);
    });
});

describe('the read boundary', () => {
    const src = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'marketplace.ts'), 'utf8');

    it('the agreed terms ride CONTRACT_SELECT and NOT the moderator projection', () => {
        // A marketplace:admin moderator is not a party to the contract. REPORT_SELECT
        // deliberately embeds only five contract identity fields, and widening it here
        // would be the one real leak this port could introduce.
        const report = src.slice(src.indexOf('const REPORT_SELECT'), src.indexOf(';', src.indexOf('const REPORT_SELECT')));
        expect(report).not.toMatch(/consideration/);
        expect(src.slice(src.indexOf('const CONTRACT_SELECT'), src.indexOf(';', src.indexOf('const CONTRACT_SELECT'))))
            .toMatch(/considerations:marketplace_contract_considerations/);
    });

    it('the moderator projection embeds only contract IDENTITY, not its body', () => {
        // Stated as the shape rather than as an absence, so adding any embed to
        // REPORT_SELECT has to come through here deliberately.
        const report = src.slice(src.indexOf('const REPORT_SELECT'), src.indexOf(';', src.indexOf('const REPORT_SELECT')));
        expect(report).toMatch(/contract:marketplace_contracts\(id, title, status, seller_id, buyer_id\)/);
    });

    it('the propose ACTION forwards the legs — it is a field-by-field forward', () => {
        // The db layer takes the whole object on create and update, but the propose
        // ACTION destructures explicitly, so a new input field is silently dropped
        // there and nowhere else. The db-layer tests above cannot see this.
        const actions = readFileSync(resolve(__dirname, '..', 'api', 'actions', 'marketplace.ts'), 'utf8');
        const handler = actions.slice(actions.indexOf("'marketplace:propose'"), actions.indexOf("'marketplace:accept'"));
        expect(handler).toMatch(/considerations: p\.considerations/);
        // …and the payload interface has to carry it, or TypeScript drops it earlier.
        expect(actions).toMatch(/interface ProposePayload[^\n]*considerations\?:/);
    });

    it('carries no catalog reference at all', () => {
        // A pin would route qm:view-gated catalog names onto a marketplace:view
        // surface, and marketplace:view is customer-grantable.
        const fields = src.slice(src.indexOf('const CONSIDERATION_FIELDS'), src.indexOf(';', src.indexOf('const CONSIDERATION_FIELDS')));
        expect(fields).not.toMatch(/catalog|commodity/i);
    });

    it('never touches warehouse stock', () => {
        const builder = src.slice(src.indexOf('function buildConsiderationRows'), src.indexOf('interface CategoryRow'));
        expect(builder).not.toMatch(/warehouse/i);
    });
});

describe('the moderator projection really is narrow, in behaviour not just in source', () => {
    it('a report carries no leg field', async () => {
        // The source scrape above is brittle — listMarketplaceReports builds through a
        // builder variable, so a rename passes it while the query changes. This is the
        // assertion that actually holds the line.
        const { listMarketplaceReports } = await import('../lib/db/marketplace');
        h.tables.marketplace_contracts = [{
            id: 'C1', listing_id: 'L1', seller_id: SELLER, buyer_id: BUYER, kind: 'item',
            title: 'T', status: 'accepted', proposed_by_id: BUYER,
        }];
        h.tables.marketplace_contract_considerations = [
            { id: 1, contract_id: 'C1', component_type: 'offer', label: 'SECRET-LEG', quantity: 1, notes: null, sort_order: 0 },
        ];
        h.tables.marketplace_reports = [{
            id: 1, listing_id: null, contract_id: 'C1', reporter_id: 99, reason_category: 'spam',
            details: null, status: 'open', created_at: 'now', resolved_at: null, resolved_by_id: null, resolution_note: null,
        }];
        const reports = await listMarketplaceReports('all');
        expect(reports.length).toBe(1);
        expect(JSON.stringify(reports), 'a moderator must not receive the agreed barter terms')
            .not.toContain('SECRET-LEG');
    });
});
