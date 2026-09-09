
import { supabase, handleSupabaseError, safeFetch, broadcastToOrg } from './common.js';
import { toPlatformShip, toUserShip, toFleetGroup } from './mappers.js';
import { stripHtml, stripHtmlSingleLine } from '../textSanitize.js';
import { log as baseLog } from '../log.js';
import type { PlatformShip, UserShip, FleetGroup, ShipStatus, FleetGroupType } from '../../types.js';
import type { Tables } from './rows.js';

/** Shape of a fleet-group create/update payload (mirrors api/actions/fleet.ts). */
interface FleetGroupInput {
    name: string;
    type?: FleetGroupType | string;
    parentId?: number | null;
    commanderId?: number | null;
    description?: string | null;
    icon?: string | null;
    sortOrder?: number;
}

const log = baseLog.child({ module: 'db.fleet' });

// Localized-string field as returned by star-citizen.wiki (accepted by locStr).
type LocStr = string | { en_EN?: string | null; en?: string | null } | null;
// Row shapes consumed by the mappers (which already carry the embed types).
type UserShipRow = Parameters<typeof toUserShip>[0];
type FleetGroupRow = Parameters<typeof toFleetGroup>[0];
// fleet_group_ships junction row with the hydrated user_ship embed.
type AssignmentRow = { id: number; fleet_group_id: number; sort_order?: number | null; user_ship?: UserShipRow | null };

// Subset of the star-citizen.wiki shipmatrix vehicle payload that syncShipCatalog reads.
interface ShipMatrixVehicle {
    id?: number;
    uuid?: string;
    name?: string;
    manufacturer?: { name?: string | null; code?: string | null } | null;
    foci?: LocStr[] | null;
    focus?: { name?: string | null } | null;
    type?: LocStr;
    size?: LocStr;
    crew?: { min?: number | null; max?: number | null } | null;
    cargo_capacity?: number | null;
    sizes?: { length?: number | null; beam?: number | null; height?: number | null } | null;
    length?: number | null;
    beam?: number | null;
    height?: number | null;
    mass?: number | null;
    speed?: { scm?: number | null; max?: number | null } | null;
    pledge_url?: string | null;
    msrp?: number | string | null;
    description?: LocStr;
    production_status?: LocStr;
}

/** Array names of the 3-key fleet bundle, used as broadcast slice
 *  discriminators so clients refetch only the affected array(s) instead of
 *  the whole bundle (the ~static several-hundred-row ship catalog was being
 *  re-egressed on every hangar edit). Hangar mutations must emit BOTH
 *  'user_ships' AND 'groups' — fleetGroups.assignedShips re-embeds user_ship
 *  rows. With NO args clients fall back to the full 'fleet' refetch. */
type FleetSlice = 'catalog' | 'user_ships' | 'groups';

function broadcastFleetUpdate(...slices: FleetSlice[]) {
    broadcastToOrg('fleet_update', slices.length > 0 ? { slices } : {});
}

// --- API Helpers ---

/** Helper to extract localized string from v2 API locale objects */
function locStr(val: string | { en_EN?: string | null; en?: string | null } | null | undefined): string | null {
    if (!val) return null;
    if (typeof val === 'string') return val;
    return val.en_EN || val.en || null;
}

/**
 * Fetch all ships from the Star Citizen Wiki shipmatrix endpoint (paginated).
 * Use shipmatrix instead of /v2/vehicles because the latter silently omits
 * some real ships (Ironclad id 274, Ironclad Assault id 275, and other
 * in-concept ships). shipmatrix is also pre-deduped by ship model — no paint
 * variants to filter.
 */
async function fetchAllVehiclesFromApi(): Promise<ShipMatrixVehicle[]> {
    const allVehicles: ShipMatrixVehicle[] = [];
    let pageNum = 1;
    let hasMore = true;

    while (hasMore) {
        const url = new URL('https://api.star-citizen.wiki/api/shipmatrix/vehicles');
        url.searchParams.set('page[size]', '200');
        url.searchParams.set('page[number]', String(pageNum));
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`star-citizen.wiki shipmatrix error: ${res.status}`);
        const json = await res.json();
        const items = json.data || [];
        allVehicles.push(...items);
        const currentPage = json.meta?.current_page ?? pageNum;
        const lastPage = json.meta?.last_page ?? (items.length > 0 ? pageNum + 1 : pageNum);
        hasMore = items.length > 0 && currentPage < lastPage;
        pageNum++;
    }
    log.info('shipmatrix fetch complete', { count: allVehicles.length, pages: pageNum - 1 });
    return allVehicles;
}

