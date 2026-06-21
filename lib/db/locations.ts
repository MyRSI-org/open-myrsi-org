// =============================================================================
// Platform Location Catalog (UEX-sourced) — sync + CRUD
// =============================================================================
// Single unified table `platform_locations` with a `kind` discriminator.
// Hierarchy via parent_id (most-specific direct parent) + denormalised
// star_system_id (always-known root) + denormalised path string.
//
// Sync is multi-pass to honour parent dependencies:
//   1. star_systems  (no parent)
//   2. orbits        (parent: system) — flagged is_internal=true
//   3. planets       (parent: system)
//   4. moons         (parent: planet > orbit; star_system fallback)
//   5. space_stations (parent: city > moon > planet > orbit > system)
//   6. cities        (parent: moon > planet > orbit > system)
//   7. outposts      (parent: moon > planet > orbit > system)
//   8. poi           (parent: outpost > city > station > moon > planet > orbit > system)
//   9. path resolution — climb each row's parent chain and write a denorm path
//
// Admin-edited fields (`nickname`, `is_hidden`, `is_internal`, `wiki_url`) are
// preserved across re-syncs by reading existing rows first and excluding
// those columns from the upsert payload when a row already exists.
// =============================================================================

import { supabase, handleSupabaseError } from './common.js';
import { toPlatformLocation } from './mappers.js';
import { safeSearchTerm, clampListOffset } from '../pgrest.js';
import { stripHtmlSingleLine } from '../textSanitize.js';
import {
    fetchUexStarSystems, fetchUexOrbits, fetchUexPlanets, fetchUexMoons,
    fetchUexSpaceStations, fetchUexCities, fetchUexOutposts, fetchUexPois,
    type UexStarSystem, type UexOrbit, type UexPlanet, type UexMoon,
    type UexSpaceStation, type UexCity, type UexOutpost, type UexPoi,
    type UexPlaceCommon,
} from './uex.js';
import type { PlatformLocation, PlatformLocationKind } from '../../types.js';
import type { Tables } from './rows.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'db.locations' });

const BATCH_SIZE = 100;
const PAGE_SIZE = 1000;

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export interface ListLocationsOptions {
    kind?: PlatformLocationKind | null;
    starSystemId?: number | null;
    includeInternal?: boolean;
    includeHidden?: boolean;
    includeDecommissioned?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
}

/**
 * Paginated listing for the admin tab. Defaults exclude internal scaffolding
 * (orbits) and admin-hidden rows so the UI is clean by default; flip the
 * include* flags to surface them.
 */
export async function getPlatformLocations(opts: ListLocationsOptions = {}): Promise<PlatformLocation[]> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
    const offset = clampListOffset(opts.offset);

    let qb = supabase.from('platform_locations').select('*');
    if (opts.kind) qb = qb.eq('kind', opts.kind);
    if (opts.starSystemId) qb = qb.eq('star_system_id', opts.starSystemId);
    if (!opts.includeInternal) qb = qb.eq('is_internal', false);
    if (!opts.includeHidden) qb = qb.eq('is_hidden', false);
    if (!opts.includeDecommissioned) qb = qb.or('is_decommissioned.is.null,is_decommissioned.eq.false');
    if (opts.search && opts.search.trim()) {
        // Allow-list the term before it enters the .or() grammar.
        const safe = safeSearchTerm(opts.search);
        if (safe) qb = qb.or(`name.ilike.%${safe}%,path.ilike.%${safe}%,nickname.ilike.%${safe}%`);
    }
    qb = qb.order('kind').order('name').range(offset, offset + limit - 1);

    const { data, error } = await qb;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to load platform locations' });
    return (data || []).map(toPlatformLocation);
}

