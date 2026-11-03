import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';

// uploadOrgMedia — per-bucket Cache-Control.
//
// Every object used to be stored with cacheControl '31536000'. For the PRIVATE
// bucket that meant clearance/marker-gated wiki + government images sat in the
// browser's disk cache for a year after the member logged out (or lost the
// clearance), while buying nothing: each re-sign mints a new URL, so a cached copy
// is never hit again once its signed URL expires. Owner decision: private uploads
// carry a short max-age tied to the read-signed-URL TTL; the public bucket keeps
// one year (stable URLs, crawler/PWA/Discord fetches).

const h = vi.hoisted(() => ({
    uploads: [] as Array<{ bucket: string; key: string; opts: Record<string, unknown> }>,
}));

vi.mock('../lib/supabaseServer.js', () => ({
    supabase: {
        storage: {
            from: (bucket: string) => ({
                list: async () => ({ data: [], error: null }),
                upload: async (key: string, _buf: Buffer, opts: Record<string, unknown>) => {
                    h.uploads.push({ bucket, key, opts });
                    return { error: null };
                },
                getPublicUrl: (key: string) => ({ data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/${bucket}/${key}` } }),
                createSignedUrl: async (key: string) => ({ data: { signedUrl: `https://proj.supabase.co/storage/v1/object/sign/${bucket}/${key}?token=t` }, error: null }),
            }),
        },
    },
}));

import {
    uploadOrgMedia, ORG_MEDIA_FEATURES, PUBLIC_BUCKET, PRIVATE_BUCKET, SIGN_TTL_READ, SIGN_TTL_EDITOR,
    type OrgMediaFeature,
} from '../lib/storage';

const ONE_YEAR = '31536000';

async function png(): Promise<Buffer> {
    return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
}

beforeEach(() => { h.uploads = []; });

describe('uploadOrgMedia — Cache-Control per bucket', () => {
    it('a private-bucket upload (wiki) carries the short read-TTL max-age, not a year', async () => {
        await uploadOrgMedia('wiki', await png());
        expect(h.uploads).toHaveLength(1);
        expect(h.uploads[0].bucket).toBe(PRIVATE_BUCKET);
        expect(h.uploads[0].opts.cacheControl).toBe(String(SIGN_TTL_READ));
        expect(h.uploads[0].opts.cacheControl).not.toBe(ONE_YEAR);
        // Supabase prefixes `max-age=` itself — the option must be bare seconds.
        expect(String(h.uploads[0].opts.cacheControl)).toMatch(/^\d+$/);
        // Never outlives the longest-lived signed URL that could have keyed it.
        expect(Number(h.uploads[0].opts.cacheControl)).toBeLessThanOrEqual(Math.max(SIGN_TTL_READ, SIGN_TTL_EDITOR));
    });

    it('a public-bucket upload (branding) keeps the one-year max-age', async () => {
        await uploadOrgMedia('branding', await png());
        expect(h.uploads).toHaveLength(1);
        expect(h.uploads[0].bucket).toBe(PUBLIC_BUCKET);
        expect(h.uploads[0].opts.cacheControl).toBe(ONE_YEAR);
    });

    it('every feature gets the value its bucket dictates (no private feature slips through with a year)', async () => {
        const features = Object.keys(ORG_MEDIA_FEATURES) as OrgMediaFeature[];
        const buf = await png();
        for (const f of features) {
            h.uploads = [];
            await uploadOrgMedia(f, buf);
            const { bucket, opts } = h.uploads[0];
            expect(bucket, f).toBe(ORG_MEDIA_FEATURES[f].bucket);
            expect(opts.cacheControl, f).toBe(bucket === PUBLIC_BUCKET ? ONE_YEAR : String(SIGN_TTL_READ));
            // Unchanged alongside: content-type pinned, no overwrite.
            expect(opts.contentType, f).toBe('image/webp');
            expect(opts.upsert, f).toBe(false);
        }
        // The private set is non-empty — the loop above really exercised the short branch.
        expect(features.filter(f => ORG_MEDIA_FEATURES[f].bucket === PRIVATE_BUCKET)).toEqual(
            expect.arrayContaining(['wiki', 'government', 'legislation']),
        );
    });
});
