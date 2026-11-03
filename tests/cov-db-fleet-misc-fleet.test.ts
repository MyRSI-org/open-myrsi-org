import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/fleet.ts — ship catalog, member hangars, fleet groups.
//
// The properties that carry weight here:
//  * Ownership: a fleet:manage_own caller passes actorUserId, which MUST become a
//    `user_id = actor` filter on every id-addressed hangar write (update/remove),
//    so one member cannot edit or delete another member's ship by id.
//  * Mass-assignment: updatePlatformShip only writes whitelisted catalog columns.
//  * Third-party sanitisation: star-citizen.wiki display text is HTML-stripped and
//    length-capped before it lands in platform_ships.
//  * Rule 4: every mutation broadcasts `fleet_update` with slice discriminators
//    only — never row content.
//  * Rule 1: every select names explicit columns (asserted after every test).
//  * Failure handling: a write error throws the caller-facing message and emits
//    NO broadcast; group/ship existence checks fail closed before any write.

vi.mock('../lib/log', async () => (await import('./cov-db-fleet-misc-sb')).logModule);
vi.mock('../lib/db/common', async (importOriginal) => {
    const h = await import('./cov-db-fleet-misc-sb');
    return {
        ...(await importOriginal<typeof import('../lib/db/common')>()),
        supabase: h.fakeSupabase,
        broadcastToOrg: h.broadcast,
    };
});

import {
    resetAll, route, sb, queriesFor, filterValue, assertExplicitColumns, logs, logged, broadcast,
    type Q,
} from './cov-db-fleet-misc-sb';
import {
    getShipCatalog, syncShipCatalog, repairShipCatalogDuplicates, getShipCatalogWithUsage,
    updatePlatformShip, deletePlatformShip, mergePlatformShips, getUserShips, addUserShip,
    addUserShips, updateUserShip, removeUserShip, removeUserShips, getFleetGroups,
    createFleetGroup, updateFleetGroup, deleteFleetGroup, assignShipToGroup, removeShipFromGroup,
    reorderFleetGroups, reorderGroupShips, reparentFleetGroup, getUserShipsByUserIds, getFleetState,
} from '../lib/db/fleet';
import { ShipStatus, FleetGroupType } from '../types';

const FIXED_NOW = '2026-03-04T05:06:07.000Z';
const DB_ERR = { code: '42501', message: 'permission denied for table' };

const shipRow = (over: Record<string, unknown> = {}) => ({
    id: 10, external_uuid: 'uuid-10', external_api_id: 274, name: 'Ironclad', manufacturer: 'Drake',
    manufacturer_code: 'DRAK', role: 'Freight', career: 'Transport', size: 'large', crew_min: 2, crew_max: 4,
    cargo_capacity: 1280, length: '129.5', beam: 50, height: 25, mass: 1000, scm_speed: 100, max_speed: 900,
    health: 5000, shield_hp: 2000, image_url: 'https://img/ironclad.png', wiki_url: 'https://wiki/Ironclad',
    pledge_url: null, msrp: '450.25', description: 'Big', production_status: 'flight-ready',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', ...over,
});
const userRow = { id: 7, name: 'Pilot', avatar_url: 'a.png', rsi_handle: 'pilot7', role_id: 2 };
const userShipRow = (over: Record<string, unknown> = {}) => ({
    id: 100, user_id: 7, ship_id: 10, custom_name: 'Big Bertha', loadout_notes: 'stock', status: 'Stored',
    is_primary: true, created_at: '2026-02-01T00:00:00Z',
    ship: { id: 10, name: 'Ironclad', manufacturer: 'Drake', role: 'Freight', size: 'large', crew_min: 2, crew_max: 4, cargo_capacity: 1280, image_url: 'x' },
    user: userRow, ...over,
});
const groupRow = (over: Record<string, unknown> = {}) => ({
    id: 1, name: 'Alpha Wing', type: 'Wing', parent_id: null, commander_id: 7, description: 'd', icon: 'i',
    sort_order: 10, commander: userRow, ...over,
});

const fleetUpdate = (...slices: string[]) => ['fleet_update', slices.length ? { slices } : {}];

// ── fetch double for the star-citizen.wiki / starcitizen.tools sync paths ──
interface FetchResp { ok: boolean; status: number; json: () => Promise<unknown> }
const fetchSpy = vi.fn<(url: string) => Promise<FetchResp>>();
const okResp = (body: unknown): FetchResp => ({ ok: true, status: 200, json: async () => body });
type Page = { data: unknown[]; meta?: { current_page?: number; last_page?: number } };

function stubWiki(pages: Page[], images?: (titles: string, url: string) => FetchResp | Promise<FetchResp>) {
    fetchSpy.mockImplementation(async (url: string) => {
        if (url.startsWith('https://api.star-citizen.wiki/')) {
            const n = Number(new URL(url).searchParams.get('page[number]'));
            return okResp(pages[n - 1] ?? { data: [] });
        }
        if (url.startsWith('https://starcitizen.tools/')) {
            const titles = new URL(url).searchParams.get('titles') ?? '';
            return images ? images(titles, url) : okResp({ query: { pages: {} } });
        }
        throw new Error(`unexpected fetch ${url}`);
    });
}
const wikiCalls = () => fetchSpy.mock.calls.map((c) => c[0]).filter((u) => u.startsWith('https://api.star-citizen.wiki/'));
const imageCalls = () => fetchSpy.mock.calls.map((c) => c[0]).filter((u) => u.startsWith('https://starcitizen.tools/'));

