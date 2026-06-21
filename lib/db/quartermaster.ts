import { supabase, handleSupabaseError, broadcastToOrg } from './common.js';
import { toQmCatalogItem, toQmLocation, toQmInventoryItem, toQmIssuance, toQmPlatformItem, toQmPlatformCategory } from './mappers.js';
import { sanitizeImageUrl } from '../imageUrl.js';
import { safeSearchTerm, clampListOffset } from '../pgrest.js';
import { log as baseLog } from '../log.js';
import {
    fetchAllUexItems,
    mapUexItemToQmRow,
} from './uex.js';
import type {
    QmCatalogItem,
    QmLocation,
    QmInventoryItem,
    QmIssuance,
    QmCatalogCategory,
    QmCondition,
    QmOverview,
    QmMemberRecord,
    QmPlatformItem,
    QmPlatformItemWithUsage,
    QmPlatformCategory,
} from '../../types.js';

const log = baseLog.child({ module: 'db.quartermaster' });

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export async function listCatalog(): Promise<QmCatalogItem[]> {
    // Org-custom rows only. Platform rows (UEX-sourced, ~5600+ items) are NOT
    // eagerly loaded — tenants reach them via qm:search_catalog instead. Keeps
    // tenant catalog payloads tiny and avoids rendering a giant card grid.
    const { data, error } = await supabase.from('quartermaster_catalog')
        .select('*')
        .eq('source', 'custom')
        .order('category', { ascending: true })
        .order('name', { ascending: true });
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load catalog' });
    return (data || []).map(toQmCatalogItem);
}

/**
 * Server-side ILIKE search over the catalog. Used by the catalog tab when the
 * user opts into 'Include platform catalog' and by the Add Stock combobox.
 * Returns max 200 rows; default 50.
 */
export async function searchCatalog(
    { query, source = 'both', limit = 50 }: { query: string; source?: 'custom' | 'platform' | 'both'; limit?: number }
): Promise<QmCatalogItem[]> {
    const q = (query || '').trim();
    if (!q) return [];
    // Escape ILIKE wildcards in user input so a lone % doesn't blow up the search.
    const safe = q.replace(/[\\%_]/g, (m) => '\\' + m);
    const cap = Math.min(Math.max(limit, 1), 200);
    let qb = supabase.from('quartermaster_catalog')
        .select('*')
        .ilike('name', `%${safe}%`);
    // Single-org: catalog rows differ only by `source` ('custom' vs 'platform').
    if (source === 'custom') qb = qb.eq('source', 'custom');
    else if (source === 'platform') qb = qb.eq('source', 'platform');
    // 'both' → no source filter (all catalog rows).
    qb = qb.order('source', { ascending: true }).order('name', { ascending: true }).limit(cap);
    const { data, error } = await qb;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to search catalog' });
    return (data || []).map(toQmCatalogItem);
}

/**
 * Single custom-catalog-row fetch backing the qm:get_catalog_item RPC — the
 * realtime row-slice path: qm:catalog_update broadcasts carry the catalogId
 * and QuartermasterView splices just that row. Scoped to source='custom'
 * exactly like the list (platform rows never ride qm:list_catalog). Returns
 * null when absent (deleted → removed client-side). THROWS on query errors.
 */
export async function getCatalogItemById(catalogId: number): Promise<QmCatalogItem | null> {
    const { data, error } = await supabase.from('quartermaster_catalog')
        .select('*')
        .eq('id', catalogId)
        .eq('source', 'custom')
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to get catalog item slice' });
    return data ? toQmCatalogItem(data) : null;
}

export interface CatalogInput {
    name: string;
    category: QmCatalogCategory;
    subcategory?: string | null;
    attributes?: Record<string, unknown>;
    thumbnailUrl?: string | null;
    wikiUrl?: string | null;
}

function slugify(name: string): string {
    return name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'item';
}

export async function createCatalogItem(input: CatalogInput): Promise<QmCatalogItem> {
    const name = (input.name || '').trim();
    if (!name) throw new Error('Item name is required.');
    const { data, error } = await supabase.from('quartermaster_catalog')
        .insert({
            slug: `${slugify(name)}-${Date.now().toString(36)}`,
            name,
            category: input.category,
            subcategory: input.subcategory ?? null,
            attributes: input.attributes || {},
            source: 'custom',
            thumbnail_url: sanitizeImageUrl(input.thumbnailUrl),
            wiki_url: input.wikiUrl ?? null,
        })
        .select()
        .single();
    handleSupabaseError({ error, message: 'Failed to create catalog item' });
    broadcastToOrg('qm:catalog_update', { catalogId: data?.id });
    return toQmCatalogItem(data);
}

export interface CatalogUpdateInput extends Partial<CatalogInput> {
    id: number;
}

export async function updateCatalogItem(input: CatalogUpdateInput): Promise<QmCatalogItem> {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.category !== undefined) patch.category = input.category;
    if (input.subcategory !== undefined) patch.subcategory = input.subcategory;
    if (input.attributes !== undefined) patch.attributes = input.attributes;
    if (input.thumbnailUrl !== undefined) patch.thumbnail_url = sanitizeImageUrl(input.thumbnailUrl);
    if (input.wikiUrl !== undefined) patch.wiki_url = input.wikiUrl;

    // Only allow editing the org's own custom rows — never platform rows.
    const { data, error } = await supabase.from('quartermaster_catalog')
        .update(patch)
        .eq('id', input.id)
        
        .eq('source', 'custom')
        .select()
        .single();
    handleSupabaseError({ error, message: 'Failed to update catalog item' });
    broadcastToOrg('qm:catalog_update', { catalogId: input.id });
    return toQmCatalogItem(data);
}

