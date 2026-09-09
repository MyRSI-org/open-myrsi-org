import { supabase, handleSupabaseError, safeFetch } from './common.js';
import { toBlueprint, toBlueprintRequest, toCraftableItem } from './mappers.js';
import { requireIntId, escapeLikePattern } from '../pgrest.js';
import { SecurityDenial } from '../errors.js';
import type { Blueprint, BlueprintRequest, BlueprintRequestStatus, CraftableItem } from '../../types.js';

// ---------------------------------------------------------------------------
// Blueprint Manager — registry + two-sided crafting-request lifecycle.
// ---------------------------------------------------------------------------
// BOTH registry reads are gated `blueprint:view`. listCraftableItems is a
// DE-DUPLICATED ITEM PICKER for the request flow, not a security boundary —
// hosted's "Clients see items, members see owners" split is dead machinery here
// because CLIENT_DEFAULT_PERMS (lib/clientRolePermissions.ts) is code-clamped to
// three request:* strings and clientRoleLock strips anything else off the seeded
// Client role. The residual hosted's split was aimed at survives, and is the same
// one Academy carries: an org whose real customers sit on a CUSTOM role can be
// granted blueprint:* by hand (lib/clientNamespaces.ts documents that acceptance).
// So this module is members-only BY OPERATOR CONVENTION, not by a code boundary —
// do not describe it as one.
//
// What the picker still buys, and why the projection stays owner-free: two owners
// offering the same item collapse to ONE row, so the list cannot be counted to
// learn how many members hold a blueprint. That is a property worth keeping even
// among members.
//
// crafter_id is the ONE place a requester learns an owner's identity, and only
// after that crafter voluntarily claims their request.
//
// NO BROADCAST anywhere in this file. The view is RPC-hydrated and refetches after
// each mutation, so an `id`-only broadcast would have no consumer (Rule 4: a
// broadcast with no consumer gets deleted, not kept).
//
// NOTE ON EGRESS: /api/services returns a handler's result directly — stripSecrets
// lives on the /api/query path only. toBlueprint / toBlueprintRequest are therefore
// the ONLY narrowing between a DB row and the browser. Keep them field-by-field.

/** Shape `safeFetch<T>` expects: a thenable yielding { data, error }. */
type FetchResult<T> = PromiseLike<{ data: T | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>;

// Minimal column lists. A by-id fetcher MUST reuse the SAME const as its list
// query so the two never drift. Rule 1: the ESLint AST rule cannot see inside
// these consts — keep them wildcard-free by hand.
const BLUEPRINT_COLS = 'id, owner_id, qm_catalog_id, item_name, category, notes, offers_crafting, created_at, updated_at';
// deleted_at is here so the mapper can WITHHOLD a departed member's name, not to
// display it. See toBlueprintParty.
const PARTY_COLS = 'id, name, avatar_url, rsi_handle, deleted_at';
const BLUEPRINT_OWNER_EMBED = `owner:users!blueprints_owner_id_fkey(${PARTY_COLS})`;
const BLUEPRINT_SELECT = `${BLUEPRINT_COLS}, ${BLUEPRINT_OWNER_EMBED}`;

/**
 * The owner-free column set. Deliberately NOT derived from BLUEPRINT_COLS — it
 * must not inherit a column added there later.
 */
const CRAFTABLE_COLS = 'qm_catalog_id, item_name, category';

const REQUEST_COLS = 'id, requester_id, crafter_id, blueprint_id, qm_catalog_id, item_name, quantity, materials_note, offer_price_uec, status, claimed_at, ready_at, delivered_at, completed_at, cancelled_at, cancel_reason, created_at, updated_at';
const REQUEST_SELECT = `${REQUEST_COLS}, requester:users!blueprint_requests_requester_id_fkey(${PARTY_COLS}), crafter:users!blueprint_requests_crafter_id_fkey(${PARTY_COLS})`;

// Server-authoritative limits (the UI mirrors them).
const MAX_LIST = 500;
const DEFAULT_LIST = 200;
const MAX_ITEM_NAME_LEN = 160;
const MAX_NOTES_LEN = 2000;
const MAX_QUANTITY = 10000;
const MAX_UEC = 1_000_000_000_000;   // 1e12, matches the CHECK in schema.sql

/** Identical message for a missing row and a forbidden one — no existence oracle. */
const ERR_BLUEPRINT = 'Blueprint not found or access denied.';
const ERR_REQUEST = 'Crafting request not found or access denied.';

type BlueprintRowWithEmbeds = Parameters<typeof toBlueprint>[0];
type RequestRowWithEmbeds = Parameters<typeof toBlueprintRequest>[0];

function clampLimit(limit: unknown): number {
    const n = typeof limit === 'number' ? limit : Number(limit);
    // Lower-clamped to 1: a fractional limit floored to 0 would silently return an
    // empty list rather than the caller's "smallest page".
    return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.floor(n), 1), MAX_LIST) : DEFAULT_LIST;
}

function requiredText(raw: unknown, field: string, max: number): string {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) throw new Error(`${field} is required.`);
    if (s.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
    return s;
}

