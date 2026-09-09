import * as db from '../../lib/db.js';
import { sendPushToPermission, sendPushToUsers } from '../../lib/push.js';
import { log as baseLog } from '../../lib/log.js';
import type {
    WarehouseCatalogCategory,
    WarehouseMovementReason,
    WarehouseReasonCategory,
    WarehouseRequestStatus,
    QmLocationType,
} from '../../types.js';

const log = baseLog.child({ module: 'actions.warehouse' });

// ----------------------------------------------------------------------------
// Payload shapes. Every handler receives the request body with the actor-id
// field (userId) injected server-side by services.ts. These mirror the field
// reads below — narrowing the dispatcher's `payload: any` here is
// assignment-safe because the registry erases handler param types.
// ----------------------------------------------------------------------------

interface ActorScopedPayload {
    userId: number;
}

// --- CATALOG ---

interface SearchCatalogPayload {
    query: string;
    source?: 'custom' | 'platform' | 'both';
    limit?: number;
}

interface CreateCatalogItemPayload {
    name: string;
    category: WarehouseCatalogCategory;
    qualityLabel?: string | null;
    unit?: string;
    description?: string | null;
}

interface UpdateCatalogItemPayload {
    catalogId: number;
    name?: string;
    category?: WarehouseCatalogCategory;
    qualityLabel?: string | null;
    unit?: string;
    description?: string | null;
}

interface ArchiveCatalogItemPayload {
    catalogId: number;
    archive?: boolean;
}

interface CatalogItemPayload {
    catalogId: number;
}

interface PaginatedExportPayload {
    offset?: number;
    limit?: number;
}

interface ImportCatalogPayload {
    items: unknown;
    offset?: number;
    limit?: number;
}

interface PreviewImportCatalogPayload {
    items: unknown;
}

// --- LOCATIONS ---

interface CreateLocationPayload {
    name: string;
    type?: QmLocationType;
    parentId?: number | null;
    description?: string | null;
}

interface UpdateLocationPayload {
    locationId: number;
    name?: string;
    type?: QmLocationType;
    parentId?: number | null;
    description?: string | null;
}

interface LocationPayload {
    locationId: number;
}

// --- STOCK ---

interface ListStockPayload {
    catalogId?: number | string | null;
    locationId?: number | string | null;
    limit?: number;
    offset?: number;
}

interface CountStockPayload {
    catalogId?: number | string | null;
    locationId?: number | string | null;
}

interface CreateStockPayload {
    catalogId: number;
    locationId: number;
    notes?: string | null;
    source?: string;
    qualityLabel?: string | null;
}

interface StockPayload {
    stockId: number | string;
}

interface AdjustStockPayload extends ActorScopedPayload {
    stockId: number;
    delta: number;
    reason: WarehouseMovementReason;
    notes?: string | null;
}

interface SetStockTotalPayload extends ActorScopedPayload {
    stockId: number;
    targetTotal: number;
    reason: WarehouseMovementReason;
    notes?: string | null;
}

interface TransferStockPayload extends ActorScopedPayload {
    fromStockId: number;
    toStockId: number;
    quantity: number;
    notes?: string | null;
}

// --- MOVEMENTS ---

interface ListMovementsPayload extends ActorScopedPayload {
    stockId?: number;
    reason?: WarehouseMovementReason;
    actorUserId?: number;
    sinceIso?: string;
    untilIso?: string;
    limit?: number;
    offset?: number;
}

// --- WITHDRAWAL REQUESTS ---

interface RequestWithdrawalPayload extends ActorScopedPayload {
    stockId: number;
    requestedQuantity: number;
    reasonCategory: WarehouseReasonCategory;
    reasonNotes?: string | null;
}

interface ListWithdrawalsPayload {
    status?: WarehouseRequestStatus | 'open';
    requesterUserId?: number;
    stockId?: number;
    limit?: number;
}

interface WithdrawalActionPayload extends ActorScopedPayload {
    requestId: string;
}

interface DenyWithdrawalPayload extends ActorScopedPayload {
    requestId: string;
    denialReason?: string | null;
}

/**
 * Warehouse RPC action handlers. Sister module to Quartermaster, but for bulk
 * fungible commodities (ore, refined materials, fuel, RMC, missiles).
 *
 * Feature-flag gate and permission checks are enforced in services.ts before
 * these handlers are dispatched.
 */
