import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { __sanitizeImportedSettingRowForTest } from '../lib/db/importer';
import { MAX_DOC_IMAGES } from '../lib/orgMediaDocs';

// THE SECOND WRITER.
//
// `settings.wikiHomeConfig` holds the only Tiptap document outside the wiki pages table, and
// it has exactly TWO writers: updateWikiHomeConfig, which sanitises, and the org importer,
// which did not. `sanitizeImportedSettingRow` switched on five settings keys and ended
// `default: return row`, so POST /api/admin/import-stream wrote an attacker-supplied
// wiki-home document verbatim — contradicting that function's own contract, which names
// sanitizeTiptapJson among the sanitisers it re-applies.
//
// It was masked rather than harmless. Every client wiki-home save posts `{...config, <field>}`,
// so the next save accidentally laundered the imported row back through the sanitiser. The
// untouched-round-trip passthrough added to updateWikiHomeConfig removes that laundering —
// which is why this case had to land in the SAME change: without it, an unsanitised imported
// document would go from transiently unsanitised to PERMANENTLY so.
//
// Severity, honestly: server.ts ships script-src with no 'unsafe-inline' and an explicit
// frame-src allowlist, so this is defence-in-depth erosion, not live XSS. What CSP does not
// cover is what an unsanitised doc keeps — target="_blank" without the rel="noopener
// noreferrer" sanitizeMark forces, and data: image srcs safeUrl would have rejected.

function row(value: unknown) {
    return __sanitizeImportedSettingRowForTest({ key: 'wikiHomeConfig', value }) as { value: Record<string, unknown> };
}

function doc(...content: unknown[]) {
    return { type: 'doc', content };
}

describe('the org importer sanitises wikiHomeConfig like the interactive write path', () => {
    it('strips a javascript: link href from an imported welcome document', () => {
        const out = row({
            welcomeContent: doc({
                type: 'paragraph',
                content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
            }),
        });
        expect(JSON.stringify(out.value.welcomeContent)).not.toContain('javascript:');
    });

    it('forces rel="noopener noreferrer" on a target=_blank link — the CSP does NOT cover this', () => {
        const out = row({
            welcomeContent: doc({
                type: 'paragraph',
                content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank' } }] }],
            }),
        });
        const s = JSON.stringify(out.value.welcomeContent);
        expect(s).toContain('noopener');
        expect(s).toContain('noreferrer');
    });

    it('drops a data: image src — the other thing CSP img-src still permits', () => {
        const out = row({
            welcomeContent: doc({ type: 'image', attrs: { src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } }),
        });
        expect(JSON.stringify(out.value.welcomeContent)).not.toContain('data:image');
    });

    it('drops an off-allowlist iframe', () => {
        const out = row({
            welcomeContent: doc({ type: 'iframe', attrs: { src: 'https://evil.example/embed' } }),
        });
        expect(JSON.stringify(out.value.welcomeContent)).not.toContain('evil.example');
    });

    it('clamps featuredPageIds to 50 and to strings', () => {
        const out = row({ featuredPageIds: [...Array(80).keys()].map(String).concat([1 as unknown as string, null as unknown as string]) });
        const ids = out.value.featuredPageIds as string[];
        expect(ids).toHaveLength(50);
        expect(ids.every((i) => typeof i === 'string')).toBe(true);
    });

    it('coerces hideRecentlyUpdated to a real boolean', () => {
        expect(row({ hideRecentlyUpdated: 'yes' as unknown as boolean }).value.hideRecentlyUpdated).toBe(true);
        expect(row({ hideRecentlyUpdated: 0 as unknown as boolean }).value.hideRecentlyUpdated).toBe(false);
    });

    it('drops a welcome document that exceeds the per-doc image cap', () => {
        // A LEGITIMATE export cannot exceed it — the source org's own save path enforces
        // assertDocImageCap — so a bundle that does is hand-crafted, and the document it
        // carries would feed the media GC reference set, which is pinned permanently
        // uncappable. Dropped rather than aborting the whole import, per this file's
        // resilient-sanitiser convention.
        const images = [...Array(MAX_DOC_IMAGES + 5).keys()].map((i) => ({
            type: 'image', attrs: { src: `https://cdn.example/img-${i}.webp` },
        }));
        expect(row({ welcomeContent: doc(...images) }).value.welcomeContent).toBeNull();
    });

    it('keeps a document at exactly the cap', () => {
        const images = [...Array(MAX_DOC_IMAGES).keys()].map((i) => ({
            type: 'image', attrs: { src: `https://cdn.example/img-${i}.webp` },
        }));
        expect(row({ welcomeContent: doc(...images) }).value.welcomeContent).not.toBeNull();
    });

    it('leaves an ordinary document intact', () => {
        const out = row({
            welcomeContent: doc({ type: 'paragraph', content: [{ type: 'text', text: 'Welcome to the org wiki.' }] }),
        });
        expect(JSON.stringify(out.value.welcomeContent)).toContain('Welcome to the org wiki.');
    });
});

describe('the importer contract stays honest', () => {
    it('wikiHomeConfig has a case in the switch — not the default passthrough', () => {
        const src = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'importer.ts'), 'utf8');
        const at = src.indexOf('function sanitizeImportedSettingRow(');
        expect(at, 'sanitizeImportedSettingRow was renamed').toBeGreaterThan(-1);
        const body = src.slice(at, src.indexOf('\n}', at));
        expect(body).toContain("case 'wikiHomeConfig':");
    });

    it('every Tiptap-bearing settings key the interactive path sanitises is covered here', () => {
        // The gap existed because the switch was written key-by-key with no cross-check.
        const src = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'importer.ts'), 'utf8');
        const at = src.indexOf('function sanitizeImportedSettingRow(');
        const body = src.slice(at, src.indexOf('\n}', at));
        for (const key of ['brandingConfig', 'publicPageConfig', 'openGraphConfig', 'heroCardConfig', 'systemConfig', 'wikiHomeConfig']) {
            expect(body, `${key} lost its sanitiser case`).toContain(`case '${key}':`);
        }
    });
});
