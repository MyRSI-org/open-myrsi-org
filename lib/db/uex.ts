// =============================================================================
// uexcorp.space API client — single source of truth for all UEX HTTP.
// =============================================================================
//
// All requests are server-side only (called from the admin catalog actions in
// api/actions/catalog.ts). The Bearer token from `process.env.UEX_API_KEY` never
// leaves the server.
//
// Quota (per UEX docs as of 2026-05): 172,800 requests/day, 120 req/min.
// Default delay of 600ms between requests keeps us comfortably under the
// per-minute cap (~100 req/min) without serializing too aggressively.
//
// Failure model: per-category items fetches are tolerated individually so
// one bad category never aborts a full-catalog sync.
// =============================================================================

import { log as baseLog } from '../log.js';
import { stripHtmlSingleLine } from '../textSanitize.js';

// Third-party UEX/wiki catalog strings are stored verbatim and rendered across
// the app, so strip markup + length-cap the DISPLAY free-text on ingest — a
// compromised/typo'd upstream record can't plant markup. Identifier/slug/
// code-shape fields are left exact (slugify constrains slugs; codes are matched,
// not rendered as markup).
const cat = (v: unknown, n = 200): string | null => stripHtmlSingleLine(v, n) || null;

const log = baseLog.child({ module: 'db.uex' });

// The API base. Overridable because a self-hosted deployment can be blocked from the
// default host by Cloudflare — the operator report that prompted this got a 403 with a
// "Just a moment…" interstitial on api.uexcorp.space while the SAME bearer token from
// the SAME host succeeded against api.uexcorp.uk. Both hosts are Cloudflare-fronted and
// serve identical payloads, so this is a per-zone WAF/reputation decision about the
// caller's egress IP, not something a header or a hostname can be relied on to dodge.
// The fix that works regardless of cause is letting the operator repoint the base —
// at the alternate host, or at their own outbound proxy — WITHOUT editing source and
// rebuilding, which is what they had to do.
//
// Default stays api.uexcorp.space: it is the documented host, every working install is
// already on it, and .uk is a different zone whose settings merely happen to be laxer
// today. Flipping the default would migrate every deployment onto an undocumented host
// to fix a minority of them.
//
// ON RULE 6 (lib/ssrf.ts): this stays a bare fetch, and that is deliberate — do not
// "harden" it to ssrfSafeFetch. Rule 6 governs REMOTELY-WRITABLE URLs (alliance_peers
// rows, intel_feeds rows, a pre-auth RSI handle); this one comes from the process
// environment, and whoever sets it already holds SUPABASE_SERVICE_ROLE_KEY and
// SECRETS_ENCRYPTION_KEY, so there is no privilege boundary to cross. lib/secrets.ts
// makes the same call for credentials (env beats the encrypted DB value). Routing
// through ssrfSafeFetch would also break the legitimate reason to set this — an
// operator's own proxy on a private address — for no boundary gained. The validation
// below is typo hygiene, not a security control.
const DEFAULT_UEX_BASE = 'https://api.uexcorp.space/2.0';

/** Resolved per call (not a module const) so tests and a restart-free env change
 *  both take effect, mirroring getDelayMs() below. */
function getUexBase(): string {
    const raw = process.env.UEX_API_BASE;
    if (!raw || !raw.trim()) return DEFAULT_UEX_BASE;
    const trimmed = raw.trim();
    try {
        const u = new URL(trimmed);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
        // Trailing slash would double up against the leading slash on every path.
        return trimmed.replace(/\/+$/, '');
    } catch {
        log.warn('UEX_API_BASE is not a valid http(s) URL — falling back to the default host', { fallback: DEFAULT_UEX_BASE });
        return DEFAULT_UEX_BASE;
    }
}

// Identify ourselves rather than shipping undici's default. Hygiene, NOT the fix for
// the 403 above — a UA is one term in a bot score, and the operator's A/B held it
// constant while changing only the hostname.
const UEX_USER_AGENT = 'myRSI/1.0 (+https://github.com/MyRSI-org/open-myrsi-org)';

// No timeout at all previously, against undici's 300s default: fetchAllUexItems makes
// ~67 sequential calls, so a stalled upstream could hang an admin's sync for hours.
export const UEX_TIMEOUT_MS = 30_000;