export async function getPlatformLocationCount(): Promise<{ total: number; perKind: Record<string, number> }> {
    // Use head+count to avoid pulling row payloads — one round-trip per kind
    // returns just an integer in the response header. All 9 queries fire in
    // parallel so total wall time is one round-trip, total egress is ~0 rows.
    const kinds: PlatformLocationKind[] = [
        'star_system', 'orbit', 'planet', 'moon', 'space_station', 'city', 'outpost', 'poi',
    ];
    const results = await Promise.all(kinds.map(async (kind) => {
        const { count, error } = await supabase.from('platform_locations')
            .select('*', { count: 'exact', head: true })
            .eq('kind', kind);
        if (error && error.code === '42P01') return [kind, 0] as const;
        if (error) return [kind, 0] as const;
        return [kind, count ?? 0] as const;
    }));
    const perKind: Record<string, number> = {};
    let total = 0;
    for (const [kind, n] of results) {
        perKind[kind] = n;
        total += n;
    }
    return { total, perKind };
}

/**
 * Tenant-facing search. Always excludes internal scaffolding and admin-hidden
 * rows. Returns top N results ordered by best match heuristic (exact name >
 * starts-with > contains, kind priority for ties).
 */
export async function searchPlatformLocations(
    { query, kind, starSystemId, limit = 50 }:
    { query: string; kind?: PlatformLocationKind; starSystemId?: number; limit?: number },
): Promise<PlatformLocation[]> {
    const q = (query || '').trim();
    if (!q) return [];
    // Allow-list before interpolating into the .or() grammar.
    const safe = safeSearchTerm(query);
    if (!safe) return [];
    const cap = Math.min(Math.max(limit, 1), 200);

    let qb = supabase.from('platform_locations').select('*')
        .eq('is_internal', false)
        .eq('is_hidden', false)
        .or(`name.ilike.%${safe}%,path.ilike.%${safe}%,nickname.ilike.%${safe}%`);
    if (kind) qb = qb.eq('kind', kind);
    if (starSystemId) qb = qb.eq('star_system_id', starSystemId);
    qb = qb.order('name').limit(cap);

    const { data, error } = await qb;
    if (error && error.code === '42P01') return [];
    handleSupabaseError({ error, message: 'Failed to search platform locations' });
    return (data || []).map(toPlatformLocation);
}

// ---------------------------------------------------------------------------
// Admin mutations
// ---------------------------------------------------------------------------

const ADMIN_PROTECTED_FIELDS = new Set([
    'id', 'kind', 'external_id', 'parent_id', 'star_system_id',
    'name', 'code', 'path', 'amenities', 'pad_types',
    'is_available_live', 'is_visible', 'is_landable', 'is_armistice', 'is_decommissioned',
    'faction_name', 'jurisdiction_name', 'last_synced_at', 'created_at',
    'uex_date_added', 'uex_date_modified',
]);

export async function updatePlatformLocation(id: number, patch: Partial<Tables<'platform_locations'>>) {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
        if (ADMIN_PROTECTED_FIELDS.has(k)) continue;
        safe[k] = v;
    }
    if (!Object.keys(safe).length) throw new Error('No updatable fields provided');
    safe.updated_at = new Date().toISOString();
    const { error } = await supabase.from('platform_locations').update(safe).eq('id', id);
    handleSupabaseError({ error, message: 'Failed to update platform location' });
}

export async function deletePlatformLocation(id: number) {
    const { count, error: countErr } = await supabase.from('platform_locations')
        .select('id', { count: 'exact', head: true })
        .eq('parent_id', id);
    handleSupabaseError({ error: countErr, message: 'Failed to check children before delete' });
    if (count && count > 0) {
        throw new Error(`Cannot delete: ${count} child row(s) reference this location. Delete or repoint them first.`);
    }
    const { error } = await supabase.from('platform_locations').delete().eq('id', id);
    handleSupabaseError({ error, message: 'Failed to delete platform location' });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

interface ExistingRow {
    id: number;
    kind: string;
    external_id: number;
    nickname: string | null;
    is_hidden: boolean;
    is_internal: boolean;
    wiki_url: string | null;
}

type Lookup = Map<string, ExistingRow>; // key = `${kind}:${external_id}`

const lookupKey = (kind: PlatformLocationKind, externalId: number) => `${kind}:${externalId}`;

function packAmenities(p: Partial<UexPlaceCommon>): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    const fields: Array<keyof UexPlaceCommon> = [
        'has_quantum_marker', 'has_trade_terminal', 'has_habitation', 'has_refinery',
        'has_cargo_center', 'has_clinic', 'has_food', 'has_shops', 'has_refuel',
        'has_repair', 'has_gravity', 'has_loading_dock', 'has_docking_port', 'has_freight_elevator',
    ];
    for (const f of fields) {
        const v = p[f];
        if (v === 1) out[String(f).replace(/^has_/, '')] = true;
    }
    return out;
}

