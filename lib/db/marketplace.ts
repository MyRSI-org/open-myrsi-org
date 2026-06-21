// =============================================================================
// lib/db/marketplace.ts — single-org internal marketplace
// =============================================================================
// Members post listings (items + services; sell/buy/offer/request), negotiate
// contracts through a lifecycle (propose → accept → deliver → confirm →
// complete, + cancel), optionally reserve/move real warehouse stock, and rate
// each other. SINGLE-ORG: there is no organization_id; the ONLY authorization
// boundary is per-user OWNERSHIP / contract PARTY membership — every mutation
// re-fetches the row and asserts the caller may act on it (the actor id is
// server-injected by api/services.ts, never client-supplied). Reads enumerate
// columns (no wildcard) and embeds expose only public member fields.

import { supabase, handleSupabaseError, broadcastToOrg } from './common.js';
import { escapeLikePattern } from '../pgrest.js';
import { stripHtml, stripHtmlSingleLine } from '../textSanitize.js';
import { log as baseLog } from '../log.js';
import { sendPushToUsers } from '../push.js';

// Coerce a UEC amount to a finite, non-negative, in-range integer (or null).
// Rejects negatives / NaN / Infinity / over-range so a collusive contract or
// listing can't skew the ledger/leaderboard with absurd or negative values. The
// column is bigint; we stay within JS safe-int range.
function clampUec(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}
import type {
    MarketplaceCategory, MarketplaceListing, MarketplaceContract, MarketplaceMilestone,
    MarketplaceRating, MarketplaceReputation, MarketplaceTrader, MarketplaceTraderProfile,
    MarketplaceListingType, MarketplaceReport,
} from '../../types.js';

const log = baseLog.child({ module: 'db.marketplace' });
const nowIso = () => new Date().toISOString();

// --- generic, no-existence-disclosure errors (BOLA) ---
const ERR_LISTING = 'Listing not found or access denied.';
const ERR_CONTRACT = 'Contract not found or access denied.';

// =============================================================================
// Selects (explicit columns + public-only embeds — no wildcard, no PII)
// =============================================================================
const TRADER_FIELDS = 'id, name, rsi_handle, avatar_url';
const LISTING_SELECT =
    'id, seller_id, kind, listing_type, category_id, title, description, quantity, quantity_claimed, price_uec, price_type, location, tags, status, expires_at, warehouse_stock_id, created_at, updated_at, ' +
    `seller:users!marketplace_listings_seller_id_fkey(${TRADER_FIELDS}), category:marketplace_categories(name, icon)`;
const CONTRACT_SELECT =
    'id, listing_id, seller_id, buyer_id, kind, title, quantity, agreed_price_uec, terms_note, status, proposed_by_id, cancel_reason, warehouse_stock_id, proposed_at, accepted_at, delivered_at, completed_at, cancelled_at, created_at, updated_at, ' +
    `seller:users!marketplace_contracts_seller_id_fkey(${TRADER_FIELDS}), buyer:users!marketplace_contracts_buyer_id_fkey(${TRADER_FIELDS})`;
const RATING_SELECT =
    `id, contract_id, rater_id, ratee_id, rater_role, stars, feedback, created_at, rater:users!marketplace_ratings_rater_id_fkey(${TRADER_FIELDS})`;

// =============================================================================
// Row shapes + mappers (marketplace tables are not yet in the generated types)
// =============================================================================
type TraderEmbed = { id: number; name: string; rsi_handle: string | null; avatar_url: string | null } | null;
const toTrader = (e: TraderEmbed | TraderEmbed[]): MarketplaceTrader | undefined => {
    const r = Array.isArray(e) ? e[0] : e;
    return r ? { id: r.id, name: r.name, rsiHandle: r.rsi_handle, avatarUrl: r.avatar_url } : undefined;
};

interface CategoryRow { id: number; slug: string; name: string; parent_id: number | null; listing_kind: string; icon: string | null; sort_order: number; active: boolean }
const toCategory = (r: CategoryRow): MarketplaceCategory => ({
    id: r.id, slug: r.slug, name: r.name, parentId: r.parent_id,
    listingKind: r.listing_kind as MarketplaceCategory['listingKind'], icon: r.icon,
    sortOrder: r.sort_order, active: r.active,
});

interface ListingRow {
    id: string; seller_id: number; kind: string; listing_type: string; category_id: number | null;
    title: string; description: string | null; quantity: number | null; quantity_claimed: number;
    price_uec: number | null; price_type: string; location: string | null; tags: string[] | null;
    status: string; expires_at: string | null; warehouse_stock_id: number | null;
    created_at: string; updated_at: string;
    seller?: TraderEmbed | TraderEmbed[]; category?: { name: string; icon: string | null } | { name: string; icon: string | null }[] | null;
}
const toListing = (r: ListingRow): MarketplaceListing => {
    const cat = Array.isArray(r.category) ? r.category[0] : r.category;
    return {
        id: r.id, sellerId: r.seller_id, seller: toTrader(r.seller ?? null),
        kind: r.kind as MarketplaceListing['kind'], listingType: r.listing_type as MarketplaceListingType,
        categoryId: r.category_id, categoryName: cat?.name ?? null, categoryIcon: cat?.icon ?? null,
        title: r.title, description: r.description, quantity: r.quantity, quantityClaimed: r.quantity_claimed,
        priceUec: r.price_uec, priceType: r.price_type as MarketplaceListing['priceType'],
        location: r.location, tags: r.tags ?? [], status: r.status as MarketplaceListing['status'],
        expiresAt: r.expires_at, warehouseStockId: r.warehouse_stock_id,
        createdAt: r.created_at, updatedAt: r.updated_at,
    };
};

