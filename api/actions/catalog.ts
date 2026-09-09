import * as db from '../../lib/db.js';
import type { ListPlatformItemsOptions } from '../../lib/db/quartermaster.js';
import type { ListPlatformCommoditiesOptions } from '../../lib/db/warehouse.js';
import type { ListLocationsOptions } from '../../lib/db/locations.js';

/**
 * Global catalog management actions (ships / items / commodities / locations).
 *
 * These are thin pass-throughs to the intact lib/db catalog functions. They
 * replace the deleted portal `platform:*` actions and are gated server-side on
 * the `admin:config:catalog` permission via api/services.ts's fullPermissionMap.
 *
 * Payload key conventions (the relocated dashboard tabs send these exact keys):
 *   - ships:        { shipId, updates } / { keepId, deleteId }
 *   - items:        { itemId, updates }
 *   - commodities:  { commodityId, updates }
 *   - locations:    { locationId, updates }
 *   - categories:   { id, updates }
 */
export const catalogActions = {
    // --- Ships (platform_ships) ---
    'catalog:list_ships': () => db.getShipCatalogWithUsage(),
    'catalog:sync_ships': () => db.syncShipCatalog(),
    'catalog:repair_ships': () => db.repairShipCatalogDuplicates(),
    'catalog:update_ship': ({ shipId, updates }: { shipId: number; updates: Record<string, unknown> }) => db.updatePlatformShip(shipId, updates),
    'catalog:delete_ship': ({ shipId }: { shipId: number }) => db.deletePlatformShip(shipId),
    'catalog:merge_ships': ({ keepId, deleteId }: { keepId: number; deleteId: number }) => db.mergePlatformShips(keepId, deleteId),

    // --- Items (quartermaster_catalog source=platform) ---
    'catalog:list_items': (p: ListPlatformItemsOptions) => db.getPlatformItemCatalogWithUsage(p),
    'catalog:count_items': (p: ListPlatformItemsOptions) => db.getPlatformItemCatalogCount(p),
    'catalog:list_item_categories': () => db.listPlatformItemCategories(),
    'catalog:update_item_category': ({ id, updates }: { id: number; updates: Record<string, unknown> }) => db.updatePlatformItemCategory(id, updates),
    'catalog:delete_item_category': ({ id }: { id: number }) => db.deletePlatformItemCategory(id),
    'catalog:sync_items': () => db.syncPlatformItemCatalog(),
    // Separate from the item sync on purpose: it hits a different UEX endpoint per
    // category and the item sync deliberately does not touch the attributes column,
    // so the two are independent and order does not matter.
    'catalog:sync_item_attributes': () => db.syncPlatformItemAttributes(),
    'catalog:update_item': ({ itemId, updates }: { itemId: number; updates: Record<string, unknown> }) => db.updatePlatformItem(itemId, updates),
    'catalog:delete_item': ({ itemId }: { itemId: number }) => db.deletePlatformItem(itemId),

    // --- Commodities (warehouse_platform_commodities) ---
    'catalog:list_commodities': (p: ListPlatformCommoditiesOptions) => db.getPlatformCommodityCatalogWithUsage(p),
    'catalog:count_commodities': (p: ListPlatformCommoditiesOptions) => db.getPlatformCommodityCatalogCount(p),
    'catalog:list_commodity_categories': () => db.listPlatformCommodityCategories(),
    'catalog:update_commodity_category': ({ id, updates }: { id: number; updates: Record<string, unknown> }) => db.updatePlatformCommodityCategory(id, updates),
    'catalog:delete_commodity_category': ({ id }: { id: number }) => db.deletePlatformCommodityCategory(id),
    'catalog:sync_commodities': () => db.syncPlatformCommodityCatalog(),
    'catalog:update_commodity': ({ commodityId, updates }: { commodityId: number; updates: Record<string, unknown> }) => db.updatePlatformCommodity(commodityId, updates),
    'catalog:delete_commodity': ({ commodityId }: { commodityId: number }) => db.deletePlatformCommodity(commodityId),

    // --- Locations (platform_locations) ---
    'catalog:list_locations': (p: ListLocationsOptions) => db.getPlatformLocations(p),
    'catalog:count_locations': () => db.getPlatformLocationCount(),
    'catalog:sync_locations': () => db.syncPlatformLocations(),
    'catalog:update_location': ({ locationId, updates }: { locationId: number; updates: Record<string, unknown> }) => db.updatePlatformLocation(locationId, updates),
    'catalog:delete_location': ({ locationId }: { locationId: number }) => db.deletePlatformLocation(locationId),
};
