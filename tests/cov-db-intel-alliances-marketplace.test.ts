import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fake, broadcastSpy, filters, hasCall, columnsOf, assertNoWildcardSelects, type FakeQuery } from './cov-db-intel-alliances-fake';

// =============================================================================
// lib/db/marketplace.ts — the module's only authz boundary is per-user
// OWNERSHIP / contract-PARTY membership, re-checked on every id-addressed
// mutation. Covers: category admin, the active-only board + owner views,
// listing create/update (barter-leg validation BEFORE any write, warehouse-link
// authority, the moderation-reopen gate that must fail CLOSED on a read fault,
// the optimistic reopen predicate, insert-then-delete-by-exclusion legs),
// contract lifecycle guards (party/role/status, optimistic flips, warehouse
// deliver/reverse compensation), ratings, reputation/profile scoping,
// party-filter fail-closed, reports + moderation takedown, and id-only emits.
// =============================================================================

const m = vi.hoisted(() => ({ sendPushToUsers: vi.fn() }));

vi.mock('../lib/db/common.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/db/common.js')>();
    const h = await import('./cov-db-intel-alliances-fake');
    return { ...actual, supabase: h.fake.client, broadcastToOrg: h.broadcastSpy };
});
vi.mock('../lib/push.js', () => ({ sendPushToUsers: m.sendPushToUsers }));

import {
    getMarketplaceCategories, listAllMarketplaceCategories, createMarketplaceCategory, updateMarketplaceCategory,
    deleteMarketplaceCategory, browseMarketplaceListings, listMyMarketplaceListings, getMarketplaceListing,
    createMarketplaceListing, updateMarketplaceListing, deleteMarketplaceListing, proposeMarketplaceContract,
    acceptMarketplaceContract, markMarketplaceDelivered, confirmMarketplaceReceived, cancelMarketplaceContract,
    rateMarketplaceContract, getMyMarketplaceContracts, getMarketplaceContract, getMarketplaceMilestones,
    toggleMarketplaceMilestone, deleteMarketplaceMilestone, getContractRatings, getMarketplaceReputation,
    getMarketplaceTraderProfile, filterContractIdsForParty, reportMarketplace, listMarketplaceReports,
    reviewMarketplaceReport, getMarketplaceState,
} from '../lib/db/marketplace';

const ERR_LISTING = 'Listing not found or access denied.';
const ERR_CONTRACT = 'Contract not found or access denied.';
const ERR_MOD = 'This listing was closed by a moderator and cannot be reopened.';
const WH = { permissions: ['warehouse:manage'] };
const CAT_COLS = 'id, slug, name, parent_id, listing_kind, icon, sort_order, active';
const GUARD_COLS = 'id, listing_id, seller_id, buyer_id, kind, quantity, status, proposed_by_id, warehouse_stock_id';

const emits = () => broadcastSpy.mock.calls.map((c) => c as unknown[]);
const mkt = () => emits().filter((c) => c[0] === 'marketplace:update').map((c) => c[1]);
const listingRow = (over: Record<string, unknown> = {}) => ({
    id: 'L1', seller_id: 1, kind: 'item', listing_type: 'sell', category_id: null, title: 'T', description: null, quantity: 5,
    quantity_claimed: 0, price_uec: 10, price_type: 'fixed', location: null, tags: null, status: 'active', expires_at: null,
    warehouse_stock_id: null, created_at: 'c', updated_at: 'u', seller: { id: 1, name: 'S', rsi_handle: 'sh', avatar_url: null },
    category: [{ name: 'Ships', icon: 'i' }], considerations: [
        { id: 2, component_type: 'want', label: 'B', quantity: 1, notes: null, sort_order: 1 },
        { id: 1, component_type: 'offer', label: 'A', quantity: 2, notes: 'n', sort_order: 0 },
        { id: 3, component_type: 'weird', label: 'C', quantity: 1, notes: null, sort_order: 1 },
    ], ...over,
});
const contract = (over: Record<string, unknown> = {}) => ({
    id: 'C1', listing_id: 'L1', seller_id: 1, buyer_id: 2, kind: 'item', quantity: 2, status: 'proposed', proposed_by_id: 2, warehouse_stock_id: null, ...over,
});

beforeEach(() => {
    fake.reset();
    broadcastSpy.mockClear();
    vi.clearAllMocks();
});
afterEach(() => assertNoWildcardSelects(fake));

// =============================================================================
describe('categories', () => {
    it('members see active categories in order; admins see all; errors surface', async () => {
        fake.queue('marketplace_categories', { data: [{ id: 1, slug: 's', name: 'N', parent_id: null, listing_kind: 'item', icon: null, sort_order: 0, active: true }] }, { data: null }, { data: null, error: { message: 'x' } });
        expect(await getMarketplaceCategories()).toEqual([{ id: 1, slug: 's', name: 'N', parentId: null, listingKind: 'item', icon: null, sortOrder: 0, active: true }]);
        const q = fake.find('marketplace_categories')[0];
        expect(q.columns).toBe(CAT_COLS);
        expect(hasCall(q, 'eq', 'active', true)).toBe(true);
        expect(await listAllMarketplaceCategories()).toEqual([]);
        expect(filters(fake.find('marketplace_categories')[1], 'eq')).toHaveLength(0);
        await expect(listAllMarketplaceCategories()).rejects.toThrow('Failed to load marketplace categories');
        fake.queue('marketplace_categories', { data: null, error: { message: 'x' } });
        await expect(getMarketplaceCategories()).rejects.toThrow('Failed to load marketplace categories');
    });

    it('create sanitises name/icon, slugifies, defaults kind/sort/active, emits a bare nudge', async () => {
        await expect(createMarketplaceCategory({ name: '<b></b>' })).rejects.toThrow('Category name is required.');
        await expect(createMarketplaceCategory({ name: '!!!' })).rejects.toThrow('Category name must contain letters or numbers.');
        fake.queue('marketplace_categories', { data: { id: 9, slug: 'big-ships', name: 'Big Ships', parent_id: 3, listing_kind: 'both', icon: null, sort_order: 0, active: true } });
        const out = await createMarketplaceCategory({ name: '  <i>Big</i> Ships! ', parentId: 3, listingKind: 'bogus', icon: '<b></b>', sortOrder: 'x' as unknown as number });
        const ins = fake.find('marketplace_categories', 'insert')[0];
        expect(ins.payload).toEqual({ slug: 'big-ships', name: 'Big Ships!', parent_id: 3, listing_kind: 'both', icon: null, sort_order: 0, active: true });
        expect(ins.columns).toBe(CAT_COLS);
        expect(out.id).toBe(9);
        expect(mkt()).toEqual([{}]);
        fake.queue('marketplace_categories', { data: { id: 10 } });
        await createMarketplaceCategory({ name: 'X', listingKind: 'service', icon: 'ic', sortOrder: 4.7, active: false });
        expect(fake.find('marketplace_categories', 'insert')[1].payload).toMatchObject({ listing_kind: 'service', icon: 'ic', sort_order: 4, active: false, parent_id: null });
        fake.queue('marketplace_categories', { data: null, error: { message: 'dup' } });
        await expect(createMarketplaceCategory({ name: 'Y' })).rejects.toThrow('Failed to create category');
    });

    it('update writes only supplied fields, refuses self-parenting, no-ops on an empty patch', async () => {
        await updateMarketplaceCategory(1, {});
        expect(fake.queries).toHaveLength(0);
        await expect(updateMarketplaceCategory(1, { name: '' })).rejects.toThrow('Category name is required.');
        await expect(updateMarketplaceCategory(1, { parentId: 1 })).rejects.toThrow('A category cannot be its own parent.');
        await updateMarketplaceCategory(1, { name: '<b>N</b>', parentId: null, listingKind: 'item', icon: '', sortOrder: 'z' as unknown as number, active: 0 as unknown as boolean });
        const u = fake.find('marketplace_categories', 'update')[0];
        expect(u.payload).toEqual({ name: 'N', parent_id: null, listing_kind: 'item', icon: null, sort_order: 0, active: false });
        expect(hasCall(u, 'eq', 'id', 1)).toBe(true);
        await updateMarketplaceCategory(1, { listingKind: 'nope', icon: 'ok', sortOrder: 3 });
        expect(fake.find('marketplace_categories', 'update')[1].payload).toEqual({ listing_kind: 'both', icon: 'ok', sort_order: 3 });
        expect(mkt()).toEqual([{}, {}]);
        fake.queue('marketplace_categories', { error: { message: 'x' } });
        await expect(updateMarketplaceCategory(1, { active: true })).rejects.toThrow('Failed to update category');
    });

    it('delete scopes by id and emits; errors surface', async () => {
        await deleteMarketplaceCategory(4);
        expect(hasCall(fake.find('marketplace_categories', 'delete')[0], 'eq', 'id', 4)).toBe(true);
        expect(mkt()).toEqual([{}]);
        fake.queue('marketplace_categories', { error: { message: 'x' } });
        await expect(deleteMarketplaceCategory(4)).rejects.toThrow('Failed to delete category');
    });
});