interface ContractRow {
    id: string; listing_id: string | null; seller_id: number; buyer_id: number; kind: string;
    title: string; quantity: number | null; agreed_price_uec: number | null; terms_note: string | null;
    status: string; proposed_by_id: number | null; cancel_reason: string | null; warehouse_stock_id: number | null;
    proposed_at: string; accepted_at: string | null; delivered_at: string | null; completed_at: string | null;
    cancelled_at: string | null; created_at: string; updated_at: string;
    seller?: TraderEmbed | TraderEmbed[]; buyer?: TraderEmbed | TraderEmbed[];
}
const toContract = (r: ContractRow): MarketplaceContract => ({
    id: r.id, listingId: r.listing_id, sellerId: r.seller_id, seller: toTrader(r.seller ?? null),
    buyerId: r.buyer_id, buyer: toTrader(r.buyer ?? null), kind: r.kind as MarketplaceContract['kind'],
    title: r.title, quantity: r.quantity, agreedPriceUec: r.agreed_price_uec, termsNote: r.terms_note,
    status: r.status as MarketplaceContract['status'], proposedById: r.proposed_by_id, cancelReason: r.cancel_reason,
    warehouseStockId: r.warehouse_stock_id, proposedAt: r.proposed_at, acceptedAt: r.accepted_at,
    deliveredAt: r.delivered_at, completedAt: r.completed_at, cancelledAt: r.cancelled_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
});

interface MilestoneRow { id: number; contract_id: string; title: string; description: string | null; sort_order: number; completed_at: string | null; completed_by_id: number | null }
const toMilestone = (r: MilestoneRow): MarketplaceMilestone => ({
    id: r.id, contractId: r.contract_id, title: r.title, description: r.description,
    sortOrder: r.sort_order, completedAt: r.completed_at, completedById: r.completed_by_id,
});

interface RatingRow { id: number; contract_id: string; rater_id: number; ratee_id: number; rater_role: string; stars: number; feedback: string | null; created_at: string; rater?: TraderEmbed | TraderEmbed[] }
const toRating = (r: RatingRow): MarketplaceRating => ({
    id: r.id, contractId: r.contract_id, raterId: r.rater_id, rater: toTrader(r.rater ?? null),
    rateeId: r.ratee_id, raterRole: r.rater_role as MarketplaceRating['raterRole'], stars: r.stars,
    feedback: r.feedback, createdAt: r.created_at,
});

function reputationTier(avg: number, count: number): MarketplaceReputation['tier'] {
    if (count === 0) return 'New';
    if (avg >= 4.5 && count >= 10) return 'Elite';
    if (avg >= 4.0 && count >= 3) return 'Trusted';
    return 'Reputable';
}

// Realtime nudge: ids/discriminators ONLY — receivers refetch through the
// permission-gated subset fetchers. Never put row bodies on the wire.
function emit(payload: { listingId?: string; contractId?: string }): void {
    broadcastToOrg('marketplace:update', payload);
}

// =============================================================================
// Categories
// =============================================================================
export async function getMarketplaceCategories(): Promise<MarketplaceCategory[]> {
    const { data, error } = await supabase.from('marketplace_categories')
        .select('id, slug, name, parent_id, listing_kind, icon, sort_order, active')
        .eq('active', true).order('sort_order', { ascending: true });
    handleSupabaseError({ error, message: 'Failed to load marketplace categories' });
    return ((data as unknown as CategoryRow[]) || []).map(toCategory);
}

// --- Admin: category management (marketplace:admin) --------------------------
const VALID_CATEGORY_KINDS = ['item', 'service', 'both'];
function slugifyCategory(s: string): string {
    return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export interface CategoryInput {
    name: string; parentId?: number | null; listingKind?: string;
    icon?: string | null; sortOrder?: number; active?: boolean;
}

/** Admin view: ALL categories (active + inactive), for the management table.
 *  Members get the active-only getMarketplaceCategories above. */
export async function listAllMarketplaceCategories(): Promise<MarketplaceCategory[]> {
    const { data, error } = await supabase.from('marketplace_categories')
        .select('id, slug, name, parent_id, listing_kind, icon, sort_order, active')
        .order('sort_order', { ascending: true });
    handleSupabaseError({ error, message: 'Failed to load marketplace categories' });
    return ((data as unknown as CategoryRow[]) || []).map(toCategory);
}

export async function createMarketplaceCategory(input: CategoryInput): Promise<MarketplaceCategory> {
    const name = stripHtmlSingleLine(input.name, 60);
    if (!name) throw new Error('Category name is required.');
    const slug = slugifyCategory(name);
    if (!slug) throw new Error('Category name must contain letters or numbers.');
    const row = {
        slug, name,
        parent_id: input.parentId ?? null,
        listing_kind: VALID_CATEGORY_KINDS.includes(String(input.listingKind)) ? input.listingKind : 'both',
        icon: input.icon ? (stripHtmlSingleLine(input.icon, 60) || null) : null,
        sort_order: Number.isFinite(Number(input.sortOrder)) ? Math.trunc(Number(input.sortOrder)) : 0,
        active: input.active !== false,
    };
    const { data, error } = await supabase.from('marketplace_categories').insert(row)
        .select('id, slug, name, parent_id, listing_kind, icon, sort_order, active').maybeSingle();
    handleSupabaseError({ error, message: 'Failed to create category' });
    emit({});
    return toCategory(data as unknown as CategoryRow);
}

export async function updateMarketplaceCategory(id: number, patch: Partial<CategoryInput>): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (patch.name !== undefined) { const n = stripHtmlSingleLine(patch.name, 60); if (!n) throw new Error('Category name is required.'); fields.name = n; }
    if (patch.parentId !== undefined) {
        if (patch.parentId === id) throw new Error('A category cannot be its own parent.');
        fields.parent_id = patch.parentId;
    }
    if (patch.listingKind !== undefined) fields.listing_kind = VALID_CATEGORY_KINDS.includes(String(patch.listingKind)) ? patch.listingKind : 'both';
    if (patch.icon !== undefined) fields.icon = patch.icon ? (stripHtmlSingleLine(patch.icon, 60) || null) : null;
    if (patch.sortOrder !== undefined) fields.sort_order = Number.isFinite(Number(patch.sortOrder)) ? Math.trunc(Number(patch.sortOrder)) : 0;
    if (patch.active !== undefined) fields.active = !!patch.active;
    if (Object.keys(fields).length === 0) return;
    const { error } = await supabase.from('marketplace_categories').update(fields).eq('id', id);
    handleSupabaseError({ error, message: 'Failed to update category' });
    emit({});
}

