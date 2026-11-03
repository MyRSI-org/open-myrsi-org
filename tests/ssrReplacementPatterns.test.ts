import { describe, it, expect, vi, beforeEach } from 'vitest';

// SSR injection (api/index.ts) — String.prototype.replace REPLACEMENT patterns.
//
// A string passed as the replacement argument is a template, not literal text:
// `$'` inserts everything AFTER the match, `` $` `` everything BEFORE it, `$&` the
// match itself, `$1` a capture group. The handler puts operator/DB-supplied values
// (org name, OG description, public-page announcements — a login-screen notice is
// writable by the default Dispatcher) into those replacements, and neither
// escapeHtml nor escapeJsonForScript touches `$` or a backtick (escapeHtml even
// rewrites `$'` into `$&#39;`, i.e. a `$&`). So the value could splice document
// HTML — the head's own `</script>` included — into the inline boot script served
// to every anonymous visitor. These drive the REAL handler and pin that the
// sequences come out literally and the document structure is untouched.

const h = vi.hoisted(() => ({
    settings: [] as Array<{ key: string; value: unknown }>,
    announcements: [] as Array<Record<string, unknown>>,
    // A compact stand-in for dist/index.html carrying every anchor the handler
    // rewrites: <title>, meta tags (some present, some injected before </head>),
    // icon/manifest links, a module <script>, and the #root mount.
    template: [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="UTF-8" />',
        '<title>Static Title</title>',
        '<link rel="manifest" href="/manifest.json">',
        '<link rel="icon" href="/icon.svg">',
        '<meta name="description" content="static description" />',
        '<meta property="og:title" content="static" />',
        '<script type="module" src="/assets/index.js"></script>',
        '</head>',
        '<body>',
        '<div id="root"></div>',
        '</body>',
        '</html>',
    ].join('\n'),
}));

vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
        from: () => ({
            select: () => ({
                in: async () => ({ data: h.settings, error: null }),
            }),
        }),
    }),
}));