// --- Ship Catalog ---

export async function getShipCatalog(): Promise<PlatformShip[]> {
    const { data, error } = await supabase.from('platform_ships')
        .select('id, external_uuid, external_api_id, name, manufacturer, manufacturer_code, role, career, size, crew_min, crew_max, cargo_capacity, length, beam, height, mass, scm_speed, max_speed, health, shield_hp, image_url, wiki_url, pledge_url, msrp, description, production_status, created_at, updated_at')
        .order('manufacturer', { ascending: true })
        .order('name', { ascending: true });
    handleSupabaseError({ error, message: 'Failed to get ship catalog' });
    return (data || []).map(toPlatformShip);
}

export async function syncShipCatalog() {
    const vehicles = await fetchAllVehiclesFromApi();

    // Fetch images from starcitizen.tools MediaWiki API (batch 50 at a time)
    const imageMap = new Map<string, string>();
    const vehicleNames = vehicles.map(v => v.name).filter((n): n is string => Boolean(n));
    for (let i = 0; i < vehicleNames.length; i += 50) {
        const batch = vehicleNames.slice(i, i + 50);
        const titles = batch.map((n: string) => n.replace(/ /g, '_')).join('|');
        try {
            const imgRes = await fetch(`https://starcitizen.tools/api.php?action=query&titles=${encodeURIComponent(titles)}&prop=pageimages&pithumbsize=400&format=json`);
            if (imgRes.ok) {
                const imgJson = await imgRes.json();
                const pages = imgJson?.query?.pages || {};
                for (const p of Object.values(pages) as Array<{ title: string; thumbnail?: { source?: string } }>) {
                    if (p.thumbnail?.source) {
                        imageMap.set(p.title, p.thumbnail.source);
                    }
                }
            }
        } catch (e) {
            log.warn('ship image batch fetch failed', { batchStart: i, err: e });
        }
    }

    // Build rows and upsert individually so one bad row doesn't block others
    let upserted = 0;
    let errors = 0;
    let claimed = 0;
    for (const v of vehicles) {
        const apiId = v.id as number | undefined;
        if (!apiId) continue; // shipmatrix should always have id; guard anyway

        const name = v.name || 'Unknown';
        const manufacturer = v.manufacturer?.name || 'Unknown';

        // Name+manufacturer fallback: claim any legacy row that lacks an
        // external_api_id but matches by name+manufacturer. Prevents the
        // upsert below from creating a duplicate row that would split
        // user_ships references off the legacy entry. Only updates rows where
        // external_api_id IS NULL, so we never steal an id from another row.
        const { data: claimedRows } = await supabase.from('platform_ships')
            .update({ external_api_id: apiId })
            .eq('name', name)
            .eq('manufacturer', manufacturer)
            .is('external_api_id', null)
            .select('id');
        if (claimedRows) claimed += claimedRows.length;

        const row = {
            external_api_id: apiId,
            name,
            manufacturer,
            manufacturer_code: v.manufacturer?.code || null,
            // Strip markup from third-party (star-citizen.wiki) display text.
            role: stripHtmlSingleLine(locStr(v.foci?.[0]) || v.focus?.name, 120) || null,
            career: stripHtmlSingleLine(locStr(v.type), 120) || null,
            size: locStr(v.size) || null,
            crew_min: v.crew?.min || 1,
            crew_max: v.crew?.max || 1,
            cargo_capacity: v.cargo_capacity ? Math.round(v.cargo_capacity) : 0,
            length: v.sizes?.length || v.length || null,
            beam: v.sizes?.beam || v.beam || null,
            height: v.sizes?.height || v.height || null,
            mass: v.mass ? Math.round(v.mass) : null,
            scm_speed: v.speed?.scm ? Math.round(v.speed.scm) : null,
            max_speed: v.speed?.max ? Math.round(v.speed.max) : null,
            image_url: imageMap.get(name) || null,
            wiki_url: `https://starcitizen.tools/${name.replace(/ /g, '_')}`,
            pledge_url: v.pledge_url || null,
            msrp: v.msrp ? parseFloat(String(v.msrp)) : null,
            description: stripHtml(locStr(v.description), 8000) || null,
            production_status: stripHtmlSingleLine(locStr(v.production_status), 80) || null,
            updated_at: new Date().toISOString()
        };

        const { error } = await supabase.from('platform_ships').upsert(row, { onConflict: 'external_api_id' });
        if (error) {
            errors++;
            if (errors <= 5) log.warn('ship upsert failed', { name, apiId, error: error.message });
        } else {
            upserted++;
        }
    }
    if (errors > 5) log.warn('additional ship upsert errors suppressed', { additionalErrors: errors - 5 });
    log.info('ship sync complete', { upserted, claimed, errors, images: imageMap.size });

    // Catalog admin mutations historically emitted nothing — remote clients
    // only saw catalog changes on their next full fleet fetch. One emit for
    // the whole sync (not per-row).
    broadcastFleetUpdate('catalog');
    return { synced: upserted, claimed, errors, images: imageMap.size };
}

