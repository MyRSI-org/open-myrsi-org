import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/uex.ts — the gaps tests/uexClient.test.ts leaves: the request throttle,
// every endpoint wrapper's path, the in-body `status` error, the ingest ceiling,
// failure paths where the body cannot even be read, the category-cache TTL, and
// the UEX → DB row mappers (which decide what third-party text reaches the DB).

vi.mock('../lib/log', async () => (await import('./cov-db-fleet-misc-sb')).logModule);

import { logs, logged } from './cov-db-fleet-misc-sb';
import {
    fetchUexCategories, fetchUexItemsForCategory, fetchUexItemAttributesForCategory, fetchUexCommodities,
    fetchUexStarSystems, fetchUexOrbits, fetchUexPlanets, fetchUexMoons, fetchUexSpaceStations,
    fetchUexCities, fetchUexOutposts, fetchUexPois, fetchAllUexItems,
    uexFailureMessage, uexSectionToQmLegacy, slugify, mapUexItemToQmRow, mapUexCommodityToWarehouseRow,
    type UexItem, type UexCommodity,
} from '../lib/db/uex';

const DEFAULT_BASE = 'https://api.uexcorp.space/2.0';
const KEY = 'uex-cov-secret';
const FIXED_NOW = '2026-04-05T06:07:08.000Z';

interface Reply { status?: number; contentType?: string | null; body?: string; text?: () => Promise<string>; reject?: unknown }
const fetchSpy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function toResponse(r: Reply): Response {
    const status = r.status ?? 200;
    const ct = r.contentType === undefined ? 'application/json' : r.contentType;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? ct : null) },
        text: r.text ?? (async () => r.body ?? ''),
        json: async () => JSON.parse(r.body ?? '{"status":"ok","data":[]}'),
    } as unknown as Response;
}

/** Route by path suffix (after the base); unmatched paths reply with an empty ok list. */
function routeFetch(table: Record<string, Reply | ((url: string) => Reply)>) {
    fetchSpy.mockImplementation(async (url: string) => {
        const key = Object.keys(table).find((k) => url.endsWith(k));
        const entry = key ? table[key] : { body: JSON.stringify({ status: 'ok', data: [] }) };
        const r = typeof entry === 'function' ? entry(url) : entry;
        if (r.reject !== undefined) throw r.reject;
        return toResponse(r);
    });
}
const ok = (data: unknown): Reply => ({ body: JSON.stringify({ status: 'ok', data }) });
const urls = () => fetchSpy.mock.calls.map((c) => c[0]);

const ENV_KEYS = ['UEX_API_KEY', 'UEX_API_BASE', 'UEX_REQUEST_DELAY_MS'] as const;
const saved: Record<string, string | undefined> = {};
let baseSeq = 0;
/** A fresh base per test busts the module-level category cache (it is keyed on base). */
function freshBase(): string {
    const b = `https://cov${++baseSeq}.uex.test/2.0`;
    process.env.UEX_API_BASE = b;
    return b;
}

