import { describe, it, expect, vi, beforeEach } from 'vitest';

// api/actions/marketplace.ts — the marketplace:* RPC handlers.
//
// Marketplace has no role gate on its member actions: its ONLY authorisation boundary
// is per-user ownership / contract-party membership, re-checked in lib/db/marketplace.ts
// on every id-addressed mutation (pinned there by tests/marketplaceSecurity.test.ts).
// That re-check is only as good as the actor id the handler hands it, so this file
// pins the handler half of the contract:
//   · every id-addressed handler passes the DISPATCHER-FORCED `userId` as the actor —
//     never a payload sellerId / buyerId / ownerId / raterId;
//   · the warehouse-touching paths (create, deliver, cancel) also forward the
//     dispatcher's `user`, so the db layer can re-check warehouse:manage;
//   · propose is field-by-field — anything the caller adds is dropped;
//   · reads about ANOTHER member take `targetUserId` (a target field) and still pass
//     the actor so the db layer can tell "my own profile" from someone else's.

const h = vi.hoisted(() => {
    const names = [
        'getMarketplaceCategories', 'browseMarketplaceListings', 'getMarketplaceListing', 'getMarketplaceTraderProfile',
        'getContractRatings', 'reportMarketplace', 'createMarketplaceListing', 'updateMarketplaceListing',
        'deleteMarketplaceListing', 'proposeMarketplaceContract', 'acceptMarketplaceContract', 'markMarketplaceDelivered',
        'confirmMarketplaceReceived', 'cancelMarketplaceContract', 'rateMarketplaceContract', 'getMyMarketplaceContracts',
        'getMarketplaceMilestones', 'toggleMarketplaceMilestone', 'deleteMarketplaceMilestone',
        'listAllMarketplaceCategories', 'createMarketplaceCategory', 'updateMarketplaceCategory',
        'deleteMarketplaceCategory', 'seedMarketplaceCategories', 'listMarketplaceReports', 'reviewMarketplaceReport',
    ];
    const db: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const n of names) db[n] = vi.fn();
    return { db, names };
});

vi.mock('../lib/db', () => h.db);

import { marketplaceActions } from '../api/actions/marketplace';

type Handler = (payload: unknown) => unknown;
const ACTIONS = marketplaceActions as unknown as Record<string, Handler>;
const run = async (action: string, payload?: unknown) => ACTIONS[action](payload);
const fn = (name: string) => h.db[name];
const dbCallCount = () => h.names.reduce((n, name) => n + fn(name).mock.calls.length, 0);

beforeEach(() => {
    vi.resetAllMocks();
});

const ACTOR = 7;
const USER = { id: ACTOR, role: 'Member', permissions: ['marketplace:view', 'marketplace:contract', 'warehouse:manage'] };
// Identity fields a hostile client might add hoping one is read as the actor.
const SPOOF = { sellerId: 99, buyerId: 99, ownerId: 99, raterId: 99, reporterId: 99, reviewerId: 99 };