// =============================================================================
describe('listing reads', () => {
    it('the board is active-only with escaped search + filters and no PII in the projection', async () => {
        fake.queue('marketplace_listings', { data: [listingRow()] });
        const [l] = await browseMarketplaceListings({ kind: 'item', listingType: 'sell', categoryId: 3, search: '50%_off' });
        const q = fake.find('marketplace_listings')[0];
        expect(hasCall(q, 'eq', 'status', 'active')).toBe(true);
        expect(hasCall(q, 'eq', 'kind', 'item')).toBe(true);
        expect(hasCall(q, 'eq', 'listing_type', 'sell')).toBe(true);
        expect(hasCall(q, 'eq', 'category_id', 3)).toBe(true);
        expect(hasCall(q, 'ilike', 'title', '%50\\%\\_off%')).toBe(true);
        expect(hasCall(q, 'limit', 200)).toBe(true);
        for (const banned of ['discord', 'email', 'clearance', 'permissions']) expect(q.columns).not.toContain(banned);
        expect(l).toMatchObject({ categoryName: 'Ships', categoryIcon: 'i', tags: [], seller: { id: 1, name: 'S', rsiHandle: 'sh', avatarUrl: null } });
        expect(l.considerations!.map((c) => [c.id, c.componentType])).toEqual([[1, 'offer'], [2, 'want'], [3, 'want']]);
    });

    it('board: blank search adds no LIKE; null rows / embeds map safely; errors surface', async () => {
        fake.queue('marketplace_listings', { data: [listingRow({ category: null, seller: null, considerations: null, tags: ['x'] })] });
        const [l] = await browseMarketplaceListings({ search: '' });
        expect(filters(fake.find('marketplace_listings')[0], 'ilike')).toHaveLength(0);
        expect(l).toMatchObject({ categoryName: null, categoryIcon: null, seller: undefined, considerations: [], tags: ['x'] });
        fake.queue('marketplace_listings', { data: null });
        expect(await browseMarketplaceListings()).toEqual([]);
        fake.queue('marketplace_listings', { data: null, error: { message: 'x' } });
        await expect(browseMarketplaceListings()).rejects.toThrow('Failed to browse marketplace');
    });

    it('my listings are owner-scoped in every status', async () => {
        fake.queue('marketplace_listings', { data: [listingRow({ status: 'paused' })] }, { data: null }, { data: null, error: { message: 'x' } });
        expect((await listMyMarketplaceListings(1))[0].status).toBe('paused');
        expect(hasCall(fake.find('marketplace_listings')[0], 'eq', 'seller_id', 1)).toBe(true);
        expect(await listMyMarketplaceListings(1)).toEqual([]);
        await expect(listMyMarketplaceListings(1)).rejects.toThrow('Failed to load your listings');
    });

    it('a withdrawn listing is visible by id only to its owner', async () => {
        fake.queue('marketplace_listings', { data: null }, { data: listingRow({ status: 'closed' }) }, { data: listingRow({ status: 'closed' }) }, { data: listingRow() });
        expect(await getMarketplaceListing('L1', 2)).toBeNull();
        expect(await getMarketplaceListing('L1', 2)).toBeNull();
        expect((await getMarketplaceListing('L1', 1))!.id).toBe('L1');
        expect((await getMarketplaceListing('L1', 2))!.id).toBe('L1');
    });
});

// =============================================================================
describe('createMarketplaceListing', () => {
    it('validates quantity, title and barter legs BEFORE any write', async () => {
        await expect(createMarketplaceListing({ kind: 'item', listingType: 'sell', title: 'T', quantity: 0 }, 1)).rejects.toThrow('Item listings require a positive quantity.');
        await expect(createMarketplaceListing({ kind: 'item', listingType: 'sell', title: 'T', quantity: NaN }, 1)).rejects.toThrow('positive quantity');
        await expect(createMarketplaceListing({ kind: 'service', listingType: 'offer', title: '<b></b>' }, 1)).rejects.toThrow('A title is required.');
        const legs = (n: number) => Array.from({ length: n }, () => ({ componentType: 'offer', label: 'x', quantity: 1 }));
        await expect(createMarketplaceListing({ kind: 'service', listingType: 'offer', title: 'T', considerations: legs(11) as never }, 1)).rejects.toThrow('at most 10 barter items');
        await expect(createMarketplaceListing({ kind: 'service', listingType: 'offer', title: 'T', considerations: [{ label: '', quantity: 1 }] as never }, 1)).rejects.toThrow('Every barter item needs a name.');
        await expect(createMarketplaceListing({ kind: 'service', listingType: 'offer', title: 'T', considerations: [null] as never }, 1)).rejects.toThrow('Every barter item needs a name.');
        for (const q of [0, 1.5, 'x', 2_000_000_000]) {
            await expect(createMarketplaceListing({ kind: 'service', listingType: 'offer', title: 'T', considerations: [{ label: 'a', quantity: q }] as never }, 1)).rejects.toThrow('Barter quantity must be a whole number');
        }
        expect(fake.queries).toHaveLength(0);
    });

    it('linking warehouse stock needs warehouse:manage and an existing stock row', async () => {
        await expect(createMarketplaceListing({ kind: 'item', listingType: 'sell', title: 'T', quantity: 1, warehouseStockId: 5 }, 1, { permissions: ['marketplace:list'] })).rejects.toThrow('You need the warehouse:manage permission');
        await expect(createMarketplaceListing({ kind: 'item', listingType: 'sell', title: 'T', quantity: 1, warehouseStockId: 5 }, 1, null)).rejects.toThrow('warehouse:manage');
        await expect(createMarketplaceListing({ kind: 'item', listingType: 'sell', title: 'T', quantity: 1, warehouseStockId: 5 }, 1, {})).rejects.toThrow('warehouse:manage');
        fake.queue('warehouse_stock', { data: null });
        await expect(createMarketplaceListing({ kind: 'item', listingType: 'sell', title: 'T', quantity: 1, warehouseStockId: 5 }, 1, WH)).rejects.toThrow('Linked warehouse stock not found.');
        expect(hasCall(fake.find('warehouse_stock')[0], 'eq', 'id', 5)).toBe(true);
        expect(fake.find('marketplace_listings')).toHaveLength(0);
    });

    it('inserts sanitised fields, clamps price, saves legs from the insert\'s own projection, emits the id', async () => {
        fake.queue('warehouse_stock', { data: { id: 5 } });
        fake.queue('marketplace_listings', { data: listingRow({ id: 'L9', considerations: null }) });
        fake.queue('marketplace_listing_considerations', { data: [{ id: 50, component_type: 'offer', label: 'Gold', quantity: 3, notes: null, sort_order: 0 }] });
        const out = await createMarketplaceListing({
            kind: 'item', listingType: 'sell', title: '<b>Ore</b>', description: '<script>x</script>Desc', quantity: 3, priceUec: -5,
            location: '', tags: Array.from({ length: 15 }, (_, i) => (i === 0 ? '<b></b>' : `t${i}`)), warehouseStockId: 5,
            considerations: [{ componentType: 'offer', label: '<i>Gold</i>', quantity: 3, notes: '' }] as never,
        }, 1, WH);
        const ins = fake.find('marketplace_listings', 'insert')[0];
        const p = ins.payload as Record<string, unknown>;
        expect(p).toMatchObject({ seller_id: 1, kind: 'item', listing_type: 'sell', category_id: null, title: 'Ore', quantity: 3, price_uec: null, price_type: 'fixed', location: null, status: 'active', expires_at: null, warehouse_stock_id: 5 });
        expect(p.description).not.toContain('<script>');
        expect(p.tags).toEqual(Array.from({ length: 11 }, (_, i) => `t${i + 1}`));
        const legs = fake.find('marketplace_listing_considerations', 'insert')[0];
        expect(legs.payload).toEqual([{ component_type: 'offer', label: 'Gold', quantity: 3, notes: null, sort_order: 0, listing_id: 'L9' }]);
        expect(legs.columns).toBe('id, component_type, label, quantity, notes, sort_order');
        expect(out.considerations).toEqual([{ id: 50, componentType: 'offer', label: 'Gold', quantity: 3, notes: null, sortOrder: 0 }]);
        expect(mkt()).toEqual([{ listingId: 'L9' }]);
    });

    it('a service listing has no quantity and ignores the stock link; price clamps; errors surface', async () => {
        fake.queue('marketplace_listings', { data: listingRow({ id: 'S1', kind: 'service' }) });
        await createMarketplaceListing({ kind: 'service', listingType: 'request', title: 'Escort', priceUec: 1e300, priceType: 'hourly', warehouseStockId: 5, tags: 'x' as never, considerations: [] }, 1);
        expect(fake.find('warehouse_stock')).toHaveLength(0);
        expect(fake.find('marketplace_listings', 'insert')[0].payload).toMatchObject({ kind: 'service', quantity: null, price_uec: Number.MAX_SAFE_INTEGER, price_type: 'hourly', tags: [], warehouse_stock_id: null });
        expect(fake.find('marketplace_listing_considerations')).toHaveLength(0);
        fake.queue('marketplace_listings', { data: null, error: { message: 'x' } });
        await expect(createMarketplaceListing({ kind: 'service', listingType: 'offer', title: 'T' }, 1)).rejects.toThrow('Failed to create listing');
        fake.queue('marketplace_listings', { data: listingRow({ id: 'S2' }) });
        fake.queue('marketplace_listing_considerations', { data: null, error: { message: 'x' } });
        await expect(createMarketplaceListing({ kind: 'service', listingType: 'offer', title: 'T', considerations: [{ label: 'a', quantity: 1 }] as never }, 1)).rejects.toThrow('Failed to save barter items');
        fake.queue('marketplace_listings', { data: listingRow({ id: 'S3' }) });
        fake.queue('marketplace_listing_considerations', { data: null });
        const s3 = await createMarketplaceListing({ kind: 'service', listingType: 'offer', title: 'T', priceUec: '' as never, considerations: [{ label: 'a', quantity: 1 }] as never }, 1);
        expect(s3.considerations).toEqual([]);
    });
});