export async function repairShipCatalogDuplicates() {
    const allVehicles = await fetchAllVehiclesFromApi();

    // Build map: API id → list of UUIDs (variant UUIDs that share the same ship model)
    const apiIdToUuids = new Map<number, string[]>();
    const uuidToApiId = new Map<string, number>();
    for (const v of allVehicles) {
        const apiId = v.id as number;
        const uuid = v.uuid as string;
        if (!apiId || !uuid) continue;
        if (!apiIdToUuids.has(apiId)) apiIdToUuids.set(apiId, []);
        apiIdToUuids.get(apiId)!.push(uuid);
        uuidToApiId.set(uuid, apiId);
    }

    let groupsProcessed = 0;
    let shipsMerged = 0;
    let backfilled = 0;
    let errors = 0;
    const summary: string[] = [];

    // Process groups with 2+ UUIDs — these may have duplicate DB rows
    for (const [apiId, uuids] of apiIdToUuids) {
        if (uuids.length < 2) continue;

        try {
            const { data: dbRows } = await supabase.from('platform_ships')
                .select('id, name, external_uuid, external_api_id, image_url')
                .in('external_uuid', uuids);

            if (!dbRows || dbRows.length < 2) continue;
            groupsProcessed++;

            // Get usage counts for each DB row
            const shipIds = dbRows.map(r => r.id);
            const { data: usageData } = await supabase.from('user_ships')
                .select('ship_id')
                .in('ship_id', shipIds);
            const usageMap = new Map<number, number>();
            for (const u of (usageData || [])) {
                usageMap.set(u.ship_id, (usageMap.get(u.ship_id) || 0) + 1);
            }

            // Pick canonical: most user_ships refs → has image → lowest DB id
            dbRows.sort((a, b) => {
                const aUsage = usageMap.get(a.id) || 0;
                const bUsage = usageMap.get(b.id) || 0;
                if (bUsage !== aUsage) return bUsage - aUsage;
                const aImg = a.image_url ? 1 : 0;
                const bImg = b.image_url ? 1 : 0;
                if (bImg !== aImg) return bImg - aImg;
                return a.id - b.id;
            });

            const keep = dbRows[0];
            const dupes = dbRows.slice(1);

            for (const dupe of dupes) {
                try {
                    const dupeUsage = usageMap.get(dupe.id) || 0;
                    await mergePlatformShips(keep.id, dupe.id);
                    shipsMerged++;
                    summary.push(`Merged "${dupe.name}" (id:${dupe.id}, ${dupeUsage} refs) → "${keep.name}" (id:${keep.id})`);
                } catch (e) {
                    errors++;
                    summary.push(`ERROR merging id:${dupe.id} → id:${keep.id}: ${(e as Error).message}`);
                }
            }

            // Set external_api_id on the kept entry
            await supabase.from('platform_ships')
                .update({ external_api_id: apiId })
                .eq('id', keep.id);
        } catch (e) {
            errors++;
            summary.push(`ERROR processing API id ${apiId}: ${(e as Error).message}`);
        }
    }

    // Backfill external_api_id on non-duplicate entries that are missing it
    const { data: missingApiId } = await supabase.from('platform_ships')
        .select('id, external_uuid')
        .is('external_api_id', null)
        .not('external_uuid', 'is', null);

    for (const row of (missingApiId || [])) {
        const apiId = uuidToApiId.get(row.external_uuid);
        if (apiId) {
            const { error } = await supabase.from('platform_ships')
                .update({ external_api_id: apiId })
                .eq('id', row.id);
            if (!error) backfilled++;
        }
    }

    log.info('ship catalog repair complete', { groupsProcessed, shipsMerged, backfilled, errors });
    // Repair merges duplicate catalog rows and reassigns user_ships refs.
    broadcastFleetUpdate('catalog', 'user_ships', 'groups');
    return { groupsProcessed, shipsMerged, backfilled, errors, summary };
}

