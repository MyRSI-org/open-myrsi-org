import { describe, it, expect, vi, beforeEach } from 'vitest';

// The rich-text image transforms: store keys (never signed URLs), sign only our own private
// keys on read, and cap images per document. The storage client is mocked only so importing
// doesn't need env — classify/normalise are pure; signing uses the mocked signer.

const h = vi.hoisted(() => ({ signed: new Map<string, string>(), ttls: [] as (number | undefined)[] }));

vi.mock('../lib/supabaseServer.js', () => ({
    supabase: {
        storage: {
            from: () => ({
                createSignedUrls: async (keys: string[], ttl?: number) => {
                    h.ttls.push(ttl);
                    return {
                        data: keys.map(k => ({ path: k, signedUrl: h.signed.get(k) ?? `signed:${k}` })),
                        error: null,
                    };
                },
            }),
        },
    },
}));

import { normalizeDocMediaForStorage, signDocMediaForClient, assertDocImageCap, MAX_DOC_IMAGES } from '../lib/orgMediaDocs';
import { SIGN_TTL_READ, SIGN_TTL_EDITOR } from '../lib/storage';

const doc = (srcs: string[]) => ({ type: 'doc', content: srcs.map(s => ({ type: 'image', attrs: { src: s } })) });
const srcsOf = (d: any) => (d.content || []).map((n: any) => n.attrs?.src);

beforeEach(() => { h.signed = new Map(); h.ttls = []; });

describe('normalizeDocMediaForStorage — store keys, keep external', () => {
    it('collapses a private signed URL and a bare key to the key; keeps external images', () => {
        // Our own signed URL must be on our own Supabase origin — this is the write side.
        const prev = process.env.SUPABASE_URL;
        process.env.SUPABASE_URL = 'https://proj.supabase.co';
        try {
            const out = normalizeDocMediaForStorage(doc([
                'https://proj.supabase.co/storage/v1/object/sign/org-media/media/wiki/a.webp?token=t',
                'media/wiki/b.webp',
                'https://cdn.example.com/c.png',
            ]));
            expect(srcsOf(out)).toEqual(['media/wiki/a.webp', 'media/wiki/b.webp', 'https://cdn.example.com/c.png']);
        } finally {
            process.env.SUPABASE_URL = prev;
        }
    });

    // A foreign URL shaped like one of ours must NOT collapse to a bare key. If it did, the
    // read path would later mint a signed URL for it for every reader of that document.
    it('keeps a storage-shaped URL from a foreign origin as an external image', () => {
        const prev = process.env.SUPABASE_URL;
        process.env.SUPABASE_URL = 'https://proj.supabase.co';
        try {
            const foreign = 'https://evil.example.com/storage/v1/object/sign/org-media/media/wiki/a.webp?token=t';
            expect(srcsOf(normalizeDocMediaForStorage(doc([foreign])))).toEqual([foreign]);
        } finally {
            process.env.SUPABASE_URL = prev;
        }
    });
});

