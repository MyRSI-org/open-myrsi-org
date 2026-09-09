import { supabase, handleSupabaseError, broadcastToOrg } from './common.js';
import { toQmCatalogItem, toQmLocation, toQmInventoryItem, toQmIssuance, toQmPlatformItem, toQmPlatformCategory } from './mappers.js';
import { sanitizeImageUrl } from '../imageUrl.js';
import { stripHtmlSingleLine } from '../textSanitize.js';
import { safeSearchTerm, clampListOffset, escapeLikePattern } from '../pgrest.js';
import { log as baseLog } from '../log.js';
import { MAX_STOCK_TOTAL } from '../stockLimits.js';
import {
    fetchAllUexItems,
    mapUexItemToQmRow,
    fetchUexCategories,
    fetchUexItemAttributesForCategory,
} from './uex.js';
import type {
    QmCatalogItem,
    QmLocation,
    QmInventoryItem,
    QmArmouryFacets,
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
        .select('id, slug, name, category, subcategory, attributes, source, thumbnail_url, wiki_url, created_at, updated_at')
        .eq('source', 'custom')
        .order('category', { ascending: true })
        .order('name', { ascending: true });
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load catalog' });
    return ((data || []) as unknown as Parameters<typeof toQmCatalogItem>[0][]).map(toQmCatalogItem);
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
    // Shared helper — the inline copy missed PostgREST's `*` alias for `%`.
    const safe = escapeLikePattern(q);
    const cap = Math.min(Math.max(limit, 1), 200);
    let qb = supabase.from('quartermaster_catalog')
        .select('id, slug, name, category, subcategory, attributes, source, thumbnail_url, wiki_url, created_at, updated_at')
        .ilike('name', `%${safe}%`);
    // Single-org: catalog rows differ only by `source` ('custom' vs 'platform').
    if (source === 'custom') qb = qb.eq('source', 'custom');
    else if (source === 'platform') qb = qb.eq('source', 'platform');
    // 'both' → no source filter (all catalog rows).
    qb = qb.order('source', { ascending: true }).order('name', { ascending: true }).order('id', { ascending: true }).limit(cap);
    const { data, error } = await qb;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to search catalog' });
    return ((data || []) as unknown as Parameters<typeof toQmCatalogItem>[0][]).map(toQmCatalogItem);
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
        .select('id, slug, name, category, subcategory, attributes, source, thumbnail_url, wiki_url, created_at, updated_at')
        .eq('id', catalogId)
        .eq('source', 'custom')
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to get catalog item slice' });
    return data ? toQmCatalogItem(data as unknown as Parameters<typeof toQmCatalogItem>[0]) : null;
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
        .select('id, slug, name, category, subcategory, attributes, source, thumbnail_url, wiki_url, created_at, updated_at')
        .single();
    handleSupabaseError({ error, message: 'Failed to create catalog item' });
    broadcastToOrg('qm:catalog_update', { catalogId: data?.id });
    return toQmCatalogItem(data as unknown as Parameters<typeof toQmCatalogItem>[0]);
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
        .select('id, slug, name, category, subcategory, attributes, source, thumbnail_url, wiki_url, created_at, updated_at')
        .single();
    handleSupabaseError({ error, message: 'Failed to update catalog item' });
    broadcastToOrg('qm:catalog_update', { catalogId: input.id });
    return toQmCatalogItem(data as unknown as Parameters<typeof toQmCatalogItem>[0]);
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
        .select('id, name, type, parent_id, description, sort_order, created_at, updated_at')

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
        .select('id, name, type, parent_id, description, sort_order, created_at, updated_at')
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
        .select('id, name, type, parent_id, description, sort_order, created_at, updated_at')
        .single();
    handleSupabaseError({ error, message: 'Failed to create location' });
    broadcastToOrg('qm:location_update', { locationId: data?.id });
    return toQmLocation(data as unknown as Parameters<typeof toQmLocation>[0]);
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

        .select('id, name, type, parent_id, description, sort_order, created_at, updated_at')
        .single();
    handleSupabaseError({ error, message: 'Failed to update location' });
    broadcastToOrg('qm:location_update', { locationId: input.id });
    return toQmLocation(data as unknown as Parameters<typeof toQmLocation>[0]);
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

const INVENTORY_ROW_COLS = 'id, catalog_id, custom_name, location_id, condition, acquired_at, notes, is_archived, created_at, updated_at';

// The DEFAULT read. Deliberately NOT widened with the facet columns: nothing in
// components/views/quartermaster renders size_label / company_name / quality /
// is_vehicle_item / attributes, and rule 3 is "enumerate exactly what the consumer
// renders". Hosted widens this one instead, which puts an unbounded JSONB on up to
// 1000 rows for zero renderers.
const INVENTORY_SELECT = `
    ${INVENTORY_ROW_COLS},
    catalog:quartermaster_catalog(id, slug, name, category, subcategory, thumbnail_url),
    location:quartermaster_locations(id, name, type)
`;

// FACET-MODE select only. Two things change: the catalog embed becomes an INNER
// join, so a filter on an embedded catalog column restricts the PARENT inventory
// rows instead of merely nulling the embed; and the filtered columns are listed so
// PostgREST can resolve `catalog.<col>` in the filter.
//
// That makes facet mode carry five short scalars and the attributes JSONB that the
// default read does not. Accepted, and genuinely bounded rather than hand-waved:
// syncPlatformItemAttributes and updatePlatformItem BOTH restrict the JSONB to
// FACETABLE_ATTR_KEYS, so it is at most five short strings. Without those caps this
// embed would be an unbounded blob and would not belong here.
//
// Free-text custom_name rows (catalog_id NULL) carry no catalog row and are
// therefore excluded whenever a facet is active — by design, and the reason
// isMiscInclusive exists below.
const INVENTORY_SELECT_FACET = `
    ${INVENTORY_ROW_COLS},
    catalog:quartermaster_catalog!inner(id, slug, name, category, subcategory, thumbnail_url, size_label, company_name, is_vehicle_item, quality, attributes),
    location:quartermaster_locations(id, name, type)
`;

// Count-side inner embed. head:true returns no rows, so this only has to make the
// join and the filtered columns resolvable.
const INVENTORY_COUNT_FACET = 'id, catalog:quartermaster_catalog!inner(id, category, subcategory, size_label, company_name, is_vehicle_item, name, attributes)';

/**
 * The catalog.attributes keys promoted to armoury facets.
 *
 * Populated by syncPlatformItemAttributes from UEX. These five are clean enums; the
 * many numeric spec attributes (Mass, Integrity, …) are deliberately NOT faceted —
 * a facet dropdown of 400 distinct masses is not a filter.
 *
 * This is also the INGEST ALLOWLIST (see syncPlatformItemAttributes), which is what
 * bounds the JSONB rather than merely bounding what is read back out of it.
 */
export const FACETABLE_ATTR_KEYS = ['Grade', 'Class', 'Armor Class', 'Weapon Class', 'Weapon Type'] as const;

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
    // Catalog facets. Each filters the JOINED catalog row through an inner embed,
    // so any active facet restricts results to catalogued stock. Validated at the
    // action layer, never trusted from the payload shape alone.
    category?: QmCatalogCategory | null;
    subcategory?: string | null;
    sizeLabel?: string | null;
    manufacturer?: string | null;
    itemKind?: 'vehicle' | 'personal' | null;
    /** JSONB facets → catalog.attributes @> {...}. Keys validated against FACETABLE_ATTR_KEYS. */
    attributes?: Record<string, string> | null;
    /** Default 1000 (legacy behavior). Set lower for paginated UIs. */
    limit?: number;
    offset?: number;
}