export const warehouseActions = {
    // --- CATALOG ---
    'warehouse:list_catalog': async () =>
        db.listWarehouseCatalog(),

    'warehouse:search_catalog': async ({ query, source, limit }: SearchCatalogPayload) =>
        db.searchWarehouseCatalog({ query, source, limit }),

    'warehouse:create_catalog_item': async ({ name, category, qualityLabel, unit, description }: CreateCatalogItemPayload) =>
        db.createWarehouseCatalogItem({ name, category, qualityLabel, unit, description }),

    'warehouse:update_catalog_item': async ({ catalogId, name, category, qualityLabel, unit, description }: UpdateCatalogItemPayload) =>
        db.updateWarehouseCatalogItem({ id: catalogId, name, category, qualityLabel, unit, description }),

    'warehouse:archive_catalog_item': async ({ catalogId, archive }: ArchiveCatalogItemPayload) =>
        db.archiveWarehouseCatalogItem(catalogId, archive !== false),

    'warehouse:delete_catalog_item': async ({ catalogId }: CatalogItemPayload) => {
        await db.deleteWarehouseCatalogItem(catalogId);
        return { applied: true };
    },

    'warehouse:export_catalog': async ({ offset, limit }: PaginatedExportPayload) =>
        db.exportWarehouseCatalog({
            offset: typeof offset === 'number' ? offset : undefined,
            limit: typeof limit === 'number' ? limit : undefined,
        }),

    'warehouse:preview_import_catalog': async ({ items }: PreviewImportCatalogPayload) =>
        db.previewWarehouseCatalogImport(items),

    'warehouse:import_catalog': async ({ items, offset, limit }: ImportCatalogPayload) =>
        db.bulkUpsertWarehouseCatalog(items, {
            offset: typeof offset === 'number' ? offset : 0,
            limit: typeof limit === 'number' ? limit : db.MAX_WAREHOUSE_IMPORT_BATCH_SIZE,
        }),

    // --- LOCATIONS (shared with Quartermaster — warehouse_stock.location_id
    // FKs quartermaster_locations, so this dialog must read from that table.
    // Warehouse-side CRUD lets admins manage them without enabling QM.) ---
    'warehouse:list_locations': async () =>
        db.listQmLocations(),

    'warehouse:create_location': async ({ name, type, parentId, description }: CreateLocationPayload) =>
        db.createQmLocation({ name, type, parentId, description }),

    'warehouse:update_location': async ({ locationId, name, type, parentId, description }: UpdateLocationPayload) =>
        db.updateQmLocation({ id: locationId, name, type, parentId, description }),

    'warehouse:delete_location': async ({ locationId }: LocationPayload) => {
        await db.deleteQmLocation(locationId);
        return { applied: true };
    },

    // --- STOCK ---
    'warehouse:list_stock': async ({ catalogId, locationId, limit, offset }: ListStockPayload) =>
        db.listWarehouseStock({
            catalogId: catalogId != null ? Number(catalogId) : null,
            locationId: locationId != null ? Number(locationId) : null,
            limit: typeof limit === 'number' ? limit : undefined,
            offset: typeof offset === 'number' ? offset : undefined,
        }),

    'warehouse:count_stock': async ({ catalogId, locationId }: CountStockPayload) =>
        db.listWarehouseStockCount({
            catalogId: catalogId != null ? Number(catalogId) : null,
            locationId: locationId != null ? Number(locationId) : null,
        }),

    'warehouse:create_stock': async ({ catalogId, locationId, notes, source, qualityLabel }: CreateStockPayload) =>
        db.createWarehouseStock({
            catalogId,
            locationId,
            notes,
            source: source === 'platform' ? 'platform' : 'custom',
            qualityLabel: typeof qualityLabel === 'string' ? qualityLabel : null,
        }),

    'warehouse:delete_stock': async ({ stockId }: StockPayload) => {
        await db.deleteWarehouseStock(Number(stockId));
        return { applied: true };
    },

    'warehouse:adjust_stock': async ({ userId, stockId, delta, reason, notes }: AdjustStockPayload) => {
        const movementId = await db.adjustWarehouseStock(stockId, delta, reason, userId, notes);
        return { movementId };
    },

    // Absolute set-total. movementId is null when the row was already at the target —
    // that is a successful no-op, not a failure. See db.setWarehouseStockTotal.
    'warehouse:set_stock_total': async ({ userId, stockId, targetTotal, reason, notes }: SetStockTotalPayload) => {
        const movementId = await db.setWarehouseStockTotal(stockId, targetTotal, reason, userId, notes);
        return { movementId };
    },

    'warehouse:transfer_stock': async ({ userId, fromStockId, toStockId, quantity, notes }: TransferStockPayload) => {
        const movementId = await db.transferWarehouseStock(fromStockId, toStockId, quantity, userId, notes);
        return { movementId };
    },

    // --- MOVEMENTS ---
    'warehouse:list_movements': async ({ userId, stockId, reason, actorUserId, sinceIso, untilIso, limit, offset }: ListMovementsPayload) => {
        // Cross-module gate. warehouse: and marketplace: toggle independently
        // (OPTIONAL_FEATURE_NAMESPACES), so an org running the warehouse with the
        // marketplace switched OFF must not receive contract-linked fields through a
        // warehouse action. Withholding the viewer id withholds all of them.
        const marketplaceOn = await db.isOptionalFeatureEnabled('marketplace');
        return db.listWarehouseMovements(
            { stockId, reason, actorUserId, sinceIso, untilIso, limit, offset },
            marketplaceOn ? userId : undefined,
        );
    },

    'warehouse:export_csv': async ({ offset, limit }: PaginatedExportPayload) =>
        db.exportWarehouseCsv({
            offset: typeof offset === 'number' ? offset : undefined,
            limit: typeof limit === 'number' ? limit : undefined,
        }),

    // --- WITHDRAWAL REQUESTS ---
    'warehouse:request_withdrawal': async ({ userId, stockId, requestedQuantity, reasonCategory, reasonNotes }: RequestWithdrawalPayload) => {
        const request = await db.createWithdrawalRequest(userId, {
            stockId, requestedQuantity, reasonCategory, reasonNotes,
        });
        sendPushToPermission('warehouse:manage', {
            title: 'Withdrawal request',
            body: `${requestedQuantity} requested · ${reasonCategory}`,
            tag: `wh-request-${request.id}`,
            data: { view: 'warehouse', tab: 'withdrawals', requestId: request.id },
        }).catch((err) => log.warn('withdrawal request push failed', { err }));
        return request;
    },

    'warehouse:list_withdrawals': async ({ status, requesterUserId, stockId, limit }: ListWithdrawalsPayload) =>
        db.listWithdrawalRequests({ status, requesterUserId, stockId, limit }),

    'warehouse:approve_withdrawal': async ({ userId, requestId }: WithdrawalActionPayload) => {
        await db.approveWithdrawalRequest(requestId, userId);
        return { applied: true };
    },

    'warehouse:deny_withdrawal': async ({ userId, requestId, denialReason }: DenyWithdrawalPayload) => {
        await db.denyWithdrawalRequest(requestId, userId, denialReason);
        return { applied: true };
    },

    'warehouse:cancel_withdrawal': async ({ userId, requestId }: WithdrawalActionPayload) => {
        await db.cancelWithdrawalRequest(requestId, userId);
        return { applied: true };
    },

    'warehouse:fulfil_withdrawal': async ({ userId, requestId }: WithdrawalActionPayload) => {
        const movementId = await db.fulfilWithdrawalRequest(requestId, userId);
        // Notify the requester that their withdrawal was fulfilled.
        const requests = await db.listWithdrawalRequests({ stockId: undefined, limit: 1 });
        const request = requests.find((r) => r.id === requestId);
        if (request && request.requestedByUserId !== userId) {
            sendPushToUsers([request.requestedByUserId], {
                title: 'Withdrawal fulfilled',
                body: `Your withdrawal of ${request.requestedQuantity} has been released.`,
                tag: `wh-fulfilled-${requestId}`,
                data: { view: 'warehouse', tab: 'withdrawals', requestId },
            }).catch((err) => log.warn('withdrawal fulfil push failed', { err }));
        }
        return { movementId };
    },

    // --- OVERVIEW ---
    'warehouse:get_overview': async () =>
        db.getWarehouseOverview(),
};