export async function deleteCatalogItem(id: number): Promise<void> {
    // Inventory rows whose only identifier is catalog_id need a custom_name
    // snapshotted in before the FK's ON DELETE SET NULL fires — otherwise
    // qm_inventory_has_name (catalog_id OR non-empty custom_name) is violated.
    const { data: catalog } = await supabase.from('quartermaster_catalog')
        .select('name')
        .eq('id', id)

        .eq('source', 'custom')
        .maybeSingle();
    const fallbackName = catalog?.name?.trim() || 'Deleted catalog item';
    // Collect the affected inventory ids for the companion broadcast below —
    // returning ids from the snapshot writes keeps it one extra-free pass.
    const { data: renamedA } = await supabase.from('quartermaster_inventory')
        .update({ custom_name: fallbackName })
        .eq('catalog_id', id)

        .is('custom_name', null)
        .select('id');
    const { data: renamedB } = await supabase.from('quartermaster_inventory')
        .update({ custom_name: fallbackName })
        .eq('catalog_id', id)

        .eq('custom_name', '')
        .select('id');

    // Explicit null-out so postgres_changes broadcasts the inventory updates.
    const { data: detached } = await supabase.from('quartermaster_inventory')
        .update({ catalog_id: null })
        .eq('catalog_id', id)
        .select('id');
    const { error } = await supabase.from('quartermaster_catalog')
        .delete()
        .eq('id', id)

        .eq('source', 'custom');
    handleSupabaseError({ error, message: 'Failed to delete catalog item' });
    broadcastToOrg('qm:catalog_update', { catalogId: id });
    // The detach above mutated inventory rows — without this companion the
    // armory view kept showing the deleted catalog's name/links until a full
    // refresh (pre-existing staleness gap).
    const inventoryIds = Array.from(new Set([
        ...(renamedA || []).map((r: { id: number }) => r.id),
        ...(renamedB || []).map((r: { id: number }) => r.id),
        ...(detached || []).map((r: { id: number }) => r.id),
    ]));
    if (inventoryIds.length > 0) {
        broadcastToOrg('qm:inventory_update', { inventoryIds });
    }
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export async function listQmLocations(): Promise<QmLocation[]> {
    const { data, error } = await supabase.from('quartermaster_locations')
        .select('*')
        
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load locations' });
    return (data || []).map(toQmLocation);
}

/**
 * Single-location fetch backing the qm:get_location RPC — the realtime
 * row-slice path for qm:location_update broadcasts. Returns null when absent
 * (deleted → removed client-side). THROWS on query errors.
 */
export async function getQmLocationById(locationId: number): Promise<QmLocation | null> {
    const { data, error } = await supabase.from('quartermaster_locations')
        .select('*')
        .eq('id', locationId)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to get location slice' });
    return data ? toQmLocation(data) : null;
}

export interface LocationInput {
    name: string;
    type?: QmLocation['type'];
    parentId?: number | null;
    description?: string | null;
    sortOrder?: number;
}

export async function createQmLocation(input: LocationInput): Promise<QmLocation> {
    const name = (input.name || '').trim();
    if (!name) throw new Error('Location name is required.');
    const { data, error } = await supabase.from('quartermaster_locations')
        .insert({
            name,
            type: input.type || 'custom',
            parent_id: input.parentId ?? null,
            description: input.description ?? null,
            sort_order: input.sortOrder ?? 0,
        })
        .select()
        .single();
    handleSupabaseError({ error, message: 'Failed to create location' });
    broadcastToOrg('qm:location_update', { locationId: data?.id });
    return toQmLocation(data);
}

export interface LocationUpdateInput extends Partial<LocationInput> {
    id: number;
}

export async function updateQmLocation(input: LocationUpdateInput): Promise<QmLocation> {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.type !== undefined) patch.type = input.type;
    if (input.parentId !== undefined) patch.parent_id = input.parentId;
    if (input.description !== undefined) patch.description = input.description;
    if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;

    const { data, error } = await supabase.from('quartermaster_locations')
        .update(patch)
        .eq('id', input.id)
        
        .select()
        .single();
    handleSupabaseError({ error, message: 'Failed to update location' });
    broadcastToOrg('qm:location_update', { locationId: input.id });
    return toQmLocation(data);
}

export async function deleteQmLocation(id: number): Promise<void> {
    // Null out references on QM inventory and children first (FK=SET NULL already
    // handles it but we want the update broadcast to fire). Collect the
    // affected ids for the inventory companion broadcast below.
    const { data: orphanedInv } = await supabase.from('quartermaster_inventory')
        .update({ location_id: null })
        .eq('location_id', id)
        .select('id');
    const orphanedInventoryIds = (orphanedInv || []).map((r: { id: number }) => r.id);

    // Warehouse stock has a RESTRICT FK on location_id, so we must remove any
    // warehouse rows pinned to this location before the location can be dropped.
    // Tear them down bottom-up: requests → movements → stock. Catalog is preserved.
    const { data: whStockRows, error: whStockListError } = await supabase.from('warehouse_stock')
        .select('id')
        
        .eq('location_id', id);
    handleSupabaseError({ error: whStockListError, message: 'Failed to load warehouse stock for location' });
    const whStockIds = (whStockRows || []).map((r: { id: number }) => r.id);

    if (whStockIds.length > 0) {
        const { error: reqError } = await supabase.from('warehouse_requests')
            .delete()
            
            .in('stock_id', whStockIds);
        handleSupabaseError({ error: reqError, message: 'Failed to delete withdrawal requests for location' });

        const { error: movError } = await supabase.from('warehouse_movements')
            .delete()
            
            .in('stock_id', whStockIds);
        handleSupabaseError({ error: movError, message: 'Failed to delete movements for location' });

        const { error: stockError } = await supabase.from('warehouse_stock')
            .delete()
            
            .in('id', whStockIds);
        handleSupabaseError({ error: stockError, message: 'Failed to delete warehouse stock for location' });
    }

    const { error } = await supabase.from('quartermaster_locations')
        .delete()
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to delete location' });
    broadcastToOrg('qm:location_update', { locationId: id });
    // The null-out above changed inventory rows — without this companion the
    // armory kept showing the deleted location until a full refresh.
    if (orphanedInventoryIds.length > 0) {
        broadcastToOrg('qm:inventory_update', { inventoryIds: orphanedInventoryIds });
    }
    if (whStockIds.length > 0) {
        broadcastToOrg('warehouse:stock_update', { locationId: id });
        // The teardown also deleted this location's withdrawal requests —
        // per-slice clients must drop them too.
        broadcastToOrg('warehouse:request_update', { locationId: id });
    }
}

// ---------------------------------------------------------------------------
// Inventory — listing with computed quantities
// ---------------------------------------------------------------------------

const INVENTORY_SELECT = `
    *,
    catalog:quartermaster_catalog(id, slug, name, category, subcategory, thumbnail_url),
    location:quartermaster_locations(id, name, type)
`;

/**
 * Lists inventory for an org with computed quantityOnHand (sum of movements)
 * and quantityOnIssue (sum of active issuance quantities). Both computed in
 * parallel sub-queries so we stay in a single round-trip per table.
 */
export interface ListInventoryOptions {
    includeArchived?: boolean;
    locationId?: number | null;
    catalogId?: number | null;
    search?: string;
    /** Default 1000 (legacy behavior). Set lower for paginated UIs. */
    limit?: number;
    offset?: number;
}