function hasAttrFacets(opts: ListInventoryOptions): boolean {
    return !!opts.attributes && Object.keys(opts.attributes).length > 0;
}

/** Any catalog facet active ⇒ take the INNER-join path. */
function inventoryFacetsActive(opts: ListInventoryOptions): boolean {
    return !!(opts.category || opts.subcategory || opts.sizeLabel || opts.manufacturer || opts.itemKind) || hasAttrFacets(opts);
}

/**
 * 'misc' is the ONE category that must ALSO surface free-text custom stock.
 *
 * Those rows have catalog_id NULL, so the inner-join facet path drops them — which
 * would silently lose every hand-entered item the moment a user picked the category
 * that is supposed to contain them. Only when 'misc' is the SOLE filter (an
 * attribute facet would require a catalog row anyway) do we take the inclusive path.
 */
function isMiscInclusive(opts: ListInventoryOptions): boolean {
    return opts.category === 'misc' && !opts.subcategory && !opts.sizeLabel && !opts.manufacturer && !opts.itemKind && !hasAttrFacets(opts);
}

/**
 * Facet filters as (embedded-column, value) pairs.
 *
 * Shared by listInventory and listInventoryCount so the page and its total apply
 * IDENTICAL filters and cannot disagree — the same read-parity rule that made the
 * original search defect visible as "No inventory yet" rather than as an empty page.
 */
function facetEqPairs(opts: ListInventoryOptions): Array<[string, string | number | boolean]> {
    const pairs: Array<[string, string | number | boolean]> = [];
    if (opts.category) pairs.push(['catalog.category', opts.category]);
    if (opts.subcategory) pairs.push(['catalog.subcategory', opts.subcategory]);
    if (opts.sizeLabel) pairs.push(['catalog.size_label', opts.sizeLabel]);
    if (opts.manufacturer) pairs.push(['catalog.company_name', opts.manufacturer]);
    if (opts.itemKind === 'vehicle') pairs.push(['catalog.is_vehicle_item', true]);
    else if (opts.itemKind === 'personal') pairs.push(['catalog.is_vehicle_item', false]);
    return pairs;
}

/**
 * Search resolution for FACET mode — and the reason it is a separate function.
 *
 * The non-facet path resolves matching catalog ids into a CAPPED `catalog_id.in.(…)`
 * list. Reusing that under a facet would resolve the id window WITHOUT the facet
 * constraint, so a broad term plus a facet could return zero rows while matches
 * exist past the cap — reproducing the exact "empty state for stock that exists"
 * bug this whole item is fixing. In facet mode the inner join already excludes
 * catalog-less rows, so the term can go straight at catalog.name, UNCAPPED.
 */
function facetSearchIlike(search: string | undefined): { ilike?: string; matchNothing?: boolean } {
    const raw = String(search ?? '').trim();
    if (!raw) return {};
    const term = safeSearchTerm(raw);
    if (!term) return { matchNothing: true };
    return { ilike: `%${escapeLikePattern(term)}%` };
}

/**
 * Ceiling on how many catalog ids one search term may expand into. A broad term on a large
 * platform catalogue would otherwise build an unbounded `catalog_id.in.(...)` list and put it
 * in a URL.
 */
const CATALOG_SEARCH_MATCH_CAP = 500;