vi.mock('../lib/db', () => ({
    getLoginScreenAnnouncements: async () => ({ announcements: h.announcements }),
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    const readFileSync = ((p: unknown, ...rest: unknown[]) =>
        String(p).endsWith('index.html')
            ? h.template
            : (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof actual.readFileSync;
    return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

import handler, { escapeHtml } from '../api/index';

// Every replacement-pattern sequence, plus surrounding text so a partial
// expansion is visible too.
const HOSTILE = "pre $' mid $` and $& then $1 post";

async function render(): Promise<string> {
    let sent: string | null = null;
    const res = {
        locals: { cspNonce: 'n0nce' },
        setHeader: () => {},
        send: (body: string) => { sent = body; return res; },
        redirect: (_code: number, loc: string) => { throw new Error(`handler fell back to redirect ${loc}`); },
    };
    const req = { headers: { host: 'org.example', 'x-forwarded-proto': 'https' } };
    await handler(req as never, res as never);
    if (sent === null) throw new Error('handler sent nothing');
    return sent;
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

/** Pull the JSON object literal assigned to `window.<name>=` out of the inline script. */
function injectedJson(html: string, name: string): unknown {
    const start = html.indexOf(`window.${name}=`);
    expect(start).toBeGreaterThan(-1);
    const from = start + `window.${name}=`.length;
    // The payload is one JSON object (no raw `<` survives escapeJsonForScript), so
    // scan to its balanced close brace, skipping string contents.
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

/** The document's skeleton is exactly one of each landmark, in order. */
function expectStructureIntact(html: string) {
    for (const landmark of ['<!DOCTYPE html>', '<html lang="en">', '<head>', '</head>', '<body>', '</body>', '</html>', '<div id="root"></div>', '<title>', '__boot_splash__"']) {
        expect(count(html, landmark), landmark).toBe(1);
    }
    expect(html.indexOf('</head>')).toBeLessThan(html.indexOf('<body>'));
    expect(html.indexOf('<body>')).toBeLessThan(html.indexOf('<div id="root"></div>'));
    // The module script from the template plus the one inline boot script — the
    // template's `</script>` was never copied into the inline script.
    expect(count(html, '<script')).toBe(2);
    expect(count(html, '</script>')).toBe(2);
    // Every script got the per-request nonce exactly once.
    expect(count(html, '<script nonce="n0nce"')).toBe(2);
    expect(count(html, 'nonce=')).toBe(2);
}

beforeEach(() => {
    h.settings = [];
    h.announcements = [];
});

describe('SSR handler — replacement patterns in operator/DB values render literally', () => {
    it('a benign config renders the expected skeleton (baseline for the hostile cases)', async () => {
        h.settings = [{ key: 'brandingConfig', value: { name: 'Plain Org' } }];
        const html = await render();
        expectStructureIntact(html);
        expect(html).toContain('<title>Plain Org</title>');
    });

    it('an org name carrying $\' $` $& $1 reaches <title>, meta tags, the splash and __BRANDING__ verbatim', async () => {
        h.settings = [{ key: 'brandingConfig', value: { name: HOSTILE } }];
        const html = await render();
        expectStructureIntact(html);

        const safe = escapeHtml(HOSTILE);
        expect(html).toContain(`<title>${safe}</title>`);
        // og:title replaces an existing tag; og:site_name / apple title are injected
        // before </head> — both replace shapes in replaceTag.
        expect(html).toContain(`<meta property="og:title" content="${safe}" />`);
        expect(html).toContain(`<meta property="og:site_name" content="${safe}" />`);
        expect(html).toContain(`<meta name="apple-mobile-web-app-title" content="${safe}" />`);
        // Splash heading + footer.
        expect(count(html, `${safe}<br/>`)).toBe(1);
        expect(count(html, `${safe} // Termlink`)).toBe(1);

        // The inline script's JSON round-trips to the exact org name.
        expect(injectedJson(html, '__BRANDING__')).toEqual({ name: HOSTILE, iconUrl: '/icon.svg' });
    });

    it('an OG description carrying the sequences fills the description meta tags literally', async () => {
        h.settings = [
            { key: 'brandingConfig', value: { name: 'Plain Org' } },
            { key: 'openGraphConfig', value: { description: HOSTILE } },
        ];
        const html = await render();
        expectStructureIntact(html);

        const safe = escapeHtml(HOSTILE);
        expect(html).toContain(`<meta name="description" content="${safe}" />`);
        expect(html).toContain(`<meta property="og:description" content="${safe}" />`);
        expect(html).toContain(`<meta name="twitter:description" content="${safe}" />`);
        // The static description is gone (replaced, not duplicated alongside).
        expect(html).not.toContain('static description');
    });

    it('a login-screen announcement body/title on the public page lands in __PUBLIC_PAGE__ verbatim', async () => {
        h.settings = [
            { key: 'brandingConfig', value: { name: 'Plain Org' } },
            { key: 'publicPageConfig', value: { enabled: true, motto: HOSTILE } },
        ];
        h.announcements = [{
            id: 'a1', title: HOSTILE, body: HOSTILE, author: 'Dispatch', type: 'info',
            audience: ['Login Screen'], publishDate: '2026-01-01T00:00:00Z',
        }];
        const html = await render();
        expectStructureIntact(html);

        const page = injectedJson(html, '__PUBLIC_PAGE__') as {
            motto: string;
            announcements: Array<{ title: string; body: string }>;
        };
        expect(page.motto).toBe(HOSTILE);
        expect(page.announcements).toHaveLength(1);
        expect(page.announcements[0].body).toBe(HOSTILE);
        expect(page.announcements[0].title).toBe(HOSTILE);
        // __BRANDING__ precedes it in the same script and still parses cleanly.
        expect(injectedJson(html, '__BRANDING__')).toEqual({ name: 'Plain Org', iconUrl: '/icon.svg' });
    });

    it('a favicon URL carrying the sequences is injected literally into the icon links', async () => {
        const url = "https://cdn.example/i.png?a=$'&b=$`&c=$&";
        h.settings = [
            { key: 'brandingConfig', value: { name: 'Plain Org' } },
            { key: 'openGraphConfig', value: { faviconUrl: url } },
        ];
        const html = await render();
        expectStructureIntact(html);
        const safe = escapeHtml(url);
        expect(html).toContain(`<link rel="icon" href="${safe}">`);
        expect(html).toContain(`<link rel="apple-touch-icon" href="${safe}">`);
    });
});