const DEFAULT_DELAY_MS = 600;
function getDelayMs(): number {
    const raw = process.env.UEX_REQUEST_DELAY_MS;
    if (!raw) return DEFAULT_DELAY_MS;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DELAY_MS;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let lastRequestAt = 0;
async function throttle(): Promise<void> {
    const delay = getDelayMs();
    if (delay <= 0) return;
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < delay) await sleep(delay - elapsed);
    lastRequestAt = Date.now();
}

/**
 * Strip anything credential-shaped out of an upstream response snippet before it is
 * logged. NOT redundant with lib/log.ts: that redacts by FIELD KEY (`bodyPreview` isn't
 * one) and value-scans only Error message/stack and stringified objects — a plain
 * string field is emitted verbatim. Per CLAUDE.md rule 5 the logger is a backstop, not
 * the defence. Worth doing because the whole point of UEX_API_BASE is letting an
 * operator repoint at their own proxy, and a proxy's debug/error page echoing the
 * request headers back is exactly how our own Bearer would land in the snippet.
 */
function redactUpstreamPreview(text: string): string {
    return text
        .replace(/bearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(/(authorization|x-api-key|api[-_]?key)(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]');
}

/** Why a UEX request failed, in the terms an operator can act on. */
export type UexFailureKind = 'challenge' | 'credential' | 'rate-limit' | 'upstream';

/**
 * Classify a failed (or non-JSON) UEX response WITHOUT retaining any of its bytes.
 * Exported for the pinning test — the three shapes are genuinely different actions:
 * a CDN challenge is fixed with UEX_API_BASE, a credential rejection with
 * UEX_API_KEY, and a 429 with UEX_REQUEST_DELAY_MS.
 */
export function classifyUexFailure(status: number, contentType: string, body: string): UexFailureKind {
    if (status === 429) return 'rate-limit';
    const ct = contentType.toLowerCase();
    const head = body.slice(0, 200).toLowerCase().trimStart();
    // An interstitial arrives as HTML where the API contract promises JSON. Checked
    // before the status codes because a challenge is normally served as 403.
    if (ct.includes('html') || head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('just a moment')) {
        return 'challenge';
    }
    if (status === 401 || status === 403) return 'credential';
    return 'upstream';
}

/**
 * Build the operator-facing failure message from classified fields ONLY. Nothing here
 * derives from the response body — see the call sites for why that matters.
 */
export function uexFailureMessage(path: string, status: number, kind: UexFailureKind): string {
    switch (kind) {
        case 'challenge':
            return `UEX API ${path} was blocked by an anti-bot challenge (HTTP ${status}, HTML instead of JSON). `
                + `That is the upstream CDN refusing this server's IP, not a bad API key — curl from this same host can succeed while the app does not. `
                + `Point UEX_API_BASE at an alternate host (https://api.uexcorp.uk/2.0) or at your own outbound proxy and retry. Server log has the cf-ray.`;
        case 'credential':
            return `UEX API ${path} rejected the credentials (HTTP ${status}). Check that UEX_API_KEY is a current Bearer token from https://uexcorp.space/api.`;
        case 'rate-limit':
            return `UEX API ${path} rate-limited this server (HTTP ${status}). Raise UEX_REQUEST_DELAY_MS and retry.`;
        default:
            return `UEX API ${path} returned HTTP ${status}. See the server log for the response details.`;
    }
}

/**
 * Authenticated GET against the UEX API. Returns the parsed `data` field of
 * the response. Throws on missing API key, network error, non-2xx status, or
 * `status !== 'ok'` in the body.
 */
async function uexFetch<T = unknown>(path: string): Promise<T> {
    const key = process.env.UEX_API_KEY;
    if (!key) {
        throw new Error('UEX_API_KEY environment variable is not set. Register an app at https://uexcorp.space/api and set the Bearer token.');
    }
    await throttle();
    const base = getUexBase();
    const url = `${base}${path}`;
    const res = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Accept': 'application/json',
            'User-Agent': UEX_USER_AGENT,
        },
        signal: AbortSignal.timeout(UEX_TIMEOUT_MS),
    });
    const contentType = res.headers.get('content-type') || '';

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const kind = classifyUexFailure(res.status, contentType, body);
        // Full detail goes to the SERVER log only, with the snippet scrubbed at the
        // source (see redactUpstreamPreview — lib/log.ts does not value-scan plain
        // string fields, so it cannot be relied on here).
        log.warn('uex request failed', {
            path, status: res.status, kind, contentType,
            cfRay: res.headers.get('cf-ray'), bytes: body.length,
            bodyPreview: redactUpstreamPreview(body.slice(0, 200)),
        });
        // The thrown message is CONSTRUCTED from classified fields and never derived
        // from the response body. It reaches the browser twice — the dispatcher
        // returns error.message on the throw path, and fetchAllUexItems below pushes
        // it into `errors[]`, which rides a 200 OK all the way to the admin catalog
        // tab — so third-party bytes must not get into it. A Cloudflare interstitial
        // used to arrive as 300 characters of raw HTML in an admin toast.
        throw new Error(uexFailureMessage(path, res.status, kind));
    }

    // A challenge/error page can also arrive with a 200. Guard before res.json(),
    // whose SyntaxError has no code/errno and so is not opaque to lib/errors.ts —
    // the raw parser message would cross the wire to the admin.
    if (!contentType.includes('json')) {
        const body = await res.text().catch(() => '');
        const kind = classifyUexFailure(res.status, contentType, body);
        log.warn('uex returned a non-JSON 2xx', {
            path, status: res.status, kind, contentType,
            cfRay: res.headers.get('cf-ray'), bytes: body.length,
            bodyPreview: redactUpstreamPreview(body.slice(0, 200)),
        });
        throw new Error(uexFailureMessage(path, res.status, kind));
    }

    const json = await res.json() as { status?: string; data?: T; message?: string };
    if (json.status && json.status !== 'ok') {
        throw new Error(`UEX API ${path} status=${json.status}: ${json.message || ''}`);
    }
    return (json.data ?? []) as T;
}

