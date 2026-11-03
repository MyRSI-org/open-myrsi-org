import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// api/index.ts — the SSR shell handler that serves index.html to EVERY visitor,
// anonymous ones included, with operator-controlled branding/OG/public-page values
// injected into HTML text, HTML attributes and an inline <script>.
//
// tests/ssrMetaInjection.test.ts pins the two escapers in isolation and
// tests/ssrReplacementPatterns.test.ts pins String.replace `$`-pattern safety. This
// suite drives the REAL handler and pins the rest of its contract:
//   - XSS: hostile name / description / image / icon / Host-header payloads are parsed
//     back out of the served document (DOMParser) as exact TEXT/attribute values — no
//     new element, no event-handler attribute, no extra <script>, no </script> breakout;
//   - CSP: the per-request nonce lands on EVERY <script> exactly once, and no nonce
//     attribute appears when none was issued;
//   - the single settings read (explicit columns, five keys) and every fallback;
//   - the __PUBLIC_PAGE__ payload is an exact projection (Security rule 3): only the
//     public fields, links re-validated, announcements filtered/expired/sorted/projected,
//     featured testimonial ids and other private config never shipped;
//   - the org accent theme reaches CSS only through the re-validated hex;
//   - fail-safe: any failure redirects to the static shell and is logged, never a 500
//     with partial HTML; index.html is read from disk once per process.

type Op = [string, unknown[]];

const h = vi.hoisted(() => ({
    template: '',
    readCount: 0,
    readThrows: null as Error | null,
    settings: [] as Array<{ key: string; value: unknown }> | null,
    settingsReject: null as Error | null,
    queries: [] as Array<{ table: string; ops: Op[] }>,
    announcements: [] as Array<Record<string, unknown>>,
    announcementsThrows: null as Error | null,
    announcementCalls: 0,
    logs: [] as Array<{ level: string; ctx: Record<string, unknown>; msg: string; fields?: Record<string, unknown> }>,
}));

vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
        from: (table: string) => {
            const q = { table, ops: [] as Op[] };
            h.queries.push(q);
            return {
                select: (...a: unknown[]) => {
                    q.ops.push(['select', a]);
                    return {
                        in: async (...b: unknown[]) => {
                            q.ops.push(['in', b]);
                            if (h.settingsReject) throw h.settingsReject;
                            return { data: h.settings, error: null };
                        },
                    };
                },
            };
        },
    }),
}));

