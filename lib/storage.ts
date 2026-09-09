// Server-side native image uploads (single-org self-hosted).
//
// SECURITY MODEL: uploads are server-proxied via the service-role client — the
// browser NEVER writes to Storage directly. The buckets have NO anon/authenticated
// write policy (and no SELECT policy — see schema.sql §Storage), so the bundled anon
// key can neither write nor LIST objects; storage RLS fails closed. Every byte that
// lands is magic-byte-sniffed AND fully re-encoded through sharp (EXIF/metadata
// stripped, dimensions capped, transcoded to WebP), so a renamed non-image, an SVG
// (script-bearing), a polyglot, or a decode bomb is rejected before it is stored.
//
// Two buckets, chosen per feature (ORG_MEDIA_FEATURES):
//   * org-public-media (public-read)  — branding/logos/ranks/etc. the SSR/social
//     crawlers, PWA manifest and Discord embeds must fetch without a session. Stores a
//     PUBLIC URL.
//   * org-media (PRIVATE)             — clearance/marker-gated wiki + government rich
//     text. Stores the object KEY; reads mint short-lived signed URLs behind the page's
//     permission gate.
//
// Single-org: object keys are `media/{feature}/{uuid}.webp` (no per-org segment). The
// fixed `media/` prefix is the marker that lets URL/key parsers tell OUR objects apart
// from an external image URL. Random uuid filename → no path traversal.

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { supabase } from './supabaseServer.js';
import { log as baseLog } from './log.js';

const log = baseLog.child({ module: 'lib.storage' });

export const PUBLIC_BUCKET = 'org-public-media';
export const PRIVATE_BUCKET = 'org-media';
/** Fixed object-key namespace prefix (single-org: no per-org id). A stored ref that
 *  starts with this is one of OUR objects; anything else is an external URL. */
const KEY_PREFIX = 'media';