// ---------------------------------------------------------------------------
// Public types — narrow shapes, only the fields we actually consume.
// ---------------------------------------------------------------------------

export interface UexCategory {
    id: number;
    name: string;
    type: string;       // 'item' | 'service' | 'contract' | ...
    section?: string | null;
    is_mining?: number;
}

export interface UexItem {
    id: number;
    id_parent?: number | null;
    id_category?: number | null;
    id_company?: number | null;
    id_vehicle?: number | null;
    name: string;
    section?: string | null;
    category?: string | null;
    company_name?: string | null;
    vehicle_name?: string | null;
    slug: string;
    size?: string | null;
    uuid?: string | null;
    color?: string | null;
    color2?: string | null;
    url_store?: string | null;
    quality?: number | null;
    is_exclusive_pledge?: number;
    is_exclusive_subscriber?: number;
    is_exclusive_concierge?: number;
    is_commodity?: number;
    is_harvestable?: number;
    screenshot?: string | null;
    game_version?: string | null;
    date_added?: number;
    date_modified?: number;
}

export interface UexCommodity {
    id: number;
    id_parent?: number | null;
    name: string;
    code?: string | null;
    slug: string;
    kind?: string | null;
    weight_scu?: number | null;
    price_buy?: number | null;
    price_sell?: number | null;
    is_available?: number;
    is_available_live?: number;
    is_visible?: number;
    is_extractable?: number;
    is_mineral?: number;
    is_raw?: number;
    is_pure?: number;
    is_refined?: number;
    is_refinable?: number;
    is_harvestable?: number;
    is_buyable?: number;
    is_sellable?: number;
    is_temporary?: number;
    is_illegal?: number;
    is_volatile_qt?: number;
    is_volatile_time?: number;
    is_inert?: number;
    is_explosive?: number;
    is_buggy?: number;
    is_fuel?: number;
    wiki?: string | null;
    date_added?: number;
    date_modified?: number;
}

// ---------------------------------------------------------------------------
// Categories — module-level cache (1hr TTL). Items sync calls this once and
// loops the result; cache keeps repeat syncs in the same hour cheap.
// ---------------------------------------------------------------------------

const CATEGORY_CACHE_TTL_MS = 60 * 60 * 1000;
// Keyed on the resolved base as well as time: an operator who repoints UEX_API_BASE
// mid-hour (the whole point of the knob) would otherwise keep being served categories
// fetched from the host they just moved off.
let categoryCache: { fetchedAt: number; base: string; data: UexCategory[] } | null = null;