// --- Ship Catalog Admin ---

export async function getShipCatalogWithUsage() {
    const [shipsResult, usageResult] = await Promise.all([
        supabase.from('platform_ships')
            .select('id, external_uuid, external_api_id, name, manufacturer, manufacturer_code, role, career, size, crew_min, crew_max, cargo_capacity, length, beam, height, mass, scm_speed, max_speed, health, shield_hp, image_url, wiki_url, pledge_url, msrp, description, production_status, created_at, updated_at')
            .order('manufacturer', { ascending: true })
            .order('name', { ascending: true }),
        supabase.from('user_ships')
            .select('ship_id')
    ]);
    handleSupabaseError({ error: shipsResult.error, message: 'Failed to get ship catalog' });

    const usageMap = new Map<number, number>();
    for (const row of (usageResult.data || [])) {
        usageMap.set(row.ship_id, (usageMap.get(row.ship_id) || 0) + 1);
    }

    return (shipsResult.data || []).map((s: Tables<'platform_ships'>) => ({
        ...toPlatformShip(s),
        usageCount: usageMap.get(s.id) || 0
    }));
}

export async function updatePlatformShip(shipId: number, updates: Record<string, unknown>) {
    const fieldMap: Record<string, string> = {
        name: 'name', manufacturer: 'manufacturer', manufacturerCode: 'manufacturer_code',
        role: 'role', career: 'career', size: 'size',
        crewMin: 'crew_min', crewMax: 'crew_max', cargoCapacity: 'cargo_capacity',
        length: 'length', beam: 'beam', height: 'height', mass: 'mass',
        scmSpeed: 'scm_speed', maxSpeed: 'max_speed', health: 'health', shieldHp: 'shield_hp',
        imageUrl: 'image_url', wikiUrl: 'wiki_url', pledgeUrl: 'pledge_url', msrp: 'msrp',
        description: 'description', productionStatus: 'production_status'
    };
    const dbUpdates: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(updates)) {
        if (fieldMap[key] !== undefined) {
            dbUpdates[fieldMap[key]] = val === '' ? null : val;
        }
    }
    dbUpdates.updated_at = new Date().toISOString();

    const { error } = await supabase.from('platform_ships')
        .update(dbUpdates)
        .eq('id', shipId);
    handleSupabaseError({ error, message: 'Failed to update platform ship' });
    broadcastFleetUpdate('catalog');
}

export async function deletePlatformShip(shipId: number) {
    const { count } = await supabase.from('user_ships')
        .select('id', { count: 'exact', head: true })
        .eq('ship_id', shipId);

    if (count && count > 0) {
        throw new Error(`Cannot delete: ${count} user ship(s) reference this entry. Use merge to reassign them first.`);
    }

    const { error } = await supabase.from('platform_ships')
        .delete()
        .eq('id', shipId);
    handleSupabaseError({ error, message: 'Failed to delete platform ship' });
    broadcastFleetUpdate('catalog');
}