/** Read a positive-integer byte count from an env var, else the default. */
function envBytes(name: string, def: number): number {
    const raw = process.env[name];
    if (!raw) return def;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/** Per-upload byte cap. Self-hosters own their own Supabase, so this is env-tunable
 *  (MEDIA_MAX_UPLOAD_BYTES). Enforced by express.raw (route), here (pre + post transform)
 *  AND the bucket file_size_limit (the hard ceiling — raise it in schema.sql if you set
 *  this above it). Default 5 MiB. */
export const MAX_UPLOAD_BYTES = envBytes('MEDIA_MAX_UPLOAD_BYTES', 5 * 1024 * 1024);
/** Total storage cap across BOTH buckets (abuse bound). Env-tunable
 *  (MEDIA_MAX_STORAGE_BYTES); default 250 MiB. An upload that would exceed it is rejected. */
export const MAX_STORAGE_BYTES = envBytes('MEDIA_MAX_STORAGE_BYTES', 250 * 1024 * 1024);
/** Read a positive-integer seconds value from an env var, else the default. Clamped to
 *  [60, 86400] so a fat-fingered value cannot mint a day-long URL or a 1-second one. */
function envSeconds(name: string, def: number): number {
    const raw = process.env[name];
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return def;
    return Math.min(86400, Math.max(60, Math.floor(n)));
}

/** Signed-URL lifetimes, split by how the URL is CONSUMED. Both env-tunable — a self-hoster
 *  owns their own Supabase and their own tolerance for re-signing traffic.
 *
 *  These are FLOORS in practice: a Supabase signed URL cannot be renewed, only re-minted,
 *  and nothing on the client re-mints on a timer — a page left open past the TTL shows
 *  broken images until its view refetches. Do not drop READ below ~15 minutes without first
 *  giving the client a re-sign trigger. Note the stored objects carry a one-year
 *  `cacheControl` (see uploadOrgMedia), so each re-sign is a new cache key and a full
 *  re-download: that, not the round-trip, is the real cost ceiling on lowering READ.
 *
 *  READ   — hydrated into a document a permitted client is rendering right now. Every
 *           consumer (wiki view mount, wiki_page_slice, government view mount, legislation
 *           list) refetches on mount and on realtime, so a short life costs only re-signing.
 *  EDITOR — the preview URL handed back from an upload, which sits in an open editor until
 *           the author saves. Deliberately the longer of the two: an author can compose for
 *           an hour. Expiry is cosmetic here — classifyOrgMediaRef parses the PATH and never
 *           the `?token=`, so an EXPIRED preview URL still normalises to the correct key on
 *           save. That property is load-bearing; it is pinned by a test. */
export const SIGN_TTL_READ = envSeconds('MEDIA_SIGN_TTL_SECONDS', 900);
export const SIGN_TTL_EDITOR = envSeconds('MEDIA_SIGN_TTL_EDITOR_SECONDS', 3600);

/** Longest-edge cap applied by sharp; bounds stored bytes + downstream render cost. */
const MEDIA_MAX_DIMENSION = 2048;
/** Decoded-pixel cap ("decode bomb" defense — a small-COMPRESSED but huge-DIMENSION
 *  image would otherwise materialise a multi-GB raster; the byte caps only bound
 *  compressed size). ~24MP covers legitimate photos while rejecting the 16k×16k class. */
const MEDIA_MAX_PIXELS = 24_000_000;

export interface DetectedImage { ext: string; contentType: string }

/**
 * Magic-byte sniff. Trusts the BYTES, never the client's Content-Type / filename.
 * Returns the canonical extension + content-type for a recognised raster image, or null
 * for anything else (incl. SVG — which is text and matches no signature). Pure.
 */
export function detectImageType(buf: Buffer): DetectedImage | null {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { ext: 'png', contentType: 'image/png' };
    }
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return { ext: 'jpg', contentType: 'image/jpeg' };
    }
    // GIF: "GIF8" (covers 87a / 89a)
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        return { ext: 'gif', contentType: 'image/gif' };
    }
    // WEBP: "RIFF" .... "WEBP"
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
        return { ext: 'webp', contentType: 'image/webp' };
    }
    // AVIF: ISO-BMFF "ftyp" box (bytes 4..8) with an avif/avis brand.
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
        const brand = buf.toString('ascii', 8, 12);
        if (brand === 'avif' || brand === 'avis') return { ext: 'avif', contentType: 'image/avif' };
    }
    return null;
}

export type OrgMediaVisibility = 'public' | 'private';
// Each feature is 1:1 with the permission that gates its write RPC (see
// FEATURE_UPLOAD_PERMS in api/orgUploadPerms.ts + orgUploadPermParity.test.ts). The
// award/government families are split by sub-type because their write perms differ.
export type OrgMediaFeature =
    | 'branding'
    | 'site-metadata'
    | 'public-page'
    | 'hero-card'
    | 'rank'
    | 'unit'
    | 'specialization'
    | 'certification'
    | 'commendation'
    | 'alliance'
    | 'quartermaster'
    | 'catalog'
    | 'wiki'
    | 'government'
    | 'legislation'
    | 'academy';

interface OrgMediaFeatureDef { bucket: string; visibility: OrgMediaVisibility }

/** Single source of truth for which bucket (and thus visibility) each upload feature
 *  uses. The endpoint's feature allowlist + FEATURE_UPLOAD_PERMS key off these names. */