function optionalText(raw: unknown, field: string, max: number): string | null {
    if (raw == null || raw === '') return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (s.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
    return s;
}

function clampQuantity(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.min(Math.max(Math.floor(n), 1), MAX_QUANTITY);
}

function normalizeUec(raw: unknown): number | null {
    if (raw == null || raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) throw new Error('Offered price must be a number.');
    const v = Math.floor(n);
    if (v < 0 || v > MAX_UEC) throw new Error(`Offered price must be between 0 and ${MAX_UEC.toLocaleString()} aUEC.`);
    return v;
}

/** Coerce an optional client-supplied id to a positive integer, or null. */
function positiveIntOrNull(raw: unknown): number | null {
    if (raw == null || raw === '' || raw === false) return null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Reference asserts (Rule 2 — no BOLA on client-supplied FK values)
// ---------------------------------------------------------------------------

/**
 * Resolve the category a catalog pin implies, and prove the pin exists.
 *
 * Single-org: there is no tenant dimension on quartermaster_catalog, so a bad id
 * is a plain bad reference, NOT a cross-org attack — it throws an ordinary Error
 * and emits no security event. Writing a `cross_org` audit row in a single-org
 * deployment would be a permanent lie in security_events.
 *
 * An absent Quartermaster table (42P01) is tolerated but treated as a MISS, never
 * a pass: the module must not hard-fail without QM, and must not let an
 * unvalidated reference through either.
 */
async function resolveCatalogCategory(qmCatalogId: number | null): Promise<{ category: string | null }> {
    if (qmCatalogId == null) return { category: null };
    const { data, error } = await supabase.from('quartermaster_catalog')
        // `category` is the SOURCE of a blueprint's category — the field is not
        // client-authored. Explicit and minimal per Rule 1.
        .select('id, category')
        .eq('id', qmCatalogId)
        .maybeSingle();
    if (error && error.code !== '42P01') handleSupabaseError({ error, message: 'Failed to validate catalog item' });
    if (!data) throw new Error('Referenced catalog item was not found.');
    return { category: (data as { category?: string | null }).category ?? null };
}

/**
 * Load a blueprint and return the columns every caller's guard needs. Throws on a
 * missing row rather than relying on a scoped UPDATE silently no-op'ing.
 */
async function loadBlueprint(blueprintId: unknown): Promise<{ id: number; owner_id: number }> {
    const id = positiveIntOrNull(blueprintId);
    if (!id) throw new Error(ERR_BLUEPRINT);
    const { data, error } = await supabase.from('blueprints')
        .select('id, owner_id')
        .eq('id', id)
        .maybeSingle();
    // A transient DB fault also yields data === null. Surfacing that as a denial
    // would poison the audit trail, so only a CLEAN miss is an authorization miss.
    handleSupabaseError({ error, message: 'Failed to load blueprint' });
    if (!data) throw new Error(ERR_BLUEPRINT);
    return data as { id: number; owner_id: number };
}

/**
 * A crafting request may only be raised for an item somebody ELSE has actually
 * offered to craft — that toggle is the whole consent model.
 *
 * Returns the CANONICAL item name from the matched registry row; the caller
 * persists that rather than the client's string. Two reasons:
 *   - the client's `itemName` is otherwise unbound from the `qmCatalogId` it
 *     claims to describe, so a caller could pin a genuinely craftable catalog id
 *     and store 160 characters of arbitrary text, which then lands on every
 *     crafter's board and inside their notifications;
 *   - the name is matched by EXACT case-insensitive comparison in JS, with the
 *     ilike used only to narrow. An unescaped ilike pattern (`%`, `_`, or a `*`
 *     that PostgREST rewrites to `%`) would otherwise match any offered item and
 *     wave the request straight past this gate. escapeLikePattern escapes rather
 *     than STRIPS — hosted's likeSafe strips, which silently turns a search for
 *     `Ballista_5` into a search for `Ballista5`.
 *
 * A request nobody but the requester could fill is a dead request: it sits `open`
 * forever, because claimBlueprintRequest already refuses a self-claim. Excluding
 * the requester's own rows HERE is what makes "you cannot raise a crafting
 * request against yourself" true.
 *
 * The matched row's OWNER is never surfaced to the caller.
 */
async function resolveCraftableItemName(qmCatalogId: number | null, itemName: string, requesterId: number): Promise<string> {
    const deny = () => new Error('Nobody else in this organisation is currently offering to craft that item.');
    const rid = requireIntId(requesterId, 'requesterId');

    if (qmCatalogId != null) {
        // Ordered even though only one row is taken: this row's item_name becomes the
        // CANONICAL string persisted on the request, so an arbitrary pick among two
        // owners' rows means two identical submissions can store different casing.
        const { data, error } = await supabase.from('blueprints')
            .select('item_name')
            .eq('offers_crafting', true)
            .eq('qm_catalog_id', qmCatalogId)
            .neq('owner_id', rid)
            .order('id', { ascending: true })
            .limit(1)
            .maybeSingle();
        if (error && error.code !== '42P01') handleSupabaseError({ error, message: 'Failed to validate craftable item' });
        if (!data) throw deny();
        return (data as { item_name: string }).item_name;
    }

    const wanted = itemName.trim().toLowerCase();
    const { data, error } = await supabase.from('blueprints')
        .select('item_name')
        .eq('offers_crafting', true)
        .neq('owner_id', rid)
        .ilike('item_name', escapeLikePattern(itemName))
        .order('id', { ascending: true })
        .limit(MAX_LIST);
    if (error && error.code !== '42P01') handleSupabaseError({ error, message: 'Failed to validate craftable item' });
    const match = ((data || []) as { item_name: string }[])
        .find(r => r.item_name.trim().toLowerCase() === wanted);
    if (!match) throw deny();
    return match.item_name;
}

// ---------------------------------------------------------------------------
// Registry reads
// ---------------------------------------------------------------------------

/**
 * The registry: every registered blueprint with its owner. Gated `blueprint:view`.
 *
 * The owner embed carries the same four roster-safe fields as marketplace's
 * TRADER_FIELDS under the equally member-wide `marketplace:view`, which is the
 * precedent this follows. It sits OUTSIDE lib/rosterGate.ts `mayReceiveRoster`
 * deliberately: that gate governs the roster ITSELF (getMainState, users_slice,
 * user_detail, users_presence), and a name+avatar riding on a row somebody
 * published to the org board is not the roster. Adding blueprint:view to
 * ROSTER_AUTHORITY_PERMS would grant the whole roster, which is the wrong trade.
 *
 * The order+limit are hoisted onto the builder BEFORE safeFetch on purpose: an
 * order/limit written inside the safeFetch(...) argument is invisible to
 * tests/listReadOrderRatchet.test.ts, which then reads this as an uncapped,
 * unordered list read. Keep the chain on `query`.
 */
export async function listBlueprints(opts: { search?: string; craftableOnly?: boolean; ownerId?: number; limit?: number } = {}): Promise<Blueprint[]> {
    let query = supabase.from('blueprints').select(BLUEPRINT_SELECT);
    if (opts.craftableOnly) query = query.eq('offers_crafting', true);
    if (opts.ownerId != null) query = query.eq('owner_id', requireIntId(opts.ownerId, 'ownerId'));
    if (opts.search) query = query.ilike('item_name', `%${escapeLikePattern(opts.search)}%`);
    query = query
        .order('item_name', { ascending: true })
        .order('id', { ascending: true })
        .limit(clampLimit(opts.limit));

    const rows = await safeFetch(query as unknown as FetchResult<BlueprintRowWithEmbeds[]>, [], 'blueprints.list');
    return (rows || []).map(toBlueprint);
}

/**
 * The craftable-item picker: what the org can craft, with no owner identity.
 * De-duplication happens in JS because PostgREST has no DISTINCT ON — but note
 * the dedupe operates on rows that never carried an owner in the first place.
 */
export async function listCraftableItems(
    opts: { search?: string; limit?: number; category?: string; viewerId?: number } = {},
): Promise<{ items: CraftableItem[]; truncated: boolean }> {
    let query = supabase.from('blueprints')
        .select(CRAFTABLE_COLS)
        .eq('offers_crafting', true);
    // Hide the viewer's OWN offers. They cannot raise a request against themselves
    // (resolveCraftableItemName refuses it), so listing an item only they offer
    // would be an invitation to an error. owner_id is a column on this table, so
    // this filter needs no users join and the projection stays owner-free.
    if (opts.viewerId != null) query = query.neq('owner_id', requireIntId(opts.viewerId, 'viewerId'));
    if (opts.category) query = query.eq('category', opts.category);
    if (opts.search) query = query.ilike('item_name', `%${escapeLikePattern(opts.search)}%`);
    query = query
        .order('item_name', { ascending: true })
        .order('id', { ascending: true })
        .limit(MAX_LIST);

    const rows = await safeFetch(
        query as unknown as FetchResult<{ qm_catalog_id: number | null; item_name: string; category: string | null }[]>,
        [],
        'blueprints.craftable',
    );

    const fetched = rows || [];
    const seen = new Set<string>();
    const out: CraftableItem[] = [];
    const cap = clampLimit(opts.limit);
    for (const row of fetched) {
        // Two owners offering the same item collapse to ONE entry — otherwise the
        // number of duplicate rows would count the owners, which is exactly the fact
        // this projection withholds.
        //
        // The key is the NAME ALONE, deliberately. Keying on qm_catalog_id first made
        // the dedupe bimodal: one owner who picked the item out of the Quartermaster
        // catalog and another who typed the same name freehand produced two rows, and
        // since the unique index is (owner_id, lower(item_name)) a duplicate name is
        // GUARANTEED to be a second owner — so the count leaked exactly. Mixed pinning
        // is the normal state, because the catalog picker only renders for members who
        // hold qm:view with Quartermaster enabled.
        const key = row.item_name.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(toCraftableItem(row));
        if (out.length >= cap) break;
    }
    // Two ways this list can be short of the truth: the caller's page filled, or the
    // DB read itself hit MAX_LIST before the dedupe ever ran. Say so rather than
    // presenting a truncated picker as the whole catalogue.
    return { items: out, truncated: fetched.length >= MAX_LIST || out.length >= cap };
}

// ---------------------------------------------------------------------------
// Registry writes
// ---------------------------------------------------------------------------

export async function registerBlueprint(data: Record<string, unknown>, ownerId: number): Promise<Blueprint> {
    const qmCatalogId = positiveIntOrNull(data.qmCatalogId);
    // Category is DERIVED from the pinned catalog row, never taken from the client.
    // As free member text it was unbound from the item it claimed to describe — you
    // could pin catalog row 100 ("weapon") and store any 80 characters you liked.
    // Deriving it also gives the picker a vocabulary to group by.
    const { category } = await resolveCatalogCategory(qmCatalogId);

    const { data: row, error } = await supabase.from('blueprints').insert({
        owner_id: ownerId,
        qm_catalog_id: qmCatalogId,
        item_name: requiredText(data.itemName, 'Item name', MAX_ITEM_NAME_LEN),
        // NULL for a freehand entry (no catalog pin) — those show as Uncategorised.
        category,
        notes: optionalText(data.notes, 'Notes', MAX_NOTES_LEN),
        offers_crafting: data.offersCrafting === true,
    }).select(BLUEPRINT_SELECT).single();

    if (error?.code === '23505') throw new Error('You have already registered that blueprint.');
    handleSupabaseError({ error, message: 'Failed to register blueprint' });
    return toBlueprint(row as unknown as BlueprintRowWithEmbeds);
}

/**
 * Explicit allowlist — never spread a client patch blob into the row (Rule 2,
 * mass-assignment). owner_id is NOT editable here.
 *
 * The allowlist is also the ONLY thing standing between an actor-id field and the
 * row: the dispatcher overwrites every ACTOR_ID_FIELDS key in the payload with the
 * caller's own id, and the handler rest-spreads what is left into `patch`. Those
 * keys are not in this list, so they are ignored — that is by design, and the test
 * file pins it.
 */
export async function updateBlueprint(blueprintId: number, patch: Record<string, unknown>, userId: number, canManage: boolean): Promise<Blueprint> {
    const existing = await loadBlueprint(blueprintId);
    if (existing.owner_id !== userId && !canManage) {
        throw new SecurityDenial('You can only edit blueprints you registered.', {
            auditEvent: 'authz.resource.denied',
            fields: { blueprintId: existing.id, userId },
        });
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ('itemName' in patch) updates.item_name = requiredText(patch.itemName, 'Item name', MAX_ITEM_NAME_LEN);
    if ('notes' in patch) updates.notes = optionalText(patch.notes, 'Notes', MAX_NOTES_LEN);
    // `category` is deliberately NOT in this allowlist — it follows the catalog pin
    // (the qmCatalogId branch below). Ignoring the key rather than erroring means an
    // older client that still sends it is harmless.
    //
    // CONSENT DOES NOT TRANSFER. blueprint:manage may moderate someone else's entry
    // (rename, retag, remove) but may not decide on their behalf that they will craft
    // for others — that toggle is what publishes their item to the craftable picker
    // and admits requests against them. It is the owner's call alone.
    if ('offersCrafting' in patch) {
        if (existing.owner_id !== userId) {
            throw new SecurityDenial('Only the member who registered a blueprint can offer it for crafting.', {
                auditEvent: 'authz.resource.denied',
                fields: { blueprintId: existing.id, userId },
            });
        }
        updates.offers_crafting = patch.offersCrafting === true;
    }
    if ('qmCatalogId' in patch) {
        const qmCatalogId = positiveIntOrNull(patch.qmCatalogId);
        const { category } = await resolveCatalogCategory(qmCatalogId);
        updates.qm_catalog_id = qmCatalogId;
        // Category travels WITH the pin, including back to null when it is cleared —
        // otherwise unlinking would strand a category with nothing behind it.
        updates.category = category;
    }

    const { data: row, error } = await supabase.from('blueprints')
        .update(updates)
        .eq('id', existing.id)
        .select(BLUEPRINT_SELECT)
        .single();

    if (error?.code === '23505') {
        throw new Error(existing.owner_id === userId
            ? 'You have already registered that blueprint.'
            : 'That member has already registered a blueprint with that name.');
    }
    handleSupabaseError({ error, message: 'Failed to update blueprint' });
    return toBlueprint(row as unknown as BlueprintRowWithEmbeds);
}

export async function deleteBlueprint(blueprintId: number, userId: number, canManage: boolean): Promise<{ id: number }> {
    const existing = await loadBlueprint(blueprintId);
    if (existing.owner_id !== userId && !canManage) {
        throw new SecurityDenial('You can only remove blueprints you registered.', {
            auditEvent: 'authz.resource.denied',
            fields: { blueprintId: existing.id, userId },
        });
    }
    const { error } = await supabase.from('blueprints').delete().eq('id', existing.id);
    handleSupabaseError({ error, message: 'Failed to remove blueprint' });
    // In-flight requests survive: blueprint_id is ON DELETE SET NULL and the
    // request's own item_name/qm_catalog_id were frozen at creation.
    return { id: existing.id };
}

/**
 * Stand a departing member down: withdraw their crafting offers AND release any
 * request they were mid-way through. Called from deleteUser.
 *
 * Member removal is a SOFT delete and the registry deliberately keeps the rows — a
 * blueprint is org history. `offers_crafting` is not history though, it is a live
 * consent flag: it is the only thing that publishes an item to the craftable picker
 * and the only thing that admits a new crafting request. Left set, a member who has
 * left keeps advertising work nobody can fulfil.
 *
 * The CLAIM half is the open build's addition. A member removed mid-job otherwise
 * strands their claimed requests in `claimed` with a crafter_id nobody can act as:
 * only the requester (cancel) or a blueprint:manage holder (release) can clear it,
 * and neither is watching. Handing those back to the board is the same act as
 * withdrawing the offer — standing the person down from work they cannot do.
 *
 * Throws on a real failure; the caller decides whether that is fatal (deleteUser
 * logs and continues — a member removal must not hinge on an optional module). A
 * missing table is NOT a real failure: this module's schema may not be applied.
 */
export async function withdrawCraftingOffers(userId: number): Promise<{ offersWithdrawn: number; claimsReleased: number }> {
    const uid = requireIntId(userId, 'userId');
    const now = new Date().toISOString();

    const { data: offers, error: offerErr } = await supabase.from('blueprints')
        .update({ offers_crafting: false, updated_at: now })
        .eq('owner_id', uid)
        .eq('offers_crafting', true)
        .select('id');
    if (offerErr && offerErr.code !== '42P01') {
        handleSupabaseError({ error: offerErr, message: 'Failed to withdraw crafting offers' });
    }

    // Only `claimed` is released. A `ready` or `delivered` job is one the requester
    // still has to close out, and silently reopening it would erase work that was
    // actually done.
    const { data: released, error: claimErr } = await supabase.from('blueprint_requests')
        .update({ status: 'open', crafter_id: null, claimed_at: null, blueprint_id: null, updated_at: now })
        .eq('crafter_id', uid)
        .eq('status', 'claimed')
        .select('id');
    if (claimErr && claimErr.code !== '42P01') {
        handleSupabaseError({ error: claimErr, message: 'Failed to release crafting claims' });
    }

    return {
        offersWithdrawn: ((offers || []) as { id: number }[]).length,
        claimsReleased: ((released || []) as { id: number }[]).length,
    };
}

// ---------------------------------------------------------------------------
// Request reads
// ---------------------------------------------------------------------------

/**
 * Visibility ladder, narrowest first:
 *   - no craft/manage → their OWN requests only.
 *   - blueprint:craft → own (as requester or crafter) + the open board.
 *   - blueprint:manage → everything.
 */
export async function listBlueprintRequests(
    viewerId: number,
    opts: { canCraft?: boolean; canManage?: boolean; status?: BlueprintRequestStatus; limit?: number } = {},
): Promise<BlueprintRequest[]> {
    // vid is interpolated into the .or() filter string below — validate it as an
    // integer first so it can never carry PostgREST filter syntax.
    const vid = requireIntId(viewerId, 'viewerId');

    let query = supabase.from('blueprint_requests').select(REQUEST_SELECT);
    if (!opts.canManage) {
        query = opts.canCraft
            ? query.or(`requester_id.eq.${vid},crafter_id.eq.${vid},status.eq.open`)
            : query.eq('requester_id', vid);
    }
    if (opts.status) query = query.eq('status', opts.status);
    query = query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(clampLimit(opts.limit));

    const rows = await safeFetch(query as unknown as FetchResult<RequestRowWithEmbeds[]>, [], 'blueprints.requests');
    return (rows || []).map(toBlueprintRequest);
}

// ---------------------------------------------------------------------------
// Request lifecycle
// ---------------------------------------------------------------------------

async function loadRequest(requestId: unknown): Promise<{ id: number; requester_id: number; crafter_id: number | null; status: BlueprintRequestStatus }> {
    const id = positiveIntOrNull(requestId);
    if (!id) throw new Error(ERR_REQUEST);
    const { data, error } = await supabase.from('blueprint_requests')
        .select('id, requester_id, crafter_id, status')
        .eq('id', id)
        .maybeSingle();
    // See loadBlueprint: a query error is a fault, not an attack.
    handleSupabaseError({ error, message: 'Failed to load crafting request' });
    if (!data) throw new Error(ERR_REQUEST);
    return data as { id: number; requester_id: number; crafter_id: number | null; status: BlueprintRequestStatus };
}

/**
 * Apply a transition as a compare-and-swap: the UPDATE re-asserts the expected
 * `from` status AND the actor predicate in its WHERE clause, so two concurrent
 * callers cannot both apply it (the loser matches zero rows and throws).
 *
 * `actor` is not optional decoration. Status alone is an A-B-A: crafter A reads a
 * `claimed` row, releases it from a second connection, crafter B claims it, and
 * A's in-flight UPDATE still matches `status = 'claimed'` — advancing B's job on
 * A's behalf. Re-asserting crafter_id/requester_id in the same WHERE makes the
 * swap fail for anyone who is no longer the party they read as.
 */
async function transitionRequest(
    requestId: number,
    from: BlueprintRequestStatus,
    updates: Record<string, unknown>,
    actor?: { column: 'crafter_id' | 'requester_id'; userId: number } | { column: 'crafter_id'; unclaimed: true },
): Promise<BlueprintRequest> {
    let query = supabase.from('blueprint_requests')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', requestId)
        .eq('status', from);
    if (actor) {
        query = 'unclaimed' in actor
            ? query.is(actor.column, null)
            : query.eq(actor.column, actor.userId);
    }
    const { data: row, error } = await query.select(REQUEST_SELECT).maybeSingle();
    handleSupabaseError({ error, message: 'Failed to update crafting request' });
    if (!row) {
        // Someone else moved it between our read and our write.
        throw new Error('That crafting request has already moved on — refresh and try again.');
    }
    return toBlueprintRequest(row as unknown as RequestRowWithEmbeds);
}

/**
 * How many requests one member may have in flight at once.
 *
 * Every created request fans a notification to every blueprint:craft holder — and
 * in this build createNotification is one row insert, one realtime broadcast AND
 * one web push each. Without a ceiling, the lowest-privileged role that can raise
 * a request holds an amplification lever: at the per-IP request cap and 50
 * crafters that is thousands of notifications, pushes and realtime messages a
 * minute from one account. Capping open requests bounds it at the source rather
 * than trying to rate-limit the fan-out afterwards.
 */
const MAX_OPEN_REQUESTS_PER_REQUESTER = 10;

/**
 * ...and the OPEN cap above does not actually bound that amplifier, which is why
 * this exists beside it.
 *
 * Counting requests in a non-terminal status is a CONCURRENCY limit: cancel ten and
 * raise ten more, and the fan-out fires again. Repeat, and the ceiling the comment
 * above claims is simply not there — it caps how many requests exist at once, not how
 * many notifications one account can cause over time. `cancelBlueprintRequest` is
 * self-service, so the reset costs the attacker one extra call per request.
 *
 * So the amplifier gets a bound in the dimension it actually runs in: creations per
 * rolling window, counted on created_at and INDEPENDENT of status, so cancelling
 * cannot rewind it. 20 per rolling 24h against MAX_NOTIFY_FANOUT of 50 puts the
 * ceiling at 1,000 notifications a day from one account — generous for a real member
 * (the open cap of 10 bites long before it) and finite for an abusive one.
 *
 * Both caps are kept: the open cap is the useful "close some before raising another"
 * guidance, and this one is the security bound. Same fail-CLOSED treatment — an
 * unreadable count refuses rather than waving the request through.
 */
const MAX_REQUESTS_PER_WINDOW = 20;
const REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function createBlueprintRequest(data: Record<string, unknown>, requesterId: number): Promise<BlueprintRequest> {
    // THE ERROR IS BOUND, DELIBERATELY. Hosted discards it, so a 42P01, a statement
    // timeout or any PostgREST fault yields count === null → `?? 0` → the cap reads
    // as SATISFIED. This is the one place in the module where the fail-open direction
    // is indefensible: it is the sole bound on the amplifier described above. A read
    // fault refuses the request; it does not wave it through.
    const { count: openCount, error: countErr } = await supabase.from('blueprint_requests')
        .select('id', { count: 'exact', head: true })
        .eq('requester_id', requireIntId(requesterId, 'requesterId'))
        .in('status', ['open', 'claimed', 'ready', 'delivered']);
    handleSupabaseError({ error: countErr, message: 'Failed to check your open crafting requests' });
    if (openCount == null) throw new Error('Could not verify your open crafting requests. Try again in a moment.');
    if (openCount >= MAX_OPEN_REQUESTS_PER_REQUESTER) {
        throw new Error(`You already have ${MAX_OPEN_REQUESTS_PER_REQUESTER} crafting requests in progress. Close some before raising another.`);
    }

    // The RATE bound. Counted on created_at with NO status filter, so cancelling a
    // request cannot buy another slot — that is the whole difference between this and
    // the open cap above. Fails closed identically.
    const windowStart = new Date(Date.now() - REQUEST_WINDOW_MS).toISOString();
    const { count: recentCount, error: rateErr } = await supabase.from('blueprint_requests')
        .select('id', { count: 'exact', head: true })
        .eq('requester_id', requireIntId(requesterId, 'requesterId'))
        .gte('created_at', windowStart);
    handleSupabaseError({ error: rateErr, message: 'Failed to check your recent crafting requests' });
    if (recentCount == null) throw new Error('Could not verify your recent crafting requests. Try again in a moment.');
    if (recentCount >= MAX_REQUESTS_PER_WINDOW) {
        throw new Error('You have raised too many crafting requests today. Try again later.');
    }

    const qmCatalogId = positiveIntOrNull(data.qmCatalogId);
    await resolveCatalogCategory(qmCatalogId);
    // Server-derived from the matched registry row, never the client's string — and
    // matched against OTHER members' offers only, so a request can never be one that
    // only the requester could fill.
    const itemName = await resolveCraftableItemName(
        qmCatalogId, requiredText(data.itemName, 'Item name', MAX_ITEM_NAME_LEN), requesterId,
    );

    const { data: row, error } = await supabase.from('blueprint_requests').insert({
        requester_id: requesterId,
        // blueprint_id stays NULL until a crafter claims it — pinning one owner's
        // registry row at creation would tell the requester who matched.
        blueprint_id: null,
        crafter_id: null,
        qm_catalog_id: qmCatalogId,
        item_name: itemName,
        quantity: clampQuantity(data.quantity),
        materials_note: optionalText(data.materialsNote, 'Materials note', MAX_NOTES_LEN),
        offer_price_uec: normalizeUec(data.offerPriceUec),
        status: 'open',
    }).select(REQUEST_SELECT).single();

    handleSupabaseError({ error, message: 'Failed to raise crafting request' });
    return toBlueprintRequest(row as unknown as RequestRowWithEmbeds);
}

/**
 * open → claimed. Any member with blueprint:craft may claim; owning a matching
 * registered blueprint is NOT required (free-text names make that unreliable), but
 * if the crafter owns one FOR THIS ITEM it is recorded as provenance.
 */
export async function claimBlueprintRequest(requestId: number, crafterId: number): Promise<BlueprintRequest> {
    const existing = await loadRequest(requestId);
    if (existing.status !== 'open') throw new Error('Only an open request can be claimed.');
    if (existing.requester_id === crafterId) throw new Error('You cannot claim your own crafting request.');

    return transitionRequest(existing.id, 'open', {
        status: 'claimed',
        crafter_id: crafterId,
        claimed_at: new Date().toISOString(),
        blueprint_id: await findCrafterBlueprintForRequest(crafterId, existing.id),
    }, { column: 'crafter_id', unclaimed: true });
}

/**
 * The claiming crafter's own registry entry FOR THE REQUESTED ITEM, or null.
 * Matching on owner alone would pin whichever of their blueprints Postgres
 * happened to return first — a provenance column pointing at the wrong row, and
 * one that ships to the requester.
 */
async function findCrafterBlueprintForRequest(crafterId: number, requestId: number): Promise<number | null> {
    const { data: req } = await supabase.from('blueprint_requests')
        .select('item_name, qm_catalog_id')
        .eq('id', requestId)
        .maybeSingle();
    const target = req as { item_name: string; qm_catalog_id: number | null } | null;
    if (!target) return null;

    let query = supabase.from('blueprints')
        .select('id, item_name')
        .eq('owner_id', crafterId)
        .eq('offers_crafting', true);
    query = target.qm_catalog_id != null
        ? query.eq('qm_catalog_id', target.qm_catalog_id)
        : query.ilike('item_name', escapeLikePattern(target.item_name));
    query = query.order('id', { ascending: true }).limit(MAX_LIST);

    const { data } = await query;
    const rows = (data || []) as { id: number; item_name: string }[];
    if (target.qm_catalog_id != null) return rows[0]?.id ?? null;
    const wanted = target.item_name.trim().toLowerCase();
    return rows.find(r => r.item_name.trim().toLowerCase() === wanted)?.id ?? null;
}

/**
 * claimed → open. The claiming crafter (or blueprint:manage) hands it back.
 *
 * Returns the released crafter alongside the row: the row has already had
 * crafter_id nulled, so a caller that wants to tell the ex-crafter their claim was
 * taken off them (the blueprint:manage path) has no other way to reach them.
 */
export async function releaseBlueprintRequest(requestId: number, userId: number, canManage: boolean): Promise<BlueprintRequest & { releasedCrafterId: number | null }> {
    const existing = await loadRequest(requestId);
    // Ownership BEFORE status — see confirmBlueprintRequestReceived for the full
    // reasoning. The other order is an id-space oracle: the two failures return
    // DIFFERENT messages, so any blueprint:craft holder could walk request ids and
    // read back "wrong state" versus "not yours" to map every request's status,
    // which is exactly what pinning non-crafters to their own rows in
    // listBlueprintRequests exists to prevent.
    if (existing.crafter_id !== userId && !canManage) {
        throw new SecurityDenial('Only the crafter who claimed this request can release it.', {
            auditEvent: 'authz.resource.denied',
            fields: { requestId: existing.id, userId },
        });
    }
    if (existing.status !== 'claimed') throw new Error('Only a claimed request can be released.');
    // The CAS pins the crafter we READ, so a manage-holder releasing someone else's
    // claim still cannot race a re-claim by a third party.
    //
    // UNCONDITIONAL, unlike hosted's. Hosted drops the actor predicate entirely when
    // crafter_id is null, which turns the swap into a status-only guard on exactly
    // the malformed row (claimed with no crafter — reachable through an import or
    // direct SQL) where an unexpected state most deserves the stricter check.
    const actor: { column: 'crafter_id'; userId: number } | { column: 'crafter_id'; unclaimed: true } =
        existing.crafter_id != null
            ? { column: 'crafter_id', userId: existing.crafter_id }
            : { column: 'crafter_id', unclaimed: true };
    const released = await transitionRequest(existing.id, 'claimed', {
        status: 'open',
        crafter_id: null,
        claimed_at: null,
        blueprint_id: null,
    }, actor);
    return { ...released, releasedCrafterId: existing.crafter_id };
}

/** claimed → ready. Crafter only — blueprint:manage does NOT stand in for them. */
export async function markBlueprintRequestReady(requestId: number, userId: number): Promise<BlueprintRequest> {
    const existing = await loadRequest(requestId);
    assertIsCrafter(existing, userId, 'markBlueprintRequestReady');   // ownership BEFORE status — oracle
    if (existing.status !== 'claimed') throw new Error('Only a claimed request can be marked ready.');
    return transitionRequest(existing.id, 'claimed', {
        status: 'ready',
        ready_at: new Date().toISOString(),
    }, { column: 'crafter_id', userId });
}

/** ready → delivered. Crafter only. */
export async function markBlueprintRequestDelivered(requestId: number, userId: number): Promise<BlueprintRequest> {
    const existing = await loadRequest(requestId);
    assertIsCrafter(existing, userId, 'markBlueprintRequestDelivered');   // ownership BEFORE status — oracle
    if (existing.status !== 'ready') throw new Error('Only a request marked ready can be marked delivered.');
    return transitionRequest(existing.id, 'ready', {
        status: 'delivered',
        delivered_at: new Date().toISOString(),
    }, { column: 'crafter_id', userId });
}

/**
 * delivered → completed. REQUESTER ONLY, deliberately with no blueprint:manage
 * bypass: "the customer confirms receipt" is the point of the two-sided close, and
 * an admin force-completing on their behalf would forge that confirmation. A stuck
 * request is resolved by cancelling it, which is audited as a cancel.
 */
export async function confirmBlueprintRequestReceived(requestId: number, userId: number): Promise<BlueprintRequest> {
    const existing = await loadRequest(requestId);
    // Ownership BEFORE status, deliberately. The other order turns this action into
    // an oracle: a non-participant could distinguish "wrong state" from "not yours"
    // and walk the id space to map every request's status, which is precisely what
    // pinning a non-crafter to their own rows in listBlueprintRequests prevents.
    if (existing.requester_id !== userId) {
        throw new SecurityDenial('Only the member who raised this request can confirm they received it.', {
            auditEvent: 'authz.resource.denied',
            fields: { requestId: existing.id, userId },
        });
    }
    if (existing.status !== 'delivered') throw new Error('Only a delivered request can be confirmed as received.');
    return transitionRequest(existing.id, 'delivered', {
        status: 'completed',
        completed_at: new Date().toISOString(),
    }, { column: 'requester_id', userId });
}

/**
 * any pre-completed → cancelled. Requester or blueprint:manage. A crafter who
 * cannot finish RELEASES the request instead of cancelling someone else's ask.
 */
export async function cancelBlueprintRequest(requestId: number, userId: number, canManage: boolean, reason?: unknown): Promise<BlueprintRequest> {
    const existing = await loadRequest(requestId);
    // Ownership before status — see confirmBlueprintRequestReceived.
    if (existing.requester_id !== userId && !canManage) {
        throw new SecurityDenial('Only the requester can cancel this crafting request.', {
            auditEvent: 'authz.resource.denied',
            fields: { requestId: existing.id, userId },
        });
    }
    if (existing.status === 'completed' || existing.status === 'cancelled') {
        throw new Error('That crafting request is already closed.');
    }
    return transitionRequest(existing.id, existing.status, {
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancel_reason: optionalText(reason, 'Cancellation reason', MAX_NOTES_LEN),
    }, canManage ? undefined : { column: 'requester_id', userId });
}

function assertIsCrafter(row: { id: number; crafter_id: number | null }, userId: number, fnName: string): void {
    if (row.crafter_id !== userId) {
        throw new SecurityDenial('Only the crafter who claimed this request can update it.', {
            auditEvent: 'authz.resource.denied',
            fields: { requestId: row.id, userId, fnName },
        });
    }
}

/** Hard ceiling on one request's notification fan-out — see MAX_OPEN_REQUESTS_PER_REQUESTER. */
const MAX_NOTIFY_FANOUT = 50;

/**
 * User ids who can actually take a crafting request — holders of `blueprint:craft`
 * — minus the requester, who cannot claim their own.
 *
 * Single-org, so there is no roles-by-org hop: every role is this org's. Mirrors
 * the academy `usersWithPermission` shape; kept local because each differs in cap
 * and exclusions. Every hop is capped AND ends on a primary-key tiebreak, so a
 * truncated fan-out is at least the SAME truncated fan-out every time.
 */
export async function getCraftNotifyIds(excludeUserId?: number): Promise<number[]> {
    const { data: perms } = await supabase.from('permissions')
        .select('id').eq('name', 'blueprint:craft')
        .order('id', { ascending: true }).limit(50);
    const permIds = ((perms || []) as { id: number }[]).map(p => p.id);
    if (permIds.length === 0) return [];

    const { data: rp } = await supabase.from('role_permissions')
        .select('role_id').in('permission_id', permIds)
        .order('role_id', { ascending: true }).limit(2000);
    const grantRoleIds = [...new Set(((rp || []) as { role_id: number }[]).map(r => r.role_id))];
    if (grantRoleIds.length === 0) return [];

    const { data: users } = await supabase.from('users')
        .select('id').in('role_id', grantRoleIds)
        .is('deleted_at', null)
        .order('id', { ascending: true }).limit(MAX_NOTIFY_FANOUT);
    return ((users || []) as { id: number }[]).map(u => u.id).filter(id => id !== excludeUserId);
}