export async function mergePlatformShips(keepId: number, deleteId: number) {
    // Reassign all user_ships from deleteId to keepId
    const { error: reassignError } = await supabase.from('user_ships')
        .update({ ship_id: keepId })
        .eq('ship_id', deleteId);
    handleSupabaseError({ error: reassignError, message: 'Failed to reassign user ships during merge' });

    // Reassign operation_participants references if any
    await supabase.from('operation_participants')
        .update({ ship_id: keepId })
        .eq('ship_id', deleteId);

    // Delete the duplicate ship
    const { error: deleteError } = await supabase.from('platform_ships')
        .delete()
        .eq('id', deleteId);
    handleSupabaseError({ error: deleteError, message: 'Failed to delete merged ship' });

    // Merge reassigns user_ships rows AND removes a catalog row.
    broadcastFleetUpdate('catalog', 'user_ships', 'groups');
    return { merged: true };
}

// --- User Ships (Hangar) ---

// Per-request batch cap + per-user hangar ceiling. A member could otherwise
// insert hundreds of thousands of rows in one fleet:add_ships call (no UNIQUE on
// (user_id, ship_id) — and there must not be one, since owning duplicate hulls is
// legitimate), permanently bloating user_ships and degrading the org-wide read.
const MAX_SHIPS_PER_REQUEST = 100;
const MAX_HANGAR_SHIPS = 1000;
// Upper bound on the org-wide hangar read so one abusive hangar can't make the
// whole fleet view unbounded. Well above MAX_HANGAR_SHIPS × a realistic roster.
const USER_SHIPS_READ_LIMIT = 20_000;

export async function getUserShips(): Promise<UserShip[]> {
    const query = supabase.from('user_ships')
        .select('id, user_id, ship_id, custom_name, loadout_notes, status, is_primary, created_at, ship:platform_ships(id, name, manufacturer, role, size, crew_min, crew_max, cargo_capacity, image_url), user:users!user_ships_user_id_fkey(id, name, avatar_url, rsi_handle, role_id)')

        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(USER_SHIPS_READ_LIMIT);
    const data = await safeFetch<UserShipRow[]>(
        query as unknown as PromiseLike<{ data: UserShipRow[] | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>,
        [],
        'Failed to get user ships',
    );
    return (data || []).map(toUserShip);
}

export async function addUserShip(userId: number, shipId: number, customName: string | null, loadoutNotes: string | null) {
    const { error } = await supabase.from('user_ships').insert({
        user_id: userId,
        ship_id: shipId,
        custom_name: customName,
        loadout_notes: loadoutNotes
    });
    handleSupabaseError({ error, message: 'Failed to add ship to hangar' });
    broadcastFleetUpdate('user_ships', 'groups');
}

export async function addUserShips(userId: number, shipIds: number[]) {
    if (!Array.isArray(shipIds) || shipIds.length === 0) return;
    if (shipIds.length > MAX_SHIPS_PER_REQUEST) {
        throw new Error(`Too many ships in one request (max ${MAX_SHIPS_PER_REQUEST}).`);
    }
    // Enforce a per-user hangar ceiling so the batch can't balloon the table.
    const { count } = await supabase.from('user_ships')
        .select('id', { count: 'exact', head: true }).eq('user_id', userId);
    if ((count || 0) + shipIds.length > MAX_HANGAR_SHIPS) {
        throw new Error(`Hangar limit reached (max ${MAX_HANGAR_SHIPS} ships).`);
    }
    const rows = shipIds.map(shipId => ({
        user_id: userId,
        ship_id: shipId
    }));
    const { error } = await supabase.from('user_ships').insert(rows);
    handleSupabaseError({ error, message: 'Failed to add ships to hangar' });
    broadcastFleetUpdate('user_ships', 'groups');
}

export async function updateUserShip(
    userShipId: number,
    updates: { customName?: string | null; loadoutNotes?: string | null; status?: ShipStatus; isPrimary?: boolean },
    // When provided, the row must also belong to this user, so a member with only
    // fleet:manage_own cannot edit another member's ship by id. Managers
    // (fleet:manage) pass undefined to operate org-wide.
    actorUserId?: number,
) {
    const dbUpdates: Record<string, unknown> = {};
    if (updates.customName !== undefined) dbUpdates.custom_name = updates.customName;
    if (updates.loadoutNotes !== undefined) dbUpdates.loadout_notes = updates.loadoutNotes;
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.isPrimary !== undefined) dbUpdates.is_primary = updates.isPrimary;

    let q = supabase.from('user_ships').update(dbUpdates).eq('id', userShipId);
    if (actorUserId !== undefined) q = q.eq('user_id', actorUserId);
    const { error } = await q;
    handleSupabaseError({ error, message: 'Failed to update ship' });
    broadcastFleetUpdate('user_ships', 'groups');
}