export async function deleteMarketplaceCategory(id: number): Promise<void> {
    // Child categories CASCADE; listings.category_id is SET NULL (schema.sql FKs),
    // so deleting a category never deletes listings — they fall back to Uncategorised.
    const { error } = await supabase.from('marketplace_categories').delete().eq('id', id);
    handleSupabaseError({ error, message: 'Failed to delete category' });
    emit({});
}

// =============================================================================
// Listings
// =============================================================================
export interface BrowseFilters { kind?: string; listingType?: string; categoryId?: number; search?: string }

/** Browse the ACTIVE listings board — org-wide (every member sees every active
 *  listing). Drafts/paused/closed/expired are never returned here. */
export async function browseMarketplaceListings(filters: BrowseFilters = {}): Promise<MarketplaceListing[]> {
    let q = supabase.from('marketplace_listings').select(LISTING_SELECT).eq('status', 'active');
    if (filters.kind) q = q.eq('kind', filters.kind);
    if (filters.listingType) q = q.eq('listing_type', filters.listingType);
    if (filters.categoryId) q = q.eq('category_id', filters.categoryId);
    if (filters.search) {
        // Escape LIKE metacharacters (% _ \) so the term matches literally inside
        // the %…% wrapper — a bare '%'/'_' would otherwise widen the match (the
        // outer wildcards are intentional; the interpolated term must not add its
        // own). Length-capped to bound the pattern.
        const safe = escapeLikePattern(String(filters.search).slice(0, 80));
        if (safe) q = q.ilike('title', `%${safe}%`);
    }
    const { data, error } = await q.order('created_at', { ascending: false }).limit(200);
    handleSupabaseError({ error, message: 'Failed to browse marketplace' });
    return ((data as unknown as ListingRow[]) || []).map(toListing);
}

export async function getMarketplaceListing(id: string, userId: number): Promise<MarketplaceListing | null> {
    const { data } = await supabase.from('marketplace_listings').select(LISTING_SELECT).eq('id', id).maybeSingle();
    if (!data) return null;
    const row = data as unknown as ListingRow;
    // Mirror the browse gate: a withdrawn (paused/closed/expired) listing is
    // visible only to its owner, never enumerable by id by other members.
    if (row.status !== 'active' && row.seller_id !== userId) return null;
    return toListing(row);
}

export interface CreateListingInput {
    kind: 'item' | 'service'; listingType: MarketplaceListingType; categoryId?: number | null;
    title: string; description?: string; quantity?: number | null; priceUec?: number | null;
    priceType?: string; location?: string; tags?: string[]; expiresAt?: string | null;
    warehouseStockId?: number | null;
}

// warehouse_stock is a shared org resource with no per-user owner. Linking it to
// a sell listing eventually fires a service-role stock withdrawal at delivery
// (warehouse_marketplace_deliver) — a movement that, done directly, requires
// warehouse:manage. So linking/moving stock through the marketplace must require
// the SAME bar; otherwise any Member (who holds marketplace:list + :contract by
// default) could draw down shared stock.
type WarehouseActor = { role?: string; permissions?: string[] } | null | undefined;
function canMoveWarehouseStock(actor: WarehouseActor): boolean {
    if (!actor) return false;
    if (actor.role === 'Admin') return true;
    return Array.isArray(actor.permissions) && actor.permissions.includes('warehouse:manage');
}

export async function createMarketplaceListing(input: CreateListingInput, userId: number, actor?: WarehouseActor): Promise<MarketplaceListing> {
    const kind = input.kind === 'service' ? 'service' : 'item';
    const isItem = kind === 'item';
    const qty = isItem ? Number(input.quantity) : null;
    if (isItem && (!Number.isFinite(qty as number) || (qty as number) <= 0)) throw new Error('Item listings require a positive quantity.');
    const title = stripHtmlSingleLine(input.title, 160);   // strip markup
    if (!title) throw new Error('A title is required.');
    // Validate the optional warehouse link exists (a member can't link an
    // arbitrary stock id to fabricate a movement later), AND that the caller is
    // authorized to move shared org stock.
    let warehouseStockId: number | null = null;
    if (isItem && input.warehouseStockId != null) {
        if (!canMoveWarehouseStock(actor)) {
            throw new Error('You need the warehouse:manage permission to link warehouse stock to a listing.');
        }
        const { data: stock } = await supabase.from('warehouse_stock').select('id').eq('id', input.warehouseStockId).maybeSingle();
        if (!stock) throw new Error('Linked warehouse stock not found.');
        warehouseStockId = input.warehouseStockId;
    }
    const { data, error } = await supabase.from('marketplace_listings').insert({
        seller_id: userId, kind, listing_type: input.listingType,
        category_id: input.categoryId ?? null, title,
        description: stripHtml(input.description, 4000) || null,
        quantity: qty, price_uec: clampUec(input.priceUec),
        price_type: input.priceType ?? 'fixed', location: stripHtmlSingleLine(input.location, 160) || null,
        tags: Array.isArray(input.tags) ? input.tags.slice(0, 12).map((t) => stripHtmlSingleLine(t, 40)).filter(Boolean) : [],
        status: 'active', expires_at: input.expiresAt ?? null, warehouse_stock_id: warehouseStockId,
    }).select(LISTING_SELECT).single();
    handleSupabaseError({ error, message: 'Failed to create listing' });
    emit({ listingId: (data as unknown as ListingRow).id });
    return toListing(data as unknown as ListingRow);
}

