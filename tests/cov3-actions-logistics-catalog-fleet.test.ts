import { describe, it, expect, vi, beforeEach } from 'vitest';

// api/actions/catalog.ts + api/actions/fleet.ts — two thin forwarding modules.
//
// catalog:* is gated on admin:config:catalog in the dispatcher; the handlers only map
// the dashboard's payload keys onto the db functions, so a key mix-up (e.g. sending the
// keep id as the delete id of a merge) is exactly what can go wrong here.
//
// fleet:* carries one real authorisation decision: fleetOwnScope. A member holding
// only fleet:manage_own may mutate ONLY their own ships, so every user-ship mutation
// passes their id as an ownership scope; fleet:manage passes `undefined` (org-wide).
// It is a plain permission test — no role-name bypass — and it fails closed on any
// malformed permissions value.

const h = vi.hoisted(() => {
    const names = [
        // catalog
        'getShipCatalogWithUsage', 'syncShipCatalog', 'repairShipCatalogDuplicates', 'updatePlatformShip',
        'deletePlatformShip', 'mergePlatformShips', 'getPlatformItemCatalogWithUsage', 'getPlatformItemCatalogCount',
        'listPlatformItemCategories', 'updatePlatformItemCategory', 'deletePlatformItemCategory', 'syncPlatformItemCatalog',
        'syncPlatformItemAttributes', 'updatePlatformItem', 'deletePlatformItem', 'getPlatformCommodityCatalogWithUsage',
        'getPlatformCommodityCatalogCount', 'listPlatformCommodityCategories', 'updatePlatformCommodityCategory',
        'deletePlatformCommodityCategory', 'syncPlatformCommodityCatalog', 'updatePlatformCommodity',
        'deletePlatformCommodity', 'getPlatformLocations', 'getPlatformLocationCount', 'syncPlatformLocations',
        'updatePlatformLocation', 'deletePlatformLocation',
        // fleet
        'addUserShip', 'addUserShips', 'updateUserShip', 'removeUserShip', 'removeUserShips', 'createFleetGroup',
        'updateFleetGroup', 'deleteFleetGroup', 'assignShipToGroup', 'removeShipFromGroup', 'reorderFleetGroups',
        'reorderGroupShips', 'reparentFleetGroup',
    ];
    const db: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const n of names) db[n] = vi.fn();
    return { db, names };
});

vi.mock('../lib/db', () => h.db);

import { catalogActions } from '../api/actions/catalog';
import { fleetActions } from '../api/actions/fleet';

type Handler = (payload: unknown) => unknown;
const CATALOG = catalogActions as unknown as Record<string, Handler>;
const FLEET = fleetActions as unknown as Record<string, Handler>;
const fn = (name: string) => h.db[name];
const dbCallCount = () => h.names.reduce((n, name) => n + fn(name).mock.calls.length, 0);

beforeEach(() => {
    vi.resetAllMocks();
});

type Case = [string, Record<string, unknown>, string, unknown[]];