export async function listInventory(opts: ListInventoryOptions = {}): Promise<QmInventoryItem[]> {
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 1000);
    const offset = clampListOffset(opts.offset);
    let q = supabase.from('quartermaster_inventory')
        .select(INVENTORY_SELECT)
        ;
    if (!opts.includeArchived) q = q.eq('is_archived', false);
    if (opts.locationId != null) q = q.eq('location_id', opts.locationId);
    if (opts.catalogId != null) q = q.eq('catalog_id', opts.catalogId);
    if (opts.search && opts.search.trim()) {
        const safe = opts.search.trim().replace(/[\\%_]/g, (m) => '\\' + m);
        // PostgREST can't cross-table OR, so we match only custom_name here;
        // catalog-name search is handled client-side on the visible page.
        q = q.ilike('custom_name', `%${safe}%`);
    }
    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load inventory' });
    const items = (data || []).map(toQmInventoryItem);
    if (items.length === 0) return items;

    const ids = items.map((i) => i.id);

    // Aggregate movements (only for the rows we actually returned — caps the
    // aggregation cost regardless of total inventory size).
    const { data: movements } = await supabase.from('quartermaster_inventory_movements')
        .select('inventory_id, delta')
        .in('inventory_id', ids);
    const onHand = new Map<number, number>();
    for (const m of movements || []) {
        onHand.set(m.inventory_id, (onHand.get(m.inventory_id) || 0) + Number(m.delta));
    }

    // Aggregate active issuances — same scope.
    const { data: issuances } = await supabase.from('quartermaster_issuances')
        .select('inventory_id, quantity')
        .in('inventory_id', ids)
        .eq('status', 'active');
    const onIssue = new Map<number, number>();
    for (const iss of issuances || []) {
        onIssue.set(iss.inventory_id, (onIssue.get(iss.inventory_id) || 0) + Number(iss.quantity));
    }

    return items.map((it) => ({
        ...it,
        quantityOnHand: onHand.get(it.id) || 0,
        quantityOnIssue: onIssue.get(it.id) || 0,
    }));
}

/** Cheap count for paginators / stat cards — no row payload. */
export async function listInventoryCount(opts: ListInventoryOptions = {}): Promise<number> {
    let q = supabase.from('quartermaster_inventory').select('*', { count: 'exact', head: true });
    if (!opts.includeArchived) q = q.eq('is_archived', false);
    if (opts.locationId != null) q = q.eq('location_id', opts.locationId);
    if (opts.catalogId != null) q = q.eq('catalog_id', opts.catalogId);
    if (opts.search && opts.search.trim()) {
        const safe = opts.search.trim().replace(/[\\%_]/g, (m) => '\\' + m);
        q = q.ilike('custom_name', `%${safe}%`);
    }
    const { count, error } = await q;
    if (error && error.code === '42P01') return 0;
    handleSupabaseError({ error, message: 'Failed to count inventory' });
    return count ?? 0;
}

export interface CreateInventoryInput {
    catalogId?: number | null;
    customName?: string | null;
    locationId?: number | null;
    condition?: QmCondition;
    initialQuantity: number;
    notes?: string | null;
}

/**
 * Creates the inventory row and seeds quantity with an 'initial' movement in
 * one logical flow. The movement is inserted after the row exists so it can
 * reference the new id.
 */
export async function createInventoryItem(
    actorUserId: number,
    input: CreateInventoryInput,
): Promise<QmInventoryItem> {
    if (!input.catalogId && !input.customName?.trim()) {
        throw new Error('Select a catalog item or provide a custom name.');
    }
    const initialQty = Math.trunc(Number(input.initialQuantity));
    if (!Number.isFinite(initialQty) || initialQty < 0) {
        throw new Error('Initial quantity must be a non-negative integer.');
    }

    const { data: row, error: insErr } = await supabase.from('quartermaster_inventory')
        .insert({
            catalog_id: input.catalogId ?? null,
            custom_name: input.customName?.trim() || null,
            location_id: input.locationId ?? null,
            condition: input.condition || 'pristine',
            notes: input.notes ?? null,
        })
        .select(INVENTORY_SELECT)
        .single();
    handleSupabaseError({ error: insErr, message: 'Failed to create inventory item' });

    if (initialQty > 0) {
        const { error: movErr } = await supabase.from('quartermaster_inventory_movements')
            .insert({
                inventory_id: row.id,
                delta: initialQty,
                reason: 'initial',
                actor_user_id: actorUserId,
            });
        handleSupabaseError({ error: movErr, message: 'Failed to record initial stock' });
    }

    broadcastToOrg('qm:inventory_update', { inventoryId: row.id });
    return {
        ...toQmInventoryItem(row),
        quantityOnHand: initialQty,
        quantityOnIssue: 0,
    };
}

export interface UpdateInventoryInput {
    id: number;
    locationId?: number | null;
    condition?: QmCondition;
    notes?: string | null;
    customName?: string | null;
    isArchived?: boolean;
}

export async function updateInventoryItem(input: UpdateInventoryInput): Promise<void> {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.locationId !== undefined) patch.location_id = input.locationId;
    if (input.condition !== undefined) patch.condition = input.condition;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.customName !== undefined) patch.custom_name = input.customName;
    if (input.isArchived !== undefined) patch.is_archived = input.isArchived;

    const { error } = await supabase.from('quartermaster_inventory')
        .update(patch)
        .eq('id', input.id)
        ;
    handleSupabaseError({ error, message: 'Failed to update inventory item' });
    broadcastToOrg('qm:inventory_update', { inventoryId: input.id });
}

export async function adjustInventoryStock(
    actorUserId: number,
    input: { inventoryId: number; delta: number; reason: 'adjust' | 'loss' | 'destruction'; notes?: string | null },
): Promise<void> {
    const delta = Math.trunc(Number(input.delta));
    if (!Number.isFinite(delta) || delta === 0) {
        throw new Error('Adjustment delta must be a non-zero integer.');
    }
    const { error } = await supabase.rpc('qm_adjust_inventory', {
        p_inventory_id: input.inventoryId,
        p_delta: delta,
        p_reason: input.reason,
        p_actor_id: actorUserId,
        p_notes: input.notes ?? null,
    });
    handleSupabaseError({ error, message: 'Failed to adjust stock' });
    broadcastToOrg('qm:inventory_update', { inventoryId: input.inventoryId });
}

// ---------------------------------------------------------------------------
// Issuances
// ---------------------------------------------------------------------------

