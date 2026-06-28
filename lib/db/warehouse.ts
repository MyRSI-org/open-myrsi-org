import { supabase, handleSupabaseError, broadcastToOrg } from './common.js';
import { log as baseLog } from '../log.js';
import { toWarehousePlatformCommodity, toWarehousePlatformCategory } from './mappers.js';
import { safeSearchTerm, clampListOffset } from '../pgrest.js';
import { stripHtml, stripHtmlSingleLine } from '../textSanitize.js';
import type { Tables } from './rows.js';
import {
    fetchUexCommodities,
    mapUexCommodityToWarehouseRow,
    slugify,
} from './uex.js';
import type {
    WarehouseCatalogItem,
    WarehouseCatalogCategory,
    WarehouseStock,
    WarehouseMovement,
    WarehouseMovementReason,
    WarehouseRequest,
    WarehouseRequestStatus,
    WarehouseReasonCategory,
    WarehouseOverview,
    WarehousePlatformCommodity,
    WarehousePlatformCommodityWithUsage,
    WarehousePlatformCategory,
    WarehouseCatalogSearchResult,
} from '../../types.js';

const log = baseLog.child({ module: 'db.warehouse' });

// ---------------------------------------------------------------------------
// Mappers — local; keeping them here avoids cluttering shared mappers.ts
// Row types include the joined embeds the select()s hydrate (not captured by
// the generated base-table types).
// ---------------------------------------------------------------------------

type CatalogRow = Tables<'warehouse_catalog'>;
type LocationEmbed = { id: number; name: string; type: string };
type ActorEmbed = { id: number; name: string; avatar_url: string | null };
type StockRow = Tables<'warehouse_stock'> & {
    catalog?: CatalogRow | null;
    location?: LocationEmbed | null;
    quantity_on_hand?: number | null;
    quantity_reserved?: number | null;
};
type StockEmbed = StockRow;
type MovementRow = Tables<'warehouse_movements'> & { actor?: ActorEmbed | null; stock?: StockEmbed | null };
type RequestRow = Tables<'warehouse_requests'> & { stock?: StockEmbed | null; requested_by?: ActorEmbed | null };