const CATALOG_CASES: Case[] = [
    ['catalog:list_ships', {}, 'getShipCatalogWithUsage', []],
    ['catalog:sync_ships', { force: true }, 'syncShipCatalog', []],
    ['catalog:repair_ships', {}, 'repairShipCatalogDuplicates', []],
    ['catalog:update_ship', { shipId: 3, updates: { name: 'Cutlass' }, id: 9 }, 'updatePlatformShip', [3, { name: 'Cutlass' }]],
    ['catalog:delete_ship', { shipId: 3, id: 9 }, 'deletePlatformShip', [3]],
    ['catalog:merge_ships', { keepId: 3, deleteId: 4 }, 'mergePlatformShips', [3, 4]],
    ['catalog:list_items', { search: 'p4', limit: 50, offset: 0 }, 'getPlatformItemCatalogWithUsage', [{ search: 'p4', limit: 50, offset: 0 }]],
    ['catalog:count_items', { search: 'p4' }, 'getPlatformItemCatalogCount', [{ search: 'p4' }]],
    ['catalog:list_item_categories', {}, 'listPlatformItemCategories', []],
    ['catalog:update_item_category', { id: 5, updates: { name: 'Weapons' } }, 'updatePlatformItemCategory', [5, { name: 'Weapons' }]],
    ['catalog:delete_item_category', { id: 5 }, 'deletePlatformItemCategory', [5]],
    ['catalog:sync_items', {}, 'syncPlatformItemCatalog', []],
    ['catalog:sync_item_attributes', {}, 'syncPlatformItemAttributes', []],
    ['catalog:update_item', { itemId: 6, updates: { name: 'P4-AR' }, id: 9 }, 'updatePlatformItem', [6, { name: 'P4-AR' }]],
    ['catalog:delete_item', { itemId: 6 }, 'deletePlatformItem', [6]],
    ['catalog:list_commodities', { category: 'ore' }, 'getPlatformCommodityCatalogWithUsage', [{ category: 'ore' }]],
    ['catalog:count_commodities', { category: 'ore' }, 'getPlatformCommodityCatalogCount', [{ category: 'ore' }]],
    ['catalog:list_commodity_categories', {}, 'listPlatformCommodityCategories', []],
    ['catalog:update_commodity_category', { id: 7, updates: { name: 'Ore' } }, 'updatePlatformCommodityCategory', [7, { name: 'Ore' }]],
    ['catalog:delete_commodity_category', { id: 7 }, 'deletePlatformCommodityCategory', [7]],
    ['catalog:sync_commodities', {}, 'syncPlatformCommodityCatalog', []],
    ['catalog:update_commodity', { commodityId: 8, updates: { name: 'Agricium' } }, 'updatePlatformCommodity', [8, { name: 'Agricium' }]],
    ['catalog:delete_commodity', { commodityId: 8 }, 'deletePlatformCommodity', [8]],
    ['catalog:list_locations', { type: 'station', limit: 20 }, 'getPlatformLocations', [{ type: 'station', limit: 20 }]],
    ['catalog:count_locations', { type: 'station' }, 'getPlatformLocationCount', []],
    ['catalog:sync_locations', {}, 'syncPlatformLocations', []],
    ['catalog:update_location', { locationId: 9, updates: { name: 'Lorville' } }, 'updatePlatformLocation', [9, { name: 'Lorville' }]],
    ['catalog:delete_location', { locationId: 9 }, 'deletePlatformLocation', [9]],
];

describe('catalog handlers map the dashboard keys onto the right db function and slots', () => {
    it.each(CATALOG_CASES)('%s → %s', async (action, payload, dbFn, args) => {
        const result = { marker: action };
        fn(dbFn).mockResolvedValueOnce(result);
        await expect(CATALOG[action](payload)).resolves.toBe(result);
        expect(fn(dbFn).mock.calls).toStrictEqual([args]);
        expect(dbCallCount()).toBe(1);
    });

    it('a failed sync propagates instead of resolving as success', async () => {
        fn('syncShipCatalog').mockRejectedValueOnce(new Error('UEX unreachable'));
        await expect(CATALOG['catalog:sync_ships']({})).rejects.toThrow('UEX unreachable');
    });

    it('every exported catalog handler is exercised', () => {
        expect(Object.keys(CATALOG).sort()).toStrictEqual([...new Set(CATALOG_CASES.map(([a]) => a))].sort());
    });
});