const ISSUANCE_SELECT = `
    *,
    inventory:quartermaster_inventory(id, custom_name, catalog:quartermaster_catalog(name, category)),
    issued_to:users!quartermaster_issuances_issued_to_user_id_fkey(id, name, avatar_url, rsi_handle),
    requested_by:users!quartermaster_issuances_requested_by_user_id_fkey(id, name, avatar_url, rsi_handle),
    issued_by:users!quartermaster_issuances_issued_by_user_id_fkey(id, name, avatar_url, rsi_handle),
    closed_by:users!quartermaster_issuances_closed_by_user_id_fkey(id, name, avatar_url, rsi_handle)
`;

export interface ListIssuancesOpts {
    status?: QmIssuance['status'] | 'open'; // 'open' = requested + active
    userId?: number;
    inventoryId?: number;
    limit?: number;
}

export async function listIssuances(
    opts: ListIssuancesOpts = {},
): Promise<QmIssuance[]> {
    let q = supabase.from('quartermaster_issuances')
        .select(ISSUANCE_SELECT)
        ;
    if (opts.status === 'open') q = q.in('status', ['requested', 'active']);
    else if (opts.status) q = q.eq('status', opts.status);
    if (opts.userId) q = q.eq('issued_to_user_id', opts.userId);
    if (opts.inventoryId) q = q.eq('inventory_id', opts.inventoryId);
    const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
    q = q.order('created_at', { ascending: false }).limit(limit);
    const { data, error } = await q;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load issuances' });
    return (data || []).map(toQmIssuance);
}

export interface RequestIssuanceInput {
    inventoryId: number;
    issuedToUserId?: number;   // defaults to requester
    quantity: number;
    dueBackAt?: string | null;
    notes?: string | null;
    operationId?: number | null;
}

export async function requestIssuance(
    requesterUserId: number,
    input: RequestIssuanceInput,
): Promise<QmIssuance> {
    const qty = Math.trunc(Number(input.quantity));
    if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error('Quantity must be a positive integer.');
    }
    const { data, error } = await supabase.from('quartermaster_issuances')
        .insert({
            inventory_id: input.inventoryId,
            issued_to_user_id: input.issuedToUserId ?? requesterUserId,
            quantity: qty,
            status: 'requested',
            requested_at: new Date().toISOString(),
            due_back_at: input.dueBackAt ?? null,
            requested_by_user_id: requesterUserId,
            notes: input.notes ?? null,
            operation_id: input.operationId ?? null,
        })
        .select(ISSUANCE_SELECT)
        .single();
    handleSupabaseError({ error, message: 'Failed to submit issuance request' });
    broadcastToOrg('qm:issuance_update', { issuanceId: data?.id });
    return toQmIssuance(data);
}

/**
 * Single-issuance fetch in the list row shape (same ISSUANCE_SELECT embeds as
 * qm:list_issuances) backing the qm:get_issuance RPC — the realtime row-slice
 * path: qm:issuance_update broadcasts carry the issuanceId(s) and
 * QuartermasterView splices just those rows instead of re-listing 200
 * 4-user-join rows. Returns null when absent. THROWS on query errors.
 */
export async function getIssuanceById(issuanceId: number): Promise<QmIssuance | null> {
    const { data, error } = await supabase.from('quartermaster_issuances')
        .select(ISSUANCE_SELECT)
        .eq('id', issuanceId)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to get issuance slice' });
    return data ? toQmIssuance(data) : null;
}

export async function fulfilIssuance(
    actorUserId: number,
    issuanceId: number,
): Promise<boolean> {
    // Tenant scope check. inventory_id rides the select so the stock
    // companion broadcast below can carry it (clients then refresh only the
    // affected armory row/page instead of everything).
    const { data: row, error: scopeErr } = await supabase.from('quartermaster_issuances')
        .select('id, status, inventory_id')
        .eq('id', issuanceId)

        .maybeSingle();
    handleSupabaseError({ error: scopeErr, message: 'Failed to load issuance' });
    if (!row) throw new Error('Issuance not found.');
    if (row.status !== 'requested') return false;

    const { data, error } = await supabase.rpc('qm_fulfil_issuance', {
        p_issuance_id: issuanceId,
        p_actor_id: actorUserId,
    });
    handleSupabaseError({ error, message: 'Failed to fulfil issuance' });
    broadcastToOrg('qm:issuance_update', { issuanceId });
    broadcastToOrg('qm:inventory_update', { inventoryId: row.inventory_id });
    return Number(data ?? 0) > 0;
}

export interface IssueDirectInput {
    inventoryId: number;
    issuedToUserId: number;
    quantity: number;
    dueBackAt?: string | null;
    notes?: string | null;
    operationId?: number | null;
}

export async function issueDirect(
    actorUserId: number,
    input: IssueDirectInput,
): Promise<number> {
    // Ensure the inventory row belongs to this org before calling the function.
    const { data: invRow, error: scopeErr } = await supabase.from('quartermaster_inventory')
        .select('id')
        .eq('id', input.inventoryId)
        
        .maybeSingle();
    handleSupabaseError({ error: scopeErr, message: 'Failed to load inventory' });
    if (!invRow) throw new Error('Inventory item not found.');

    const { data, error } = await supabase.rpc('qm_issue_direct', {
        p_inventory_id: input.inventoryId,
        p_issued_to: input.issuedToUserId,
        p_quantity: Math.trunc(Number(input.quantity)),
        p_due_back_at: input.dueBackAt ?? null,
        p_actor_id: actorUserId,
        p_notes: input.notes ?? null,
        p_operation_id: input.operationId ?? null,
    });
    handleSupabaseError({ error, message: 'Failed to issue item' });
    broadcastToOrg('qm:issuance_update', { issuanceId: Number(data) });
    broadcastToOrg('qm:inventory_update', { inventoryId: input.inventoryId });
    return Number(data);
}

// Defensive upper bound on a single bulk issue/return call. A kit / return
// batch this large is never a legitimate UI flow; reject outright (rather than
// truncate, which would silently drop lines) as a circuit breaker against
// write amplification from a runaway / hostile direct API consumer.
// Mirrors the bulk-action caps in lib/db/users.ts (BULK_ACTION_MAX) and the
// import/template caps (MAX_IMPORT_BATCH_SIZE, MAX_PHASES, ...).
const MAX_BULK_LINES = 200;

export interface IssueBulkInput {
    issuedToUserId: number;
    lines: { inventoryId: number; quantity: number }[];
    dueBackAt?: string | null;
    notes?: string | null;
    operationId?: number | null;
}