export async function fetchUexCategories(force = false): Promise<UexCategory[]> {
    const base = getUexBase();
    if (!force && categoryCache && categoryCache.base === base && Date.now() - categoryCache.fetchedAt < CATEGORY_CACHE_TTL_MS) {
        return categoryCache.data;
    }
    const data = await uexFetch<UexCategory[]>('/categories');
    categoryCache = { fetchedAt: Date.now(), base, data };
    return data;
}

export async function fetchUexItemsForCategory(categoryId: number): Promise<UexItem[]> {
    return await uexFetch<UexItem[]>(`/items?id_category=${categoryId}`);
}

export async function fetchUexCommodities(): Promise<UexCommodity[]> {
    return await uexFetch<UexCommodity[]>('/commodities');
}

// ---------------------------------------------------------------------------
// Location endpoints — used by the platform location catalog sync.
// All single-call (no required query params; returns full list per kind).
// Daily UEX cache TTL is 1 day per endpoint.
// ---------------------------------------------------------------------------

export interface UexStarSystem {
    id: number;
    id_faction?: number | null;
    id_jurisdiction?: number | null;
    name: string;
    code?: string | null;
    is_available?: number;
    is_available_live?: number;
    is_visible?: number;
    is_default?: number;
    wiki?: string | null;
    date_added?: number;
    date_modified?: number;
    faction_name?: string | null;
    jurisdiction_name?: string | null;
}

export interface UexOrbit {
    id: number;
    id_star_system: number;
    id_faction?: number | null;
    id_jurisdiction?: number | null;
    name: string;
    name_origin?: string | null;
    code?: string | null;
    is_available?: number;
    is_available_live?: number;
    is_visible?: number;
    is_default?: number;
    is_lagrange?: number;
    is_man_made?: number;
    is_asteroid?: number;
    is_planet?: number;
    is_star?: number;
    is_jump_point?: number;
    date_added?: number;
    date_modified?: number;
    star_system_name?: string | null;
    faction_name?: string | null;
    jurisdiction_name?: string | null;
}

export interface UexPlanet {
    id: number;
    id_star_system: number;
    id_faction?: number | null;
    id_jurisdiction?: number | null;
    name: string;
    name_origin?: string | null;
    code?: string | null;
    is_available?: number;
    is_available_live?: number;
    is_visible?: number;
    is_default?: number;
    is_lagrange?: number;
    date_added?: number;
    date_modified?: number;
    star_system_name?: string | null;
    faction_name?: string | null;
    jurisdiction_name?: string | null;
}

export interface UexMoon {
    id: number;
    id_star_system: number;
    id_planet?: number | null;
    id_orbit?: number | null;
    id_faction?: number | null;
    id_jurisdiction?: number | null;
    name: string;
    name_origin?: string | null;
    code?: string | null;
    is_available?: number;
    is_available_live?: number;
    is_visible?: number;
    is_default?: number;
    date_added?: number;
    date_modified?: number;
    star_system_name?: string | null;
    planet_name?: string | null;
    orbit_name?: string | null;
    faction_name?: string | null;
    jurisdiction_name?: string | null;
}

// Shared shape for places that sit "in" the universe (stations, cities,
// outposts, POIs). All carry the same parent FK columns + amenities flags.
export interface UexPlaceCommon {
    id: number;
    id_star_system: number;
    id_planet?: number | null;
    id_orbit?: number | null;
    id_moon?: number | null;
    id_faction?: number | null;
    id_jurisdiction?: number | null;
    name: string;
    nickname?: string | null;
    is_available?: number;
    is_available_live?: number;
    is_visible?: number;
    is_default?: number;
    is_monitored?: number;
    is_armistice?: number;
    is_landable?: number;
    is_decommissioned?: number;
    has_quantum_marker?: number;
    has_trade_terminal?: number;
    has_habitation?: number;
    has_refinery?: number;
    has_cargo_center?: number;
    has_clinic?: number;
    has_food?: number;
    has_shops?: number;
    has_refuel?: number;
    has_repair?: number;
    has_gravity?: number;
    has_loading_dock?: number;
    has_docking_port?: number;
    has_freight_elevator?: number;
    pad_types?: string | null;
    date_added?: number;
    date_modified?: number;
    star_system_name?: string | null;
    planet_name?: string | null;
    orbit_name?: string | null;
    moon_name?: string | null;
    faction_name?: string | null;
    jurisdiction_name?: string | null;
}

