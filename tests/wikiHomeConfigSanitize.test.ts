import { describe, it, expect, vi, beforeEach } from 'vitest';

// updateWikiHomeConfig was the only Tiptap write path that stored its document
// without sanitizeTiptapJson + assertDocImageCap, and it spread the caller's
// object straight into the settings row. The stored blob ships to every
// authenticated caller in the `main` subset and has its media re-signed on each
// read, so an unsanitised doc here is a published-payload problem, not a local
// rendering one. These pin the write boundary.

const h = vi.hoisted(() => ({ upserted: null as any }));

vi.mock('../lib/db/common', () => {
    function builder() {
        const b: any = {};
        b.select = () => b; b.eq = () => b; b.in = () => b; b.is = () => b;
        b.order = () => b; b.limit = () => b;
        b.upsert = (v: unknown) => { h.upserted = v; return b; };
        const settle = () => Promise.resolve({ data: null, error: null });
        b.maybeSingle = () => settle();
        b.single = () => settle();
        b.then = (res: any, rej: any) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: () => builder() },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => ({}), safeFetch: async () => [],
    };
});
vi.mock('../lib/cache', () => ({ cache: { get: () => undefined, set: () => {}, invalidate: () => {}, invalidatePrefix: () => {} }, TTL: {} }));
vi.mock('../lib/push', () => ({ sendPushToAll: () => {}, sendPushToStaff: () => {}, sendPushToPermission: () => {} }));
vi.mock('../lib/db/seeder', () => ({ seedNewOrganization: async () => {} }));

import { updateWikiHomeConfig } from '../lib/db/system';
import { MAX_DOC_IMAGES } from '../lib/orgMediaDocs';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });

beforeEach(() => { h.upserted = null; });

describe('updateWikiHomeConfig — key allowlist', () => {
    it('rejects an unknown top-level key instead of storing it', async () => {
        await expect(updateWikiHomeConfig({ nope: 1 } as never)).rejects.toThrow(/Unknown wiki home config field/i);
        expect(h.upserted).toBeNull();
    });

    it('rejects a non-object payload', async () => {
        await expect(updateWikiHomeConfig(null as never)).rejects.toThrow(/Invalid wiki home config/i);
    });

    it('stores only allow-listed keys, coercing their types', async () => {
        await updateWikiHomeConfig({ hideRecentlyUpdated: 'yes' as never, featuredPageIds: ['a', 2 as never, 'b'] });
        expect(h.upserted.value.hideRecentlyUpdated).toBe(true);
        expect(h.upserted.value.featuredPageIds).toEqual(['a', 'b']);
    });

    it('caps featuredPageIds so a bulk array cannot bloat the shared settings row', async () => {
        await updateWikiHomeConfig({ featuredPageIds: Array.from({ length: 500 }, (_, i) => `p${i}`) });
        expect(h.upserted.value.featuredPageIds).toHaveLength(50);
    });
});

describe('updateWikiHomeConfig — rich-text sanitisation', () => {
    it('drops an iframe pointing at a non-allow-listed host', async () => {
        await updateWikiHomeConfig({ welcomeContent: doc({ type: 'iframe', attrs: { src: 'https://attacker.example/x' } }) });
        expect(JSON.stringify(h.upserted.value.welcomeContent)).not.toContain('attacker.example');
    });

    it('keeps an allow-listed embed host', async () => {
        await updateWikiHomeConfig({ welcomeContent: doc({ type: 'iframe', attrs: { src: 'https://www.youtube.com/embed/abc' } }) });
        expect(JSON.stringify(h.upserted.value.welcomeContent)).toContain('youtube.com');
    });

    it('forces rel="noopener noreferrer" onto link marks (reverse-tabnabbing guard)', async () => {
        await updateWikiHomeConfig({
            welcomeContent: doc(para({
                type: 'text', text: 'click',
                marks: [{ type: 'link', attrs: { href: 'https://evil.example', target: '_blank' } }],
            })),
        });
        const stored = JSON.stringify(h.upserted.value.welcomeContent);
        expect(stored).toContain('noopener noreferrer');
    });

    it('drops a javascript: link mark', async () => {
        await updateWikiHomeConfig({
            welcomeContent: doc(para({
                type: 'text', text: 'click',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            })),
        });
        expect(JSON.stringify(h.upserted.value.welcomeContent)).not.toContain('javascript:');
    });

    it('enforces the per-document image cap', async () => {
        const images = Array.from({ length: MAX_DOC_IMAGES + 1 }, (_, i) => ({ type: 'image', attrs: { src: `https://cdn.example/${i}.png` } }));
        await expect(updateWikiHomeConfig({ welcomeContent: doc(...images) })).rejects.toThrow(/Too many images/i);
        expect(h.upserted).toBeNull();
    });

    it('stores an explicit clear as null rather than echoing the raw falsy input', async () => {
        await updateWikiHomeConfig({ welcomeContent: null });
        expect(h.upserted.value.welcomeContent).toBeNull();
    });
});
