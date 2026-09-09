import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// lib/orgMediaGc.ts performs the ONLY live storage delete in the codebase, and every one of
// its safety properties is structural: gatherReferencedKeys THROWS rather than defaulting to
// an empty set, an object with an unreadable age is KEPT, a 48h grace window protects
// upload-before-save, and a bucket whose reference set came back empty is skipped entirely.
// A single refactor turning one of those throws into a `?? []` silently converts the nightly
// sweep into "delete everything". None of it was pinned before this file existed.

const h = vi.hoisted(() => ({
    // Table reads: table name -> { data, error }
    tables: new Map<string, { data: unknown[] | null; error: unknown }>(),
    // Storage listings: bucket -> prefix -> array of entries
    listings: new Map<string, Map<string, Array<{ name: string; id: string | null; created_at?: string | null; metadata?: { size?: number } }>>>(),
    listError: null as unknown,
    removed: [] as Array<{ bucket: string; keys: string[] }>,
    removeError: null as unknown,
    pageReads: [] as Array<{ table: string; from: number; to: number }>,
}));

vi.mock('../lib/supabaseServer.js', () => ({
    supabase: {
        // Chainable, and it honours .range() for real — gatherReferencedKeys now PAGES
        // every read, and a mock that ignored range would let a regression to a single
        // unpaged read pass unnoticed. h.pageReads records every window requested so a
        // test can assert the loop actually walked past the first page.
        from: (table: string) => {
            const b: Record<string, unknown> = {};
            let from = 0, to = Number.MAX_SAFE_INTEGER;
            const settle = () => {
                const entry = h.tables.get(table) ?? { data: [], error: null };
                if (entry.error) return { data: null, error: entry.error };
                h.pageReads.push({ table, from, to });
                return { data: (entry.data ?? []).slice(from, to + 1), error: null };
            };
            b.select = () => b;
            b.order = () => b;
            b.range = (f: number, t: number) => { from = f; to = t; return b; };
            b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(settle()).then(res, rej);
            return b;
        },
        storage: {
            from: (bucket: string) => ({
                list: async (prefix: string) => {
                    if (h.listError) return { data: null, error: h.listError };
                    const forBucket = h.listings.get(bucket);
                    return { data: forBucket?.get(prefix) ?? [], error: null };
                },
                remove: async (keys: string[]) => {
                    h.removed.push({ bucket, keys });
                    return { error: h.removeError };
                },
            }),
        },
    },
}));

import { runOrgMediaGc } from '../lib/orgMediaGc';
import { PUBLIC_BUCKET, PRIVATE_BUCKET } from '../lib/storage';

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const old = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

/** Register one object under `media/<feature>/<name>` in a bucket. */
function putObject(bucket: string, feature: string, name: string, createdAt: string | null) {
    let forBucket = h.listings.get(bucket);
    if (!forBucket) { forBucket = new Map(); h.listings.set(bucket, forBucket); }
    // Top level of `media/` lists FEATURE FOLDERS (id null); the file lives one level down.
    const folders = forBucket.get('media') ?? [];
    if (!folders.some(f => f.name === feature)) folders.push({ name: feature, id: null });
    forBucket.set('media', folders);
    const files = forBucket.get(`media/${feature}`) ?? [];
    files.push({ name, id: `id-${name}`, created_at: createdAt, metadata: { size: 10 } });
    forBucket.set(`media/${feature}`, files);
}

/** How a PUBLIC-bucket object is actually stored in a row: a full public URL. A bare
 *  `media/…` key always resolves to the PRIVATE bucket, so a bare key never keeps a public
 *  object alive — which is exactly what made the first draft of these fixtures wrong. */
const publicUrl = (key: string) => `https://proj.supabase.co/storage/v1/object/public/${PUBLIC_BUCKET}/${key}`;

/** Make a settings row that references `ref`, so the referenced set is non-empty. */
function settingsReferencing(...refs: string[]) {
    h.tables.set('settings', { data: refs.map(r => ({ value: { iconUrl: r } })), error: null });
}

beforeEach(() => {
    h.tables = new Map();
    h.listings = new Map();
    h.listError = null;
    h.removed = [];
    h.removeError = null;
    h.pageReads = [];
    delete process.env.MEDIA_GC_DRY_RUN;
});

afterEach(() => { delete process.env.MEDIA_GC_DRY_RUN; });