export async function issueDirectBulk(
    actorUserId: number,
    input: IssueBulkInput,
): Promise<number[]> {
    if (!input.lines?.length) throw new Error('Kit must contain at least one item.');
    if (input.lines.length > MAX_BULK_LINES) {
        throw new Error(`qm:issue_bulk: kit capped at ${MAX_BULK_LINES} lines per call (got ${input.lines.length}).`);
    }

    // Verify every inventory row belongs to this org before handing off to the
    // transaction-wrapped stored proc. The proc doesn't re-check tenant scope
    // (it trusts that lookup), so this gate is load-bearing.
    const invIds = Array.from(new Set(input.lines.map(l => l.inventoryId)));
    const { data: invRows, error: scopeErr } = await supabase.from('quartermaster_inventory')
        .select('id')
        
        .in('id', invIds);
    handleSupabaseError({ error: scopeErr, message: 'Failed to load inventory' });
    const validIds = new Set((invRows || []).map((r: { id: number }) => r.id));
    for (const id of invIds) {
        if (!validIds.has(id)) throw new Error(`Inventory item ${id} not found in this org.`);
    }

    const payload = input.lines.map(l => ({
        inventory_id: l.inventoryId,
        quantity: Math.trunc(Number(l.quantity)),
    }));

    const { data, error } = await supabase.rpc('qm_issue_bulk', {
        p_issued_to: input.issuedToUserId,
        p_due_back_at: input.dueBackAt ?? null,
        p_actor_id: actorUserId,
        p_notes: input.notes ?? null,
        p_operation_id: input.operationId ?? null,
        p_lines: payload,
    });
    handleSupabaseError({ error, message: 'Failed to issue kit' });
    const issuanceIds = ((data as unknown[]) || []).map((v) => Number(v));
    broadcastToOrg('qm:issuance_update', { issuanceIds });
    broadcastToOrg('qm:inventory_update', { inventoryIds: invIds });
    return issuanceIds;
}

export interface ReturnIssuanceInput {
    issuanceId: number;
    returnedQuantity: number;
    outcome: 'returned_on_time' | 'returned_late' | 'returned_damaged';
    notes?: string | null;
}

export async function returnIssuance(
    actorUserId: number,
    input: ReturnIssuanceInput,
): Promise<boolean> {
    const { data: row } = await supabase.from('quartermaster_issuances')
        .select('id, status, inventory_id')
        .eq('id', input.issuanceId)

        .maybeSingle();
    if (!row) throw new Error('Issuance not found.');
    if (row.status !== 'active') return false;

    const { data, error } = await supabase.rpc('qm_return_issuance', {
        p_issuance_id: input.issuanceId,
        p_returned_qty: Math.trunc(Number(input.returnedQuantity)),
        p_outcome: input.outcome,
        p_actor_id: actorUserId,
        p_notes: input.notes ?? null,
    });
    handleSupabaseError({ error, message: 'Failed to close issuance' });
    broadcastToOrg('qm:issuance_update', { issuanceId: input.issuanceId });
    broadcastToOrg('qm:inventory_update', { inventoryId: row.inventory_id });
    return Number(data ?? 0) > 0;
}

export interface WriteOffIssuanceInput {
    issuanceId: number;
    outcome: 'lost' | 'destroyed_in_action';
    notes?: string | null;
}

export async function writeOffIssuance(
    actorUserId: number,
    input: WriteOffIssuanceInput,
): Promise<boolean> {
    const { data: row } = await supabase.from('quartermaster_issuances')
        .select('id, status')
        .eq('id', input.issuanceId)
        
        .maybeSingle();
    if (!row) throw new Error('Issuance not found.');
    if (row.status !== 'active') return false;

    const { data, error } = await supabase.rpc('qm_write_off_issuance', {
        p_issuance_id: input.issuanceId,
        p_outcome: input.outcome,
        p_actor_id: actorUserId,
        p_notes: input.notes ?? null,
    });
    handleSupabaseError({ error, message: 'Failed to write off issuance' });
    broadcastToOrg('qm:issuance_update', { issuanceId: input.issuanceId });
    return Number(data ?? 0) > 0;
}

export interface ReturnBulkInput {
    lines: {
        issuanceId: number;
        returnedQuantity: number;
        outcome: 'returned_on_time' | 'returned_late' | 'returned_damaged';
    }[];
    notes?: string | null;
}

export async function returnIssuanceBulk(
    actorUserId: number,
    input: ReturnBulkInput,
): Promise<number> {
    if (!input.lines?.length) throw new Error('No issuances selected for return.');
    if (input.lines.length > MAX_BULK_LINES) {
        throw new Error(`qm:return_bulk: return capped at ${MAX_BULK_LINES} lines per call (got ${input.lines.length}).`);
    }

    // Tenant scope: every issuance must live in this org. The stored proc
    // trusts this has been checked. inventory_id rides the select so the
    // stock companion broadcast below can carry the affected inventory ids.
    const ids = Array.from(new Set(input.lines.map(l => l.issuanceId)));
    const { data: rows, error: scopeErr } = await supabase.from('quartermaster_issuances')
        .select('id, inventory_id')

        .in('id', ids);
    handleSupabaseError({ error: scopeErr, message: 'Failed to load issuances' });
    const validIds = new Set((rows || []).map((r: { id: number }) => r.id));
    for (const id of ids) {
        if (!validIds.has(id)) throw new Error(`Issuance ${id} not found in this org.`);
    }
    const returnedInventoryIds = Array.from(new Set((rows || []).map((r: { inventory_id: number }) => r.inventory_id)));

    const payload = input.lines.map(l => ({
        issuance_id: l.issuanceId,
        returned_quantity: Math.trunc(Number(l.returnedQuantity)),
        outcome: l.outcome,
    }));

    const { data, error } = await supabase.rpc('qm_return_bulk', {
        p_actor_id: actorUserId,
        p_notes: input.notes ?? null,
        p_lines: payload,
    });
    handleSupabaseError({ error, message: 'Failed to close issuances' });
    broadcastToOrg('qm:issuance_update', { issuanceIds: ids });
    broadcastToOrg('qm:inventory_update', { inventoryIds: returnedInventoryIds });
    return Number(data ?? 0);
}

// ---------------------------------------------------------------------------
// Member records (Q-Record view) — server-grouped, open issuances only
// ---------------------------------------------------------------------------
// The ledger fetch is capped at 200 rows because closed history can be huge.
// For per-member rollup we only need *open* issuances (active + requested),
// which are bounded by "items currently out in the field" — typically tens,
// not thousands — so we skip the cap and return everything open.

