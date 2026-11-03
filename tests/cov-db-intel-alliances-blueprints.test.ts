import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fake, broadcastSpy, filters, hasCall, assertNoWildcardSelects, type FakeQuery } from './cov-db-intel-alliances-fake';

// =============================================================================
// lib/db/blueprints.ts — registry + two-sided crafting-request lifecycle.
// Covers: owner-free craftable picker (name-keyed dedupe so owner counts never
// leak), departed-member name withholding, catalog-pin validation (42P01 is a
// MISS, never a pass) and server-derived category, consent-does-not-transfer,
// the crafting gate against OTHER members' offers with canonical names, the
// open + rolling-window caps (fail CLOSED), ownership-before-status oracles,
// CAS transitions with actor predicates, provenance lookup, the departure
// stand-down, the visibility ladder and notify fan-out. No broadcasts, ever.
// =============================================================================

vi.mock('../lib/db/common.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/db/common.js')>();
    const h = await import('./cov-db-intel-alliances-fake');
    return { ...actual, supabase: h.fake.client, broadcastToOrg: h.broadcastSpy };
});

import {
    listBlueprints, listCraftableItems, registerBlueprint, updateBlueprint, deleteBlueprint, withdrawCraftingOffers,
    listBlueprintRequests, createBlueprintRequest, claimBlueprintRequest, releaseBlueprintRequest,
    markBlueprintRequestReady, markBlueprintRequestDelivered, confirmBlueprintRequestReceived, cancelBlueprintRequest,
    getCraftNotifyIds,
} from '../lib/db/blueprints';
import { SecurityDenial } from '../lib/errors';

const ERR_BP = 'Blueprint not found or access denied.';
const ERR_REQ = 'Crafting request not found or access denied.';
const MOVED = 'That crafting request has already moved on — refresh and try again.';
const party = (id: number, deleted = false) => ({ id, name: `U${id}`, avatar_url: null, rsi_handle: `h${id}`, deleted_at: deleted ? 'gone' : null });
const bpRow = (over: Record<string, unknown> = {}) => ({ id: 1, owner_id: 5, qm_catalog_id: null, item_name: 'Ballista', category: null, notes: null, offers_crafting: true, created_at: 'c', updated_at: 'u', owner: party(5), ...over });
const reqRow = (over: Record<string, unknown> = {}) => ({ id: 9, requester_id: 2, crafter_id: null, blueprint_id: null, qm_catalog_id: null, item_name: 'Ballista', quantity: 1, materials_note: null, offer_price_uec: null, status: 'open', created_at: 'c', updated_at: 'u', requester: party(2), crafter: null, ...over });
const isCount = (q: FakeQuery) => (q.selectOptions as { head?: boolean } | undefined)?.head === true;