function toCatalogItem(row: CatalogRow): WarehouseCatalogItem {
    return {
        id: row.id,
        name: row.name,
        category: row.category as WarehouseCatalogCategory,
        qualityLabel: row.quality_label || null,
        unit: row.unit,
        description: row.description || null,
        archivedAt: row.archived_at || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toStock(row: StockRow): WarehouseStock {
    return {
        id: row.id,
        catalogId: row.catalog_id,
        catalog: row.catalog ? toCatalogItem(row.catalog) : undefined,
        locationId: row.location_id,
        location: row.location ? { id: row.location.id, name: row.location.name, type: row.location.type } : undefined,
        notes: row.notes || null,
        quantityOnHand: typeof row.quantity_on_hand === 'number' ? row.quantity_on_hand : 0,
        quantityReserved: typeof row.quantity_reserved === 'number' ? row.quantity_reserved : 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toMovement(row: MovementRow): WarehouseMovement {
    return {
        id: row.id,
        stockId: row.stock_id,
        delta: row.delta,
        reason: row.reason as WarehouseMovementReason,
        actorUserId: row.actor_user_id,
        actor: row.actor ? { id: row.actor.id, name: row.actor.name, avatarUrl: row.actor.avatar_url } : undefined,
        stock: row.stock ? {
            id: row.stock.id,
            catalogId: row.stock.catalog_id,
            catalog: row.stock.catalog ? {
                id: row.stock.catalog.id,
                name: row.stock.catalog.name,
                category: row.stock.catalog.category as WarehouseCatalogCategory,
                qualityLabel: row.stock.catalog.quality_label || null,
                unit: row.stock.catalog.unit,
            } : undefined,
            location: row.stock.location ? {
                id: row.stock.location.id,
                name: row.stock.location.name,
                type: row.stock.location.type,
            } : undefined,
        } : undefined,
        relatedRequestId: row.related_request_id || null,
        relatedMovementId: row.related_movement_id || null,
        notes: row.notes || null,
        createdAt: row.created_at,
    };
}

function toRequest(row: RequestRow): WarehouseRequest {
    return {
        id: row.id,
        stockId: row.stock_id,
        stock: row.stock ? {
            id: row.stock.id,
            catalogId: row.stock.catalog_id,
            catalog: row.stock.catalog ? {
                id: row.stock.catalog.id,
                name: row.stock.catalog.name,
                category: row.stock.catalog.category as WarehouseCatalogCategory,
                qualityLabel: row.stock.catalog.quality_label || null,
                unit: row.stock.catalog.unit,
            } : undefined,
            location: row.stock.location ? {
                id: row.stock.location.id,
                name: row.stock.location.name,
                type: row.stock.location.type,
            } : undefined,
            quantityOnHand: typeof row.stock.quantity_on_hand === 'number' ? row.stock.quantity_on_hand : undefined,
        } : undefined,
        requestedByUserId: row.requested_by_user_id,
        requestedBy: row.requested_by ? { id: row.requested_by.id, name: row.requested_by.name, avatarUrl: row.requested_by.avatar_url } : undefined,
        requestedQuantity: row.requested_quantity,
        reasonCategory: row.reason_category as WarehouseReasonCategory,
        reasonNotes: row.reason_notes || null,
        status: row.status as WarehouseRequestStatus,
        approvedByUserId: row.approved_by_user_id || null,
        approvedAt: row.approved_at || null,
        fulfilledMovementId: row.fulfilled_movement_id || null,
        fulfilledAt: row.fulfilled_at || null,
        denialReason: row.denial_reason || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface ListWarehouseCatalogOptions {
    /** Default 1000 (Supabase PostgREST hard ceiling). Set lower for paginated UIs. */
    limit?: number;
    offset?: number;
}

export async function listWarehouseCatalog(
    opts: ListWarehouseCatalogOptions = {},
): Promise<WarehouseCatalogItem[]> {
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 1000);
    const offset = clampListOffset(opts.offset);
    const { data, error } = await supabase.from('warehouse_catalog')
        .select('id, name, category, quality_label, unit, description, archived_at, created_at, updated_at')

        .order('category', { ascending: true })
        .order('name', { ascending: true })
        .range(offset, offset + limit - 1);
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load warehouse catalog' });
    return (data || []).map(toCatalogItem);
}

export async function listWarehouseCatalogCount(): Promise<number> {
    const { count, error } = await supabase.from('warehouse_catalog')
        .select('id', { count: 'exact', head: true })
        ;
    if (error && error.code === '42P01') return 0;
    handleSupabaseError({ error, message: 'Failed to count warehouse catalog' });
    return count ?? 0;
}

/**
 * Server-side ILIKE search across both tenant warehouse_catalog (custom) and
 * platform warehouse_platform_commodities. Returns a unified shape so the
 * tenant UI can render and pick from a mixed list. Caller can scope to
 * 'custom', 'platform', or 'both' (default).
 */
export async function searchWarehouseCatalog(
    { query, source = 'both', limit = 50 }: { query: string; source?: 'custom' | 'platform' | 'both'; limit?: number }
): Promise<WarehouseCatalogSearchResult[]> {
    const q = (query || '').trim();
    if (!q) return [];
    const safe = q.replace(/[\\%_]/g, (m) => '\\' + m);
    const cap = Math.min(Math.max(limit, 1), 200);

    const results: WarehouseCatalogSearchResult[] = [];

    // Custom (tenant) rows.
    if (source === 'custom' || source === 'both') {
        const { data, error } = await supabase.from('warehouse_catalog')
            .select('id, name, category, quality_label, unit, archived_at')
            
            .ilike('name', `%${safe}%`)
            .order('name', { ascending: true })
            .limit(cap);
        if (error && error.code !== '42P01') {
            handleSupabaseError({ error, message: 'Failed to search warehouse custom catalog' });
        }
        for (const r of (data || [])) {
            results.push({
                id: r.id,
                source: 'custom',
                name: r.name,
                category: r.category ?? null,
                qualityLabel: r.quality_label ?? null,
                unit: r.unit ?? null,
                archived: !!r.archived_at,
            });
        }
    }

    // Platform rows.
    if (source === 'platform' || source === 'both') {
        const { data, error } = await supabase.from('warehouse_platform_commodities')
            .select('id, name, kind')
            .ilike('name', `%${safe}%`)
            .order('name', { ascending: true })
            .limit(cap);
        if (error && error.code !== '42P01') {
            handleSupabaseError({ error, message: 'Failed to search warehouse platform catalog' });
        }
        for (const r of (data || [])) {
            results.push({
                id: r.id,
                source: 'platform',
                name: r.name,
                category: r.kind ?? null,
                qualityLabel: null,
                unit: null,
                archived: false,
            });
        }
    }

    // Deterministic order: custom first (tenant's own data takes precedence),
    // then platform, both alphabetic by name.
    results.sort((a, b) => {
        if (a.source !== b.source) return a.source === 'custom' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    // Total cap across both lists.
    return results.slice(0, cap);
}

export interface WarehouseCatalogInput {
    name: string;
    category: WarehouseCatalogCategory;
    qualityLabel?: string | null;
    unit?: string;
    description?: string | null;
}

export async function createWarehouseCatalogItem(input: WarehouseCatalogInput): Promise<WarehouseCatalogItem> {
    const name = (input.name || '').trim();
    if (!name) throw new Error('Commodity name is required.');
    const { data, error } = await supabase.from('warehouse_catalog')
        .insert({
            name,
            category: input.category,
            quality_label: input.qualityLabel?.trim() || null,
            unit: (input.unit || 'units').trim() || 'units',
            description: input.description?.trim() || null,
        })
        .select('id, name, category, quality_label, unit, description, archived_at, created_at, updated_at')
        .single();
    handleSupabaseError({ error, message: 'Failed to create warehouse catalog item' });
    if (!data) throw new Error('Failed to create warehouse catalog item');
    broadcastToOrg('warehouse:catalog_update', { catalogId: data.id });
    return toCatalogItem(data);
}

export interface WarehouseCatalogUpdateInput extends Partial<WarehouseCatalogInput> {
    id: number;
}

export async function updateWarehouseCatalogItem(input: WarehouseCatalogUpdateInput): Promise<WarehouseCatalogItem> {
    const patch: Partial<Tables<'warehouse_catalog'>> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.category !== undefined) patch.category = input.category;
    if (input.qualityLabel !== undefined) patch.quality_label = input.qualityLabel?.trim() || null;
    if (input.unit !== undefined) patch.unit = (input.unit || 'units').trim() || 'units';
    if (input.description !== undefined) patch.description = input.description?.trim() || null;
    const { data, error } = await supabase.from('warehouse_catalog')
        .update(patch)
        .eq('id', input.id)

        .select('id, name, category, quality_label, unit, description, archived_at, created_at, updated_at')
        .single();
    handleSupabaseError({ error, message: 'Failed to update warehouse catalog item' });
    if (!data) throw new Error('Failed to update warehouse catalog item');
    broadcastToOrg('warehouse:catalog_update', { catalogId: input.id });
    return toCatalogItem(data);
}

export async function archiveWarehouseCatalogItem(id: number, archive: boolean = true): Promise<void> {
    const { error } = await supabase.from('warehouse_catalog')
        .update({ archived_at: archive ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to archive warehouse catalog item' });
    broadcastToOrg('warehouse:catalog_update', { catalogId: id });
}

export async function deleteWarehouseCatalogItem(id: number): Promise<void> {
    // FKs cascade in stages: warehouse_movements/warehouse_requests reference
    // warehouse_stock with ON DELETE RESTRICT, and warehouse_stock references
    // warehouse_catalog with ON DELETE RESTRICT. Marketplace listing/contract
    // references to stock are ON DELETE SET NULL, so they auto-detach.
    // Delete bottom-up, scoped by organization_id for tenant safety.
    const { data: stockRows, error: stockListError } = await supabase.from('warehouse_stock')
        .select('id')
        
        .eq('catalog_id', id);
    handleSupabaseError({ error: stockListError, message: 'Failed to load commodity stock' });
    const stockIds = (stockRows || []).map((r: { id: number }) => r.id);

    if (stockIds.length > 0) {
        const { error: reqError } = await supabase.from('warehouse_requests')
            .delete()
            
            .in('stock_id', stockIds);
        handleSupabaseError({ error: reqError, message: 'Failed to delete commodity withdrawal requests' });

        const { error: movError } = await supabase.from('warehouse_movements')
            .delete()
            
            .in('stock_id', stockIds);
        handleSupabaseError({ error: movError, message: 'Failed to delete commodity movements' });

        const { error: stockError } = await supabase.from('warehouse_stock')
            .delete()
            
            .in('id', stockIds);
        handleSupabaseError({ error: stockError, message: 'Failed to delete commodity stock' });
    }

    const { error } = await supabase.from('warehouse_catalog')
        .delete()
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to delete warehouse catalog item' });
    broadcastToOrg('warehouse:catalog_update', { catalogId: id });
    // The cascade above also removed stock + request rows; emit their slice
    // events too so remote clients (which refetch per-slice, not the whole
    // warehouse bundle) don't keep phantom rows until a full refresh.
    if (stockIds.length > 0) {
        broadcastToOrg('warehouse:stock_update', {});
        broadcastToOrg('warehouse:request_update', {});
    }
}

// ---------------------------------------------------------------------------
// Catalog import/export (JSON, round-trippable, paginated)
// ---------------------------------------------------------------------------
//
// Catalog imports run as a client-driven offset/limit loop so a 5000-row
// import can show a progress bar and survive being cancelled mid-flight.
// `bulkUpsertWarehouseCatalog` processes one slice per call; the client loops
// until `nextOffset === null`. Server clamps `limit` to
// MAX_WAREHOUSE_IMPORT_BATCH_SIZE upstream regardless of what the client asks.
//
// Catalog exports paginate the same way — the client loops, accumulating
// pages into an in-memory array and writing one Blob at the end. The first
// page returns the export envelope metadata (version, exportedAt) so the
// client doesn't need a separate "info" call.

const VALID_CATEGORIES: ReadonlyArray<WarehouseCatalogCategory> =
    ['ore', 'refined', 'fuel', 'rmc', 'munition', 'consumable', 'misc'];

export const MAX_WAREHOUSE_IMPORT_BATCH_SIZE = 100;

export interface WarehouseCatalogExportItem {
    name: string;
    category: WarehouseCatalogCategory;
    qualityLabel: string | null;
    unit: string;
    description: string | null;
    archived: boolean;
}

export interface WarehouseCatalogExport {
    version: 1;
    exportedAt: string;
    items: WarehouseCatalogExportItem[];
}

export interface WarehouseCatalogExportPage {
    items: WarehouseCatalogExportItem[];
    total: number;
    nextOffset: number | null;
    /** Present only on the first page (offset === 0). */
    filename?: string;
    /** Present only on the first page. */
    version?: 1;
    /** Present only on the first page. */
    exportedAt?: string;
}

export async function exportWarehouseCatalog(
    opts: { offset?: number; limit?: number } = {},
): Promise<WarehouseCatalogExportPage> {
    const safeLimit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const safeOffset = Math.max(opts.offset ?? 0, 0);

    const total = await listWarehouseCatalogCount();
    const items = await listWarehouseCatalog({ offset: safeOffset, limit: safeLimit });
    const exportItems: WarehouseCatalogExportItem[] = items.map((c) => ({
        name: c.name,
        category: c.category,
        qualityLabel: c.qualityLabel,
        unit: c.unit,
        description: c.description,
        archived: !!c.archivedAt,
    }));

    const consumedThroughEnd = safeOffset + exportItems.length;
    const nextOffset = consumedThroughEnd < total && exportItems.length > 0 ? consumedThroughEnd : null;

    const page: WarehouseCatalogExportPage = {
        items: exportItems,
        total,
        nextOffset,
    };
    if (safeOffset === 0) {
        const date = new Date().toISOString().slice(0, 10);
        page.filename = `warehouse-catalog-${date}.json`;
        page.version = 1;
        page.exportedAt = new Date().toISOString();
    }
    return page;
}

export interface WarehouseCatalogImportItem {
    name: string;
    category: WarehouseCatalogCategory;
    qualityLabel: string | null;
    unit: string;
    description: string | null;
    archived: boolean;
}

export interface WarehouseCatalogImportPreview {
    newCount: number;
    updateCount: number;
    skipCount: number;
    conflicts: Array<{
        name: string;
        qualityLabel: string | null;
        changes: Record<string, { from: unknown; to: unknown }>;
    }>;
    invalid: Array<{ index: number; name?: string; reason: string }>;
    total: number;
}

export interface WarehouseCatalogImportProgress {
    processed: number;
    total: number;
    nextOffset: number | null;
    inserted: number;
    updated: number;
    errors: Array<{ index: number; name?: string; reason: string }>;
}

// Existing-catalog row shapes cached during import dedupe. Preview needs the
// full editable column set for diffing; the write path also caches freshly
// inserted rows that only carry the key columns.
type PreviewExistingRow = Pick<Tables<'warehouse_catalog'>, 'id' | 'name' | 'quality_label' | 'category' | 'unit' | 'description' | 'archived_at'>;
type ImportExistingRow = Pick<Tables<'warehouse_catalog'>, 'id' | 'name' | 'quality_label'> & Partial<Pick<Tables<'warehouse_catalog'>, 'category' | 'unit' | 'description' | 'archived_at'>>;

// Composite match key: (name, quality_label) — matches the
// uq_warehouse_catalog_org_name_quality unique index.
function catalogIndexKey(name: string, quality: string | null | undefined): string {
    return `${name.trim().toLowerCase()}|${(quality || '').trim().toLowerCase()}`;
}

// Validate + normalise a raw import row. Returns null with a reason on failure
// so the caller can collect it as an `invalid` entry without aborting.
function normalizeCatalogImportRow(raw: unknown): { item: WarehouseCatalogImportItem } | { reason: string; name?: string } {
    if (!raw || typeof raw !== 'object') return { reason: 'Row is not an object.' };
    const r = raw as Record<string, unknown>;
    // Strip markup + length-cap the client-supplied free-text so a CSV import
    // can't store HTML/control chars or multi-MB blobs in warehouse_catalog.
    const name = stripHtmlSingleLine(r.name, 200);
    if (!name) return { reason: 'Missing name.' };
    const category = r.category as WarehouseCatalogCategory;
    if (!VALID_CATEGORIES.includes(category)) {
        return { name, reason: `Invalid category "${r.category}". Expected one of: ${VALID_CATEGORIES.join(', ')}.` };
    }
    const qualityLabel = stripHtmlSingleLine(r.qualityLabel, 80) || null;
    const unit = stripHtmlSingleLine(r.unit, 40) || 'units';
    const description = stripHtml(r.description, 2000) || null;
    const archived = !!r.archived;
    return {
        item: { name, category, qualityLabel, unit, description, archived },
    };
}

// Diff editable fields between an existing DB row and an incoming item.
// Excludes name/quality_label — those are the match key, not editable here.
function diffCatalogRow(
    existing: Pick<Tables<'warehouse_catalog'>, 'category' | 'unit' | 'description' | 'archived_at'>,
    incoming: WarehouseCatalogImportItem,
): Record<string, { from: unknown; to: unknown }> {
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if ((existing.category ?? null) !== incoming.category) {
        changes.category = { from: existing.category ?? null, to: incoming.category };
    }
    if ((existing.unit ?? null) !== incoming.unit) {
        changes.unit = { from: existing.unit ?? null, to: incoming.unit };
    }
    if ((existing.description ?? null) !== (incoming.description ?? null)) {
        changes.description = { from: existing.description ?? null, to: incoming.description ?? null };
    }
    const existingArchived = !!existing.archived_at;
    if (existingArchived !== incoming.archived) {
        changes.archived = { from: existingArchived, to: incoming.archived };
    }
    return changes;
}

export async function previewWarehouseCatalogImport(
    items: unknown,
): Promise<WarehouseCatalogImportPreview> {
    if (!Array.isArray(items)) throw new Error('items must be an array.');

    const invalid: WarehouseCatalogImportPreview['invalid'] = [];
    const valid: WarehouseCatalogImportItem[] = [];
    const seen = new Set<string>();
    items.forEach((raw, i: number) => {
        const result = normalizeCatalogImportRow(raw);
        if ('reason' in result) {
            invalid.push({ index: i, name: result.name ?? (typeof raw?.name === 'string' ? raw.name : undefined), reason: result.reason });
            return;
        }
        const key = catalogIndexKey(result.item.name, result.item.qualityLabel);
        if (seen.has(key)) {
            invalid.push({ index: i, name: result.item.name, reason: 'Duplicate (name + quality) within import file.' });
            return;
        }
        seen.add(key);
        valid.push(result.item);
    });

    if (valid.length === 0) {
        return { newCount: 0, updateCount: 0, skipCount: 0, conflicts: [], invalid, total: items.length };
    }

    // Bulk-fetch only the names we care about — bounded by the file size, not
    // by the org's total catalog. Avoids the >1000-row dedupe bug that the
    // old implementation had.
    const names = Array.from(new Set(valid.map((v) => v.name)));
    const { data: existingRows, error } = await supabase
        .from('warehouse_catalog')
        .select('id, name, category, quality_label, unit, description, archived_at')
        
        .in('name', names);
    handleSupabaseError({ error, message: 'Failed to load existing warehouse catalog for import preview' });

    const existingByKey = new Map<string, PreviewExistingRow>();
    for (const row of existingRows || []) {
        existingByKey.set(catalogIndexKey(row.name, row.quality_label), row);
    }

    let newCount = 0;
    let updateCount = 0;
    let skipCount = 0;
    const conflicts: WarehouseCatalogImportPreview['conflicts'] = [];
    for (const item of valid) {
        const existing = existingByKey.get(catalogIndexKey(item.name, item.qualityLabel));
        if (!existing) {
            newCount += 1;
            continue;
        }
        const changes = diffCatalogRow(existing, item);
        if (Object.keys(changes).length === 0) {
            skipCount += 1;
            continue;
        }
        updateCount += 1;
        conflicts.push({ name: item.name, qualityLabel: item.qualityLabel, changes });
    }

    return { newCount, updateCount, skipCount, conflicts, invalid, total: items.length };
}

export async function bulkUpsertWarehouseCatalog(
    items: unknown,
    { offset = 0, limit = MAX_WAREHOUSE_IMPORT_BATCH_SIZE }: { offset?: number; limit?: number } = {},
): Promise<WarehouseCatalogImportProgress> {
    if (!Array.isArray(items)) throw new Error('items must be an array.');

    const safeLimit = Math.max(1, Math.min(MAX_WAREHOUSE_IMPORT_BATCH_SIZE, Math.floor(limit) || MAX_WAREHOUSE_IMPORT_BATCH_SIZE));
    const safeOffset = Math.max(0, Math.floor(offset) || 0);
    const total = items.length;

    if (safeOffset >= total) {
        return { processed: total, total, nextOffset: null, inserted: 0, updated: 0, errors: [] };
    }

    const slice = items.slice(safeOffset, safeOffset + safeLimit);
    const errors: WarehouseCatalogImportProgress['errors'] = [];

    // Normalise the slice first; collect invalid rows in errors[] so the loop
    // below only touches DB for rows that should be written.
    type PreparedRow = { absoluteIndex: number; item: WarehouseCatalogImportItem };
    const prepared: PreparedRow[] = [];
    slice.forEach((raw, i: number) => {
        const absoluteIndex = safeOffset + i;
        const result = normalizeCatalogImportRow(raw);
        if ('reason' in result) {
            errors.push({ index: absoluteIndex, name: result.name ?? (typeof raw?.name === 'string' ? raw.name : undefined), reason: result.reason });
            return;
        }
        prepared.push({ absoluteIndex, item: result.item });
    });

    // Bulk-fetch only the existing rows that match this slice's names — bounded
    // by slice size, not by the org's total catalog. Fixes the historical
    // dedupe bug where >1000 catalog rows broke importWarehouseCatalog.
    const sliceNames = Array.from(new Set(prepared.map((p) => p.item.name)));
    const existingByKey = new Map<string, ImportExistingRow>();
    if (sliceNames.length > 0) {
        const { data: existingRows, error } = await supabase
            .from('warehouse_catalog')
            .select('id, name, category, quality_label, unit, description, archived_at')
            
            .in('name', sliceNames);
        if (error) throw error;
        for (const row of existingRows || []) {
            existingByKey.set(catalogIndexKey(row.name, row.quality_label), row);
        }
    }

    let inserted = 0;
    let updated = 0;
    for (const { absoluteIndex, item } of prepared) {
        try {
            const match = existingByKey.get(catalogIndexKey(item.name, item.qualityLabel));
            if (match) {
                const { error } = await supabase.from('warehouse_catalog')
                    .update({
                        category: item.category,
                        unit: item.unit,
                        description: item.description,
                        archived_at: item.archived ? (match.archived_at || new Date().toISOString()) : null,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', match.id)
                    ;
                if (error) {
                    errors.push({ index: absoluteIndex, name: item.name, reason: error.message });
                    continue;
                }
                updated += 1;
            } else {
                const { data, error } = await supabase.from('warehouse_catalog')
                    .insert({
                        name: item.name,
                        category: item.category,
                        quality_label: item.qualityLabel,
                        unit: item.unit,
                        description: item.description,
                        archived_at: item.archived ? new Date().toISOString() : null,
                    })
                    .select('id, name, quality_label')
                    .single();
                if (error) {
                    errors.push({ index: absoluteIndex, name: item.name, reason: error.message });
                    continue;
                }
                if (data) {
                    // Cache the inserted row so a later slice in the same upload
                    // referencing the same (name, quality) updates instead of
                    // double-inserting and tripping the unique index.
                    existingByKey.set(catalogIndexKey(data.name, data.quality_label), data);
                }
                inserted += 1;
            }
        } catch (err) {
            errors.push({ index: absoluteIndex, name: item.name, reason: err instanceof Error ? err.message : 'unknown error' });
        }
    }

    const consumedThroughEnd = safeOffset + slice.length;
    const nextOffset = consumedThroughEnd < total ? consumedThroughEnd : null;

    // Broadcast once on the final batch to avoid spamming realtime per slice.
    if (nextOffset === null && (inserted > 0 || updated > 0)) {
        broadcastToOrg('warehouse:catalog_update', { bulk: true });
    }

    return {
        processed: consumedThroughEnd,
        total,
        nextOffset,
        inserted,
        updated,
        errors,
    };
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

export interface ListWarehouseStockOptions {
    catalogId?: number | null;
    locationId?: number | null;
    /** Default 1000 (legacy behavior). Set lower for paginated UIs. */
    limit?: number;
    offset?: number;
}

export async function listWarehouseStock(
    opts: ListWarehouseStockOptions = {},
): Promise<WarehouseStock[]> {
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 1000);
    const offset = clampListOffset(opts.offset);
    let q = supabase.from('v_warehouse_stock_with_qty')
        .select(`
            id, catalog_id, location_id, notes, created_at, updated_at,
            quantity_on_hand, quantity_reserved,
            catalog:warehouse_catalog(id, name, category, quality_label, unit, description, archived_at, created_at, updated_at),
            location:quartermaster_locations(id, name, type)
        `)
        ;
    if (opts.catalogId != null) q = q.eq('catalog_id', opts.catalogId);
    if (opts.locationId != null) q = q.eq('location_id', opts.locationId);
    q = q.order('updated_at', { ascending: false }).range(offset, offset + limit - 1);
    const { data, error } = await q;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load warehouse stock' });
    return ((data || []) as unknown as StockRow[]).map(toStock);
}

export async function listWarehouseStockCount(
    opts: ListWarehouseStockOptions = {},
): Promise<number> {
    let q = supabase.from('warehouse_stock').select('id', { count: 'exact', head: true });
    if (opts.catalogId != null) q = q.eq('catalog_id', opts.catalogId);
    if (opts.locationId != null) q = q.eq('location_id', opts.locationId);
    const { count, error } = await q;
    if (error && error.code === '42P01') return 0;
    handleSupabaseError({ error, message: 'Failed to count warehouse stock' });
    return count ?? 0;
}

export interface WarehouseStockInput {
    catalogId: number;
    locationId: number;
    notes?: string | null;
    /** When 'platform', catalogId references warehouse_platform_commodities and
     *  is materialised into a tenant warehouse_catalog row before the stock row
     *  is created. Defaults to 'custom'. */
    source?: 'custom' | 'platform';
    /** Optional quality label to stamp on the auto-created catalog row when
     *  source='platform'. Ignored when source='custom' (the picked catalog row
     *  already carries its own quality). */
    qualityLabel?: string | null;
}

/**
 * Materialise a platform commodity into the tenant warehouse_catalog so the
 * stock row's catalog_id FK is satisfied. Idempotent — if a custom row with
 * the same (name, quality_label) already exists for this org, reuses it
 * instead of inserting.
 */
async function ensureCatalogFromPlatformCommodity(
    platformCommodityId: number,
    qualityLabel: string | null,
): Promise<number> {
    const { data: pc, error: pcErr } = await supabase
        .from('warehouse_platform_commodities')
        .select('id, name, is_fuel, is_refined, is_extractable, is_raw, is_mineral')
        .eq('id', platformCommodityId)
        .maybeSingle();
    handleSupabaseError({ error: pcErr, message: 'Failed to look up platform commodity' });
    if (!pc) throw new Error('Platform commodity not found.');

    const name = (pc.name || '').trim();
    if (!name) throw new Error('Platform commodity has no name.');

    // The (organization_id, name, COALESCE(quality_label, '')) unique index lets
    // us reuse a matching row instead of inserting a duplicate.
    const lookup = supabase
        .from('warehouse_catalog')
        .select('id')
        
        .eq('name', name);
    const { data: existing, error: lookupErr } = await (
        qualityLabel ? lookup.eq('quality_label', qualityLabel) : lookup.is('quality_label', null)
    ).maybeSingle();
    handleSupabaseError({ error: lookupErr, message: 'Failed to look up existing catalog row' });
    if (existing) return existing.id;

    const category: WarehouseCatalogCategory =
        pc.is_fuel ? 'fuel'
        : pc.is_refined ? 'refined'
        : (pc.is_extractable || pc.is_raw || pc.is_mineral) ? 'ore'
        : 'misc';

    const { data: created, error: insErr } = await supabase
        .from('warehouse_catalog')
        .insert({
            name,
            category,
            quality_label: qualityLabel,
            unit: 'SCU',
            description: null,
        })
        .select('id')
        .single();
    handleSupabaseError({ error: insErr, message: 'Failed to materialise platform commodity into catalog' });
    broadcastToOrg('warehouse:catalog_update', { catalogId: created?.id });
    return created!.id;
}

export async function createWarehouseStock(input: WarehouseStockInput): Promise<WarehouseStock> {
    const catalogId = input.source === 'platform'
        ? await ensureCatalogFromPlatformCommodity(input.catalogId, input.qualityLabel?.trim() || null)
        : input.catalogId;

    const { data, error } = await supabase.from('warehouse_stock')
        .insert({
            catalog_id: catalogId,
            location_id: input.locationId,
            notes: input.notes?.trim() || null,
        })
        .select(`
            id, catalog_id, location_id, notes, created_at, updated_at,
            catalog:warehouse_catalog(id, name, category, quality_label, unit, description, archived_at, created_at, updated_at),
            location:quartermaster_locations(id, name, type)
        `)
        .single();
    handleSupabaseError({ error, message: 'Failed to create warehouse stock' });
    broadcastToOrg('warehouse:stock_update', { stockId: data?.id });
    return toStock({ ...data, quantity_on_hand: 0, quantity_reserved: 0 } as unknown as StockRow);
}

/**
 * Hard-delete a stock row, its movement ledger, and any historical withdrawal
 * requests. Refuses to delete while the row has reserved quantity (open
 * withdrawals or open marketplace contracts) — the caller should resolve those
 * first. Marketplace listing/contract FKs to warehouse_stock are ON DELETE SET
 * NULL so historical contracts stay intact, just unlinked.
 */
export async function deleteWarehouseStock(stockId: number): Promise<void> {
    const { data: stockRow, error: lookupErr } = await supabase
        .from('warehouse_stock')
        .select('id')
        .eq('id', stockId)
        
        .maybeSingle();
    handleSupabaseError({ error: lookupErr, message: 'Failed to validate stock row' });
    if (!stockRow) throw new Error('Stock row not found in this organization.');

    const { data: qtyRow, error: qtyErr } = await supabase
        .from('v_warehouse_stock_with_qty')
        .select('quantity_reserved')
        .eq('id', stockId)
        
        .maybeSingle();
    handleSupabaseError({ error: qtyErr, message: 'Failed to read stock reservations' });
    const reserved = Number(qtyRow?.quantity_reserved) || 0;
    if (reserved > 0) {
        throw new Error(`Cannot delete: ${reserved} unit(s) are reserved by open withdrawals or marketplace contracts. Resolve those first.`);
    }

    const { error: reqError } = await supabase.from('warehouse_requests')
        .delete()
        
        .eq('stock_id', stockId);
    handleSupabaseError({ error: reqError, message: 'Failed to delete withdrawal requests' });

    const { error: movError } = await supabase.from('warehouse_movements')
        .delete()
        
        .eq('stock_id', stockId);
    handleSupabaseError({ error: movError, message: 'Failed to delete movement ledger' });

    const { error } = await supabase.from('warehouse_stock')
        .delete()
        .eq('id', stockId)
        ;
    handleSupabaseError({ error, message: 'Failed to delete warehouse stock' });
    broadcastToOrg('warehouse:stock_update', { stockId });
    // Request rows for this stock were cascade-deleted above — emit the
    // request slice event too so per-slice refetching clients drop them.
    broadcastToOrg('warehouse:request_update', {});
}

export async function adjustWarehouseStock(
    stockId: number,
    delta: number,
    reason: WarehouseMovementReason,
    actorUserId: number,
    notes?: string | null,
): Promise<string> {
    if (!Number.isFinite(delta) || delta === 0) throw new Error('Delta must be a non-zero integer.');
    const allowed: WarehouseMovementReason[] = ['initial', 'adjust', 'restock', 'loss', 'destruction'];
    if (!allowed.includes(reason)) throw new Error(`Invalid adjustment reason: ${reason}`);

    // Existence guard before calling the proc.
    const { data: row, error: lookupErr } = await supabase.from('warehouse_stock')
        .select('id')
        .eq('id', stockId)

        .maybeSingle();
    handleSupabaseError({ error: lookupErr, message: 'Failed to validate stock row' });
    if (!row) throw new Error('Stock row not found.');

    const { data, error } = await supabase.rpc('warehouse_adjust_stock', {
        p_stock_id: stockId,
        p_delta: Math.trunc(delta),
        p_reason: reason,
        p_actor_id: actorUserId,
        p_notes: notes?.trim() || null,
    });
    handleSupabaseError({ error, message: 'Failed to adjust warehouse stock' });
    broadcastToOrg('warehouse:stock_update', { stockId });
    return data as string;
}

export async function transferWarehouseStock(
    fromStockId: number,
    toStockId: number,
    quantity: number,
    actorUserId: number,
    notes?: string | null,
): Promise<string> {
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Quantity must be positive.');

    // Existence guard on both stocks.
    const { data: rows, error: lookupErr } = await supabase.from('warehouse_stock')
        .select('id')
        .in('id', [fromStockId, toStockId])
        ;
    handleSupabaseError({ error: lookupErr, message: 'Failed to validate transfer endpoints' });
    if (!rows || rows.length !== 2) throw new Error('One or both stock rows not found.');

    const { data, error } = await supabase.rpc('warehouse_transfer_stock', {
        p_from_stock_id: fromStockId,
        p_to_stock_id: toStockId,
        p_quantity: Math.trunc(quantity),
        p_actor_id: actorUserId,
        p_notes: notes?.trim() || null,
    });
    handleSupabaseError({ error, message: 'Failed to transfer warehouse stock' });
    broadcastToOrg('warehouse:stock_update', {});
    return data as string;
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

export interface MovementFilters {
    stockId?: number;
    reason?: WarehouseMovementReason;
    actorUserId?: number;
    sinceIso?: string;
    untilIso?: string;
    limit?: number;
    offset?: number;
}

export async function listWarehouseMovements(filters: MovementFilters = {}): Promise<WarehouseMovement[]> {
    // Embed the joined stock row (catalog + location) on each movement so the
    // movements tab no longer has to read warehouseStock from DataContext just
    // to resolve stockId → name/quality/location.
    let q = supabase.from('warehouse_movements')
        .select(`
            id, stock_id, delta, reason, actor_user_id, related_request_id, related_movement_id, notes, created_at,
            actor:users!warehouse_movements_actor_user_id_fkey(id, name, avatar_url),
            stock:warehouse_stock(
                id, catalog_id, location_id,
                catalog:warehouse_catalog(id, name, category, quality_label, unit),
                location:quartermaster_locations(id, name, type)
            )
        `)
        
        .order('created_at', { ascending: false });

    if (filters.stockId != null) q = q.eq('stock_id', filters.stockId);
    if (filters.reason) q = q.eq('reason', filters.reason);
    if (filters.actorUserId != null) q = q.eq('actor_user_id', filters.actorUserId);
    if (filters.sinceIso) q = q.gte('created_at', filters.sinceIso);
    if (filters.untilIso) q = q.lte('created_at', filters.untilIso);
    // Clamp the client-supplied limit like the sibling list fns — a
    // warehouse:view member could otherwise request a huge embedded-join page.
    const moveLimit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
    const moveOffset = clampListOffset(filters.offset);
    q = q.range(moveOffset, moveOffset + moveLimit - 1);

    const { data, error } = await q;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load warehouse movements' });
    return ((data || []) as unknown as MovementRow[]).map(toMovement);
}

// ---------------------------------------------------------------------------
// Withdrawal requests
// ---------------------------------------------------------------------------

export interface WithdrawalRequestInput {
    stockId: number;
    requestedQuantity: number;
    reasonCategory: WarehouseReasonCategory;
    reasonNotes?: string | null;
}

export async function createWithdrawalRequest(
    requesterUserId: number,
    input: WithdrawalRequestInput,
): Promise<WarehouseRequest> {
    if (!Number.isFinite(input.requestedQuantity) || input.requestedQuantity <= 0) {
        throw new Error('Requested quantity must be positive.');
    }
    const requestedQuantity = Math.trunc(input.requestedQuantity);
    const allowed: WarehouseReasonCategory[] = ['sale', 'craft', 'transport', 'other'];
    if (!allowed.includes(input.reasonCategory)) throw new Error(`Invalid reason category: ${input.reasonCategory}`);

    // A pending/approved request's requested_quantity feeds the view-computed
    // v_warehouse_stock_with_qty.quantity_reserved (schema.sql), which is
    // consumed server-side — deleteWarehouseStock() refuses to delete while
    // reserved > 0, and managers see available = on_hand − reserved. An
    // unbounded requestedQuantity would therefore let any warehouse:request
    // holder pin ANY stock row against deletion and drive its availability
    // negative (and could overflow the view's integer SUM). Bound the new
    // reservation by AVAILABILITY (on_hand − already-reserved), not raw on_hand:
    // otherwise N rate-limited requests could each individually pass an on-hand
    // check yet inflate aggregate quantity_reserved well beyond what physically
    // exists. Read both figures from the same explicit-column qty view BEFORE the
    // insert and reject a non-existent stock id explicitly (don't rely on the FK).
    const { data: stockQty, error: stockErr } = await supabase
        .from('v_warehouse_stock_with_qty')
        .select('id, quantity_on_hand, quantity_reserved')
        .eq('id', input.stockId)
        .maybeSingle();
    handleSupabaseError({ error: stockErr, message: 'Failed to validate stock row' });
    if (!stockQty) throw new Error('Stock row not found.');
    const onHand = Number(stockQty.quantity_on_hand) || 0;
    const reserved = Number(stockQty.quantity_reserved) || 0;
    const available = onHand - reserved;
    if (requestedQuantity > available) {
        // Keep the plain "only N on hand" wording when nothing is reserved yet
        // (the availability ceiling reduces to on-hand); surface the breakdown
        // only once existing reservations are what's constraining the request.
        throw new Error(
            reserved > 0
                ? `Cannot reserve ${requestedQuantity} unit(s): only ${available} available (${onHand} on hand, ${reserved} already reserved).`
                : `Cannot reserve ${requestedQuantity} unit(s): only ${onHand} on hand.`,
        );
    }

    const { data, error } = await supabase.from('warehouse_requests')
        .insert({
            stock_id: input.stockId,
            requested_by_user_id: requesterUserId,
            requested_quantity: requestedQuantity,
            reason_category: input.reasonCategory,
            reason_notes: input.reasonNotes?.trim() || null,
        })
        .select(`
            id, stock_id, requested_by_user_id, requested_quantity, reason_category, reason_notes, status, approved_by_user_id, approved_at, fulfilled_movement_id, fulfilled_at, denial_reason, created_at, updated_at,
            requested_by:users!warehouse_requests_requested_by_user_id_fkey(id, name, avatar_url)
        `)
        .single();
    handleSupabaseError({ error, message: 'Failed to submit withdrawal request' });
    if (!data) throw new Error('Failed to submit withdrawal request');
    broadcastToOrg('warehouse:request_update', { requestId: data.id });
    // A new pending request raises the stock row's view-computed
    // quantity_reserved — emit the stock slice event so remote clients
    // (which refetch per-slice) see the new Reserved count.
    broadcastToOrg('warehouse:stock_update', {});
    return toRequest(data as unknown as RequestRow);
}

export interface RequestFilters {
    status?: WarehouseRequestStatus | 'open';
    requesterUserId?: number;
    stockId?: number;
    limit?: number;
}

export async function listWithdrawalRequests(filters: RequestFilters = {}): Promise<WarehouseRequest[]> {
    // Embed the joined stock row (catalog + location) on each request so the
    // withdrawals tab no longer has to read warehouseStock from DataContext
    // to render a request card. The computed quantity_on_hand isn't available
    // through PostgREST's FK-embed mechanism (the view lacks an FK comment),
    // so we hydrate it in a follow-up bulk query against the qty view.
    let q = supabase.from('warehouse_requests')
        .select(`
            id, stock_id, requested_by_user_id, requested_quantity, reason_category, reason_notes, status, approved_by_user_id, approved_at, fulfilled_movement_id, fulfilled_at, denial_reason, created_at, updated_at,
            requested_by:users!warehouse_requests_requested_by_user_id_fkey(id, name, avatar_url),
            stock:warehouse_stock!warehouse_requests_stock_id_fkey(
                id, catalog_id, location_id,
                catalog:warehouse_catalog(id, name, category, quality_label, unit),
                location:quartermaster_locations(id, name, type)
            )
        `)
        
        .order('created_at', { ascending: false });

    if (filters.status === 'open') {
        q = q.in('status', ['pending', 'approved']);
    } else if (filters.status) {
        q = q.eq('status', filters.status);
    }
    if (filters.requesterUserId != null) q = q.eq('requested_by_user_id', filters.requesterUserId);
    if (filters.stockId != null) q = q.eq('stock_id', filters.stockId);
    // Apply the clamped default UNCONDITIONALLY — an absent limit must not return
    // all rows unbounded (sibling fns clamp to 500).
    q = q.limit(Math.min(Math.max(filters.limit ?? 200, 1), 500));

    const { data, error } = await q;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load withdrawal requests' });
    const rows = ((data || []) as unknown as RequestRow[]).map(toRequest);
    if (rows.length === 0) return rows;

    // Hydrate quantity_on_hand for the unique stocks involved.
    const stockIds = Array.from(new Set(rows.map((r) => r.stockId)));
    const { data: qtyRows } = await supabase
        .from('v_warehouse_stock_with_qty')
        .select('id, quantity_on_hand')
        
        .in('id', stockIds);
    const qtyById = new Map<number, number>();
    for (const q of (qtyRows || [])) qtyById.set(q.id, Number(q.quantity_on_hand) || 0);
    for (const r of rows) {
        if (r.stock) r.stock.quantityOnHand = qtyById.get(r.stockId) ?? 0;
    }
    return rows;
}

export async function approveWithdrawalRequest(requestId: string, actorUserId: number): Promise<void> {
    const { error } = await supabase.from('warehouse_requests')
        .update({
            status: 'approved',
            approved_by_user_id: actorUserId,
            approved_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq('id', requestId)
        
        .eq('status', 'pending');
    handleSupabaseError({ error, message: 'Failed to approve withdrawal request' });
    broadcastToOrg('warehouse:request_update', { requestId });
}

export async function denyWithdrawalRequest(requestId: string, actorUserId: number, denialReason?: string | null): Promise<void> {
    const { error } = await supabase.from('warehouse_requests')
        .update({
            status: 'denied',
            approved_by_user_id: actorUserId,
            approved_at: new Date().toISOString(),
            denial_reason: denialReason?.trim() || null,
            updated_at: new Date().toISOString(),
        })
        .eq('id', requestId)
        
        .in('status', ['pending', 'approved']);
    handleSupabaseError({ error, message: 'Failed to deny withdrawal request' });
    broadcastToOrg('warehouse:request_update', { requestId });
    // pending/approved → denied releases the view-computed reservation.
    broadcastToOrg('warehouse:stock_update', {});
}

export async function cancelWithdrawalRequest(requestId: string, requesterUserId: number): Promise<void> {
    const { error } = await supabase.from('warehouse_requests')
        .update({
            status: 'cancelled',
            updated_at: new Date().toISOString(),
        })
        .eq('id', requestId)
        
        .eq('requested_by_user_id', requesterUserId)
        .in('status', ['pending', 'approved']);
    handleSupabaseError({ error, message: 'Failed to cancel withdrawal request' });
    broadcastToOrg('warehouse:request_update', { requestId });
    // pending/approved → cancelled releases the view-computed reservation.
    broadcastToOrg('warehouse:stock_update', {});
}

export async function fulfilWithdrawalRequest(requestId: string, actorUserId: number): Promise<string> {
    // Tenant-scope guard before calling the proc.
    const { data: row, error: lookupErr } = await supabase.from('warehouse_requests')
        .select('id')
        .eq('id', requestId)
        
        .maybeSingle();
    handleSupabaseError({ error: lookupErr, message: 'Failed to validate request' });
    if (!row) throw new Error('Request not found in this organization.');

    const { data, error } = await supabase.rpc('warehouse_fulfil_request', {
        p_request_id: requestId,
        p_actor_id: actorUserId,
    });
    handleSupabaseError({ error, message: 'Failed to fulfil withdrawal request' });
    broadcastToOrg('warehouse:request_update', { requestId });
    broadcastToOrg('warehouse:stock_update', {});
    return data as string;
}

// ---------------------------------------------------------------------------
// Overview + CSV export
// ---------------------------------------------------------------------------

export async function getWarehouseOverview(): Promise<WarehouseOverview> {
    // Single SQL aggregate — no longer fetches every stock row + every open
    // request just to compute SUMs. ~5 numbers vs potentially hundreds of KB.
    const { data, error } = await supabase.rpc('warehouse_overview_stats', {});
    handleSupabaseError({ error, message: 'Failed to load warehouse overview stats' });
    const row: Record<string, unknown> = (data && data[0]) || {};
    return {
        totalStocks: Number(row.total_stocks ?? 0),
        totalOnHand: Number(row.total_on_hand ?? 0),
        totalReserved: Number(row.total_reserved ?? 0),
        lowStockCount: Number(row.low_stock_count ?? 0),
        openRequestCount: Number(row.open_request_count ?? 0),
    };
}

export interface WarehouseStockExportRow {
    commodity: string;
    quality: string;
    category: string;
    unit: string;
    location: string;
    onHand: number;
    reserved: number;
    notes: string;
}

export interface WarehouseStockExportPage {
    rows: WarehouseStockExportRow[];
    total: number;
    nextOffset: number | null;
    /** Present only on the first page (offset === 0). */
    filename?: string;
}

// Spreadsheet formula-injection neutralization for CSV-export-only string
// fields. A cell beginning with = + - @ (or a leading TAB/CR that some apps
// strip before evaluating the next char) is auto-evaluated as a formula by
// Excel/LibreOffice/Sheets, so an operator who merely opens the export executes
// the payload. The warehouse stock export ships operator-controlled
// commodity/quality/category/unit/location/notes to the client, which assembles
// the CSV (WhStockTab.handleStartCsvExport), so neutralize at this output
// boundary by prefixing a literal-text apostrophe (mirrors the formula branch of
// lib/db/finances.csvEscape). We deliberately prepend ONLY the marker here and
// do NOT RFC-4180 quote-wrap — the client assembler already quote-wraps, so
// wrapping here would double-wrap benign delimiter-bearing values.
function neutralizeCsvFormula(value: string): string {
    return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

// Stock CSV export, paginated. Returns raw row objects so the client can
// assemble the CSV in one Blob at the end of the loop — avoids re-streaming
// the header on every page and avoids the server holding an unbounded string
// in memory.
export async function exportWarehouseCsv(
    opts: { offset?: number; limit?: number } = {},
): Promise<WarehouseStockExportPage> {
    const safeLimit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const safeOffset = Math.max(opts.offset ?? 0, 0);

    const total = await listWarehouseStockCount();
    const stocks = await listWarehouseStock({ offset: safeOffset, limit: safeLimit });

    const rows: WarehouseStockExportRow[] = stocks.map((s) => ({
        commodity: neutralizeCsvFormula(s.catalog?.name ?? ''),
        quality: neutralizeCsvFormula(s.catalog?.qualityLabel ?? ''),
        category: neutralizeCsvFormula(s.catalog?.category ?? ''),
        unit: neutralizeCsvFormula(s.catalog?.unit ?? ''),
        location: neutralizeCsvFormula(s.location?.name ?? ''),
        onHand: s.quantityOnHand,
        reserved: s.quantityReserved,
        notes: neutralizeCsvFormula(s.notes ?? ''),
    }));

    const consumedThroughEnd = safeOffset + rows.length;
    const nextOffset = consumedThroughEnd < total && rows.length > 0 ? consumedThroughEnd : null;

    const page: WarehouseStockExportPage = { rows, total, nextOffset };
    if (safeOffset === 0) {
        const date = new Date().toISOString().slice(0, 10);
        page.filename = `warehouse-${date}.csv`;
    }
    return page;
}

// ===========================================================================
// PLATFORM COMMODITY CATALOG (UEX-sourced, platform-admin only)
// ===========================================================================
// Separate from the org's warehouse_catalog. Lives in warehouse_platform_commodities
// (the shared reference commodity catalog). Managed via the catalog:* admin actions
// (api/actions/catalog.ts); the org catalog code (listWarehouseCatalog etc.) is untouched.

export async function listPlatformCommodityCategories(): Promise<WarehousePlatformCategory[]> {
    const { data, error } = await supabase.from('warehouse_platform_categories')
        .select('id, slug, uex_kind, display_name, sort_order, is_hidden, created_at, updated_at')
        .order('sort_order', { ascending: true })
        .order('display_name', { ascending: true });
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load warehouse platform categories' });
    return (data || []).map(toWarehousePlatformCategory);
}

export async function updatePlatformCommodityCategory(id: number, patch: Partial<Tables<'warehouse_platform_categories'>>) {
    if (!Object.keys(patch).length) throw new Error('No updatable fields provided');
    patch.updated_at = new Date().toISOString();
    const { error } = await supabase.from('warehouse_platform_categories')
        .update(patch)
        .eq('id', id);
    handleSupabaseError({ error, message: 'Failed to update warehouse platform category' });
}

export async function deletePlatformCommodityCategory(id: number) {
    const { count } = await supabase.from('warehouse_platform_commodities')
        .select('id', { count: 'exact', head: true })
        .eq('platform_category_id', id);
    if (count && count > 0) {
        throw new Error(`Cannot delete: ${count} commodity row(s) reference this category. Reassign first.`);
    }
    const { error } = await supabase.from('warehouse_platform_categories')
        .delete()
        .eq('id', id);
    handleSupabaseError({ error, message: 'Failed to delete warehouse platform category' });
}

export interface ListPlatformCommoditiesOptions {
    search?: string;
    platformCategoryId?: number | null;
    illegalOnly?: boolean;
    legalOnly?: boolean;
    limit?: number;
    offset?: number;
}

export async function getPlatformCommodityCatalog(opts: ListPlatformCommoditiesOptions = {}): Promise<WarehousePlatformCommodity[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = clampListOffset(opts.offset);
    let qb = supabase.from('warehouse_platform_commodities').select('id, external_id, external_uuid, slug, name, code, kind, weight_scu, price_buy, price_sell, is_available, is_available_live, is_visible, is_extractable, is_mineral, is_raw, is_pure, is_refined, is_refinable, is_harvestable, is_buyable, is_sellable, is_temporary, is_illegal, is_volatile_qt, is_volatile_time, is_inert, is_explosive, is_buggy, is_fuel, wiki_url, platform_category_id, uex_date_added, uex_date_modified, last_synced_at, created_at, updated_at');
    if (opts.search && opts.search.trim()) {
        const safe = safeSearchTerm(opts.search); // allow-list before .or()
        if (safe) qb = qb.or(`name.ilike.%${safe}%,kind.ilike.%${safe}%,code.ilike.%${safe}%`);
    }
    if (opts.platformCategoryId != null) qb = qb.eq('platform_category_id', opts.platformCategoryId);
    if (opts.illegalOnly) qb = qb.eq('is_illegal', true);
    if (opts.legalOnly) qb = qb.or('is_illegal.is.null,is_illegal.eq.false');
    qb = qb.order('name', { ascending: true }).range(offset, offset + limit - 1);
    const { data, error } = await qb;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load platform commodity catalog' });
    return (data || []).map(toWarehousePlatformCommodity);
}

/**
 * Returns platform commodities with usage counts. NOTE: tenant warehouse_stock
 * still references warehouse_catalog, NOT warehouse_platform_commodities, so
 * this count is always 0 today. When tenant-side wiring lands, stocks will be
 * able to point at platform rows and this count will become meaningful.
 */
export async function getPlatformCommodityCatalogWithUsage(opts: ListPlatformCommoditiesOptions = {}): Promise<WarehousePlatformCommodityWithUsage[]> {
    const rows = await getPlatformCommodityCatalog(opts);
    return rows.map(c => ({ ...c, usageCount: 0 }));
}

export async function getPlatformCommodityCatalogCount(opts: ListPlatformCommoditiesOptions = {}): Promise<number> {
    let qb = supabase.from('warehouse_platform_commodities').select('id', { count: 'exact', head: true });
    if (opts.search && opts.search.trim()) {
        const safe = safeSearchTerm(opts.search); // allow-list before .or()
        if (safe) qb = qb.or(`name.ilike.%${safe}%,kind.ilike.%${safe}%,code.ilike.%${safe}%`);
    }
    if (opts.platformCategoryId != null) qb = qb.eq('platform_category_id', opts.platformCategoryId);
    if (opts.illegalOnly) qb = qb.eq('is_illegal', true);
    if (opts.legalOnly) qb = qb.or('is_illegal.is.null,is_illegal.eq.false');
    const { count, error } = await qb;
    if (error && error.code === '42P01') return 0;
    handleSupabaseError({ error, message: 'Failed to count platform commodities' });
    return count ?? 0;
}

/**
 * Sync from UEX. Two-pass:
 *   1. Derive distinct kinds from the response and upsert into
 *      warehouse_platform_categories by slug. Admin display_name is preserved
 *      across re-syncs (we only set display_name on first insert).
 *   2. Upsert each commodity row by external_id (the UEX commodity id).
 */
export async function syncPlatformCommodityCatalog() {
    const commodities = await fetchUexCommodities();
    log.info('uex commodities fetched', { count: commodities.length });

    // Pass 1: categories
    const distinctKinds = new Map<string, string>();
    for (const c of commodities) {
        if (!c.kind) continue;
        const slug = slugify(c.kind);
        if (slug && !distinctKinds.has(slug)) distinctKinds.set(slug, c.kind);
    }

    const { data: existingCats } = await supabase.from('warehouse_platform_categories').select('id, slug, display_name');
    const existingBySlug = new Map<string, { id: number; display_name: string }>();
    for (const r of (existingCats || [])) {
        existingBySlug.set(r.slug, { id: r.id, display_name: r.display_name });
    }

    const catFkLookup = new Map<string, number>();
    let categoriesInserted = 0;
    let categoriesUpdated = 0;

    for (const [slug, kind] of distinctKinds) {
        const existing = existingBySlug.get(slug);
        if (existing) {
            // Refresh uex_kind only; preserve admin-edited display_name.
            const { error } = await supabase.from('warehouse_platform_categories')
                .update({ uex_kind: kind, updated_at: new Date().toISOString() })
                .eq('id', existing.id);
            if (!error) categoriesUpdated++;
            catFkLookup.set(slug, existing.id);
        } else {
            const { data, error } = await supabase.from('warehouse_platform_categories')
                .insert({ slug, uex_kind: kind, display_name: kind })
                .select('id')
                .single();
            if (!error && data) {
                catFkLookup.set(slug, data.id);
                categoriesInserted++;
            }
        }
    }

    // Pass 2: commodities (batched)
    const COMMODITY_BATCH_SIZE = 100;
    let updated = 0;
    let errors = 0;
    const rows = commodities.map(c => mapUexCommodityToWarehouseRow(c, catFkLookup));
    const names = commodities.map(c => c.name || '?');

    for (let i = 0; i < rows.length; i += COMMODITY_BATCH_SIZE) {
        const batch = rows.slice(i, i + COMMODITY_BATCH_SIZE);
        const { error } = await supabase.from('warehouse_platform_commodities')
            .upsert(batch, { onConflict: 'external_id' });
        if (error) {
            // Fall back to per-row upserts on batch failure.
            for (let j = 0; j < batch.length; j++) {
                const { error: rowErr } = await supabase.from('warehouse_platform_commodities')
                    .upsert(batch[j], { onConflict: 'external_id' });
                if (rowErr) {
                    errors++;
                    if (errors <= 5) log.warn('uex commodity upsert failed', { name: names[i + j], reason: rowErr.message });
                } else {
                    updated++;
                }
            }
        } else {
            updated += batch.length;
        }
    }

    log.info('uex commodities sync done', { synced: updated, errors, categoriesInserted, categoriesUpdated });
    return {
        commoditiesSynced: updated,
        commodityErrors: errors,
        categoriesInserted,
        categoriesUpdated,
    };
}

const PLATFORM_COMMODITY_DELETE_REASON = 'Cannot delete: this is the platform catalog table; tenant warehouses do not reference it yet.';

// Identity/sync-key fields must not be admin-editable — overwriting external_id
// (the onConflict upsert key) would mis-key the next sync and create
// duplicate/orphan rows.
const COMMODITY_PROTECTED_FIELDS = new Set(['id', 'external_id', 'external_uuid', 'slug', 'created_at', 'last_synced_at']);

export async function updatePlatformCommodity(id: number, patch: Partial<Tables<'warehouse_platform_commodities'>>) {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (!COMMODITY_PROTECTED_FIELDS.has(k)) safe[k] = v;
    if (!Object.keys(safe).length) throw new Error('No updatable fields provided');
    safe.updated_at = new Date().toISOString();
    const { error } = await supabase.from('warehouse_platform_commodities')
        .update(safe)
        .eq('id', id);
    handleSupabaseError({ error, message: 'Failed to update platform commodity' });
}

export async function deletePlatformCommodity(id: number) {
    // Tenant warehouse_stock doesn't yet reference warehouse_platform_commodities,
    // so deletes are unconditionally safe today. When tenant wiring lands, add
    // a usage check here.
    void PLATFORM_COMMODITY_DELETE_REASON;
    const { error } = await supabase.from('warehouse_platform_commodities')
        .delete()
        .eq('id', id);
    handleSupabaseError({ error, message: 'Failed to delete platform commodity' });
}

export async function mergePlatformCommodities(keepId: number, deleteId: number) {
    if (keepId === deleteId) throw new Error('Cannot merge a commodity with itself');
    // No tenant references yet, so merge is just delete-the-loser.
    await deletePlatformCommodity(deleteId);
    return { merged: true };
}

export async function repairPlatformCommodityCatalogDuplicates() {
    // UEX commodities are keyed by external_id (UNIQUE constraint), so true
    // duplicates can only come from manual admin inserts. Find rows sharing
    // a slug and report them — don't auto-merge since we can't pick canonical.
    const { data } = await supabase.from('warehouse_platform_commodities')
        .select('id, slug, name, external_id');
    const bySlug = new Map<string, Array<{ id: number; name: string; external_id: number }>>();
    for (const r of (data || [])) {
        if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
        bySlug.get(r.slug)!.push({ id: r.id, name: r.name, external_id: r.external_id });
    }
    const summary: string[] = [];
    let groupsFound = 0;
    for (const [slug, group] of bySlug) {
        if (group.length > 1) {
            groupsFound++;
            summary.push(`Slug "${slug}" used by ${group.length} rows: ${group.map(g => `id=${g.id}(ext=${g.external_id})`).join(', ')}`);
        }
    }
    return { groupsFound, summary };
}