function bool(v: number | null | undefined): boolean | null {
    if (v === null || v === undefined) return null;
    return v === 1;
}

async function upsertBatch(rows: Array<Partial<Tables<'platform_locations'>>>): Promise<{ inserted: number; errors: number; perRowErrors: string[] }> {
    if (!rows.length) return { inserted: 0, errors: 0, perRowErrors: [] };
    const perRowErrors: string[] = [];
    let inserted = 0;
    let errors = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from('platform_locations')
            .upsert(batch, { onConflict: 'kind,external_id' });
        if (error) {
            // Fall back to per-row so one bad row doesn't block the rest.
            for (const row of batch) {
                const { error: rowErr } = await supabase.from('platform_locations')
                    .upsert(row, { onConflict: 'kind,external_id' });
                if (rowErr) {
                    errors++;
                    if (perRowErrors.length < 5) perRowErrors.push(`${row.kind} "${row.name}": ${rowErr.message}`);
                } else {
                    inserted++;
                }
            }
        } else {
            inserted += batch.length;
        }
    }
    return { inserted, errors, perRowErrors };
}

/**
 * Reload the row IDs for a kind back into the lookup so subsequent passes
 * can resolve parent FKs against the database-assigned ids.
 */
async function refreshLookupForKind(kind: PlatformLocationKind, lookup: Lookup): Promise<void> {
    // Paginate past PostgREST's 1000-row default cap.
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error } = await supabase.from('platform_locations')
            .select('id, kind, external_id, nickname, is_hidden, is_internal, wiki_url')
            .eq('kind', kind)
            .range(offset, offset + PAGE_SIZE - 1);
        handleSupabaseError({ error, message: `Failed to reload ${kind} lookup` });
        const batch = data || [];
        for (const r of batch) {
            lookup.set(lookupKey(r.kind as PlatformLocationKind, r.external_id), r as ExistingRow);
        }
        if (batch.length < PAGE_SIZE) break;
    }
}

interface KindSyncResult {
    fetched: number;
    inserted: number;
    errors: number;
    perRowErrors: string[];
}

/**
 * Build a mapper closure that converts a UEX row into a DB row, resolving
 * parent_id and star_system_id from the lookup.
 */