export async function listMemberRecords(): Promise<QmMemberRecord[]> {
    const { data, error } = await supabase.from('quartermaster_issuances')
        .select(ISSUANCE_SELECT)
        
        .in('status', ['requested', 'active'])
        .order('due_back_at', { ascending: true, nullsFirst: false });
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load member records' });

    const issuances = (data || []).map(toQmIssuance);
    const map = new Map<number, QmMemberRecord>();
    for (const iss of issuances) {
        if (!iss.issuedTo) continue;
        let rec = map.get(iss.issuedToUserId);
        if (!rec) {
            rec = { user: iss.issuedTo, active: [], requested: [], overdueCount: 0, totalQuantity: 0 };
            map.set(iss.issuedToUserId, rec);
        }
        if (iss.status === 'active') {
            rec.active.push(iss);
            if (iss.isOverdue) rec.overdueCount++;
        } else if (iss.status === 'requested') {
            rec.requested.push(iss);
        }
        rec.totalQuantity += iss.quantity;
    }

    return Array.from(map.values()).sort((a, b) => {
        if (a.overdueCount !== b.overdueCount) return b.overdueCount - a.overdueCount;
        const aOpen = a.active.length + a.requested.length;
        const bOpen = b.active.length + b.requested.length;
        if (aOpen !== bOpen) return bOpen - aOpen;
        return a.user.name.localeCompare(b.user.name);
    });
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function getQuartermasterOverview(): Promise<QmOverview> {
    // Single SQL aggregate call — replaces the previous "fetch entire inventory
    // + every open issuance row, sum in JS" pattern. Egress: ~5 numbers vs
    // potentially hundreds of KB of joined inventory rows.
    const [statsResult, recentIssuances] = await Promise.all([
        supabase.rpc('qm_overview_stats', {}),
        listIssuances({ limit: 10 }),
    ]);
    handleSupabaseError({ error: statsResult.error, message: 'Failed to load overview stats' });
    const row: {
        total_items?: number | null;
        distinct_skus?: number | null;
        items_on_issue?: number | null;
        overdue_count?: number | null;
        pending_requests?: number | null;
    } = (statsResult.data && statsResult.data[0]) || {};
    return {
        totalItems: Number(row.total_items ?? 0),
        distinctSkus: Number(row.distinct_skus ?? 0),
        itemsOnIssue: Number(row.items_on_issue ?? 0),
        overdueCount: Number(row.overdue_count ?? 0),
        pendingRequests: Number(row.pending_requests ?? 0),
        recentIssuances,
    };
}

// ---------------------------------------------------------------------------
// Low-stock listing — used by the overview low-stock card. Bounded list
// (default 10) so we never repeat the "pull all inventory" pattern; the
// query computes qty_on_hand and qty_on_issue per row and only returns
// rows where on-hand <= threshold.
// ---------------------------------------------------------------------------

export interface QmLowStockRow {
    inventoryId: number;
    name: string;
    quantityOnHand: number;
    quantityOnIssue: number;
    locationName: string | null;
    catalogId: number | null;
    thumbnailUrl: string | null;
}

export async function listLowStockInventory(
    opts: { threshold?: number; limit?: number } = {},
): Promise<QmLowStockRow[]> {
    const threshold = Math.max(0, Math.trunc(opts.threshold ?? 2));
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);

    // Pull the non-archived inventory rows + minimal joined fields. We don't
    // know up front which rows are below the threshold (it depends on
    // computed qty), so we have to inspect movements/issuances to filter.
    // To stay bounded: fetch *all* movements in one query keyed by inventory_id,
    // sum in JS, then take the bottom-N by qty_on_hand. Movements are an
    // append-only log so this is unbounded over time, but per-org it is
    // typically O(thousands) of rows even for active orgs — small enough for
    // a single round-trip and far cheaper than shipping the whole inventory.
    const { data: invRows, error: invErr } = await supabase
        .from('quartermaster_inventory')
        .select(`
            id, custom_name, catalog_id,
            catalog:quartermaster_catalog(id, name, thumbnail_url),
            location:quartermaster_locations(id, name)
        `)
        
        .eq('is_archived', false);
    if (invErr && invErr.code === '42P01') return [];
    handleSupabaseError({ error: invErr, message: 'Failed to load inventory for low-stock scan' });
    interface LowStockInvRow {
        id: number;
        custom_name: string | null;
        catalog_id: number | null;
        catalog?: { id: number; name: string | null; thumbnail_url: string | null } | null;
        location?: { id: number; name: string | null } | null;
    }
    const items: LowStockInvRow[] = (invRows || []) as unknown as LowStockInvRow[];
    if (items.length === 0) return [];

    const ids = items.map((r) => r.id);

    const { data: movements } = await supabase
        .from('quartermaster_inventory_movements')
        .select('inventory_id, delta')
        .in('inventory_id', ids);
    const onHand = new Map<number, number>();
    for (const m of movements || []) {
        onHand.set(m.inventory_id, (onHand.get(m.inventory_id) || 0) + Number(m.delta));
    }

    const { data: issuances } = await supabase
        .from('quartermaster_issuances')
        .select('inventory_id, quantity')
        .in('inventory_id', ids)
        .eq('status', 'active');
    const onIssue = new Map<number, number>();
    for (const iss of issuances || []) {
        onIssue.set(iss.inventory_id, (onIssue.get(iss.inventory_id) || 0) + Number(iss.quantity));
    }

    const enriched = items
        .map((r) => ({
            inventoryId: r.id as number,
            name: (r.catalog?.name || r.custom_name || 'Item') as string,
            quantityOnHand: onHand.get(r.id) || 0,
            quantityOnIssue: onIssue.get(r.id) || 0,
            locationName: (r.location?.name as string | undefined) || null,
            catalogId: (r.catalog_id as number | null) ?? null,
            thumbnailUrl: (r.catalog?.thumbnail_url as string | null) || null,
        }))
        .filter((r) => r.quantityOnHand <= threshold)
        .sort((a, b) => a.quantityOnHand - b.quantityOnHand || a.name.localeCompare(b.name))
        .slice(0, limit);

    return enriched;
}

// ---------------------------------------------------------------------------
// CSV export — inventory snapshot
// ---------------------------------------------------------------------------

function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
    return str;
}