export async function updateMarketplaceListing(id: string, patch: Partial<CreateListingInput> & { status?: string }, userId: number): Promise<void> {
    const { data: row } = await supabase.from('marketplace_listings').select('id, seller_id, kind').eq('id', id).maybeSingle();
    if (!row || (row as { seller_id: number }).seller_id !== userId) throw new Error(ERR_LISTING);   // owner-only
    // A seller (this is the owner-only path) cannot REOPEN a listing a moderator
    // closed — moderation_closed_at is stamped by reviewMarketplaceReport on
    // takedown. Soft-fail (treat as not-closed) when the column predates the
    // schema redeploy, since no moderation flag can exist yet on such a DB.
    if (patch.status === 'active') {
        const { data: modRow, error: modErr } = await supabase.from('marketplace_listings')
            .select('moderation_closed_at').eq('id', id).maybeSingle();
        if (!modErr && (modRow as { moderation_closed_at?: string | null } | null)?.moderation_closed_at) {
            throw new Error('This listing was closed by a moderator and cannot be reopened.');
        }
    }
    const db: Record<string, unknown> = { updated_at: nowIso() };
    if (patch.title !== undefined) db.title = stripHtmlSingleLine(patch.title, 160);
    if (patch.description !== undefined) db.description = stripHtml(patch.description, 4000) || null;
    if (patch.priceUec !== undefined) db.price_uec = clampUec(patch.priceUec);
    if (patch.priceType !== undefined) db.price_type = patch.priceType;
    if (patch.location !== undefined) db.location = stripHtmlSingleLine(patch.location, 160) || null;
    if (patch.categoryId !== undefined) db.category_id = patch.categoryId;
    if (patch.tags !== undefined) db.tags = Array.isArray(patch.tags) ? patch.tags.slice(0, 12).map((t) => stripHtmlSingleLine(t, 40)).filter(Boolean) : [];
    if (patch.expiresAt !== undefined) db.expires_at = patch.expiresAt;
    if (patch.status !== undefined && ['active', 'paused', 'closed'].includes(patch.status)) db.status = patch.status;
    const { error } = await supabase.from('marketplace_listings').update(db).eq('id', id).eq('seller_id', userId);
    handleSupabaseError({ error, message: 'Failed to update listing' });
    emit({ listingId: id });
}

export async function deleteMarketplaceListing(id: string, userId: number): Promise<void> {
    const { data: row } = await supabase.from('marketplace_listings').select('id, seller_id').eq('id', id).maybeSingle();
    if (!row || (row as { seller_id: number }).seller_id !== userId) throw new Error(ERR_LISTING);
    // Contracts reference listing_id ON DELETE SET NULL — history survives unlinked.
    const { error } = await supabase.from('marketplace_listings').delete().eq('id', id).eq('seller_id', userId);
    handleSupabaseError({ error, message: 'Failed to delete listing' });
    emit({ listingId: id });
}

// =============================================================================
// Contracts — lifecycle
// =============================================================================

/** Parties from listing_type: sell/offer ⇒ the listing OWNER is the seller and
 *  the proposer is the buyer; buy/request ⇒ the proposer is the seller. */
function deriveParties(listingType: string, ownerId: number, proposerId: number): { sellerId: number; buyerId: number } {
    if (listingType === 'sell' || listingType === 'offer') return { sellerId: ownerId, buyerId: proposerId };
    return { sellerId: proposerId, buyerId: ownerId };
}

export interface ProposeContractInput { listingId: string; quantity?: number | null; agreedPriceUec?: number | null; termsNote?: string; milestones?: { title: string; description?: string }[] }
export async function proposeMarketplaceContract(input: ProposeContractInput, userId: number): Promise<MarketplaceContract> {
    const { data: l } = await supabase.from('marketplace_listings')
        .select('id, seller_id, kind, listing_type, title, quantity, quantity_claimed, status').eq('id', input.listingId).maybeSingle();
    const listing = l as unknown as { id: string; seller_id: number; kind: string; listing_type: string; title: string; quantity: number | null; quantity_claimed: number; status: string } | null;
    if (!listing || listing.status !== 'active') throw new Error(ERR_LISTING);
    if (listing.seller_id === userId) throw new Error('You cannot contract your own listing.');

    // Dedup: a proposer may hold only ONE live (non-terminal) contract per listing.
    // Without this, proposed contracts don't reserve quantity, so the over-claim
    // guard never trips and one member can flood a seller / bloat the table.
    const { data: liveContract } = await supabase.from('marketplace_contracts')
        .select('id').eq('listing_id', listing.id).eq('proposed_by_id', userId)
        .in('status', ['proposed', 'accepted', 'delivered']).maybeSingle();
    if (liveContract) throw new Error('You already have an active contract on this listing.');

    const isItem = listing.kind === 'item';
    let qty: number | null = null;
    if (isItem) {
        qty = Number(input.quantity);
        const remaining = (listing.quantity ?? 0) - (listing.quantity_claimed ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) throw new Error('A positive quantity is required.');
        if (qty > remaining) throw new Error(`Only ${remaining} remaining on this listing.`);   // no over-claim
    }
    const { sellerId, buyerId } = deriveParties(listing.listing_type, listing.seller_id, userId);

    const { data, error } = await supabase.from('marketplace_contracts').insert({
        listing_id: listing.id, seller_id: sellerId, buyer_id: buyerId, kind: listing.kind,
        title: listing.title, quantity: qty, agreed_price_uec: clampUec(input.agreedPriceUec),
        terms_note: stripHtml(input.termsNote, 250) || null,
        status: 'proposed', proposed_by_id: userId,
    }).select(CONTRACT_SELECT).single();
    handleSupabaseError({ error, message: 'Failed to propose contract' });
    const contract = data as unknown as ContractRow;

    // Optional service milestones (cap 20).
    if (Array.isArray(input.milestones) && input.milestones.length > 0) {
        const rows = input.milestones.slice(0, 20).map((m, i) => ({
            contract_id: contract.id, title: stripHtmlSingleLine(m.title, 160),
            description: stripHtml(m.description, 1000) || null, sort_order: i,
        })).filter((m) => m.title);
        if (rows.length > 0) await supabase.from('marketplace_contract_milestones').insert(rows);
    }
    emit({ contractId: contract.id });
    return toContract(contract);
}

/** Load a contract row with the columns the lifecycle guards need. */
async function loadContractGuarded(id: string): Promise<{ id: string; listing_id: string | null; seller_id: number; buyer_id: number; kind: string; quantity: number | null; status: string; proposed_by_id: number | null; warehouse_stock_id: number | null } | null> {
    const { data } = await supabase.from('marketplace_contracts')
        .select('id, listing_id, seller_id, buyer_id, kind, quantity, status, proposed_by_id, warehouse_stock_id').eq('id', id).maybeSingle();
    return (data as unknown as Awaited<ReturnType<typeof loadContractGuarded>>) ?? null;
}

