import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/locations.ts — the UEX-sourced platform location catalog.
//   Read paths:   admin listing (filters, search allow-list, pagination clamps), per-kind
//                 head counts, and the TENANT-facing search, which must never surface
//                 internal scaffolding (orbits) or admin-hidden rows.
//   Mutations:    admin update strips every UEX-owned column; delete refuses while any
//                 child row still references the location, and fails closed when it
//                 cannot count them.
//   Sync:         the multi-pass upsert runs against an in-memory platform_locations
//                 table here, so parent resolution, admin-edit preservation, batching,
//                 per-row fallback, pagination and path recomputation are all observed
//                 end to end rather than asserted against a canned chain.

type Row = Record<string, unknown> & { id: number; kind: string; external_id: number };

const h = vi.hoisted(() => {
    type Call = { m: string; a: unknown[] };
    type Q = { table: string; calls: Call[] };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
    const state = {
        queries: [] as Q[],
        respond: ((_q: Q) => ({ data: null, error: null })) as (q: Q) => unknown,
    };
    function from(table: string) {
        const q: Q = { table, calls: [] };
        state.queries.push(q);
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'or', 'order', 'range', 'limit', 'update', 'upsert', 'delete']) {
            b[m] = (...a: unknown[]) => { q.calls.push({ m, a }); return b; };
        }
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve().then(() => state.respond(q)).then(res, rej);
        return b;
    }
    const uex = {
        systems: [] as unknown[], orbits: [] as unknown[], planets: [] as unknown[], moons: [] as unknown[],
        stations: [] as unknown[], cities: [] as unknown[], outposts: [] as unknown[], pois: [] as unknown[],
        calls: [] as string[],
        orbitsError: null as Error | null,
    };
    const fetcher = (name: string, key: keyof typeof uex) => async () => {
        uex.calls.push(name);
        if (name === 'orbits' && uex.orbitsError) throw uex.orbitsError;
        return uex[key];
    };
    return { state, logger, from, uex, fetcher };
});

vi.mock('../lib/db/common', () => ({
    supabase: { from: h.from },
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
        if (error) throw new Error(message);
    },
}));
vi.mock('../lib/log', () => ({ log: h.logger }));
vi.mock('../lib/db/uex', () => ({
    fetchUexStarSystems: h.fetcher('systems', 'systems'),
    fetchUexOrbits: h.fetcher('orbits', 'orbits'),
    fetchUexPlanets: h.fetcher('planets', 'planets'),
    fetchUexMoons: h.fetcher('moons', 'moons'),
    fetchUexSpaceStations: h.fetcher('stations', 'stations'),
    fetchUexCities: h.fetcher('cities', 'cities'),
    fetchUexOutposts: h.fetcher('outposts', 'outposts'),
    fetchUexPois: h.fetcher('pois', 'pois'),
}));

import {
    getPlatformLocations, getPlatformLocationCount, searchPlatformLocations,
    updatePlatformLocation, deletePlatformLocation, syncPlatformLocations,
} from '../lib/db/locations';

type Q = { table: string; calls: Array<{ m: string; a: unknown[] }> };
const has = (q: Q, m: string) => q.calls.some((c) => c.m === m);
const arg = (q: Q, m: string, i = 0) => q.calls.find((c) => c.m === m)?.a[i];
const all = (q: Q, m: string) => q.calls.filter((c) => c.m === m).map((c) => c.a);

const LIST_COLUMNS = 'id, kind, external_id, parent_id, star_system_id, name, nickname, code, path, is_available_live, is_visible, is_landable, is_armistice, is_decommissioned, is_internal, is_hidden, pad_types, amenities, faction_name, jurisdiction_name, wiki_url, uex_date_added, uex_date_modified, last_synced_at, created_at, updated_at';
const LOOKUP_COLUMNS = 'id, kind, external_id, nickname, is_hidden, is_internal, wiki_url';

const dbRow = (over: Partial<Row> = {}): Row => ({
    id: 1, kind: 'city', external_id: 40, parent_id: 5, star_system_id: 2, name: 'Orison', nickname: null,
    code: 'ORI', path: 'Stanton > Crusader > Orison', is_available_live: true, is_visible: true, is_landable: true,
    is_armistice: true, is_decommissioned: false, is_internal: false, is_hidden: false, pad_types: 'S,M',
    amenities: { refuel: true }, faction_name: 'UEE', jurisdiction_name: 'UEE', wiki_url: null,
    uex_date_added: 1, uex_date_modified: 2, last_synced_at: 'ls', created_at: 'c', updated_at: 'u', ...over,
});

beforeEach(() => {
    h.state.queries = [];
    h.state.respond = () => ({ data: null, error: null });
    for (const k of ['systems', 'orbits', 'planets', 'moons', 'stations', 'cities', 'outposts', 'pois'] as const) h.uex[k] = [];
    h.uex.calls = [];
    h.uex.orbitsError = null;
    h.logger.info.mockClear();
});

