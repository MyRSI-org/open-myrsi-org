import * as db from '../../lib/db.js';
import { sendPushToPermission } from '../../lib/push.js';
import { log as baseLog } from '../../lib/log.js';
import type { QmCatalogCategory, QmLocationType, QmCondition, QmIssuanceStatus } from '../../types.js';

const log = baseLog.child({ module: 'actions.quartermaster' });

// --- Payload shapes ---
// For mutations, payloads carry the authenticated userId. Numeric ids are
// treated as numbers by the lib/db layer; the listing handlers coerce
// loosely-typed client values.

type EmptyPayload = Record<string, never>;

interface SearchCatalogPayload {
    query: string;
    source?: 'custom' | 'platform' | 'both';
    limit?: number;
}

interface CreateCatalogItemPayload {
    name: string;
    category: QmCatalogCategory;
    subcategory?: string | null;
    attributes?: Record<string, unknown>;
    thumbnailUrl?: string | null;
    wikiUrl?: string | null;
}

interface UpdateCatalogItemPayload {
    catalogId: number;
    name?: string;
    category?: QmCatalogCategory;
    subcategory?: string | null;
    attributes?: Record<string, unknown>;
    thumbnailUrl?: string | null;
    wikiUrl?: string | null;
}

interface DeleteCatalogItemPayload {
    catalogId: number;
}

interface CreateLocationPayload {
    name: string;
    type?: QmLocationType;
    parentId?: number | null;
    description?: string | null;
    sortOrder?: number;
}

interface UpdateLocationPayload {
    locationId: number;
    name?: string;
    type?: QmLocationType;
    parentId?: number | null;
    description?: string | null;
    sortOrder?: number;
}

interface DeleteLocationPayload {
    locationId: number;
}

/** Catalog facets, shared by the list and the count so the two cannot drift. */
interface InventoryFacetFields {
    category?: unknown;
    subcategory?: unknown;
    sizeLabel?: unknown;
    manufacturer?: unknown;
    itemKind?: unknown;
    attributes?: unknown;
}

interface ListInventoryPayload extends InventoryFacetFields {
    includeArchived?: boolean;
    locationId?: number | string | null;
    catalogId?: number | string | null;
    search?: string;
    limit?: number;
    offset?: number;
}

interface CountInventoryPayload extends InventoryFacetFields {
    includeArchived?: boolean;
    locationId?: number | string | null;
    catalogId?: number | string | null;
    search?: string;
}

const QM_CATEGORIES: readonly string[] = ['weapon', 'armor', 'component', 'consumable', 'misc'];

/** Bounded free-text facet value. Null for anything that is not a usable string. */
function facetStr(v: unknown, max = 80): string | null {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t ? t.slice(0, max) : null;
}

function facetCategory(v: unknown): QmCatalogCategory | null {
    const s = facetStr(v, 20);
    return s && QM_CATEGORIES.includes(s) ? (s as QmCatalogCategory) : null;
}

function facetKind(v: unknown): 'vehicle' | 'personal' | null {
    return v === 'vehicle' || v === 'personal' ? v : null;
}

/**
 * Attribute facets, validated against the SERVER's allowlist.
 *
 * The keys land in a PostgREST `@>` containment filter against a JSONB column, so an
 * arbitrary caller-chosen key would let anyone probe for any attribute the catalogue
 * happens to carry — and would make the facet surface unbounded regardless of what
 * the ingest writes. Values are length-capped for the same reason.
 */
function facetAttributes(v: unknown): Record<string, string> | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!(db.FACETABLE_ATTR_KEYS as readonly string[]).includes(k)) continue;
        const s = facetStr(val, 60);
        if (s) out[k] = s;
    }
    return Object.keys(out).length ? out : null;
}

function facetOptsFrom(p: InventoryFacetFields) {
    return {
        category: facetCategory(p.category),
        subcategory: facetStr(p.subcategory),
        sizeLabel: facetStr(p.sizeLabel, 20),
        manufacturer: facetStr(p.manufacturer),
        itemKind: facetKind(p.itemKind),
        attributes: facetAttributes(p.attributes),
    };
}

interface CreateInventoryPayload {
    userId: number;
    catalogId?: number | null;
    customName?: string | null;
    locationId?: number | null;
    condition?: QmCondition;
    initialQuantity: number;
    notes?: string | null;
}

