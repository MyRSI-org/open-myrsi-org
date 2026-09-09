// Daily sweep that reclaims orphaned uploaded images — objects in the media buckets that
// no current field or rich-text document references any more (replaced images, uploads that
// were never saved, and so on).
//
// The whole design is "never delete a live image":
//   * The referenced-key set is built from EVERY place an image can be stored (all settings
//     rows, every image column, and every rich-text document). If any query errors, the run
//     THROWS and is skipped — an incomplete set must never drive deletes. It deliberately
//     avoids the swallow-and-default read path, which could fake an empty set.
//   * A grace window protects just-uploaded objects (upload happens on file-pick, before the
//     form is saved) and in-flight edits; an object with no readable age is kept.
//   * MEDIA_GC_DRY_RUN=true logs what it WOULD delete without deleting.

import { supabase } from './supabaseServer.js';
import { collectImageSrcs, tryParseTiptapJson } from './tiptapValidate.js';
import { classifyOrgMediaRef, orgMediaKeyFromUrl, listOrgMediaObjects, PUBLIC_BUCKET, PRIVATE_BUCKET } from './storage.js';
import { log as baseLog } from './log.js';

const log = baseLog.child({ module: 'lib.orgMediaGc' });

/** Objects younger than this are kept (protects upload-before-save + in-flight edits). */
const GRACE_MS = 48 * 60 * 60 * 1000;

interface ReferencedKeys { public: Set<string>; private: Set<string> }

/**
 * EVERY read below must be EXHAUSTIVE, and that is the difference between this job
 * reclaiming disk and this job deleting live images.
 *
 * PostgREST caps an unbounded select at its server-side maximum and returns the short
 * page with a 200 and no error. These reads build the "still referenced" set, so a
 * truncated read does not fail — it silently produces a SMALLER reference set, and
 * every row past the cap becomes an unreferenced object this job then deletes. The
 * grace window is no protection: those objects are all older than 48h.
 *
 * It is not hypothetical either. `quartermaster_catalog` is UEX-sourced and its own
 * comment in lib/db/quartermaster.ts puts it at 5,600+ rows, and `wiki_pages` grows
 * without bound — both were read unpaged.
 *
 * So: page every read to exhaustion, and REFUSE rather than sweep if a table is larger
 * than the ceiling. The builder is passed as a factory so each call site keeps its
 * `.select('…')` as a string literal — a dynamic select argument would also opt the
 * call out of tests/wildcardSelectRatchet.test.ts, which is the rule that keeps these
 * column lists honest.
 */
const GC_PAGE = 1000;
const GC_MAX_PAGES = 200;

async function readAllPaged<T>(
    table: string,
    build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < GC_MAX_PAGES; page++) {
        const from = page * GC_PAGE;
        const { data, error } = await build(from, from + GC_PAGE - 1);
        if (error) throw error;
        const rows = (data || []) as T[];
        out.push(...rows);
        if (rows.length < GC_PAGE) return out;
    }
    // Deliberately a throw, not a truncation: the caller skips the whole sweep on a
    // throw, and skipping costs disk while continuing costs somebody's images.
    throw new Error(`media gc: ${table} exceeded ${GC_MAX_PAGES * GC_PAGE} rows; refusing to sweep on a partial reference set`);
}

/**
 * Build the complete set of referenced object keys (split by bucket). THROWS on any query
 * error — the caller must skip the sweep on throw (no deletes on an incomplete set).
 */