// [action, payload, db fn, expected args]
const CASES: Array<[string, Record<string, unknown> | undefined, string, unknown[]]> = [
    ['marketplace:get_categories', {}, 'getMarketplaceCategories', []],
    ['marketplace:browse', { kind: 'item', listingType: 'sell', categoryId: 3, search: 'p4', sellerId: 99, includeHidden: true }, 'browseMarketplaceListings',
        [{ kind: 'item', listingType: 'sell', categoryId: 3, search: 'p4' }]],
    // The dispatcher always sends a body, but the handler tolerates none.
    ['marketplace:browse', undefined, 'browseMarketplaceListings',
        [{ kind: undefined, listingType: undefined, categoryId: undefined, search: undefined }]],
    ['marketplace:get_listing', { id: 'L1', userId: ACTOR, ...SPOOF }, 'getMarketplaceListing', ['L1', ACTOR]],
    ['marketplace:get_profile', { targetUserId: 3, userId: ACTOR }, 'getMarketplaceTraderProfile', [3, ACTOR]],
    ['marketplace:get_contract_ratings', { id: 'K1', userId: ACTOR, ...SPOOF }, 'getContractRatings', ['K1', ACTOR]],
    ['marketplace:report', { listingId: 'L1', contractId: 'K1', reasonCategory: 'scam', details: 'd', userId: ACTOR, ...SPOOF }, 'reportMarketplace',
        [{ listingId: 'L1', contractId: 'K1', reasonCategory: 'scam', details: 'd' }, ACTOR]],
    ['marketplace:update_listing', { id: 'L1', updates: { title: 'T' }, userId: ACTOR, ...SPOOF }, 'updateMarketplaceListing', ['L1', { title: 'T' }, ACTOR]],
    ['marketplace:delete_listing', { id: 'L1', userId: ACTOR, ...SPOOF }, 'deleteMarketplaceListing', ['L1', ACTOR]],
    ['marketplace:accept', { id: 'K1', userId: ACTOR, ...SPOOF }, 'acceptMarketplaceContract', ['K1', ACTOR]],
    ['marketplace:mark_delivered', { id: 'K1', userId: ACTOR, user: USER, ...SPOOF }, 'markMarketplaceDelivered', ['K1', ACTOR, USER]],
    ['marketplace:confirm_received', { id: 'K1', userId: ACTOR, ...SPOOF }, 'confirmMarketplaceReceived', ['K1', ACTOR]],
    ['marketplace:cancel', { id: 'K1', reason: 'changed mind', userId: ACTOR, user: USER, ...SPOOF }, 'cancelMarketplaceContract', ['K1', ACTOR, 'changed mind', USER]],
    ['marketplace:rate', { id: 'K1', stars: 5, feedback: 'great', userId: ACTOR, ratedUserId: 3, ...SPOOF }, 'rateMarketplaceContract',
        ['K1', { stars: 5, feedback: 'great' }, ACTOR]],
    ['marketplace:my_contracts', { userId: ACTOR, ...SPOOF }, 'getMyMarketplaceContracts', [ACTOR]],
    ['marketplace:get_milestones', { id: 'K1', userId: ACTOR, ...SPOOF }, 'getMarketplaceMilestones', ['K1', ACTOR]],
    ['marketplace:toggle_milestone', { milestoneId: 4, userId: ACTOR, contractId: 'other', ...SPOOF }, 'toggleMarketplaceMilestone', [4, ACTOR]],
    ['marketplace:delete_milestone', { milestoneId: 4, userId: ACTOR, ...SPOOF }, 'deleteMarketplaceMilestone', [4, ACTOR]],
    ['marketplace:admin:list_categories', {}, 'listAllMarketplaceCategories', []],
    ['marketplace:admin:update_category', { id: 3, updates: { name: 'Ships' }, slug: 'x' }, 'updateMarketplaceCategory', [3, { name: 'Ships' }]],
    ['marketplace:admin:delete_category', { id: 3 }, 'deleteMarketplaceCategory', [3]],
    ['marketplace:admin:list_reports', { status: 'open', userId: ACTOR }, 'listMarketplaceReports', ['open']],
    ['marketplace:admin:review_report', { id: 12, decision: 'actioned', userId: ACTOR, ...SPOOF }, 'reviewMarketplaceReport', [12, 'actioned', ACTOR]],
];

describe('marketplace handlers forward exactly their arguments', () => {
    it.each(CASES)('%s → %s', async (action, payload, dbFn, args) => {
        const result = { marker: action };
        fn(dbFn).mockResolvedValueOnce(result);
        await expect(run(action, payload)).resolves.toBe(result);
        expect(fn(dbFn).mock.calls).toStrictEqual([args]);
        expect(dbCallCount()).toBe(1);
    });
});

describe('ownership boundary: the actor handed to the db layer is always the dispatcher-forced userId', () => {
    // Every id-addressed member mutation/read whose db function re-checks ownership or
    // contract-party membership against the actor argument.
    const ID_ADDRESSED: Array<[string, Record<string, unknown>, string, number]> = [
        ['marketplace:update_listing', { id: 'L1', updates: {} }, 'updateMarketplaceListing', 2],
        ['marketplace:delete_listing', { id: 'L1' }, 'deleteMarketplaceListing', 1],
        ['marketplace:accept', { id: 'K1' }, 'acceptMarketplaceContract', 1],
        ['marketplace:mark_delivered', { id: 'K1' }, 'markMarketplaceDelivered', 1],
        ['marketplace:confirm_received', { id: 'K1' }, 'confirmMarketplaceReceived', 1],
        ['marketplace:cancel', { id: 'K1' }, 'cancelMarketplaceContract', 1],
        ['marketplace:rate', { id: 'K1', stars: 4 }, 'rateMarketplaceContract', 2],
        ['marketplace:get_listing', { id: 'L1' }, 'getMarketplaceListing', 1],
        ['marketplace:get_contract_ratings', { id: 'K1' }, 'getContractRatings', 1],
        ['marketplace:get_milestones', { id: 'K1' }, 'getMarketplaceMilestones', 1],
        ['marketplace:toggle_milestone', { milestoneId: 4 }, 'toggleMarketplaceMilestone', 1],
        ['marketplace:delete_milestone', { milestoneId: 4 }, 'deleteMarketplaceMilestone', 1],
        ['marketplace:propose', { listingId: 'L1' }, 'proposeMarketplaceContract', 1],
        ['marketplace:report', { listingId: 'L1', reasonCategory: 'scam' }, 'reportMarketplace', 1],
        ['marketplace:create_listing', { kind: 'item', listingType: 'sell', title: 'T' }, 'createMarketplaceListing', 1],
    ];

    it.each(ID_ADDRESSED)('%s passes userId in the actor slot and no spoofed identity anywhere', async (action, payload, dbFn, actorSlot) => {
        for (const actor of [7, 8]) {
            vi.resetAllMocks();
            fn(dbFn).mockResolvedValueOnce({});
            await run(action, { ...SPOOF, ...payload, userId: actor });
            const args = fn(dbFn).mock.calls[0];
            expect(args[actorSlot]).toBe(actor);
            // create_listing forwards the whole payload object (the db layer narrows it),
            // so the spoofed keys are inside arg 0 — but never in an actor slot.
            const actorArgs = action === 'marketplace:create_listing' ? args.slice(1) : args;
            expect(JSON.stringify(actorArgs)).not.toContain('99');
        }
    });
});

