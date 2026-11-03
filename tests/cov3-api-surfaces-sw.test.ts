import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import vm from 'node:vm';

// api/sw.ts — GET /sw.js, the dynamically generated service worker.
//
// The admin-controlled org name and PWA icon URL are interpolated into JavaScript
// SOURCE. The CSP nonce does not cover /sw.js (it is served as a script, not an inline
// block), so JSON.stringify is the only defence at this sink. These tests do not just
// grep the body: they EXECUTE the generated worker in an isolated vm context and prove
// a hostile name/URL comes back out as the exact same string — no breakout, no side
// effect. Also pinned: the one settings read (explicit columns, two keys), defaults when
// the read yields nothing, the no-store/Service-Worker-Allowed headers, and the per-deploy
// cache name that purges stale caches on activate.

type Op = [string, unknown[]];

const h = vi.hoisted(() => ({
    created: [] as Array<[string, string]>,
    queries: [] as Array<{ table: string; ops: Op[] }>,
    result: { data: null, error: null } as { data: unknown; error: unknown },
}));

vi.mock('@supabase/supabase-js', () => ({
    createClient: (url: string, key: string) => {
        h.created.push([url, key]);
        return {
            from: (table: string) => {
                const q = { table, ops: [] as Op[] };
                h.queries.push(q);
                const chain: Record<string, unknown> = {};
                for (const m of ['select', 'in']) chain[m] = (...a: unknown[]) => { q.ops.push([m, a]); return chain; };
                chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(h.result).then(ok, bad);
                return chain;
            },
        };
    },
}));

type Handler = (req: unknown, res: unknown) => Promise<void>;

interface Sent { status: number; headers: Record<string, string>; body: string }

async function loadHandler(at: Date): Promise<Handler> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    vi.resetModules();
    const mod = await import('../api/sw');
    vi.useRealTimers();
    return mod.default as Handler;
}

async function render(handler: Handler): Promise<Sent> {
    const sent: Sent = { status: 0, headers: {}, body: '' };
    const res = {
        setHeader: (k: string, v: string) => { sent.headers[k] = v; return res; },
        status: (c: number) => { sent.status = c; return res; },
        send: (b: string) => { sent.body = b; return res; },
    };
    await handler({ method: 'GET', headers: {} }, res);
    return sent;
}

function settingsRows(branding?: unknown, og?: unknown) {
    const rows: Array<{ key: string; value: unknown }> = [];
    if (branding !== undefined) rows.push({ key: 'brandingConfig', value: branding });
    if (og !== undefined) rows.push({ key: 'openGraphConfig', value: og });
    return rows;
}

/** Execute the generated worker in a fresh vm context with stubbed SW globals. */
function bootWorker(code: string, origin = 'https://org.example') {
    const listeners: Record<string, (ev: unknown) => unknown> = {};
    const shown: Array<{ title: unknown; options: Record<string, unknown> }> = [];
    const cacheAdds: string[] = [];
    const cacheOpens: string[] = [];
    const cacheDeletes: string[] = [];
    let cacheKeys: string[] = [];
    const self = {
        addEventListener: (type: string, fn: (ev: unknown) => unknown) => { listeners[type] = fn; },
        skipWaiting: vi.fn(),
        clients: { claim: vi.fn(() => 'claimed') },
        location: new URL(origin),
        registration: { showNotification: (title: unknown, options: Record<string, unknown>) => { shown.push({ title, options }); return Promise.resolve(); } },
    };
    const caches = {
        open: (name: string) => {
            cacheOpens.push(name);
            return Promise.resolve({ add: (u: string) => { cacheAdds.push(u); return Promise.resolve(); }, put: () => Promise.resolve() });
        },
        keys: () => Promise.resolve(cacheKeys),
        delete: (name: string) => { cacheDeletes.push(name); return Promise.resolve(true); },
        match: () => Promise.resolve(undefined),
    };
    const sandbox: Record<string, unknown> = {
        self, caches, URL, console: { warn: () => {} },
        clients: { matchAll: () => Promise.resolve([]), openWindow: vi.fn() },
        fetch: vi.fn(), Response: { error: () => 'NETWORK_ERROR' },
    };
    vm.runInNewContext(code, sandbox);
    return {
        sandbox, listeners, shown, cacheAdds, cacheOpens, cacheDeletes,
        setCacheKeys: (k: string[]) => { cacheKeys = k; },
        async install() {
            let wait: Promise<unknown> = Promise.resolve();
            listeners.install({ waitUntil: (p: Promise<unknown>) => { wait = p; } });
            await wait;
        },
        async activate() {
            let wait: Promise<unknown> = Promise.resolve();
            const ret = listeners.activate({ waitUntil: (p: Promise<unknown>) => { wait = p; } });
            await wait;
            return ret;
        },
        async push(data: { json: () => unknown; text: () => string } | null) {
            let wait: Promise<unknown> = Promise.resolve();
            listeners.push({ data, waitUntil: (p: Promise<unknown>) => { wait = p; } });
            await wait;
        },
    };
}