beforeEach(() => {
    fake.reset();
    broadcastSpy.mockClear();
});
afterEach(() => {
    assertNoWildcardSelects(fake);
    // Rule 4: this module has no consumer for a broadcast, so it must never emit one.
    expect(broadcastSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
});

// =============================================================================
describe('registry reads', () => {
    it('lists with optional filters, escaped search, clamped limit; withholds a departed owner', async () => {
        fake.queue('blueprints', { data: [bpRow(), bpRow({ id: 2, owner: party(6, true) })] });
        const out = await listBlueprints({ craftableOnly: true, ownerId: 5, search: '50%_x', limit: 9999 });
        const q = fake.find('blueprints')[0];
        expect(hasCall(q, 'eq', 'offers_crafting', true)).toBe(true);
        expect(hasCall(q, 'eq', 'owner_id', '5')).toBe(true);
        expect(hasCall(q, 'ilike', 'item_name', '%50\\%\\_x%')).toBe(true);
        expect(hasCall(q, 'limit', 500)).toBe(true);
        expect(out[0].owner).toEqual({ id: 5, name: 'U5', avatarUrl: null, rsiHandle: 'h5' });
        expect(out[1].owner).toBeUndefined();
        fake.queue('blueprints', { data: null, error: { message: 'x' } });
        expect(await listBlueprints({ limit: -4 })).toEqual([]);
        expect(hasCall(fake.find('blueprints')[1], 'limit', 200)).toBe(true);
        expect(filters(fake.find('blueprints')[1], 'eq')).toHaveLength(0);
        await expect(listBlueprints({ ownerId: -1 })).rejects.toThrow('Invalid ownerId');
    });

    it('limit clamps: fractions floor but never below 1, non-numeric defaults', async () => {
        fake.queue('blueprints', { data: [] }, { data: [] }, { data: [] });
        await listBlueprints({ limit: 3.9 });
        await listBlueprints({ limit: 'abc' as unknown as number });
        await listBlueprints({ limit: 0.4 });
        expect(hasCall(fake.find('blueprints')[0], 'limit', 3)).toBe(true);
        expect(hasCall(fake.find('blueprints')[1], 'limit', 200)).toBe(true);
        expect(hasCall(fake.find('blueprints')[2], 'limit', 1)).toBe(true);
    });

    it('the craftable picker is owner-free, dedupes by NAME (pinned + freehand collapse), hides the viewer\'s own offers', async () => {
        fake.queue('blueprints', { data: [
            { qm_catalog_id: 100, item_name: 'Ballista', category: 'weapon' },
            { qm_catalog_id: null, item_name: ' ballista ', category: null },
            { qm_catalog_id: null, item_name: 'Arrow', category: null },
        ] });
        const out = await listCraftableItems({ viewerId: 7, category: 'weapon', search: 'b_' });
        const q = fake.find('blueprints')[0];
        expect(q.columns).toBe('qm_catalog_id, item_name, category');
        expect(hasCall(q, 'eq', 'offers_crafting', true)).toBe(true);
        expect(hasCall(q, 'neq', 'owner_id', '7')).toBe(true);
        expect(hasCall(q, 'eq', 'category', 'weapon')).toBe(true);
        expect(hasCall(q, 'ilike', 'item_name', '%b\\_%')).toBe(true);
        expect(out).toEqual({ items: [{ qmCatalogId: 100, itemName: 'Ballista', category: 'weapon' }, { qmCatalogId: null, itemName: 'Arrow', category: null }], truncated: false });
        expect(JSON.stringify(out)).not.toMatch(/owner/);
    });

    it('the picker reports truncation when the page fills or the DB read hit its cap', async () => {
        fake.queue('blueprints', { data: [{ qm_catalog_id: null, item_name: 'A', category: null }, { qm_catalog_id: null, item_name: 'B', category: null }] });
        expect(await listCraftableItems({ limit: 1 })).toEqual({ items: [{ qmCatalogId: null, itemName: 'A', category: null }], truncated: true });
        fake.queue('blueprints', { data: Array.from({ length: 500 }, () => ({ qm_catalog_id: null, item_name: 'Same', category: null })) });
        expect((await listCraftableItems()).truncated).toBe(true);
        fake.queue('blueprints', { data: null, error: { message: 'x' } });
        expect(await listCraftableItems()).toEqual({ items: [], truncated: false });
        expect(filters(fake.find('blueprints')[2], 'neq')).toHaveLength(0);
    });
});

// =============================================================================
describe('registry writes', () => {
    it('register: validates text, derives category from the catalog pin, maps 23505', async () => {
        await expect(registerBlueprint({ itemName: '   ' }, 5)).rejects.toThrow('Item name is required.');
        await expect(registerBlueprint({ itemName: 'x'.repeat(161) }, 5)).rejects.toThrow('Item name must be 160 characters or fewer.');
        await expect(registerBlueprint({ itemName: 'ok', notes: 'n'.repeat(2001) }, 5)).rejects.toThrow('Notes must be 2000 characters or fewer.');
        expect(fake.find('blueprints').filter((q) => q.executed)).toHaveLength(0);

        fake.queue('quartermaster_catalog', { data: { id: 100, category: 'weapon' } });
        fake.queue('blueprints', { data: bpRow({ category: 'weapon', qm_catalog_id: 100 }) });
        const out = await registerBlueprint({ itemName: ' Ballista ', qmCatalogId: '100', category: 'IGNORED', notes: '  ', offersCrafting: 'yes' }, 5);
        const qm = fake.find('quartermaster_catalog')[0];
        expect(qm.columns).toBe('id, category');
        expect(hasCall(qm, 'eq', 'id', 100)).toBe(true);
        expect(fake.find('blueprints', 'insert').at(-1)!.payload).toEqual({ owner_id: 5, qm_catalog_id: 100, item_name: 'Ballista', category: 'weapon', notes: null, offers_crafting: false });
        expect(out.category).toBe('weapon');
        fake.queue('blueprints', { data: null, error: { code: '23505' } });
        await expect(registerBlueprint({ itemName: 'x', offersCrafting: true }, 5)).rejects.toThrow('You have already registered that blueprint.');
        fake.queue('blueprints', { data: null, error: { code: 'XX' } });
        await expect(registerBlueprint({ itemName: 'x' }, 5)).rejects.toThrow('Failed to register blueprint');
    });

    it('a catalog pin must exist; a missing QM table (42P01) is a MISS, other errors surface', async () => {
        fake.queue('quartermaster_catalog', { data: null });
        await expect(registerBlueprint({ itemName: 'x', qmCatalogId: 7 }, 5)).rejects.toThrow('Referenced catalog item was not found.');
        fake.queue('quartermaster_catalog', { data: null, error: { code: '42P01' } });
        await expect(registerBlueprint({ itemName: 'x', qmCatalogId: 7 }, 5)).rejects.toThrow('Referenced catalog item was not found.');
        fake.queue('quartermaster_catalog', { data: null, error: { code: '08006' } });
        await expect(registerBlueprint({ itemName: 'x', qmCatalogId: 7 }, 5)).rejects.toThrow('Failed to validate catalog item');
        fake.queue('quartermaster_catalog', { data: { id: 7 } });
        fake.queue('blueprints', { data: bpRow() });
        await registerBlueprint({ itemName: 'x', qmCatalogId: 7 }, 5);
        expect(fake.find('blueprints', 'insert')[0].payload).toMatchObject({ category: null });
        // Non-positive / boolean / blank pins are simply "no pin" (no catalog read).
        for (const pin of [0, -3, 1.5, false, '', 'abc']) {
            fake.queue('blueprints', { data: bpRow() });
            await registerBlueprint({ itemName: 'x', qmCatalogId: pin }, 5);
        }
        expect(fake.find('quartermaster_catalog')).toHaveLength(4);
        expect(fake.find('blueprints', 'insert').at(-1)!.payload).toMatchObject({ qm_catalog_id: null });
    });

    it('update: owner or manager only; consent (offersCrafting) never transfers; only allow-listed keys are written', async () => {
        await expect(updateBlueprint(0, {}, 5, true)).rejects.toThrow(ERR_BP);
        fake.queue('blueprints', { data: null, error: { message: 'x' } });
        await expect(updateBlueprint(1, {}, 5, true)).rejects.toThrow('Failed to load blueprint');
        fake.queue('blueprints', { data: null });
        await expect(updateBlueprint(1, {}, 5, true)).rejects.toThrow(ERR_BP);
        fake.queue('blueprints', { data: { id: 1, owner_id: 5 } });
        const denied = await updateBlueprint(1, { itemName: 'x' }, 6, false).catch((e) => e);
        expect(denied).toBeInstanceOf(SecurityDenial);
        expect(denied.message).toBe('You can only edit blueprints you registered.');
        fake.queue('blueprints', { data: { id: 1, owner_id: 5 } });
        await expect(updateBlueprint(1, { offersCrafting: true }, 6, true)).rejects.toThrow('Only the member who registered a blueprint can offer it for crafting.');
        expect(fake.find('blueprints', 'update')).toHaveLength(0);

        fake.queue('blueprints', { data: { id: 1, owner_id: 5 } }, { data: bpRow({ item_name: 'New' }) });
        fake.queue('quartermaster_catalog', { data: { id: 3, category: 'armor' } });
        const out = await updateBlueprint(1, { itemName: ' New ', notes: '', offersCrafting: true, qmCatalogId: 3, category: 'hack', owner_id: 99, userId: 6 }, 5, false);
        const u = fake.find('blueprints', 'update')[0];
        const p = u.payload as Record<string, unknown>;
        expect(Object.keys(p).sort()).toEqual(['category', 'item_name', 'notes', 'offers_crafting', 'qm_catalog_id', 'updated_at']);
        expect(p).toMatchObject({ item_name: 'New', notes: null, offers_crafting: true, qm_catalog_id: 3, category: 'armor' });
        expect(hasCall(u, 'eq', 'id', 1)).toBe(true);
        expect(out.itemName).toBe('New');
    });

    it('update: a manager may moderate; clearing the pin clears the category; 23505 copy depends on who edits', async () => {
        fake.queue('blueprints', { data: { id: 1, owner_id: 5 } }, { data: bpRow() });
        await updateBlueprint(1, { qmCatalogId: null, notes: 'n' }, 6, true);
        expect(fake.find('blueprints', 'update')[0].payload).toMatchObject({ qm_catalog_id: null, category: null, notes: 'n' });
        expect(fake.find('quartermaster_catalog')).toHaveLength(0);
        fake.queue('blueprints', { data: { id: 1, owner_id: 5 } }, { data: null, error: { code: '23505' } });
        await expect(updateBlueprint(1, { itemName: 'Dup' }, 5, false)).rejects.toThrow('You have already registered that blueprint.');
        fake.queue('blueprints', { data: { id: 1, owner_id: 5 } }, { data: null, error: { code: '23505' } });
        await expect(updateBlueprint(1, { itemName: 'Dup' }, 6, true)).rejects.toThrow('That member has already registered a blueprint with that name.');
        fake.queue('blueprints', { data: { id: 1, owner_id: 5 } }, { data: null, error: { code: 'XX' } });
        await expect(updateBlueprint(1, {}, 5, false)).rejects.toThrow('Failed to update blueprint');
    });

    it('delete: owner or manager only; returns the id; errors surface', async () => {
        fake.queue('blueprints', { data: { id: 1, owner_id: 5 } });
        await expect(deleteBlueprint(1, 6, false)).rejects.toBeInstanceOf(SecurityDenial);
        fake.queue('blueprints', { data: { id: 1, owner_id: 5 } }, { error: null });
        expect(await deleteBlueprint(1, 6, true)).toEqual({ id: 1 });
        expect(hasCall(fake.find('blueprints', 'delete')[0], 'eq', 'id', 1)).toBe(true);
        fake.queue('blueprints', { data: { id: 1, owner_id: 5 } }, { error: { message: 'x' } });
        await expect(deleteBlueprint(1, 5, false)).rejects.toThrow('Failed to remove blueprint');
    });

    it('withdrawCraftingOffers stands a departed member down (offers off, CLAIMED jobs released only)', async () => {
        await expect(withdrawCraftingOffers(-1)).rejects.toThrow('Invalid userId');
        fake.queue('blueprints', { data: [{ id: 1 }, { id: 2 }] });
        fake.queue('blueprint_requests', { data: [{ id: 9 }] });
        expect(await withdrawCraftingOffers(5)).toEqual({ offersWithdrawn: 2, claimsReleased: 1 });
        const off = fake.find('blueprints', 'update')[0];
        expect(off.payload).toMatchObject({ offers_crafting: false });
        expect(hasCall(off, 'eq', 'owner_id', '5')).toBe(true);
        expect(hasCall(off, 'eq', 'offers_crafting', true)).toBe(true);
        const rel = fake.find('blueprint_requests', 'update')[0];
        expect(rel.payload).toMatchObject({ status: 'open', crafter_id: null, claimed_at: null, blueprint_id: null });
        expect(hasCall(rel, 'eq', 'crafter_id', '5')).toBe(true);
        expect(hasCall(rel, 'eq', 'status', 'claimed')).toBe(true);
        // Missing tables are tolerated; other errors surface.
        fake.queue('blueprints', { data: null, error: { code: '42P01' } });
        fake.queue('blueprint_requests', { data: null, error: { code: '42P01' } });
        expect(await withdrawCraftingOffers(5)).toEqual({ offersWithdrawn: 0, claimsReleased: 0 });
        fake.queue('blueprints', { data: null, error: { code: 'XX' } });
        await expect(withdrawCraftingOffers(5)).rejects.toThrow('Failed to withdraw crafting offers');
        fake.queue('blueprints', { data: [] });
        fake.queue('blueprint_requests', { data: null, error: { code: 'XX' } });
        await expect(withdrawCraftingOffers(5)).rejects.toThrow('Failed to release crafting claims');
    });
});

// =============================================================================
describe('listBlueprintRequests (visibility ladder)', () => {
    it('plain members see only their own; crafters add the open board; managers see all', async () => {
        fake.on('blueprint_requests', { data: [reqRow({ crafter: party(8, true) })] });
        const [r] = await listBlueprintRequests(2);
        expect(hasCall(fake.find('blueprint_requests')[0], 'eq', 'requester_id', '2')).toBe(true);
        expect(r.crafter).toBeUndefined();
        await listBlueprintRequests(2, { canCraft: true, status: 'open' as never, limit: 10 });
        const q2 = fake.find('blueprint_requests')[1];
        expect(hasCall(q2, 'or', 'requester_id.eq.2,crafter_id.eq.2,status.eq.open')).toBe(true);
        expect(hasCall(q2, 'eq', 'status', 'open')).toBe(true);
        expect(hasCall(q2, 'limit', 10)).toBe(true);
        await listBlueprintRequests(2, { canManage: true, canCraft: true });
        const q3 = fake.find('blueprint_requests')[2];
        expect(filters(q3, 'or')).toHaveLength(0);
        expect(filters(q3, 'eq')).toHaveLength(0);
        await expect(listBlueprintRequests('2,status.eq.open' as unknown as number)).rejects.toThrow('Invalid viewerId');
        fake.reset();
        fake.on('blueprint_requests', { data: null, error: { message: 'x' } });
        expect(await listBlueprintRequests(2)).toEqual([]);
    });
});

// =============================================================================
describe('createBlueprintRequest', () => {
    function arm(o: { open?: unknown; recent?: unknown; offer?: unknown; offers?: unknown; insert?: unknown } = {}) {
        fake.on('blueprint_requests', (q) => {
            if (isCount(q) && filters(q, 'in').length > 0) return (o.open as never) ?? { count: 0 };
            if (isCount(q)) return (o.recent as never) ?? { count: 0 };
            if (q.op === 'insert') return (o.insert as never) ?? { data: reqRow() };
            return { data: null };
        });
        fake.on('blueprints', (q) => {
            if (filters(q, 'ilike').length > 0) return (o.offers as never) ?? { data: [{ item_name: 'BALLISTA' }] };
            return (o.offer as never) ?? { data: { item_name: 'Ballista Mk1' } };
        });
        fake.on('quartermaster_catalog', { data: { id: 100, category: 'weapon' } });
    }

    it('enforces the open cap and FAILS CLOSED when it cannot be read', async () => {
        arm({ open: { count: null, error: { message: 'timeout' } } });
        await expect(createBlueprintRequest({ itemName: 'x' }, 2)).rejects.toThrow('Failed to check your open crafting requests');
        arm({ open: { count: null } });
        await expect(createBlueprintRequest({ itemName: 'x' }, 2)).rejects.toThrow('Could not verify your open crafting requests');
        arm({ open: { count: 10 } });
        await expect(createBlueprintRequest({ itemName: 'x' }, 2)).rejects.toThrow('You already have 10 crafting requests in progress');
        const q = fake.find('blueprint_requests').at(-1)!;
        expect(hasCall(q, 'in', 'status', ['open', 'claimed', 'ready', 'delivered'])).toBe(true);
        expect(fake.find('blueprint_requests', 'insert')).toHaveLength(0);
    });

    it('enforces the rolling 24h creation cap independent of status (cancel cannot rewind it), failing closed', async () => {
        arm({ recent: { count: null, error: { message: 'x' } } });
        await expect(createBlueprintRequest({ itemName: 'x' }, 2)).rejects.toThrow('Failed to check your recent crafting requests');
        arm({ recent: { count: null } });
        await expect(createBlueprintRequest({ itemName: 'x' }, 2)).rejects.toThrow('Could not verify your recent crafting requests');
        arm({ recent: { count: 20 } });
        vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 2));
        await expect(createBlueprintRequest({ itemName: 'x' }, 2)).rejects.toThrow('You have raised too many crafting requests today.');
        const rate = fake.find('blueprint_requests').filter(isCount).at(-1)!;
        expect(filters(rate, 'in')).toHaveLength(0);
        expect(hasCall(rate, 'gte', 'created_at', new Date(Date.UTC(2026, 10, 2) - 86_400_000).toISOString())).toBe(true);
    });

    it('a pinned request matches ANOTHER member\'s offer and persists the canonical name', async () => {
        arm();
        await createBlueprintRequest({ itemName: 'anything at all', qmCatalogId: 100, quantity: 50000, materialsNote: ' bring ore ', offerPriceUec: '12.7' }, 2);
        const probe = fake.find('blueprints')[0];
        expect(hasCall(probe, 'eq', 'qm_catalog_id', 100)).toBe(true);
        expect(hasCall(probe, 'neq', 'owner_id', '2')).toBe(true);
        expect(hasCall(probe, 'order', 'id', { ascending: true })).toBe(true);
        expect(fake.find('blueprint_requests', 'insert')[0].payload).toEqual({
            requester_id: 2, blueprint_id: null, crafter_id: null, qm_catalog_id: 100, item_name: 'Ballista Mk1',
            quantity: 10000, materials_note: 'bring ore', offer_price_uec: 12, status: 'open',
        });
    });

    it('a freehand request matches exactly (case-insensitive) via an ESCAPED ilike, never a wildcard', async () => {
        arm({ offers: { data: [{ item_name: 'Ballista_5x' }, { item_name: ' ballista_5 ' }] } });
        await createBlueprintRequest({ itemName: 'Ballista_5', quantity: 'x' }, 2);
        const probe = fake.find('blueprints')[0];
        expect(hasCall(probe, 'ilike', 'item_name', 'Ballista\\_5')).toBe(true);
        expect(hasCall(probe, 'limit', 500)).toBe(true);
        expect(fake.find('blueprint_requests', 'insert')[0].payload).toMatchObject({ item_name: ' ballista_5 ', quantity: 1, offer_price_uec: null, materials_note: null });
        arm({ offers: { data: [{ item_name: 'Ballista_5x' }] } });
        await expect(createBlueprintRequest({ itemName: '%' }, 2)).rejects.toThrow('Nobody else in this organisation is currently offering to craft that item.');
    });

    it('refuses when nobody else offers it, and fails on real (non-42P01) probe errors', async () => {
        arm({ offer: { data: null } });
        await expect(createBlueprintRequest({ itemName: 'x', qmCatalogId: 100 }, 2)).rejects.toThrow('Nobody else');
        arm({ offer: { data: null, error: { code: '42P01' } } });
        await expect(createBlueprintRequest({ itemName: 'x', qmCatalogId: 100 }, 2)).rejects.toThrow('Nobody else');
        arm({ offer: { data: null, error: { code: 'XX' } } });
        await expect(createBlueprintRequest({ itemName: 'x', qmCatalogId: 100 }, 2)).rejects.toThrow('Failed to validate craftable item');
        arm({ offers: { data: null, error: { code: 'XX' } } });
        await expect(createBlueprintRequest({ itemName: 'x' }, 2)).rejects.toThrow('Failed to validate craftable item');
        arm({ offers: { data: null, error: { code: '42P01' } } });
        await expect(createBlueprintRequest({ itemName: 'x' }, 2)).rejects.toThrow('Nobody else');
        expect(fake.find('blueprint_requests', 'insert')).toHaveLength(0);
    });

    it('validates price and surfaces an insert failure', async () => {
        arm();
        await expect(createBlueprintRequest({ itemName: 'Ballista', offerPriceUec: 'lots' }, 2)).rejects.toThrow('Offered price must be a number.');
        await expect(createBlueprintRequest({ itemName: 'Ballista', offerPriceUec: -1 }, 2)).rejects.toThrow('Offered price must be between 0 and');
        await expect(createBlueprintRequest({ itemName: 'Ballista', offerPriceUec: 2e12 }, 2)).rejects.toThrow('Offered price must be between 0 and');
        arm({ insert: { data: null, error: { message: 'x' } } });
        await expect(createBlueprintRequest({ itemName: 'Ballista', offerPriceUec: '' }, 2)).rejects.toThrow('Failed to raise crafting request');
    });
});