beforeEach(() => {
    logs.length = 0;
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.UEX_API_KEY = KEY;
    delete process.env.UEX_API_BASE;
    process.env.UEX_REQUEST_DELAY_MS = '0';
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('endpoint wrappers', () => {
    const cases: Array<[string, () => Promise<unknown>, string]> = [
        ['fetchUexStarSystems', fetchUexStarSystems, '/star_systems'],
        ['fetchUexOrbits', fetchUexOrbits, '/orbits'],
        ['fetchUexPlanets', fetchUexPlanets, '/planets'],
        ['fetchUexMoons', fetchUexMoons, '/moons'],
        ['fetchUexSpaceStations', fetchUexSpaceStations, '/space_stations'],
        ['fetchUexCities', fetchUexCities, '/cities'],
        ['fetchUexOutposts', fetchUexOutposts, '/outposts'],
        ['fetchUexPois', fetchUexPois, '/poi'],
        ['fetchUexCommodities', fetchUexCommodities, '/commodities'],
        ['fetchUexItemsForCategory(7)', () => fetchUexItemsForCategory(7), '/items?id_category=7'],
        ['fetchUexItemAttributesForCategory(7)', () => fetchUexItemAttributesForCategory(7), '/items_attributes?id_category=7'],
    ];
    for (const [name, fn, path] of cases) {
        it(`${name} GETs ${path} with the Bearer and returns the payload's data`, async () => {
            const data = [{ id: 1, name: `row for ${path}` }];
            routeFetch({ [path]: ok(data) });
            await expect(fn()).resolves.toEqual(data);
            expect(urls()).toEqual([`${DEFAULT_BASE}${path}`]);
            const init = fetchSpy.mock.calls[0][1] as { method: string; headers: Record<string, string> };
            expect(init.method).toBe('GET');
            expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
            expect(init.headers.Accept).toBe('application/json');
        });
    }

    it('accepts a plain-http operator proxy base (trailing slashes stripped)', async () => {
        process.env.UEX_API_BASE = 'http://proxy.internal:8080/uex//';
        routeFetch({});
        await fetchUexMoons();
        expect(urls()).toEqual(['http://proxy.internal:8080/uex/moons']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('response body contract', () => {
    it('throws when the body reports a non-ok status, quoting the API message', async () => {
        routeFetch({ '/commodities': { body: JSON.stringify({ status: 'invalid_request', message: 'Bad category' }) } });
        await expect(fetchUexCommodities()).rejects.toThrow('UEX API /commodities status=invalid_request: Bad category');
    });

    it('throws with an empty message suffix when the non-ok body carries no message', async () => {
        routeFetch({ '/commodities': { body: JSON.stringify({ status: 'error' }) } });
        await expect(fetchUexCommodities()).rejects.toThrow(/^UEX API \/commodities status=error: $/);
    });

    it('returns [] when an ok body has no data field, and data when status is absent', async () => {
        routeFetch({ '/commodities': { body: JSON.stringify({ status: 'ok' }) } });
        await expect(fetchUexCommodities()).resolves.toEqual([]);
        routeFetch({ '/commodities': { body: JSON.stringify({ data: [{ id: 3 }] }) } });
        await expect(fetchUexCommodities()).resolves.toEqual([{ id: 3 }]);
    });

    it('an unreadable error body still yields a classified, body-free message', async () => {
        routeFetch({ '/commodities': { status: 500, text: async () => { throw new Error('stream aborted'); } } });
        const err = await fetchUexCommodities().catch((e: Error) => e) as Error;
        expect(err.message).toBe(uexFailureMessage('/commodities', 500, 'upstream'));
        expect(err.message).toBe('UEX API /commodities returned HTTP 500. See the server log for the response details.');
        expect(err.message).not.toContain('stream aborted');
        expect(logged('warn', 'uex request failed')?.fields).toMatchObject({ status: 500, kind: 'upstream', bytes: 0, bodyPreview: '' });
    });

    it('a 2xx with no content-type is treated as non-JSON, even if its body is unreadable', async () => {
        routeFetch({ '/commodities': { status: 200, contentType: null, text: async () => { throw new Error('reset'); } } });
        const err = await fetchUexCommodities().catch((e: Error) => e) as Error;
        expect(err.message).toBe('UEX API /commodities returned HTTP 200. See the server log for the response details.');
        expect(logged('warn', 'uex returned a non-JSON 2xx')?.fields).toMatchObject({ status: 200, kind: 'upstream', contentType: '', bytes: 0 });
    });

    it('scrubs x-api-key / api_key echoes out of the logged preview', async () => {
        routeFetch({ '/commodities': { status: 502, contentType: 'text/plain', body: `x-api-key: ${KEY} api_key=${KEY}2 note` } });
        await fetchUexCommodities().catch(() => {});
        const preview = String(logged('warn', 'uex request failed')!.fields!.bodyPreview);
        expect(preview).toBe('x-api-key: [REDACTED] api_key=[REDACTED] note');
        expect(preview).not.toContain(KEY);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('request throttle', () => {
    async function expectSpacing(delayEnv: string, expectedMs: number) {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2030-01-01T00:00:00Z').getTime() + (++baseSeq) * 10_000_000);
        process.env.UEX_REQUEST_DELAY_MS = delayEnv;
        routeFetch({});
        await fetchUexCommodities(); // long after any previous request → no wait
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const second = fetchUexCommodities();
        await vi.advanceTimersByTimeAsync(expectedMs - 1);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await second;
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    }

    it('spaces consecutive requests by UEX_REQUEST_DELAY_MS', async () => {
        await expectSpacing('250', 250);
    });

    it('falls back to the 600ms default for a non-numeric delay', async () => {
        await expectSpacing('abc', 600);
    });

    it('falls back to the 600ms default for a negative delay', async () => {
        await expectSpacing('-5', 600);
    });

    it('uses the 600ms default when the knob is unset', async () => {
        delete process.env.UEX_REQUEST_DELAY_MS;
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2031-01-01T00:00:00Z').getTime() + (++baseSeq) * 10_000_000);
        routeFetch({});
        await fetchUexCommodities();
        const second = fetchUexCommodities();
        await vi.advanceTimersByTimeAsync(599);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await second;
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('does not wait at all when the delay is 0', async () => {
        routeFetch({});
        await fetchUexCommodities();
        await fetchUexCommodities();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('category cache', () => {
    it('serves from cache within the hour, refetches after it, and force bypasses it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const t0 = new Date('2032-01-01T00:00:00Z').getTime();
        vi.setSystemTime(t0);
        const base = freshBase();
        routeFetch({ '/categories': ok([{ id: 1, name: 'Ship Weapons', type: 'item' }]) });

        await expect(fetchUexCategories()).resolves.toEqual([{ id: 1, name: 'Ship Weapons', type: 'item' }]);
        vi.setSystemTime(t0 + 59 * 60_000);
        await fetchUexCategories();
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        await fetchUexCategories(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        vi.setSystemTime(t0 + 59 * 60_000 + 60 * 60_000 + 1);
        await fetchUexCategories();
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(urls().every((u) => u === `${base}/categories`)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('fetchAllUexItems', () => {
    it('fetches only item-type categories and collects per-category failures (incl. non-Error throws)', async () => {
        const base = freshBase();
        routeFetch({
            '/categories': ok([
                { id: 1, name: 'Personal Weapons', type: 'item' },
                { id: 2, name: 'Armor', type: 'item' },
                { id: 3, name: 'Refueling', type: 'service' },
            ]),
            '/items?id_category=1': ok([{ id: 10, name: 'P4-AR', slug: 'p4-ar' }, { id: 11, name: 'S71', slug: 's71' }]),
            '/items?id_category=2': { reject: 'socket hang up' },
        });

        const res = await fetchAllUexItems();

        expect(urls()).toEqual([`${base}/categories`, `${base}/items?id_category=1`, `${base}/items?id_category=2`]);
        expect(res.categories.map((c) => c.id)).toEqual([1, 2]);
        expect(res.items.map((i) => i.id)).toEqual([10, 11]);
        expect(res.errors).toEqual([{ categoryId: 2, categoryName: 'Armor', message: 'socket hang up' }]);
        expect(logged('warn', 'item category fetch failed')?.fields).toEqual({ categoryId: 2, categoryName: 'Armor', message: 'socket hang up' });
        expect(logged('info', 'fetched all uex items')?.fields).toEqual({ itemCount: 2, categoryCount: 2, errorCount: 1 });
    });

    it('stops fetching once the 50,000-item ingest ceiling is reached', async () => {
        const base = freshBase();
        const big = Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: 'x', slug: 'x' }));
        routeFetch({
            '/categories': ok([{ id: 1, name: 'A', type: 'item' }, { id: 2, name: 'B', type: 'item' }]),
            '/items?id_category=1': ok(big),
        });

        const res = await fetchAllUexItems();

        expect(res.items).toHaveLength(50_000);
        // Category 2 is never requested.
        expect(urls()).toEqual([`${base}/categories`, `${base}/items?id_category=1`]);
        expect(logged('warn', 'uex item ceiling reached — truncating')?.fields).toEqual({ cap: 50_000, fetched: 50_000 });
        expect(res.errors).toEqual([]);
    });

    it('propagates a categories failure (nothing to iterate)', async () => {
        freshBase();
        routeFetch({ '/categories': { status: 401, body: '{"status":"unauthorized"}' } });
        await expect(fetchAllUexItems()).rejects.toThrow(/rejected the credentials \(HTTP 401\)/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('uexSectionToQmLegacy — collapses UEX categories onto the legacy CHECK set', () => {
    it.each([
        ['Personal Weapons', 'Rifles', 'weapon'],
        ['Armor', 'Pistol Holsters', 'weapon'], // weapon keywords take precedence
        ['Clothing', 'Undersuits', 'armor'],
        [null, 'Helmets', 'armor'],
        ['Vehicle Components', null, 'component'],
        [undefined, 'Quantum Drives', 'component'],
        ['Liveries', 'Paint', 'component'],
        ['Consumables', 'Food', 'consumable'],
        [null, 'MedPens', 'consumable'],
        ['Gadgets', 'Tools', 'misc'],
        [null, undefined, 'misc'],
    ] as const)('(%s, %s) → %s', (section, category, expected) => {
        expect(uexSectionToQmLegacy(section, category)).toBe(expected);
    });
});

describe('slugify', () => {
    it('lowercases, hyphenates runs of non-alphanumerics and trims edge hyphens', () => {
        expect(slugify('  P4-AR Rifle (Black)!  ')).toBe('p4-ar-rifle-black');
    });
    it('caps the length and never returns an empty slug', () => {
        expect(slugify('abcdefghij', 5)).toBe('abcde');
        expect(slugify('')).toBe('unknown');
        expect(slugify('!!!')).toBe('unknown');
        expect(slugify(undefined as unknown as string)).toBe('unknown');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('mapUexItemToQmRow', () => {
    const lookup = new Map<number, number>([[5, 50]]);
    const item = (over: Partial<UexItem> = {}): UexItem => ({
        id: 101, id_category: 5, name: 'P4-AR <b>Rifle</b>', section: 'Personal Weapons', category: 'Rifles',
        slug: 'p4-ar-rifle', uuid: 'uuid-101', company_name: 'Behring<script>x</script>', vehicle_name: null,
        screenshot: 'https://uex/shot.png', url_store: 'https://uex/store', quality: 3, size: 'S3',
        color: 'black', color2: 'red', game_version: '4.1', is_commodity: 1, is_harvestable: 0, ...over,
    });

    it('skips an item without a stable uuid', () => {
        expect(mapUexItemToQmRow(item({ uuid: null }), lookup)).toBeNull();
        expect(mapUexItemToQmRow(item({ uuid: '' }), lookup)).toBeNull();
    });

    it('maps every column, strips markup from display text, and NEVER writes `attributes`', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(FIXED_NOW));
        const row = mapUexItemToQmRow(item(), lookup)!;
        expect(row).toEqual({
            slug: 'p4-ar-rifle', name: 'P4-AR Rifle', category: 'weapon', subcategory: 'Rifles', source: 'platform',
            thumbnail_url: 'https://uex/shot.png', wiki_url: null, external_uuid: 'uuid-101', external_id: 101,
            is_vehicle_item: false, is_commodity: true, is_harvestable: false,
            screenshot_url: 'https://uex/shot.png', store_url: 'https://uex/store',
            company_name: 'Behringx', vehicle_name: null, quality: 3, size_label: 'S3', color: 'black', color2: 'red',
            game_version: '4.1', platform_category_id: 50, last_synced_at: FIXED_NOW, updated_at: FIXED_NOW,
        });
        // Omitting the key is what preserves attribute data across re-syncs.
        expect(Object.prototype.hasOwnProperty.call(row, 'attributes')).toBe(false);
    });

    it('falls back for slug/name/subcategory and nulls absent optional fields', () => {
        const row = mapUexItemToQmRow(item({
            slug: '', name: '<i></i>', category: null, section: 'Ship Components', id_category: 99,
            screenshot: null, url_store: null, quality: null, size: null, color: null, color2: null,
            game_version: null, company_name: null, id: 0, is_commodity: undefined,
        }), lookup)!;
        expect(row).toMatchObject({
            slug: 'i-i', name: 'Unknown', subcategory: 'Ship Components', category: 'component',
            platform_category_id: null, thumbnail_url: null, store_url: null, quality: null, size_label: null,
            color: null, color2: null, game_version: null, company_name: null, external_id: null, is_commodity: false,
        });
    });

    it('flags vehicle items by id or name and leaves the FK null without a category id', () => {
        expect(mapUexItemToQmRow(item({ id_vehicle: 12 }), lookup)!.is_vehicle_item).toBe(true);
        expect(mapUexItemToQmRow(item({ vehicle_name: 'Cutlass Black' }), lookup)).toMatchObject({ is_vehicle_item: true, vehicle_name: 'Cutlass Black' });
        expect(mapUexItemToQmRow(item({ id_category: null }), lookup)!.platform_category_id).toBeNull();
    });
});

describe('mapUexCommodityToWarehouseRow', () => {
    const lookup = new Map<string, number>([['metal-ore', 7]]);
    const commodity = (over: Partial<UexCommodity> = {}): UexCommodity => ({
        id: 33, name: 'Agricium <b>(Ore)</b>', code: 'AGRI', slug: 'agricium-ore', kind: 'Metal Ore',
        weight_scu: 1, price_buy: 10.5, price_sell: 12, is_available: 1, is_illegal: 0, is_raw: 1,
        wiki: 'https://wiki/agricium', date_added: 1700000000, date_modified: 1700000500, ...over,
    });

    it('maps numbers, 0/1 flags to booleans and resolves the category FK from the kind slug', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(FIXED_NOW));
        const row = mapUexCommodityToWarehouseRow(commodity(), lookup);
        expect(row).toMatchObject({
            external_id: 33, external_uuid: null, slug: 'agricium-ore', name: 'Agricium (Ore)', code: 'AGRI',
            kind: 'Metal Ore', weight_scu: 1, price_buy: 10.5, price_sell: 12,
            is_available: true, is_illegal: false, is_raw: true,
            // Absent flags are unknown (null), not false.
            is_available_live: null, is_buyable: null, is_fuel: null,
            wiki_url: 'https://wiki/agricium', platform_category_id: 7,
            uex_date_added: 1700000000, uex_date_modified: 1700000500,
            last_synced_at: FIXED_NOW, updated_at: FIXED_NOW,
        });
    });

    it('nulls non-numeric values, an unknown kind, and missing optional text', () => {
        const row = mapUexCommodityToWarehouseRow(commodity({
            slug: '', name: '', code: null, kind: null, weight_scu: null, price_buy: undefined,
            wiki: null, date_added: undefined, date_modified: undefined,
        }), lookup);
        expect(row).toMatchObject({
            slug: 'unknown', name: 'Unknown', code: null, kind: null, weight_scu: null, price_buy: null,
            wiki_url: null, platform_category_id: null, uex_date_added: null, uex_date_modified: null,
        });
        expect(mapUexCommodityToWarehouseRow(commodity({ kind: 'Gas' }), lookup).platform_category_id).toBeNull();
    });
});
