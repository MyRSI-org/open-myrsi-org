// Rich-text image transforms between the private bucket and the client.
//
// The database stores the private object KEY for an uploaded rich-text image; clients only
// ever receive short-lived signed URLs.
//   * SAVE: normalise a doc so our private signed-URLs and bare keys collapse to the key;
//     external images (custom URLs, public-bucket URLs, shipped assets) pass through.
//   * READ (only behind the content's permission + clearance gate): replace private keys
//     with freshly-signed URLs so a permitted client can render them.
// See lib/storage.ts classifyOrgMediaRef for how a ref is classified.

import { collectImageSrcs, mapImageSrcs } from './tiptapValidate.js';
import { classifyOrgMediaRef, signOrgMediaUrls, SIGN_TTL_READ, SIGN_TTL_EDITOR } from './storage.js';

/** Cap on distinct images per document — bounds storage + the GC sweep. */
export const MAX_DOC_IMAGES = 50;

/** Throw if a doc references more than the per-doc image cap (enforced on save). */
export function assertDocImageCap(doc: unknown, max = MAX_DOC_IMAGES): void {
    if (collectImageSrcs(doc).size > max) {
        throw new Error(`Too many images in this document (max ${max}).`);
    }
}

/**
 * SAVE normalise: a private ref (our signed URL or bare key) collapses to the bare key;
 * an external image is kept. Returns a new doc (input untouched). Typed loosely so it flows
 * into the Json content column without a cast.
 */
export function normalizeDocMediaForStorage(doc: unknown): any {
    return mapImageSrcs(doc, (src) => {
        const r = classifyOrgMediaRef(src);
        return r.kind === 'own-private' ? r.key : src;
    });
}

/**
 * READ hydrate (only call behind the content's permission + clearance gate): private keys
 * become freshly-signed URLs. Batch-signs in one round-trip. Returns a new doc.
 *
 * THE CLASSIFICATION MODEL, stated because the alternative reading looks like a hole.
 * The gate is on the DOCUMENT, never on the object: this signs any `media/` key it finds in a
 * document the caller is already permitted to read, and nothing records which page an object was
 * first uploaded for. So an editor who can see a CLASSIFIED page can paste its image into an
 * UNCLASSIFIED one, and every reader of that page will then see it.
 *
 * That is DELIBERATE and it is the owner's ruling: image reuse across pages is allowed, and
 * classifying a page correctly is the content owner's job. It is the same act as pasting the
 * classified page's TEXT into an unclassified one — a decision by someone who was authorised to
 * see the material, which no gate can arbitrate. Binding objects to their first document would
 * break legitimate reuse (one org crest, one map, used on pages of several classifications) to
 * prevent something an authorised editor can do anyway.
 *
 * What this is NOT is an accessible hole. There is no path to an object without an authorised
 * editor deliberately republishing it: keys are `media/{feature}/{randomUUID}.webp` and so
 * unguessable, and this function only ever signs keys that appear in a document the caller may
 * already read. A low-clearance reader cannot enumerate, guess or request a key that is not in
 * front of them.
 *
 * DO NOT "fix" this by adding per-object clearance binding or an upload-provenance table. If the
 * policy ever changes, that is a product decision with a migration, not a patch.
 *
 * `longLived` opts a call site out of the short read TTL and into the editor-length one. It
 * exists for exactly one class of caller: content signed into the BOOT BUNDLE (and its
 * `main` subset twin), which nothing on the client re-mints on a timer. A tab left visible
 * on that content never triggers a `main` refetch, so a short lifetime would show broken
 * images. Every other read path (wiki list, wiki_page_slice, government, legislation)
 * refetches on mount and on realtime, and MUST keep the short default — in particular the
 * wiki list/slice pair must stay identical to each other, or the mirrored gates drift.
 */
export async function signDocMediaForClient(doc: unknown, opts?: { longLived?: boolean }): Promise<any> {
    if (!doc || typeof doc !== 'object') return doc;
    const keys: string[] = [];
    for (const src of collectImageSrcs(doc)) {
        const r = classifyOrgMediaRef(src);
        if (r.kind === 'own-private') keys.push(r.key);
    }
    if (keys.length === 0) return doc;
    const signed = await signOrgMediaUrls(keys, opts?.longLived ? SIGN_TTL_EDITOR : SIGN_TTL_READ);
    return mapImageSrcs(doc, (src) => {
        const r = classifyOrgMediaRef(src);
        return r.kind === 'own-private' ? (signed.get(r.key) ?? src) : src;
    });
}