async function gatherReferencedKeys(): Promise<ReferencedKeys> {
    const pub = new Set<string>();
    const priv = new Set<string>();

    const addRef = (ref: unknown) => {
        if (typeof ref !== 'string' || !ref) return;
        const parsed = orgMediaKeyFromUrl(ref); // a public URL OR a bare private key
        if (parsed) (parsed.bucket === PUBLIC_BUCKET ? pub : priv).add(parsed.key);
        const c = classifyOrgMediaRef(ref); // also catches a private SIGNED url
        if (c.kind === 'own-private') priv.add(c.key);
    };
    const addDoc = (doc: unknown) => {
        const parsed = typeof doc === 'string' ? tryParseTiptapJson(doc) : doc;
        for (const src of collectImageSrcs(parsed)) addRef(src);
    };
    // Settings values are nested config blobs. Pull every string (image URLs/keys) and every
    // embedded rich-text doc (e.g. the wiki home welcome content) out of them, so no
    // image-bearing settings key can be missed.
    const walkSettingValue = (val: unknown) => {
        if (typeof val === 'string') { addRef(val); return; }
        if (Array.isArray(val)) { for (const v of val) walkSettingValue(v); return; }
        if (val && typeof val === 'object') {
            addDoc(val);
            for (const v of Object.values(val)) walkSettingValue(v);
        }
    };

    // 1) All settings rows (branding, metadata, public page, hero card, wiki home, alliance
    //    self-profile, ...). Ordered by `key`, its primary key — `settings` is the one table
    //    here with no `id` column.
    const settingsRows = await readAllPaged<{ value: unknown }>('settings', (f, t) =>
        supabase.from('settings').select('value, key').order('key', { ascending: true }).range(f, t));
    for (const row of settingsRows) walkSettingValue(row.value);

    // 2) Row image columns.
    const ranks = await readAllPaged<{ icon_url?: string }>('ranks', (f, t) =>
        supabase.from('ranks').select('icon_url, id').order('id', { ascending: true }).range(f, t));
    const units = await readAllPaged<{ logo_url?: string; banner_url?: string }>('units', (f, t) =>
        supabase.from('units').select('logo_url, banner_url, id').order('id', { ascending: true }).range(f, t));
    const tags = await readAllPaged<{ image_url?: string }>('specialization_tags', (f, t) =>
        supabase.from('specialization_tags').select('image_url, id').order('id', { ascending: true }).range(f, t));
    const certs = await readAllPaged<{ image_url?: string }>('certifications', (f, t) =>
        supabase.from('certifications').select('image_url, id').order('id', { ascending: true }).range(f, t));
    const commends = await readAllPaged<{ image_url?: string }>('commendations', (f, t) =>
        supabase.from('commendations').select('image_url, id').order('id', { ascending: true }).range(f, t));
    const catalog = await readAllPaged<{ thumbnail_url?: string; screenshot_url?: string }>('quartermaster_catalog', (f, t) =>
        supabase.from('quartermaster_catalog').select('thumbnail_url, screenshot_url, id').order('id', { ascending: true }).range(f, t));
    const courses = await readAllPaged<{ image_url?: string }>('academy_courses', (f, t) =>
        supabase.from('academy_courses').select('image_url, id').order('id', { ascending: true }).range(f, t));

    for (const r of ranks) addRef(r.icon_url);
    for (const r of units) { addRef(r.logo_url); addRef(r.banner_url); }
    for (const r of [...tags, ...certs, ...commends, ...courses]) addRef(r.image_url);
    for (const r of catalog) { addRef(r.thumbnail_url); addRef(r.screenshot_url); }

    // 3) Rich-text document columns (private keys embedded in bodies).
    const wikiPages = await readAllPaged<{ content?: unknown }>('wiki_pages', (f, t) =>
        supabase.from('wiki_pages').select('content, id').order('id', { ascending: true }).range(f, t));
    const govConfigs = await readAllPaged<{ constitution_content?: unknown }>('government_configs', (f, t) =>
        supabase.from('government_configs').select('constitution_content, id').order('id', { ascending: true }).range(f, t));
    const legislation = await readAllPaged<{ body?: unknown }>('government_legislation', (f, t) =>
        supabase.from('government_legislation').select('body, id').order('id', { ascending: true }).range(f, t));

    for (const r of wikiPages) addDoc(r.content);
    for (const r of govConfigs) addDoc(r.constitution_content);
    for (const r of legislation) addDoc(r.body);

    return { public: pub, private: priv };
}

/**
 * List actual objects in both buckets and delete those NOT referenced AND older than the
 * grace window. THROWS if gathering or a listing throws, so the caller skips the run.
 */
async function sweep(now: number, dryRun: boolean): Promise<{ deleted: number; kept: number }> {
    const referenced = await gatherReferencedKeys();
    let deleted = 0;
    let kept = 0;
    const buckets: Array<[string, Set<string>]> = [
        [PUBLIC_BUCKET, referenced.public],
        [PRIVATE_BUCKET, referenced.private],
    ];
    for (const [bucket, refSet] of buckets) {
        const objects = await listOrgMediaObjects(bucket);
        // FAIL-SAFE: "nothing is referenced" is far more likely to be a broken reference set
        // than a genuinely empty org. gatherReferencedKeys throws on a query ERROR, but a
        // query that SUCCEEDS and returns rows whose refs no longer parse yields a
        // legitimately-empty set — and this loop would read that as "delete everything".
        // The 48h grace window does not bound it: every object already in the bucket is older
        // than that. The realistic trigger is a stored-URL origin change (custom domain,
        // proxy swap, project restore, staging→prod dump), which is precisely why the read-
        // side parser is deliberately NOT origin-checked. Belt and braces: skip the bucket.
        if (refSet.size === 0 && objects.length > 0) {
            log.warn('media gc skipped: empty reference set with objects present', { bucket, objects: objects.length });
            kept += objects.length;
            continue;
        }
        const toDelete: string[] = [];
        for (const obj of objects) {
            if (refSet.has(obj.key)) { kept++; continue; }
            const ageMs = obj.createdAt ? now - new Date(obj.createdAt).getTime() : NaN;
            if (!Number.isFinite(ageMs) || ageMs < GRACE_MS) { kept++; continue; } // unknown age or in grace → keep
            toDelete.push(obj.key);
        }
        if (toDelete.length === 0) continue;
        if (dryRun) {
            log.info('media gc dry-run would delete', { bucket, count: toDelete.length, keys: toDelete.slice(0, 20) });
            continue;
        }
        for (let i = 0; i < toDelete.length; i += 1000) {
            const batch = toDelete.slice(i, i + 1000);
            const { error } = await supabase.storage.from(bucket).remove(batch);
            if (error) { log.warn('media gc delete failed', { err: error, bucket, count: batch.length }); continue; }
            deleted += batch.length;
            log.info('media gc reclaimed', { bucket, count: batch.length });
        }
    }
    return { deleted, kept };
}

/**
 * Reclaim orphaned uploaded images. Fail-safe: any error skips the run (never deletes on an
 * incomplete reference set). Set MEDIA_GC_DRY_RUN=true to log-only. Called from the daily
 * leased cron in server.ts.
 */
export async function runOrgMediaGc(now: number = Date.now()): Promise<void> {
    const dryRun = process.env.MEDIA_GC_DRY_RUN === 'true';
    try {
        const { deleted, kept } = await sweep(now, dryRun);
        log.info('media gc complete', { deleted, kept, dryRun });
    } catch (e) {
        log.warn('media gc skipped (fail-safe — no deletes on error)', { err: e });
    }
}