export const ORG_MEDIA_FEATURES: Record<OrgMediaFeature, OrgMediaFeatureDef> = {
    branding: { bucket: PUBLIC_BUCKET, visibility: 'public' },
    'site-metadata': { bucket: PUBLIC_BUCKET, visibility: 'public' },
    'public-page': { bucket: PUBLIC_BUCKET, visibility: 'public' },
    'hero-card': { bucket: PUBLIC_BUCKET, visibility: 'public' },
    rank: { bucket: PUBLIC_BUCKET, visibility: 'public' },
    unit: { bucket: PUBLIC_BUCKET, visibility: 'public' },
    specialization: { bucket: PUBLIC_BUCKET, visibility: 'public' },
    certification: { bucket: PUBLIC_BUCKET, visibility: 'public' },
    commendation: { bucket: PUBLIC_BUCKET, visibility: 'public' },
    alliance: { bucket: PUBLIC_BUCKET, visibility: 'public' },
    quartermaster: { bucket: PUBLIC_BUCKET, visibility: 'public' },
    // PLATFORM item-catalog thumbnails — quartermaster_catalog WHERE source='platform',
    // written by catalog:update_item / admin:config:catalog in the UNGATED catalog:
    // namespace. Deliberately separate from `quartermaster` above, which feeds the org's
    // OWN custom rows (source='custom', qm:update_catalog_item / qm:admin) and rides the
    // GATED qm: namespace. One table, two resources, two permissions, two gates.
    // PUBLIC is load-bearing, not stylistic: nothing signs quartermaster_catalog's
    // thumbnail_url on read — it is mapped straight to the wire (lib/db/mappers.ts) and
    // rendered as a bare <img src>, so a private-bucket key would render broken
    // everywhere an item thumbnail appears.
    catalog: { bucket: PUBLIC_BUCKET, visibility: 'public' },
    wiki: { bucket: PRIVATE_BUCKET, visibility: 'private' },
    government: { bucket: PRIVATE_BUCKET, visibility: 'private' },
    legislation: { bucket: PRIVATE_BUCKET, visibility: 'private' },
    // Course cover images are shown in the (authed) catalogue — public-read like branding.
    academy: { bucket: PUBLIC_BUCKET, visibility: 'public' },
};

/** Narrowing guard for a client-supplied `?for=` feature string. */
export function isOrgMediaFeature(x: unknown): x is OrgMediaFeature {
    return typeof x === 'string' && Object.prototype.hasOwnProperty.call(ORG_MEDIA_FEATURES, x);
}

export interface OrgUploadResult {
    /** Public URL for a public-bucket upload; a short-lived signed URL for a private one. */
    url: string | null;
    /** Storage object key (`media/{feature}/{uuid}.webp`) — persisted for private uploads + GC. */
    key: string;
    visibility: OrgMediaVisibility;
}

/**
 * Re-encode an arbitrary (already magic-byte-validated) raster buffer to a clean WebP:
 * auto-orient static images from EXIF, cap the longest edge, DROP all metadata (sharp
 * emits no EXIF/ICC/XMP unless withMetadata() is called). The output shares no bytes
 * with the attacker's input — the primary polyglot/metadata scrubber.
 */