export interface UexSpaceStation extends UexPlaceCommon {
    id_city?: number | null;
    is_lagrange?: number;
    is_jump_point?: number;
    city_name?: string | null;
    code?: string | null;
}

export interface UexCity extends UexPlaceCommon {
    code?: string | null;
    wiki?: string | null;
}

export interface UexOutpost extends UexPlaceCommon {
    // Outposts use the common shape verbatim — no extra fields.
}

export interface UexPoi extends UexPlaceCommon {
    id_space_station?: number | null;
    id_city?: number | null;
    id_outpost?: number | null;
    space_station_name?: string | null;
    city_name?: string | null;
    outpost_name?: string | null;
}

export async function fetchUexStarSystems(): Promise<UexStarSystem[]> {
    return await uexFetch<UexStarSystem[]>('/star_systems');
}

export async function fetchUexOrbits(): Promise<UexOrbit[]> {
    return await uexFetch<UexOrbit[]>('/orbits');
}

export async function fetchUexPlanets(): Promise<UexPlanet[]> {
    return await uexFetch<UexPlanet[]>('/planets');
}

export async function fetchUexMoons(): Promise<UexMoon[]> {
    return await uexFetch<UexMoon[]>('/moons');
}

export async function fetchUexSpaceStations(): Promise<UexSpaceStation[]> {
    return await uexFetch<UexSpaceStation[]>('/space_stations');
}

export async function fetchUexCities(): Promise<UexCity[]> {
    return await uexFetch<UexCity[]>('/cities');
}

export async function fetchUexOutposts(): Promise<UexOutpost[]> {
    return await uexFetch<UexOutpost[]>('/outposts');
}

export async function fetchUexPois(): Promise<UexPoi[]> {
    return await uexFetch<UexPoi[]>('/poi');
}

/**
 * Fetches every item across every UEX item-category. Per-category errors are
 * captured in the `errors` array rather than thrown — one bad category should
 * never abort an otherwise-successful sync.
 */
export async function fetchAllUexItems(): Promise<{
    categories: UexCategory[];
    items: UexItem[];
    errors: Array<{ categoryId: number; categoryName: string; message: string }>;
}> {
    const allCategories = await fetchUexCategories();
    const itemCategories = allCategories.filter(c => c.type === 'item');

    const items: UexItem[] = [];
    const errors: Array<{ categoryId: number; categoryName: string; message: string }> = [];
    // Bound total ingest — UEX is a trusted fixed host, but an upstream bug /
    // spoofed response shouldn't drive an unbounded insert loop.
    const MAX_UEX_ITEMS = 50_000;

    for (const cat of itemCategories) {
        if (items.length >= MAX_UEX_ITEMS) {
            log.warn('uex item ceiling reached — truncating', { cap: MAX_UEX_ITEMS, fetched: items.length });
            break;
        }
        try {
            const batch = await fetchUexItemsForCategory(cat.id);
            items.push(...batch);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push({ categoryId: cat.id, categoryName: cat.name, message: msg });
            log.warn('item category fetch failed', { categoryId: cat.id, categoryName: cat.name, message: msg });
        }
    }

    log.info('fetched all uex items', { itemCount: items.length, categoryCount: itemCategories.length, errorCount: errors.length });
    return { categories: itemCategories, items, errors };
}

// ---------------------------------------------------------------------------
// Mappers — UEX shape → DB row shape.
// ---------------------------------------------------------------------------

/**
 * The legacy `category` column on quartermaster_catalog has a CHECK constraint:
 * IN ('weapon', 'armor', 'component', 'consumable', 'misc'). UEX has many
 * more categories, so we collapse them via section/category text. The new
 * platform_category_id FK is the real classification — this is purely to
 * satisfy the legacy CHECK so existing tenant queries keep working.
 */
export function uexSectionToQmLegacy(section: string | null | undefined, category: string | null | undefined): 'weapon' | 'armor' | 'component' | 'consumable' | 'misc' {
    const s = (section || '').toLowerCase();
    const c = (category || '').toLowerCase();
    const all = `${s} ${c}`;
    if (/(weapon|gun|rifle|pistol|missile|cannon|launcher|grenade|knife|sword)/.test(all)) return 'weapon';
    if (/(armor|armour|helmet|undersuit|gloves|backpack|chest|legs|core)/.test(all)) return 'armor';
    if (/(component|module|cooler|shield|quantum|power plant|thruster|qed|coupler|generator|reactor|engine|qdrive|propulsion|paint)/.test(all)) return 'component';
    if (/(food|drink|medical|consumable|stim|medpen)/.test(all)) return 'consumable';
    return 'misc';
}

