import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/public.ts — the UNAUTHENTICATED public org page and the admin-side testimonial
// picker that feeds it. Security rule 3: an unauthenticated surface returns a projection
// of exactly the fields the public UI consumes. What is pinned here:
//   - the page payload is an exact allowlist; nothing else stored on publicPageConfig or
//     brandingConfig (featured ids, webhook urls, private notes...) crosses the wire;
//   - the page is gated ONLY by enabled === true (strict), and returns null otherwise;
//   - rich-text blurbs are rendered through the allowlisting walker (no raw HTML);
//   - testimonials are anonymised (opaque id, 5 keys) and limited to rated rows with
//     feedback, admin order, max 6; services expose 4 display fields of ACTIVE rows only;
//   - every read failure degrades to "nothing" (fail-closed), never to a throw on the
//     public surface — except the authenticated admin listing, which throws.

const h = vi.hoisted(() => {
    type Call = { m: string; a: unknown[] };
    type Q = { table: string; calls: Call[] };
    const state = {
        settings: {} as Record<string, unknown>,
        settingsCalls: 0,
        queries: [] as Q[],
        respond: ((_q: Q) => ({ data: null, error: null })) as (q: Q) => unknown,
        rpcCalls: [] as Array<{ fn: string; args: unknown }>,
        rpcResult: { data: null, error: null } as { data: unknown; error: unknown },
    };
    function from(table: string) {
        const q: Q = { table, calls: [] };
        state.queries.push(q);
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'not', 'is', 'ilike', 'order', 'range']) {
            b[m] = (...a: unknown[]) => { q.calls.push({ m, a }); return b; };
        }
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve().then(() => state.respond(q)).then(res, rej);
        return b;
    }
    const rpc = (fn: string, args: unknown) => { state.rpcCalls.push({ fn, args }); return Promise.resolve(state.rpcResult); };
    return { state, from, rpc };
});

vi.mock('../lib/db/common', () => ({
    supabase: { from: h.from, rpc: h.rpc },
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
        if (error) throw new Error(message);
    },
}));
vi.mock('../lib/db/system', () => ({
    getPublicSettings: async () => { h.state.settingsCalls++; return h.state.settings; },
}));

import {
    getPublicPageData, getPublicStatsForOrg, getPublicFeaturedTestimonials, getPublicServicesForOrg,
    getTestimonialCandidates, verifyFeaturedTestimonialIdsBelongToOrg,
} from '../lib/db/public';
import { opaqueId } from '../lib/publicId';

beforeEach(() => {
    h.state.settings = {};
    h.state.settingsCalls = 0;
    h.state.queries = [];
    h.state.respond = () => ({ data: null, error: null });
    h.state.rpcCalls = [];
    h.state.rpcResult = { data: null, error: null };
});

const RATED_FILTERS = [
    { m: 'eq', a: ['rated', true] },
    { m: 'not', a: ['client_rating', 'is', null] },
    { m: 'not', a: ['client_feedback', 'is', null] },
];

const doc = (...content: unknown[]) => JSON.stringify({ type: 'doc', content });

// ---------------------------------------------------------------------------
describe('getPublicPageData gate', () => {
    it.each([['', 'empty slug'], [undefined, 'missing slug'], [42, 'non-string slug']])(
        'returns null for %s (%s) without reading settings',
        async (slug, _label) => {
            h.state.settings = { publicPageConfig: { enabled: true } };
            expect(await getPublicPageData(slug as unknown as string)).toBeNull();
            expect(h.state.settingsCalls).toBe(0);
        },
    );

    it('returns null when no publicPageConfig is stored', async () => {
        h.state.settings = { brandingConfig: { name: 'Org' } };
        expect(await getPublicPageData('org')).toBeNull();
    });

    it.each([false, 'true', 1, null, undefined])('returns null unless enabled is strictly true (got %s)', async (enabled) => {
        h.state.settings = { publicPageConfig: { enabled, motto: 'leak?' } };
        expect(await getPublicPageData('org')).toBeNull();
    });
});