// =============================================================================
describe('request lifecycle', () => {
    /** loadRequest row, then a CAS result for the transition UPDATE. */
    function arm(load: unknown, cas: unknown = { data: reqRow({ status: 'x' }) }, extra: { target?: unknown; mine?: unknown } = {}) {
        fake.on('blueprint_requests', (q) => {
            if (q.op === 'update') return cas as never;
            if (q.columns === 'id, requester_id, crafter_id, status') return load as never;
            if (q.columns === 'item_name, qm_catalog_id') return (extra.target as never) ?? { data: { item_name: 'Ballista', qm_catalog_id: null } };
            return { data: null };
        });
        fake.on('blueprints', (extra.mine as never) ?? { data: [{ id: 41, item_name: 'Other' }, { id: 42, item_name: ' ballista ' }] });
    }
    const cas = () => fake.find('blueprint_requests', 'update')[0];

    it('loading: bad id / missing row → generic error; a DB fault is surfaced as a fault, not a denial', async () => {
        await expect(claimBlueprintRequest('x' as unknown as number, 8)).rejects.toThrow(ERR_REQ);
        arm({ data: null });
        await expect(claimBlueprintRequest(9, 8)).rejects.toThrow(ERR_REQ);
        arm({ data: null, error: { message: 'x' } });
        await expect(claimBlueprintRequest(9, 8)).rejects.toThrow('Failed to load crafting request');
    });

    it('claim: open only, never your own; CAS on status + unclaimed; records provenance by item name', async () => {
        arm({ data: { id: 9, requester_id: 2, crafter_id: null, status: 'claimed' } });
        await expect(claimBlueprintRequest(9, 8)).rejects.toThrow('Only an open request can be claimed.');
        arm({ data: { id: 9, requester_id: 8, crafter_id: null, status: 'open' } });
        await expect(claimBlueprintRequest(9, 8)).rejects.toThrow('You cannot claim your own crafting request.');
        arm({ data: { id: 9, requester_id: 2, crafter_id: null, status: 'open' } }, { data: reqRow({ status: 'claimed', crafter_id: 8, crafter: party(8) }) });
        const out = await claimBlueprintRequest(9, 8);
        expect(cas().payload).toMatchObject({ status: 'claimed', crafter_id: 8, blueprint_id: 42 });
        expect(hasCall(cas(), 'eq', 'status', 'open')).toBe(true);
        expect(hasCall(cas(), 'is', 'crafter_id', null)).toBe(true);
        const mine = fake.find('blueprints')[0];
        expect(hasCall(mine, 'eq', 'owner_id', 8)).toBe(true);
        expect(hasCall(mine, 'ilike', 'item_name', 'Ballista')).toBe(true);
        expect(out).toMatchObject({ status: 'claimed', crafterId: 8, crafter: { id: 8 } });
    });

    it('claim provenance: catalog-pinned → first own pinned row; no own match / vanished request → null', async () => {
        arm({ data: { id: 9, requester_id: 2, crafter_id: null, status: 'open' } }, { data: reqRow() }, { target: { data: { item_name: 'X', qm_catalog_id: 100 } }, mine: { data: [{ id: 77, item_name: 'X' }] } });
        await claimBlueprintRequest(9, 8);
        expect(cas().payload).toMatchObject({ blueprint_id: 77 });
        expect(hasCall(fake.find('blueprints')[0], 'eq', 'qm_catalog_id', 100)).toBe(true);
        fake.reset();
        arm({ data: { id: 9, requester_id: 2, crafter_id: null, status: 'open' } }, { data: reqRow() }, { target: { data: { item_name: 'X', qm_catalog_id: 100 } }, mine: { data: null } });
        await claimBlueprintRequest(9, 8);
        expect(cas().payload).toMatchObject({ blueprint_id: null });
        fake.reset();
        arm({ data: { id: 9, requester_id: 2, crafter_id: null, status: 'open' } }, { data: reqRow() }, { target: { data: { item_name: 'Nope', qm_catalog_id: null } } });
        await claimBlueprintRequest(9, 8);
        expect(cas().payload).toMatchObject({ blueprint_id: null });
        fake.reset();
        arm({ data: { id: 9, requester_id: 2, crafter_id: null, status: 'open' } }, { data: reqRow() }, { target: { data: null } });
        await claimBlueprintRequest(9, 8);
        expect(cas().payload).toMatchObject({ blueprint_id: null });
        expect(fake.find('blueprints')).toHaveLength(0);
    });

    it('a lost CAS race and a CAS error both refuse', async () => {
        arm({ data: { id: 9, requester_id: 2, crafter_id: null, status: 'open' } }, { data: null });
        await expect(claimBlueprintRequest(9, 8)).rejects.toThrow(MOVED);
        arm({ data: { id: 9, requester_id: 2, crafter_id: null, status: 'open' } }, { data: null, error: { message: 'x' } });
        await expect(claimBlueprintRequest(9, 8)).rejects.toThrow('Failed to update crafting request');
    });

    it('release: ownership BEFORE status (no oracle); pins the crafter READ; manager may release; reports the ex-crafter', async () => {
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'open' } });
        const err = await releaseBlueprintRequest(9, 7, false).catch((e) => e);
        expect(err).toBeInstanceOf(SecurityDenial);   // "not yours" wins over "wrong state"
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'ready' } });
        await expect(releaseBlueprintRequest(9, 8, false)).rejects.toThrow('Only a claimed request can be released.');
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'claimed' } }, { data: reqRow({ status: 'open' }) });
        const out = await releaseBlueprintRequest(9, 99, true);
        expect(cas().payload).toMatchObject({ status: 'open', crafter_id: null, claimed_at: null, blueprint_id: null });
        expect(hasCall(cas(), 'eq', 'crafter_id', 8)).toBe(true);
        expect(out.releasedCrafterId).toBe(8);
        fake.reset();
        arm({ data: { id: 9, requester_id: 2, crafter_id: null, status: 'claimed' } }, { data: reqRow({ status: 'open' }) });
        const malformed = await releaseBlueprintRequest(9, 99, true);
        expect(hasCall(cas(), 'is', 'crafter_id', null)).toBe(true);
        expect(malformed.releasedCrafterId).toBeNull();
    });

    it('ready / delivered: crafter only (no manager stand-in), ownership before status, CAS on the crafter', async () => {
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'open' } });
        await expect(markBlueprintRequestReady(9, 7)).rejects.toBeInstanceOf(SecurityDenial);
        await expect(markBlueprintRequestReady(9, 8)).rejects.toThrow('Only a claimed request can be marked ready.');
        await expect(markBlueprintRequestDelivered(9, 7)).rejects.toBeInstanceOf(SecurityDenial);
        await expect(markBlueprintRequestDelivered(9, 8)).rejects.toThrow('Only a request marked ready can be marked delivered.');
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'claimed' } }, { data: reqRow({ status: 'ready' }) });
        expect((await markBlueprintRequestReady(9, 8)).status).toBe('ready');
        expect(cas().payload).toMatchObject({ status: 'ready' });
        expect(hasCall(cas(), 'eq', 'status', 'claimed')).toBe(true);
        expect(hasCall(cas(), 'eq', 'crafter_id', 8)).toBe(true);
        fake.reset();
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'ready' } }, { data: reqRow({ status: 'delivered' }) });
        await markBlueprintRequestDelivered(9, 8);
        expect(cas().payload).toMatchObject({ status: 'delivered' });
        expect(hasCall(cas(), 'eq', 'status', 'ready')).toBe(true);
    });

    it('confirm: requester only (no manager forge), delivered only, CAS on the requester', async () => {
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'claimed' } });
        await expect(confirmBlueprintRequestReceived(9, 8)).rejects.toBeInstanceOf(SecurityDenial);
        await expect(confirmBlueprintRequestReceived(9, 2)).rejects.toThrow('Only a delivered request can be confirmed as received.');
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'delivered' } }, { data: reqRow({ status: 'completed' }) });
        await confirmBlueprintRequestReceived(9, 2);
        expect(cas().payload).toMatchObject({ status: 'completed' });
        expect(hasCall(cas(), 'eq', 'requester_id', 2)).toBe(true);
    });

    it('cancel: requester or manager, never from a closed state; manager CAS has no actor predicate', async () => {
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'claimed' } });
        await expect(cancelBlueprintRequest(9, 8, false)).rejects.toBeInstanceOf(SecurityDenial);
        for (const status of ['completed', 'cancelled']) {
            arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status } });
            await expect(cancelBlueprintRequest(9, 2, false)).rejects.toThrow('That crafting request is already closed.');
        }
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'claimed' } });
        await expect(cancelBlueprintRequest(9, 2, false, 'r'.repeat(2001))).rejects.toThrow('Cancellation reason must be 2000 characters or fewer.');
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'claimed' } }, { data: reqRow({ status: 'cancelled' }) });
        await cancelBlueprintRequest(9, 2, false, '  changed  ');
        expect(cas().payload).toMatchObject({ status: 'cancelled', cancel_reason: 'changed' });
        expect(hasCall(cas(), 'eq', 'status', 'claimed')).toBe(true);
        expect(hasCall(cas(), 'eq', 'requester_id', 2)).toBe(true);
        fake.reset();
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'ready' } }, { data: reqRow({ status: 'cancelled' }) });
        await cancelBlueprintRequest(9, 50, true, 42);
        expect(cas().payload).toMatchObject({ cancel_reason: '42' });
        expect(filters(cas(), 'is')).toHaveLength(0);
        expect(filters(cas(), 'eq').map((a) => a[0])).toEqual(['id', 'status']);
        fake.reset();
        arm({ data: { id: 9, requester_id: 2, crafter_id: 8, status: 'open' } }, { data: reqRow({ status: 'cancelled' }) });
        await cancelBlueprintRequest(9, 2, false, '   ');
        expect(cas().payload).toMatchObject({ cancel_reason: null });
    });
});