// ===========================================================================
describe('getPlatformLocations (admin listing)', () => {
    it('defaults: explicit columns, hides internal + hidden + decommissioned rows, stable order, first 200', async () => {
        h.state.respond = () => ({ data: [dbRow()], error: null });
        const out = await getPlatformLocations();
        const q = h.state.queries[0];
        expect(q.table).toBe('platform_locations');
        expect(q.calls).toEqual([
            { m: 'select', a: [LIST_COLUMNS] },
            { m: 'eq', a: ['is_internal', false] },
            { m: 'eq', a: ['is_hidden', false] },
            { m: 'or', a: ['is_decommissioned.is.null,is_decommissioned.eq.false'] },
            { m: 'order', a: ['kind'] },
            { m: 'order', a: ['name'] },
            { m: 'order', a: ['id', { ascending: true }] },
            { m: 'range', a: [0, 199] },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual(expect.objectContaining({
            id: 1, kind: 'city', externalId: 40, parentId: 5, starSystemId: 2, name: 'Orison', path: 'Stanton > Crusader > Orison',
            isInternal: false, isHidden: false, amenities: { refuel: true }, padTypes: 'S,M',
        }));
    });

    it('kind / system filters and include* flags shape the query', async () => {
        h.state.respond = () => ({ data: [], error: null });
        await getPlatformLocations({
            kind: 'moon', starSystemId: 3, includeInternal: true, includeHidden: true, includeDecommissioned: true,
            limit: 10, offset: 20,
        });
        expect(h.state.queries[0].calls.slice(1)).toEqual([
            { m: 'eq', a: ['kind', 'moon'] },
            { m: 'eq', a: ['star_system_id', 3] },
            { m: 'order', a: ['kind'] },
            { m: 'order', a: ['name'] },
            { m: 'order', a: ['id', { ascending: true }] },
            { m: 'range', a: [20, 29] },
        ]);
    });

    it('clamps limit to [1,2000] and offset to [0,100000]', async () => {
        h.state.respond = () => ({ data: [], error: null });
        await getPlatformLocations({ limit: 99_999, offset: -5 });
        await getPlatformLocations({ limit: 0, offset: 5_000_000 });
        await getPlatformLocations({ offset: Number.NaN });
        expect(h.state.queries.map((q) => arg(q, 'range', 0))).toEqual([0, 100_000, 0]);
        expect(h.state.queries.map((q) => arg(q, 'range', 1))).toEqual([1999, 100_000, 199]);
    });

    it('allow-lists the search term before it enters the .or() grammar', async () => {
        h.state.respond = () => ({ data: [], error: null });
        await getPlatformLocations({ search: '  Port),is_hidden.eq.true,(name.ilike.%  ' });
        const ors = all(h.state.queries[0], 'or').map((a) => a[0]);
        expect(ors[1]).toBe('name.ilike.%Portis_hiddeneqtruenameilike%,path.ilike.%Portis_hiddeneqtruenameilike%,nickname.ilike.%Portis_hiddeneqtruenameilike%');
        expect(ors[1]).not.toMatch(/[(),.]is_hidden/);
    });

    it('a search that is blank, or empty after the allow-list, adds no search filter', async () => {
        h.state.respond = () => ({ data: [], error: null });
        await getPlatformLocations({ search: '   ' });
        await getPlatformLocations({ search: '%%(),.' });
        for (const q of h.state.queries) expect(all(q, 'or')).toHaveLength(1); // only the decommissioned filter
    });

    it('a missing table (42P01) yields an empty list; any other error throws', async () => {
        h.state.respond = () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
        expect(await getPlatformLocations()).toEqual([]);
        h.state.respond = () => ({ data: null, error: { code: '57014', message: 'timeout' } });
        await expect(getPlatformLocations()).rejects.toThrow('Failed to load platform locations');
    });

    it('null data maps to an empty list', async () => {
        h.state.respond = () => ({ data: null, error: null });
        expect(await getPlatformLocations()).toEqual([]);
    });
});

// ===========================================================================
describe('getPlatformLocationCount', () => {
    const KINDS = ['star_system', 'orbit', 'planet', 'moon', 'space_station', 'city', 'outpost', 'poi'];

    it('issues one head-only count per kind (no row payloads) and sums them', async () => {
        const counts: Record<string, number | null> = { star_system: 3, orbit: 10, planet: 12, moon: 20, space_station: 30, city: 4, outpost: 50, poi: null };
        h.state.respond = (q) => ({ count: counts[arg(q, 'eq', 1) as string], error: null });
        const res = await getPlatformLocationCount();
        expect(h.state.queries.map((q) => q.calls)).toEqual(KINDS.map((k) => [
            { m: 'select', a: ['id', { count: 'exact', head: true }] },
            { m: 'eq', a: ['kind', k] },
        ]));
        expect(res).toEqual({
            total: 129,
            perKind: { star_system: 3, orbit: 10, planet: 12, moon: 20, space_station: 30, city: 4, outpost: 50, poi: 0 },
        });
    });

    it('a missing table or a per-kind error counts that kind as 0 instead of failing the panel', async () => {
        h.state.respond = (q) => {
            const k = arg(q, 'eq', 1);
            if (k === 'planet') return { count: 99, error: { code: '42P01' } };
            if (k === 'moon') return { count: 99, error: { code: '57014' } };
            return { count: 1, error: null };
        };
        const res = await getPlatformLocationCount();
        expect(res.perKind.planet).toBe(0);
        expect(res.perKind.moon).toBe(0);
        expect(res.total).toBe(6);
    });
});

// ===========================================================================
describe('searchPlatformLocations (tenant-facing)', () => {
    it.each([[''], ['   '], [undefined]])('a blank query (%j) returns [] without a query', async (query) => {
        expect(await searchPlatformLocations({ query: query as unknown as string })).toEqual([]);
        expect(h.state.queries).toEqual([]);
    });

    it('a query that is empty after the allow-list returns [] without a query', async () => {
        expect(await searchPlatformLocations({ query: '%(),.*' })).toEqual([]);
        expect(h.state.queries).toEqual([]);
    });

    it('ALWAYS excludes internal scaffolding and admin-hidden rows, and caps at 50 by default', async () => {
        h.state.respond = () => ({ data: [dbRow({ id: 9, name: 'Port Olisar' })], error: null });
        const out = await searchPlatformLocations({ query: ' Port ' });
        expect(h.state.queries[0].calls).toEqual([
            { m: 'select', a: [LIST_COLUMNS] },
            { m: 'eq', a: ['is_internal', false] },
            { m: 'eq', a: ['is_hidden', false] },
            { m: 'or', a: ['name.ilike.%Port%,path.ilike.%Port%,nickname.ilike.%Port%'] },
            { m: 'order', a: ['name'] },
            { m: 'order', a: ['id', { ascending: true }] },
            { m: 'limit', a: [50] },
        ]);
        expect(out.map((l) => l.id)).toEqual([9]);
    });

    it('optional kind / system filters and a [1,200] limit clamp', async () => {
        h.state.respond = () => ({ data: [], error: null });
        await searchPlatformLocations({ query: 'a', kind: 'city', starSystemId: 7, limit: 1000 });
        await searchPlatformLocations({ query: 'a', limit: -3 });
        const [first, second] = h.state.queries;
        expect(first.calls).toContainEqual({ m: 'eq', a: ['kind', 'city'] });
        expect(first.calls).toContainEqual({ m: 'eq', a: ['star_system_id', 7] });
        expect(arg(first, 'limit')).toBe(200);
        expect(arg(second, 'limit')).toBe(1);
        expect(second.calls.some((c) => c.m === 'eq' && c.a[0] === 'kind')).toBe(false);
    });

    it('a missing table yields []; any other error throws; null data maps to []', async () => {
        h.state.respond = () => ({ data: null, error: { code: '42P01' } });
        expect(await searchPlatformLocations({ query: 'x' })).toEqual([]);
        h.state.respond = () => ({ data: null, error: null });
        expect(await searchPlatformLocations({ query: 'x' })).toEqual([]);
        h.state.respond = () => ({ data: null, error: { code: 'XX000' } });
        await expect(searchPlatformLocations({ query: 'x' })).rejects.toThrow('Failed to search platform locations');
    });
});

// ===========================================================================
describe('updatePlatformLocation (admin)', () => {
    it('strips every UEX-owned column and stamps updated_at; only admin-editable fields are written', async () => {
        h.state.respond = () => ({ error: null });
        await updatePlatformLocation(12, {
            id: 99, kind: 'poi', external_id: 1, parent_id: 2, star_system_id: 3, name: 'Renamed', code: 'X', path: 'p',
            amenities: {}, pad_types: 'L', is_available_live: false, is_visible: false, is_landable: false,
            is_armistice: false, is_decommissioned: true, faction_name: 'f', jurisdiction_name: 'j',
            last_synced_at: 'x', created_at: 'x', uex_date_added: 1, uex_date_modified: 2,
            nickname: 'Admin nick', is_hidden: true, is_internal: true, wiki_url: 'https://wiki.example/x',
        } as never);
        const q = h.state.queries[0];
        expect(q.table).toBe('platform_locations');
        const patch = arg(q, 'update') as Record<string, unknown>;
        expect(Object.keys(patch).sort()).toEqual(['is_hidden', 'is_internal', 'nickname', 'updated_at', 'wiki_url']);
        expect(patch).toEqual(expect.objectContaining({ nickname: 'Admin nick', is_hidden: true, is_internal: true, wiki_url: 'https://wiki.example/x' }));
        expect(Number.isNaN(Date.parse(patch.updated_at as string))).toBe(false);
        expect(all(q, 'eq')).toEqual([['id', 12]]);
    });

    it('a patch made only of protected fields is refused before any query', async () => {
        await expect(updatePlatformLocation(12, { name: 'x', kind: 'poi' } as never)).rejects.toThrow('No updatable fields provided');
        await expect(updatePlatformLocation(12, {} as never)).rejects.toThrow('No updatable fields provided');
        expect(h.state.queries).toEqual([]);
    });

    it('a write error throws', async () => {
        h.state.respond = () => ({ error: { message: 'boom' } });
        await expect(updatePlatformLocation(1, { nickname: 'n' } as never)).rejects.toThrow('Failed to update platform location');
    });
});

// ===========================================================================
describe('deletePlatformLocation (admin)', () => {
    const deletes = () => h.state.queries.filter((q) => has(q, 'delete'));

    it('counts children head-only, then deletes by id when there are none', async () => {
        h.state.respond = (q) => has(q as Q, 'delete') ? { error: null } : { count: 0, error: null };
        await deletePlatformLocation(33);
        expect(h.state.queries[0].calls).toEqual([
            { m: 'select', a: ['id', { count: 'exact', head: true }] },
            { m: 'eq', a: ['parent_id', 33] },
        ]);
        expect(deletes()).toHaveLength(1);
        expect(all(deletes()[0], 'eq')).toEqual([['id', 33]]);
    });

    it('a null count is treated as no children', async () => {
        h.state.respond = (q) => has(q as Q, 'delete') ? { error: null } : { count: null, error: null };
        await deletePlatformLocation(33);
        expect(deletes()).toHaveLength(1);
    });

    it('refuses while children still reference the location — nothing is deleted', async () => {
        h.state.respond = () => ({ count: 3, error: null });
        await expect(deletePlatformLocation(33)).rejects.toThrow(
            'Cannot delete: 3 child row(s) reference this location. Delete or repoint them first.',
        );
        expect(deletes()).toEqual([]);
    });

    it('a single referencing child is enough to refuse (boundary)', async () => {
        h.state.respond = () => ({ count: 1, error: null });
        await expect(deletePlatformLocation(33)).rejects.toThrow('Cannot delete: 1 child row(s) reference this location.');
        expect(deletes()).toEqual([]);
    });

    it('FAILS CLOSED when the child count cannot be read — nothing is deleted', async () => {
        h.state.respond = () => ({ count: null, error: { message: 'timeout' } });
        await expect(deletePlatformLocation(33)).rejects.toThrow('Failed to check children before delete');
        expect(deletes()).toEqual([]);
    });

    it('a delete error throws', async () => {
        h.state.respond = (q) => has(q as Q, 'delete') ? { error: { message: 'fk' } } : { count: 0, error: null };
        await expect(deletePlatformLocation(33)).rejects.toThrow('Failed to delete platform location');
    });
});

// ===========================================================================
// In-memory platform_locations for the sync engine.
// ===========================================================================
interface Db {
    rows: Row[];
    nextId: number;
    batchFails: (rows: Array<Record<string, unknown>>) => boolean;
    rowError: (row: Record<string, unknown>) => string | null;
    updateFails: (patch: Record<string, unknown>, id: number) => boolean;
    selectError: (cols: string, kind: string | undefined) => unknown;
    nullData: boolean;
}
let db: Db;

function memRespond(q: Q): unknown {
    if (q.table !== 'platform_locations') return { data: null, error: null };
    if (has(q, 'upsert')) {
        const payload = arg(q, 'upsert') as Record<string, unknown> | Array<Record<string, unknown>>;
        expect(arg(q, 'upsert', 1)).toEqual({ onConflict: 'kind,external_id' });
        const list = Array.isArray(payload) ? payload : [payload];
        if (Array.isArray(payload) && db.batchFails(list)) return { error: { message: 'batch rejected' } };
        if (!Array.isArray(payload)) {
            const msg = db.rowError(payload);
            if (msg) return { error: { message: msg } };
        }
        for (const r of list) {
            const existing = db.rows.find((x) => x.kind === r.kind && x.external_id === r.external_id);
            if (existing) Object.assign(existing, r);
            else db.rows.push({ ...(r as Row), id: db.nextId++ });
        }
        return { error: null };
    }
    if (has(q, 'update')) {
        const patch = arg(q, 'update') as Record<string, unknown>;
        const id = all(q, 'eq').find((a) => a[0] === 'id')![1] as number;
        if (db.updateFails(patch, id)) return { error: { message: 'update failed' } };
        const row = db.rows.find((x) => x.id === id);
        if (row) Object.assign(row, patch);
        return { error: null };
    }
    // select
    const cols = arg(q, 'select') as string;
    const kind = all(q, 'eq').find((a) => a[0] === 'kind')?.[1] as string | undefined;
    const err = db.selectError(cols, kind);
    if (err) return { data: null, error: err };
    if (db.nullData) return { data: null, error: null };
    const [from, to] = arg(q, 'range') !== undefined ? q.calls.find((c) => c.m === 'range')!.a as [number, number] : [0, Infinity];
    const picked = db.rows
        .filter((r) => kind === undefined || r.kind === kind)
        .sort((a, b) => a.id - b.id)
        .slice(from, to + 1)
        .map((r) => Object.fromEntries(cols.split(', ').map((c) => [c, r[c] ?? null])));
    return { data: picked, error: null };
}

const byKey = (kind: string, ext: number) => db.rows.find((r) => r.kind === kind && r.external_id === ext)!;
const upsertQueries = () => h.state.queries.filter((q) => has(q, 'upsert'));
const upsertPayloadFor = (kind: string, ext: number) => {
    for (const q of upsertQueries()) {
        const p = arg(q, 'upsert') as Record<string, unknown> | Array<Record<string, unknown>>;
        const hit = (Array.isArray(p) ? p : [p]).find((r) => r.kind === kind && r.external_id === ext);
        if (hit) return hit;
    }
    return undefined;
};

function loadUniverse() {
    h.uex.systems = [
        { id: 1, name: 'Stanton', code: 'ST', is_available_live: 1, is_visible: 1, wiki: 'https://wiki.example/stanton', faction_name: '<b>UEE</b>', jurisdiction_name: 'UEE  Jurisdiction', date_added: 100, date_modified: 200 },
        { id: 2, name: 'Pyro', is_available_live: 0 },
    ];
    h.uex.orbits = [
        { id: 10, id_star_system: 1, name: 'Crusader L1' },
        { id: 11, id_star_system: 99, name: 'Lost orbit' },             // unknown system
    ];
    h.uex.planets = [{ id: 20, id_star_system: 1, name: 'Crusader', code: 'CRU' }];
    h.uex.moons = [
        { id: 30, id_star_system: 1, id_planet: 20, id_orbit: 10, name: 'Yela' },     // planet beats orbit
        { id: 31, id_star_system: 1, id_planet: null, id_orbit: 10, name: 'OrbitMoon' },
        { id: 32, id_star_system: 1, id_planet: 999, name: 'Orphan moon' },            // unresolved → system
    ];
    h.uex.cities = [{
        id: 40, id_star_system: 1, id_moon: null, id_planet: 20, name: 'Orison', nickname: 'Cloud City', code: 'ORI',
        is_landable: 1, is_armistice: 1, is_decommissioned: 0, pad_types: 'S,M', has_refuel: 1, has_shops: 1, has_food: 0,
        wiki: 'https://wiki.example/orison',
    }];
    h.uex.stations = [
        { id: 50, id_star_system: 1, id_city: 40, id_moon: 30, name: 'Orison Platform' },  // city beats moon
        { id: 51, id_star_system: 1, id_moon: 30, name: '<i>GrimHEX</i>', nickname: 'Grim', has_docking_port: 1, has_freight_elevator: 1 },
    ];
    h.uex.outposts = [{ id: 60, id_star_system: 1, id_moon: 30, id_planet: 20, name: 'Yela Outpost', is_decommissioned: 1 }];
    h.uex.pois = [
        { id: 70, id_star_system: 1, id_outpost: 60, id_city: 40, id_space_station: 51, name: 'Outpost POI' },
        { id: 71, id_star_system: 1, id_space_station: 51, id_moon: 30, name: 'Station POI' },
        { id: 72, id_star_system: 2, name: 'Pyro POI' },
    ];
}

describe('syncPlatformLocations', () => {
    beforeEach(() => {
        db = {
            rows: [], nextId: 1,
            batchFails: () => false, rowError: () => null, updateFails: () => false, selectError: () => null,
            nullData: false,
        };
        h.state.respond = (q) => memRespond(q as Q);
    });

    it('syncs every kind in dependency order and resolves parents by priority', async () => {
        loadUniverse();
        const res = await syncPlatformLocations();

        // Cities sync BEFORE stations so a station→city parent resolves on the first sync.
        expect(h.uex.calls).toEqual(['systems', 'orbits', 'planets', 'moons', 'cities', 'stations', 'outposts', 'pois']);
        const upsertKinds = upsertQueries().map((q) => (arg(q, 'upsert') as Array<{ kind: string }>)[0].kind);
        expect(upsertKinds).toEqual(['star_system', 'orbit', 'planet', 'moon', 'city', 'space_station', 'outpost', 'poi']);

        const stanton = byKey('star_system', 1);
        const pyro = byKey('star_system', 2);
        // Star systems point at themselves so later passes resolve uniformly.
        expect(stanton.star_system_id).toBe(stanton.id);
        expect(pyro.star_system_id).toBe(pyro.id);

        expect(byKey('orbit', 10).parent_id).toBe(stanton.id);
        expect(byKey('orbit', 11)).toEqual(expect.objectContaining({ parent_id: null, star_system_id: null }));
        expect(byKey('planet', 20).parent_id).toBe(stanton.id);
        expect(byKey('moon', 30).parent_id).toBe(byKey('planet', 20).id);
        expect(byKey('moon', 31).parent_id).toBe(byKey('orbit', 10).id);
        expect(byKey('moon', 32).parent_id).toBe(stanton.id);
        expect(byKey('city', 40).parent_id).toBe(byKey('planet', 20).id);
        expect(byKey('space_station', 50).parent_id).toBe(byKey('city', 40).id);
        expect(byKey('space_station', 51).parent_id).toBe(byKey('moon', 30).id);
        expect(byKey('outpost', 60).parent_id).toBe(byKey('moon', 30).id);
        expect(byKey('poi', 70).parent_id).toBe(byKey('outpost', 60).id);
        expect(byKey('poi', 71).parent_id).toBe(byKey('space_station', 51).id);
        expect(byKey('poi', 72)).toEqual(expect.objectContaining({ parent_id: pyro.id, star_system_id: pyro.id }));
        for (const r of db.rows.filter((x) => x.kind !== 'star_system' && x.external_id !== 11)) {
            expect(r.star_system_id, `${r.kind}:${r.external_id}`).toBe(r.external_id === 72 ? pyro.id : stanton.id);
        }

        expect(res.perKind).toEqual({
            star_system: { fetched: 2, inserted: 2, errors: 0, perRowErrors: [] },
            orbit: { fetched: 2, inserted: 2, errors: 0, perRowErrors: [] },
            planet: { fetched: 1, inserted: 1, errors: 0, perRowErrors: [] },
            moon: { fetched: 3, inserted: 3, errors: 0, perRowErrors: [] },
            space_station: { fetched: 2, inserted: 2, errors: 0, perRowErrors: [] },
            city: { fetched: 1, inserted: 1, errors: 0, perRowErrors: [] },
            outpost: { fetched: 1, inserted: 1, errors: 0, perRowErrors: [] },
            poi: { fetched: 3, inserted: 3, errors: 0, perRowErrors: [] },
        });
        expect(res.totalErrors).toBe(0);
        expect(res.pathsUpdated).toBe(15);
        expect(res.durationMs).toBeGreaterThanOrEqual(0);
        expect(h.logger.info).toHaveBeenCalledWith('uex sync: pre-loaded existing platform_locations rows', { count: 0 });
        expect(h.logger.info).toHaveBeenCalledWith('uex sync: locations done', expect.objectContaining({ pathsUpdated: 15, totalErrors: 0 }));
    });

    it('computes denormalised "A > B > C" paths from the parent chain', async () => {
        loadUniverse();
        await syncPlatformLocations();
        expect(byKey('space_station', 51).path).toBe('Stanton > Crusader > Yela > GrimHEX');
        expect(byKey('poi', 71).path).toBe('Stanton > Crusader > Yela > GrimHEX > Station POI');
        expect(byKey('moon', 31).path).toBe('Stanton > Crusader L1 > OrbitMoon');
        expect(byKey('orbit', 11).path).toBe('Lost orbit');
        expect(byKey('star_system', 2).path).toBe('Pyro');
        // The path pass writes ONLY the path column.
        const pathUpdates = h.state.queries.filter((q) => has(q, 'update') && 'path' in (arg(q, 'update') as object));
        for (const q of pathUpdates) expect(Object.keys(arg(q, 'update') as object)).toEqual(['path']);
    });

    it('maps UEX fields onto a NEW row: sanitised names, booleans, amenities, UEX nickname/wiki, not hidden', async () => {
        loadUniverse();
        await syncPlatformLocations();
        const sys = upsertPayloadFor('star_system', 1)!;
        expect(sys).toEqual(expect.objectContaining({
            kind: 'star_system', external_id: 1, parent_id: null, star_system_id: null, name: 'Stanton', code: 'ST',
            is_available_live: true, is_visible: true, faction_name: 'UEE', jurisdiction_name: 'UEE Jurisdiction',
            uex_date_added: 100, uex_date_modified: 200, wiki_url: 'https://wiki.example/stanton',
            nickname: null, is_hidden: false, is_internal: false, amenities: {},
            is_landable: null, is_armistice: null, is_decommissioned: null, pad_types: null,
        }));
        expect(Number.isNaN(Date.parse(sys.last_synced_at as string))).toBe(false);
        expect(upsertPayloadFor('star_system', 2)).toEqual(expect.objectContaining({
            is_available_live: false, is_visible: null, code: null, faction_name: null, wiki_url: null, uex_date_added: null,
        }));
        // Orbits are internal scaffolding on first insert.
        expect(upsertPayloadFor('orbit', 10)!.is_internal).toBe(true);
        expect(upsertPayloadFor('city', 40)).toEqual(expect.objectContaining({
            nickname: 'Cloud City', code: 'ORI', is_landable: true, is_armistice: true, is_decommissioned: false,
            pad_types: 'S,M', amenities: { refuel: true, shops: true }, wiki_url: 'https://wiki.example/orison',
            is_hidden: false, is_internal: false,
        }));
        expect(upsertPayloadFor('space_station', 51)).toEqual(expect.objectContaining({
            name: 'GrimHEX', nickname: 'Grim', amenities: { docking_port: true, freight_elevator: true },
        }));
        expect(upsertPayloadFor('outpost', 60)).toEqual(expect.objectContaining({ code: null, is_decommissioned: true }));
    });

    it('PRESERVES admin edits (nickname, hidden, internal, wiki) across a re-sync', async () => {
        loadUniverse();
        db.rows.push(
            { id: 500, kind: 'city', external_id: 40, name: 'Old name', parent_id: null, nickname: 'Admin nick', is_hidden: true, is_internal: true, wiki_url: 'https://admin.example/wiki' },
            { id: 501, kind: 'orbit', external_id: 10, name: 'Crusader L1', parent_id: null, nickname: null, is_hidden: false, is_internal: false, wiki_url: null },
        );
        db.nextId = 1000;
        const res = await syncPlatformLocations();
        expect(h.logger.info).toHaveBeenCalledWith('uex sync: pre-loaded existing platform_locations rows', { count: 2 });
        expect(upsertPayloadFor('city', 40)).toEqual(expect.objectContaining({
            name: 'Orison', nickname: 'Admin nick', is_hidden: true, is_internal: true, wiki_url: 'https://admin.example/wiki',
        }));
        // An admin who un-flagged an orbit as internal keeps it visible.
        expect(upsertPayloadFor('orbit', 10)!.is_internal).toBe(false);
        // Upsert by (kind, external_id) keeps the row identity.
        expect(byKey('city', 40).id).toBe(500);
        expect(res.perKind.city.inserted).toBe(1);
    });

    it('a place whose system and parents are all unknown gets NULL foreign keys, never a guessed system', async () => {
        const sparse = { id_star_system: 404, name: 'Nowhere' };
        h.uex.planets = [{ id: 1, ...sparse }];
        h.uex.moons = [{ id: 2, ...sparse }];
        h.uex.cities = [{ id: 3, ...sparse }];
        h.uex.stations = [{ id: 4, ...sparse }];
        h.uex.outposts = [{ id: 5, ...sparse }];
        h.uex.pois = [{ id: 6, ...sparse }];
        const res = await syncPlatformLocations();
        for (const [kind, ext] of [['planet', 1], ['moon', 2], ['city', 3], ['space_station', 4], ['outpost', 5], ['poi', 6]] as const) {
            expect(byKey(kind, ext), kind).toEqual(expect.objectContaining({
                parent_id: null, star_system_id: null, path: 'Nowhere', nickname: null, code: null, pad_types: null,
                faction_name: null, jurisdiction_name: null, uex_date_added: null, uex_date_modified: null,
            }));
        }
        expect(res.totalErrors).toBe(0);
    });

    it('an all-markup UEX name falls back to the raw string; an over-long name is capped at 200', async () => {
        h.uex.systems = [{ id: 1, name: '<b></b>' }, { id: 2, name: 'N'.repeat(250) }];
        await syncPlatformLocations();
        expect(upsertPayloadFor('star_system', 1)!.name).toBe('<b></b>');
        expect((upsertPayloadFor('star_system', 2)!.name as string).length).toBe(200);
    });

    it('upserts in batches of 100', async () => {
        h.uex.planets = Array.from({ length: 150 }, (_, i) => ({ id: 1000 + i, id_star_system: 1, name: `P${i}` }));
        const res = await syncPlatformLocations();
        const planetBatches = upsertQueries()
            .map((q) => arg(q, 'upsert') as Array<{ kind: string }>)
            .filter((p) => p[0].kind === 'planet');
        expect(planetBatches.map((b) => b.length)).toEqual([100, 50]);
        expect(res.perKind.planet).toEqual({ fetched: 150, inserted: 150, errors: 0, perRowErrors: [] });
    });

    it('a rejected batch falls back to per-row upserts; per-row errors are counted and capped at 5 messages', async () => {
        h.uex.pois = [
            ...Array.from({ length: 7 }, (_, i) => ({ id: 800 + i, id_star_system: 1, name: `Bad ${i}` })),
            { id: 900, id_star_system: 1, name: 'Good POI' },
        ];
        db.batchFails = (rows) => rows.some((r) => r.kind === 'poi');
        db.rowError = (row) => String(row.name).startsWith('Bad') ? 'violates check constraint' : null;
        const res = await syncPlatformLocations();
        expect(res.perKind.poi.fetched).toBe(8);
        expect(res.perKind.poi.inserted).toBe(1);
        expect(res.perKind.poi.errors).toBe(7);
        expect(res.perKind.poi.perRowErrors).toEqual([0, 1, 2, 3, 4].map((i) => `poi "Bad ${i}": violates check constraint`));
        expect(res.totalErrors).toBe(7);
        // The good row still landed.
        expect(byKey('poi', 900).name).toBe('Good POI');
        expect(db.rows.some((r) => r.kind === 'poi' && String(r.name).startsWith('Bad'))).toBe(false);
    });

    it('pages the lookup pre-load past the 1000-row PostgREST cap', async () => {
        for (let i = 0; i < 1001; i++) {
            db.rows.push({ id: i + 1, kind: 'poi', external_id: 10_000 + i, name: `Old ${i}`, parent_id: null, nickname: null, is_hidden: false, is_internal: false, wiki_url: null });
        }
        db.nextId = 5000;
        const res = await syncPlatformLocations();
        const preloads = h.state.queries.filter((q) =>
            arg(q, 'select') === LOOKUP_COLUMNS && !all(q, 'eq').some((a) => a[0] === 'kind'));
        expect(preloads.map((q) => q.calls)).toEqual([
            [{ m: 'select', a: [LOOKUP_COLUMNS] }, { m: 'order', a: ['id', { ascending: true }] }, { m: 'range', a: [0, 999] }],
            [{ m: 'select', a: [LOOKUP_COLUMNS] }, { m: 'order', a: ['id', { ascending: true }] }, { m: 'range', a: [1000, 1999] }],
        ]);
        expect(h.logger.info).toHaveBeenCalledWith('uex sync: pre-loaded existing platform_locations rows', { count: 1001 });
        // The path pass pages too, and visits every row.
        const pathLoads = h.state.queries.filter((q) => arg(q, 'select') === 'id, name, parent_id');
        expect(pathLoads.map((q) => arg(q, 'range', 0))).toEqual([0, 1000]);
        expect(res.pathsUpdated).toBe(1001);
    });

    it('pages the per-kind lookup refresh too', async () => {
        h.uex.systems = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, name: `S${i}` }));
        await syncPlatformLocations();
        const refreshes = h.state.queries.filter((q) =>
            arg(q, 'select') === LOOKUP_COLUMNS && all(q, 'eq').some((a) => a[0] === 'kind' && a[1] === 'star_system'));
        expect(refreshes.map((q) => arg(q, 'range', 0))).toEqual([0, 1000]);
    });

    it('re-reads each kind with explicit lookup columns after its pass', async () => {
        loadUniverse();
        await syncPlatformLocations();
        const refreshedKinds = h.state.queries
            .filter((q) => arg(q, 'select') === LOOKUP_COLUMNS)
            .map((q) => all(q, 'eq').find((a) => a[0] === 'kind')?.[1])
            .filter(Boolean);
        // POIs are the leaf pass: nothing resolves against them, so no refresh.
        expect(refreshedKinds).toEqual(['star_system', 'orbit', 'planet', 'moon', 'city', 'space_station', 'outpost']);
    });

    it('lookup/path reads that return no data (and no error) are treated as empty, so FKs stay null', async () => {
        loadUniverse();
        db.nullData = true;
        const res = await syncPlatformLocations();
        // Nothing resolved from the lookup → every child is unparented and system-less.
        expect(byKey('planet', 20)).toEqual(expect.objectContaining({ parent_id: null, star_system_id: null }));
        expect(byKey('poi', 71)).toEqual(expect.objectContaining({ parent_id: null, star_system_id: null }));
        expect(res.pathsUpdated).toBe(0);
        expect(h.logger.info).toHaveBeenCalledWith('uex sync: pre-loaded existing platform_locations rows', { count: 0 });
    });

    it('a failed lookup pre-load aborts before any UEX fetch', async () => {
        db.selectError = (cols, kind) => (cols === LOOKUP_COLUMNS && kind === undefined ? { message: 'down' } : null);
        await expect(syncPlatformLocations()).rejects.toThrow('Failed to pre-load locations lookup');
        expect(h.uex.calls).toEqual([]);
        expect(upsertQueries()).toEqual([]);
    });

    it('a failed per-kind refresh aborts the sync before the dependent passes', async () => {
        loadUniverse();
        db.selectError = (cols, kind) => (cols === LOOKUP_COLUMNS && kind === 'moon' ? { message: 'down' } : null);
        await expect(syncPlatformLocations()).rejects.toThrow('Failed to reload moon lookup');
        expect(h.uex.calls).toEqual(['systems', 'orbits', 'planets', 'moons']);
    });

    it('a UEX fetch failure propagates (no partial "success" result)', async () => {
        loadUniverse();
        h.uex.orbitsError = new Error('UEX upstream 503');
        await expect(syncPlatformLocations()).rejects.toThrow('UEX upstream 503');
        expect(h.uex.calls).toEqual(['systems', 'orbits']);
    });

    it('a failed path load throws', async () => {
        loadUniverse();
        db.selectError = (cols) => (cols === 'id, name, parent_id' ? { message: 'down' } : null);
        await expect(syncPlatformLocations()).rejects.toThrow('Failed to load rows for path computation');
    });

    it('a failed path write is not counted as updated', async () => {
        loadUniverse();
        db.updateFails = (patch, id) => 'path' in patch && id === byKey('poi', 72).id;
        const res = await syncPlatformLocations();
        expect(res.pathsUpdated).toBe(14);
        expect(byKey('poi', 72).path).toBeUndefined();
    });

    it('a failed star-system self-reference write does not stop the sync; children still resolve their system', async () => {
        loadUniverse();
        db.updateFails = (patch) => 'star_system_id' in patch;
        const res = await syncPlatformLocations();
        expect(byKey('star_system', 1).star_system_id).toBeNull();
        expect(byKey('planet', 20).star_system_id).toBe(byKey('star_system', 1).id);
        expect(res.totalErrors).toBe(0);
    });

    it('path depth is capped at 8 (a parent cycle terminates) and a dangling parent stops the climb', async () => {
        db.rows.push(
            { id: 900, kind: 'poi', external_id: 1, name: 'A', parent_id: 901, nickname: null, is_hidden: false, is_internal: false, wiki_url: null },
            { id: 901, kind: 'poi', external_id: 2, name: 'B', parent_id: 900, nickname: null, is_hidden: false, is_internal: false, wiki_url: null },
            { id: 902, kind: 'poi', external_id: 3, name: 'Dangling', parent_id: 12345, nickname: null, is_hidden: false, is_internal: false, wiki_url: null },
        );
        db.nextId = 1000;
        const res = await syncPlatformLocations();
        expect(db.rows.find((r) => r.id === 900)!.path).toBe('B > A > B > A > B > A > B > A');
        expect(db.rows.find((r) => r.id === 902)!.path).toBe('Dangling');
        expect(res.pathsUpdated).toBe(3);
        expect(res.perKind.poi).toEqual({ fetched: 0, inserted: 0, errors: 0, perRowErrors: [] });
    });
});