/**
 * The armoury search filter, as a PostgREST `.or()` expression.
 *
 * THE DEFECT THIS FIXES. Both list and count matched `custom_name` ONLY. Every row created
 * through "Add Stock -> From Catalog" has `custom_name IS NULL` (createInventoryItem writes
 * `input.customName?.trim() || null`, and the modal sends null for the catalog path), and
 * `NULL ILIKE '%rifle%'` is NULL — so the row is excluded. Catalog-sourced stock, which is the
 * DEFAULT way to add stock, could not be found by name at all.
 *
 * The old comment claimed "catalog-name search is handled client-side on the visible page".
 * It was not: QmArmoryTab client-filters by CATEGORY only. The comment was itself part of the
 * defect, which is why it is deleted rather than worked around.
 *
 * PostgREST cannot OR across an embedded table, so the catalog half is resolved in a separate
 * read and folded in as an id set.
 *
 * TERM SANITISATION CHANGES BEHAVIOUR — read this before "fixing" it back. The term now lands
 * inside a raw `.or()` grammar, where a comma, dot or parenthesis is STRUCTURE and an
 * under-escaped term injects sibling conditions. So it must go through safeSearchTerm (an
 * allow-list) and not escapeLikePattern (which escapes metacharacters but passes everything
 * else through). The cost is real and deliberate: a name with punctuation ("A.C.E.") is
 * stripped to "ACE" and no longer matches literally. That is the correct trade against
 * injecting into an OR grammar, and it is the same term treatment getPlatformItemCatalog
 * already uses for exactly this reason.
 */
async function buildInventorySearchOr(rawSearch: string | undefined): Promise<string | null> {
    // No search supplied => no filter. But a term the user DID type that sanitises away to
    // nothing (say "%%%") must match NOTHING rather than falling through to an unfiltered
    // query — otherwise a garbage search reveals the entire armoury.
    if (!String(rawSearch ?? '').trim()) return null;
    const term = safeSearchTerm(rawSearch);
    if (!term) return 'id.eq.0';   // ids are always > 0, so this matches nothing
    // Belt and braces for the .ilike() leg below. safeSearchTerm's allow-list already removes
    // the LIKE wildcards, so this escape is a no-op today — but tests/likeEscapeSweep.test.ts
    // holds an ABSOLUTE rule that every %…% ilike is fed by escapeLikePattern, and keeping it
    // absolute is worth more than the one call it saves. It also keeps this correct if that
    // allow-list is ever widened.
    //
    // Deliberate asymmetry: the .or() legs use the UNESCAPED term, because a backslash inside
    // a PostgREST .or() grammar string is not something to rely on unverified. The only
    // observable difference is that a typed '_' is a single-char wildcard on the custom_name
    // leg and literal on the catalog leg — a UNION, so the user gets more rows, never fewer.
    const likeTerm = escapeLikePattern(term);

    // DETERMINISTIC. listInventory and listInventoryCount resolve this independently, so
    // without a total order a term matching more than the cap could hand the two queries
    // different 500-id windows and desync the page from its own total.
    const { data: catRows, error } = await supabase.from('quartermaster_catalog')
        .select('id')
        .ilike('name', `%${likeTerm}%`)
        .order('id', { ascending: true })
        .limit(CATALOG_SEARCH_MATCH_CAP);
    if (error && error.code !== '42P01') {
        handleSupabaseError({ error, message: 'Failed to resolve catalog matches for search' });
    }
    const catalogIds = ((catRows || []) as Array<{ id: number }>).map((r) => r.id);

    const parts = [`custom_name.ilike.%${term}%`];
    if (catalogIds.length) parts.push(`catalog_id.in.(${catalogIds.join(',')})`);
    return parts.join(',');
}

/**
 * OR-filter for the misc-inclusive path: catalog-less custom rows OR catalog rows
 * whose category is 'misc'. Folds the optional search term into BOTH branches, and
 * is shared by the list and the count so their filters stay identical.
 */
async function buildMiscInclusiveOr(rawSearch: string | undefined): Promise<string> {
    const raw = String(rawSearch ?? '').trim();
    const term = raw ? safeSearchTerm(raw) : '';
    if (raw && !term) return 'id.eq.0'; // typed but nothing usable survived ⇒ match nothing
    let cq = supabase.from('quartermaster_catalog')
        .select('id')
        .eq('category', 'misc');
    if (term) cq = cq.ilike('name', `%${escapeLikePattern(term)}%`);
    cq = cq.order('source', { ascending: true }).order('id', { ascending: true }).limit(CATALOG_SEARCH_MATCH_CAP);
    const { data: catRows, error } = await cq;
    if (error && error.code !== '42P01') handleSupabaseError({ error, message: 'Failed to resolve misc catalog matches' });
    const catalogIds = ((catRows || []) as Array<{ id: number }>).map((r) => r.id);
    const nullBranch = term ? `and(catalog_id.is.null,custom_name.ilike.%${term}%)` : 'catalog_id.is.null';
    const parts = [nullBranch];
    if (catalogIds.length) parts.push(`catalog_id.in.(${catalogIds.join(',')})`);
    return parts.join(',');
}