function makeRow(
    kind: PlatformLocationKind,
    externalId: number,
    name: string,
    parentDbId: number | null,
    starSystemDbId: number | null,
    extras: Partial<{
        nickname: string | null;
        code: string | null;
        is_available_live: boolean | null;
        is_visible: boolean | null;
        is_landable: boolean | null;
        is_armistice: boolean | null;
        is_decommissioned: boolean | null;
        is_internal: boolean;
        pad_types: string | null;
        amenities: Record<string, boolean>;
        faction_name: string | null;
        jurisdiction_name: string | null;
        wiki_url: string | null;
        uex_date_added: number | null;
        uex_date_modified: number | null;
    }>,
    existing?: ExistingRow,
): Partial<Tables<'platform_locations'>> {
    const row: Partial<Tables<'platform_locations'>> = {
        kind,
        external_id: externalId,
        parent_id: parentDbId,
        star_system_id: starSystemDbId,
        name: stripHtmlSingleLine(name, 200) || name,   // strip markup from UEX display name
        code: extras.code ?? null,
        is_available_live: extras.is_available_live ?? null,
        is_visible: extras.is_visible ?? null,
        is_landable: extras.is_landable ?? null,
        is_armistice: extras.is_armistice ?? null,
        is_decommissioned: extras.is_decommissioned ?? null,
        pad_types: extras.pad_types ?? null,
        amenities: extras.amenities ?? {},
        faction_name: stripHtmlSingleLine(extras.faction_name, 120) || null,
        jurisdiction_name: stripHtmlSingleLine(extras.jurisdiction_name, 120) || null,
        uex_date_added: extras.uex_date_added ?? null,
        uex_date_modified: extras.uex_date_modified ?? null,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    // Admin-editable fields: only set on first insert OR when not previously
    // overridden. UEX is the source of truth for the value initially, but
    // once an admin edits we don't want to clobber.
    if (existing) {
        // Preserve existing values for these — they may be admin-edited.
        row.nickname = existing.nickname;
        row.is_hidden = existing.is_hidden;
        row.is_internal = existing.is_internal;
        row.wiki_url = existing.wiki_url;
    } else {
        row.nickname = extras.nickname ?? null;
        row.is_hidden = false;
        row.is_internal = extras.is_internal ?? false;
        row.wiki_url = extras.wiki_url ?? null;
    }
    return row;
}

/** Pick the first non-null FK from a priority list and return its db row id. */
function resolveParent(
    lookup: Lookup,
    priorities: Array<{ kind: PlatformLocationKind; externalId: number | null | undefined }>,
): number | null {
    for (const p of priorities) {
        if (!p.externalId) continue;
        const found = lookup.get(lookupKey(p.kind, p.externalId));
        if (found) return found.id;
    }
    return null;
}

/**
 * Walk the parent chain to compute a "Stanton > Crusader > Yela > GrimHEX"
 * style path for every row. Updates rows in batches.
 */
async function recomputePaths(): Promise<{ updated: number }> {
    // Pull every row's id, name, parent_id into memory (small — ~3-5k rows).
    const all: Array<{ id: number; name: string; parent_id: number | null }> = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error } = await supabase.from('platform_locations')
            .select('id, name, parent_id')
            .range(offset, offset + PAGE_SIZE - 1);
        handleSupabaseError({ error, message: 'Failed to load rows for path computation' });
        const batch = data || [];
        all.push(...batch);
        if (batch.length < PAGE_SIZE) break;
    }
    const byId = new Map<number, { name: string; parent_id: number | null }>();
    for (const r of all) byId.set(r.id, { name: r.name, parent_id: r.parent_id });

    const computePath = (id: number): string => {
        const segments: string[] = [];
        let cur: number | null = id;
        let depth = 0;
        while (cur !== null && depth < 8) {
            const node = byId.get(cur);
            if (!node) break;
            segments.unshift(node.name);
            cur = node.parent_id;
            depth++;
        }
        return segments.join(' > ');
    };

    // Update in batches of 100 — Supabase doesn't have a great bulk-update,
    // so we do per-row patches but parallelise within each batch.
    let updated = 0;
    for (let i = 0; i < all.length; i += BATCH_SIZE) {
        const batch = all.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (r) => {
            const path = computePath(r.id);
            const { error } = await supabase.from('platform_locations')
                .update({ path })
                .eq('id', r.id);
            if (!error) updated++;
        }));
    }
    return { updated };
}

export interface SyncLocationsResult {
    durationMs: number;
    perKind: Record<PlatformLocationKind, KindSyncResult>;
    pathsUpdated: number;
    totalErrors: number;
}