// =============================================================================
describe('updateMarketplaceListing', () => {
    function arm(o: { owner?: unknown; mod?: unknown; update?: unknown; legIns?: unknown; legDel?: unknown } = {}) {
        fake.on('marketplace_listings', (q) => {
            if (q.op === 'select' && q.columns === 'id, seller_id, kind') return (o.owner as never) ?? { data: { id: 'L1', seller_id: 1, kind: 'item' } };
            if (q.op === 'select' && q.columns === 'moderation_closed_at') return (o.mod as never) ?? { data: { moderation_closed_at: null } };
            if (q.op === 'update') return (o.update as never) ?? { data: [{ id: 'L1' }] };
            return { data: null };
        });
        fake.on('marketplace_listing_considerations', (q) => {
            if (q.op === 'insert') return (o.legIns as never) ?? { data: [{ id: 70 }, { id: 71 }] };
            if (q.op === 'delete') return (o.legDel as never) ?? { error: null };
            return { data: null };
        });
    }
    const upd = () => fake.find('marketplace_listings', 'update')[0];

    it('rejects a malformed bundle before ANY read or write', async () => {
        await expect(updateMarketplaceListing('L1', { title: 'New', considerations: [{ label: '', quantity: 1 }] as never }, 1)).rejects.toThrow('Every barter item needs a name.');
        expect(fake.queries).toHaveLength(0);
    });

    it('owner-only: a missing row or a non-owner gets the generic error', async () => {
        arm({ owner: { data: null } });
        await expect(updateMarketplaceListing('L1', { title: 'x' }, 1)).rejects.toThrow(ERR_LISTING);
        arm({ owner: { data: { id: 'L1', seller_id: 9, kind: 'item' } } });
        await expect(updateMarketplaceListing('L1', { title: 'x' }, 1)).rejects.toThrow(ERR_LISTING);
        expect(fake.find('marketplace_listings', 'update')).toHaveLength(0);
    });

    it('a reopen is refused for a moderator-closed listing, and FAILS CLOSED on a moderation read fault', async () => {
        arm({ mod: { data: { moderation_closed_at: '2026-01-01' } } });
        await expect(updateMarketplaceListing('L1', { status: 'active' }, 1)).rejects.toThrow(ERR_MOD);
        arm({ mod: { data: null, error: { code: '08006', message: 'reset' } } });
        await expect(updateMarketplaceListing('L1', { status: 'active' }, 1)).rejects.toThrow('Failed to verify listing moderation state');
        expect(fake.find('marketplace_listings', 'update')).toHaveLength(0);
    });

    it('a reopen with the column present carries the optimistic is(moderation_closed_at, null) predicate', async () => {
        arm();
        await updateMarketplaceListing('L1', { status: 'active' }, 1);
        expect(hasCall(upd(), 'is', 'moderation_closed_at', null)).toBe(true);
        expect(hasCall(upd(), 'eq', 'seller_id', 1)).toBe(true);
        expect(upd().columns).toBe('id');
        expect(mkt()).toEqual([{ listingId: 'L1' }]);
    });

    it.each([['42703'], ['PGRST204']])('schema drift (%s) soft-fails the moderation read and omits the predicate', async (code) => {
        arm({ mod: { data: null, error: { code } } });
        await updateMarketplaceListing('L1', { status: 'active' }, 1);
        expect(filters(upd(), 'is')).toHaveLength(0);
        expect(upd().payload).toMatchObject({ status: 'active' });
    });

    it('a write that matched zero rows is a refusal (moderation race vs ownership move)', async () => {
        arm({ update: { data: [] } });
        await expect(updateMarketplaceListing('L1', { status: 'active' }, 1)).rejects.toThrow(ERR_MOD);
        arm({ update: { data: null } });
        await expect(updateMarketplaceListing('L1', { title: 'x' }, 1)).rejects.toThrow(ERR_LISTING);
        arm({ update: { data: null, error: { message: 'x' } } });
        await expect(updateMarketplaceListing('L1', { title: 'x' }, 1)).rejects.toThrow('Failed to update listing');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('writes only supplied, sanitised fields; unknown statuses are ignored; non-active status skips the moderation read', async () => {
        arm();
        await updateMarketplaceListing('L1', {
            title: '<b>N</b>', description: '', priceUec: 'abc' as never, priceType: 'auction', location: '<i>Port</i>',
            categoryId: 4, tags: ['a', '<b></b>'], expiresAt: 'e', status: 'deleted',
        }, 1);
        expect(fake.find('marketplace_listings').some((q) => q.columns === 'moderation_closed_at')).toBe(false);
        const p = upd().payload as Record<string, unknown>;
        expect(p).toMatchObject({ title: 'N', description: null, price_uec: null, price_type: 'auction', location: 'Port', category_id: 4, tags: ['a'], expires_at: 'e' });
        expect('status' in p).toBe(false);
        arm();
        await updateMarketplaceListing('L1', { tags: 'x' as never, status: 'paused' }, 1);
        expect(fake.find('marketplace_listings', 'update')[1].payload).toMatchObject({ tags: [], status: 'paused' });
        expect(fake.find('marketplace_listing_considerations')).toHaveLength(0);
    });

    it('replaces legs insert-first then deletes BY EXCLUSION; [] clears; null leaves them alone', async () => {
        arm();
        await updateMarketplaceListing('L1', { considerations: [{ label: 'a', quantity: 1 }, { componentType: 'offer', label: 'b', quantity: 2 }] as never }, 1);
        const [ins] = fake.find('marketplace_listing_considerations', 'insert');
        expect(ins.payload).toEqual([
            { component_type: 'want', label: 'a', quantity: 1, notes: null, sort_order: 0, listing_id: 'L1' },
            { component_type: 'offer', label: 'b', quantity: 2, notes: null, sort_order: 1, listing_id: 'L1' },
        ]);
        const del = fake.find('marketplace_listing_considerations', 'delete')[0];
        expect(hasCall(del, 'eq', 'listing_id', 'L1')).toBe(true);
        expect(hasCall(del, 'not', 'id', 'in', '(70,71)')).toBe(true);
        fake.reset(); arm();
        await updateMarketplaceListing('L1', { considerations: [] }, 1);
        const clear = fake.find('marketplace_listing_considerations', 'delete')[0];
        expect(filters(clear, 'not')).toHaveLength(0);
        expect(fake.find('marketplace_listing_considerations', 'insert')).toHaveLength(0);
        fake.reset(); arm();
        await updateMarketplaceListing('L1', { considerations: null }, 1);
        expect(fake.find('marketplace_listing_considerations')).toHaveLength(0);
    });

    it('leg write failures surface (insert, exclusion delete, clear); a null insert projection keeps nothing', async () => {
        arm({ legIns: { data: null, error: { message: 'x' } } });
        await expect(updateMarketplaceListing('L1', { considerations: [{ label: 'a', quantity: 1 }] as never }, 1)).rejects.toThrow('Failed to save barter items');
        arm({ legDel: { error: { message: 'x' } } });
        await expect(updateMarketplaceListing('L1', { considerations: [{ label: 'a', quantity: 1 }] as never }, 1)).rejects.toThrow('Failed to replace barter items');
        arm({ legDel: { error: { message: 'x' } } });
        await expect(updateMarketplaceListing('L1', { considerations: [] }, 1)).rejects.toThrow('Failed to clear barter items');
        fake.reset();
        arm({ legIns: { data: null } });
        await updateMarketplaceListing('L1', { considerations: [{ label: 'a', quantity: 1 }] as never }, 1);
        expect(hasCall(fake.find('marketplace_listing_considerations', 'delete')[0], 'not', 'id', 'in', '()')).toBe(true);
    });

    it('delete is owner-only and scoped by seller_id', async () => {
        fake.queue('marketplace_listings', { data: null });
        await expect(deleteMarketplaceListing('L1', 1)).rejects.toThrow(ERR_LISTING);
        fake.queue('marketplace_listings', { data: { id: 'L1', seller_id: 2 } });
        await expect(deleteMarketplaceListing('L1', 1)).rejects.toThrow(ERR_LISTING);
        fake.queue('marketplace_listings', { data: { id: 'L1', seller_id: 1 } }, { error: null });
        await deleteMarketplaceListing('L1', 1);
        const d = fake.find('marketplace_listings', 'delete')[0];
        expect(hasCall(d, 'eq', 'id', 'L1')).toBe(true);
        expect(hasCall(d, 'eq', 'seller_id', 1)).toBe(true);
        expect(mkt()).toEqual([{ listingId: 'L1' }]);
        fake.queue('marketplace_listings', { data: { id: 'L1', seller_id: 1 } }, { error: { message: 'x' } });
        await expect(deleteMarketplaceListing('L1', 1)).rejects.toThrow('Failed to delete listing');
    });
});

// =============================================================================
describe('proposeMarketplaceContract', () => {
    function arm(o: { listing?: unknown; live?: unknown; insert?: unknown; legs?: unknown } = {}) {
        fake.on('marketplace_listings', (o.listing as never) ?? { data: { id: 'L1', seller_id: 1, kind: 'item', listing_type: 'sell', title: 'Ore', quantity: 10, quantity_claimed: 7, status: 'active' } });
        fake.on('marketplace_contracts', (q) => (q.op === 'select' ? (o.live as never) ?? { data: null } : (o.insert as never) ?? { data: { id: 'C1', seller_id: 1, buyer_id: 2, status: 'proposed', considerations: null } }));
        fake.on('marketplace_contract_considerations', (o.legs as never) ?? { data: [{ id: 5, component_type: 'offer', label: 'Gold', quantity: 1, notes: null, sort_order: 0 }] });
        fake.on('marketplace_contract_milestones', { error: null });
    }

    it('refuses inactive/unknown listings, self-contracting and a second live contract', async () => {
        arm({ listing: { data: null } });
        await expect(proposeMarketplaceContract({ listingId: 'L1' }, 2)).rejects.toThrow(ERR_LISTING);
        arm({ listing: { data: { id: 'L1', seller_id: 1, status: 'paused' } } });
        await expect(proposeMarketplaceContract({ listingId: 'L1' }, 2)).rejects.toThrow(ERR_LISTING);
        arm();
        await expect(proposeMarketplaceContract({ listingId: 'L1' }, 1)).rejects.toThrow('You cannot contract your own listing.');
        arm({ live: { data: { id: 'C0' } } });
        await expect(proposeMarketplaceContract({ listingId: 'L1', quantity: 1 }, 2)).rejects.toThrow('You already have an active contract on this listing.');
        const dedup = fake.find('marketplace_contracts', 'select')[0];
        expect(hasCall(dedup, 'in', 'status', ['proposed', 'accepted', 'in_progress', 'delivered'])).toBe(true);
        expect(hasCall(dedup, 'eq', 'proposed_by_id', 2)).toBe(true);
        expect(fake.find('marketplace_contracts', 'insert')).toHaveLength(0);
    });

    it('items need a positive quantity within what remains (no over-claim)', async () => {
        arm();
        await expect(proposeMarketplaceContract({ listingId: 'L1', quantity: 0 }, 2)).rejects.toThrow('A positive quantity is required.');
        await expect(proposeMarketplaceContract({ listingId: 'L1', quantity: 4 }, 2)).rejects.toThrow('Only 3 remaining on this listing.');
        arm({ listing: { data: { id: 'L1', seller_id: 1, kind: 'item', listing_type: 'sell', title: 'Ore', quantity: null, quantity_claimed: null, status: 'active' } } });
        await expect(proposeMarketplaceContract({ listingId: 'L1', quantity: 1 }, 2)).rejects.toThrow('Only 0 remaining on this listing.');
        expect(fake.find('marketplace_contracts', 'insert')).toHaveLength(0);
    });

    it('derives parties from the listing type, freezes the proposer\'s legs as offers, caps milestones', async () => {
        arm();
        const out = await proposeMarketplaceContract({
            listingId: 'L1', quantity: 3, agreedPriceUec: 99.9, termsNote: '<b>terms</b>',
            considerations: [{ componentType: 'want', label: 'Gold', quantity: 1 }] as never,
            milestones: [...Array.from({ length: 21 }, (_, i) => ({ title: `m${i}`, description: '<i>d</i>' })), { title: '' }],
        }, 2);
        const ins = fake.find('marketplace_contracts', 'insert')[0];
        expect(ins.payload).toMatchObject({ listing_id: 'L1', seller_id: 1, buyer_id: 2, kind: 'item', title: 'Ore', quantity: 3, agreed_price_uec: 99, terms_note: 'terms', status: 'proposed', proposed_by_id: 2 });
        expect(columnsOf(ins)).toContain('considerations:marketplace_contract_considerations(id, component_type, label, quantity, notes, sort_order)');
        expect(fake.find('marketplace_contract_considerations', 'insert')[0].payload).toEqual([{ component_type: 'offer', label: 'Gold', quantity: 1, notes: null, sort_order: 0, contract_id: 'C1' }]);
        const ms = fake.find('marketplace_contract_milestones', 'insert')[0].payload as Array<Record<string, unknown>>;
        expect(ms).toHaveLength(20);
        expect(ms[0]).toEqual({ contract_id: 'C1', title: 'm0', description: 'd', sort_order: 0 });
        expect(out.considerations).toHaveLength(1);
        expect(mkt()).toEqual([{ contractId: 'C1' }]);
    });

    it('buy/request listings make the proposer the seller; services carry no quantity; empty milestone titles insert nothing', async () => {
        arm({ listing: { data: { id: 'L2', seller_id: 1, kind: 'service', listing_type: 'request', title: 'Escort', quantity: null, quantity_claimed: 0, status: 'active' } } });
        await proposeMarketplaceContract({ listingId: 'L2', milestones: [{ title: '<b></b>' }] }, 2);
        expect(fake.find('marketplace_contracts', 'insert')[0].payload).toMatchObject({ seller_id: 2, buyer_id: 1, quantity: null, agreed_price_uec: null, terms_note: null });
        expect(fake.find('marketplace_contract_milestones')).toHaveLength(0);
        expect(fake.find('marketplace_contract_considerations')).toHaveLength(0);
        arm({ listing: { data: { id: 'L3', seller_id: 1, kind: 'service', listing_type: 'buy', title: 'X', status: 'active' } } });
        await proposeMarketplaceContract({ listingId: 'L3' }, 2);
        expect(fake.find('marketplace_contracts', 'insert')[1].payload).toMatchObject({ seller_id: 2, buyer_id: 1 });
        arm({ listing: { data: { id: 'L4', seller_id: 1, kind: 'service', listing_type: 'offer', title: 'X', status: 'active' } } });
        await proposeMarketplaceContract({ listingId: 'L4' }, 2);
        expect(fake.find('marketplace_contracts', 'insert')[2].payload).toMatchObject({ seller_id: 1, buyer_id: 2 });
    });

    it('surfaces contract + leg write failures; a null leg projection maps to none', async () => {
        arm({ insert: { data: null, error: { message: 'x' } } });
        await expect(proposeMarketplaceContract({ listingId: 'L1', quantity: 1 }, 2)).rejects.toThrow('Failed to propose contract');
        arm({ legs: { data: null, error: { message: 'x' } } });
        await expect(proposeMarketplaceContract({ listingId: 'L1', quantity: 1, considerations: [{ label: 'a', quantity: 1 }] as never }, 2)).rejects.toThrow('Failed to record barter items');
        arm({ legs: { data: null } });
        expect((await proposeMarketplaceContract({ listingId: 'L1', quantity: 1, considerations: [{ label: 'a', quantity: 1 }] as never }, 2)).considerations).toEqual([]);
    });
});

// =============================================================================
describe('contract lifecycle', () => {
    const guarded = (row: unknown) => fake.queue('marketplace_contracts', { data: row });

    it('accept: only the non-proposer party, only from proposed; RPC verdicts map to errors; emits listing + contract', async () => {
        guarded(null);
        await expect(acceptMarketplaceContract('C1', 1)).rejects.toThrow(ERR_CONTRACT);
        guarded(contract());
        await expect(acceptMarketplaceContract('C1', 2)).rejects.toThrow(ERR_CONTRACT); // proposer (buyer) cannot accept
        guarded(contract({ proposed_by_id: 1 }));
        await expect(acceptMarketplaceContract('C1', 1)).rejects.toThrow(ERR_CONTRACT); // proposer (seller) cannot accept
        guarded(contract({ status: 'accepted' }));
        await expect(acceptMarketplaceContract('C1', 1)).rejects.toThrow('This contract can no longer be accepted.');
        for (const [verdict, msg] of [['forbidden', ERR_CONTRACT], ['bad_state', 'no longer be accepted'], ['full', 'no longer has enough remaining quantity']]) {
            guarded(contract());
            fake.queue('rpc:marketplace_accept_contract', { data: verdict });
            await expect(acceptMarketplaceContract('C1', 1)).rejects.toThrow(msg);
        }
        guarded(contract());
        fake.queue('rpc:marketplace_accept_contract', { data: null, error: { message: 'x' } });
        await expect(acceptMarketplaceContract('C1', 1)).rejects.toThrow('Failed to accept contract');
        expect(broadcastSpy).not.toHaveBeenCalled();
        guarded(contract());
        fake.queue('rpc:marketplace_accept_contract', { data: 'ok' });
        await acceptMarketplaceContract('C1', 1);
        expect(fake.find('marketplace_accept_contract', 'rpc').at(-1)!.payload).toEqual({ p_contract_id: 'C1', p_actor_id: 1 });
        expect(fake.find('marketplace_contracts')[0].columns).toBe(GUARD_COLS);
        expect(mkt()).toEqual([{ listingId: 'L1' }, { contractId: 'C1' }]);
        broadcastSpy.mockClear();
        guarded(contract({ listing_id: null, proposed_by_id: 1 }));
        fake.queue('rpc:marketplace_accept_contract', { data: 'ok' });
        await acceptMarketplaceContract('C1', 2);
        expect(mkt()).toEqual([{ contractId: 'C1' }]);
    });

    describe('markMarketplaceDelivered', () => {
        it('seller only, from accepted/in_progress only; warehouse-linked items need warehouse:manage BEFORE the flip', async () => {
            guarded(null);
            await expect(markMarketplaceDelivered('C1', 1)).rejects.toThrow(ERR_CONTRACT);
            guarded(contract({ status: 'accepted' }));
            await expect(markMarketplaceDelivered('C1', 2)).rejects.toThrow(ERR_CONTRACT);
            guarded(contract({ status: 'proposed' }));
            await expect(markMarketplaceDelivered('C1', 1)).rejects.toThrow('This contract is not ready to deliver.');
            guarded(contract({ status: 'accepted', warehouse_stock_id: 5 }));
            await expect(markMarketplaceDelivered('C1', 1, { permissions: [] })).rejects.toThrow('warehouse:manage');
            expect(fake.find('marketplace_contracts', 'update')).toHaveLength(0);
        });

        it('flips under an optimistic status guard; a lost race never touches stock', async () => {
            guarded(contract({ status: 'in_progress', warehouse_stock_id: 5 }));
            fake.queue('marketplace_contracts', { data: [] });
            await expect(markMarketplaceDelivered('C1', 1, WH)).rejects.toThrow('This contract is not ready to deliver.');
            const flip = fake.find('marketplace_contracts', 'update')[0];
            expect(hasCall(flip, 'eq', 'status', 'in_progress')).toBe(true);
            expect(hasCall(flip, 'eq', 'seller_id', 1)).toBe(true);
            expect(fake.find('warehouse_marketplace_deliver', 'rpc')).toHaveLength(0);
            guarded(contract({ status: 'accepted' }));
            fake.queue('marketplace_contracts', { data: null, error: { message: 'x' } });
            await expect(markMarketplaceDelivered('C1', 1)).rejects.toThrow('Failed to mark delivered');
        });

        it('moves warehouse stock after owning the transition and nudges stock + contract', async () => {
            guarded(contract({ status: 'accepted', warehouse_stock_id: 5 }));
            fake.queue('marketplace_contracts', { data: [{ id: 'C1' }] });
            await markMarketplaceDelivered('C1', 1, WH);
            expect(fake.find('warehouse_marketplace_deliver', 'rpc')[0].payload).toEqual({ p_contract_id: 'C1', p_actor_id: 1 });
            expect(emits().map((c) => c[0])).toEqual(['warehouse:stock_update', 'marketplace:update']);
            broadcastSpy.mockClear();
            guarded(contract({ status: 'accepted', kind: 'service' }));
            fake.queue('marketplace_contracts', { data: null });
            await markMarketplaceDelivered('C1', 1);
            expect(emits().map((c) => c[0])).toEqual(['marketplace:update']);
        });

        it('a failed stock movement reverts the delivered flip; the insufficient-stock RAISE gets fixed copy, others an opaque message', async () => {
            guarded(contract({ status: 'in_progress', warehouse_stock_id: 5 }));
            fake.queue('marketplace_contracts', { data: [{ id: 'C1' }] }, { error: null });
            fake.queue('rpc:warehouse_marketplace_deliver', { error: { message: 'WAREHOUSE_INSUFFICIENT_STOCK: have 1' } });
            await expect(markMarketplaceDelivered('C1', 1, WH)).rejects.toThrow('Stock movement failed: the linked warehouse stock does not have enough on hand');
            const revert = fake.find('marketplace_contracts', 'update')[1];
            expect(revert.payload).toMatchObject({ status: 'in_progress', delivered_at: null });
            expect(hasCall(revert, 'eq', 'status', 'delivered')).toBe(true);
            expect(hasCall(revert, 'eq', 'id', 'C1')).toBe(true);
            guarded(contract({ status: 'accepted', warehouse_stock_id: 5 }));
            fake.queue('marketplace_contracts', { data: [{ id: 'C1' }] }, { error: null });
            fake.queue('rpc:warehouse_marketplace_deliver', { error: { message: 'relation "x" does not exist', code: '42P01' } });
            const err = await markMarketplaceDelivered('C1', 1, WH).catch((e) => e);
            expect(err.message).toBe('Stock movement failed');
            fake.queue('marketplace_contracts', { data: contract({ status: 'accepted', warehouse_stock_id: 5 }) }, { data: [{ id: 'C1' }] }, { error: null });
            fake.queue('rpc:warehouse_marketplace_deliver', { error: { message: 42 } });
            await expect(markMarketplaceDelivered('C1', 1, WH)).rejects.toThrow('Stock movement failed');
            expect(emits().some((c) => c[0] === 'warehouse:stock_update')).toBe(false);
        });
    });

    it('confirm: buyer only, from delivered only; warehouse items need a recorded delivery movement; optimistic flip', async () => {
        guarded(null);
        await expect(confirmMarketplaceReceived('C1', 2)).rejects.toThrow(ERR_CONTRACT);
        guarded(contract({ status: 'delivered' }));
        await expect(confirmMarketplaceReceived('C1', 1)).rejects.toThrow(ERR_CONTRACT);
        guarded(contract({ status: 'accepted' }));
        await expect(confirmMarketplaceReceived('C1', 2)).rejects.toThrow('This contract is not awaiting confirmation.');
        guarded(contract({ status: 'delivered', warehouse_stock_id: 5 }));
        fake.queue('warehouse_movements', { data: null });
        await expect(confirmMarketplaceReceived('C1', 2)).rejects.toThrow('Delivery has not been recorded for this contract yet.');
        const mv = fake.find('warehouse_movements')[0];
        expect(hasCall(mv, 'eq', 'related_contract_id', 'C1')).toBe(true);
        expect(hasCall(mv, 'in', 'reason', ['withdraw_sale', 'restock'])).toBe(true);
        expect(hasCall(mv, 'is', 'related_movement_id', null)).toBe(true);
        guarded(contract({ status: 'delivered', warehouse_stock_id: 5 }));
        fake.queue('warehouse_movements', { data: { id: 1 } });
        fake.queue('marketplace_contracts', { data: [] });
        await expect(confirmMarketplaceReceived('C1', 2)).rejects.toThrow('This contract is not awaiting confirmation.');
        guarded(contract({ status: 'delivered' }));
        fake.queue('marketplace_contracts', { data: null, error: { message: 'x' } });
        await expect(confirmMarketplaceReceived('C1', 2)).rejects.toThrow('Failed to confirm receipt');
        guarded(contract({ status: 'delivered' }));
        fake.queue('marketplace_contracts', { data: [{ id: 'C1' }] });
        await confirmMarketplaceReceived('C1', 2);
        const flip = fake.find('marketplace_contracts', 'update').at(-1)!;
        expect(flip.payload).toMatchObject({ status: 'completed' });
        expect(hasCall(flip, 'eq', 'buyer_id', 2)).toBe(true);
        expect(mkt()).toEqual([{ contractId: 'C1' }]);
    });

    describe('cancelMarketplaceContract', () => {
        it('party only, never from a terminal status; warehouse-linked delivered items need warehouse:manage', async () => {
            guarded(null);
            await expect(cancelMarketplaceContract('C1', 1)).rejects.toThrow(ERR_CONTRACT);
            guarded(contract());
            await expect(cancelMarketplaceContract('C1', 3)).rejects.toThrow(ERR_CONTRACT);
            guarded(contract({ status: 'completed' }));
            await expect(cancelMarketplaceContract('C1', 1)).rejects.toThrow('This contract can no longer be cancelled.');
            guarded(contract({ status: 'delivered', warehouse_stock_id: 5 }));
            await expect(cancelMarketplaceContract('C1', 2)).rejects.toThrow('warehouse:manage');
            expect(fake.find('marketplace_contracts', 'update')).toHaveLength(0);
        });

        it('a proposed cancel releases nothing; a lost race is a refusal; write errors surface', async () => {
            guarded(contract());
            fake.queue('marketplace_contracts', { data: [{ id: 'C1' }] });
            await cancelMarketplaceContract('C1', 2, '<b>changed mind</b>');
            const flip = fake.find('marketplace_contracts', 'update')[0];
            expect(flip.payload).toMatchObject({ status: 'cancelled', cancel_reason: 'changed mind' });
            expect(hasCall(flip, 'eq', 'status', 'proposed')).toBe(true);
            expect(fake.queries.filter((q) => q.op === 'rpc')).toHaveLength(0);
            expect(mkt()).toEqual([{ contractId: 'C1' }]);
            guarded(contract());
            fake.queue('marketplace_contracts', { data: [] });
            await expect(cancelMarketplaceContract('C1', 2)).rejects.toThrow('This contract can no longer be cancelled.');
            guarded(contract());
            fake.queue('marketplace_contracts', { data: null, error: { message: 'x' } });
            await expect(cancelMarketplaceContract('C1', 2)).rejects.toThrow('Failed to cancel contract');
        });

        it('an accepted cancel releases the reservation (emitting the listing); a release failure only logs', async () => {
            guarded(contract({ status: 'accepted' }));
            fake.queue('marketplace_contracts', { data: null });
            await cancelMarketplaceContract('C1', 1);
            expect(fake.find('marketplace_release_listing', 'rpc')[0].payload).toEqual({ p_listing_id: 'L1', p_qty: 2 });
            expect(mkt()).toEqual([{ listingId: 'L1' }, { contractId: 'C1' }]);
            broadcastSpy.mockClear();
            guarded(contract({ status: 'accepted' }));
            fake.queue('marketplace_contracts', { data: [{ id: 'C1' }] });
            fake.queue('rpc:marketplace_release_listing', { error: { message: 'x' } });
            await cancelMarketplaceContract('C1', 1, '');
            expect(mkt()).toEqual([{ contractId: 'C1' }]);
            expect(fake.find('marketplace_contracts', 'update').at(-1)!.payload).toMatchObject({ cancel_reason: null });
        });

        it('a delivered warehouse cancel reverses the stock movement (nudging stock); a reversal failure only logs', async () => {
            guarded(contract({ status: 'delivered', warehouse_stock_id: 5 }));
            fake.queue('marketplace_contracts', { data: [{ id: 'C1' }] });
            await cancelMarketplaceContract('C1', 1, 'r', WH);
            expect(fake.find('warehouse_marketplace_reverse', 'rpc')[0].payload).toEqual({ p_contract_id: 'C1', p_actor_id: 1, p_reason: 'Marketplace contract cancelled' });
            expect(emits().map((c) => c[0])).toEqual(['marketplace:update', 'warehouse:stock_update', 'marketplace:update']);
            broadcastSpy.mockClear();
            guarded(contract({ status: 'delivered', warehouse_stock_id: 5 }));
            fake.queue('marketplace_contracts', { data: [{ id: 'C1' }] });
            fake.queue('rpc:warehouse_marketplace_reverse', { error: { message: 'x' } });
            await cancelMarketplaceContract('C1', 1, 'r', WH);
            expect(emits().some((c) => c[0] === 'warehouse:stock_update')).toBe(false);
        });

        it('services / unlinked / quantity-less contracts skip both compensations', async () => {
            guarded(contract({ status: 'delivered', kind: 'service', warehouse_stock_id: 5 }));
            fake.queue('marketplace_contracts', { data: [{ id: 'C1' }] });
            await cancelMarketplaceContract('C1', 1);
            guarded(contract({ status: 'accepted', listing_id: null }));
            fake.queue('marketplace_contracts', { data: [{ id: 'C1' }] });
            await cancelMarketplaceContract('C1', 1);
            guarded(contract({ status: 'accepted', quantity: null }));
            fake.queue('marketplace_contracts', { data: [{ id: 'C1' }] });
            await cancelMarketplaceContract('C1', 1);
            expect(fake.queries.filter((q) => q.op === 'rpc')).toHaveLength(0);
        });
    });

    it('rating: party only, completed only, 1-5 stars, one per party (23505), ratee is the counterparty', async () => {
        guarded(null);
        await expect(rateMarketplaceContract('C1', { stars: 5 }, 1)).rejects.toThrow(ERR_CONTRACT);
        guarded(contract({ status: 'completed' }));
        await expect(rateMarketplaceContract('C1', { stars: 5 }, 3)).rejects.toThrow(ERR_CONTRACT);
        guarded(contract({ status: 'delivered' }));
        await expect(rateMarketplaceContract('C1', { stars: 5 }, 1)).rejects.toThrow('You can only rate a completed contract.');
        for (const s of [0, 6, NaN]) {
            guarded(contract({ status: 'completed' }));
            await expect(rateMarketplaceContract('C1', { stars: s }, 1)).rejects.toThrow('Rating must be 1–5 stars.');
        }
        guarded(contract({ status: 'completed' }));
        await rateMarketplaceContract('C1', { stars: 4.6, feedback: '<b>great</b>' }, 1);
        expect(fake.find('marketplace_ratings', 'insert')[0].payload).toEqual({ contract_id: 'C1', rater_id: 1, ratee_id: 2, rater_role: 'seller', stars: 5, feedback: 'great' });
        guarded(contract({ status: 'completed' }));
        await rateMarketplaceContract('C1', { stars: 1 }, 2);
        expect(fake.find('marketplace_ratings', 'insert')[1].payload).toMatchObject({ rater_id: 2, ratee_id: 1, rater_role: 'buyer', feedback: null });
        expect(mkt()).toEqual([{ contractId: 'C1' }, { contractId: 'C1' }]);
        guarded(contract({ status: 'completed' }));
        fake.queue('marketplace_ratings', { error: { code: '23505' } });
        await expect(rateMarketplaceContract('C1', { stars: 3 }, 1)).rejects.toThrow('You have already rated this contract.');
        guarded(contract({ status: 'completed' }));
        fake.queue('marketplace_ratings', { error: { code: 'XX' } });
        await expect(rateMarketplaceContract('C1', { stars: 3 }, 1)).rejects.toThrow('Failed to submit rating');
    });
});

// =============================================================================
describe('party-scoped reads + milestones', () => {
    it('my contracts are the caller\'s seller-or-buyer rows only', async () => {
        fake.queue('marketplace_contracts', { data: [{ id: 'C1', seller_id: 1, buyer_id: 2, seller: [{ id: 1, name: 'S', rsi_handle: null, avatar_url: null }], buyer: null }] }, { data: null }, { data: null, error: { message: 'x' } });
        const [c] = await getMyMarketplaceContracts(2);
        expect(hasCall(fake.find('marketplace_contracts')[0], 'or', 'seller_id.eq.2,buyer_id.eq.2')).toBe(true);
        expect(c).toMatchObject({ id: 'C1', seller: { id: 1, name: 'S' }, buyer: undefined, considerations: [] });
        expect(await getMyMarketplaceContracts(2)).toEqual([]);
        await expect(getMyMarketplaceContracts(2)).rejects.toThrow('Failed to load contracts');
    });

    it('single-contract read returns null to non-parties (no existence leak) and attaches milestones for parties', async () => {
        fake.queue('marketplace_contracts', { data: null }, { data: { id: 'C1', seller_id: 1, buyer_id: 2 } }, { data: { id: 'C1', seller_id: 1, buyer_id: 2 } }, { data: { seller_id: 1, buyer_id: 2, status: 'accepted' } });
        fake.queue('marketplace_contract_milestones', { data: [{ id: 1, contract_id: 'C1', title: 'M', description: null, sort_order: 0, completed_at: null, completed_by_id: null }] });
        expect(await getMarketplaceContract('C1', 1)).toBeNull();
        expect(await getMarketplaceContract('C1', 3)).toBeNull();
        const c = (await getMarketplaceContract('C1', 2))!;
        expect(c.milestones).toEqual([{ id: 1, contractId: 'C1', title: 'M', description: null, sortOrder: 0, completedAt: null, completedById: null }]);
    });

    it('milestone list is party-gated; null data → []', async () => {
        fake.queue('marketplace_contracts', { data: null }, { data: { seller_id: 1, buyer_id: 2, status: 'accepted' } });
        await expect(getMarketplaceMilestones('C1', 1)).rejects.toThrow(ERR_CONTRACT);
        expect(await getMarketplaceMilestones('C1', 1)).toEqual([]);
        expect(hasCall(fake.find('marketplace_contract_milestones')[0], 'order', 'sort_order', { ascending: true })).toBe(true);
    });

    it('toggle: seller only, accepted/in_progress only; first completion advances accepted → in_progress', async () => {
        fake.queue('marketplace_contract_milestones', { data: null });
        await expect(toggleMarketplaceMilestone(1, 1)).rejects.toThrow(ERR_CONTRACT);
        fake.queue('marketplace_contract_milestones', { data: { id: 1, contract_id: 'C1', completed_at: null } });
        fake.queue('marketplace_contracts', { data: { seller_id: 1, buyer_id: 2, status: 'accepted' } });
        await expect(toggleMarketplaceMilestone(1, 2)).rejects.toThrow(ERR_CONTRACT);
        fake.queue('marketplace_contract_milestones', { data: { id: 1, contract_id: 'C1', completed_at: null } });
        fake.queue('marketplace_contracts', { data: { seller_id: 1, buyer_id: 2, status: 'completed' } });
        await expect(toggleMarketplaceMilestone(1, 1)).rejects.toThrow('Milestones are locked once the contract is no longer in progress.');
        expect(fake.find('marketplace_contract_milestones', 'update')).toHaveLength(0);

        fake.queue('marketplace_contract_milestones', { data: { id: 1, contract_id: 'C1', completed_at: null } });
        fake.queue('marketplace_contracts', { data: { seller_id: 1, buyer_id: 2, status: 'accepted' } });
        await toggleMarketplaceMilestone(1, 1);
        expect(fake.find('marketplace_contract_milestones', 'update')[0].payload).toMatchObject({ completed_by_id: 1 });
        const adv = fake.find('marketplace_contracts', 'update')[0];
        expect(adv.payload).toMatchObject({ status: 'in_progress' });
        expect(hasCall(adv, 'eq', 'status', 'accepted')).toBe(true);
        expect(mkt()).toEqual([{ contractId: 'C1' }]);

        fake.queue('marketplace_contract_milestones', { data: { id: 1, contract_id: 'C1', completed_at: 'done' } });
        fake.queue('marketplace_contracts', { data: { seller_id: 1, buyer_id: 2, status: 'in_progress' } });
        await toggleMarketplaceMilestone(1, 1);
        expect(fake.find('marketplace_contract_milestones', 'update')[1].payload).toEqual({ completed_at: null, completed_by_id: null });
        expect(fake.find('marketplace_contracts', 'update')).toHaveLength(1);
    });

    it('delete: seller only, proposed/accepted only', async () => {
        fake.queue('marketplace_contract_milestones', { data: null });
        await expect(deleteMarketplaceMilestone(1, 1)).rejects.toThrow(ERR_CONTRACT);
        fake.queue('marketplace_contract_milestones', { data: { id: 1, contract_id: 'C1' } });
        fake.queue('marketplace_contracts', { data: { seller_id: 1, buyer_id: 2, status: 'proposed' } });
        await expect(deleteMarketplaceMilestone(1, 2)).rejects.toThrow(ERR_CONTRACT);
        fake.queue('marketplace_contract_milestones', { data: { id: 1, contract_id: 'C1' } });
        fake.queue('marketplace_contracts', { data: { seller_id: 1, buyer_id: 2, status: 'in_progress' } });
        await expect(deleteMarketplaceMilestone(1, 1)).rejects.toThrow('Milestones are locked once work is underway.');
        fake.queue('marketplace_contract_milestones', { data: { id: 1, contract_id: 'C1' } });
        fake.queue('marketplace_contracts', { data: { seller_id: 1, buyer_id: 2, status: 'accepted' } });
        await deleteMarketplaceMilestone(1, 1);
        expect(hasCall(fake.find('marketplace_contract_milestones', 'delete')[0], 'eq', 'id', 1)).toBe(true);
        expect(mkt()).toEqual([{ contractId: 'C1' }]);
    });
});

// =============================================================================
describe('ratings, reputation, trader profile, party filter', () => {
    it('contract ratings are party-only', async () => {
        fake.queue('marketplace_contracts', { data: { seller_id: 1, buyer_id: 2, status: 'completed' } }, { data: { seller_id: 1, buyer_id: 2 } });
        fake.queue('marketplace_ratings', { data: [{ id: 1, contract_id: 'C1', rater_id: 1, ratee_id: 2, rater_role: 'seller', stars: 5, feedback: 'f', created_at: 'c', rater: null }] }, { data: null });
        expect((await getContractRatings('C1', 2))[0]).toMatchObject({ raterId: 1, rater: undefined, feedback: 'f' });
        expect(hasCall(fake.find('marketplace_ratings')[0], 'eq', 'contract_id', 'C1')).toBe(true);
        expect(await getContractRatings('C1', 1)).toEqual([]);
        fake.queue('marketplace_contracts', { data: { seller_id: 1, buyer_id: 2 } });
        await expect(getContractRatings('C1', 3)).rejects.toThrow(ERR_CONTRACT);
    });

    it('reputation is zeroed for deleted/unknown users and tiered by average + volume', async () => {
        fake.queue('users', { data: null });
        expect(await getMarketplaceReputation(5)).toEqual({ userId: 5, averageStars: 0, ratingCount: 0, tier: 'New' });
        expect(hasCall(fake.find('users')[0], 'is', 'deleted_at', null)).toBe(true);
        expect(fake.find('marketplace_ratings')).toHaveLength(0);
        const tier = async (stars: number[]) => {
            fake.queue('users', { data: { id: 5 } });
            fake.queue('marketplace_ratings', { data: stars.map((s) => ({ stars: s })) });
            return getMarketplaceReputation(5);
        };
        expect(await tier([])).toMatchObject({ tier: 'New', averageStars: 0 });
        expect(await tier(Array(10).fill(5))).toMatchObject({ tier: 'Elite', averageStars: 5, ratingCount: 10 });
        expect(await tier([4, 4, 5])).toMatchObject({ tier: 'Trusted', averageStars: 4.3 });
        expect(await tier([3, 2])).toMatchObject({ tier: 'Reputable', averageStars: 2.5 });
        fake.queue('users', { data: { id: 5 } });
        fake.queue('marketplace_ratings', { data: null });
        expect((await getMarketplaceReputation(5)).ratingCount).toBe(0);
    });

    it('trader profiles exist only for people IN the market (or the caller themselves) — no directory side door', async () => {
        fake.queue('users', { data: null });
        expect(await getMarketplaceTraderProfile(5, 1)).toBeNull();
        // Live user, no listings, no ratings, not self → not found.
        fake.queue('users', { data: { id: 5, name: 'N', rsi_handle: 'h', avatar_url: null } }, { data: { id: 5 } });
        fake.queue('marketplace_ratings', { data: [] });
        fake.queue('marketplace_listings', { data: [] });
        expect(await getMarketplaceTraderProfile(5, 1)).toBeNull();
        // Self → found even with nothing.
        fake.queue('users', { data: { id: 5, name: 'N', rsi_handle: 'h', avatar_url: null } }, { data: { id: 5 } });
        fake.queue('marketplace_ratings', { data: [] });
        fake.queue('marketplace_listings', { data: null });
        expect(await getMarketplaceTraderProfile(5, '5' as unknown as number)).toMatchObject({ trader: { id: 5 }, activeListings: [] });
        // Has an active listing → found; never carries recent ratings.
        fake.queue('users', { data: { id: 5, name: 'N', rsi_handle: 'h', avatar_url: null } }, { data: { id: 5 } });
        fake.queue('marketplace_ratings', { data: [] });
        fake.queue('marketplace_listings', { data: [listingRow({ seller_id: 5 })] });
        const prof = (await getMarketplaceTraderProfile(5))!;
        expect(prof.activeListings).toHaveLength(1);
        expect('recentRatings' in prof).toBe(false);
        const lq = fake.find('marketplace_listings').at(-1)!;
        expect(hasCall(lq, 'eq', 'status', 'active')).toBe(true);
        expect(hasCall(lq, 'limit', 50)).toBe(true);
        expect(fake.find('users')[0].columns).toBe('id, name, rsi_handle, avatar_url');
        // Has ratings only → found.
        fake.queue('users', { data: { id: 5, name: 'N', rsi_handle: 'h', avatar_url: null } }, { data: { id: 5 } });
        fake.queue('marketplace_ratings', { data: [{ stars: 4 }] });
        fake.queue('marketplace_listings', { data: [] });
        expect(await getMarketplaceTraderProfile(5, 1)).not.toBeNull();
    });

    it('party filter: no ids / non-integer user → no query; fails CLOSED on error; dedups + caps ids', async () => {
        expect(await filterContractIdsForParty([], 1)).toEqual(new Set());
        expect(await filterContractIdsForParty(['a'], 'x' as unknown as number)).toEqual(new Set());
        expect(fake.queries).toHaveLength(0);
        fake.queue('marketplace_contracts', { data: null, error: { message: 'x' } });
        expect(await filterContractIdsForParty(['a'], 1)).toEqual(new Set());
        fake.queue('marketplace_contracts', { data: [{ id: 'a' }] });
        const ids = [...Array.from({ length: 600 }, (_, i) => `c${i}`), 'c1'];
        expect(await filterContractIdsForParty(ids, 2)).toEqual(new Set(['a']));
        const q = fake.find('marketplace_contracts')[1];
        expect((filters(q, 'in')[0][1] as string[]).length).toBe(500);
        expect(hasCall(q, 'or', 'seller_id.eq.2,buyer_id.eq.2')).toBe(true);
        expect(q.columns).toBe('id, seller_id, buyer_id');
        fake.queue('marketplace_contracts', { data: null });
        expect(await filterContractIdsForParty(['a'], 2)).toEqual(new Set());
    });
});

// =============================================================================
describe('reports + moderation', () => {
    it('a report needs a visible target and is deduped while one is open', async () => {
        await expect(reportMarketplace({ reasonCategory: 'scam' }, 2)).rejects.toThrow('A listing or contract is required.');
        fake.queue('marketplace_listings', { data: null });
        await expect(reportMarketplace({ listingId: 'L1', reasonCategory: 'scam' }, 2)).rejects.toThrow(ERR_LISTING);
        fake.queue('marketplace_listings', { data: { id: 'L1', status: 'closed', seller_id: 1 } });
        await expect(reportMarketplace({ listingId: 'L1', reasonCategory: 'scam' }, 2)).rejects.toThrow(ERR_LISTING);
        fake.queue('marketplace_contracts', { data: { seller_id: 1, buyer_id: 3 } });
        await expect(reportMarketplace({ contractId: 'C1', reasonCategory: 'scam' }, 2)).rejects.toThrow(ERR_CONTRACT);
        fake.queue('marketplace_listings', { data: { id: 'L1', status: 'active', seller_id: 1 } });
        fake.queue('marketplace_reports', { data: { id: 9 } });
        await expect(reportMarketplace({ listingId: 'L1', reasonCategory: 'scam' }, 2)).rejects.toThrow('You already have an open report on this item.');
        const dup = fake.find('marketplace_reports')[0];
        expect(hasCall(dup, 'eq', 'reporter_id', 2)).toBe(true);
        expect(hasCall(dup, 'eq', 'status', 'open')).toBe(true);
        expect(hasCall(dup, 'eq', 'listing_id', 'L1')).toBe(true);
        expect(fake.find('marketplace_reports', 'insert')).toHaveLength(0);
    });

    it('files a sanitised open report on a listing (own withdrawn listing allowed) or a party contract', async () => {
        fake.queue('marketplace_listings', { data: { id: 'L1', status: 'paused', seller_id: 2 } });
        fake.queue('marketplace_reports', { data: null }, { error: null });
        await reportMarketplace({ listingId: 'L1', reasonCategory: '<b></b>', details: '<script>x</script>bad' }, 2);
        const ins = fake.find('marketplace_reports', 'insert')[0];
        expect(ins.payload).toMatchObject({ listing_id: 'L1', contract_id: null, reporter_id: 2, status: 'open', reason_category: 'other' });
        expect((ins.payload as { details: string }).details).not.toContain('<script>');
        fake.queue('marketplace_contracts', { data: { seller_id: 1, buyer_id: 2 } });
        fake.queue('marketplace_reports', { data: null }, { error: null });
        await reportMarketplace({ contractId: 'C1', reasonCategory: 'fraud' }, 2);
        const dup = fake.find('marketplace_reports', 'select').at(-1)!;
        expect(hasCall(dup, 'eq', 'contract_id', 'C1')).toBe(true);
        expect(fake.find('marketplace_reports', 'insert')[1].payload).toMatchObject({ listing_id: null, contract_id: 'C1', reason_category: 'fraud', details: null });
        fake.queue('marketplace_contracts', { data: { seller_id: 1, buyer_id: 2 } });
        fake.queue('marketplace_reports', { data: null }, { error: { message: 'x' } });
        await expect(reportMarketplace({ contractId: 'C1', reasonCategory: 'x' }, 2)).rejects.toThrow('Failed to submit report');
    });

    it('the moderation queue defaults to open work, supports all/specific buckets, and maps targets', async () => {
        fake.queue('marketplace_reports', { data: [
            { id: 1, listing_id: 'L1', contract_id: null, reporter_id: 2, reason_category: 'scam', details: null, status: 'open', reviewed_at: null, reviewed_by_id: null, created_at: 'c', reporter: [{ id: 2, name: 'R', avatar_url: 'a' }], reviewer: null, listing: [{ id: 'L1', title: 'T', status: 'active', seller_id: 1 }], contract: null },
            { id: 2, listing_id: null, contract_id: 'C1', reporter_id: 2, reason_category: 'x', details: 'd', status: 'open', reviewed_at: null, reviewed_by_id: 9, created_at: 'c', reporter: null, reviewer: [{ id: 9, name: 'Mod' }], listing: null, contract: { id: 'C1', title: 'K', status: 'accepted', seller_id: 1, buyer_id: 2 } },
            { id: 3, listing_id: null, contract_id: null, reporter_id: 2, reason_category: 'x', details: null, status: 'open', reviewed_at: null, reviewed_by_id: null, created_at: 'c' },
        ] }, { data: null }, { data: [] }, { data: null, error: { message: 'x' } });
        const out = await listMarketplaceReports();
        expect(hasCall(fake.find('marketplace_reports')[0], 'in', 'status', ['open', 'reviewing'])).toBe(true);
        expect(out[0]).toMatchObject({ reporterName: 'R', reporterAvatarUrl: 'a', targetType: 'listing', targetId: 'L1', targetTitle: 'T', targetSellerId: 1, reviewerName: null });
        expect(out[1]).toMatchObject({ reporterName: null, reviewerName: 'Mod', targetType: 'contract', targetId: 'C1', targetStatus: 'accepted' });
        expect(out[2]).toMatchObject({ targetType: 'contract', targetId: null, targetTitle: null, targetStatus: null, targetSellerId: null });
        // REPORT_SELECT never projects contract terms / price to a non-party moderator.
        expect(fake.find('marketplace_reports')[0].columns).not.toMatch(/agreed_price_uec|terms_note|considerations/);
        expect(await listMarketplaceReports('all')).toEqual([]);
        expect(filters(fake.find('marketplace_reports')[1], 'in')).toHaveLength(0);
        expect(filters(fake.find('marketplace_reports')[1], 'eq')).toHaveLength(0);
        await listMarketplaceReports('actioned');
        expect(hasCall(fake.find('marketplace_reports')[2], 'eq', 'status', 'actioned')).toBe(true);
        await expect(listMarketplaceReports()).rejects.toThrow('Failed to load marketplace reports');
    });

    it('review validates the decision and refuses already-resolved / unknown reports', async () => {
        await expect(reviewMarketplaceReport(1, 'nuke' as never, 9)).rejects.toThrow('Invalid decision.');
        fake.queue('marketplace_reports', { data: null });
        await expect(reviewMarketplaceReport(1, 'actioned', 9)).rejects.toThrow('Report not found.');
        for (const status of ['actioned', 'dismissed']) {
            fake.queue('marketplace_reports', { data: { id: 1, status, listing_id: null } });
            await expect(reviewMarketplaceReport(1, 'dismissed', 9)).rejects.toThrow('This report is already resolved.');
        }
        fake.queue('marketplace_reports', { data: { id: 1, status: 'open', listing_id: 'L1' } }, { error: { message: 'x' } });
        await expect(reviewMarketplaceReport(1, 'actioned', 9)).rejects.toThrow('Failed to resolve report');
        expect(fake.find('marketplace_listings')).toHaveLength(0);
    });

    it('dismissal records the decision only; an actioned contract report never auto-cancels', async () => {
        fake.queue('marketplace_reports', { data: { id: 1, status: 'open', listing_id: 'L1' } }, { error: null });
        await reviewMarketplaceReport(1, 'dismissed', 9);
        expect(fake.find('marketplace_reports', 'update')[0].payload).toMatchObject({ status: 'dismissed', reviewed_by_id: 9 });
        fake.queue('marketplace_reports', { data: { id: 2, status: 'reviewing', listing_id: null } }, { error: null });
        await reviewMarketplaceReport(2, 'actioned', 9);
        expect(fake.find('marketplace_listings')).toHaveLength(0);
        expect(fake.find('marketplace_contracts')).toHaveLength(0);
    });

    it('an actioned listing report takes it down with a moderation stamp, emits the id and notifies the seller', async () => {
        fake.queue('marketplace_reports', { data: { id: 1, status: 'open', listing_id: 'L1' } }, { error: null });
        fake.queue('marketplace_listings', { data: { id: 'L1', seller_id: 4, status: 'active', title: 'Ore' } }, { error: null });
        await reviewMarketplaceReport(1, 'actioned', 9);
        const close = fake.find('marketplace_listings', 'update')[0];
        expect(close.payload).toMatchObject({ status: 'closed' });
        expect(typeof (close.payload as Record<string, unknown>).moderation_closed_at).toBe('string');
        expect(mkt()).toEqual([{ listingId: 'L1' }]);
        expect(m.sendPushToUsers).toHaveBeenCalledWith([4], { title: 'Listing Removed', body: 'Your marketplace listing "Ore" was removed by a moderator.', tag: 'marketplace-moderation', data: { url: '/marketplace' } });
    });

    it('takedown: retries without the stamp on schema drift; a real close failure logs and stops; closed/missing listings are left alone', async () => {
        fake.queue('marketplace_reports', { data: { id: 1, status: 'open', listing_id: 'L1' } }, { error: null });
        fake.queue('marketplace_listings', { data: { id: 'L1', seller_id: 4, status: 'paused', title: 'Ore' } }, { error: { code: 'PGRST204' } }, { error: null });
        await reviewMarketplaceReport(1, 'actioned', 9);
        const [first, retry] = fake.find('marketplace_listings', 'update');
        expect('moderation_closed_at' in (first.payload as object)).toBe(true);
        expect('moderation_closed_at' in (retry.payload as object)).toBe(false);
        expect(m.sendPushToUsers).toHaveBeenCalledTimes(1);

        m.sendPushToUsers.mockClear(); broadcastSpy.mockClear();
        fake.queue('marketplace_reports', { data: { id: 1, status: 'open', listing_id: 'L1' } }, { error: null });
        fake.queue('marketplace_listings', { data: { id: 'L1', seller_id: 4, status: 'active', title: 'Ore' } }, { error: { code: '08006' } });
        await reviewMarketplaceReport(1, 'actioned', 9);
        expect(m.sendPushToUsers).not.toHaveBeenCalled();
        expect(broadcastSpy).not.toHaveBeenCalled();

        fake.queue('marketplace_reports', { data: { id: 1, status: 'open', listing_id: 'L1' } }, { error: null });
        fake.queue('marketplace_listings', { data: { id: 'L1', seller_id: 4, status: 'active', title: 'Ore' } }, { error: { code: '42703' } }, { error: { code: 'XX' } });
        await reviewMarketplaceReport(1, 'actioned', 9);
        expect(m.sendPushToUsers).not.toHaveBeenCalled();

        const before = fake.find('marketplace_listings', 'update').length;
        fake.queue('marketplace_reports', { data: { id: 1, status: 'open', listing_id: 'L1' } }, { error: null }, { data: { id: 1, status: 'open', listing_id: 'L1' } }, { error: null });
        fake.queue('marketplace_listings', { data: { id: 'L1', seller_id: 4, status: 'closed', title: 'Ore' } }, { data: null });
        await reviewMarketplaceReport(1, 'actioned', 9);
        await reviewMarketplaceReport(1, 'actioned', 9);
        expect(fake.find('marketplace_listings', 'update')).toHaveLength(before);
    });
});

describe('getMarketplaceState', () => {
    it('folds the four party/board reads into one subset', async () => {
        fake.on('marketplace_categories', { data: [] });
        fake.on('marketplace_listings', (q: FakeQuery) => ({ data: hasCall(q, 'eq', 'seller_id', 3) ? [listingRow({ seller_id: 3, status: 'paused' })] : [listingRow()] }));
        fake.on('marketplace_contracts', { data: [] });
        const s = await getMarketplaceState(3);
        expect(Object.keys(s).sort()).toEqual(['marketplaceCategories', 'marketplaceContracts', 'marketplaceListings', 'marketplaceMyListings']);
        expect(s.marketplaceMyListings[0].status).toBe('paused');
        expect(s.marketplaceListings[0].status).toBe('active');
        expect(hasCall(fake.find('marketplace_contracts')[0], 'or', 'seller_id.eq.3,buyer_id.eq.3')).toBe(true);
    });
});