// NOTE ON THE TWO-STATEMENT SELECT BELOW, and on comment placement.
//
// The facet path needs a DIFFERENT select string (the !inner embed). It is written
// as two adjacent statements rather than `select(facetsActive ? A : B)` because the
// wildcard ratchet cannot resolve a ternary select argument and treats it as
// unverifiable. And the two statements must stay ADJACENT: the order ratchet
// attaches a builder's later `.order()/.range()` to its select by scanning a
// 300-character window behind it for `let q = supabase`, so prose or code inserted
// between them silently detaches the follow-on and turns a capped read into a
// baseline violation with no visible change. Keep explanation above the declaration.
export async function listInventory(opts: ListInventoryOptions = {}): Promise<QmInventoryItem[]> {
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 1000);
    const offset = clampListOffset(opts.offset);
    const miscInclusive = isMiscInclusive(opts);
    const facetsActive = !miscInclusive && inventoryFacetsActive(opts);
    let q = supabase.from('quartermaster_inventory').select(INVENTORY_SELECT);
    if (facetsActive) q = supabase.from('quartermaster_inventory').select(INVENTORY_SELECT_FACET);
    if (!opts.includeArchived) q = q.eq('is_archived', false);
    if (opts.locationId != null) q = q.eq('location_id', opts.locationId);
    if (opts.catalogId != null) q = q.eq('catalog_id', opts.catalogId);
    // THREE branches, and exactly one .or() per builder — two .or() calls on the
    // same builder AND together rather than OR, which would quietly return nothing.
    if (miscInclusive) {
        q = q.or(await buildMiscInclusiveOr(opts.search));
    } else if (facetsActive) {
        for (const [col, val] of facetEqPairs(opts)) q = q.eq(col, val);
        if (hasAttrFacets(opts)) q = q.contains('catalog.attributes', opts.attributes as Record<string, string>);
        const fs2 = facetSearchIlike(opts.search);
        if (fs2.matchNothing) q = q.eq('id', 0);
        else if (fs2.ilike) q = q.ilike('catalog.name', fs2.ilike);
    } else {
        const searchOr = await buildInventorySearchOr(opts.search);
        if (searchOr) q = q.or(searchOr);
    }
    // created_at is not unique (a bulk intake writes many rows in one statement),
    // so page over it alone and offsets can skip or repeat rows. id is the bigint
    // PK — a total order, which exportInventoryCsv's paging depends on.
    q = q.order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load inventory' });
    const items = ((data || []) as unknown as Parameters<typeof toQmInventoryItem>[0][]).map(toQmInventoryItem);
    if (items.length === 0) return items;

    const ids = items.map((i) => i.id);

    // Aggregate movements (only for the rows we actually returned — caps the
    // aggregation cost regardless of total inventory size). Shared, fail-closed
    // read: this list also backs exportInventoryCsv, so a discarded error here
    // used to write 0 into every quantity_on_hand cell of an inventory audit.
    const movements = await readInventoryOnHand(ids);
    if (!movements) {
        // Pre-migration window: no movement ledger exists, so there genuinely is
        // no stock history to sum. Report the rows rather than failing the whole
        // armory list — the same call the inventory read's own 42P01 branch makes.
        log.warn('inventory list: movements table not present — quantities reported as 0');
    }
    const onHand = movements || new Map<number, number>();

    // Aggregate active issuances — same scope. Fail closed for the same reason:
    // quantity_on_issue is a column of the audit CSV, so a silent 0 here is a
    // false record, not a dimmed badge.
    const { data: issuances, error: issErr } = await supabase.from('quartermaster_issuances')
        .select('inventory_id, quantity')
        .in('inventory_id', ids)
        .eq('status', 'active');
    if (issErr && issErr.code === '42P01') {
        log.warn('inventory list: issuances table not present — on-issue reported as 0');
    } else {
        handleSupabaseError({ error: issErr, message: 'Failed to load active issuances for inventory' });
    }
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

const EMPTY_FACETS: QmArmouryFacets = {
    categories: [], types: [], sizes: [], manufacturers: [],
    hasVehicle: false, hasPersonal: false, attributes: {},
};

/**
 * Facet options for the armoury filters.
 *
 * ONE SQL aggregate, matching the move already made for the overview: the
 * alternative — fetch the inventory into Node and fold it — is a full-table read
 * whose answer is silently capped by whatever page size the caller used, so a facet
 * value would simply be missing from the dropdown for stock the org owns.
 *
 * Derived from stock ON HAND, not from the whole catalogue: a dropdown of every
 * manufacturer in Star Citizen is a list, not a filter.
 *
 * Soft-fails to empty rather than throwing. A missing function (the pre-apply
 * window) or a read fault costs the DROPDOWNS, which are an affordance; the list
 * itself is a separate read with its own error handling, and taking the whole
 * armoury down because a filter menu could not be populated is the wrong trade.
 */
export async function getArmoryFacets(opts: { includeArchived?: boolean } = {}): Promise<QmArmouryFacets> {
    const { data, error } = await supabase.rpc('qm_armoury_facets', { p_include_archived: !!opts.includeArchived });
    if (error) {
        log.warn('armoury facets unavailable', { code: error.code, message: error.message });
        return EMPTY_FACETS;
    }
    const raw = (data || {}) as Partial<Record<keyof QmArmouryFacets, unknown>>;
    const strList = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    const attrs: Record<string, string[]> = {};
    const rawAttrs = raw.attributes;
    if (rawAttrs && typeof rawAttrs === 'object' && !Array.isArray(rawAttrs)) {
        for (const [k, v] of Object.entries(rawAttrs as Record<string, unknown>)) {
            // Belt and braces with the SQL allowlist. The function filters to the same
            // set, but this is the boundary the client actually reads, and a key that
            // reached the JSONB some other way must not become a facet by surprise.
            if (!(FACETABLE_ATTR_KEYS as readonly string[]).includes(k)) continue;
            const vals = strList(v);
            if (vals.length) attrs[k] = vals;
        }
    }
    return {
        categories: strList(raw.categories),
        types: strList(raw.types),
        sizes: strList(raw.sizes),
        manufacturers: strList(raw.manufacturers),
        hasVehicle: raw.hasVehicle === true,
        hasPersonal: raw.hasPersonal === true,
        attributes: attrs,
    };
}

