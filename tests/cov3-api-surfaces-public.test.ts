import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// api/public.ts — GET /api/public?resource=page|stats|testimonials|services&slug=…
//
// The ONLY fully unauthenticated data surface. Security rule 3: every response is an
// exact projection of the fields the public UI consumes. This suite drives the REAL
// handler over the REAL lib/db/public.ts projection (only the Supabase client and the
// settings reader are faked), with a settings blob and DB rows deliberately stuffed with
// private fields — featured testimonial ids, admin notes, webhook URLs, bot tokens,
// client names, internal UUIDs — and asserts:
//   - full key sets at every level of every 200 body, and that none of the private
//     values appear anywhere in the serialized body;
//   - 404 parity: every refusal (bad slug, disabled page, disabled module, unknown
//     resource, internal error) is byte-identical — same status, same body, same
//     headers — so slug / config state cannot be enumerated;
//   - each module endpoint is refused while its module is off, WITHOUT reading the
//     module's data;
//   - the in-process TTL cache (hit, strict expiry boundary, admin invalidation, the
//     featured-set cache key, and the soft size cap) — fake Date only, no real sleeps.

type Op = [string, unknown[]];
interface Q { table: string; ops: Op[] }

const h = vi.hoisted(() => {
    const state = {
        settings: {} as Record<string, unknown>,
        settingsCalls: 0,
        settingsThrows: null as Error | null,
        queries: [] as Q[],
        rows: {} as Record<string, unknown[]>,
        rpcCalls: [] as Array<{ fn: string; args: unknown }>,
        rpcResult: { data: null, error: null } as { data: unknown; error: unknown },
        logs: [] as Array<{ level: string; ctx: Record<string, unknown>; msg: string; fields?: Record<string, unknown> }>,
    };
    function from(table: string) {
        const q: Q = { table, ops: [] };
        state.queries.push(q);
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'not', 'is', 'order']) {
            chain[m] = (...a: unknown[]) => { q.ops.push([m, a]); return chain; };
        }
        chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
            Promise.resolve({ data: state.rows[table] ?? [], error: null }).then(ok, bad);
        return chain;
    }
    const rpc = (fn: string, args: unknown) => { state.rpcCalls.push({ fn, args }); return Promise.resolve(state.rpcResult); };
    return { state, from, rpc };
});

vi.mock('../lib/db/common', () => ({
    supabase: { from: h.from, rpc: h.rpc },
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
}));

vi.mock('../lib/db/system', () => ({
    getPublicSettings: async () => {
        h.state.settingsCalls++;
        if (h.state.settingsThrows) throw h.state.settingsThrows;
        return structuredClone(h.state.settings);
    },
}));

vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    type L = typeof actual.log;
    const mk = (ctx: Record<string, unknown>): L => ({
        debug: (msg, fields) => { h.state.logs.push({ level: 'debug', ctx, msg, fields }); },
        info: (msg, fields) => { h.state.logs.push({ level: 'info', ctx, msg, fields }); },
        warn: (msg, fields) => { h.state.logs.push({ level: 'warn', ctx, msg, fields }); },
        error: (msg, fields) => { h.state.logs.push({ level: 'error', ctx, msg, fields }); },
        child: (more) => mk({ ...ctx, ...more }),
    });
    return { ...actual, log: mk({}) };
});

import publicHandler, { invalidatePublicCache } from '../api/public';
import { opaqueId } from '../lib/publicId';

// ---------------------------------------------------------------------------
// Fixtures: every private value below must NEVER appear in a response body.
const T_ID_1 = '0d6f2a2e-1111-4111-8111-111111111111';
const T_ID_2 = '0d6f2a2e-2222-4222-8222-222222222222';
const T_ID_UNRATED = '0d6f2a2e-3333-4333-8333-333333333333';
const PRIVATE_VALUES = [
    'PRIVATE-ADMIN-NOTE', 'https://discord.com/api/webhooks/1/SECRET', 'whsec_LINK_SECRET', 'BOT-TOKEN-SECRET',
    'Alice Client', 'alice@example.com', 'user-uuid-42', 'INTERNAL-SVC-ID', 'svc-webhook-secret',
    T_ID_1, T_ID_2, T_ID_UNRATED,
];
const PRIVATE_KEYS = [
    'featuredTestimonialIds', 'adminNotes', 'webhookUrl', 'botToken', 'secretModule', 'webhookSecret',
    'client_name', 'client_email', 'user_id', 'is_active', 'webhook_url', 'internal_secret',
];