interface UpdateInventoryPayload {
    inventoryId: number;
    locationId?: number | null;
    condition?: QmCondition;
    notes?: string | null;
    customName?: string | null;
    isArchived?: boolean;
}

interface AdjustInventoryPayload {
    userId: number;
    inventoryId: number;
    delta: number;
    reason: 'adjust' | 'loss' | 'destruction';
    notes?: string | null;
}

interface SetInventoryTotalPayload {
    userId: number;
    inventoryId: number;
    targetTotal: number;
    reason: 'adjust' | 'loss' | 'destruction';
    notes?: string | null;
}

interface ListIssuancesPayload {
    status?: QmIssuanceStatus | 'open';
    userIdFilter?: number;
    inventoryId?: number;
    limit?: number;
}

interface RequestIssuancePayload {
    userId: number;
    inventoryId: number;
    issuedToUserId?: number;
    quantity: number;
    dueBackAt?: string | null;
    notes?: string | null;
    operationId?: number | null;
}

interface FulfilIssuancePayload {
    userId: number;
    issuanceId: number;
}

interface IssueDirectPayload {
    userId: number;
    inventoryId: number;
    issuedToUserId: number;
    quantity: number;
    dueBackAt?: string | null;
    notes?: string | null;
    operationId?: number | null;
}

interface IssueBulkPayload {
    userId: number;
    issuedToUserId: number;
    lines: { inventoryId: number; quantity: number }[];
    dueBackAt?: string | null;
    notes?: string | null;
    operationId?: number | null;
}

interface ReturnIssuancePayload {
    userId: number;
    issuanceId: number;
    returnedQuantity: number;
    outcome: 'returned_on_time' | 'returned_late' | 'returned_damaged';
    notes?: string | null;
}

interface ReturnBulkPayload {
    userId: number;
    lines: {
        issuanceId: number;
        returnedQuantity: number;
        outcome: 'returned_on_time' | 'returned_late' | 'returned_damaged';
    }[];
    notes?: string | null;
}

interface WriteOffIssuancePayload {
    userId: number;
    issuanceId: number;
    outcome: 'lost' | 'destroyed_in_action';
    notes?: string | null;
}

interface LowStockPayload {
    threshold?: number;
    limit?: number;
}

/**
 * Quartermaster RPC action handlers. Permission checks are enforced in
 * services.ts before these handlers are dispatched.
 */