/** Cheap count for paginators / stat cards — no row payload. */
export async function listInventoryCount(opts: ListInventoryOptions = {}): Promise<number> {
    const miscInclusive = isMiscInclusive(opts);
    const facetsActive = !miscInclusive && inventoryFacetsActive(opts);
    let q = supabase.from('quartermaster_inventory').select('id', { count: 'exact', head: true });
    if (facetsActive) q = supabase.from('quartermaster_inventory').select(INVENTORY_COUNT_FACET, { count: 'exact', head: true });
    if (!opts.includeArchived) q = q.eq('is_archived', false);
    if (opts.locationId != null) q = q.eq('location_id', opts.locationId);
    if (opts.catalogId != null) q = q.eq('catalog_id', opts.catalogId);
    // MUST stay byte-for-byte the same branches as listInventory's, or the pager's
    // total disagrees with its own page.
    if (miscInclusive) {
        q = q.or(await buildMiscInclusiveOr(opts.search));
    } else if (facetsActive) {
        for (const [col, val] of facetEqPairs(opts)) q = q.eq(col, val);
        if (hasAttrFacets(opts)) q = q.contains('catalog.attributes', opts.attributes as Record<string, string>);
        const fs2 = facetSearchIlike(opts.search);
        if (fs2.matchNothing) q = q.eq('id', 0);
        else if (fs2.ilike) q = q.ilike('catalog.name', fs2.ilike);
    } else {
        const searchOr = await buildInventorySearchOr(opts.search);
        if (searchOr) q = q.or(searchOr);
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
    if (!row) throw new Error('Failed to create inventory item');

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
        ...toQmInventoryItem(row as unknown as Parameters<typeof toQmInventoryItem>[0]),
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

/**
 * Set an inventory row to an ABSOLUTE on-hand total.
 *
 * The point of this function is what it does NOT do: it never computes a delta on the
 * client. AdjustStockDialog's "Set total" mode used to send (target - onHand) where
 * onHand came from a snapshot frozen when the dialog opened, so two managers each
 * correcting 10 -> 8 both sent -2 and the row landed on 6. qm_set_inventory_total does
 * the subtraction inside the transaction under the same FOR UPDATE lock every other
 * qm_* writer takes, which is the only place it can be correct.
 *
 * Delta mode is race-free by construction and still goes through adjustInventoryStock.
 */
export async function setInventoryTotal(
    actorUserId: number,
    input: { inventoryId: number; targetTotal: number; reason: 'adjust' | 'loss' | 'destruction'; notes?: string | null },
): Promise<void> {
    const target = Math.trunc(Number(input.targetTotal));
    if (!Number.isFinite(target) || target < 0) {
        throw new Error('Target total must be a non-negative integer.');
    }
    if (target > MAX_STOCK_TOTAL) {
        throw new Error(`Target total must not exceed ${MAX_STOCK_TOTAL}.`);
    }
    const { error } = await supabase.rpc('qm_set_inventory_total', {
        p_inventory_id: input.inventoryId,
        p_target_total: target,
        p_reason: input.reason,
        p_actor_id: actorUserId,
        p_notes: input.notes ?? null,
    });
    handleSupabaseError({ error, message: 'Failed to set stock total' });
    broadcastToOrg('qm:inventory_update', { inventoryId: input.inventoryId });
}

// ---------------------------------------------------------------------------
// Issuances
// ---------------------------------------------------------------------------

const ISSUANCE_SELECT = `
    id, inventory_id, issued_to_user_id, quantity, status, requested_at, issued_at, due_back_at, returned_at, returned_quantity, outcome, requested_by_user_id, issued_by_user_id, closed_by_user_id, notes, operation_id, created_at, updated_at,
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
    q = q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
    const { data, error } = await q;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load issuances' });
    return ((data || []) as unknown as Parameters<typeof toQmIssuance>[0][]).map(toQmIssuance);
}

/**
 * Inventory ids per on-hand request. PostgREST serialises .in() into the request
 * URI, so a few thousand bigint ids overflow the gateway limit (HTTP 414) — same
 * bound, same reason, as DELETE_CHUNK in lib/db/notifications.ts.
 */
const ONHAND_ID_CHUNK = 500;

/**
 * SUM(delta) per inventory row from the append-only movement log — the ONE read
 * that answers "how much is on hand". Every caller goes through here so the
 * over-issue guard, the armory list and the low-stock card cannot drift.
 *
 * FAIL CLOSED on the read itself. On-hand is summed ONLY from this log, so "no
 * rows" does not mean "no stock", it means "we don't know". Two callers used to
 * discard the error (`const { data: movements } = …`), which left every scanned
 * row summing to 0 and published a fabricated zero-stock alarm on the overview
 * card plus a 0 in every quantity_on_hand cell of the qm:export_csv inventory
 * audit — a wrong answer presented as fact, which is worse than a missing card.
 *
 * Returns null ONLY for 42P01 — the movement table does not exist yet, i.e. a
 * pre-migration deploy window in which there is no ledger at all. Each caller
 * renders that its own way; anything that must fail closed on a missing table
 * treats null as a throw.
 */
async function readInventoryOnHand(inventoryIds: number[]): Promise<Map<number, number> | null> {
    const map = new Map<number, number>();
    if (!inventoryIds.length) return map;
    for (let i = 0; i < inventoryIds.length; i += ONHAND_ID_CHUNK) {
        const chunk = inventoryIds.slice(i, i + ONHAND_ID_CHUNK);
        const { data, error, count } = await supabase.from('quartermaster_inventory_movements')
            .select('inventory_id, delta', { count: 'exact' })
            .in('inventory_id', chunk);
        if (error && error.code === '42P01') return null;
        handleSupabaseError({ error, message: 'Failed to compute on-hand quantity' });
        const rows = (data || []) as { inventory_id: number; delta: number }[];
        // PostgREST enforces its own server-side max-rows and returns a SHORT
        // response with NO error. Summing a half-read log understates on-hand —
        // the same fabricated zero arriving by a different door — so compare the
        // exact count against what actually landed and refuse to answer instead.
        if (typeof count === 'number' && rows.length < count) {
            throw new Error('Failed to compute on-hand quantity: the movement log was truncated by the server row cap');
        }
        for (const m of rows) {
            map.set(m.inventory_id, (map.get(m.inventory_id) || 0) + Number(m.delta));
        }
    }
    return map;
}

/**
 * Computes current on-hand (SUM of movement deltas) for one or more inventory
 * rows. Backs the over-issue guard on the issuance write paths below.
 *
 * The stored procs (schema.sql qm_fulfil_issuance / qm_issue_direct) are the
 * authoritative, transaction-safe backstop and MUST raise QM_INSUFFICIENT_STOCK
 * themselves (mirroring warehouse_fulfil_request / warehouse_adjust_stock). This
 * TS-layer pre-check fails closed before the RPC so a member-created 'requested'
 * issuance with an arbitrary quantity can't drive quantityOnHand negative
 * (silent ledger corruption), gives a friendlier error, and is unit-pinnable in
 * the DB-less test harness.
 */
async function getInventoryOnHandMap(inventoryIds: number[]): Promise<Map<number, number>> {
    const map = await readInventoryOnHand(inventoryIds);
    // A missing movement ledger is not evidence of available stock — the guard
    // must not read it as "plenty", so treat it exactly like a read failure.
    if (!map) throw new Error('Failed to compute on-hand quantity');
    return map;
}

async function assertSufficientOnHand(inventoryId: number, quantity: number): Promise<void> {
    const onHand = (await getInventoryOnHandMap([inventoryId])).get(inventoryId) || 0;
    if (onHand - quantity < 0) {
        throw new Error(`QM_INSUFFICIENT_STOCK: have ${onHand}, need ${quantity}`);
    }
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
    return toQmIssuance(data as unknown as Parameters<typeof toQmIssuance>[0]);
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
    return data ? toQmIssuance(data as unknown as Parameters<typeof toQmIssuance>[0]) : null;
}

export async function fulfilIssuance(
    actorUserId: number,
    issuanceId: number,
): Promise<boolean> {
    // Tenant scope check. inventory_id rides the select so the stock
    // companion broadcast below can carry it (clients then refresh only the
    // affected armory row/page instead of everything).
    const { data: row, error: scopeErr } = await supabase.from('quartermaster_issuances')
        .select('id, status, inventory_id, quantity')
        .eq('id', issuanceId)

        .maybeSingle();
    handleSupabaseError({ error: scopeErr, message: 'Failed to load issuance' });
    if (!row) throw new Error('Issuance not found.');
    if (row.status !== 'requested') return false;

    // Fail closed before posting the negative 'issue' movement so a poison
    // 'requested' issuance (qm:request lets a member pick the quantity) can't
    // drive on-hand negative when fulfilled. The proc is the hard backstop.
    await assertSufficientOnHand(row.inventory_id, Number(row.quantity));

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

    const qty = Math.trunc(Number(input.quantity));
    // Fail closed on over-issue before posting the negative movement (proc backstop).
    await assertSufficientOnHand(input.inventoryId, qty);

    const { data, error } = await supabase.rpc('qm_issue_direct', {
        p_inventory_id: input.inventoryId,
        p_issued_to: input.issuedToUserId,
        p_quantity: qty,
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

    // Fail closed on over-issue BEFORE the proc posts the negative movements.
    // Sum the required quantity PER inventory id (a kit may list the same row on
    // more than one line) and reject if any item's total draw would drive its
    // on-hand (SUM of movement deltas) negative. Mirrors the single-row pre-checks
    // on fulfilIssuance / issueDirect. The qm_issue_bulk proc additionally
    // re-checks per line inside its transaction as the authoritative backstop
    // (see schema.sql qm_issue_direct / qm_issue_bulk).
    const requiredByInventoryId = new Map<number, number>();
    for (const l of input.lines) {
        requiredByInventoryId.set(
            l.inventoryId,
            (requiredByInventoryId.get(l.inventoryId) || 0) + Math.trunc(Number(l.quantity)),
        );
    }
    const onHandByInventoryId = await getInventoryOnHandMap(invIds);
    for (const [id, required] of requiredByInventoryId) {
        const onHand = onHandByInventoryId.get(id) || 0;
        if (onHand - required < 0) {
            throw new Error(`QM_INSUFFICIENT_STOCK: inventory ${id} has ${onHand}, need ${required}`);
        }
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

    const issuances = ((data || []) as unknown as Parameters<typeof toQmIssuance>[0][]).map(toQmIssuance);
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
    // So: fetch the movements for those rows through the shared, fail-closed
    // readInventoryOnHand, sum in JS, then take the bottom-N by qty_on_hand.
    // Movements are an append-only log so this is unbounded over time, but per
    // org it is typically O(thousands) of rows even for active orgs — cheaper
    // than shipping the whole inventory.
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

    // FAIL CLOSED. This card's entire purpose is to be believed, and on-hand is
    // summed ONLY from the movement log — so a read fault must not resolve to an
    // empty map, which used to make every scanned row sum to 0, pass the
    // `<= threshold` filter and fill the card with fabricated out-of-stock items.
    const onHand = await readInventoryOnHand(ids);
    if (!onHand) {
        log.warn('low-stock scan: movements table not present — reporting no low stock rather than a false alarm');
        return [];
    }

    // Display-only, unlike on-hand: quantityOnIssue is neither the filter
    // predicate nor the sort key, so a fault here can dim the On-issue badge but
    // can never create or hide a low-stock row. Degrade instead of failing the
    // card. (listInventory throws on the same read because it feeds the audit CSV.)
    const { data: issuances, error: issErr } = await supabase
        .from('quartermaster_issuances')
        .select('inventory_id, quantity')
        .in('inventory_id', ids)
        .eq('status', 'active');
    if (issErr) log.warn('low-stock scan: active-issuance read failed; On-issue badges will read 0', { err: issErr });
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

// Two concerns, applied in order (mirrors finances.ts csvEscape):
//  1. Formula injection (OWASP CSV-injection): a cell beginning with = + - @
//     (or a leading TAB/CR some apps strip before evaluating the next char) is
//     auto-evaluated as a formula by Excel/LibreOffice/Sheets. The user-controlled
//     name (custom_name) and notes columns are stored verbatim by
//     createInventoryItem/updateInventoryItem, so neutralize at the output
//     boundary by prefixing a single quote — apps then render the cell as literal
//     text and never execute it.
//  2. Quote-wrapping: preserve the existing RFC-4180 escaping for cells that
//     contain a delimiter/quote/newline.
export function csvEscapeQm(value: unknown): string {
    if (value === null || value === undefined) return '';
    let str = String(value);
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
    return str;
}

/** Rows an inventory export may reach before it stops and says so in the file. */
const MAX_INVENTORY_EXPORT_ROWS = 10000;
/** Rows per export round-trip — listInventory's own hard clamp. */
const INVENTORY_EXPORT_PAGE = 1000;
/**
 * Round-trips an export may make. Reaching the row ceiling needs 11 at full
 * pages, so this only fires when the server is handing back pages far smaller
 * than requested — in which case the export cannot be completed and the file is
 * marked truncated rather than the database hammered.
 */
const INVENTORY_EXPORT_MAX_PAGES = 32;

/**
 * Inventory CSV. This used to be a single listInventory() call, which clamps at
 * 1000 rows, and QmArmoryTab has no way to page — so an org past 1000 SKUs got
 * an "inventory audit" that was quietly the newest 1000 items with nothing in
 * the file saying so. Same defect as the ledger export: it pages to its own
 * ceiling and marks truncation IN THE FILE, because a server log the auditor
 * never sees does not fix a partial export that looks complete.
 */
export async function exportInventoryCsv(): Promise<string> {
    const rows: QmInventoryItem[] = [];
    let truncated = false;
    for (let offset = 0, pages = 0; ; pages++) {
        if (pages >= INVENTORY_EXPORT_MAX_PAGES) { truncated = true; break; }
        const page = await listInventory({ includeArchived: false, limit: INVENTORY_EXPORT_PAGE, offset });
        if (page.length === 0) break;
        rows.push(...page);
        // Advance by rows RECEIVED: PostgREST enforces its own server-side
        // max-rows and returns a SHORT page with no error, so a short page must
        // not be mistaken for the end of the inventory.
        offset += page.length;
        // Strictly GREATER than the ceiling: an inventory of exactly
        // MAX_INVENTORY_EXPORT_ROWS costs one more (empty) round-trip but is not
        // mislabelled as truncated.
        if (rows.length > MAX_INVENTORY_EXPORT_ROWS) {
            rows.splice(MAX_INVENTORY_EXPORT_ROWS);
            truncated = true;
            break;
        }
    }
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
        ].map(csvEscapeQm).join(','));
    }

    if (truncated) {
        log.warn('inventory CSV export hit its row ceiling — the file is a partial (newest-first) window', { ceiling: MAX_INVENTORY_EXPORT_ROWS, exported: rows.length });
        // Full-width so the file stays rectangular through a spreadsheet import,
        // and LAST so rows 1..N remain a clean, parseable inventory.
        const notice = new Array(header.length).fill('');
        notice[0] = `** TRUNCATED — this export contains only the ${rows.length} most recently added items (ceiling ${MAX_INVENTORY_EXPORT_ROWS}). Older items are NOT included. Archive stock you no longer need to audit. **`;
        lines.push(notice.map(csvEscapeQm).join(','));
    }
    return lines.join('\n');
}

export interface ItemAttributesSyncResult {
    categoriesScanned: number;
    itemsUpdated: number;
    itemErrors: number;
    attributesKept: number;
    fetchErrors: Array<{ categoryId: number; categoryName: string; message: string }>;
}

/**
 * Populate quartermaster_catalog.attributes from the UEX /items_attributes EAV
 * endpoint, matched on external_id (= UEX id_item).
 *
 * Independent of syncPlatformItemCatalog, which deliberately does not touch the
 * column — so the two can run in either order and an item re-sync never wipes what
 * this collected.
 *
 * THE FOLD IS AN ALLOWLIST, not a passthrough. `attribute_name` is an unvalidated
 * upstream string used as an OBJECT KEY, and UEX ships hundreds of numeric spec
 * attributes per item. Taking them all would put an unbounded JSONB on every catalog
 * row, make the SQL facet scan walk it, and — since the facet embed ships the column
 * — put it on the wire. Only FACETABLE_ATTR_KEYS is ever read back, so only
 * FACETABLE_ATTR_KEYS is ever written. That is what makes "bounded" true rather than
 * merely claimed.
 *
 * Uncapped by category count, matching syncPlatformItemCatalog rather than hosted's
 * cursor-chunked variant: this build's sync is a single admin-triggered pass and the
 * chunking scaffolding is not ported.
 */
export async function syncPlatformItemAttributes(): Promise<ItemAttributesSyncResult> {
    const allCategories = await fetchUexCategories();
    const itemCategories = allCategories.filter((c) => c.type === 'item');

    const fetchErrors: ItemAttributesSyncResult['fetchErrors'] = [];
    const byItem = new Map<number, Record<string, string>>();
    let attributesKept = 0;

    for (const c of itemCategories) {
        let rows: Awaited<ReturnType<typeof fetchUexItemAttributesForCategory>>;
        try {
            rows = await fetchUexItemAttributesForCategory(c.id);
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            fetchErrors.push({ categoryId: c.id, categoryName: c.name, message });
            log.warn('item attributes category fetch failed', { categoryId: c.id, message });
            continue;
        }
        for (const a of rows) {
            if (a.id_item == null || !a.attribute_name) continue;
            if (!(FACETABLE_ATTR_KEYS as readonly string[]).includes(a.attribute_name)) continue;
            // Same treatment every other UEX display string gets: markup-stripped and
            // length-capped on ingest, because these render in a dropdown.
            const value = stripHtmlSingleLine(a.value == null ? '' : String(a.value), 60);
            if (!value) continue;
            let m = byItem.get(a.id_item);
            if (!m) { m = {}; byItem.set(a.id_item, m); }
            m[a.attribute_name] = value;
            attributesKept++;
        }
    }

    // Update each platform row, matched on external_id + source so a custom row with
    // a colliding id can never be rewritten by an upstream sweep.
    const entries = [...byItem.entries()];
    const CHUNK = 25;
    let itemsUpdated = 0;
    let itemErrors = 0;
    for (let i = 0; i < entries.length; i += CHUNK) {
        const slice = entries.slice(i, i + CHUNK);
        const results = await Promise.all(slice.map(async ([externalId, attrs]) => {
            const { error } = await supabase.from('quartermaster_catalog')
                .update({ attributes: attrs, updated_at: new Date().toISOString() })
                .eq('external_id', externalId)
                .eq('source', 'platform');
            return !error;
        }));
        for (const ok of results) { if (ok) itemsUpdated++; else itemErrors++; }
    }

    log.info('platform item attributes synced', {
        categoriesScanned: itemCategories.length, itemsUpdated, itemErrors, attributesKept,
    });
    return { categoriesScanned: itemCategories.length, itemsUpdated, itemErrors, attributesKept, fetchErrors };
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
        .select('id, uex_category_id, uex_category_name, uex_section, display_name, sort_order, is_hidden, created_at, updated_at')
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
        .select('id', { count: 'exact', head: true })
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
    let qb = supabase.from('quartermaster_catalog').select('id, slug, name, category, subcategory, attributes, thumbnail_url, wiki_url, external_uuid, external_id, is_vehicle_item, is_commodity, is_harvestable, screenshot_url, store_url, company_name, vehicle_name, quality, size_label, color, color2, game_version, platform_category_id, last_synced_at, created_at, updated_at').eq('source', 'platform');
    if (opts.search && opts.search.trim()) {
        const safe = safeSearchTerm(opts.search); // allow-list before .or()
        if (safe) qb = qb.or(`name.ilike.%${safe}%,subcategory.ilike.%${safe}%,company_name.ilike.%${safe}%`);
    }
    if (opts.platformCategoryId != null) qb = qb.eq('platform_category_id', opts.platformCategoryId);
    if (opts.hideVehicleItems) qb = qb.eq('is_vehicle_item', false);
    qb = qb.order('name', { ascending: true }).order('id', { ascending: true }).range(offset, offset + limit - 1);
    const { data, error } = await qb;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load platform item catalog' });
    return ((data || []) as unknown as Parameters<typeof toQmPlatformItem>[0][]).map(toQmPlatformItem);
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
    let qb = supabase.from('quartermaster_catalog').select('id', { count: 'exact', head: true }).eq('source', 'platform');
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

// Identity/sync-key fields must not be admin-editable. Overwriting any of these
// would corrupt the UEX re-sync (external_uuid is the onConflict upsert key) and
// the org-import FK remap (external_uuid/external_id are the catalog-match keys),
// creating duplicate/orphan rows or mis-resolved references. This is a deny-list
// mirroring warehouse's COMMODITY_PROTECTED_FIELDS — the operator-editable
// display columns (name/category/subcategory/attributes/flags/links/etc.) are
// intentionally NOT listed and flow through unchanged.
/**
 * Shape-check an admin-supplied attributes JSONB.
 *
 * catalog:update_item copies every non-protected key straight through, and
 * `attributes` is deliberately NOT protected (an operator may want to correct a bad
 * upstream value). But that makes the admin the SECOND writer of a column the ingest
 * carefully bounds, and it now feeds a SQL facet scan and a wire projection. So the
 * same allowlist applies on both paths — otherwise the ingest caps are trivially
 * bypassable by the same person, and "bounded JSONB" stops being true.
 */
function sanitizeCatalogAttributes(v: unknown): Record<string, string> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!(FACETABLE_ATTR_KEYS as readonly string[]).includes(k)) continue;
        const s = stripHtmlSingleLine(typeof val === 'string' ? val : String(val ?? ''), 60);
        if (s) out[k] = s;
    }
    return out;
}

const QM_PLATFORM_PROTECTED_FIELDS = new Set([
    'id', 'source', 'created_at', 'slug', 'external_uuid', 'external_id', 'last_synced_at',
]);

export async function updatePlatformItem(id: number, patch: Record<string, unknown>) {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
        if (QM_PLATFORM_PROTECTED_FIELDS.has(k)) continue;
        // The admin is the SECOND writer of the facet JSONB — see sanitizeCatalogAttributes.
        safe[k] = k === 'attributes' ? sanitizeCatalogAttributes(v) : v;
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
        .select('id', { count: 'exact', head: true })
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