export async function acceptMarketplaceContract(id: string, userId: number): Promise<void> {
    // Fast pre-checks give friendly errors; the RPC re-checks everything under a
    // row lock (the checks below are advisory, not the security boundary).
    const c = await loadContractGuarded(id);
    if (!c) throw new Error(ERR_CONTRACT);
    const nonProposer = c.proposed_by_id === c.seller_id ? c.buyer_id : c.seller_id;
    if (userId !== nonProposer) throw new Error(ERR_CONTRACT);
    if (c.status !== 'proposed') throw new Error('This contract can no longer be accepted.');

    // The ENTIRE accept (party + status re-check, warehouse-link snapshot, listing
    // reserve, status flip) is one atomic transaction in SQL — PostgREST has none,
    // so two concurrent accepts (or a double-accept of the same contract) can't
    // race. See marketplace_accept_contract in schema.sql §4.
    const { data: result, error } = await supabase.rpc('marketplace_accept_contract', { p_contract_id: id, p_actor_id: userId });
    handleSupabaseError({ error, message: 'Failed to accept contract' });
    if (result === 'forbidden') throw new Error(ERR_CONTRACT);
    if (result === 'bad_state') throw new Error('This contract can no longer be accepted.');
    if (result === 'full') throw new Error('This listing no longer has enough remaining quantity.');
    if (c.listing_id) emit({ listingId: c.listing_id });
    emit({ contractId: id });
}

export async function markMarketplaceDelivered(id: string, userId: number, actor?: WarehouseActor): Promise<void> {
    const c = await loadContractGuarded(id);
    if (!c) throw new Error(ERR_CONTRACT);
    if (userId !== c.seller_id) throw new Error(ERR_CONTRACT);                 // seller only
    if (!['accepted', 'in_progress'].includes(c.status)) throw new Error('This contract is not ready to deliver.');
    const fromStatus = c.status;   // optimistic-guard expectation
    // Re-check warehouse authorization at the moment stock actually moves — the
    // create-time check could be bypassed by a permission change or a future
    // caller that skips it. Do this BEFORE the status flip so an unauthorized
    // caller never even moves the state machine.
    if (c.kind === 'item' && c.warehouse_stock_id && !canMoveWarehouseStock(actor)) {
        throw new Error('You need the warehouse:manage permission to deliver a warehouse-linked contract.');
    }
    // Flip status FIRST under an optimistic guard (.eq('status', fromStatus)) and
    // only move stock if the flip actually claimed the row. A concurrent
    // confirm/cancel that already advanced the contract makes the UPDATE affect 0
    // rows, so we never double-decrement the shared warehouse ledger against a
    // stale read.
    const { data: flipped, error } = await supabase.from('marketplace_contracts').update({
        status: 'delivered', delivered_at: nowIso(), updated_at: nowIso(),
    }).eq('id', id).eq('seller_id', userId).eq('status', fromStatus).select('id');
    handleSupabaseError({ error, message: 'Failed to mark delivered' });
    // the guarded update's returning-projection yields the affected rows (an
    // array, possibly empty);
    // an empty array means a concurrent transition already moved the row, so the
    // optimistic guard lost — fail closed before touching warehouse stock.
    if (Array.isArray(flipped) && flipped.length === 0) throw new Error('This contract is not ready to deliver.');
    // Auto stock decrement (idempotent + row-locked in the RPC) — only after we
    // own the delivered transition.
    if (c.kind === 'item' && c.warehouse_stock_id) {
        const { error: rpcErr } = await supabase.rpc('warehouse_marketplace_deliver', { p_contract_id: id, p_actor_id: userId });
        if (rpcErr) throw new Error(`Stock movement failed: ${rpcErr.message}`);
        broadcastToOrg('warehouse:stock_update', {});
    }
    emit({ contractId: id });
}

export async function confirmMarketplaceReceived(id: string, userId: number): Promise<void> {
    const c = await loadContractGuarded(id);
    if (!c) throw new Error(ERR_CONTRACT);
    if (userId !== c.buyer_id) throw new Error(ERR_CONTRACT);                  // buyer only
    if (c.status !== 'delivered') throw new Error('This contract is not awaiting confirmation.');
    // Optimistic status guard — a raced cancel that already moved the contract off
    // 'delivered' makes this affect 0 rows, so we fail closed instead of
    // overwriting a terminal state from a stale read.
    const { data: flipped, error } = await supabase.from('marketplace_contracts').update({
        status: 'completed', completed_at: nowIso(), updated_at: nowIso(),
    }).eq('id', id).eq('buyer_id', userId).eq('status', 'delivered').select('id');
    handleSupabaseError({ error, message: 'Failed to confirm receipt' });
    if (Array.isArray(flipped) && flipped.length === 0) throw new Error('This contract is not awaiting confirmation.');
    emit({ contractId: id });
}