describe('signDocMediaForClient — swap keys for signed URLs', () => {
    it('signs private keys and leaves external images alone', async () => {
        h.signed.set('media/wiki/a.webp', 'https://signed/a');
        const out = await signDocMediaForClient(doc(['media/wiki/a.webp', 'https://cdn.example.com/c.png']));
        expect(srcsOf(out)).toEqual(['https://signed/a', 'https://cdn.example.com/c.png']);
    });
    it('returns the doc unchanged when there are no private images', async () => {
        const d = doc(['https://cdn.example.com/c.png']);
        expect(await signDocMediaForClient(d)).toBe(d);
    });

    // The read TTL is short because every read consumer refetches on mount and on realtime.
    // The boot bundle is the one exception — nothing re-mints it on a timer — so it opts into
    // the longer editor lifetime. If these two ever collapse to one number, either the boot
    // bundle shows broken images or every read path holds a URL for an hour.
    it('signs read paths with the short TTL and the boot bundle with the long one', async () => {
        await signDocMediaForClient(doc(['media/wiki/a.webp']));
        expect(h.ttls).toEqual([SIGN_TTL_READ]);
        await signDocMediaForClient(doc(['media/wiki/a.webp']), { longLived: true });
        expect(h.ttls).toEqual([SIGN_TTL_READ, SIGN_TTL_EDITOR]);
        expect(SIGN_TTL_READ).toBeLessThan(SIGN_TTL_EDITOR);
    });

    // THE CLASSIFICATION MODEL — pinned because it reads like a hole and is not one.
    //
    // The gate is on the DOCUMENT, never on the object. The same uploaded image can appear on
    // pages of different classifications, and each is signed for whoever may read THAT page.
    // Owner's ruling: image reuse is allowed and classifying a page is the content owner's job —
    // pasting a classified image into an unclassified page is the same act as pasting its text,
    // and is a decision by someone already authorised to see it.
    //
    // This test exists so a future reader who spots the "walk-down" does not helpfully add
    // per-object clearance binding or an upload-provenance table. That would break legitimate
    // reuse (one org crest across pages of several classifications) to prevent something an
    // authorised editor can do anyway. Changing the policy is a product decision with a
    // migration; it should break this test loudly, not slip in as a patch.
    it('signs the SAME key for any document that references it (reuse is allowed by design)', async () => {
        h.signed.set('media/wiki/shared-crest.webp', 'https://signed/crest');
        const classified = await signDocMediaForClient(doc(['media/wiki/shared-crest.webp']));
        const unclassified = await signDocMediaForClient(doc(['media/wiki/shared-crest.webp']));
        expect(srcsOf(classified)).toEqual(['https://signed/crest']);
        expect(srcsOf(unclassified)).toEqual(['https://signed/crest']);
    });

    // The other half of "not an accessible hole": this only ever signs keys that are ALREADY in
    // the document handed to it. It is not a lookup service — a caller cannot use it to resolve a
    // key they merely guessed, and keys are random UUIDs, so there is nothing to guess.
    it('signs only keys present in the document, never anything else', async () => {
        h.signed.set('media/wiki/present.webp', 'https://signed/present');
        h.signed.set('media/wiki/absent.webp', 'https://signed/absent');
        const out = await signDocMediaForClient(doc(['media/wiki/present.webp']));
        expect(srcsOf(out)).toEqual(['https://signed/present']);
        // Exactly one batch, carrying exactly the one key the document referenced.
        expect(h.ttls).toHaveLength(1);
    });

    // An editor can compose for longer than the preview URL lives. Expiry must stay cosmetic:
    // the save-normalise reads the PATH and never the ?token=, so an EXPIRED preview still
    // collapses to the right key. A future change that validated the token before trusting
    // the ref would silently lose every image in an editing session longer than the TTL.
    it('normalises an EXPIRED preview URL to its key (expiry is cosmetic on save)', () => {
        const prev = process.env.SUPABASE_URL;
        process.env.SUPABASE_URL = 'https://proj.supabase.co';
        try {
            const expired = 'https://proj.supabase.co/storage/v1/object/sign/org-media/media/wiki/a.webp?token=long-expired';
            expect(srcsOf(normalizeDocMediaForStorage(doc([expired])))).toEqual(['media/wiki/a.webp']);
        } finally {
            process.env.SUPABASE_URL = prev;
        }
    });
});

describe('assertDocImageCap', () => {
    it('throws over the per-document image cap', () => {
        const many = doc(Array.from({ length: MAX_DOC_IMAGES + 1 }, (_, i) => `media/wiki/${i}.webp`));
        expect(() => assertDocImageCap(many)).toThrow(/Too many images/);
    });
    it('allows a document at the cap', () => {
        const ok = doc(Array.from({ length: MAX_DOC_IMAGES }, (_, i) => `media/wiki/${i}.webp`));
        expect(() => assertDocImageCap(ok)).not.toThrow();
    });
});