vi.mock('../lib/db', () => ({
    getLoginScreenAnnouncements: async () => {
        h.announcementCalls++;
        if (h.announcementsThrows) throw h.announcementsThrows;
        return { announcements: structuredClone(h.announcements) };
    },
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    const readFileSync = ((p: unknown, ...rest: unknown[]) => {
        if (String(p).endsWith('index.html')) {
            h.readCount++;
            if (h.readThrows) throw h.readThrows;
            return h.template;
        }
        return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.readFileSync;
    return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    type L = typeof actual.log;
    const mk = (ctx: Record<string, unknown>): L => ({
        debug: (msg, fields) => { h.logs.push({ level: 'debug', ctx, msg, fields }); },
        info: (msg, fields) => { h.logs.push({ level: 'info', ctx, msg, fields }); },
        warn: (msg, fields) => { h.logs.push({ level: 'warn', ctx, msg, fields }); },
        error: (msg, fields) => { h.logs.push({ level: 'error', ctx, msg, fields }); },
        child: (more) => mk({ ...ctx, ...more }),
    });
    return { ...actual, log: mk({}) };
});

import handler from '../api/index';
import { accentRampCss } from '../lib/orgTheme';

const TEMPLATE = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    '<title>Static Title</title>',
    '<link rel="manifest" href="/manifest.json">',
    `<link rel='icon' type="image/svg+xml" href="/static-icon.svg">`,
    '<link rel="apple-touch-icon" href="/static-apple.png">',
    '<meta name="description" content="static description" />',
    '<meta name="theme-color" content="#000000">',
    '<meta property="og:title" content="static" />',
    '<script type="module" crossorigin src="/assets/index.js"></script>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    '<script src="/pwa-init.js"></script>',
    '</body>',
    '</html>',
].join('\n');

interface Rendered { html: string; headers: Record<string, string>; redirect: [number, string] | null }

async function render(opts: { nonce?: string | null; headers?: Record<string, string>; using?: typeof handler } = {}): Promise<Rendered> {
    const out: Rendered = { html: '', headers: {}, redirect: null };
    const res = {
        locals: opts.nonce === null ? {} : { cspNonce: opts.nonce ?? 'n0nce' },
        setHeader: (k: string, v: string) => { out.headers[k] = v; return res; },
        send: (b: string) => { out.html = b; return res; },
        redirect: (code: number, loc: string) => { out.redirect = [code, loc]; return res; },
    };
    const req = { headers: opts.headers ?? { host: 'org.example' } };
    await (opts.using ?? handler)(req as never, res as never);
    return out;
}

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const meta = (doc: Document, attr: 'name' | 'property', v: string) =>
    Array.from(doc.querySelectorAll('meta')).filter((m) => m.getAttribute(attr) === v);

/** Pull the JSON object literal assigned to `window.<name>=` out of the inline script. */
function injectedJson(html: string, name: string): unknown {
    const marker = `window.${name}=`;
    const start = html.indexOf(marker);
    if (start < 0) return undefined;
    const from = start + marker.length;
    let depth = 0, inStr = false, esc = false;
    for (let i = from; i < html.length; i++) {
        const ch = html[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return JSON.parse(html.slice(from, i + 1));
        }
    }
    throw new Error(`unterminated window.${name} payload`);
}

function inlineScript(doc: Document): string {
    const inline = Array.from(doc.querySelectorAll('script')).filter((s) => !s.hasAttribute('src'));
    expect(inline).toHaveLength(1);
    return inline[0].textContent ?? '';
}

const doc = (...content: unknown[]) => JSON.stringify({ type: 'doc', content });

beforeEach(() => {
    h.template = TEMPLATE;
    h.readThrows = null;
    h.settings = [];
    h.settingsReject = null;
    h.queries = [];
    h.announcements = [];
    h.announcementsThrows = null;
    h.announcementCalls = 0;
    h.logs = [];
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe('SSR shell — settings read, headers, defaults', () => {
    it('reads the five settings keys with explicit columns, once per request', async () => {
        await render();
        expect(h.queries).toEqual([{
            table: 'settings',
            ops: [
                ['select', ['key, value']],
                ['in', ['key', ['brandingConfig', 'openGraphConfig', 'publicPageConfig', 'setup_completed', 'themeConfig']]],
            ],
        }]);
    });

    it('serves HTML with no-store on the browser AND the CDN', async () => {
        const r = await render();
        expect(r.redirect).toBeNull();
        expect(r.headers).toEqual({
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'CDN-Cache-Control': 'no-store',
        });
    });

    it('a null settings result renders every default', async () => {
        h.settings = null;
        const r = await render();
        const d = parse(r.html);
        expect(d.title).toBe('Operations Dashboard');
        expect(meta(d, 'name', 'description').map((m) => m.content)).toEqual(['Secure Operations Terminal']);
        expect(meta(d, 'name', 'theme-color').map((m) => m.content)).toEqual(['#0f172a']);
        expect(meta(d, 'name', 'apple-mobile-web-app-title').map((m) => m.content)).toEqual(['Dashboard']);
        expect(meta(d, 'property', 'og:title').map((m) => m.content)).toEqual(['Operations Dashboard']);
        expect(meta(d, 'property', 'og:image').map((m) => m.content)).toEqual(['/icon.svg']);
        expect(meta(d, 'property', 'og:site_name').map((m) => m.content)).toEqual(['Dashboard']);
        expect(meta(d, 'property', 'og:url').map((m) => m.content)).toEqual(['https://org.example']);
        expect(meta(d, 'name', 'twitter:card').map((m) => m.content)).toEqual(['summary_large_image']);
        expect(meta(d, 'name', 'twitter:image').map((m) => m.content)).toEqual(['/icon.svg']);
        expect(d.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/icon.svg');
        expect(d.getElementById('__bs_icon__')?.getAttribute('src')).toBe('/icon.svg');
        expect(injectedJson(r.html, '__BRANDING__')).toEqual({ name: 'Dashboard', iconUrl: '/icon.svg' });
        expect(r.html).toContain('window.__SETUP_COMPLETED__=false');
        expect(r.html).not.toContain('__PUBLIC_PAGE__');
        expect(r.html).not.toContain('__org_theme__');
        expect(h.announcementCalls).toBe(0);
    });

    it('OG values beat branding; the splash keeps the real logo while the tab icon honours the favicon override', async () => {
        h.settings = [
            { key: 'brandingConfig', value: { name: 'Brand Name', iconUrl: '/brand-logo.png', themeColor: '#111111' } },
            { key: 'openGraphConfig', value: { title: 'OG Title', description: 'OG desc', imageUrl: '/og.png', themeColor: '#222222', faviconUrl: '/fav.ico' } },
        ];
        const r = await render();
        const d = parse(r.html);
        expect(d.title).toBe('OG Title');
        expect(meta(d, 'property', 'og:title').map((m) => m.content)).toEqual(['OG Title']);
        expect(meta(d, 'name', 'twitter:title').map((m) => m.content)).toEqual(['OG Title']);
        expect(meta(d, 'property', 'og:description').map((m) => m.content)).toEqual(['OG desc']);
        expect(meta(d, 'property', 'og:image').map((m) => m.content)).toEqual(['/og.png']);
        expect(meta(d, 'name', 'theme-color').map((m) => m.content)).toEqual(['#222222']);
        // siteName is always the BRANDING name.
        expect(meta(d, 'property', 'og:site_name').map((m) => m.content)).toEqual(['Brand Name']);
        expect(d.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/fav.ico');
        expect(d.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')).toBe('/fav.ico');
        expect(d.getElementById('__bs_icon__')?.getAttribute('src')).toBe('/brand-logo.png');
        expect(injectedJson(r.html, '__BRANDING__')).toEqual({ name: 'Brand Name', iconUrl: '/brand-logo.png' });
    });

    it('branding fills in when OG is absent (title, theme colour, icon)', async () => {
        h.settings = [{ key: 'brandingConfig', value: { name: 'Brand Name', iconUrl: '/brand-logo.png', themeColor: '#111111' } }];
        const d = parse((await render()).html);
        expect(d.title).toBe('Brand Name');
        expect(meta(d, 'name', 'theme-color').map((m) => m.content)).toEqual(['#111111']);
        expect(d.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/brand-logo.png');
    });

    it('og:url prefers the forwarded proto/host over the Host header', async () => {
        const d = parse((await render({ headers: { host: 'internal:3000', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'public.example' } })).html);
        expect(meta(d, 'property', 'og:url').map((m) => m.content)).toEqual(['http://public.example']);
    });
});

// ---------------------------------------------------------------------------
describe('SSR shell — document structure', () => {
    it('static manifest/icon links are replaced by exactly one dynamic set; existing meta tags are replaced, not duplicated', async () => {
        const r = await render();
        const d = parse(r.html);
        const manifests = d.querySelectorAll('link[rel="manifest"]');
        expect(manifests).toHaveLength(1);
        expect(manifests[0].getAttribute('href')).toBe('/api/manifest');
        expect(d.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
        expect(d.querySelectorAll('link[rel="apple-touch-icon"]')).toHaveLength(1);
        expect(r.html).not.toContain('/manifest.json');
        expect(r.html).not.toContain('/static-icon.svg');
        expect(r.html).not.toContain('/static-apple.png');
        for (const [attr, v] of [['name', 'description'], ['name', 'theme-color'], ['property', 'og:title'], ['name', 'twitter:card'], ['property', 'og:url']] as const) {
            expect(meta(d, attr, v), `${attr}=${v}`).toHaveLength(1);
        }
        expect(r.html).not.toContain('static description');
        // All injected head content stays in <head>; the splash follows #root in <body>.
        expect(d.head.querySelectorAll('meta[property="og:site_name"]')).toHaveLength(1);
        expect(d.getElementById('root')?.nextElementSibling?.id).toBe('__boot_splash__');
    });

    it('the CSP nonce is stamped onto EVERY <script> exactly once', async () => {
        const r = await render({ nonce: 'abc123XYZ' });
        const d = parse(r.html);
        const scripts = Array.from(d.querySelectorAll('script'));
        expect(scripts).toHaveLength(3); // module entry + pwa-init + the injected boot script
        for (const s of scripts) expect(s.getAttribute('nonce')).toBe('abc123XYZ');
        expect(count(r.html, '<script')).toBe(3);
        expect(count(r.html, 'nonce="abc123XYZ"')).toBe(3);
        expect(count(r.html, 'nonce=')).toBe(3);
    });

    it('without an issued nonce no nonce attribute is emitted at all', async () => {
        const r = await render({ nonce: null });
        expect(r.html).not.toContain('nonce=');
        expect(count(r.html, '<script')).toBe(3);
        const r2 = await render({ nonce: '' });
        expect(r2.html).not.toContain('nonce=');
    });

    it('setup_completed is surfaced only when strictly true', async () => {
        h.settings = [{ key: 'setup_completed', value: true }];
        expect((await render()).html).toContain('window.__SETUP_COMPLETED__=true');
        h.settings = [{ key: 'setup_completed', value: 'true' }];
        expect((await render()).html).toContain('window.__SETUP_COMPLETED__=false');
    });
});

// ---------------------------------------------------------------------------
describe('SSR shell — hostile operator values stay inert (XSS)', () => {
    const NAME = `"><script>alert('n')</script><img src=x onerror=alert(1)>'`;
    const DESC = `</title></head><body onload=alert(2)><script>alert('d')</script>`;
    const IMG = `https://cdn.example/x.png" onerror="alert(3)`;
    const ICON = `/logo.png" onload="alert(4)`;
    const FAV = `/fav.ico"><script>alert(5)</script>`;

    it('every sink parses back to the exact operator string as text/attribute data', async () => {
        h.settings = [
            { key: 'brandingConfig', value: { name: NAME, iconUrl: ICON } },
            { key: 'openGraphConfig', value: { description: DESC, imageUrl: IMG, faviconUrl: FAV } },
        ];
        const r = await render();
        const d = parse(r.html);

        // Exact round-trip through every sink.
        expect(d.title).toBe(NAME);
        expect(meta(d, 'name', 'description').map((m) => m.content)).toEqual([DESC]);
        expect(meta(d, 'property', 'og:description').map((m) => m.content)).toEqual([DESC]);
        expect(meta(d, 'property', 'og:image').map((m) => m.content)).toEqual([IMG]);
        expect(meta(d, 'name', 'twitter:image').map((m) => m.content)).toEqual([IMG]);
        expect(meta(d, 'property', 'og:site_name').map((m) => m.content)).toEqual([NAME]);
        expect(d.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe(FAV);
        expect(d.getElementById('__bs_icon__')?.getAttribute('src')).toBe(ICON);
        expect(d.querySelector('#__boot_splash__ h1')?.firstChild?.textContent).toBe(NAME);
        expect(injectedJson(r.html, '__BRANDING__')).toEqual({ name: NAME, iconUrl: ICON });

        // No element was injected: only the three expected scripts, no img besides the
        // splash icon, no event-handler attributes anywhere, body has no onload.
        expect(d.querySelectorAll('script')).toHaveLength(3);
        expect(d.querySelectorAll('img')).toHaveLength(1);
        for (const el of Array.from(d.querySelectorAll('*'))) {
            for (const a of Array.from(el.attributes)) expect(a.name.startsWith('on'), `${el.tagName}[${a.name}]`).toBe(false);
        }
        expect(count(r.html, '</script>')).toBe(3);
        // The inline script contains no raw angle brackets at all.
        expect(inlineScript(d)).not.toMatch(/[<>]/);
    });

    it('a hostile Host header cannot break out of og:url', async () => {
        const host = `evil.example"><script>alert(6)</script>`;
        const r = await render({ headers: { host } });
        const d = parse(r.html);
        expect(meta(d, 'property', 'og:url').map((m) => m.content)).toEqual([`https://${host}`]);
        expect(d.querySelectorAll('script')).toHaveLength(3);
    });

    it('the org accent reaches CSS only as a re-validated hex ramp', async () => {
        h.settings = [{ key: 'themeConfig', value: { enabled: true, accent: '#FF8800' } }];
        let r = await render();
        const style = parse(r.html).getElementById('__org_theme__');
        expect(style?.parentElement?.tagName).toBe('HEAD');
        expect(style?.textContent).toBe(`:root{${accentRampCss('#ff8800')}}`);
        expect(style?.textContent).toMatch(/^:root\{(--color-sky-\d+:oklch\([\d.]+% [\d.]+ [\d.]+\);?)+\}$/);

        for (const value of [
            { enabled: true, accent: '#fff;}</style><script>alert(7)</script>' },
            { enabled: true, accent: 'red' },
            { enabled: 'true', accent: '#ff8800' },
            { enabled: false, accent: '#ff8800' },
        ]) {
            h.settings = [{ key: 'themeConfig', value }];
            r = await render();
            expect(r.html, JSON.stringify(value)).not.toContain('__org_theme__');
            expect(r.html).not.toContain('alert(7)');
        }
    });
});

// ---------------------------------------------------------------------------
describe('SSR shell — __PUBLIC_PAGE__ is an exact public projection', () => {
    const NOW = new Date('2026-07-01T12:00:00.000Z');

    function pageSettings(cfg: Record<string, unknown>) {
        return [
            { key: 'brandingConfig', value: { name: 'Pub Org', iconUrl: '/pub.png', botToken: 'BOT-SECRET' } },
            { key: 'publicPageConfig', value: { enabled: true, ...cfg } },
        ];
    }

    it('only an enabled === true page is injected; otherwise no payload and no announcement read', async () => {
        for (const enabled of [false, 'true', 1, undefined]) {
            h.settings = [{ key: 'publicPageConfig', value: { enabled, motto: 'x' } }];
            const r = await render();
            expect(r.html, String(enabled)).not.toContain('__PUBLIC_PAGE__');
        }
        expect(h.announcementCalls).toBe(0);
    });

    it('ships exactly the public fields; featured ids, notes, webhooks and branding secrets never cross', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        h.settings = pageSettings({
            motto: 'Fly safe',
            blurb: 'Plain blurb',
            heroImageUrl: 'https://cdn.example/hero.png',
            profileImageUrl: 'javascript:alert(1)',
            modules: { stats: 1, testimonials: 0, services: 'yes', secretModule: true },
            links: [{ id: 'l1', label: 'Discord', url: 'https://discord.gg/x', icon: 'discord', webhookSecret: 'whsec_X' }],
            featuredTestimonialIds: ['0d6f2a2e-1111-4111-8111-111111111111'],
            adminNotes: 'PRIVATE-NOTE',
            webhookUrl: 'https://discord.com/api/webhooks/1/SECRET',
        });
        const r = await render();
        const page = injectedJson(r.html, '__PUBLIC_PAGE__');
        expect(page).toEqual({
            enabled: true,
            org: { name: 'Pub Org', iconUrl: '/pub.png' },
            motto: 'Fly safe',
            blurb: 'Plain blurb',
            blurbHtml: '',
            heroImageUrl: 'https://cdn.example/hero.png',
            profileImageUrl: '',
            modules: { stats: true, testimonials: false, services: true, links: false },
            links: [{ id: 'l1', label: 'Discord', url: 'https://discord.gg/x', icon: 'discord' }],
            announcements: [],
        });
        expect(Object.keys(page as object).sort()).toEqual(['announcements', 'blurb', 'blurbHtml', 'enabled', 'heroImageUrl', 'links', 'modules', 'motto', 'org', 'profileImageUrl']);
        for (const leak of ['featuredTestimonialIds', '0d6f2a2e-1111', 'PRIVATE-NOTE', 'adminNotes', 'webhooks/1/SECRET', 'whsec_X', 'BOT-SECRET', 'secretModule']) {
            expect(r.html, leak).not.toContain(leak);
        }
        expect(h.announcementCalls).toBe(1);
    });

    it('links: require id+label+url strings, drop unsafe URLs, cap at 10, icon only when a non-empty string', async () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, label: `M${i}`, url: `https://m${i}.example/` }));
        h.settings = pageSettings({
            links: [
                null,
                { label: 'NoId', url: 'https://noid.example/' },
                { id: 'num-label', label: 7, url: 'https://x.example/' },
                { id: 'js', label: 'JS', url: 'javascript:alert(1)' },
                { id: 'priv', label: 'Private', url: 'http://10.0.0.5/admin' },
                { id: 'empty-icon', label: 'E', url: 'https://e.example/', icon: '' },
                { id: 'num-icon', label: 'N', url: 'https://n.example/', icon: 5 },
                ...many,
            ],
        });
        const page = injectedJson((await render()).html, '__PUBLIC_PAGE__') as { links: Array<Record<string, unknown>> };
        expect(page.links).toHaveLength(10);
        expect(page.links.slice(0, 2)).toEqual([
            { id: 'empty-icon', label: 'E', url: 'https://e.example/' },
            { id: 'num-icon', label: 'N', url: 'https://n.example/' },
        ]);
        expect(page.links.map((l) => l.id)).toEqual(['empty-icon', 'num-icon', 'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
        for (const l of page.links) expect(Object.keys(l).sort()).toEqual(['id', 'label', 'url']);
    });

    it('non-array links and non-string motto degrade to empty values', async () => {
        h.settings = pageSettings({ links: 'https://x.example', motto: 42, modules: undefined });
        const page = injectedJson((await render()).html, '__PUBLIC_PAGE__') as Record<string, unknown>;
        expect(page.links).toEqual([]);
        expect(page.motto).toBe('');
        expect(page.modules).toEqual({ stats: false, testimonials: false, services: false, links: false });
    });

    it.each([
        ['plain text', 'Line one', 'Line one', ''],
        ['whitespace only', '   \n ', '', ''],
        ['non-string', 42, '', ''],
        ['empty Tiptap doc', doc({ type: 'paragraph' }), '', ''],
        ['Tiptap doc with hostile text', doc({ type: 'paragraph', content: [{ type: 'text', text: 'Hi <script>x</script>', marks: [{ type: 'bold' }] }] }), '', '<p><strong>Hi &lt;script&gt;x&lt;/script&gt;</strong></p>'],
    ])('blurb %s → { blurb, blurbHtml } as expected', async (_label, blurb, wantText, wantHtml) => {
        h.settings = pageSettings({ blurb });
        const r = await render();
        const page = injectedJson(r.html, '__PUBLIC_PAGE__') as { blurb: string; blurbHtml: string };
        expect(page.blurb).toBe(wantText);
        expect(page.blurbHtml).toBe(wantHtml);
        expect(inlineScript(parse(r.html))).not.toMatch(/[<>]/);
    });

    it('announcements: Login Screen audience only, unexpired only, newest first, exact projection', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const base = { author: 'Dispatch', type: 'info', authorId: 'user-uuid-9', internalNotes: 'STAFF-ONLY' };
        h.announcements = [
            { ...base, id: 'old', title: 'Old', body: 'b', audience: ['Login Screen'], publishDate: '2026-01-01T00:00:00Z' },
            { ...base, id: 'staff', title: 'Staff', body: 'b', audience: ['Staff'], publishDate: '2026-06-30T00:00:00Z' },
            { ...base, id: 'noaud', title: 'NoAud', body: 'b', audience: 'Login Screen', publishDate: '2026-06-30T00:00:00Z' },
            { ...base, id: 'expired', title: 'Expired', body: 'b', audience: ['Login Screen'], publishDate: '2026-06-01T00:00:00Z', expiryDate: '2026-07-01T11:59:59Z' },
            { ...base, id: 'badexp', title: 'BadExp', body: 'b', audience: ['Login Screen'], publishDate: '2026-06-01T00:00:00Z', expiryDate: 'not-a-date' },
            { ...base, id: 'new', title: 'New', body: 'b', audience: ['Login Screen', 'Staff'], publishDate: '2026-06-15T00:00:00Z', expiryDate: '2026-07-01T12:00:01Z' },
            { ...base, id: 'undated', title: 'Undated', body: 'b', audience: ['Login Screen'], publishDate: 'garbage' },
        ];
        h.settings = pageSettings({});
        const r = await render();
        const page = injectedJson(r.html, '__PUBLIC_PAGE__') as { announcements: Array<Record<string, unknown>> };
        expect(page.announcements).toEqual([
            { id: 'new', title: 'New', body: 'b', author: 'Dispatch', type: 'info', audience: ['Login Screen', 'Staff'], publishDate: '2026-06-15T00:00:00Z', expiryDate: '2026-07-01T12:00:01Z' },
            { id: 'old', title: 'Old', body: 'b', author: 'Dispatch', type: 'info', audience: ['Login Screen'], publishDate: '2026-01-01T00:00:00Z' },
            { id: 'undated', title: 'Undated', body: 'b', author: 'Dispatch', type: 'info', audience: ['Login Screen'], publishDate: 'garbage' },
        ]);
        expect(r.html).not.toContain('STAFF-ONLY');
        expect(r.html).not.toContain('user-uuid-9');
        expect(r.html).not.toContain('authorId');
    });

    it('a failing announcement read ships an empty list and still renders the page', async () => {
        h.announcementsThrows = new Error('db down');
        h.settings = pageSettings({ motto: 'Still here' });
        const r = await render();
        expect(r.redirect).toBeNull();
        const page = injectedJson(r.html, '__PUBLIC_PAGE__') as { motto: string; announcements: unknown[] };
        expect(page.motto).toBe('Still here');
        expect(page.announcements).toEqual([]);
    });

    it('a hostile announcement body cannot close the inline script', async () => {
        h.announcements = [{ id: 'x', title: '</script><script>alert(8)</script>', body: '<!--', author: 'a', type: 't', audience: ['Login Screen'], publishDate: '2026-01-01T00:00:00Z' }];
        h.settings = pageSettings({});
        const r = await render();
        const d = parse(r.html);
        expect(d.querySelectorAll('script')).toHaveLength(3);
        expect(inlineScript(d)).not.toMatch(/[<>]/);
        const page = injectedJson(r.html, '__PUBLIC_PAGE__') as { announcements: Array<{ title: string; body: string }> };
        expect(page.announcements[0].title).toBe('</script><script>alert(8)</script>');
        expect(page.announcements[0].body).toBe('<!--');
    });
});

// ---------------------------------------------------------------------------
describe('SSR shell — fail-safe', () => {
    it('a settings read failure redirects to the static shell and logs the error; nothing partial is sent', async () => {
        const boom = new Error('settings unavailable');
        h.settingsReject = boom;
        const r = await render();
        expect(r.redirect).toEqual([302, '/index.html']);
        expect(r.html).toBe('');
        expect(r.headers).toEqual({});
        expect(h.logs).toEqual([{ level: 'error', ctx: { module: 'api.index' }, msg: 'ssr injection failed', fields: { err: boom } }]);
    });

    it('index.html is read from disk once and reused across requests', async () => {
        vi.resetModules();
        const fresh = (await import('../api/index')).default;
        const before = h.readCount;
        await render({ using: fresh });
        await render({ using: fresh });
        await render({ using: fresh });
        expect(h.readCount - before).toBe(1);
    });

    it('an unreadable index.html (fresh process) redirects to the static shell', async () => {
        vi.resetModules();
        const fresh = (await import('../api/index')).default;
        const boom = new Error('ENOENT: dist/index.html');
        h.readThrows = boom;
        const r = await render({ using: fresh });
        expect(r.redirect).toEqual([302, '/index.html']);
        expect(h.logs.at(-1)).toEqual({ level: 'error', ctx: { module: 'api.index' }, msg: 'ssr injection failed', fields: { err: boom } });
        // Not cached on failure: the next request retries the read.
        h.readThrows = null;
        const ok = await render({ using: fresh });
        expect(ok.redirect).toBeNull();
        expect(ok.html).toContain('__boot_splash__');
    });
});