function baseSettings(modules: Partial<Record<'stats' | 'testimonials' | 'services' | 'links', boolean>> = {}) {
    return {
        publicPageConfig: {
            enabled: true,
            motto: 'Fly safe',
            blurb: 'Plain text blurb',
            heroImageUrl: 'https://cdn.example/hero.png',
            profileImageUrl: 'javascript:alert(1)',
            modules: { stats: true, testimonials: true, services: true, links: true, secretModule: true, ...modules },
            links: [
                { id: 'l1', label: 'Discord', url: 'https://discord.gg/abc', icon: 'discord', webhookSecret: 'whsec_LINK_SECRET' },
                { label: 'Legacy', url: 'https://legacy.example/' },
                { id: 'l3', label: 'Evil', url: 'javascript:alert(1)' },
            ],
            featuredTestimonialIds: [T_ID_2, T_ID_UNRATED, T_ID_1],
            adminNotes: 'PRIVATE-ADMIN-NOTE',
            webhookUrl: 'https://discord.com/api/webhooks/1/SECRET',
        },
        brandingConfig: { name: 'Test Org', iconUrl: '/media/logo.png', botToken: 'BOT-TOKEN-SECRET', themeColor: '#123456' },
    };
}

const TESTIMONIAL_ROWS = [
    { id: T_ID_1, client_rating: 5, client_feedback: '  Great escort  ', service_type: 'Escort', updated_at: '2026-02-03T23:30:00Z', client_name: 'Alice Client', client_email: 'alice@example.com', user_id: 'user-uuid-42' },
    { id: T_ID_2, client_rating: '4', client_feedback: 'Fast refuel', service_type: null, updated_at: null, client_name: 'Alice Client' },
];
const SERVICE_ROWS = [
    { name: 'Escort', icon: 'shield', color: '#00f', description: 'We fly with you', is_active: true, id: 'INTERNAL-SVC-ID', webhook_url: 'svc-webhook-secret' },
    { name: 'Refuel', icon: null, color: undefined, description: 42, is_active: true },
];

// ---------------------------------------------------------------------------
interface Sent { status: number; headers: Record<string, string>; body: unknown }

async function get(query: Record<string, unknown>, method = 'GET'): Promise<Sent> {
    const sent: Sent = { status: 0, headers: {}, body: undefined };
    const res = {
        setHeader: (k: string, v: string) => { sent.headers[k] = v; return res; },
        status: (c: number) => { sent.status = c; return res; },
        json: (b: unknown) => { sent.body = b; return res; },
    };
    await publicHandler({ method, query } as never, res as never);
    return sent;
}

const NOT_FOUND: Sent = { status: 404, headers: { 'Cache-Control': 'no-store' }, body: { error: 'not_found' } };
const okHeaders = (maxAge: number) => ({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': `public, max-age=${maxAge}`,
    'X-Content-Type-Options': 'nosniff',
});
const keys = (v: unknown) => Object.keys(v as object).sort();

function expectNoPrivateData(body: unknown) {
    const text = JSON.stringify(body);
    for (const v of PRIVATE_VALUES) expect(text, `leaked value ${v}`).not.toContain(v);
    for (const k of PRIVATE_KEYS) expect(text, `leaked key ${k}`).not.toContain(`"${k}"`);
}

const T0 = new Date('2026-06-01T00:00:00.000Z').getTime();

beforeEach(() => {
    invalidatePublicCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    h.state.settings = baseSettings();
    h.state.settingsCalls = 0;
    h.state.settingsThrows = null;
    h.state.queries = [];
    h.state.rows = { service_requests: TESTIMONIAL_ROWS, service_types: SERVICE_ROWS };
    h.state.rpcCalls = [];
    h.state.rpcResult = { data: null, error: null };
    h.state.logs = [];
});