export async function removeUserShip(userShipId: number, actorUserId?: number) {
    let q = supabase.from('user_ships').delete().eq('id', userShipId);
    if (actorUserId !== undefined) q = q.eq('user_id', actorUserId);
    const { error } = await q;
    handleSupabaseError({ error, message: 'Failed to remove ship' });
    broadcastFleetUpdate('user_ships', 'groups');
}

export async function removeUserShips(userShipIds: number[], actorUserId?: number) {
    let q = supabase.from('user_ships').delete().in('id', userShipIds);
    if (actorUserId !== undefined) q = q.eq('user_id', actorUserId);
    const { error } = await q;
    handleSupabaseError({ error, message: 'Failed to remove ships' });
    broadcastFleetUpdate('user_ships', 'groups');
}

// --- Fleet Groups ---

export async function getFleetGroups(): Promise<FleetGroup[]> {
    const query = supabase.from('fleet_groups')
        .select('id, name, type, parent_id, commander_id, description, icon, sort_order, commander:users!fleet_groups_commander_id_fkey(id, name, avatar_url, rsi_handle, role_id)')

        .order('sort_order', { ascending: true });
    const data = await safeFetch<FleetGroupRow[]>(
        query as unknown as PromiseLike<{ data: FleetGroupRow[] | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>,
        [],
        'Failed to get fleet groups',
    );

    // Fetch group ship assignments. ORDER BY sort_order so the UI's manual
    // ship arrangement persists across reloads and across other clients.
    const groupIds = (data || []).map((g) => g.id);
    let assignments: AssignmentRow[] = [];
    if (groupIds.length > 0) {
        const { data: assignData } = await supabase.from('fleet_group_ships')
            .select('id, fleet_group_id, sort_order, user_ship:user_ships(id, user_id, ship_id, custom_name, loadout_notes, status, is_primary, created_at, ship:platform_ships(id, name, manufacturer, role, size, crew_min, crew_max, cargo_capacity, image_url), user:users!user_ships_user_id_fkey(id, name, avatar_url, rsi_handle, role_id))')
            .in('fleet_group_id', groupIds)
            .order('sort_order', { ascending: true });
        assignments = (assignData || []) as unknown as AssignmentRow[];
    }

    // Each assignment carries the junction row id forward via the synthetic
    // __assignment_id field so the client can reorder by junction id without
    // a second fetch. Mappers convert that into UserShip.assignmentId.
    const assignmentsByGroup = new Map<number, UserShipRow[]>();
    for (const a of assignments) {
        if (!assignmentsByGroup.has(a.fleet_group_id)) assignmentsByGroup.set(a.fleet_group_id, []);
        const hydratedShip = a.user_ship ? { ...a.user_ship, __assignment_id: a.id } : null;
        if (hydratedShip) assignmentsByGroup.get(a.fleet_group_id)!.push(hydratedShip);
    }

    return (data || []).map((g) => {
        const group = toFleetGroup(g);
        group.assignedShips = (assignmentsByGroup.get(g.id) || []).map(toUserShip);
        return group;
    });
}

export async function createFleetGroup(data: FleetGroupInput) {
    const { error } = await supabase.from('fleet_groups').insert({
        name: data.name,
        type: data.type || 'Custom',
        parent_id: data.parentId || null,
        commander_id: data.commanderId || null,
        description: data.description || null,
        icon: data.icon || null,
        sort_order: data.sortOrder || 0
    });
    handleSupabaseError({ error, message: 'Failed to create fleet group' });
    broadcastFleetUpdate('groups');
}

export async function updateFleetGroup(id: number, updates: Partial<FleetGroupInput>) {
    const dbUpdates: Record<string, unknown> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.type !== undefined) dbUpdates.type = updates.type;
    if (updates.parentId !== undefined) dbUpdates.parent_id = updates.parentId || null;
    if (updates.commanderId !== undefined) dbUpdates.commander_id = updates.commanderId || null;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.icon !== undefined) dbUpdates.icon = updates.icon;
    if (updates.sortOrder !== undefined) dbUpdates.sort_order = updates.sortOrder;

    const { error } = await supabase.from('fleet_groups')
        .update(dbUpdates)
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to update fleet group' });
    broadcastFleetUpdate('groups');
}