const badJson = (text: string) => ({ json: () => { throw new SyntaxError('bad'); }, text: () => text });

let handler: Handler;
const T0 = new Date('2026-05-06T07:08:09.000Z');

beforeEach(async () => {
    h.created = [];
    h.queries = [];
    h.result = { data: [], error: null };
    handler = await loadHandler(T0);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('GET /sw.js — the settings read', () => {
    it('builds the client from the service env and reads exactly two settings keys with explicit columns', async () => {
        expect(h.created).toEqual([[process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY]]);
        await render(handler);
        expect(h.queries).toEqual([{
            table: 'settings',
            ops: [['select', ['key, value']], ['in', ['key', ['brandingConfig', 'openGraphConfig']]]],
        }]);
    });

    it('serves JS with no-store caching and a root Service-Worker-Allowed scope', async () => {
        const sent = await render(handler);
        expect(sent.status).toBe(200);
        expect(sent.headers).toEqual({
            'Content-Type': 'application/javascript',
            'Service-Worker-Allowed': '/',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
    });
});

describe('GET /sw.js — defaults and precedence', () => {
    it('a failed / empty read falls back to the default name and same-origin icon', async () => {
        h.result = { data: null, error: { message: 'down' } };
        const w = bootWorker((await render(handler)).body);
        await w.push(badJson('fallback body'));
        expect(w.shown).toHaveLength(1);
        expect(w.shown[0].title).toBe('Operations Terminal');
        expect(w.shown[0].options).toMatchObject({ body: 'fallback body', icon: '/icon.svg', badge: '/icon.svg' });
        await w.install();
        expect(w.cacheAdds).toEqual(['/icon.svg']);
    });

    it('rows present but empty objects still use the defaults', async () => {
        h.result = { data: settingsRows({}, {}), error: null };
        const w = bootWorker((await render(handler)).body);
        await w.push({ json: () => ({ body: 'b' }), text: () => '' });
        expect(w.shown[0].title).toBe('Operations Terminal');
        expect(w.shown[0].options.icon).toBe('/icon.svg');
    });

    it('the PWA icon override beats the branding icon, which beats the default', async () => {
        h.result = { data: settingsRows({ name: 'Org', iconUrl: '/brand.png' }, { pwaIconUrl: '/pwa.png' }), error: null };
        let w = bootWorker((await render(handler)).body);
        await w.push({ json: () => ({}), text: () => '' });
        expect(w.shown[0].options).toMatchObject({ icon: '/pwa.png', badge: '/pwa.png' });

        h.result = { data: settingsRows({ name: 'Org', iconUrl: '/brand.png' }, {}), error: null };
        w = bootWorker((await render(handler)).body);
        await w.push({ json: () => ({}), text: () => '' });
        expect(w.shown[0].options).toMatchObject({ icon: '/brand.png', badge: '/brand.png' });
        expect(w.shown[0].title).toBe('Org');
    });

    it('only a SAME-ORIGIN icon is pre-cached; an external icon is left to the browser', async () => {
        h.result = { data: settingsRows({ iconUrl: 'https://cdn.example/i.png' }), error: null };
        const w = bootWorker((await render(handler)).body);
        await w.install();
        expect(w.cacheAdds).toEqual([]);
        expect((w.sandbox.self as { skipWaiting: ReturnType<typeof vi.fn> }).skipWaiting).toHaveBeenCalledTimes(1);
    });
});

describe('GET /sw.js — admin strings are inert inside the worker source', () => {
    const HOSTILE_NAMES = [
        `"; self.pwned = 1; //`,
        `'; self.pwned = 1; //`,
        '`${self.pwned = 1}`',
        `</script><script>self.pwned=1</script>`,
        `line1\nline2\r\n\u2028\u2029 tab\t back\\slash`,
        `\\"; self.pwned = 1; //`,
    ];

    it.each(HOSTILE_NAMES)('org name %j round-trips exactly as the notification title with no side effect', async (name) => {
        h.result = { data: settingsRows({ name }), error: null };
        const body = (await render(handler)).body;
        expect(body).toContain(JSON.stringify(name));
        const w = bootWorker(body);
        expect(w.sandbox.self).not.toHaveProperty('pwned');
        expect(w.sandbox).not.toHaveProperty('pwned');
        // Both interpolation sites: the text() fallback title and the default title.
        await w.push(badJson('x'));
        await w.push({ json: () => ({ body: 'y' }), text: () => '' });
        expect(w.shown.map((s) => s.title)).toEqual([name, name]);
        expect(w.sandbox.self).not.toHaveProperty('pwned');
    });

    it('a hostile icon URL round-trips exactly into icon/badge and the pre-cache list', async () => {
        const icon = `/i.png"; self.pwned = 1; caches.open('x'); //\u2028`;
        h.result = { data: settingsRows({ name: 'Org' }, { pwaIconUrl: icon }), error: null };
        const w = bootWorker((await render(handler)).body);
        expect(w.sandbox.self).not.toHaveProperty('pwned');
        expect(w.cacheOpens).toEqual([]);
        await w.push({ json: () => ({}), text: () => '' });
        expect(w.shown[0].options).toMatchObject({ icon, badge: icon });
        await w.install();
        expect(w.cacheAdds).toEqual([icon]);
    });
});

describe('GET /sw.js — per-deploy cache name', () => {
    it('is stable within a process and derived from the start-up clock', async () => {
        const deployId = T0.getTime().toString(36);
        const a = (await render(handler)).body;
        const b = (await render(handler)).body;
        expect(a).toBe(b);
        const w = bootWorker(a);
        await w.install();
        expect(w.cacheOpens).toEqual([`myrsi-v19-${deployId}`]);
    });

    it('a redeploy (new module instance, later clock) gets a new cache name and activate purges the old one', async () => {
        const oldName = `myrsi-v19-${T0.getTime().toString(36)}`;
        const T1 = new Date(T0.getTime() + 3_600_000);
        const next = await loadHandler(T1);
        const newName = `myrsi-v19-${T1.getTime().toString(36)}`;
        expect(newName).not.toBe(oldName);

        const w = bootWorker((await render(next)).body);
        await w.install();
        expect(w.cacheOpens).toEqual([newName]);
        w.setCacheKeys([oldName, newName, 'some-other-cache']);
        const ret = await w.activate();
        expect(w.cacheDeletes).toEqual([oldName, 'some-other-cache']);
        expect(ret).toBe('claimed');
    });
});

describe('GET /sw.js — push payload handling in the generated worker', () => {
    it('ignores a push with no data', async () => {
        const w = bootWorker((await render(handler)).body);
        w.listeners.push({ data: null, waitUntil: () => { throw new Error('must not wait'); } });
        expect(w.shown).toEqual([]);
    });

    it('a high-priority tag vibrates long and requires interaction; a normal one does not', async () => {
        const w = bootWorker((await render(handler)).body);
        await w.push({ json: () => ({ title: 'T', body: 'B', tag: 'eam' }), text: () => '' });
        await w.push({ json: () => ({ title: 'T2' }), text: () => '' });
        expect(w.shown[0]).toEqual({
            title: 'T',
            options: {
                body: 'B', icon: '/icon.svg', badge: '/icon.svg',
                vibrate: [300, 100, 300, 100, 300], data: { url: '/' }, tag: 'eam',
                renotify: true, requireInteraction: true, actions: [],
            },
        });
        expect(w.shown[1].options).toMatchObject({
            body: 'Operational Alert', vibrate: [100, 50, 100], tag: 'general-alert',
            renotify: false, requireInteraction: false,
        });
    });
});