export function slugify(input: string, maxLen = 80): string {
    return (input || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, maxLen) || 'unknown';
}

/**
 * Build a quartermaster_catalog row from a UEX item. The caller passes a
 * `categoryFkLookup` map of `uex_category_id -> platform_category_row.id`
 * built during the sync.
 */
export function mapUexItemToQmRow(
    item: UexItem,
    categoryFkLookup: Map<number, number>
): Record<string, unknown> | null {
    if (!item.uuid) return null; // skip items without a stable uuid
    const platformCategoryId = item.id_category ? categoryFkLookup.get(item.id_category) ?? null : null;
    return {
        slug: item.slug || slugify(item.name),
        name: cat(item.name) || 'Unknown',
        category: uexSectionToQmLegacy(item.section, item.category),
        subcategory: cat(item.category || item.section),
        attributes: {},
        source: 'platform',
        thumbnail_url: item.screenshot || null,
        wiki_url: null,
        external_uuid: item.uuid,
        external_id: item.id || null,
        is_vehicle_item: !!(item.id_vehicle || item.vehicle_name),
        is_commodity: !!item.is_commodity,
        is_harvestable: !!item.is_harvestable,
        screenshot_url: item.screenshot || null,
        store_url: item.url_store || null,
        company_name: cat(item.company_name),
        vehicle_name: cat(item.vehicle_name),
        quality: typeof item.quality === 'number' ? item.quality : null,
        size_label: item.size || null,
        color: item.color || null,
        color2: item.color2 || null,
        game_version: item.game_version || null,
        platform_category_id: platformCategoryId,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
}

/**
 * Build a warehouse_platform_commodities row from a UEX commodity. Caller
 * passes a `categoryFkLookup` map of `uex_kind_slug -> platform_category_row.id`.
 */
export function mapUexCommodityToWarehouseRow(
    commodity: UexCommodity,
    categoryFkLookup: Map<string, number>
): Record<string, unknown> {
    const kindSlug = commodity.kind ? slugify(commodity.kind) : '';
    const platformCategoryId = kindSlug ? categoryFkLookup.get(kindSlug) ?? null : null;
    const num = (v: number | null | undefined) => (typeof v === 'number' ? v : null);
    const bool = (v: number | undefined) => (typeof v === 'number' ? v === 1 : null);
    return {
        external_id: commodity.id,
        external_uuid: null,
        slug: commodity.slug || slugify(commodity.name),
        name: cat(commodity.name) || 'Unknown',
        code: cat(commodity.code, 60),
        kind: cat(commodity.kind, 80),
        weight_scu: num(commodity.weight_scu),
        price_buy: num(commodity.price_buy),
        price_sell: num(commodity.price_sell),
        is_available: bool(commodity.is_available),
        is_available_live: bool(commodity.is_available_live),
        is_visible: bool(commodity.is_visible),
        is_extractable: bool(commodity.is_extractable),
        is_mineral: bool(commodity.is_mineral),
        is_raw: bool(commodity.is_raw),
        is_pure: bool(commodity.is_pure),
        is_refined: bool(commodity.is_refined),
        is_refinable: bool(commodity.is_refinable),
        is_harvestable: bool(commodity.is_harvestable),
        is_buyable: bool(commodity.is_buyable),
        is_sellable: bool(commodity.is_sellable),
        is_temporary: bool(commodity.is_temporary),
        is_illegal: bool(commodity.is_illegal),
        is_volatile_qt: bool(commodity.is_volatile_qt),
        is_volatile_time: bool(commodity.is_volatile_time),
        is_inert: bool(commodity.is_inert),
        is_explosive: bool(commodity.is_explosive),
        is_buggy: bool(commodity.is_buggy),
        is_fuel: bool(commodity.is_fuel),
        wiki_url: commodity.wiki || null,
        platform_category_id: platformCategoryId,
        uex_date_added: typeof commodity.date_added === 'number' ? commodity.date_added : null,
        uex_date_modified: typeof commodity.date_modified === 'number' ? commodity.date_modified : null,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
}
