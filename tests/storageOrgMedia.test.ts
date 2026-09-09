import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';

// Security pins for the image-upload engine: bytes are trusted only after a magic-byte
// sniff AND a full sharp re-encode (SVG/polyglot rejected, size capped), object keys are
// random (no path traversal), and the private classify/sign helpers only ever touch our
// own objects.

const h = vi.hoisted(() => ({
    uploaded: [] as Array<{ bucket: string; key: string; contentType?: string }>,
    listData: [] as unknown[],
    uploadError: null as unknown,
}));

function bucketApi(bucket: string) {
    return {
        list: async () => ({ data: h.listData, error: null }),
        upload: async (key: string, _buf: Buffer, opts?: { contentType?: string }) => {
            h.uploaded.push({ bucket, key, contentType: opts?.contentType });
            return { error: h.uploadError };
        },
        getPublicUrl: (key: string) => ({ data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/${bucket}/${key}` } }),
        createSignedUrl: async (key: string) => ({ data: { signedUrl: `https://proj.supabase.co/storage/v1/object/sign/${bucket}/${key}?token=t` }, error: null }),
        createSignedUrls: async (keys: string[]) => ({ data: keys.map(k => ({ path: k, signedUrl: `https://proj.supabase.co/storage/v1/object/sign/${bucket}/${k}?token=t` })), error: null }),
        remove: async () => ({ error: null }),
    };
}

vi.mock('../lib/supabaseServer.js', () => ({ supabase: { storage: { from: (b: string) => bucketApi(b) } } }));

import {
    detectImageType, uploadOrgMedia, orgMediaKeyFromUrl, classifyOrgMediaRef,
    signOrgMediaUrl, PUBLIC_BUCKET, PRIVATE_BUCKET,
} from '../lib/storage';

async function png(w = 4, h2 = 4): Promise<Buffer> {
    return sharp({ create: { width: w, height: h2, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

beforeEach(() => { h.uploaded = []; h.listData = []; h.uploadError = null; });

describe('detectImageType — trusts bytes, not the content-type', () => {
    it('recognises PNG/JPEG/GIF/WEBP by signature', () => {
        expect(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))?.ext).toBe('png');
        expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]))?.ext).toBe('jpg');
        expect(detectImageType(Buffer.from([0x47, 0x49, 0x46, 0x38, 0, 0, 0, 0, 0, 0, 0, 0]))?.ext).toBe('gif');
        expect(detectImageType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))?.ext).toBe('webp');
    });
    it('rejects SVG (text, no signature), short buffers, and non-images', () => {
        expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'))).toBeNull();
        expect(detectImageType(Buffer.from([0x89, 0x50]))).toBeNull();
        expect(detectImageType(Buffer.from('not an image at all'))).toBeNull();
    });
});

describe('uploadOrgMedia — validate + re-encode + store', () => {
    it('re-encodes a real PNG to WebP and stores it under a random key; returns a public URL', async () => {
        const res = await uploadOrgMedia('branding', await png());
        expect(res.visibility).toBe('public');
        expect(res.url).toContain(`/public/${PUBLIC_BUCKET}/`);
        expect(res.key).toMatch(/^media\/branding\/[0-9a-f-]{36}\.webp$/);
        expect(h.uploaded).toHaveLength(1);
        expect(h.uploaded[0].bucket).toBe(PUBLIC_BUCKET);
        expect(h.uploaded[0].contentType).toBe('image/webp'); // content-type pinned, never trusted from input
        expect(h.uploaded[0].key).not.toContain('..');
    });

    it('a private feature stores in the private bucket and returns a signed URL + the key', async () => {
        const res = await uploadOrgMedia('wiki', await png());
        expect(res.visibility).toBe('private');
        expect(h.uploaded[0].bucket).toBe(PRIVATE_BUCKET);
        expect(res.key).toMatch(/^media\/wiki\/[0-9a-f-]{36}\.webp$/);
        expect(res.url).toContain(`/sign/${PRIVATE_BUCKET}/`);
    });

    it('rejects an SVG / non-image before it is stored', async () => {
        await expect(uploadOrgMedia('branding', Buffer.from('<svg><script>alert(1)</script></svg>'))).rejects.toThrow(/Unsupported or invalid image/);
        expect(h.uploaded).toHaveLength(0);
    });

    it('rejects an oversized buffer before decoding', async () => {
        await expect(uploadOrgMedia('branding', Buffer.alloc(6 * 1024 * 1024, 1))).rejects.toThrow(/too large/i);
        expect(h.uploaded).toHaveLength(0);
    });

    it('rejects an empty buffer and an unknown feature', async () => {
        await expect(uploadOrgMedia('branding', Buffer.alloc(0))).rejects.toThrow(/Unsupported or invalid image/);
        // @ts-expect-error unknown feature
        await expect(uploadOrgMedia('not-a-feature', await png())).rejects.toThrow(/Unsupported or invalid image/);
    });
});