describe('getPublicPageData projection (Security rule 3)', () => {
    it('emits exactly the allowlisted keys and nothing else stored on the configs', async () => {
        h.state.settings = {
            publicPageConfig: {
                enabled: true,
                motto: 'Semper',
                blurb: 'Plain about text',
                heroImageUrl: 'https://cdn.example/hero.png',
                profileImageUrl: 'https://cdn.example/p.png',
                modules: { stats: true, testimonials: 1, services: '', links: undefined },
                links: [{ id: 'a', label: 'Site', url: 'https://org.example/home', icon: 'fa-globe', secretNote: 'x' }],
                featuredTestimonialIds: ['SR-INTERNAL-1'],
                adminNotes: 'do not publish',
            },
            brandingConfig: { name: 'Org', iconUrl: '/media/logo.png', webhookSecret: 'shh', dutyTimeoutMinutes: 30 },
            discordConfig: { botToken: 'TOKEN' },
        };
        const res = await getPublicPageData('anything');
        expect(res).toEqual({
            enabled: true,
            org: { name: 'Org', iconUrl: '/media/logo.png' },
            motto: 'Semper',
            blurb: 'Plain about text',
            blurbHtml: '',
            heroImageUrl: 'https://cdn.example/hero.png',
            profileImageUrl: 'https://cdn.example/p.png',
            modules: { stats: true, testimonials: true, services: false, links: false },
            links: [{ id: 'a', label: 'Site', url: 'https://org.example/home', icon: 'fa-globe' }],
        });
        const wire = JSON.stringify(res);
        for (const leak of ['SR-INTERNAL-1', 'do not publish', 'shh', 'TOKEN', 'secretNote', 'dutyTimeoutMinutes']) {
            expect(wire).not.toContain(leak);
        }
    });

    it('non-string branding/motto/blurb fields and a missing branding block become empty strings', async () => {
        h.state.settings = { publicPageConfig: { enabled: true, motto: 7, blurb: { evil: true } } };
        const res = await getPublicPageData('org');
        expect(res!.org).toEqual({ name: '', iconUrl: '' });
        expect(res!.motto).toBe('');
        expect(res!.blurb).toBe('');
        expect(res!.blurbHtml).toBe('');
        expect(res!.modules).toEqual({ stats: false, testimonials: false, services: false, links: false });
        expect(res!.links).toEqual([]);
        expect(res!.heroImageUrl).toBe('');
        expect(res!.profileImageUrl).toBe('');
    });

    it('non-string branding values are blanked, not passed through', async () => {
        h.state.settings = { publicPageConfig: { enabled: true }, brandingConfig: { name: { x: 1 }, iconUrl: 5 } };
        expect((await getPublicPageData('org'))!.org).toEqual({ name: '', iconUrl: '' });
    });
});