// =============================================================================
describe('getCraftNotifyIds', () => {
    it('resolves blueprint:craft holders (live users only), capped and PK-ordered, minus the requester', async () => {
        fake.queue('permissions', { data: [{ id: 3 }] });
        fake.queue('role_permissions', { data: [{ role_id: 1 }, { role_id: 1 }, { role_id: 2 }] });
        fake.queue('users', { data: [{ id: 2 }, { id: 5 }, { id: 8 }] });
        expect(await getCraftNotifyIds(2)).toEqual([5, 8]);
        expect(hasCall(fake.find('permissions')[0], 'eq', 'name', 'blueprint:craft')).toBe(true);
        expect(hasCall(fake.find('role_permissions')[0], 'in', 'permission_id', [3])).toBe(true);
        const u = fake.find('users')[0];
        expect(hasCall(u, 'in', 'role_id', [1, 2])).toBe(true);
        expect(hasCall(u, 'is', 'deleted_at', null)).toBe(true);
        expect(hasCall(u, 'order', 'id', { ascending: true })).toBe(true);
        expect(hasCall(u, 'limit', 50)).toBe(true);
    });

    it('short-circuits when the permission or any granting role is missing', async () => {
        fake.queue('permissions', { data: null });
        expect(await getCraftNotifyIds()).toEqual([]);
        expect(fake.find('role_permissions')).toHaveLength(0);
        fake.queue('permissions', { data: [{ id: 3 }] });
        fake.queue('role_permissions', { data: null });
        expect(await getCraftNotifyIds()).toEqual([]);
        expect(fake.find('users')).toHaveLength(0);
        fake.queue('permissions', { data: [{ id: 3 }] });
        fake.queue('role_permissions', { data: [{ role_id: 1 }] });
        fake.queue('users', { data: null });
        expect(await getCraftNotifyIds()).toEqual([]);
    });
});