describe('orgMediaGc — reclaims orphans', () => {
    it('deletes an unreferenced object past the grace window', async () => {
        settingsReferencing(publicUrl('media/rank/keep.webp'));
        putObject(PUBLIC_BUCKET, 'rank', 'keep.webp', old(200));
        putObject(PUBLIC_BUCKET, 'rank', 'orphan.webp', old(200));
        await runOrgMediaGc(NOW);
        expect(h.removed).toEqual([{ bucket: PUBLIC_BUCKET, keys: ['media/rank/orphan.webp'] }]);
    });

    it('keeps an object that a settings row still references', async () => {
        settingsReferencing(publicUrl('media/rank/keep.webp'));
        putObject(PUBLIC_BUCKET, 'rank', 'keep.webp', old(200));
        await runOrgMediaGc(NOW);
        expect(h.removed).toEqual([]);
    });

    it('keeps an object still inside the 48h grace window', async () => {
        // Upload happens on file-pick, BEFORE the form is saved — so a just-uploaded object is
        // legitimately unreferenced. Deleting it would destroy an in-flight edit.
        settingsReferencing(publicUrl('media/rank/keep.webp'));
        putObject(PUBLIC_BUCKET, 'rank', 'keep.webp', old(200));
        putObject(PUBLIC_BUCKET, 'rank', 'just-uploaded.webp', old(1));
        await runOrgMediaGc(NOW);
        expect(h.removed).toEqual([]);
    });

    it('keeps an object whose age is unreadable', async () => {
        settingsReferencing(publicUrl('media/rank/keep.webp'));
        putObject(PUBLIC_BUCKET, 'rank', 'keep.webp', old(200));
        putObject(PUBLIC_BUCKET, 'rank', 'no-age.webp', null);
        putObject(PUBLIC_BUCKET, 'rank', 'bad-age.webp', 'not-a-date');
        await runOrgMediaGc(NOW);
        expect(h.removed).toEqual([]);
    });

    it('finds keys embedded in rich-text documents, not just image columns', async () => {
        h.tables.set('settings', { data: [], error: null });
        h.tables.set('wiki_pages', {
            data: [{ content: { type: 'doc', content: [{ type: 'image', attrs: { src: 'media/wiki/in-a-page.webp' } }] } }],
            error: null,
        });
        putObject(PRIVATE_BUCKET, 'wiki', 'in-a-page.webp', old(200));
        putObject(PRIVATE_BUCKET, 'wiki', 'orphan.webp', old(200));
        await runOrgMediaGc(NOW);
        expect(h.removed).toEqual([{ bucket: PRIVATE_BUCKET, keys: ['media/wiki/orphan.webp'] }]);
    });
});

describe('orgMediaGc — fail-safe: never delete on an incomplete picture', () => {
    it('deletes NOTHING when the settings read errors', async () => {
        h.tables.set('settings', { data: null, error: { message: 'boom' } });
        putObject(PUBLIC_BUCKET, 'rank', 'orphan.webp', old(200));
        await runOrgMediaGc(NOW);
        expect(h.removed).toEqual([]);
    });

    it('deletes NOTHING when a rich-text document read errors', async () => {
        // An error here means "we cannot see which images pages reference". Every private
        // object would look unreferenced. The run must abort, not sweep.
        settingsReferencing(publicUrl('media/rank/keep.webp'));
        h.tables.set('wiki_pages', { data: null, error: { message: 'boom' } });
        putObject(PRIVATE_BUCKET, 'wiki', 'orphan.webp', old(200));
        await runOrgMediaGc(NOW);
        expect(h.removed).toEqual([]);
    });

    it('deletes NOTHING when the bucket listing errors', async () => {
        settingsReferencing(publicUrl('media/rank/keep.webp'));
        h.listError = { message: 'listing unavailable' };
        putObject(PUBLIC_BUCKET, 'rank', 'orphan.webp', old(200));
        await runOrgMediaGc(NOW);
        expect(h.removed).toEqual([]);
    });

    // THE ONE THE THROW DOES NOT COVER. A query that SUCCEEDS but returns rows whose refs no
    // longer parse yields a legitimately-empty reference set, and the sweep would read that as
    // "nothing is referenced, delete everything". The realistic trigger is a stored-URL origin
    // change (custom domain, proxy swap, project restore, staging->prod dump). The grace window
    // is no protection: every object already in the bucket is older than 48h.
    it('skips a bucket whose reference set is empty while objects exist', async () => {
        h.tables.set('settings', { data: [{ value: { iconUrl: 'https://cdn.example.com/external-only.png' } }], error: null });
        putObject(PUBLIC_BUCKET, 'rank', 'a.webp', old(200));
        putObject(PUBLIC_BUCKET, 'rank', 'b.webp', old(200));
        await runOrgMediaGc(NOW);
        expect(h.removed).toEqual([]);
    });

    // The cost of the guard above, stated so it is a choice and not a surprise: an org that
    // genuinely dereferences every object in a bucket leaks those objects rather than
    // reclaiming them. Leaking a few objects is strictly better than deleting live ones, and
    // the skip is logged. This test exists so the trade-off is visible, not to endorse it.
    it('leaks (does not reclaim) when a bucket legitimately has zero references', async () => {
        h.tables.set('settings', { data: [], error: null });
        putObject(PRIVATE_BUCKET, 'wiki', 'genuinely-orphaned.webp', old(200));
        await runOrgMediaGc(NOW);
        expect(h.removed).toEqual([]);
    });

    it('dry run logs but never deletes', async () => {
        process.env.MEDIA_GC_DRY_RUN = 'true';
        settingsReferencing(publicUrl('media/rank/keep.webp'));
        putObject(PUBLIC_BUCKET, 'rank', 'keep.webp', old(200));
        putObject(PUBLIC_BUCKET, 'rank', 'orphan.webp', old(200));
        await runOrgMediaGc(NOW);
        expect(h.removed).toEqual([]);
    });

    it('never throws out of the cron entry point', async () => {
        h.tables.set('settings', { data: null, error: { message: 'boom' } });
        await expect(runOrgMediaGc(NOW)).resolves.toBeUndefined();
    });
});