async function transformOrgImage(buf: Buffer): Promise<Buffer> {
    // limitInputPixels rejects a decode bomb at decode time; .timeout() bounds runaway
    // processing so a single upload can't pin the shared service-role process.
    const image = sharp(buf, { animated: true, failOn: 'error', limitInputPixels: MEDIA_MAX_PIXELS }).timeout({ seconds: 20 });
    const meta = await image.metadata();
    // Reject an oversized raster from the HEADER (before the full decode). For an ANIMATED
    // image loaded with { animated: true }, sharp stacks frames vertically, so meta.height
    // is already pageHeight*pages — width*height is the total decoded pixel count. Do NOT
    // multiply by pages (that over-counts and wrongly rejects legit animations).
    if (meta.width && meta.height && meta.width * meta.height > MEDIA_MAX_PIXELS) {
        throw new Error('Image dimensions too large');
    }
    // rotate() (EXIF auto-orient) is a no-op / unsupported on multi-frame (animated) images.
    const oriented = (meta.pages && meta.pages > 1) ? image : image.rotate();
    return oriented
        .resize(MEDIA_MAX_DIMENSION, MEDIA_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
}

/**
 * Validate + re-encode + upload an image under `media/{feature}/{uuid}.webp`. Returns a
 * public URL (public bucket) or a short-lived signed URL + the object KEY (private
 * bucket). Throws stable, opaque messages on size/type/upload failure.
 */
export async function uploadOrgMedia(feature: OrgMediaFeature, buf: Buffer): Promise<OrgUploadResult> {
    const def = ORG_MEDIA_FEATURES[feature];
    if (!def) throw new Error('Unsupported or invalid image');
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('Unsupported or invalid image');
    if (buf.length > MAX_UPLOAD_BYTES) throw new Error('Image too large');
    if (!detectImageType(buf)) throw new Error('Unsupported or invalid image');

    let out: Buffer;
    try {
        out = await transformOrgImage(buf);
    } catch (e) {
        // A buffer that passes the magic-byte sniff but sharp refuses to decode is treated
        // as invalid. The cause stays on the Error for server logs; only `.message` is
        // forwarded to the client, so no decoder detail leaks.
        log.warn('org media transform failed', { err: e });
        throw new Error('Unsupported or invalid image', { cause: e });
    }
    if (out.length > MAX_UPLOAD_BYTES) throw new Error('Image too large');

    // HARD storage cap: reject if THIS object would push the deployment over the limit.
    // Ground-truth sum across both buckets (after transform, so it counts actual stored
    // bytes). Bounds the storage bill against a runaway/abusive uploader.
    const used = await getStorageBytes();
    if (used + out.length > MAX_STORAGE_BYTES) throw new Error('Storage limit reached');

    const key = `${KEY_PREFIX}/${feature}/${randomUUID()}.webp`;
    const { error } = await supabase.storage.from(def.bucket).upload(key, out, {
        contentType: 'image/webp',
        cacheControl: '31536000',
        upsert: false,
    });
    if (error) {
        log.error('org media upload failed', { err: error });
        throw new Error('Upload failed');
    }
    if (def.visibility === 'public') {
        const { data } = supabase.storage.from(def.bucket).getPublicUrl(key);
        return { url: data.publicUrl, key, visibility: 'public' };
    }
    // Private: the KEY is what the caller persists. Also return a short-lived signed URL so
    // the editor can display the just-uploaded image immediately (normalised to key on save).
    const signedUrl = await signOrgMediaUrl(key);
    return { url: signedUrl, key, visibility: 'private' };
}

/**
 * Extract the object key that follows `prefix` in a ref, ANCHORED. The prefix must start the
 * URL's PATHNAME — not merely appear somewhere in the string, which is what a bare
 * `indexOf` allowed: `https://evil.example/x/storage/v1/object/public/org-public-media/media/rank/a.webp`
 * used to parse as one of our objects, and that string survives sanitizeImageUrl, so it is
 * reachable from any "paste an image URL" field.
 *
 * `requireOwnOrigin` additionally demands the URL live on THIS deployment's Supabase origin.
 * It is applied on the WRITE side only (classifyOrgMediaRef → normalizeDocMediaForStorage),
 * where a foreign storage-shaped URL would otherwise collapse to a bare key that the read
 * path later signs for anyone permitted to read that document.
 *
 * It is deliberately NOT applied on the read/GC side (orgMediaKeyFromUrl). getPublicUrl bakes
 * the THEN-CURRENT origin into every stored public URL, so any later origin change — a custom
 * domain in front of Supabase, a proxy swap, a project restore, a staging→prod dump, http↔https
 * drift — would make every stored branding/rank/unit/certification URL classify as external,
 * empty the GC's referenced set, and let the next nightly sweep delete every public object
 * (all of which are past the grace window). Matching MORE strings there is the fail-safe
 * direction: a matched ref only ever PROTECTS an object from deletion.
 *
 * `SUPABASE_URL` is read per call, not cached at module load, so the value cannot go stale
 * between a test's env stub and the parse.
 */
function keyAfterPathPrefix(ref: string, prefix: string, requireOwnOrigin: boolean): string | null {
    let pathname: string;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
        let u: URL;
        try { u = new URL(ref); } catch { return null; }
        if (requireOwnOrigin) {
            let ownOrigin: string | null;
            try { ownOrigin = new URL(process.env.SUPABASE_URL ?? '').origin; } catch { ownOrigin = null; }
            if (!ownOrigin || u.origin !== ownOrigin) return null;
        }
        // u.pathname keeps percent-encoding, so a `%2e%2e` traversal still fails the
        // KEY_PREFIX test at the call site. Do NOT decodeURIComponent here — that would
        // CREATE the traversal path this is guarding against.
        pathname = u.pathname;
    } else if (ref.startsWith('/')) {
        pathname = ref.split('?')[0].split('#')[0];
    } else {
        return null;
    }
    if (!pathname.startsWith(prefix)) return null;
    return pathname.slice(prefix.length) || null;
}