export const quartermasterActions = {
    // --- CATALOG ---
    'qm:list_catalog': async (_payload: EmptyPayload) =>
        db.listCatalog(),

    'qm:search_catalog': async ({ query, source, limit }: SearchCatalogPayload) =>
        db.searchCatalog({ query, source, limit }),

    'qm:create_catalog_item': async ({ name, category, subcategory, attributes, thumbnailUrl, wikiUrl }: CreateCatalogItemPayload) =>
        db.createCatalogItem({ name, category, subcategory, attributes, thumbnailUrl, wikiUrl }),

    'qm:update_catalog_item': async ({ catalogId, name, category, subcategory, attributes, thumbnailUrl, wikiUrl }: UpdateCatalogItemPayload) =>
        db.updateCatalogItem({ id: catalogId, name, category, subcategory, attributes, thumbnailUrl, wikiUrl }),

    'qm:delete_catalog_item': async ({ catalogId }: DeleteCatalogItemPayload) =>
        db.deleteCatalogItem(catalogId),

    // Realtime row-slice fetch: qm:catalog_update broadcasts carry the
    // catalogId; QuartermasterView splices just that row instead of
    // re-listing the catalog.
    'qm:get_catalog_item': async ({ catalogId }: DeleteCatalogItemPayload) =>
        db.getCatalogItemById(catalogId),

    // --- LOCATIONS ---
    'qm:list_locations': async (_payload: EmptyPayload) =>
        db.listQmLocations(),

    'qm:create_location': async ({ name, type, parentId, description, sortOrder }: CreateLocationPayload) =>
        db.createQmLocation({ name, type, parentId, description, sortOrder }),

    'qm:update_location': async ({ locationId, name, type, parentId, description, sortOrder }: UpdateLocationPayload) =>
        db.updateQmLocation({ id: locationId, name, type, parentId, description, sortOrder }),

    'qm:delete_location': async ({ locationId }: DeleteLocationPayload) =>
        db.deleteQmLocation(locationId),

    // Realtime row-slice fetch — see qm:get_catalog_item.
    'qm:get_location': async ({ locationId }: DeleteLocationPayload) =>
        db.getQmLocationById(locationId),

    // --- INVENTORY ---
    // The list and the count MUST parse facets through the same helper. They are two
    // separate queries backing one screen, and a filter applied to only one of them
    // shows a page of N rows above a pager that claims a different total — which is
    // how the original search defect surfaced as "No inventory yet".
    'qm:list_inventory': async ({ includeArchived, locationId, catalogId, search, limit, offset, ...facets }: ListInventoryPayload) =>
        db.listInventory({
            includeArchived: !!includeArchived,
            locationId: locationId != null ? Number(locationId) : null,
            catalogId: catalogId != null ? Number(catalogId) : null,
            search: typeof search === 'string' ? search : undefined,
            limit: typeof limit === 'number' ? limit : undefined,
            offset: typeof offset === 'number' ? offset : undefined,
            ...facetOptsFrom(facets),
        }),

    'qm:count_inventory': async ({ includeArchived, locationId, catalogId, search, ...facets }: CountInventoryPayload) =>
        db.listInventoryCount({
            includeArchived: !!includeArchived,
            locationId: locationId != null ? Number(locationId) : null,
            catalogId: catalogId != null ? Number(catalogId) : null,
            search: typeof search === 'string' ? search : undefined,
            ...facetOptsFrom(facets),
        }),

    /** Filter options, derived from stock that actually exists. */
    'qm:list_inventory_facets': async ({ includeArchived }: { includeArchived?: boolean }) =>
        db.getArmoryFacets({ includeArchived: !!includeArchived }),

    'qm:create_inventory': async ({ userId, catalogId, customName, locationId, condition, initialQuantity, notes }: CreateInventoryPayload) =>
        db.createInventoryItem(userId, { catalogId, customName, locationId, condition, initialQuantity, notes }),

    'qm:update_inventory': async ({ inventoryId, locationId, condition, notes, customName, isArchived }: UpdateInventoryPayload) =>
        db.updateInventoryItem({ id: inventoryId, locationId, condition, notes, customName, isArchived }),

    'qm:adjust_inventory': async ({ userId, inventoryId, delta, reason, notes }: AdjustInventoryPayload) =>
        db.adjustInventoryStock(userId, { inventoryId, delta, reason, notes }),

    // Absolute set-total. Distinct from adjust_inventory because the arithmetic must
    // happen server-side under the row lock — see db.setInventoryTotal.
    'qm:set_inventory_total': async ({ userId, inventoryId, targetTotal, reason, notes }: SetInventoryTotalPayload) =>
        db.setInventoryTotal(userId, { inventoryId, targetTotal, reason, notes }),

    // --- ISSUANCES ---
    'qm:list_issuances': async ({ status, userIdFilter, inventoryId, limit }: ListIssuancesPayload) =>
        db.listIssuances({ status, userId: userIdFilter, inventoryId, limit }),

    // Realtime row-slice fetch: qm:issuance_update broadcasts carry the
    // issuanceId(s); QuartermasterView splices just those rows instead of
    // re-listing 200 four-user-join rows.
    'qm:get_issuance': async ({ issuanceId }: { issuanceId: number }) =>
        db.getIssuanceById(issuanceId),

    'qm:request_issuance': async ({
        userId, inventoryId, issuedToUserId, quantity, dueBackAt, notes, operationId,
    }: RequestIssuancePayload) => {
        const issuance = await db.requestIssuance(userId, {
            inventoryId, issuedToUserId, quantity, dueBackAt, notes, operationId,
        });
        sendPushToPermission('qm:manage', {
            title: 'Issuance request',
            body: `${quantity}× requested · ${issuance.inventory?.catalog?.name || issuance.inventory?.customName || 'item'}`,
            tag: `qm-request-${issuance.id}`,
            data: { view: 'quartermaster', tab: 'issuances', issuanceId: issuance.id },
        }).catch((err) => log.warn('request push failed', { err }));
        return issuance;
    },

    'qm:fulfil_issuance': async ({ userId, issuanceId }: FulfilIssuancePayload) => {
        const ok = await db.fulfilIssuance(userId, issuanceId);
        if (ok) {
            // Notify the recipient that their request was fulfilled.
            const issuances = await db.listIssuances({ limit: 1 });
            const issuance = issuances.find((i) => i.id === issuanceId);
            if (issuance && issuance.issuedToUserId !== userId) {
                // Durable inbox notification (also emits realtime + OS push).
                await db.createNotification(issuance.issuedToUserId, {
                    type: 'qm_issuance',
                    title: 'Loadout ready',
                    body: `Your issuance of ${issuance.quantity}× ${issuance.inventory?.catalog?.name || issuance.inventory?.customName || 'item'} has been fulfilled.`,
                    link: 'quartermaster',
                    metadata: { issuanceId },
                }).catch((err) => log.warn('fulfil notification failed', { err }));
            }
        }
        return { applied: ok };
    },

    'qm:issue_direct': async ({
        userId, inventoryId, issuedToUserId, quantity, dueBackAt, notes, operationId,
    }: IssueDirectPayload) => {
        const issuanceId = await db.issueDirect(userId, {
            inventoryId, issuedToUserId, quantity, dueBackAt, notes, operationId,
        });
        if (issuedToUserId !== userId) {
            await db.createNotification(issuedToUserId, {
                type: 'qm_issuance',
                title: 'Loadout issued',
                body: `You've been issued ${quantity}× item by an officer.`,
                link: 'quartermaster',
                metadata: { issuanceId },
            }).catch((err) => log.warn('issue notification failed', { err }));
        }
        return { issuanceId };
    },

    'qm:issue_bulk': async ({
        userId, issuedToUserId, lines, dueBackAt, notes, operationId,
    }: IssueBulkPayload) => {
        const issuanceIds = await db.issueDirectBulk(userId, {
            issuedToUserId, lines, dueBackAt, notes, operationId,
        });
        if (issuedToUserId !== userId && issuanceIds.length > 0) {
            await db.createNotification(issuedToUserId, {
                type: 'qm_issuance',
                title: 'Kit issued',
                body: `An officer issued ${issuanceIds.length} ${issuanceIds.length === 1 ? 'item' : 'items'} to you.`,
                link: 'quartermaster',
                metadata: { issuanceId: issuanceIds[0] },
            }).catch((err) => log.warn('bulk issue notification failed', { err }));
        }
        return { issuanceIds };
    },

    'qm:return_issuance': async ({ userId, issuanceId, returnedQuantity, outcome, notes }: ReturnIssuancePayload) => {
        const ok = await db.returnIssuance(userId, { issuanceId, returnedQuantity, outcome, notes });
        return { applied: ok };
    },

    'qm:return_bulk': async ({ userId, lines, notes }: ReturnBulkPayload) => {
        const closed = await db.returnIssuanceBulk(userId, { lines, notes });
        return { closed };
    },

    'qm:list_member_records': async (_payload: EmptyPayload) =>
        db.listMemberRecords(),

    'qm:write_off_issuance': async ({ userId, issuanceId, outcome, notes }: WriteOffIssuancePayload) => {
        const ok = await db.writeOffIssuance(userId, { issuanceId, outcome, notes });
        return { applied: ok };
    },

    // --- OVERVIEW / EXPORT ---
    'qm:get_overview': async (_payload: EmptyPayload) =>
        db.getQuartermasterOverview(),

    'qm:list_low_stock': async ({ threshold, limit }: LowStockPayload) =>
        db.listLowStockInventory({
            threshold: typeof threshold === 'number' ? threshold : undefined,
            limit: typeof limit === 'number' ? limit : undefined,
        }),

    'qm:export_csv': async (_payload: EmptyPayload) => {
        const csv = await db.exportInventoryCsv();
        return { csv, filename: `inventory-${new Date().toISOString().slice(0, 10)}.csv` };
    },

    // --- OVERDUE SCAN (for admin UI or nightly cron) ---
    'qm:list_overdue': async (_payload: EmptyPayload) =>
        db.listOverdueIssuances(),
};