describe('orgMediaKeyFromUrl / classifyOrgMediaRef / signOrgMediaUrl — only touch our own objects', () => {
    it('resolves a public URL and a bare private key; ignores external URLs and traversal', () => {
        expect(orgMediaKeyFromUrl(`https://x/storage/v1/object/public/${PUBLIC_BUCKET}/media/rank/a.webp`)).toEqual({ bucket: PUBLIC_BUCKET, key: 'media/rank/a.webp' });
        expect(orgMediaKeyFromUrl('media/wiki/b.webp')).toEqual({ bucket: PRIVATE_BUCKET, key: 'media/wiki/b.webp' });
        expect(orgMediaKeyFromUrl('https://cdn.example.com/logo.png')).toBeNull();
        expect(orgMediaKeyFromUrl(`https://x/storage/v1/object/public/${PUBLIC_BUCKET}/media/../secret.webp`)).toBeNull();
    });

    it('classifies a private signed URL / bare key as own-private, everything else as external', () => {
        // Host pinned to SUPABASE_URL, not a bare literal: classifyOrgMediaRef is the WRITE
        // side and demands our own origin. Set explicitly rather than leaning on the
        // ambient value, so a dev machine with a real .env sourced does not change the result.
        const prev = process.env.SUPABASE_URL;
        process.env.SUPABASE_URL = 'https://proj.supabase.co';
        try {
            expect(classifyOrgMediaRef(`https://proj.supabase.co/storage/v1/object/sign/${PRIVATE_BUCKET}/media/wiki/c.webp?token=t`)).toEqual({ kind: 'own-private', key: 'media/wiki/c.webp' });
            expect(classifyOrgMediaRef('media/government/d.webp')).toEqual({ kind: 'own-private', key: 'media/government/d.webp' });
            expect(classifyOrgMediaRef('https://cdn.example.com/x.png')).toEqual({ kind: 'external' });
            expect(classifyOrgMediaRef('media/../etc/passwd')).toEqual({ kind: 'external' });
        } finally {
            process.env.SUPABASE_URL = prev;
        }
    });

    // The write side must refuse a foreign URL merely SHAPED like one of ours. Without this,
    // an attacker-hosted string collapses to a bare `media/` key on save, and the read path
    // then signs it for every reader permitted to see the document it was pasted into.
    it('classifyOrgMediaRef refuses a storage-shaped URL on a foreign origin, and an unanchored marker', () => {
        const prev = process.env.SUPABASE_URL;
        process.env.SUPABASE_URL = 'https://proj.supabase.co';
        try {
            expect(classifyOrgMediaRef(`https://evil.example.com/storage/v1/object/sign/${PRIVATE_BUCKET}/media/wiki/c.webp?token=t`)).toEqual({ kind: 'external' });
            // Marker present but NOT at the start of the pathname — what a bare indexOf allowed.
            expect(classifyOrgMediaRef(`https://proj.supabase.co/x/storage/v1/object/sign/${PRIVATE_BUCKET}/media/wiki/c.webp?token=t`)).toEqual({ kind: 'external' });
            // Percent-encoded traversal must not be decoded into a traversal.
            expect(classifyOrgMediaRef(`https://proj.supabase.co/storage/v1/object/sign/${PRIVATE_BUCKET}/media/%2e%2e/secret.webp`)).toEqual({ kind: 'external' });
        } finally {
            process.env.SUPABASE_URL = prev;
        }
    });

    // The READ/GC side is deliberately NOT origin-checked, and that asymmetry is a safety
    // property, not an oversight. orgMediaKeyFromUrl's only consumer is the GC's referenced-key
    // set, where matching MORE strings only ever PROTECTS an object from deletion. Origin-
    // checking it would mean that any later origin change (custom domain, proxy swap, project
    // restore, staging->prod dump) stops every stored public URL from resolving, empties the
    // referenced set, and lets the nightly sweep delete every public object. Do not "fix" this.
    it('orgMediaKeyFromUrl still resolves a public URL on a DIFFERENT origin (fail-safe for the GC)', () => {
        const prev = process.env.SUPABASE_URL;
        process.env.SUPABASE_URL = 'https://proj.supabase.co';
        try {
            expect(orgMediaKeyFromUrl(`https://old-host.example.com/storage/v1/object/public/${PUBLIC_BUCKET}/media/rank/a.webp`))
                .toEqual({ bucket: PUBLIC_BUCKET, key: 'media/rank/a.webp' });
        } finally {
            process.env.SUPABASE_URL = prev;
        }
    });

    it('orgMediaKeyFromUrl anchors the marker to the pathname and the key to media/', () => {
        // Marker mid-path: the substring match used to accept this from any host.
        expect(orgMediaKeyFromUrl(`https://evil.example.com/x/storage/v1/object/public/${PUBLIC_BUCKET}/media/rank/a.webp`)).toBeNull();
        // Public branch was the one site that checked traversal but not the media/ namespace.
        expect(orgMediaKeyFromUrl(`https://x/storage/v1/object/public/${PUBLIC_BUCKET}/outside/a.webp`)).toBeNull();
    });

    it('signOrgMediaUrl refuses a key outside our namespace or with traversal', async () => {
        expect(await signOrgMediaUrl('not-ours/x.webp')).toBeNull();
        expect(await signOrgMediaUrl('media/../x.webp')).toBeNull();
        expect(await signOrgMediaUrl('media/wiki/ok.webp')).toContain('/sign/');
    });
});