/**
 * Resolve a stored ref (a public-bucket URL OR a raw private-bucket key) to its
 * {bucket, key}. Returns null for anything that is not one of OUR objects or that smells
 * like traversal. Used to build the GC's referenced-key set.
 */
export function orgMediaKeyFromUrl(ref: string | null | undefined): { bucket: string; key: string } | null {
    if (typeof ref !== 'string' || !ref) return null;
    // Public bucket: a full `/storage/v1/object/public/org-public-media/…` URL.
    // NOT origin-checked, deliberately — see keyAfterPathPrefix. This parser's only consumer
    // is the GC's reference set, where matching MORE strings is the fail-safe direction.
    const key = keyAfterPathPrefix(ref, `/storage/v1/object/public/${PUBLIC_BUCKET}/`, false);
    if (key !== null) {
        // Anchored on KEY_PREFIX like every other site in this file. The public branch used
        // to check traversal only, so a public URL naming an object outside `media/`
        // resolved. Nothing writes such an object (uploadOrgMedia is the only writer), so
        // this is a tightening, not a behaviour change.
        if (!key.startsWith(`${KEY_PREFIX}/`) || key.includes('..')) return null;
        return { bucket: PUBLIC_BUCKET, key };
    }
    // Private bucket: a raw object key (no scheme/host), stored verbatim in the row.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(ref) && ref.startsWith(`${KEY_PREFIX}/`) && !ref.includes('..')) {
        return { bucket: PRIVATE_BUCKET, key: ref };
    }
    return null;
}

// There is deliberately NO actor-invoked delete helper in this module. Object reclamation is
// the job of lib/orgMediaGc.ts's daily leased sweep, which deletes an object only when (a) no
// settings row, image column or rich-text document references it and (b) it is older than a
// 48h grace window, and which THROWS rather than deletes on an incomplete reference set.
//
// A per-ref delete cannot make either guarantee: a row is not the only place a key can
// appear — the same image can be embedded in several documents — so deleting because "this
// field changed" orphans a live image on another page. If one is ever needed it must take an
// actor and emit recordSecurityEvent, like the denial sites in api/orgUpload.ts.

/**
 * Mint a short-lived signed URL for a PRIVATE-bucket object, for a client that has
 * already passed the page's permission gate. Fail-closed: only signs OUR `media/` keys
 * (no traversal). Returns null on any guard miss or storage error.
 */
export async function signOrgMediaUrl(key: string, ttlSeconds = SIGN_TTL_EDITOR): Promise<string | null> {
    if (typeof key !== 'string' || !key) return null;
    if (!key.startsWith(`${KEY_PREFIX}/`) || key.includes('..')) return null;
    const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(key, ttlSeconds);
    if (error || !data) {
        log.warn('org media sign failed', { err: error });
        return null;
    }
    return data.signedUrl;
}

export type OrgMediaRef =
    | { kind: 'own-private'; key: string }
    | { kind: 'external' };

/**
 * Classify an image `src` from a Tiptap doc. Used by the private-media save-normalise
 * (own-private → store the KEY; external → keep) and read-sign transforms. In a single-org
 * deployment there is no cross-tenant class — a private-bucket ref (bare `media/` key or a
 * signed org-media URL) is ours; anything else (external https, public-bucket URL, shipped
 * asset path) passes through unchanged. A traversal-smelling key is treated as external so
 * it is never stored as one of our keys.
 */