export async function cancelMarketplaceContract(id: string, userId: number, reason?: string, actor?: WarehouseActor): Promise<void> {
    const c = await loadContractGuarded(id);
    if (!c) throw new Error(ERR_CONTRACT);
    if (userId !== c.seller_id && userId !== c.buyer_id) throw new Error(ERR_CONTRACT);   // party only
    if (['completed', 'cancelled'].includes(c.status)) throw new Error('This contract can no longer be cancelled.');

    const fromStatus = c.status;                 // optimistic-guard expectation
    const wasDelivered = fromStatus === 'delivered';
    // A cancel-after-delivery fires warehouse_marketplace_reverse — a real +qty
    // restock of shared org stock, the same movement that, done directly, requires
    // warehouse:manage. Re-check the SAME bar here (mirror markMarketplaceDelivered)
    // BEFORE we flip state so a non-warehouse party can't drive a compensating
    // stock movement.
    if (wasDelivered && c.kind === 'item' && c.warehouse_stock_id && !canMoveWarehouseStock(actor)) {
        throw new Error('You need the warehouse:manage permission to cancel a warehouse-linked delivered contract.');
    }
    // Flip to cancelled FIRST under an optimistic guard, and only run the
    // (non-idempotent) listing release / warehouse reverse if THIS call actually
    // claimed the transition. Two concurrent cancels otherwise each subtract the
    // reservation (over-release, re-opening the listing for over-claim) and each
    // post a reverse; the guard makes the loser a no-op.
    const { data: flipped, error } = await supabase.from('marketplace_contracts').update({
        status: 'cancelled', cancelled_at: nowIso(), cancel_reason: stripHtml(reason, 250) || null, updated_at: nowIso(), // cancel_reason is on the wire (CONTRACT_SELECT)
    }).eq('id', id).eq('status', fromStatus).select('id');
    handleSupabaseError({ error, message: 'Failed to cancel contract' });
    if (Array.isArray(flipped) && flipped.length === 0) throw new Error('This contract can no longer be cancelled.');

    // Release the listing reservation atomically (floors at 0, re-opens if it
    // had auto-closed). Only an already-reserved contract (accepted onward) ever
    // held a reservation — a still-proposed cancel never reserved, so releasing
    // is a no-op for it (the contract's quantity wasn't added). Decide from the
    // GUARDED pre-cancel status we just won, not a re-read.
    if (c.kind === 'item' && c.listing_id && c.quantity && fromStatus !== 'proposed') {
        const { error: relErr } = await supabase.rpc('marketplace_release_listing', { p_listing_id: c.listing_id, p_qty: c.quantity });
        if (relErr) log.warn('marketplace release failed', { id, err: relErr.message });
        else emit({ listingId: c.listing_id });
    }
    // Compensating warehouse movement if stock was already moved on delivery.
    if (wasDelivered && c.kind === 'item' && c.warehouse_stock_id) {
        const { error: rpcErr } = await supabase.rpc('warehouse_marketplace_reverse', { p_contract_id: id, p_actor_id: userId, p_reason: 'Marketplace contract cancelled' });
        if (rpcErr) log.warn('marketplace reversal failed', { id, err: rpcErr.message });
        else broadcastToOrg('warehouse:stock_update', {});
    }
    emit({ contractId: id });
}

export interface RateContractInput { stars: number; feedback?: string }
export async function rateMarketplaceContract(id: string, input: RateContractInput, userId: number): Promise<void> {
    const c = await loadContractGuarded(id);
    if (!c) throw new Error(ERR_CONTRACT);
    const isSeller = userId === c.seller_id;
    const isBuyer = userId === c.buyer_id;
    if (!isSeller && !isBuyer) throw new Error(ERR_CONTRACT);                  // party only
    if (c.status !== 'completed') throw new Error('You can only rate a completed contract.');
    const stars = Math.round(Number(input.stars));
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) throw new Error('Rating must be 1–5 stars.');
    const rateeId = isSeller ? c.buyer_id : c.seller_id;
    const { error } = await supabase.from('marketplace_ratings').insert({
        contract_id: id, rater_id: userId, ratee_id: rateeId, rater_role: isSeller ? 'seller' : 'buyer',
        stars, feedback: stripHtml(input.feedback, 1000) || null,
    });
    // UNIQUE(contract_id, rater_id) — one rating per party.
    if (error) {
        if ((error as { code?: string }).code === '23505') throw new Error('You have already rated this contract.');
        handleSupabaseError({ error, message: 'Failed to submit rating' });
    }
    emit({ contractId: id });
}

// =============================================================================
// Contract reads (party-scoped)
// =============================================================================
export async function getMyMarketplaceContracts(userId: number): Promise<MarketplaceContract[]> {
    const { data, error } = await supabase.from('marketplace_contracts').select(CONTRACT_SELECT)
        .or(`seller_id.eq.${userId},buyer_id.eq.${userId}`).order('updated_at', { ascending: false }).limit(200);
    handleSupabaseError({ error, message: 'Failed to load contracts' });
    return ((data as unknown as ContractRow[]) || []).map(toContract);
}

export async function getMarketplaceContract(id: string, userId: number): Promise<MarketplaceContract | null> {
    const { data } = await supabase.from('marketplace_contracts').select(CONTRACT_SELECT).eq('id', id).maybeSingle();
    if (!data) return null;
    const row = data as unknown as ContractRow;
    if (row.seller_id !== userId && row.buyer_id !== userId) return null;      // party-only read; no existence leak
    const contract = toContract(row);
    contract.milestones = await getMarketplaceMilestones(id, userId);
    return contract;
}

// =============================================================================
// Milestones
// =============================================================================
async function assertContractParty(contractId: string, userId: number): Promise<{ seller_id: number; buyer_id: number; status: string }> {
    const { data } = await supabase.from('marketplace_contracts').select('seller_id, buyer_id, status').eq('id', contractId).maybeSingle();
    const c = data as unknown as { seller_id: number; buyer_id: number; status: string } | null;
    if (!c || (c.seller_id !== userId && c.buyer_id !== userId)) throw new Error(ERR_CONTRACT);
    return c;
}

export async function getMarketplaceMilestones(contractId: string, userId: number): Promise<MarketplaceMilestone[]> {
    await assertContractParty(contractId, userId);
    const { data } = await supabase.from('marketplace_contract_milestones')
        .select('id, contract_id, title, description, sort_order, completed_at, completed_by_id')
        .eq('contract_id', contractId).order('sort_order', { ascending: true });
    return ((data as unknown as MilestoneRow[]) || []).map(toMilestone);
}

export async function toggleMarketplaceMilestone(milestoneId: number, userId: number): Promise<void> {
    const { data: m } = await supabase.from('marketplace_contract_milestones').select('id, contract_id, completed_at').eq('id', milestoneId).maybeSingle();
    const row = m as unknown as { id: number; contract_id: string; completed_at: string | null } | null;
    if (!row) throw new Error(ERR_CONTRACT);
    const c = await assertContractParty(row.contract_id, userId);
    // Only the SELLER marks deliverables done.
    if (userId !== c.seller_id) throw new Error(ERR_CONTRACT);
    // Mirror deleteMarketplaceMilestone's status gate — a milestone is a
    // party-visible deliverable record; it must not be flipped on a terminal
    // (completed/cancelled) or not-yet-accepted contract.
    if (!['accepted', 'in_progress'].includes(c.status)) throw new Error('Milestones are locked once the contract is no longer in progress.');
    const completing = !row.completed_at;
    await supabase.from('marketplace_contract_milestones').update({
        completed_at: completing ? nowIso() : null, completed_by_id: completing ? userId : null,
    }).eq('id', milestoneId);
    // First completion advances an accepted service contract to in_progress.
    if (completing && c.status === 'accepted') {
        await supabase.from('marketplace_contracts').update({ status: 'in_progress', updated_at: nowIso() }).eq('id', row.contract_id).eq('status', 'accepted');
    }
    emit({ contractId: row.contract_id });
}

