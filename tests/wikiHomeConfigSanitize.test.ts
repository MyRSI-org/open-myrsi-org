import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// updateWikiHomeConfig was the only Tiptap write path that stored its document
// without sanitizeTiptapJson + assertDocImageCap, and it spread the caller's
// object straight into the settings row. The stored blob ships to every
// authenticated caller in the `main` subset and has its media re-signed on each
// read, so an unsanitised doc here is a published-payload problem, not a local
// rendering one. These pin the write boundary.

const h = vi.hoisted(() => ({
    upserted: null as any,
    // The wikiHomeConfig row already in the settings table, for the read-merge suite.
    existing: null as any,
    readError: null as any,
}));

vi.mock('../lib/db/common', () => {
    function builder() {
        const b: any = {};
        b.select = () => b; b.eq = () => b; b.in = () => b; b.is = () => b;
        b.order = () => b; b.limit = () => b;
        b.upsert = (v: unknown) => { h.upserted = v; return b; };
        const settle = () => Promise.resolve({ data: null, error: null });
        b.maybeSingle = () => Promise.resolve({
            data: h.existing === null ? null : { value: h.existing },
            error: h.readError,
        });
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

beforeEach(() => { h.upserted = null; h.existing = null; h.readError = null; });

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

    it('an UNTOUCHED round-trip is not re-sanitised, so an unrelated save cannot mutate it', async () => {
        // All three client save paths POST {...config, <one field>}, so ticking the
        // "hide recently updated" checkbox hands the whole welcome document back. Re-running
        // the sanitiser over it applies POLICY to content nobody edited — a dropped node, a
        // rewritten embed src — silently, 200 OK. The doc below carries a youtube embed that
        // survives sanitisation, so the observable property is the CAP, not the content.
        const stored = doc({ type: 'iframe', attrs: { src: 'https://www.youtube.com/embed/abc' } });
        h.existing = { welcomeContent: stored };
        await updateWikiHomeConfig({ welcomeContent: stored, hideRecentlyUpdated: true });
        expect(h.upserted.value.hideRecentlyUpdated).toBe(true);
        expect(JSON.stringify(h.upserted.value.welcomeContent)).toContain('youtube.com');
    });

    it('an over-cap org can still save the OTHER two fields — the regression this fixes', async () => {
        // assertDocImageCap is the same hazard in reverse: an org already holding a document
        // over the cap (imported, or capped under an older limit) could not change a checkbox
        // without the echoed document failing the cap check on a save it was not part of.
        const images = Array.from({ length: MAX_DOC_IMAGES + 10 }, (_, i) => ({ type: 'image', attrs: { src: `https://cdn.example/${i}.png` } }));
        const stored = doc(...images);
        h.existing = { welcomeContent: stored };
        await updateWikiHomeConfig({ welcomeContent: stored, featuredPageIds: ['a'] });
        expect(h.upserted.value.featuredPageIds).toEqual(['a']);
    });

    it('a GENUINE edit still goes through the sanitiser — the passthrough must not widen', async () => {
        // The one way this change could become a security regression: skipping the sanitiser
        // on a doc that actually differs from what is stored.
        h.existing = { welcomeContent: doc(para({ type: 'text', text: 'before' })) };
        await updateWikiHomeConfig({
            welcomeContent: doc(para({
                type: 'text', text: 'after',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            })),
        });
        const written = JSON.stringify(h.upserted.value.welcomeContent);
        expect(written).not.toContain('javascript:');
        // AND the edit must actually land. Asserting only the absence of `javascript:` would
        // pass if the passthrough wrongly re-stored the OLD document — the user's edit
        // silently discarded, 200 OK. Both halves are needed to distinguish those.
        expect(written).toContain('after');
        expect(written).not.toContain('before');
    });

    it('the image cap still fires on a genuine edit', async () => {
        h.existing = { welcomeContent: doc(para({ type: 'text', text: 'small' })) };
        const images = Array.from({ length: MAX_DOC_IMAGES + 1 }, (_, i) => ({ type: 'image', attrs: { src: `https://cdn.example/${i}.png` } }));
        await expect(updateWikiHomeConfig({ welcomeContent: doc(...images) })).rejects.toThrow(/Too many images/i);
    });

    it('stores an explicit clear as null rather than echoing the raw falsy input', async () => {
        await updateWikiHomeConfig({ welcomeContent: null });
        expect(h.upserted.value.welcomeContent).toBeNull();
    });
});

// Phase 3 item 8, owner decision OD-6 — THE WRITE-INTEGRITY INVARIANT.
//
// projectSettingsForViewer (lib/settingsProjection.ts) withholds wikiHomeConfig from a
// caller without wiki:view, while the WRITE is gated wiki:edit_page (api/services.ts). The
// wiki home editor posts `{ ...config, <one field> }`, where `config` is whatever the
// browser hydrated — so for a holder of the write gate but not the read gate, `config` is
// the ConfigContext `{}` default and the spread contributes NOTHING. Building the stored
// value from empty therefore turned one click of any single editor control into a
// wholesale wipe of the org's wiki home page.
//
// The read gate is deliberately NOT widened to close this — that would make the config
// read wider than the `wiki` subset it configures. The write is made non-destructive
// instead, which is strictly narrower and also fixes a PRE-EXISTING first-paint race where
// a toggle clicked before the first `main` payload landed had the same empty spread.
describe('updateWikiHomeConfig — read-merge (OD-6)', () => {
    const stored = {
        welcomeContent: doc(para({ type: 'text', text: 'the org welcome' })),
        featuredPageIds: ['p1', 'p2'],
        hideRecentlyUpdated: false,
    };

    it('a single-field save preserves every field it did not post', async () => {
        h.existing = stored;
        // Exactly what WikiHomePage posts when `config` never hydrated: one field, alone.
        await updateWikiHomeConfig({ hideRecentlyUpdated: true });
        expect(h.upserted.value.hideRecentlyUpdated).toBe(true);
        expect(h.upserted.value.featuredPageIds).toEqual(['p1', 'p2']);
        expect(JSON.stringify(h.upserted.value.welcomeContent)).toContain('the org welcome');
    });

    it('a posted field still WINS over the stored one', async () => {
        h.existing = stored;
        await updateWikiHomeConfig({ featuredPageIds: ['p9'] });
        expect(h.upserted.value.featuredPageIds).toEqual(['p9']);
        // ...and the merge did not resurrect anything it should not have.
        expect(h.upserted.value.hideRecentlyUpdated).toBe(false);
    });

    it('an explicit clear still clears — the merge must not resurrect the old body', async () => {
        h.existing = stored;
        await updateWikiHomeConfig({ welcomeContent: null });
        expect(h.upserted.value.welcomeContent).toBeNull();
        expect(h.upserted.value.featuredPageIds).toEqual(['p1', 'p2']);
    });

    it('a stray key already in the stored row is dropped, not re-persisted forever', async () => {
        h.existing = { ...stored, legacyJunk: 'from an old schema' };
        await updateWikiHomeConfig({ hideRecentlyUpdated: true });
        expect('legacyJunk' in h.upserted.value).toBe(false);
        expect(h.upserted.value.featuredPageIds).toEqual(['p1', 'p2']);
    });

    it('FAILS CLOSED on a read fault — never falls back to an empty base and wipes the row', async () => {
        // Without the explicit error check, a transient DB blip yields `existing =
        // undefined`, the base collapses to {} and the save performs exactly the wipe this
        // merge exists to prevent. Same class as the certifyAndComplete fail-open found
        // one wave earlier: a single-row read has to say it.
        h.existing = stored;
        h.readError = { message: 'connection reset' };
        await expect(updateWikiHomeConfig({ hideRecentlyUpdated: true }))
            .rejects.toThrow(/Failed to read wiki home config/i);
        expect(h.upserted).toBeNull();
    });

    it('an absent row still writes — a first-ever save is not blocked by the merge', async () => {
        h.existing = null;
        await updateWikiHomeConfig({ featuredPageIds: ['first'] });
        expect(h.upserted.value.featuredPageIds).toEqual(['first']);
        expect('welcomeContent' in h.upserted.value).toBe(false);
    });

    it('merge:false REPLACES — the org importer must not inherit target-only fields', async () => {
        // The one caller that posts a COMPLETE config (lib/db/wiki.ts importWikiPages).
        // After an import the home config must BE the bundle's; a target field the source
        // bundle lacked surviving is an import-fidelity break, not a rescue.
        h.existing = stored;
        await updateWikiHomeConfig({ welcomeContent: doc(para({ type: 'text', text: 'imported' })) }, { merge: false });
        expect(JSON.stringify(h.upserted.value.welcomeContent)).toContain('imported');
        expect('featuredPageIds' in h.upserted.value).toBe(false);
        expect('hideRecentlyUpdated' in h.upserted.value).toBe(false);
    });

    it('merge:false is used by the importer and NOWHERE else', () => {
        // A ratchet, not a style check: passing merge:false from an interactive editor
        // path (the RPC handler is api/actions/admin.ts) would silently re-create the
        // wholesale wipe OD-6 exists to close. Walks the whole server tree so a NEW caller
        // in a file this test never heard of is caught too.
        const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
            .flatMap(e => (e.isDirectory() ? walk(join(dir, e.name))
                : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
        const callers = [...walk(join(process.cwd(), 'api')), ...walk(join(process.cwd(), 'lib'))]
            .map(f => [f, readFileSync(f, 'utf8')] as const)
            .filter(([, src]) => /updateWikiHomeConfig\(/.test(src));
        const replacers = callers
            .filter(([, src]) => /updateWikiHomeConfig\([^;]*merge:\s*false/.test(src))
            .map(([f]) => f.replace(/\\/g, '/').split('/').slice(-3).join('/'));
        expect(replacers).toEqual(['lib/db/wiki.ts']);
    });
});