afterEach(() => {
    vi.useRealTimers();
    invalidatePublicCache();
});

// ---------------------------------------------------------------------------
describe('request validation and 404 parity', () => {
    it('a non-GET is 405 and reads nothing', async () => {
        const r = await get({ resource: 'page', slug: 'org' }, 'POST');
        expect(r).toEqual({ status: 405, headers: {}, body: { error: 'method_not_allowed' } });
        expect(h.state.settingsCalls).toBe(0);
    });

    it.each([
        ['missing', undefined],
        ['array (repeated param)', ['org', 'org']],
        ['number', 42],
        ['empty', ''],
        ['two chars (below the 3-char multi-char floor)', 'ab'],
        ['leading hyphen', '-org'],
        ['trailing hyphen', 'org-'],
        ['underscore', 'my_org'],
        ['space inside', 'my org'],
        ['path traversal', '../etc'],
        ['33 chars', 'a'.repeat(33)],
        ['non-ascii', 'örg'],
        ['url-encoded', 'org%20x'],
    ])('slug %s → the unified 404, without any read', async (_label, slug) => {
        expect(await get({ resource: 'page', slug })).toEqual(NOT_FOUND);
        expect(h.state.settingsCalls).toBe(0);
        expect(h.state.queries).toEqual([]);
    });

    it.each([
        ['one char', 'a'],
        ['three chars', 'abc'],
        ['inner hyphen', 'a-b'],
        ['32 chars (maximum)', 'a'.repeat(32)],
    ])('slug %s is accepted', async (_label, slug) => {
        const r = await get({ resource: 'page', slug });
        expect(r.status).toBe(200);
    });

    it('a slug is trimmed and lower-cased, so case/whitespace variants share ONE cache entry', async () => {
        expect((await get({ resource: 'page', slug: '  My-Org ' })).status).toBe(200);
        expect((await get({ resource: 'page', slug: 'my-org' })).status).toBe(200);
        expect((await get({ resource: 'page', slug: 'MY-ORG' })).status).toBe(200);
        expect(h.state.settingsCalls).toBe(1);
    });

    it('an unknown or missing resource → the unified 404, without any read', async () => {
        expect(await get({ resource: 'members', slug: 'org' })).toEqual(NOT_FOUND);
        expect(await get({ slug: 'org' })).toEqual(NOT_FOUND);
        expect(await get({ resource: ['page'], slug: 'org' })).toEqual(NOT_FOUND);
        expect(h.state.settingsCalls).toBe(0);
    });

    it('a disabled public page is byte-identical to a bad slug on every resource', async () => {
        h.state.settings = { ...baseSettings(), publicPageConfig: { ...baseSettings().publicPageConfig, enabled: false } };
        for (const resource of ['page', 'stats', 'testimonials', 'services']) {
            expect(await get({ resource, slug: 'org' }), resource).toEqual(NOT_FOUND);
        }
        // Not strictly true is not enabled.
        h.state.settings = { ...baseSettings(), publicPageConfig: { ...baseSettings().publicPageConfig, enabled: 'true' } };
        expect(await get({ resource: 'page', slug: 'org' })).toEqual(NOT_FOUND);
        expect(h.state.rpcCalls).toEqual([]);
        expect(h.state.queries).toEqual([]);
    });

    it('a disabled public page is never cached: enabling it takes effect on the next request', async () => {
        h.state.settings = { ...baseSettings(), publicPageConfig: { ...baseSettings().publicPageConfig, enabled: false } };
        expect(await get({ resource: 'page', slug: 'org' })).toEqual(NOT_FOUND);
        h.state.settings = baseSettings();
        expect((await get({ resource: 'page', slug: 'org' })).status).toBe(200);
        expect(h.state.settingsCalls).toBe(2);
    });

    it.each(['page', 'stats', 'testimonials', 'services'])(
        'an internal error on %s is the unified 404 (never a 500), logged with the error only',
        async (resource) => {
            const boom = new Error('settings read failed');
            h.state.settingsThrows = boom;
            expect(await get({ resource, slug: 'org' })).toEqual(NOT_FOUND);
            expect(h.state.logs).toEqual([
                { level: 'error', ctx: { module: 'api.public' }, msg: 'public handler error', fields: { err: boom } },
            ]);
        },
    );

    it('an error AFTER the page check (testimonials featured-id read) is still the unified 404', async () => {
        // Page is cached by the first request; the second request's direct settings read throws.
        expect((await get({ resource: 'page', slug: 'org' })).status).toBe(200);
        h.state.settingsThrows = new Error('late failure');
        expect(await get({ resource: 'testimonials', slug: 'org' })).toEqual(NOT_FOUND);
        expect(h.state.queries).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('resource=page — exact public projection', () => {
    it('returns exactly the public page fields, nothing private', async () => {
        const r = await get({ resource: 'page', slug: 'org' });
        expect(r.status).toBe(200);
        expect(r.headers).toEqual(okHeaders(60));
        expect(r.body).toEqual({
            enabled: true,
            org: { name: 'Test Org', iconUrl: '/media/logo.png' },
            motto: 'Fly safe',
            blurb: 'Plain text blurb',
            blurbHtml: '',
            heroImageUrl: 'https://cdn.example/hero.png',
            profileImageUrl: '',
            modules: { stats: true, testimonials: true, services: true, links: true },
            links: [
                { id: 'l1', label: 'Discord', url: 'https://discord.gg/abc', icon: 'discord' },
                { id: 'link-1', label: 'Legacy', url: 'https://legacy.example/' },
            ],
        });
        const body = r.body as { org: object; modules: object; links: object[] };
        expect(keys(r.body)).toEqual(['blurb', 'blurbHtml', 'enabled', 'heroImageUrl', 'links', 'modules', 'motto', 'org', 'profileImageUrl']);
        expect(keys(body.org)).toEqual(['iconUrl', 'name']);
        expect(keys(body.modules)).toEqual(['links', 'services', 'stats', 'testimonials']);
        expect(body.links.map(keys)).toEqual([['icon', 'id', 'label', 'url'], ['id', 'label', 'url']]);
        expectNoPrivateData(r.body);
        // The page itself never touches request/service data.
        expect(h.state.queries).toEqual([]);
        expect(h.state.rpcCalls).toEqual([]);
    });

    it('is cached for 60s: a hit replays without a read; the boundary is strict', async () => {
        const first = await get({ resource: 'page', slug: 'org' });
        vi.setSystemTime(T0 + 60_000); // expiresAt === now → still fresh
        const second = await get({ resource: 'page', slug: 'org' });
        expect(second).toEqual(first);
        expect(h.state.settingsCalls).toBe(1);
        vi.setSystemTime(T0 + 60_001); // past expiry → re-read
        await get({ resource: 'page', slug: 'org' });
        expect(h.state.settingsCalls).toBe(2);
    });

    it('invalidatePublicCache drops the cache immediately (an admin disabling the page takes effect now)', async () => {
        expect((await get({ resource: 'page', slug: 'org' })).status).toBe(200);
        h.state.settings = { ...baseSettings(), publicPageConfig: { ...baseSettings().publicPageConfig, enabled: false } };
        // Without invalidation the cached copy is still served inside the TTL…
        expect((await get({ resource: 'page', slug: 'org' })).status).toBe(200);
        invalidatePublicCache();
        // …with it, the disabled state is visible on the very next request.
        expect(await get({ resource: 'page', slug: 'org' })).toEqual(NOT_FOUND);
    });
});

// ---------------------------------------------------------------------------
describe('resource=stats', () => {
    it('returns exactly the four aggregate counters via the public RPC', async () => {
        h.state.rpcResult = { data: [{ total_completed: '12', avg_rating_times10: 45, avg_response_minutes: 7.5, last30_completed: 3, internal_secret: 'x' }], error: null };
        const r = await get({ resource: 'stats', slug: 'org' });
        expect(r.status).toBe(200);
        expect(r.headers).toEqual(okHeaders(300));
        expect(r.body).toEqual({ totalCompleted: 12, avgRatingTimes10: 45, avgResponseMinutes: 7.5, last30Completed: 3 });
        expect(h.state.rpcCalls).toEqual([{ fn: 'public_stats_for_org', args: {} }]);
        expectNoPrivateData(r.body);
    });

    it('a failing RPC degrades to zeros, not an error', async () => {
        h.state.rpcResult = { data: null, error: { message: 'down' } };
        const r = await get({ resource: 'stats', slug: 'org' });
        expect(r.body).toEqual({ totalCompleted: 0, avgRatingTimes10: 0, avgResponseMinutes: 0, last30Completed: 0 });
    });

    it('module OFF → the unified 404 and the RPC is never called', async () => {
        h.state.settings = baseSettings({ stats: false });
        expect(await get({ resource: 'stats', slug: 'org' })).toEqual(NOT_FOUND);
        expect(h.state.rpcCalls).toEqual([]);
    });

    it('reuses a cached page, and caches the counters for 5 minutes', async () => {
        h.state.rpcResult = { data: [{ total_completed: 1 }], error: null };
        await get({ resource: 'page', slug: 'org' });
        await get({ resource: 'stats', slug: 'org' });
        expect(h.state.settingsCalls).toBe(1);
        vi.setSystemTime(T0 + 4 * 60_000);
        h.state.rpcResult = { data: [{ total_completed: 2 }], error: null };
        expect(((await get({ resource: 'stats', slug: 'org' })).body as { totalCompleted: number }).totalCompleted).toBe(1);
        expect(h.state.rpcCalls).toHaveLength(1);
        vi.setSystemTime(T0 + 5 * 60_000 + 1);
        expect(((await get({ resource: 'stats', slug: 'org' })).body as { totalCompleted: number }).totalCompleted).toBe(2);
        expect(h.state.rpcCalls).toHaveLength(2);
    });

    it('the stats path populates the page cache for later page requests', async () => {
        await get({ resource: 'stats', slug: 'org' });
        await get({ resource: 'page', slug: 'org' });
        expect(h.state.settingsCalls).toBe(1);
    });
});

// ---------------------------------------------------------------------------
describe('resource=testimonials — anonymised, featured-only', () => {
    it('returns { items } only: admin order, opaque ids, five display fields, no featured ids or client PII', async () => {
        const r = await get({ resource: 'testimonials', slug: 'org' });
        expect(r.status).toBe(200);
        expect(r.headers).toEqual(okHeaders(120));
        expect(keys(r.body)).toEqual(['items']);
        expect(r.body).toEqual({
            items: [
                // Admin order is T_ID_2, T_ID_UNRATED (no row → omitted), T_ID_1.
                { id: opaqueId(T_ID_2), rating: 4, quote: 'Fast refuel', serviceType: '', ratedAt: '' },
                // ratedAt is the UTC calendar date (23:30Z stays the 3rd in every TZ).
                { id: opaqueId(T_ID_1), rating: 5, quote: 'Great escort', serviceType: 'Escort', ratedAt: '2026-02-03' },
            ],
        });
        expect(opaqueId(T_ID_1)).not.toBe(T_ID_1);
        expectNoPrivateData(r.body);
        // One read with explicit columns, scoped to the featured ids and rated rows only.
        expect(h.state.queries).toEqual([{
            table: 'service_requests',
            ops: [
                ['select', ['id, client_rating, client_feedback, service_type, updated_at']],
                ['in', ['id', [T_ID_2, T_ID_UNRATED, T_ID_1]]],
                ['eq', ['rated', true]],
                ['not', ['client_rating', 'is', null]],
                ['not', ['client_feedback', 'is', null]],
            ],
        }]);
    });

    it('module OFF → the unified 404 and service_requests is never read', async () => {
        h.state.settings = baseSettings({ testimonials: false });
        expect(await get({ resource: 'testimonials', slug: 'org' })).toEqual(NOT_FOUND);
        expect(h.state.queries).toEqual([]);
    });

    it.each([
        ['empty', []],
        ['absent', undefined],
        ['not an array', 'id-1,id-2'],
    ])('a %s featured set is an empty 200 (card hides cleanly) without a read', async (_label, featured) => {
        const s = baseSettings();
        (s.publicPageConfig as Record<string, unknown>).featuredTestimonialIds = featured;
        h.state.settings = s;
        const r = await get({ resource: 'testimonials', slug: 'org' });
        expect(r).toEqual({ status: 200, headers: okHeaders(120), body: { items: [] } });
        expect(h.state.queries).toEqual([]);
    });

    it('caches per featured set for 2 minutes; changing the featured set misses the cache', async () => {
        await get({ resource: 'testimonials', slug: 'org' });
        await get({ resource: 'testimonials', slug: 'org' });
        expect(h.state.queries).toHaveLength(1);
        // The featured ids are re-read every time (they are not in the cached page payload).
        expect(h.state.settingsCalls).toBe(3);

        const s = baseSettings();
        s.publicPageConfig.featuredTestimonialIds = [T_ID_1];
        h.state.settings = s;
        const r = await get({ resource: 'testimonials', slug: 'org' });
        expect(h.state.queries).toHaveLength(2);
        expect((r.body as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([opaqueId(T_ID_1)]);

        vi.setSystemTime(T0 + 2 * 60_000 + 1);
        await get({ resource: 'testimonials', slug: 'org' });
        expect(h.state.queries).toHaveLength(3);
    });
});

// ---------------------------------------------------------------------------
describe('resource=services — active service types, four display fields', () => {
    it('returns { items } with exactly name/icon/color/description from ACTIVE rows', async () => {
        const r = await get({ resource: 'services', slug: 'org' });
        expect(r.status).toBe(200);
        expect(r.headers).toEqual(okHeaders(600));
        expect(keys(r.body)).toEqual(['items']);
        expect(r.body).toEqual({
            items: [
                { name: 'Escort', icon: 'shield', color: '#00f', description: 'We fly with you' },
                { name: 'Refuel', icon: '', color: '', description: '' },
            ],
        });
        expectNoPrivateData(r.body);
        expect(h.state.queries).toEqual([{
            table: 'service_types',
            ops: [['select', ['name, icon, color, description, is_active']], ['eq', ['is_active', true]], ['order', ['name']]],
        }]);
    });

    it('module OFF → the unified 404 and service_types is never read', async () => {
        h.state.settings = baseSettings({ services: false });
        expect(await get({ resource: 'services', slug: 'org' })).toEqual(NOT_FOUND);
        expect(h.state.queries).toEqual([]);
    });

    it('caches for 10 minutes and reuses the cached page', async () => {
        await get({ resource: 'services', slug: 'org' });
        vi.setSystemTime(T0 + 59_000);
        await get({ resource: 'services', slug: 'org' });
        expect(h.state.queries).toHaveLength(1);
        expect(h.state.settingsCalls).toBe(1);
        vi.setSystemTime(T0 + 10 * 60_000 + 1);
        await get({ resource: 'services', slug: 'org' });
        expect(h.state.queries).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
describe('cache soft size cap', () => {
    it('at 500 entries the oldest quarter is evicted; newer entries survive', async () => {
        for (let i = 0; i < 500; i++) {
            expect((await get({ resource: 'page', slug: `org-${i}` })).status).toBe(200);
        }
        expect(h.state.settingsCalls).toBe(500);
        // Entry 501 trips the cap: org-0 … org-124 are dropped.
        await get({ resource: 'page', slug: 'org-500' });
        expect(h.state.settingsCalls).toBe(501);

        await get({ resource: 'page', slug: 'org-125' }); // oldest survivor — still a hit
        await get({ resource: 'page', slug: 'org-499' });
        expect(h.state.settingsCalls).toBe(501);
        await get({ resource: 'page', slug: 'org-124' }); // newest evicted — a miss
        expect(h.state.settingsCalls).toBe(502);
        await get({ resource: 'page', slug: 'org-0' });
        expect(h.state.settingsCalls).toBe(503);
    });
});
