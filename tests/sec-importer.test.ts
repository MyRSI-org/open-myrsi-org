import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sanitizeRichHtml } from '../lib/htmlSanitize';

// The org import path must run imported `settings` rows through the same
// write-boundary sanitizers the admin RPC config writers (lib/db/system.ts) use,
// rather than writing them verbatim. Otherwise a crafted export could seed raw
// HTML (termsOfService), javascript: links, tracking-host image URLs and
// over-length mottos that the normal write path would have stripped. These tests
// capture the rows the importer actually inserts and check that imported config
// values are sanitized identically to the admin write path.

const h = vi.hoisted(() => ({ inserts: [] as { table: string; rows: Record<string, unknown>[] }[] }));

vi.mock('../lib/db/common', () => {
    const make = (table: string) => {
        const b: any = {
            select: () => b,
            insert: (rows: any) => {
                h.inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
                return Promise.resolve({ error: null, data: null });
            },
            update: () => b,
            delete: () => ({
                neq: () => Promise.resolve({ error: null }),
                eq: () => Promise.resolve({ error: null }),
                in: () => Promise.resolve({ error: null }),
            }),
            eq: () => Promise.resolve({ data: [], error: null }),
            in: () => b,
            range: () => Promise.resolve({ data: [], error: null }),
            // Empty-DB guard + any bare-await read resolves to an empty/zero result.
            then: (r: any) => Promise.resolve({ count: 0, error: null, data: [] }).then(r),
        };
        return b;
    };
    return {
        supabase: { from: (t: string) => make(t), rpc: () => Promise.resolve({ error: null, data: null }) },
        handleSupabaseError: () => {},
    };
});

import { importOrgData } from '../lib/db/importer';

// sanitizeRichHtml must strip the onerror handler and the <script> block on WRITE.
const RAW_TOS = '<img src=x onerror="alert(1)"><script>alert(2)</script>hello';
const LONG_MOTTO = 'A'.repeat(500);

const NDJSON = [
    '{"kind":"header","version":1,"tableOrder":["settings"],"manifest":{"settings":2}}',
    JSON.stringify({ kind: 'row', t: 'settings', r: { key: 'brandingConfig', value: { name: 'Org', termsOfService: RAW_TOS } } }),
    JSON.stringify({
        kind: 'row', t: 'settings', r: {
            key: 'publicPageConfig', value: {
                enabled: true,
                motto: LONG_MOTTO,
                heroImageUrl: 'https://evil.example/not-an-image',     // no image extension → cleared
                profileImageUrl: 'https://cdn.example/avatar.png',     // valid → kept
                links: [
                    { id: 'l1', label: 'Bad', url: 'javascript:alert(1)' },   // dangerous scheme → dropped
                    { id: 'l2', label: 'Good', url: 'https://example.com' },  // public https → kept
                    { id: 'l3', label: 'Internal', url: 'https://127.0.0.1/x' }, // private host → dropped
                ],
            },
        },
    }),
].join('\n');

const settingsValue = (key: string): Record<string, unknown> | undefined => {
    const row = h.inserts.filter((i) => i.table === 'settings').flatMap((i) => i.rows).find((r) => r.key === key);
    return row?.value as Record<string, unknown> | undefined;
};

beforeEach(() => { h.inserts = []; });

describe('importOrgData re-applies write-boundary sanitizers to imported settings', () => {
    it('sanitizes brandingConfig.termsOfService exactly like updateBrandingConfig (sanitizeRichHtml)', async () => {
        await importOrgData(NDJSON);
        const branding = settingsValue('brandingConfig');
        expect(branding, 'brandingConfig row must be inserted').toBeDefined();
        const tos = branding!.termsOfService as string;
        // The dangerous constructs are gone...
        expect(tos).not.toMatch(/onerror/i);
        expect(tos).not.toMatch(/<script/i);
        // ...and the stored value equals what the admin write path would have stored.
        expect(tos).toBe(sanitizeRichHtml(RAW_TOS));
        // Non-sanitized sibling fields are preserved verbatim.
        expect(branding!.name).toBe('Org');
    });

    it('length-caps publicPageConfig.motto and clears a non-image heroImageUrl', async () => {
        await importOrgData(NDJSON);
        const pub = settingsValue('publicPageConfig');
        expect(pub, 'publicPageConfig row must be inserted').toBeDefined();
        // motto is stripHtml(.,120) → capped to 120 chars.
        expect((pub!.motto as string).length).toBe(120);
        // heroImageUrl is not a valid image URL → cleared; the valid profile image is kept.
        expect(pub!.heroImageUrl).toBe('');
        expect(pub!.profileImageUrl).toBe('https://cdn.example/avatar.png');
    });

    it('drops javascript: / private-host links and keeps only public https links', async () => {
        await importOrgData(NDJSON);
        const pub = settingsValue('publicPageConfig');
        const links = pub!.links as Array<{ url: string }>;
        expect(links).toHaveLength(1);
        expect(links[0].url).toMatch(/^https:\/\/example\.com\/?$/);
        for (const l of links) {
            expect(l.url).not.toMatch(/^javascript:/i);
            expect(l.url).not.toContain('127.0.0.1');
        }
    });

    it('leaves a settings key with no sanitizing write path untouched', async () => {
        const ndjson = [
            '{"kind":"header","version":1,"tableOrder":["settings"],"manifest":{"settings":1}}',
            JSON.stringify({ kind: 'row', t: 'settings', r: { key: 'wikiHomeConfig', value: { welcome: '<b>hi</b>' } } }),
        ].join('\n');
        await importOrgData(ndjson);
        const wiki = settingsValue('wikiHomeConfig');
        expect(wiki).toEqual({ welcome: '<b>hi</b>' });
    });
});