export async function exportInventoryCsv(): Promise<string> {
    const rows = await listInventory({ includeArchived: false });
    const header = [
        'id', 'name', 'category', 'subcategory', 'location', 'condition',
        'quantity_on_hand', 'quantity_on_issue', 'acquired_at', 'notes',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
        lines.push([
            r.id,
            r.catalog?.name ?? r.customName ?? '',
            r.catalog?.category ?? '',
            r.catalog?.subcategory ?? '',
            r.location?.name ?? '',
            r.condition,
            r.quantityOnHand,
            r.quantityOnIssue,
            r.acquiredAt,
            r.notes,
        ].map(csvEscape).join(','));
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Overdue scan — returns active issuances that are now past their due date.
// Intended to be called by a nightly cron so push notifications fire once
// per day per overdue issuance; per-issuance dedup left to the caller.
// ---------------------------------------------------------------------------

export interface OverdueIssuanceSummary {
    id: number;
    issuedToUserId: number;
    inventoryName: string;
    quantity: number;
    dueBackAt: string;
}

export async function listOverdueIssuances(): Promise<OverdueIssuanceSummary[]> {
    const q = supabase.from('quartermaster_issuances')
        .select('id, issued_to_user_id, quantity, due_back_at, inventory:quartermaster_inventory(custom_name, catalog:quartermaster_catalog(name))')
        .eq('status', 'active')
        .not('due_back_at', 'is', null)
        .lt('due_back_at', new Date().toISOString());
    const { data, error } = await q;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to scan overdue issuances' });
    interface OverdueRow {
        id: number;
        issued_to_user_id: number;
        quantity: number;
        due_back_at: string;
        inventory?: { custom_name: string | null; catalog?: { name: string | null } | null } | null;
    }
    return ((data || []) as unknown as OverdueRow[]).map((r) => ({
        id: r.id,
        issuedToUserId: r.issued_to_user_id,
        inventoryName: r.inventory?.catalog?.name || r.inventory?.custom_name || 'Item',
        quantity: r.quantity,
        dueBackAt: r.due_back_at,
    }));
}

// ===========================================================================
// PLATFORM ITEM CATALOG (UEX-sourced, platform-admin only)
// ===========================================================================
// Platform rows live in quartermaster_catalog with source='platform' and
// organization_id IS NULL. Tenant listCatalog() already merges them via
// the .or(...) query at the top of this file. The new editable category
// lookup is in quartermaster_platform_categories.

export async function listPlatformItemCategories(): Promise<QmPlatformCategory[]> {
    const { data, error } = await supabase.from('quartermaster_platform_categories')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('display_name', { ascending: true });
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load quartermaster platform categories' });
    return (data || []).map(toQmPlatformCategory);
}

export async function updatePlatformItemCategory(id: number, patch: Record<string, unknown>) {
    if (!Object.keys(patch).length) throw new Error('No updatable fields provided');
    patch.updated_at = new Date().toISOString();
    const { error } = await supabase.from('quartermaster_platform_categories')
        .update(patch)
        .eq('id', id);
    handleSupabaseError({ error, message: 'Failed to update quartermaster platform category' });
}

export async function deletePlatformItemCategory(id: number) {
    const { count } = await supabase.from('quartermaster_catalog')
        .select('*', { count: 'exact', head: true })
        .eq('platform_category_id', id);
    if (count && count > 0) {
        throw new Error(`Cannot delete: ${count} item row(s) reference this category. Reassign first.`);
    }
    const { error } = await supabase.from('quartermaster_platform_categories')
        .delete()
        .eq('id', id);
    handleSupabaseError({ error, message: 'Failed to delete quartermaster platform category' });
}

export interface ListPlatformItemsOptions {
    search?: string;
    platformCategoryId?: number | null;
    hideVehicleItems?: boolean;
    limit?: number;
    offset?: number;
}

/**
 * Paginated, filtered server-side read for the admin item catalog. Replaces
 * the eager bulk fetch — typical egress drops from ~5MB (5600 rows) to ~50 KB
 * (50 rows) per visit.
 */
export async function getPlatformItemCatalog(opts: ListPlatformItemsOptions = {}): Promise<QmPlatformItem[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = clampListOffset(opts.offset);
    let qb = supabase.from('quartermaster_catalog').select('*').eq('source', 'platform');
    if (opts.search && opts.search.trim()) {
        const safe = safeSearchTerm(opts.search); // allow-list before .or()
        if (safe) qb = qb.or(`name.ilike.%${safe}%,subcategory.ilike.%${safe}%,company_name.ilike.%${safe}%`);
    }
    if (opts.platformCategoryId != null) qb = qb.eq('platform_category_id', opts.platformCategoryId);
    if (opts.hideVehicleItems) qb = qb.eq('is_vehicle_item', false);
    qb = qb.order('name', { ascending: true }).range(offset, offset + limit - 1);
    const { data, error } = await qb;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load platform item catalog' });
    return (data || []).map(toQmPlatformItem);
}

/**
 * Paginated read with usage counts for the visible page only. Avoids the
 * old "pull all 5600 + all inventory" pattern; usage is now resolved per
 * visible row via a single IN-list count query.
 */
export async function getPlatformItemCatalogWithUsage(opts: ListPlatformItemsOptions = {}): Promise<QmPlatformItemWithUsage[]> {
    const items = await getPlatformItemCatalog(opts);
    if (!items.length) return [];
    const ids = items.map((i) => i.id);
    const { data: usageRows } = await supabase.from('quartermaster_inventory')
        .select('catalog_id')
        .in('catalog_id', ids);
    const usageMap = new Map<number, number>();
    for (const row of (usageRows || [])) {
        if (row.catalog_id == null) continue;
        usageMap.set(row.catalog_id, (usageMap.get(row.catalog_id) || 0) + 1);
    }
    return items.map((i) => ({ ...i, usageCount: usageMap.get(i.id) || 0 }));
}

/**
 * Server-side count for stats + pagination. Same filter shape as the listing
 * function; uses count-only query so no row payload is sent over the wire.
 */
export async function getPlatformItemCatalogCount(opts: ListPlatformItemsOptions = {}): Promise<number> {
    let qb = supabase.from('quartermaster_catalog').select('*', { count: 'exact', head: true }).eq('source', 'platform');
    if (opts.search && opts.search.trim()) {
        const safe = safeSearchTerm(opts.search); // allow-list before .or()
        if (safe) qb = qb.or(`name.ilike.%${safe}%,subcategory.ilike.%${safe}%,company_name.ilike.%${safe}%`);
    }
    if (opts.platformCategoryId != null) qb = qb.eq('platform_category_id', opts.platformCategoryId);
    if (opts.hideVehicleItems) qb = qb.eq('is_vehicle_item', false);
    const { count, error } = await qb;
    if (error && error.code === '42P01') return 0;
    handleSupabaseError({ error, message: 'Failed to count platform items' });
    return count ?? 0;
}

/**
 * Sync from UEX. Two-pass:
 *   1. Upsert each item-type UEX category into quartermaster_platform_categories
 *      by uex_category_id. Admin-edited display_name / sort_order / is_hidden
 *      are PRESERVED across re-syncs (only uex_category_name and uex_section
 *      get refreshed).
 *   2. For each item with a uuid, upsert by external_uuid.
 */
export async function syncPlatformItemCatalog() {
    const { categories, items, errors: fetchErrors } = await fetchAllUexItems();

    // Pass 1: categories
    const { data: existingCats } = await supabase.from('quartermaster_platform_categories')
        .select('id, uex_category_id, display_name');
    const existingByUexId = new Map<number, { id: number; display_name: string }>();
    for (const r of (existingCats || [])) {
        existingByUexId.set(r.uex_category_id, { id: r.id, display_name: r.display_name });
    }

    const catFkLookup = new Map<number, number>();
    let categoriesInserted = 0;
    let categoriesUpdated = 0;

    for (const cat of categories) {
        const existing = existingByUexId.get(cat.id);
        if (existing) {
            const { error } = await supabase.from('quartermaster_platform_categories')
                .update({
                    uex_category_name: cat.name,
                    uex_section: cat.section || null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', existing.id);
            if (!error) categoriesUpdated++;
            catFkLookup.set(cat.id, existing.id);
        } else {
            const { data, error } = await supabase.from('quartermaster_platform_categories')
                .insert({
                    uex_category_id: cat.id,
                    uex_category_name: cat.name,
                    uex_section: cat.section || null,
                    display_name: cat.name,
                })
                .select('id')
                .single();
            if (!error && data) {
                catFkLookup.set(cat.id, data.id);
                categoriesInserted++;
            }
        }
    }

    // Pass 2: items (batched upserts — 5000+ rows is too many for individual round-trips)
    const ITEM_BATCH_SIZE = 100;
    let itemsSynced = 0;
    let itemsSkipped = 0;
    let itemErrors = 0;
    const rowsToWrite: Record<string, unknown>[] = [];
    const rowOriginalNames: string[] = [];
    for (const item of items) {
        const row = mapUexItemToQmRow(item, catFkLookup);
        if (!row) { itemsSkipped++; continue; }
        rowsToWrite.push(row);
        rowOriginalNames.push(item.name || '?');
    }

    for (let i = 0; i < rowsToWrite.length; i += ITEM_BATCH_SIZE) {
        const batch = rowsToWrite.slice(i, i + ITEM_BATCH_SIZE);
        const { error } = await supabase.from('quartermaster_catalog')
            .upsert(batch, { onConflict: 'external_uuid' });
        if (error) {
            // Batch failed — fall back to per-row upserts so one bad row
            // doesn't block the rest of the batch.
            for (let j = 0; j < batch.length; j++) {
                const row = batch[j];
                const name = rowOriginalNames[i + j];
                const { error: rowErr } = await supabase.from('quartermaster_catalog')
                    .upsert(row, { onConflict: 'external_uuid' });
                if (rowErr) {
                    itemErrors++;
                    if (itemErrors <= 5) log.warn('uex item upsert failed', { name, externalUuid: row.external_uuid, error: rowErr.message });
                } else {
                    itemsSynced++;
                }
            }
        } else {
            itemsSynced += batch.length;
        }
    }

    log.info('uex sync done', { itemsSynced, itemsSkipped, itemErrors, categoriesInserted, categoriesUpdated, categoryFetchErrors: fetchErrors.length });
    return {
        itemsSynced,
        itemsSkipped,
        itemErrors,
        categoriesInserted,
        categoriesUpdated,
        fetchErrors,
    };
}

const QM_PLATFORM_PROTECTED_FIELDS = new Set([
    'id', 'source', 'created_at',
]);

export async function updatePlatformItem(id: number, patch: Record<string, unknown>) {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
        if (QM_PLATFORM_PROTECTED_FIELDS.has(k)) continue;
        safe[k] = v;
    }
    if (!Object.keys(safe).length) throw new Error('No updatable fields provided');
    safe.updated_at = new Date().toISOString();
    const { error } = await supabase.from('quartermaster_catalog')
        .update(safe)
        .eq('id', id)
        .eq('source', 'platform');
    handleSupabaseError({ error, message: 'Failed to update platform item' });
}

export async function deletePlatformItem(id: number) {
    const { count } = await supabase.from('quartermaster_inventory')
        .select('*', { count: 'exact', head: true })
        .eq('catalog_id', id);
    if (count && count > 0) {
        throw new Error(`Cannot delete: ${count} inventory row(s) reference this item. Use merge to reassign them first.`);
    }
    const { error } = await supabase.from('quartermaster_catalog')
        .delete()
        .eq('id', id)
        .eq('source', 'platform');
    handleSupabaseError({ error, message: 'Failed to delete platform item' });
}

export async function mergePlatformItems(keepId: number, deleteId: number) {
    if (keepId === deleteId) throw new Error('Cannot merge an item with itself');
    // Verify both rows are platform rows before reassigning.
    const { data: rows, error: lookupErr } = await supabase.from('quartermaster_catalog')
        .select('id, source')
        .in('id', [keepId, deleteId]);
    handleSupabaseError({ error: lookupErr, message: 'Failed to look up items to merge' });
    if ((rows || []).length !== 2 || (rows || []).some(r => r.source !== 'platform')) {
        throw new Error('Both items must exist and be platform rows.');
    }

    const { error: reassignErr } = await supabase.from('quartermaster_inventory')
        .update({ catalog_id: keepId })
        .eq('catalog_id', deleteId);
    handleSupabaseError({ error: reassignErr, message: 'Failed to reassign inventory during merge' });

    const { error: delErr } = await supabase.from('quartermaster_catalog')
        .delete()
        .eq('id', deleteId)
        .eq('source', 'platform');
    handleSupabaseError({ error: delErr, message: 'Failed to delete merged item' });

    return { merged: true };
}

export async function repairPlatformItemCatalogDuplicates() {
    // Same as commodities: external_uuid is UNIQUE so true UEX dupes can't
    // exist. Report rows sharing slug/name as informational only.
    const { data } = await supabase.from('quartermaster_catalog')
        .select('id, slug, name, external_uuid')
        .eq('source', 'platform');
    const bySlug = new Map<string, Array<{ id: number; name: string; external_uuid: string | null }>>();
    for (const r of (data || [])) {
        if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
        bySlug.get(r.slug)!.push({ id: r.id, name: r.name, external_uuid: r.external_uuid });
    }
    const summary: string[] = [];
    let groupsFound = 0;
    for (const [slug, group] of bySlug) {
        if (group.length > 1) {
            groupsFound++;
            summary.push(`Slug "${slug}" used by ${group.length} platform rows: ${group.map(g => `id=${g.id}(uuid=${g.external_uuid})`).join(', ')}`);
        }
    }
    return { groupsFound, summary };
}