export async function deleteMarketplaceMilestone(milestoneId: number, userId: number): Promise<void> {
    const { data: m } = await supabase.from('marketplace_contract_milestones').select('id, contract_id').eq('id', milestoneId).maybeSingle();
    const row = m as unknown as { id: number; contract_id: string } | null;
    if (!row) throw new Error(ERR_CONTRACT);
    const c = await assertContractParty(row.contract_id, userId);
    if (!['proposed', 'accepted'].includes(c.status)) throw new Error('Milestones are locked once work is underway.');
    await supabase.from('marketplace_contract_milestones').delete().eq('id', milestoneId);
    emit({ contractId: row.contract_id });
}

// =============================================================================
// Ratings / reputation / profile
// =============================================================================
export async function getContractRatings(contractId: string, userId: number): Promise<MarketplaceRating[]> {
    // Party-only: a contract's ratings (incl. free-text feedback) are visible to
    // its two parties. Public per-trader reputation rides getTraderProfile.
    await assertContractParty(contractId, userId);
    const { data } = await supabase.from('marketplace_ratings').select(RATING_SELECT).eq('contract_id', contractId);
    return ((data as unknown as RatingRow[]) || []).map(toRating);
}

export async function getMarketplaceReputation(userId: number): Promise<MarketplaceReputation> {
    // Mirror getMarketplaceTraderProfile's deleted_at guard — reputation is
    // enumerable by any marketplace:view holder via targetUserId, so a
    // soft-deleted (or non-existent) user's standing must not stay readable.
    // Return a zeroed "New" reputation for a non-live id rather than its history.
    const { data: u } = await supabase.from('users').select('id').eq('id', userId).is('deleted_at', null).maybeSingle();
    if (!u) return { userId, averageStars: 0, ratingCount: 0, tier: reputationTier(0, 0) };
    const { data } = await supabase.from('marketplace_ratings').select('stars').eq('ratee_id', userId);
    const rows = (data as unknown as { stars: number }[] | null) || [];
    const count = rows.length;
    const avg = count > 0 ? rows.reduce((s, r) => s + r.stars, 0) / count : 0;
    return { userId, averageStars: Math.round(avg * 10) / 10, ratingCount: count, tier: reputationTier(avg, count) };
}