describe('lib/storage — no actor-invoked delete helper', () => {
    // Object reclamation belongs to the GC's leased sweep, which is the only thing that can
    // check "no OTHER document references this key" and "past the grace window". A per-ref
    // delete helper cannot make either guarantee and orphans live images on other pages. One
    // existed here, unused, with no caller since the commit that introduced it.
    it('exposes no per-ref delete function', () => {
        const src = readFileSync(join(process.cwd(), 'lib', 'storage.ts'), 'utf8');
        expect(src).not.toMatch(/export\s+async\s+function\s+remove/);
        expect(src).not.toMatch(/\.remove\(/);
    });
});

describe('orgMediaGc — the reference set must be EXHAUSTIVE, not just error-free', () => {
    // The sharpest edge in this file. Every read in gatherReferencedKeys used to be
    // unbounded, and PostgREST answers an unbounded select with its server-side maximum,
    // a 200, and no error. That does not fail — it silently returns a SMALLER reference
    // set, and every row past the cap becomes an "unreferenced" object this job deletes.
    // The 48h grace window is no protection: those objects are all older than that.
    //
    // Not hypothetical: quartermaster_catalog is UEX-sourced (5,600+ rows by its own
    // comment in lib/db/quartermaster.ts) and wiki_pages grows without bound.
    const bigCatalog = (n: number) => ({
        data: Array.from({ length: n }, (_, i) => ({ thumbnail_url: `media/qm/item-${i}.webp`, id: i })),
        error: null,
    });

    it('pages past the first 1000 rows, so row 1001 still counts as referenced', async () => {
        h.tables.set('settings', { data: [], error: null });
        h.tables.set('quartermaster_catalog', bigCatalog(1500));
        // An object referenced ONLY by a row beyond the first page.
        putObject(PRIVATE_BUCKET, 'qm', 'item-1200.webp', old(200));
        await runOrgMediaGc(NOW);
        expect(h.removed, 'a live image past the first page was deleted').toEqual([]);
    });

    it('actually walks the pages — the loop is not a single wide read', async () => {
        h.tables.set('settings', { data: [], error: null });
        h.tables.set('quartermaster_catalog', bigCatalog(2500));
        await runOrgMediaGc(NOW);
        const windows = h.pageReads.filter(r => r.table === 'quartermaster_catalog').map(r => `${r.from}-${r.to}`);
        // 0-999, 1000-1999, 2000-2999 (the last comes back short and ends the loop).
        expect(windows).toEqual(['0-999', '1000-1999', '2000-2999']);
    });

    it('stops at the first short page rather than reading forever', async () => {
        h.tables.set('settings', { data: [], error: null });
        h.tables.set('ranks', { data: [{ icon_url: 'media/rank/a.webp', id: 1 }], error: null });
        await runOrgMediaGc(NOW);
        expect(h.pageReads.filter(r => r.table === 'ranks')).toHaveLength(1);
    });

    it('a read error still aborts the whole sweep, from inside the paging loop', async () => {
        // The paging rewrite must not have swallowed the throw the file is built on.
        h.tables.set('settings', { data: [], error: null });
        h.tables.set('wiki_pages', { data: null, error: { message: 'boom' } });
        putObject(PUBLIC_BUCKET, 'rank', 'orphan.webp', old(200));
        await runOrgMediaGc(NOW);
        expect(h.removed).toEqual([]);
    });
});