export async function deleteFleetGroup(id: number) {
    // Confirm the group belongs to the caller's org and grab its parent_id —
    // children will be reparented to that value so they're promoted one level
    // up rather than flattened to the root (which is what the FK's ON DELETE
    // SET NULL fallback would do). Mirrors the tenant-scoping precedent in
    // assignShipToGroup / removeShipFromGroup above.
    const { data: group } = await supabase.from('fleet_groups')
        .select('id, parent_id')
        .eq('id', id)
        
        .maybeSingle();
    if (!group) throw new Error('Fleet group not found');

    // Reparent children before the delete. Org-scoped on the WHERE so a
    // crafted payload can't reach across tenants. fleet_group_ships rows
    // for the deleted group are dropped by ON DELETE CASCADE on the FK
    // (see migrations/add-fleet-delete-cascade.sql).
    const { error: reparentError } = await supabase.from('fleet_groups')
        .update({ parent_id: group.parent_id })
        .eq('parent_id', id)
        ;
    handleSupabaseError({ error: reparentError, message: 'Failed to reparent child fleet groups' });

    const { error } = await supabase.from('fleet_groups')
        .delete()
        .eq('id', id)
        ;
    handleSupabaseError({ error, message: 'Failed to delete fleet group' });
    broadcastFleetUpdate('groups');
}

export async function assignShipToGroup(fleetGroupId: number, userShipId: number) {
    // Defense-in-depth: confirm both the group and the ship belong to the
    // caller's org so a crafted payload can't link cross-tenant rows. Mirrors
    // the reorderGroupShips precedent below.
    const [groupRes, shipRes] = await Promise.all([
        supabase.from('fleet_groups').select('id').eq('id', fleetGroupId).maybeSingle(),
        supabase.from('user_ships').select('id').eq('id', userShipId).maybeSingle(),
    ]);
    if (!groupRes.data) throw new Error('Fleet group not found');
    if (!shipRes.data) throw new Error('Ship not found');

    const { error } = await supabase.from('fleet_group_ships').insert({
        fleet_group_id: fleetGroupId,
        user_ship_id: userShipId
    });
    handleSupabaseError({ error, message: 'Failed to assign ship to group' });
    broadcastFleetUpdate('groups');
}

export async function removeShipFromGroup(fleetGroupId: number, userShipId: number) {
    // Defense-in-depth: confirm the group belongs to the caller's org so a
    // crafted payload can't strip another tenant's assignments. Mirrors the
    // reorderGroupShips precedent below.
    const { data: group } = await supabase.from('fleet_groups')
        .select('id')
        .eq('id', fleetGroupId)
        
        .maybeSingle();
    if (!group) throw new Error('Fleet group not found');

    const { error } = await supabase.from('fleet_group_ships')
        .delete()
        .eq('fleet_group_id', fleetGroupId)
        .eq('user_ship_id', userShipId);
    handleSupabaseError({ error, message: 'Failed to remove ship from group' });
    broadcastFleetUpdate('groups');
}

// --- Manual ordering / reparenting ---

/**
 * Apply a new sibling order to fleet groups. Caller passes the full ordered
 * list of group ids at one parent level; we set sort_order = (idx + 1) * 10
 * so subsequent insertions between two existing items don't immediately need
 * a renumber. One broadcast per call.
 */
export async function reorderFleetGroups(orderedIds: number[]) {
    if (orderedIds.length === 0) return;
    const updates = orderedIds.map((id, idx) =>
        supabase.from('fleet_groups')
            .update({ sort_order: (idx + 1) * 10 })
            .eq('id', id)
            
    );
    const results = await Promise.all(updates);
    for (const r of results) {
        handleSupabaseError({ error: r.error, message: 'Failed to reorder fleet groups' });
    }
    broadcastFleetUpdate('groups');
}