describe('getPublicPageData blurb rendering', () => {
    it('a Tiptap JSON blurb renders through the safe walker and blanks the plain field', async () => {
        h.state.settings = {
            publicPageConfig: {
                enabled: true,
                blurb: doc({ type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script> & hi' }] }),
            },
        };
        const res = await getPublicPageData('org');
        expect(res!.blurb).toBe('');
        expect(res!.blurbHtml).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; hi</p>');
        expect(res!.blurbHtml).not.toContain('<script>');
    });

    it('an empty Tiptap doc (cleared editor) suppresses both blurb fields', async () => {
        h.state.settings = { publicPageConfig: { enabled: true, blurb: doc({ type: 'paragraph' }) } };
        const res = await getPublicPageData('org');
        expect(res!.blurb).toBe('');
        expect(res!.blurbHtml).toBe('');
    });

    it('a whitespace-only plain blurb is treated as empty', async () => {
        h.state.settings = { publicPageConfig: { enabled: true, blurb: '   \n  ' } };
        const res = await getPublicPageData('org');
        expect(res!.blurb).toBe('');
        expect(res!.blurbHtml).toBe('');
    });
});

describe('getPublicPageData links', () => {
    it('drops malformed / unsafe links, synthesises legacy ids by post-filter index, and caps at 10', async () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ id: `id-${i}`, label: `L${i}`, url: `https://org.example/p${i}` }));
        h.state.settings = {
            publicPageConfig: {
                enabled: true,
                links: [
                    null,
                    { label: 'no url' },
                    { url: 'https://org.example/nolabel' },
                    { label: 'js', url: 'javascript:alert(1)' },
                    { label: 'legacy', url: 'https://org.example/legacy' },          // no id
                    { id: '', label: 'blank id', url: 'https://org.example/blank', icon: '' },
                    ...many,
                ],
            },
        };
        const res = await getPublicPageData('org');
        expect(res!.links).toHaveLength(10);
        expect(res!.links[0]).toEqual({ id: 'link-0', label: 'legacy', url: 'https://org.example/legacy' });
        // Empty icon is omitted entirely; empty id falls back to the index key.
        expect(res!.links[1]).toEqual({ id: 'link-1', label: 'blank id', url: 'https://org.example/blank' });
        expect(res!.links[2]).toEqual({ id: 'id-0', label: 'L0', url: 'https://org.example/p0' });
        expect(res!.links[9].id).toBe('id-7');
        expect(JSON.stringify(res!.links)).not.toContain('javascript:');
    });

    it('a non-array links value yields no links', async () => {
        h.state.settings = { publicPageConfig: { enabled: true, links: { label: 'x', url: 'https://a.example/' } } };
        expect((await getPublicPageData('org'))!.links).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('getPublicStatsForOrg', () => {
    const ZERO = { totalCompleted: 0, avgRatingTimes10: 0, avgResponseMinutes: 0, last30Completed: 0 };

    it('calls the aggregate RPC with no arguments and maps its first row', async () => {
        h.state.rpcResult = {
            data: [{ total_completed: '12', avg_rating_times10: 47, avg_response_minutes: '9', last30_completed: 3, extra: 'x' }],
            error: null,
        };
        expect(await getPublicStatsForOrg()).toEqual({
            totalCompleted: 12, avgRatingTimes10: 47, avgResponseMinutes: 9, last30Completed: 3,
        });
        expect(h.state.rpcCalls).toEqual([{ fn: 'public_stats_for_org', args: {} }]);
    });

    it('non-numeric aggregates coerce to 0', async () => {
        h.state.rpcResult = { data: [{ total_completed: 'abc', avg_rating_times10: null }], error: null };
        expect(await getPublicStatsForOrg()).toEqual(ZERO);
    });

    it.each([
        ['an RPC error', { data: [{ total_completed: 5 }], error: { message: 'x' } }],
        ['null data', { data: null, error: null }],
        ['an empty row set', { data: [], error: null }],
    ])('%s yields all zeros', async (_label, result) => {
        h.state.rpcResult = result as { data: unknown; error: unknown };
        expect(await getPublicStatsForOrg()).toEqual(ZERO);
    });
});

// ---------------------------------------------------------------------------
describe('getPublicFeaturedTestimonials', () => {
    const row = (id: string, over: Record<string, unknown> = {}) => ({
        id, client_rating: 5, client_feedback: `Feedback ${id}`, service_type: 'Rescue', updated_at: '2026-03-15T10:45:00.000Z', ...over,
    });

    it.each([[undefined], [null], ['SR-1'], [[]]])('returns [] without a query for %j', async (ids) => {
        expect(await getPublicFeaturedTestimonials(ids as unknown as string[])).toEqual([]);
        expect(h.state.queries).toEqual([]);
    });

    it('returns [] without a query when every id is non-string or empty', async () => {
        expect(await getPublicFeaturedTestimonials(['', 5, null] as unknown as string[])).toEqual([]);
        expect(h.state.queries).toEqual([]);
    });

    it('queries only rated rows with feedback, by the first 6 valid ids, selecting no client columns', async () => {
        h.state.respond = () => ({ data: [], error: null });
        await getPublicFeaturedTestimonials(['a', 'b', '', 'c', 'd', 'e', 'f', 'g']);
        expect(h.state.queries).toEqual([{
            table: 'service_requests',
            calls: [
                { m: 'select', a: ['id, client_rating, client_feedback, service_type, updated_at'] },
                // slice(0,6) runs BEFORE the filter, so '' consumes a slot and 'f','g' are clamped away.
                { m: 'in', a: ['id', ['a', 'b', 'c', 'd', 'e']] },
                ...RATED_FILTERS,
            ],
        }]);
    });

    it('anonymises, preserves admin order, and silently omits unresolved / blank-feedback rows', async () => {
        const long = 'x'.repeat(700);
        h.state.respond = () => ({
            data: [
                row('SR-2', { client_feedback: `  ${long}  `, client_rating: '4', service_type: 42, updated_at: null }),
                row('SR-1'),
                row('SR-3', { client_feedback: '    ' }),
                row('SR-4', { client_rating: 'n/a' }),
            ],
            error: null,
        });
        const out = await getPublicFeaturedTestimonials(['SR-1', 'SR-GONE', 'SR-2', 'SR-3', 'SR-4']);
        expect(out).toEqual([
            { id: opaqueId('SR-1'), rating: 5, quote: 'Feedback SR-1', serviceType: 'Rescue', ratedAt: '2026-03-15' },
            { id: opaqueId('SR-2'), rating: 4, quote: 'x'.repeat(600), serviceType: '', ratedAt: '' },
            { id: opaqueId('SR-4'), rating: 0, quote: 'Feedback SR-4', serviceType: 'Rescue', ratedAt: '2026-03-15' },
        ]);
        // The internal request id never appears as the public id.
        for (const t of out) expect(t.id).toMatch(/^[0-9a-f]{12}$/);
    });

    it('a failed read (data null) publishes nothing', async () => {
        h.state.respond = () => ({ data: null, error: { message: 'boom' } });
        expect(await getPublicFeaturedTestimonials(['SR-1'])).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('getPublicServicesForOrg', () => {
    it('reads active service types ordered by name and exposes only the 4 display fields', async () => {
        h.state.respond = () => ({
            data: [
                { name: 'Rescue', icon: 'fa-x', color: '#fff', description: 'Saves', is_active: true, internal: 'no' },
                { name: 7, icon: null, color: undefined, description: {}, is_active: true },
            ],
            error: null,
        });
        const out = await getPublicServicesForOrg();
        expect(h.state.queries).toEqual([{
            table: 'service_types',
            calls: [
                { m: 'select', a: ['name, icon, color, description, is_active'] },
                { m: 'eq', a: ['is_active', true] },
                { m: 'order', a: ['name'] },
            ],
        }]);
        expect(out).toEqual([
            { name: 'Rescue', icon: 'fa-x', color: '#fff', description: 'Saves' },
            { name: '', icon: '', color: '', description: '' },
        ]);
    });

    it('a failed read yields no services', async () => {
        h.state.respond = () => ({ data: null, error: { message: 'boom' } });
        expect(await getPublicServicesForOrg()).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
describe('getTestimonialCandidates (authenticated admin picker)', () => {
    const isCount = (q: { calls: Array<{ m: string; a: unknown[] }> }) =>
        q.calls.some((c) => c.m === 'select' && (c.a[1] as { head?: boolean } | undefined)?.head === true);

    it('issues a head count + a page read over rated rows, default page 50 from 0', async () => {
        h.state.respond = (q) => isCount(q)
            ? { count: 2, data: null, error: null }
            : { data: [{ id: 'SR-1', client_rating: 5, client_feedback: '  great  ', service_type: 'Rescue', updated_at: '2026-01-02T03:04:05Z' }], error: null };
        const res = await getTestimonialCandidates();
        const [countQ, dataQ] = h.state.queries;
        expect(countQ).toEqual({
            table: 'service_requests',
            calls: [{ m: 'select', a: ['id', { count: 'exact', head: true }] }, ...RATED_FILTERS],
        });
        expect(dataQ).toEqual({
            table: 'service_requests',
            calls: [
                { m: 'select', a: ['id, client_rating, client_feedback, service_type, updated_at'] },
                ...RATED_FILTERS,
                { m: 'order', a: ['updated_at', { ascending: false }] },
                { m: 'range', a: [0, 49] },
            ],
        });
        // The admin view carries the INTERNAL id (needed to feature it) but no client identity.
        expect(res).toEqual({
            items: [{ id: 'SR-1', rating: 5, quote: 'great', serviceType: 'Rescue', ratedAt: '2026-01-02' }],
            total: 2,
        });
    });

    it('clamps limit to [1,100] and offset to >= 0', async () => {
        h.state.respond = () => ({ data: [], count: null, error: null });
        await getTestimonialCandidates({ limit: 5000, offset: -20 });
        expect(h.state.queries[1].calls.at(-1)).toEqual({ m: 'range', a: [0, 99] });
        h.state.queries = [];
        await getTestimonialCandidates({ limit: 0, offset: 30 });
        expect(h.state.queries[1].calls.at(-1)).toEqual({ m: 'range', a: [30, 30] });
    });

    it('escapes LIKE metacharacters in the search term on BOTH queries, trimmed and capped at 100', async () => {
        h.state.respond = () => ({ data: [], count: 0, error: null });
        await getTestimonialCandidates({ search: `  50%_off\\*${'y'.repeat(200)}  ` });
        const term = `50%_off\\*${'y'.repeat(200)}`.slice(0, 100);
        const escaped = term.replace(/[\\%_*]/g, (m) => `\\${m}`);
        for (const q of h.state.queries) {
            expect(q.calls).toContainEqual({ m: 'ilike', a: ['client_feedback', `%${escaped}%`] });
        }
        expect(escaped.startsWith('50\\%\\_off\\\\\\*')).toBe(true);
    });

    it('a blank or non-string search adds no ilike filter', async () => {
        h.state.respond = () => ({ data: [], count: 0, error: null });
        await getTestimonialCandidates({ search: '   ' });
        await getTestimonialCandidates({ search: 5 as unknown as string });
        expect(h.state.queries.flatMap((q) => q.calls).some((c) => c.m === 'ilike')).toBe(false);
    });

    it('throws on a page read error (authenticated path fails loudly, not silently empty)', async () => {
        h.state.respond = (q) => isCount(q) ? { count: 3, error: null } : { data: null, error: { message: 'boom' } };
        await expect(getTestimonialCandidates()).rejects.toThrow('Failed to list testimonial candidates');
    });

    it('null data and a null count map to an empty page with total 0; missing fields blank out', async () => {
        h.state.respond = (q) => isCount(q)
            ? { count: null, error: null }
            : { data: [{ id: 'SR-9', client_rating: null, client_feedback: null, service_type: null, updated_at: null }], error: null };
        expect(await getTestimonialCandidates()).toEqual({
            items: [{ id: 'SR-9', rating: 0, quote: '', serviceType: '', ratedAt: '' }],
            total: 0,
        });
        h.state.respond = () => ({ data: null, count: null, error: null });
        expect(await getTestimonialCandidates()).toEqual({ items: [], total: 0 });
    });
});

// ---------------------------------------------------------------------------
describe('verifyFeaturedTestimonialIdsBelongToOrg (save-time gate)', () => {
    it.each([[[]], [undefined], ['SR-1']])('accepts %j without a query', async (ids) => {
        expect(await verifyFeaturedTestimonialIdsBelongToOrg(ids as unknown as string[])).toEqual({ ok: true, invalidIds: [] });
        expect(h.state.queries).toEqual([]);
    });

    it('selects only id over rated rows with feedback and reports the ids that did not resolve', async () => {
        h.state.respond = () => ({ data: [{ id: 'SR-1' }, { id: 'SR-3' }], error: null });
        const res = await verifyFeaturedTestimonialIdsBelongToOrg(['SR-1', 'SR-2', 'SR-3']);
        expect(h.state.queries).toEqual([{
            table: 'service_requests',
            calls: [{ m: 'select', a: ['id'] }, { m: 'in', a: ['id', ['SR-1', 'SR-2', 'SR-3']] }, ...RATED_FILTERS],
        }]);
        expect(res).toEqual({ ok: false, invalidIds: ['SR-2'] });
    });

    it('all ids resolving is ok', async () => {
        h.state.respond = () => ({ data: [{ id: 'SR-1' }], error: null });
        expect(await verifyFeaturedTestimonialIdsBelongToOrg(['SR-1'])).toEqual({ ok: true, invalidIds: [] });
    });

    it('FAILS CLOSED on a read error: every id is reported invalid', async () => {
        h.state.respond = () => ({ data: null, error: { message: 'boom' } });
        expect(await verifyFeaturedTestimonialIdsBelongToOrg(['SR-1', 'SR-2'])).toEqual({ ok: false, invalidIds: ['SR-1', 'SR-2'] });
    });
});