describe('payload shaping', () => {
    it('create_listing forwards the payload, its forced userId as owner, and the dispatcher user for the warehouse re-check', async () => {
        const p = { kind: 'item', listingType: 'sell', title: 'Arclight', quantity: 2, priceUec: 500, warehouseStockId: 4, userId: ACTOR, user: USER };
        fn('createMarketplaceListing').mockResolvedValueOnce({ id: 'L9' });
        await expect(run('marketplace:create_listing', p)).resolves.toStrictEqual({ id: 'L9' });
        expect(fn('createMarketplaceListing').mock.calls).toStrictEqual([[p, ACTOR, USER]]);
    });

    it('propose is field-by-field: listing, quantity, price, terms, milestones, considerations — nothing else', async () => {
        const considerations = [{ kind: 'item', name: 'Medpen', quantity: 4 }];
        const milestones = [{ title: 'Half', description: 'first half' }];
        fn('proposeMarketplaceContract').mockResolvedValueOnce({ id: 'K9' });
        await expect(run('marketplace:propose', {
            listingId: 'L1', quantity: 2, agreedPriceUec: 900, termsNote: 'net 7', milestones, considerations,
            userId: ACTOR, status: 'accepted', sellerId: 99, buyerId: 99, acceptedAt: 'now',
        })).resolves.toStrictEqual({ id: 'K9' });
        expect(fn('proposeMarketplaceContract').mock.calls).toStrictEqual([[
            { listingId: 'L1', quantity: 2, agreedPriceUec: 900, termsNote: 'net 7', milestones, considerations },
            ACTOR,
        ]]);
    });

    it('admin create_category forwards the category payload unchanged', async () => {
        const p = { name: 'Ships', parentId: null, listingKind: 'item', icon: 'rocket', sortOrder: 2, active: true };
        fn('createMarketplaceCategory').mockResolvedValueOnce({ id: 3 });
        await expect(run('marketplace:admin:create_category', p)).resolves.toStrictEqual({ id: 3 });
        expect(fn('createMarketplaceCategory').mock.calls).toStrictEqual([[p]]);
    });

    it('admin seed_categories seeds THEN returns the refreshed full list', async () => {
        const order: string[] = [];
        fn('seedMarketplaceCategories').mockImplementationOnce(async () => { order.push('seed'); });
        fn('listAllMarketplaceCategories').mockImplementationOnce(async () => { order.push('list'); return [{ id: 1 }]; });
        await expect(run('marketplace:admin:seed_categories', {})).resolves.toStrictEqual([{ id: 1 }]);
        expect(order).toStrictEqual(['seed', 'list']);
        expect(fn('seedMarketplaceCategories').mock.calls).toStrictEqual([[]]);
    });

    it('a failed seed does not report a list as if it had succeeded', async () => {
        fn('seedMarketplaceCategories').mockRejectedValueOnce(new Error('Failed to seed marketplace categories'));
        await expect(run('marketplace:admin:seed_categories', {})).rejects.toThrow('Failed to seed marketplace categories');
        expect(fn('listAllMarketplaceCategories')).not.toHaveBeenCalled();
    });

    it('an ownership refusal from the db layer propagates unchanged', async () => {
        fn('deleteMarketplaceListing').mockRejectedValueOnce(new Error('Listing not found.'));
        await expect(run('marketplace:delete_listing', { id: 'L1', userId: ACTOR })).rejects.toThrow('Listing not found.');
        fn('cancelMarketplaceContract').mockRejectedValueOnce(new Error('Only a party to this contract can cancel it.'));
        await expect(run('marketplace:cancel', { id: 'K1', userId: 8 })).rejects.toThrow('Only a party to this contract can cancel it.');
    });
});

describe('module surface', () => {
    it('every exported marketplace handler is exercised by this file', () => {
        const covered = new Set([
            ...CASES.map(([a]) => a),
            'marketplace:create_listing', 'marketplace:propose', 'marketplace:admin:create_category', 'marketplace:admin:seed_categories',
        ]);
        expect(Object.keys(ACTIONS).sort()).toStrictEqual([...covered].sort());
    });
});