/**
 * Apply a new ship order within a single group. `orderedAssignmentIds` are
 * fleet_group_ships row ids — pulled from UserShip.assignmentId on the client.
 * One broadcast per call.
 */
export async function reorderGroupShips(fleetGroupId: number, orderedAssignmentIds: number[]) {
    if (orderedAssignmentIds.length === 0) return;
    // Defense-in-depth: confirm the group belongs to the caller's org so a
    // crafted payload can't reorder another tenant's assignments.
    const { data: group } = await supabase.from('fleet_groups')
        .select('id')
        .eq('id', fleetGroupId)
        
        .maybeSingle();
    if (!group) throw new Error('Fleet group not found');

    const updates = orderedAssignmentIds.map((id, idx) =>
        supabase.from('fleet_group_ships')
            .update({ sort_order: (idx + 1) * 10 })
            .eq('id', id)
            .eq('fleet_group_id', fleetGroupId)
    );
    const results = await Promise.all(updates);
    for (const r of results) {
        handleSupabaseError({ error: r.error, message: 'Failed to reorder group ships' });
    }
    broadcastFleetUpdate('groups');
}

/**
 * Reparent a fleet group. Used when the user drags a group onto another
 * group's body. Walks the existing parent chain to reject cycles before
 * committing. `newParentId === null` reparents to the root.
 */
export async function reparentFleetGroup(groupId: number, newParentId: number | null, newSortOrder: number) {
    if (newParentId === groupId) throw new Error('A fleet group cannot be its own parent.');

    if (newParentId !== null) {
        // Walk up from newParentId — if we ever hit groupId, the move would
        // create a cycle. Use a small in-memory map to keep this O(depth) even
        // with large org charts.
        const { data: allGroups } = await supabase.from('fleet_groups')
            .select('id, parent_id')
            ;
        const parentMap = new Map<number, number | null>();
        for (const g of (allGroups || [])) parentMap.set(g.id, g.parent_id);
        let cursor: number | null | undefined = newParentId;
        const seen = new Set<number>();
        while (cursor !== null && cursor !== undefined) {
            if (cursor === groupId) throw new Error('Cannot move a group beneath one of its descendants.');
            if (seen.has(cursor)) break; // Pre-existing cycle in data; bail rather than loop.
            seen.add(cursor);
            cursor = parentMap.get(cursor) ?? null;
        }
    }

    const { error } = await supabase.from('fleet_groups')
        .update({ parent_id: newParentId, sort_order: newSortOrder })
        .eq('id', groupId)
        ;
    handleSupabaseError({ error, message: 'Failed to reparent fleet group' });
    broadcastFleetUpdate('groups');
}

// --- Cross-org ship lookup (for joint operations) ---

export async function getUserShipsByUserIds(userIds: number[]): Promise<UserShip[]> {
    if (!userIds.length) return [];
    const { data, error } = await supabase.from('user_ships')
        .select('id, user_id, ship_id, custom_name, loadout_notes, status, is_primary, created_at, ship:platform_ships(id, external_uuid, external_api_id, name, manufacturer, manufacturer_code, role, career, size, crew_min, crew_max, cargo_capacity, length, beam, height, mass, scm_speed, max_speed, health, shield_hp, image_url, wiki_url, pledge_url, msrp, description, production_status), user:users!user_ships_user_id_fkey(id, name, avatar_url, rsi_handle, role_id)')
        .in('user_id', userIds)
        .order('created_at', { ascending: false });
    handleSupabaseError({ error, message: 'Failed to get user ships by user IDs' });
    return ((data || []) as unknown as UserShipRow[]).map(toUserShip);
}

// --- Fleet State (combined fetch for query subset) ---

export async function getFleetState() {
    const [shipCatalog, userShips, fleetGroups] = await Promise.all([
        getShipCatalog(),
        getUserShips(),
        getFleetGroups()
    ]);
    return { shipCatalog, userShips, fleetGroups };
}