beforeEach(() => {
    resetAll();
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
    assertExplicitColumns();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getShipCatalog', () => {
    it('reads platform_ships with an explicit column list, ordered manufacturer then name, and maps each row', async () => {
        route('platform_ships:select', { data: [shipRow()] });
        const out = await getShipCatalog();

        const [q] = queriesFor('platform_ships', 'select');
        expect(q.columns).toContain('external_api_id');
        expect(q.columns).toContain('production_status');
        expect(q.orders).toEqual([['manufacturer', { ascending: true }], ['name', { ascending: true }]]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            id: 10, externalUuid: 'uuid-10', externalApiId: 274, name: 'Ironclad', manufacturer: 'Drake',
            manufacturerCode: 'DRAK', crewMin: 2, crewMax: 4, cargoCapacity: 1280,
            length: 129.5, msrp: 450.25, imageUrl: 'https://img/ironclad.png', productionStatus: 'flight-ready',
        });
        expect(out[0].pledgeUrl).toBeUndefined();
    });

    it('returns [] when the read yields no rows', async () => {
        route('platform_ships:select', { data: null });
        await expect(getShipCatalog()).resolves.toEqual([]);
    });

    it('throws the caller-facing message (no schema detail) on a read error', async () => {
        route('platform_ships:select', { error: DB_ERR });
        await expect(getShipCatalog()).rejects.toThrow(/^Failed to get ship catalog$/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('syncShipCatalog', () => {
    const fullVehicle = {
        id: 274, uuid: 'u-274', name: 'Ironclad Assault',
        manufacturer: { name: 'Drake Interplanetary', code: 'DRAK' },
        foci: [{ en_EN: '<b>Heavy</b>\nAssault' }],
        type: { en: '<i>Combat</i>' },
        size: { en_EN: 'large' },
        crew: { min: 3, max: 6 },
        cargo_capacity: 1279.6,
        sizes: { length: 129, beam: 50, height: 25 },
        mass: 1234.5,
        speed: { scm: 100.4, max: 900.6 },
        pledge_url: 'https://rsi/pledge',
        msrp: '450.50',
        description: { en_EN: '<p>Armoured</p> dropship' },
        production_status: { en: 'flight-ready' },
    };
    const sparseVehicle = { id: 9, manufacturer: null, focus: { name: 'Starter' }, length: 20, beam: 10, height: 5, size: null };

    it('maps + sanitises every wiki field, claims legacy rows first, upserts on external_api_id, and broadcasts once', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(FIXED_NOW));
        stubWiki(
            [{ data: [fullVehicle, sparseVehicle, { name: 'NoId' }] }],
            () => okResp({ query: { pages: { 1: { title: 'Ironclad Assault', thumbnail: { source: 'https://img/ia.png' } }, 2: { title: 'NoId' } } } }),
        );
        route('platform_ships:update', (q) => ({ data: filterValue(q, 'eq', 'name') === 'Ironclad Assault' ? [{ id: 1 }] : null }));

        const res = await syncShipCatalog();

        expect(res).toEqual({ synced: 2, claimed: 1, errors: 0, images: 1 });
        // Vehicles without an id are never written.
        const claims = queriesFor('platform_ships', 'update');
        const upserts = queriesFor('platform_ships', 'upsert');
        expect(claims).toHaveLength(2);
        expect(upserts).toHaveLength(2);

        // Legacy-row claim: only rows that have NO external_api_id yet, matched on name + manufacturer.
        expect(claims[0].payload).toEqual({ external_api_id: 274 });
        expect(claims[0].filters).toEqual([
            ['eq', 'name', 'Ironclad Assault'], ['eq', 'manufacturer', 'Drake Interplanetary'], ['is', 'external_api_id', null],
        ]);
        expect(claims[0].columns).toBe('id');
        // The claim precedes the upsert for the same vehicle.
        expect(sb.queries.indexOf(claims[0])).toBeLessThan(sb.queries.indexOf(upserts[0]));

        expect(upserts[0].writeOpts).toEqual({ onConflict: 'external_api_id' });
        expect(upserts[0].payload).toEqual({
            external_api_id: 274, name: 'Ironclad Assault', manufacturer: 'Drake Interplanetary', manufacturer_code: 'DRAK',
            role: 'Heavy Assault', career: 'Combat', size: 'large', crew_min: 3, crew_max: 6, cargo_capacity: 1280,
            length: 129, beam: 50, height: 25, mass: 1235, scm_speed: 100, max_speed: 901,
            image_url: 'https://img/ia.png', wiki_url: 'https://starcitizen.tools/Ironclad_Assault',
            pledge_url: 'https://rsi/pledge', msrp: 450.5, description: 'Armoured dropship',
            production_status: 'flight-ready', updated_at: FIXED_NOW,
        });
        // Sparse record: every fallback, and the flat length/beam/height fields.
        expect(upserts[1].payload).toEqual({
            external_api_id: 9, name: 'Unknown', manufacturer: 'Unknown', manufacturer_code: null,
            role: 'Starter', career: null, size: null, crew_min: 1, crew_max: 1, cargo_capacity: 0,
            length: 20, beam: 10, height: 5, mass: null, scm_speed: null, max_speed: null,
            image_url: null, wiki_url: 'https://starcitizen.tools/Unknown', pledge_url: null, msrp: null,
            description: null, production_status: null, updated_at: FIXED_NOW,
        });

        expect(broadcast).toHaveBeenCalledTimes(1);
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('catalog'));
        expect(logged('info', 'ship sync complete')?.fields).toEqual({ upserted: 2, claimed: 1, errors: 0, images: 1 });
    });

    it('paginates the shipmatrix by meta.last_page with 200-row pages', async () => {
        stubWiki([
            { data: [{ id: 1, name: 'A' }], meta: { current_page: 1, last_page: 2 } },
            { data: [{ id: 2, name: 'B' }], meta: { current_page: 2, last_page: 2 } },
        ]);
        const res = await syncShipCatalog();

        const urls = wikiCalls().map((u) => new URL(u));
        expect(urls).toHaveLength(2);
        expect(urls.map((u) => u.searchParams.get('page[number]'))).toEqual(['1', '2']);
        expect(urls.every((u) => u.searchParams.get('page[size]') === '200')).toBe(true);
        expect(res.synced).toBe(2);
        expect(logged('info', 'shipmatrix fetch complete')?.fields).toEqual({ count: 2, pages: 2 });
    });

    it('without pagination meta, keeps paging until an empty page', async () => {
        stubWiki([{ data: [{ id: 1, name: 'A' }] }, { data: [] }]);
        await syncShipCatalog();
        expect(wikiCalls()).toHaveLength(2);
        expect(logged('info', 'shipmatrix fetch complete')?.fields).toEqual({ count: 1, pages: 2 });
    });

    it('a shipmatrix HTTP failure aborts before any DB write or broadcast', async () => {
        fetchSpy.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
        await expect(syncShipCatalog()).rejects.toThrow('star-citizen.wiki shipmatrix error: 503');
        expect(sb.queries).toEqual([]);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('batches image lookups 50 titles at a time, underscore-joined', async () => {
        const vehicles = Array.from({ length: 51 }, (_, i) => ({ name: `Ship ${i}` }));
        stubWiki([{ data: vehicles }]);
        const res = await syncShipCatalog();

        const calls = imageCalls().map((u) => new URL(u).searchParams.get('titles')!.split('|'));
        expect(calls.map((c) => c.length)).toEqual([50, 1]);
        expect(calls[0][0]).toBe('Ship_0');
        expect(calls[1]).toEqual(['Ship_50']);
        // No ids → nothing written, but the sync still completes and broadcasts.
        expect(res).toEqual({ synced: 0, claimed: 0, errors: 0, images: 0 });
        expect(queriesFor('platform_ships')).toEqual([]);
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('catalog'));
    });

    it('tolerates a failed or throwing image batch — images are best-effort', async () => {
        const vehicles = Array.from({ length: 51 }, (_, i) => ({ id: i + 1, name: `Ship ${i}` }));
        let n = 0;
        stubWiki([{ data: vehicles }], () => {
            n++;
            if (n === 1) return { ok: false, status: 500, json: async () => { throw new Error('not reached'); } };
            throw new Error('dns failure');
        });
        const res = await syncShipCatalog();
        expect(res.images).toBe(0);
        expect(res.synced).toBe(51);
        const warn = logged('warn', 'ship image batch fetch failed');
        expect(warn?.fields).toMatchObject({ batchStart: 50 });
        expect(queriesFor('platform_ships', 'upsert').every((q) => (q.payload as { image_url: unknown }).image_url === null)).toBe(true);
    });

    it('counts per-row upsert failures, logs the first five and suppresses the rest', async () => {
        stubWiki([{ data: Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `S${i}` })) }]);
        route('platform_ships:upsert', { error: { message: 'duplicate key' } });
        const res = await syncShipCatalog();

        expect(res).toEqual({ synced: 0, claimed: 0, errors: 7, images: 0 });
        expect(logs.filter((l) => l.level === 'warn' && l.msg === 'ship upsert failed')).toHaveLength(5);
        expect(logged('warn', 'ship upsert failed')?.fields).toEqual({ name: 'S0', apiId: 1, error: 'duplicate key' });
        expect(logged('warn', 'additional ship upsert errors suppressed')?.fields).toEqual({ additionalErrors: 2 });
        // One bad row never blocks the rest: every vehicle was attempted.
        expect(queriesFor('platform_ships', 'upsert')).toHaveLength(7);
        expect(broadcast).toHaveBeenCalledTimes(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('repairShipCatalogDuplicates', () => {
    const GROUP_COLS = 'id, name, external_uuid, external_api_id, image_url';

    it('merges duplicate rows into the most-referenced (then image, then lowest id) row and backfills missing api ids', async () => {
        stubWiki([{
            data: [
                { id: 1, uuid: 'a1' }, { id: 1, uuid: 'a2' }, { id: 1, uuid: 'a3' },
                { id: 2, uuid: 'b1' },
                { id: 3, uuid: 'c1' }, { id: 3, uuid: 'c2' },
                { id: 4 }, { uuid: 'orphan' },
            ],
        }]);
        route('platform_ships:select', (q) => {
            if (q.columns === GROUP_COLS) {
                const uuids = filterValue(q, 'in', 'external_uuid') as string[];
                if (uuids.includes('a1')) {
                    return { data: [
                        { id: 30, name: 'A3', external_uuid: 'a3', external_api_id: null, image_url: null },
                        { id: 20, name: 'A2', external_uuid: 'a2', external_api_id: null, image_url: 'img' },
                        { id: 10, name: 'A1', external_uuid: 'a1', external_api_id: null, image_url: null },
                    ] };
                }
                return { data: [{ id: 50, name: 'C1', external_uuid: 'c1', external_api_id: null, image_url: null }] };
            }
            return { data: [{ id: 60, external_uuid: 'b1' }, { id: 61, external_uuid: 'not-in-wiki' }, { id: 62, external_uuid: 'c1' }] };
        });
        route('user_ships:select', { data: [{ ship_id: 30 }, { ship_id: 30 }, { ship_id: 10 }, { ship_id: 10 }] });
        route('platform_ships:update', (q) => (filterValue(q, 'eq', 'id') === 62 ? { error: DB_ERR } : {}));

        const res = await repairShipCatalogDuplicates();

        // 30 and 10 tie on usage (2 refs each), neither has an image → lowest id (10) is kept.
        expect(res).toEqual({
            groupsProcessed: 1, shipsMerged: 2, backfilled: 1, errors: 0,
            summary: ['Merged "A3" (id:30, 2 refs) → "A1" (id:10)', 'Merged "A2" (id:20, 0 refs) → "A1" (id:10)'],
        });
        const [usage] = queriesFor('user_ships', 'select');
        expect(usage.columns).toBe('ship_id');
        expect(filterValue(usage, 'in', 'ship_id')).toEqual([30, 20, 10]);

        // Each dupe's hangar refs are reassigned to the keeper before the dupe row is deleted.
        expect(queriesFor('user_ships', 'update').map((q) => [q.payload, filterValue(q, 'eq', 'ship_id')]))
            .toEqual([[{ ship_id: 10 }, 30], [{ ship_id: 10 }, 20]]);
        expect(queriesFor('platform_ships', 'delete').map((q) => filterValue(q, 'eq', 'id'))).toEqual([30, 20]);

        const updates = queriesFor('platform_ships', 'update').map((q) => [q.payload, filterValue(q, 'eq', 'id')]);
        expect(updates).toEqual([
            [{ external_api_id: 1 }, 10], // keeper stamped with the group's api id
            [{ external_api_id: 2 }, 60], // backfill
            [{ external_api_id: 3 }, 62], // backfill (errored → not counted)
        ]);
        const backfillRead = queriesFor('platform_ships', 'select').find((q) => q.columns === 'id, external_uuid')!;
        expect(backfillRead.filters).toEqual([['is', 'external_api_id', null], ['not', 'external_uuid', ['is', null]]]);

        // Two merge broadcasts + the final one; all three slices, no content.
        expect(broadcast).toHaveBeenCalledTimes(3);
        for (const call of broadcast.mock.calls) expect(call).toEqual(fleetUpdate('catalog', 'user_ships', 'groups'));
    });

    it('breaks a usage tie by preferring the row that already has an image', async () => {
        stubWiki([{ data: [{ id: 1, uuid: 'x' }, { id: 1, uuid: 'y' }] }]);
        route('platform_ships:select', (q) => (q.columns === GROUP_COLS
            ? { data: [{ id: 5, name: 'Five', image_url: null }, { id: 9, name: 'Nine', image_url: 'pic' }] }
            : { data: null }));
        route('user_ships:select', { data: null });

        const res = await repairShipCatalogDuplicates();
        expect(res.summary).toEqual(['Merged "Five" (id:5, 0 refs) → "Nine" (id:9)']);
        expect(filterValue(queriesFor('platform_ships', 'update')[0], 'eq', 'id')).toBe(9);
    });

    it('records a failed merge as an error and still stamps the keeper', async () => {
        stubWiki([{ data: [{ id: 1, uuid: 'x' }, { id: 1, uuid: 'y' }] }]);
        route('platform_ships:select', (q) => (q.columns === GROUP_COLS
            ? { data: [{ id: 5, name: 'Five', image_url: null }, { id: 9, name: 'Nine', image_url: null }] }
            : { data: [] }));
        route('user_ships:update', { error: DB_ERR });

        const res = await repairShipCatalogDuplicates();
        expect(res).toMatchObject({ groupsProcessed: 1, shipsMerged: 0, errors: 1 });
        expect(res.summary).toEqual(['ERROR merging id:9 → id:5: Failed to reassign user ships during merge']);
        // The reassign failed, so the duplicate row was NOT deleted (its refs would dangle).
        expect(queriesFor('platform_ships', 'delete')).toEqual([]);
        expect(queriesFor('platform_ships', 'update').map((q) => q.payload)).toEqual([{ external_api_id: 1 }]);
    });

    it('records a per-group read fault and carries on to the backfill', async () => {
        stubWiki([{ data: [{ id: 1, uuid: 'x' }, { id: 1, uuid: 'y' }, { id: 2, uuid: 'z' }] }]);
        route('platform_ships:select', (q) => {
            if (q.columns === GROUP_COLS) throw new Error('connection reset');
            return { data: [{ id: 70, external_uuid: 'z' }] };
        });

        const res = await repairShipCatalogDuplicates();
        expect(res).toEqual({ groupsProcessed: 0, shipsMerged: 0, backfilled: 1, errors: 1, summary: ['ERROR processing API id 1: connection reset'] });
        expect(logged('info', 'ship catalog repair complete')?.fields).toEqual({ groupsProcessed: 0, shipsMerged: 0, backfilled: 1, errors: 1 });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ship catalog admin', () => {
    it('getShipCatalogWithUsage attaches a per-ship hangar reference count', async () => {
        route('platform_ships:select', { data: [shipRow({ id: 1 }), shipRow({ id: 2 })] });
        route('user_ships:select', { data: [{ ship_id: 1 }, { ship_id: 1 }, { ship_id: 99 }] });
        const out = await getShipCatalogWithUsage();

        expect(out.map((s) => [s.id, s.usageCount])).toEqual([[1, 2], [2, 0]]);
        expect(queriesFor('user_ships', 'select')[0].columns).toBe('ship_id');
        expect(queriesFor('platform_ships', 'select')[0].orders.map((o) => o[0])).toEqual(['manufacturer', 'name']);
    });

    it('getShipCatalogWithUsage treats a missing usage read as zero refs, and throws on a catalog read error', async () => {
        route('platform_ships:select', { data: null });
        route('user_ships:select', { data: null });
        await expect(getShipCatalogWithUsage()).resolves.toEqual([]);

        route('platform_ships:select', { data: [shipRow()] });
        await expect(getShipCatalogWithUsage()).resolves.toMatchObject([{ id: 10, usageCount: 0 }]);

        route('platform_ships:select', { error: DB_ERR });
        await expect(getShipCatalogWithUsage()).rejects.toThrow('Failed to get ship catalog');
    });

    it('updatePlatformShip writes only whitelisted catalog columns, blanks "" to null, and stamps updated_at', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(FIXED_NOW));
        await updatePlatformShip(10, {
            name: 'Ironclad Mk II', manufacturerCode: '', crewMin: 3, imageUrl: 'https://img/new.png',
            productionStatus: 'concept', shieldHp: 4000,
            // Not catalog columns — must never reach the UPDATE (mass assignment).
            id: 999, external_api_id: 1, created_at: 'x', usageCount: 5,
        });
        const [q] = queriesFor('platform_ships', 'update');
        expect(q.payload).toEqual({
            name: 'Ironclad Mk II', manufacturer_code: null, crew_min: 3, image_url: 'https://img/new.png',
            production_status: 'concept', shield_hp: 4000, updated_at: FIXED_NOW,
        });
        expect(q.filters).toEqual([['eq', 'id', 10]]);
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('catalog'));
    });

    it('updatePlatformShip throws and does not broadcast on a write error', async () => {
        route('platform_ships:update', { error: DB_ERR });
        await expect(updatePlatformShip(10, { name: 'x' })).rejects.toThrow('Failed to update platform ship');
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('deletePlatformShip refuses while any hangar row references the ship', async () => {
        route('user_ships:select', { count: 3 });
        await expect(deletePlatformShip(10)).rejects.toThrow('Cannot delete: 3 user ship(s) reference this entry. Use merge to reassign them first.');
        const [probe] = queriesFor('user_ships', 'select');
        expect(probe.columns).toBe('id');
        expect(probe.selectOpts).toEqual({ count: 'exact', head: true });
        expect(probe.filters).toEqual([['eq', 'ship_id', 10]]);
        expect(queriesFor('platform_ships', 'delete')).toEqual([]);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('deletePlatformShip deletes an unreferenced ship and broadcasts the catalog slice', async () => {
        route('user_ships:select', { count: 0 });
        await deletePlatformShip(10);
        expect(queriesFor('platform_ships', 'delete')[0].filters).toEqual([['eq', 'id', 10]]);
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('catalog'));
    });

    it('deletePlatformShip surfaces a delete error without broadcasting', async () => {
        route('user_ships:select', { count: null });
        route('platform_ships:delete', { error: DB_ERR });
        await expect(deletePlatformShip(10)).rejects.toThrow('Failed to delete platform ship');
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('mergePlatformShips reassigns hangar + participant refs, then deletes the duplicate', async () => {
        await expect(mergePlatformShips(1, 2)).resolves.toEqual({ merged: true });
        expect(sb.queries.map((q) => [q.table, q.verb, q.payload, q.filters])).toEqual([
            ['user_ships', 'update', { ship_id: 1 }, [['eq', 'ship_id', 2]]],
            ['operation_participants', 'update', { ship_id: 1 }, [['eq', 'ship_id', 2]]],
            ['platform_ships', 'delete', undefined, [['eq', 'id', 2]]],
        ]);
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('catalog', 'user_ships', 'groups'));
    });

    it('mergePlatformShips stops before deleting when the reassign fails', async () => {
        route('user_ships:update', { error: DB_ERR });
        await expect(mergePlatformShips(1, 2)).rejects.toThrow('Failed to reassign user ships during merge');
        expect(queriesFor('platform_ships', 'delete')).toEqual([]);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('mergePlatformShips surfaces a failed duplicate delete', async () => {
        route('platform_ships:delete', { error: DB_ERR });
        await expect(mergePlatformShips(1, 2)).rejects.toThrow('Failed to delete merged ship');
        expect(broadcast).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('hangar reads', () => {
    it('getUserShips reads a bounded, totally-ordered page with a narrow user embed and maps rows', async () => {
        route('user_ships:select', { data: [userShipRow()] });
        const out = await getUserShips();

        const [q] = queriesFor('user_ships', 'select');
        expect(q.columns).toContain('user:users!user_ships_user_id_fkey(id, name, avatar_url, rsi_handle, role_id)');
        // No PII columns on the embedded user.
        expect(q.columns).not.toMatch(/\b(email|discord_id|ip_address|last_ip)\b/);
        expect(q.orders).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(q.limit).toBe(20_000);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            id: 100, userId: 7, shipId: 10, customName: 'Big Bertha', loadoutNotes: 'stock',
            status: ShipStatus.Stored, isPrimary: true, createdAt: '2026-02-01T00:00:00Z',
        });
        expect(out[0].user).toMatchObject({ id: 7 });
        expect(out[0].ship).toMatchObject({ id: 10, name: 'Ironclad' });
        expect(out[0].assignmentId).toBeUndefined();
    });

    it('getUserShips fails soft to [] on any read error, logging loudly for a real fault', async () => {
        route('user_ships:select', { error: { code: 'PGRST205', message: 'relation not in cache' } });
        await expect(getUserShips()).resolves.toEqual([]);
        expect(logged('warn', 'safeFetch returning fallback')?.fields).toMatchObject({ target: 'Failed to get user ships', code: 'PGRST205' });
        expect(logged('error', 'safeFetch DB error')).toBeUndefined();

        // A real fault never hands a partial/raw row set to the caller: the
        // fallback is the empty list, and the fault is logged at error level.
        route('user_ships:select', { error: DB_ERR });
        await expect(getUserShips()).resolves.toEqual([]);
        expect(logged('error', 'safeFetch DB error')?.fields).toMatchObject({ target: 'Failed to get user ships', code: '42501' });

        route('user_ships:select', { data: null });
        await expect(getUserShips()).resolves.toEqual([]);
    });

    it('getUserShipsByUserIds short-circuits on an empty id list', async () => {
        await expect(getUserShipsByUserIds([])).resolves.toEqual([]);
        expect(sb.queries).toEqual([]);
    });

    it('getUserShipsByUserIds filters to the requested owners, newest first', async () => {
        route('user_ships:select', { data: [userShipRow({ user_id: 3 })] });
        const out = await getUserShipsByUserIds([3, 4]);
        const [q] = queriesFor('user_ships', 'select');
        expect(q.filters).toEqual([['in', 'user_id', [3, 4]]]);
        expect(q.orders).toEqual([['created_at', { ascending: false }]]);
        expect(q.columns).toContain('user:users!user_ships_user_id_fkey(id, name, avatar_url, rsi_handle, role_id)');
        expect(out.map((s) => s.userId)).toEqual([3]);
    });

    it('getUserShipsByUserIds throws on a read error and returns [] on null data', async () => {
        route('user_ships:select', { data: null });
        await expect(getUserShipsByUserIds([1])).resolves.toEqual([]);
        route('user_ships:select', { error: DB_ERR });
        await expect(getUserShipsByUserIds([1])).rejects.toThrow('Failed to get user ships by user IDs');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('hangar writes', () => {
    it('addUserShip inserts the row for the given owner and broadcasts both hangar slices', async () => {
        await addUserShip(7, 10, 'Bertha', 'notes');
        expect(queriesFor('user_ships', 'insert')[0].payload).toEqual({ user_id: 7, ship_id: 10, custom_name: 'Bertha', loadout_notes: 'notes' });
        // groups re-embed user_ship rows, so BOTH slices must be refetched.
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('user_ships', 'groups'));
    });

    it('addUserShip throws and does not broadcast on an insert error', async () => {
        route('user_ships:insert', { error: DB_ERR });
        await expect(addUserShip(7, 10, null, null)).rejects.toThrow('Failed to add ship to hangar');
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('addUserShips counts the CALLER\'s hangar, allows exactly the ceiling, and inserts one row per id', async () => {
        route('user_ships:select', { count: 998 });
        await addUserShips(7, [10, 11]);
        const [probe] = queriesFor('user_ships', 'select');
        expect(probe.selectOpts).toEqual({ count: 'exact', head: true });
        expect(probe.filters).toEqual([['eq', 'user_id', 7]]);
        expect(queriesFor('user_ships', 'insert')[0].payload).toEqual([{ user_id: 7, ship_id: 10 }, { user_id: 7, ship_id: 11 }]);
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('user_ships', 'groups'));
    });

    it('addUserShips refuses one past the ceiling and a non-array payload is a no-op', async () => {
        route('user_ships:select', { count: 999 });
        await expect(addUserShips(7, [10, 11])).rejects.toThrow('Hangar limit reached (max 1000 ships).');
        expect(queriesFor('user_ships', 'insert')).toEqual([]);

        await addUserShips(7, 'nope' as unknown as number[]);
        expect(queriesFor('user_ships', 'insert')).toEqual([]);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('addUserShips refuses an over-sized batch before even counting the hangar', async () => {
        await expect(addUserShips(7, Array.from({ length: 101 }, (_, i) => i))).rejects.toThrow('Too many ships in one request (max 100).');
        expect(sb.queries).toEqual([]);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('addUserShips surfaces an insert error', async () => {
        route('user_ships:select', { count: null });
        route('user_ships:insert', { error: DB_ERR });
        await expect(addUserShips(7, [1])).rejects.toThrow('Failed to add ships to hangar');
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('updateUserShip scopes the write to the actor\'s own row when an actor is given', async () => {
        await updateUserShip(100, { customName: 'X', loadoutNotes: null, status: ShipStatus.Damaged, isPrimary: false }, 7);
        const [q] = queriesFor('user_ships', 'update');
        expect(q.payload).toEqual({ custom_name: 'X', loadout_notes: null, status: 'Damaged', is_primary: false });
        expect(q.filters).toEqual([['eq', 'id', 100], ['eq', 'user_id', 7]]);
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('user_ships', 'groups'));
    });

    it('updateUserShip without an actor (manager) is org-wide and only writes provided fields', async () => {
        await updateUserShip(100, { status: ShipStatus.Lent });
        const [q] = queriesFor('user_ships', 'update');
        expect(q.payload).toEqual({ status: 'Lent' });
        expect(q.filters).toEqual([['eq', 'id', 100]]);
    });

    it('updateUserShip throws and does not broadcast on a write error', async () => {
        route('user_ships:update', { error: DB_ERR });
        await expect(updateUserShip(100, { customName: 'X' }, 7)).rejects.toThrow('Failed to update ship');
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('removeUserShip adds the ownership filter for an actor and omits it for a manager', async () => {
        await removeUserShip(100, 7);
        await removeUserShip(101);
        const [own, mgr] = queriesFor('user_ships', 'delete');
        expect(own.filters).toEqual([['eq', 'id', 100], ['eq', 'user_id', 7]]);
        expect(mgr.filters).toEqual([['eq', 'id', 101]]);
        expect(broadcast).toHaveBeenCalledTimes(2);
        expect(broadcast).toHaveBeenLastCalledWith(...fleetUpdate('user_ships', 'groups'));
    });

    it('removeUserShip surfaces a delete error', async () => {
        route('user_ships:delete', { error: DB_ERR });
        await expect(removeUserShip(100, 7)).rejects.toThrow('Failed to remove ship');
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('removeUserShips bulk-deletes by id, ownership-scoped for an actor', async () => {
        await removeUserShips([1, 2], 7);
        await removeUserShips([3]);
        const [own, mgr] = queriesFor('user_ships', 'delete');
        expect(own.filters).toEqual([['in', 'id', [1, 2]], ['eq', 'user_id', 7]]);
        expect(mgr.filters).toEqual([['in', 'id', [3]]]);
        expect(broadcast).toHaveBeenLastCalledWith(...fleetUpdate('user_ships', 'groups'));
    });

    it('removeUserShips surfaces a delete error', async () => {
        route('user_ships:delete', { error: DB_ERR });
        await expect(removeUserShips([1], 7)).rejects.toThrow('Failed to remove ships');
        expect(broadcast).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getFleetGroups', () => {
    it('hydrates each group with its junction-ordered ships, carrying the assignment id', async () => {
        route('fleet_groups:select', { data: [groupRow(), groupRow({ id: 2, name: 'Bravo', type: null, parent_id: 1, commander_id: null, commander: null, sort_order: null })] });
        route('fleet_group_ships:select', { data: [
            { id: 501, fleet_group_id: 1, sort_order: 10, user_ship: userShipRow({ id: 100 }) },
            { id: 502, fleet_group_id: 1, sort_order: 20, user_ship: null }, // dangling junction row
            { id: 503, fleet_group_id: 1, sort_order: 30, user_ship: userShipRow({ id: 101 }) },
        ] });

        const out = await getFleetGroups();

        const [gq] = queriesFor('fleet_groups', 'select');
        expect(gq.columns).toContain('commander:users!fleet_groups_commander_id_fkey(id, name, avatar_url, rsi_handle, role_id)');
        expect(gq.orders).toEqual([['sort_order', { ascending: true }]]);
        const [aq] = queriesFor('fleet_group_ships', 'select');
        expect(filterValue(aq, 'in', 'fleet_group_id')).toEqual([1, 2]);
        expect(aq.orders).toEqual([['sort_order', { ascending: true }]]);
        expect(aq.columns).toContain('user:users!user_ships_user_id_fkey(id, name, avatar_url, rsi_handle, role_id)');

        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ id: 1, name: 'Alpha Wing', type: FleetGroupType.Wing, commanderId: 7, sortOrder: 10, children: [] });
        expect(out[0].commander).toMatchObject({ id: 7 });
        expect(out[0].assignedShips.map((s) => [s.id, s.assignmentId])).toEqual([[100, 501], [101, 503]]);
        expect(out[1]).toMatchObject({ id: 2, type: FleetGroupType.Custom, parentId: 1, commanderId: undefined, sortOrder: 0, assignedShips: [] });
    });

    it('skips the assignment read when there are no groups', async () => {
        route('fleet_groups:select', { data: [] });
        await expect(getFleetGroups()).resolves.toEqual([]);
        expect(queriesFor('fleet_group_ships')).toEqual([]);
    });

    it('a null assignment read leaves every group empty', async () => {
        route('fleet_groups:select', { data: [groupRow()] });
        route('fleet_group_ships:select', { data: null });
        const out = await getFleetGroups();
        expect(out[0].assignedShips).toEqual([]);
    });

    it('fails soft to [] on a read error without issuing the assignment read', async () => {
        route('fleet_groups:select', { error: { code: 'PGRST200', message: 'no relationship' } });
        await expect(getFleetGroups()).resolves.toEqual([]);
        route('fleet_groups:select', { error: DB_ERR });
        await expect(getFleetGroups()).resolves.toEqual([]);
        expect(logged('error', 'safeFetch DB error')?.fields).toMatchObject({ target: 'Failed to get fleet groups', code: '42501' });
        expect(queriesFor('fleet_group_ships')).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('fleet group writes', () => {
    it('createFleetGroup applies defaults for every optional field', async () => {
        await createFleetGroup({ name: 'Ops', parentId: 0, commanderId: undefined });
        expect(queriesFor('fleet_groups', 'insert')[0].payload).toEqual({
            name: 'Ops', type: 'Custom', parent_id: null, commander_id: null, description: null, icon: null, sort_order: 0,
        });
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('groups'));
    });

    it('createFleetGroup passes provided fields through', async () => {
        await createFleetGroup({ name: 'Ops', type: 'Squadron', parentId: 3, commanderId: 7, description: 'D', icon: 'I', sortOrder: 40 });
        expect(queriesFor('fleet_groups', 'insert')[0].payload).toEqual({
            name: 'Ops', type: 'Squadron', parent_id: 3, commander_id: 7, description: 'D', icon: 'I', sort_order: 40,
        });
    });

    it('createFleetGroup surfaces an insert error', async () => {
        route('fleet_groups:insert', { error: DB_ERR });
        await expect(createFleetGroup({ name: 'x' })).rejects.toThrow('Failed to create fleet group');
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('updateFleetGroup writes only provided fields and normalises falsy FKs to null', async () => {
        await updateFleetGroup(4, { name: 'N', type: 'Wing', parentId: 0, commanderId: null, description: 'd', icon: 'i', sortOrder: 0 });
        await updateFleetGroup(5, { parentId: 2, commanderId: 9 });
        await updateFleetGroup(6, {});
        const [a, b, c] = queriesFor('fleet_groups', 'update');
        expect(a.payload).toEqual({ name: 'N', type: 'Wing', parent_id: null, commander_id: null, description: 'd', icon: 'i', sort_order: 0 });
        expect(a.filters).toEqual([['eq', 'id', 4]]);
        expect(b.payload).toEqual({ parent_id: 2, commander_id: 9 });
        expect(c.payload).toEqual({});
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('groups'));
    });

    it('updateFleetGroup surfaces a write error', async () => {
        route('fleet_groups:update', { error: DB_ERR });
        await expect(updateFleetGroup(4, { name: 'N' })).rejects.toThrow('Failed to update fleet group');
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('deleteFleetGroup refuses an unknown group before any write', async () => {
        route('fleet_groups:select', { data: null });
        await expect(deleteFleetGroup(4)).rejects.toThrow('Fleet group not found');
        expect(queriesFor('fleet_groups', 'update')).toEqual([]);
        expect(queriesFor('fleet_groups', 'delete')).toEqual([]);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('deleteFleetGroup promotes children one level up, then deletes the group', async () => {
        route('fleet_groups:select', { data: { id: 4, parent_id: 2 } });
        await deleteFleetGroup(4);
        const [probe] = queriesFor('fleet_groups', 'select');
        expect(probe.columns).toBe('id, parent_id');
        expect(probe.terminal).toBe('maybeSingle');
        expect(sb.queries.slice(1).map((q) => [q.verb, q.payload, q.filters])).toEqual([
            ['update', { parent_id: 2 }, [['eq', 'parent_id', 4]]],
            ['delete', undefined, [['eq', 'id', 4]]],
        ]);
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('groups'));
    });

    it('deleteFleetGroup does not delete when the child reparent fails', async () => {
        route('fleet_groups:select', { data: { id: 4, parent_id: null } });
        route('fleet_groups:update', { error: DB_ERR });
        await expect(deleteFleetGroup(4)).rejects.toThrow('Failed to reparent child fleet groups');
        expect(queriesFor('fleet_groups', 'delete')).toEqual([]);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('deleteFleetGroup surfaces a delete error', async () => {
        route('fleet_groups:select', { data: { id: 4, parent_id: null } });
        route('fleet_groups:delete', { error: DB_ERR });
        await expect(deleteFleetGroup(4)).rejects.toThrow('Failed to delete fleet group');
        expect(broadcast).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('group ship assignment', () => {
    it('assignShipToGroup verifies both rows exist, then links them', async () => {
        route('fleet_groups:select', { data: { id: 1 } });
        route('user_ships:select', { data: { id: 100 } });
        await assignShipToGroup(1, 100);
        expect(queriesFor('fleet_groups', 'select')[0].filters).toEqual([['eq', 'id', 1]]);
        expect(queriesFor('user_ships', 'select')[0].filters).toEqual([['eq', 'id', 100]]);
        expect(queriesFor('fleet_group_ships', 'insert')[0].payload).toEqual({ fleet_group_id: 1, user_ship_id: 100 });
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('groups'));
    });

    it('assignShipToGroup refuses an unknown group or ship without inserting', async () => {
        route('fleet_groups:select', { data: null });
        route('user_ships:select', { data: { id: 100 } });
        await expect(assignShipToGroup(1, 100)).rejects.toThrow('Fleet group not found');

        route('fleet_groups:select', { data: { id: 1 } });
        route('user_ships:select', { data: null });
        await expect(assignShipToGroup(1, 100)).rejects.toThrow('Ship not found');

        expect(queriesFor('fleet_group_ships')).toEqual([]);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('assignShipToGroup surfaces an insert error', async () => {
        route('fleet_groups:select', { data: { id: 1 } });
        route('user_ships:select', { data: { id: 100 } });
        route('fleet_group_ships:insert', { error: DB_ERR });
        await expect(assignShipToGroup(1, 100)).rejects.toThrow('Failed to assign ship to group');
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('removeShipFromGroup checks the group, then deletes the exact junction row', async () => {
        route('fleet_groups:select', { data: { id: 1 } });
        await removeShipFromGroup(1, 100);
        expect(queriesFor('fleet_group_ships', 'delete')[0].filters).toEqual([['eq', 'fleet_group_id', 1], ['eq', 'user_ship_id', 100]]);
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('groups'));
    });

    it('removeShipFromGroup refuses an unknown group and surfaces a delete error', async () => {
        route('fleet_groups:select', { data: null });
        await expect(removeShipFromGroup(1, 100)).rejects.toThrow('Fleet group not found');
        expect(queriesFor('fleet_group_ships')).toEqual([]);

        route('fleet_groups:select', { data: { id: 1 } });
        route('fleet_group_ships:delete', { error: DB_ERR });
        await expect(removeShipFromGroup(1, 100)).rejects.toThrow('Failed to remove ship from group');
        expect(broadcast).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('manual ordering', () => {
    it('reorderFleetGroups is a no-op for an empty list', async () => {
        await reorderFleetGroups([]);
        expect(sb.queries).toEqual([]);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('reorderFleetGroups spaces sort_order by 10 in the given order and broadcasts once', async () => {
        await reorderFleetGroups([7, 3, 5]);
        expect(queriesFor('fleet_groups', 'update').map((q) => [filterValue(q, 'eq', 'id'), q.payload]))
            .toEqual([[7, { sort_order: 10 }], [3, { sort_order: 20 }], [5, { sort_order: 30 }]]);
        expect(broadcast).toHaveBeenCalledTimes(1);
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('groups'));
    });

    it('reorderFleetGroups throws if any single update failed', async () => {
        route('fleet_groups:update', (q: Q) => (filterValue(q, 'eq', 'id') === 3 ? { error: DB_ERR } : {}));
        await expect(reorderFleetGroups([7, 3])).rejects.toThrow('Failed to reorder fleet groups');
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('reorderGroupShips is a no-op for an empty list (no existence probe either)', async () => {
        await reorderGroupShips(1, []);
        expect(sb.queries).toEqual([]);
    });

    it('reorderGroupShips refuses an unknown group before writing', async () => {
        route('fleet_groups:select', { data: null });
        await expect(reorderGroupShips(1, [501])).rejects.toThrow('Fleet group not found');
        expect(queriesFor('fleet_group_ships')).toEqual([]);
    });

    it('reorderGroupShips scopes every junction update to the named group', async () => {
        route('fleet_groups:select', { data: { id: 1 } });
        await reorderGroupShips(1, [503, 501]);
        expect(queriesFor('fleet_group_ships', 'update').map((q) => [q.payload, q.filters])).toEqual([
            [{ sort_order: 10 }, [['eq', 'id', 503], ['eq', 'fleet_group_id', 1]]],
            [{ sort_order: 20 }, [['eq', 'id', 501], ['eq', 'fleet_group_id', 1]]],
        ]);
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('groups'));
    });

    it('reorderGroupShips surfaces a failed update', async () => {
        route('fleet_groups:select', { data: { id: 1 } });
        route('fleet_group_ships:update', { error: DB_ERR });
        await expect(reorderGroupShips(1, [501])).rejects.toThrow('Failed to reorder group ships');
        expect(broadcast).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reparentFleetGroup', () => {
    it('rejects making a group its own parent before touching the DB', async () => {
        await expect(reparentFleetGroup(3, 3, 10)).rejects.toThrow('A fleet group cannot be its own parent.');
        expect(sb.queries).toEqual([]);
    });

    it('rejects a move beneath one of the group\'s own descendants', async () => {
        // 1 ← 2 ← 3 : moving 1 under 3 would close a cycle.
        route('fleet_groups:select', { data: [{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }] });
        await expect(reparentFleetGroup(1, 3, 10)).rejects.toThrow('Cannot move a group beneath one of its descendants.');
        expect(queriesFor('fleet_groups', 'select')[0].columns).toBe('id, parent_id');
        expect(queriesFor('fleet_groups', 'update')).toEqual([]);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('allows a legal move and writes the new parent + sort order', async () => {
        route('fleet_groups:select', { data: [{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: null }] });
        await reparentFleetGroup(3, 2, 25);
        const [u] = queriesFor('fleet_groups', 'update');
        expect(u.payload).toEqual({ parent_id: 2, sort_order: 25 });
        expect(u.filters).toEqual([['eq', 'id', 3]]);
        expect(broadcast).toHaveBeenCalledWith(...fleetUpdate('groups'));
    });

    it('terminates on a pre-existing cycle in the data rather than looping', async () => {
        // 5 ↔ 6 already form a loop that does not include the moved group.
        route('fleet_groups:select', { data: [{ id: 5, parent_id: 6 }, { id: 6, parent_id: 5 }, { id: 9, parent_id: null }] });
        await reparentFleetGroup(9, 5, 0);
        expect(queriesFor('fleet_groups', 'update')[0].payload).toEqual({ parent_id: 5, sort_order: 0 });
    });

    it('a move to the root skips the ancestry walk; a null group read is treated as no ancestry', async () => {
        await reparentFleetGroup(3, null, 5);
        expect(queriesFor('fleet_groups', 'select')).toEqual([]);
        expect(queriesFor('fleet_groups', 'update')[0].payload).toEqual({ parent_id: null, sort_order: 5 });

        route('fleet_groups:select', { data: null });
        await reparentFleetGroup(3, 8, 5);
        expect(queriesFor('fleet_groups', 'update')[1].payload).toEqual({ parent_id: 8, sort_order: 5 });
    });

    it('surfaces a write error', async () => {
        route('fleet_groups:update', { error: DB_ERR });
        await expect(reparentFleetGroup(3, null, 5)).rejects.toThrow('Failed to reparent fleet group');
        expect(broadcast).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getFleetState', () => {
    it('combines the catalog, hangars and groups into one bundle', async () => {
        route('platform_ships:select', { data: [shipRow()] });
        route('user_ships:select', { data: [userShipRow()] });
        route('fleet_groups:select', { data: [] });
        const out = await getFleetState();
        expect(out.shipCatalog.map((s) => s.id)).toEqual([10]);
        expect(out.userShips.map((s) => s.id)).toEqual([100]);
        expect(out.fleetGroups).toEqual([]);
        expect(new Set(sb.queries.map((q) => q.table))).toEqual(new Set(['platform_ships', 'user_ships', 'fleet_groups']));
    });

    it('rejects if the catalog read fails', async () => {
        route('platform_ships:select', { error: DB_ERR });
        await expect(getFleetState()).rejects.toThrow('Failed to get ship catalog');
    });
});