export async function getMarketplaceTraderProfile(userId: number): Promise<MarketplaceTraderProfile | null> {
    const { data: u } = await supabase.from('users').select(TRADER_FIELDS).eq('id', userId).is('deleted_at', null).maybeSingle();
    const trader = toTrader(u as unknown as TraderEmbed);
    if (!trader) return null;
    const reputation = await getMarketplaceReputation(userId);
    const { data: listingRows } = await supabase.from('marketplace_listings').select(LISTING_SELECT)
        .eq('seller_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(50);
    // NO recentRatings here. A trader profile is enumerable by any
    // marketplace:view holder via targetUserId, but the free-text feedback +
    // rater identities are party-confidential (the sibling getContractRatings
    // gates them behind assertContractParty). Expose only the aggregate
    // reputation; the per-rating detail never leaves the party boundary.
    return {
        trader, reputation,
        activeListings: ((listingRows as unknown as ListingRow[]) || []).map(toListing),
    };
}

// =============================================================================
// Reports (member flag; review is admin-only and not a member RPC)
// =============================================================================
export interface ReportInput { listingId?: string; contractId?: string; reasonCategory: string; details?: string }
export async function reportMarketplace(input: ReportInput, userId: number): Promise<void> {
    if (!input.listingId && !input.contractId) throw new Error('A listing or contract is required.');
    // The reporter must be able to SEE the target: an active listing, or a
    // contract they are a party to.
    if (input.listingId) {
        const { data: l } = await supabase.from('marketplace_listings').select('id, status, seller_id').eq('id', input.listingId).maybeSingle();
        const listing = l as unknown as { id: string; status: string; seller_id: number } | null;
        if (!listing || (listing.status !== 'active' && listing.seller_id !== userId)) throw new Error(ERR_LISTING);
    }
    if (input.contractId) {
        await assertContractParty(input.contractId, userId);
    }
    // One OPEN report per reporter per target. Without a dedup, a member can flood
    // marketplace_reports against the same listing / contract (write amplification
    // + moderation-queue noise). A duplicate while a prior report is still open is
    // rejected; once it's actioned/dismissed the reporter may re-flag.
    let dupQ = supabase.from('marketplace_reports').select('id').eq('reporter_id', userId).eq('status', 'open');
    dupQ = input.listingId ? dupQ.eq('listing_id', input.listingId) : dupQ.eq('contract_id', input.contractId as string);
    const { data: existing } = await dupQ.limit(1).maybeSingle();
    if (existing) throw new Error('You already have an open report on this item.');
    const { error } = await supabase.from('marketplace_reports').insert({
        listing_id: input.listingId ?? null, contract_id: input.contractId ?? null, reporter_id: userId,
        status: 'open',                                             // explicit (don't rely on the DB default) so the dedup gate above is self-consistent
        reason_category: stripHtmlSingleLine(input.reasonCategory, 60) || 'other',
        details: stripHtml(input.details, 2000) || null,
    });
    handleSupabaseError({ error, message: 'Failed to submit report' });
}

// =============================================================================
// Admin: report moderation (marketplace:admin)
// =============================================================================
// reporter + reviewer both FK to users → disambiguate by constraint name. The
// target embeds expose only the columns the moderation queue renders (title +
// status + owner), never the full listing/contract body.
const REPORT_SELECT =
    'id, listing_id, contract_id, reporter_id, reason_category, details, status, reviewed_at, reviewed_by_id, created_at, ' +
    'reporter:users!marketplace_reports_reporter_id_fkey(id, name, avatar_url), ' +
    'reviewer:users!marketplace_reports_reviewed_by_id_fkey(id, name), ' +
    'listing:marketplace_listings(id, title, status, seller_id), ' +
    'contract:marketplace_contracts(id, title, status, seller_id, buyer_id)';

interface ReportRow {
    id: number; listing_id: string | null; contract_id: string | null; reporter_id: number;
    reason_category: string; details: string | null; status: string;
    reviewed_at: string | null; reviewed_by_id: number | null; created_at: string;
    reporter?: { id: number; name: string; avatar_url: string | null } | { id: number; name: string; avatar_url: string | null }[] | null;
    reviewer?: { id: number; name: string } | { id: number; name: string }[] | null;
    listing?: { id: string; title: string; status: string; seller_id: number } | { id: string; title: string; status: string; seller_id: number }[] | null;
    contract?: { id: string; title: string; status: string; seller_id: number; buyer_id: number } | { id: string; title: string; status: string; seller_id: number; buyer_id: number }[] | null;
}
const toReport = (r: ReportRow): MarketplaceReport => {
    const reporter = Array.isArray(r.reporter) ? r.reporter[0] : r.reporter;
    const reviewer = Array.isArray(r.reviewer) ? r.reviewer[0] : r.reviewer;
    const listing = Array.isArray(r.listing) ? r.listing[0] : r.listing;
    const contract = Array.isArray(r.contract) ? r.contract[0] : r.contract;
    const target = listing ?? contract ?? null;
    return {
        id: r.id, listingId: r.listing_id, contractId: r.contract_id,
        reporterId: r.reporter_id, reporterName: reporter?.name ?? null, reporterAvatarUrl: reporter?.avatar_url ?? null,
        reasonCategory: r.reason_category, details: r.details,
        status: r.status as MarketplaceReport['status'],
        reviewedAt: r.reviewed_at, reviewedById: r.reviewed_by_id, reviewerName: reviewer?.name ?? null,
        createdAt: r.created_at,
        targetType: listing ? 'listing' : 'contract',
        targetId: target ? String(target.id) : null,
        targetTitle: target?.title ?? null,
        targetStatus: target?.status ?? null,
        targetSellerId: target?.seller_id ?? null,
    };
};

/** Admin moderation queue. No status filter ⇒ the open work (open + reviewing);
 *  'all' ⇒ full history; a specific status ⇒ just that bucket. */
export async function listMarketplaceReports(statusFilter?: string): Promise<MarketplaceReport[]> {
    let q = supabase.from('marketplace_reports').select(REPORT_SELECT);
    if (statusFilter && statusFilter !== 'all') q = q.eq('status', statusFilter);
    else if (!statusFilter) q = q.in('status', ['open', 'reviewing']);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(200);
    handleSupabaseError({ error, message: 'Failed to load marketplace reports' });
    return ((data as unknown as ReportRow[]) || []).map(toReport);
}

/** Resolve a report. 'actioned' on a listing report takes the listing down
 *  (status → closed) and notifies its owner; 'dismissed' clears it untouched.
 *  Contract reports record the decision only (no auto-cancel). */
export async function reviewMarketplaceReport(id: number, decision: 'actioned' | 'dismissed', reviewerId: number): Promise<void> {
    if (decision !== 'actioned' && decision !== 'dismissed') throw new Error('Invalid decision.');
    const { data: r } = await supabase.from('marketplace_reports')
        .select('id, status, listing_id').eq('id', id).maybeSingle();
    const report = r as unknown as { id: number; status: string; listing_id: string | null } | null;
    if (!report) throw new Error('Report not found.');
    if (report.status === 'actioned' || report.status === 'dismissed') throw new Error('This report is already resolved.');

    const { error } = await supabase.from('marketplace_reports')
        .update({ status: decision, reviewed_at: nowIso(), reviewed_by_id: reviewerId }).eq('id', id);
    handleSupabaseError({ error, message: 'Failed to resolve report' });

    if (decision === 'actioned' && report.listing_id) {
        const { data: l } = await supabase.from('marketplace_listings')
            .select('id, seller_id, status, title').eq('id', report.listing_id).maybeSingle();
        const listing = l as unknown as { id: string; seller_id: number; status: string; title: string } | null;
        if (listing && listing.status !== 'closed') {
            // Stamp moderation_closed_at so the seller can't simply reopen the
            // listing (updateMarketplaceListing refuses status:active while set).
            const closePatch: Record<string, unknown> = { status: 'closed', updated_at: nowIso(), moderation_closed_at: nowIso() };
            let { error: upErr } = await supabase.from('marketplace_listings')
                .update(closePatch).eq('id', listing.id);
            // Soft-fail if the column predates the schema redeploy — still close it.
            const upCode = (upErr as { code?: string } | null)?.code;
            if (upErr && (upCode === '42703' || upCode === 'PGRST204')) {
                delete closePatch.moderation_closed_at;
                ({ error: upErr } = await supabase.from('marketplace_listings').update(closePatch).eq('id', listing.id));
            }
            if (upErr) { log.error('report-takedown listing close failed', { err: upErr, id: listing.id }); return; }
            emit({ listingId: listing.id });
            // Notify the owner their listing was removed by moderation (best-effort).
            sendPushToUsers([listing.seller_id], {
                title: 'Listing Removed',
                body: `Your marketplace listing "${listing.title}" was removed by a moderator.`,
                tag: 'marketplace-moderation',
                data: { url: '/marketplace' },
            });
        }
    }
}

// =============================================================================
// Aggregate state (folded into getState, gated marketplace:view)
// =============================================================================
export async function getMarketplaceState(userId: number) {
    const [categories, listings, contracts] = await Promise.all([
        getMarketplaceCategories(),
        browseMarketplaceListings({}),
        getMyMarketplaceContracts(userId),
    ]);
    return { marketplaceCategories: categories, marketplaceListings: listings, marketplaceContracts: contracts };
}