export function classifyOrgMediaRef(ref: unknown): OrgMediaRef {
    if (typeof ref !== 'string' || !ref) return { kind: 'external' };
    // Origin-checked: this is the WRITE side. A foreign URL merely SHAPED like one of our
    // signed URLs must not collapse to a bare key, or the read path would later sign it for
    // every reader permitted to see the document it was pasted into.
    let key = keyAfterPathPrefix(ref, `/storage/v1/object/sign/${PRIVATE_BUCKET}/`, true);
    if (key === null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(ref) && ref.startsWith(`${KEY_PREFIX}/`)) {
        key = ref;
    }
    if (key === null) return { kind: 'external' };
    if (key.includes('..') || !key.startsWith(`${KEY_PREFIX}/`)) return { kind: 'external' };
    return { kind: 'own-private', key };
}

/**
 * Batch-mint signed URLs for a set of private keys (one round-trip via createSignedUrls).
 * Returns a key→signedUrl map; traversal/foreign keys or sign failures are simply absent.
 * Used by the read path to hydrate a permitted client.
 */
export async function signOrgMediaUrls(keys: string[], ttlSeconds = SIGN_TTL_READ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const safe = [...new Set(keys)].filter(k => typeof k === 'string' && k.startsWith(`${KEY_PREFIX}/`) && !k.includes('..'));
    if (safe.length === 0) return out;
    const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrls(safe, ttlSeconds);
    if (error || !data) {
        log.warn('org media batch sign failed', { err: error });
        return out;
    }
    for (const item of data) {
        if (item.path && item.signedUrl) out.set(item.path, item.signedUrl);
    }
    return out;
}

export interface OrgMediaObject { key: string; createdAt: string | null; size: number }

/**
 * List EVERY object under `media/` in a bucket, paginated. Two-level traversal matching
 * the `media/{feature}/{uuid}.webp` layout (feature folders → files). Returns each
 * object's full key + creation timestamp + size. THROWS on any storage error so the GC
 * caller can fail-safe (never delete on an incomplete/failed listing).
 */
export async function listOrgMediaObjects(bucket: string): Promise<OrgMediaObject[]> {
    const out: OrgMediaObject[] = [];
    const { data: folders, error } = await supabase.storage.from(bucket).list(KEY_PREFIX, { limit: 1000 });
    if (error) throw error;
    for (const folder of folders || []) {
        if (folder.id) continue; // feature entries are folders (id null); a stray file here is skipped
        const prefix = `${KEY_PREFIX}/${folder.name}`;
        let offset = 0;
        let done = false;
        while (!done) {
            const { data: files, error: e2 } = await supabase.storage.from(bucket).list(prefix, { limit: 1000, offset });
            if (e2) throw e2;
            const batch = files || [];
            for (const f of batch) {
                if (!f.id) continue; // skip any nested folder
                const createdAt = (f as { created_at?: string | null }).created_at ?? null;
                const size = (f as { metadata?: { size?: number } | null }).metadata?.size ?? 0;
                out.push({ key: `${prefix}/${f.name}`, createdAt, size });
            }
            offset += batch.length;
            if (batch.length < 1000) done = true;
        }
    }
    return out;
}

/**
 * Total bytes currently stored across BOTH media buckets — the ground-truth sum of stored
 * object sizes under `media/`. Reuses the same paginated listing as the GC, so it reflects
 * exactly what is stored (no drifting counter). O(objects) per call — fine at upload frequency.
 */
export async function getStorageBytes(): Promise<number> {
    let total = 0;
    for (const bucket of [PUBLIC_BUCKET, PRIVATE_BUCKET]) {
        for (const o of await listOrgMediaObjects(bucket)) total += o.size;
    }
    return total;
}