const FLEET_CASES: Case[] = [
    ['fleet:add_ship', { userId: 7, shipId: 3, customName: 'Bessie', loadoutNotes: 'n', ownerId: 99 }, 'addUserShip', [7, 3, 'Bessie', 'n']],
    ['fleet:add_ships', { userId: 7, shipIds: [3, 4], ownerId: 99 }, 'addUserShips', [7, [3, 4]]],
    ['fleet:create_group', { groupData: { name: 'Alpha', type: 'wing', commanderId: 3 }, id: 9 }, 'createFleetGroup', [{ name: 'Alpha', type: 'wing', commanderId: 3 }]],
    ['fleet:update_group', { groupId: 2, updates: { name: 'Bravo' } }, 'updateFleetGroup', [2, { name: 'Bravo' }]],
    ['fleet:delete_group', { groupId: 2 }, 'deleteFleetGroup', [2]],
    ['fleet:assign_ship', { fleetGroupId: 2, userShipId: 11 }, 'assignShipToGroup', [2, 11]],
    ['fleet:unassign_ship', { fleetGroupId: 2, userShipId: 11 }, 'removeShipFromGroup', [2, 11]],
    ['fleet:reorder_groups', { orderedIds: [3, 1, 2] }, 'reorderFleetGroups', [[3, 1, 2]]],
    ['fleet:reorder_group_ships', { fleetGroupId: 2, orderedAssignmentIds: [5, 4] }, 'reorderGroupShips', [2, [5, 4]]],
    ['fleet:reparent_group', { groupId: 2, newParentId: 1, newSortOrder: 3 }, 'reparentFleetGroup', [2, 1, 3]],
    ['fleet:reparent_group', { groupId: 2, newSortOrder: 0 }, 'reparentFleetGroup', [2, null, 0]],
    ['fleet:sync_catalog', {}, 'syncShipCatalog', []],
];

describe('fleet handlers forward exactly their arguments', () => {
    it.each(FLEET_CASES)('%s → %s', async (action, payload, dbFn, args) => {
        const result = { marker: action };
        fn(dbFn).mockResolvedValueOnce(result);
        await expect(FLEET[action](payload)).resolves.toBe(result);
        expect(fn(dbFn).mock.calls).toStrictEqual([args]);
        expect(dbCallCount()).toBe(1);
    });
});

describe('fleetOwnScope: fleet:manage is org-wide, everyone else is scoped to their own ships', () => {
    const MUTATIONS: Array<[string, Record<string, unknown>, string, (scope: number | undefined) => unknown[]]> = [
        ['fleet:update_ship', { userShipId: 11, updates: { status: 'Destroyed', isPrimary: true } }, 'updateUserShip',
            (s) => [11, { status: 'Destroyed', isPrimary: true }, s]],
        ['fleet:remove_ship', { userShipId: 11 }, 'removeUserShip', (s) => [11, s]],
        ['fleet:remove_ships', { userShipIds: [11, 12] }, 'removeUserShips', (s) => [[11, 12], s]],
    ];
    const USERS: Array<[string, unknown, number | undefined]> = [
        ['fleet:manage holder → org-wide (undefined)', { permissions: ['fleet:view', 'fleet:manage'] }, undefined],
        ['fleet:manage_own only → own ships', { permissions: ['fleet:view', 'fleet:manage_own'] }, 7],
        ['a role NAMED Admin without the permission → own ships', { role: 'Admin', permissions: [] }, 7],
        ['permissions as a string containing the word → own ships (fails closed)', { permissions: 'fleet:manage' }, 7],
        ['no permissions field → own ships', {}, 7],
        ['no user at all → own ships', undefined, 7],
    ];

    for (const [action, payload, dbFn, args] of MUTATIONS) {
        it.each(USERS)(`${action}: %s`, async (_label, user, scope) => {
            fn(dbFn).mockResolvedValueOnce({ ok: true });
            await expect(FLEET[action]({ ...payload, userId: 7, user })).resolves.toStrictEqual({ ok: true });
            expect(fn(dbFn).mock.calls).toStrictEqual([args(scope)]);
        });
    }

    it('an ownership refusal from the db layer propagates unchanged', async () => {
        fn('removeUserShip').mockRejectedValueOnce(new Error('Ship not found.'));
        await expect(FLEET['fleet:remove_ship']({ userShipId: 11, userId: 7, user: { permissions: ['fleet:manage_own'] } }))
            .rejects.toThrow('Ship not found.');
    });

    it('every exported fleet handler is exercised', () => {
        const covered = new Set([...FLEET_CASES.map(([a]) => a), ...MUTATIONS.map(([a]) => a)]);
        expect(Object.keys(FLEET).sort()).toStrictEqual([...covered].sort());
    });
});