export async function syncPlatformLocations(): Promise<SyncLocationsResult> {
    const start = Date.now();

    // Pre-load the existing lookup so we can preserve admin edits.
    const lookup: Lookup = new Map();
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error } = await supabase.from('platform_locations')
            .select('id, kind, external_id, nickname, is_hidden, is_internal, wiki_url')
            .range(offset, offset + PAGE_SIZE - 1);
        handleSupabaseError({ error, message: 'Failed to pre-load locations lookup' });
        const batch = data || [];
        for (const r of batch) {
            lookup.set(lookupKey(r.kind as PlatformLocationKind, r.external_id), r as ExistingRow);
        }
        if (batch.length < PAGE_SIZE) break;
    }
    log.info('uex sync: pre-loaded existing platform_locations rows', { count: lookup.size });

    const perKind: Record<PlatformLocationKind, KindSyncResult> = {
        star_system: { fetched: 0, inserted: 0, errors: 0, perRowErrors: [] },
        orbit: { fetched: 0, inserted: 0, errors: 0, perRowErrors: [] },
        planet: { fetched: 0, inserted: 0, errors: 0, perRowErrors: [] },
        moon: { fetched: 0, inserted: 0, errors: 0, perRowErrors: [] },
        space_station: { fetched: 0, inserted: 0, errors: 0, perRowErrors: [] },
        city: { fetched: 0, inserted: 0, errors: 0, perRowErrors: [] },
        outpost: { fetched: 0, inserted: 0, errors: 0, perRowErrors: [] },
        poi: { fetched: 0, inserted: 0, errors: 0, perRowErrors: [] },
    };

    // --- Pass 1: star systems (parent: none) ---
    const systems: UexStarSystem[] = await fetchUexStarSystems();
    perKind.star_system.fetched = systems.length;
    {
        const rows = systems.map((s) => {
            const existing = lookup.get(lookupKey('star_system', s.id));
            return makeRow('star_system', s.id, s.name, null, null, {
                code: s.code ?? null,
                is_available_live: bool(s.is_available_live),
                is_visible: bool(s.is_visible),
                wiki_url: s.wiki ?? null,
                faction_name: s.faction_name ?? null,
                jurisdiction_name: s.jurisdiction_name ?? null,
                uex_date_added: s.date_added ?? null,
                uex_date_modified: s.date_modified ?? null,
            }, existing);
        });
        const r = await upsertBatch(rows);
        perKind.star_system.inserted = r.inserted;
        perKind.star_system.errors = r.errors;
        perKind.star_system.perRowErrors = r.perRowErrors;
        await refreshLookupForKind('star_system', lookup);
    }

    // Star_systems need their own star_system_id pointing at themselves so
    // every later "lookup the system db id" call works uniformly.
    {
        const sysRows = Array.from(lookup.values()).filter((r) => r.kind === 'star_system');
        await Promise.all(sysRows.map(async (r) => {
            await supabase.from('platform_locations').update({ star_system_id: r.id }).eq('id', r.id);
        }));
    }

    // --- Pass 2: orbits (parent: system; flag is_internal=true) ---
    const orbits: UexOrbit[] = await fetchUexOrbits();
    perKind.orbit.fetched = orbits.length;
    {
        const rows = orbits.map((o) => {
            const existing = lookup.get(lookupKey('orbit', o.id));
            const sysDb = lookup.get(lookupKey('star_system', o.id_star_system))?.id ?? null;
            return makeRow('orbit', o.id, o.name, sysDb, sysDb, {
                code: o.code ?? null,
                is_available_live: bool(o.is_available_live),
                is_visible: bool(o.is_visible),
                is_internal: true,
                faction_name: o.faction_name ?? null,
                jurisdiction_name: o.jurisdiction_name ?? null,
                uex_date_added: o.date_added ?? null,
                uex_date_modified: o.date_modified ?? null,
            }, existing);
        });
        const r = await upsertBatch(rows);
        perKind.orbit.inserted = r.inserted;
        perKind.orbit.errors = r.errors;
        perKind.orbit.perRowErrors = r.perRowErrors;
        await refreshLookupForKind('orbit', lookup);
    }

    // --- Pass 3: planets (parent: system) ---
    const planets: UexPlanet[] = await fetchUexPlanets();
    perKind.planet.fetched = planets.length;
    {
        const rows = planets.map((p) => {
            const existing = lookup.get(lookupKey('planet', p.id));
            const sysDb = lookup.get(lookupKey('star_system', p.id_star_system))?.id ?? null;
            return makeRow('planet', p.id, p.name, sysDb, sysDb, {
                code: p.code ?? null,
                is_available_live: bool(p.is_available_live),
                is_visible: bool(p.is_visible),
                faction_name: p.faction_name ?? null,
                jurisdiction_name: p.jurisdiction_name ?? null,
                uex_date_added: p.date_added ?? null,
                uex_date_modified: p.date_modified ?? null,
            }, existing);
        });
        const r = await upsertBatch(rows);
        perKind.planet.inserted = r.inserted;
        perKind.planet.errors = r.errors;
        perKind.planet.perRowErrors = r.perRowErrors;
        await refreshLookupForKind('planet', lookup);
    }

    // --- Pass 4: moons (parent: planet > orbit) ---
    const moons: UexMoon[] = await fetchUexMoons();
    perKind.moon.fetched = moons.length;
    {
        const rows = moons.map((m) => {
            const existing = lookup.get(lookupKey('moon', m.id));
            const sysDb = lookup.get(lookupKey('star_system', m.id_star_system))?.id ?? null;
            const parentId = resolveParent(lookup, [
                { kind: 'planet', externalId: m.id_planet },
                { kind: 'orbit', externalId: m.id_orbit },
            ]) ?? sysDb;
            return makeRow('moon', m.id, m.name, parentId, sysDb, {
                code: m.code ?? null,
                is_available_live: bool(m.is_available_live),
                is_visible: bool(m.is_visible),
                faction_name: m.faction_name ?? null,
                jurisdiction_name: m.jurisdiction_name ?? null,
                uex_date_added: m.date_added ?? null,
                uex_date_modified: m.date_modified ?? null,
            }, existing);
        });
        const r = await upsertBatch(rows);
        perKind.moon.inserted = r.inserted;
        perKind.moon.errors = r.errors;
        perKind.moon.perRowErrors = r.perRowErrors;
        await refreshLookupForKind('moon', lookup);
    }

    // --- Pass 5: cities (synced before stations so station→city parents resolve) ---
    // A station can sit "in" a city, so cities must load first for the station
    // parent lookup to find them on the first sync.
    const cities: UexCity[] = await fetchUexCities();
    perKind.city.fetched = cities.length;
    {
        const rows = cities.map((c) => {
            const existing = lookup.get(lookupKey('city', c.id));
            const sysDb = lookup.get(lookupKey('star_system', c.id_star_system))?.id ?? null;
            const parentId = resolveParent(lookup, [
                { kind: 'moon', externalId: c.id_moon },
                { kind: 'planet', externalId: c.id_planet },
                { kind: 'orbit', externalId: c.id_orbit },
            ]) ?? sysDb;
            return makeRow('city', c.id, c.name, parentId, sysDb, {
                nickname: c.nickname ?? null,
                code: c.code ?? null,
                is_available_live: bool(c.is_available_live),
                is_visible: bool(c.is_visible),
                is_landable: bool(c.is_landable),
                is_armistice: bool(c.is_armistice),
                is_decommissioned: bool(c.is_decommissioned),
                pad_types: c.pad_types ?? null,
                amenities: packAmenities(c),
                faction_name: c.faction_name ?? null,
                jurisdiction_name: c.jurisdiction_name ?? null,
                wiki_url: c.wiki ?? null,
                uex_date_added: c.date_added ?? null,
                uex_date_modified: c.date_modified ?? null,
            }, existing);
        });
        const r = await upsertBatch(rows);
        perKind.city.inserted = r.inserted;
        perKind.city.errors = r.errors;
        perKind.city.perRowErrors = r.perRowErrors;
        await refreshLookupForKind('city', lookup);
    }

    // --- Pass 6: space_stations (parent: city > moon > planet > orbit > system) ---
    const stations: UexSpaceStation[] = await fetchUexSpaceStations();
    perKind.space_station.fetched = stations.length;
    {
        const rows = stations.map((s) => {
            const existing = lookup.get(lookupKey('space_station', s.id));
            const sysDb = lookup.get(lookupKey('star_system', s.id_star_system))?.id ?? null;
            const parentId = resolveParent(lookup, [
                { kind: 'city', externalId: s.id_city },
                { kind: 'moon', externalId: s.id_moon },
                { kind: 'planet', externalId: s.id_planet },
                { kind: 'orbit', externalId: s.id_orbit },
            ]) ?? sysDb;
            return makeRow('space_station', s.id, s.name, parentId, sysDb, {
                nickname: s.nickname ?? null,
                code: s.code ?? null,
                is_available_live: bool(s.is_available_live),
                is_visible: bool(s.is_visible),
                is_landable: bool(s.is_landable),
                is_armistice: bool(s.is_armistice),
                is_decommissioned: bool(s.is_decommissioned),
                pad_types: s.pad_types ?? null,
                amenities: packAmenities(s),
                faction_name: s.faction_name ?? null,
                jurisdiction_name: s.jurisdiction_name ?? null,
                uex_date_added: s.date_added ?? null,
                uex_date_modified: s.date_modified ?? null,
            }, existing);
        });
        const r = await upsertBatch(rows);
        perKind.space_station.inserted = r.inserted;
        perKind.space_station.errors = r.errors;
        perKind.space_station.perRowErrors = r.perRowErrors;
        await refreshLookupForKind('space_station', lookup);
    }

    // --- Pass 7: outposts (parent: moon > planet > orbit > system) ---
    const outposts: UexOutpost[] = await fetchUexOutposts();
    perKind.outpost.fetched = outposts.length;
    {
        const rows = outposts.map((o) => {
            const existing = lookup.get(lookupKey('outpost', o.id));
            const sysDb = lookup.get(lookupKey('star_system', o.id_star_system))?.id ?? null;
            const parentId = resolveParent(lookup, [
                { kind: 'moon', externalId: o.id_moon },
                { kind: 'planet', externalId: o.id_planet },
                { kind: 'orbit', externalId: o.id_orbit },
            ]) ?? sysDb;
            return makeRow('outpost', o.id, o.name, parentId, sysDb, {
                nickname: o.nickname ?? null,
                is_available_live: bool(o.is_available_live),
                is_visible: bool(o.is_visible),
                is_landable: bool(o.is_landable),
                is_armistice: bool(o.is_armistice),
                is_decommissioned: bool(o.is_decommissioned),
                pad_types: o.pad_types ?? null,
                amenities: packAmenities(o),
                faction_name: o.faction_name ?? null,
                jurisdiction_name: o.jurisdiction_name ?? null,
                uex_date_added: o.date_added ?? null,
                uex_date_modified: o.date_modified ?? null,
            }, existing);
        });
        const r = await upsertBatch(rows);
        perKind.outpost.inserted = r.inserted;
        perKind.outpost.errors = r.errors;
        perKind.outpost.perRowErrors = r.perRowErrors;
        await refreshLookupForKind('outpost', lookup);
    }

    // --- Pass 8: POIs (parent: outpost > city > station > moon > planet > orbit > system) ---
    const pois: UexPoi[] = await fetchUexPois();
    perKind.poi.fetched = pois.length;
    {
        const rows = pois.map((p) => {
            const existing = lookup.get(lookupKey('poi', p.id));
            const sysDb = lookup.get(lookupKey('star_system', p.id_star_system))?.id ?? null;
            const parentId = resolveParent(lookup, [
                { kind: 'outpost', externalId: p.id_outpost },
                { kind: 'city', externalId: p.id_city },
                { kind: 'space_station', externalId: p.id_space_station },
                { kind: 'moon', externalId: p.id_moon },
                { kind: 'planet', externalId: p.id_planet },
                { kind: 'orbit', externalId: p.id_orbit },
            ]) ?? sysDb;
            return makeRow('poi', p.id, p.name, parentId, sysDb, {
                nickname: p.nickname ?? null,
                is_available_live: bool(p.is_available_live),
                is_visible: bool(p.is_visible),
                is_landable: bool(p.is_landable),
                is_armistice: bool(p.is_armistice),
                is_decommissioned: bool(p.is_decommissioned),
                pad_types: p.pad_types ?? null,
                amenities: packAmenities(p),
                faction_name: p.faction_name ?? null,
                jurisdiction_name: p.jurisdiction_name ?? null,
                uex_date_added: p.date_added ?? null,
                uex_date_modified: p.date_modified ?? null,
            }, existing);
        });
        const r = await upsertBatch(rows);
        perKind.poi.inserted = r.inserted;
        perKind.poi.errors = r.errors;
        perKind.poi.perRowErrors = r.perRowErrors;
    }

    // --- Pass 9: recompute denormalised paths ---
    const { updated: pathsUpdated } = await recomputePaths();

    const totalErrors = Object.values(perKind).reduce((sum, k) => sum + k.errors, 0);
    const durationMs = Date.now() - start;
    log.info('uex sync: locations done', { durationMs, pathsUpdated, totalErrors });

    return { durationMs, perKind, pathsUpdated, totalErrors };
}
