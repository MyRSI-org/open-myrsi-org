// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';

// server.ts driven end to end: the REAL exported app on an ephemeral loopback port, real
// middleware order, real rate limiters, real body parsers, real CSRF gate. Only the leaf
// handlers (api/*), the database layer and the logger are replaced, so every assertion below is
// about what server.ts itself decides — the status, the headers, the body, which downstream
// function ran and with what arguments.
//
// Client IPs: TRUST_CF_PROXY=1 makes getClientIp honour CF-Connecting-IP (read per request), so
// each test can present its OWN client address. That keeps the per-IP limiters and the abuse
// blackhole from leaking state between tests, and lets the keying itself be asserted.

type Handler = (req: Request, res: Response) => unknown;
type HandlerName = 'services' | 'query' | 'manifest' | 'sw' | 'public' | 'ssr' | 'upload';
interface LogRecord { level: string; msg: string; fields: Record<string, unknown> | undefined }
interface Call { name: HandlerName; path: string; query: Record<string, unknown>; body: unknown; nonce: unknown; method: string }
type UserRow = Record<string, unknown>;

const h = vi.hoisted(() => {
    // Set before ANY import below: lib/storage reads MEDIA_MAX_UPLOAD_BYTES at module load, and the
    // static imports of lib/db pull it in before beforeAll runs.
    vi.stubEnv('TRUST_CF_PROXY', '1');
    vi.stubEnv('MEDIA_MAX_UPLOAD_BYTES', '4096');
    return {
        logs: [] as LogRecord[],
        distDir: '',
        handlers: {} as Partial<Record<HandlerName, Handler>>,
        calls: [] as Call[],
        users: new Map<number, UserRow>(),
        userQueue: [] as Array<UserRow | null | Error>,
        settingsQueue: [] as Array<Record<string, unknown> | Error>,
        banQueue: [] as Array<'clear' | 'banned' | Error>,
        verifyQueue: [] as Array<'real' | null>,
        importImpl: null as null | ((ndjson: string, onEvent: (e: unknown) => void, merge: unknown) => Promise<{ reanchoredAdminUserId: number | null }>),
        importArgs: [] as Array<{ ndjson: string; merge: unknown }>,
        peers: new Map<string, { id: string; name: string }>(),
        fed: {
            respondToPair: vi.fn(),
            getAllianceSelfProfile: vi.fn(),
            getAllianceShareableData: vi.fn(),
            getOperationManifestForPeer: vi.fn(),
            getOperationSnapshotForPeer: vi.fn(),
            acceptInviteForPeer: vi.fn(),
            declineInviteForPeer: vi.fn(),
            upsertAlliedParticipant: vi.fn(),
            removeAlliedParticipant: vi.fn(),
            receiveMirrorInvite: vi.fn(),
            receiveMirrorPush: vi.fn(),
            receiveMirrorRevoke: vi.fn(),
            getAllyRosterProjection: vi.fn(),
            getAllyFleetProjection: vi.fn(),
        },
        /** Wrap a leaf handler: record the call, then run the per-test override or the default. */
        wrap(name: HandlerName, fallback: Handler): Handler {
            return async (req, res) => {
                // res.locals is absent on the /sw.js capture sink, which is not a real response.
                h.calls.push({ name, path: req.path, query: { ...req.query }, body: req.body, nonce: res.locals?.cspNonce, method: req.method });
                await (h.handlers[name] ?? fallback)(req, res);
            };
        },
    };
});

vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => { h.logs.push({ level, msg, fields }); };
    const logger = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), child: () => logger };
    return { ...actual, log: logger };
});

// Point server.ts's `path.resolve(__dirname, '../dist')` at a fixture directory, so the static
// mount and the SSR fallback serve real files. Every other resolve() call is passed through.
vi.mock('path', async (importOriginal) => {
    const actual = await importOriginal<typeof import('path')>();
    const resolve = (...segs: string[]) => (segs.length === 2 && segs[1] === '../dist' && h.distDir ? h.distDir : actual.resolve(...segs));
    const patched = { ...actual, resolve };
    return { ...patched, default: patched };
});

vi.mock('../lib/auth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/auth')>();
    return {
        ...actual,
        verifyToken: (t: string | undefined) => {
            const next = h.verifyQueue.shift();
            return next === undefined || next === 'real' ? actual.verifyToken(t) : next;
        },
    };
});

vi.mock('../lib/db', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/db')>();
    const take = <T>(v: T | Error | undefined): T | undefined => { if (v instanceof Error) throw v; return v; };
    return {
        ...actual,
        ...h.fed,
        getPlatformSettings: async () => take(h.settingsQueue.shift()) ?? {},
        getUserById: async (id: number) => (h.userQueue.length > 0 ? take(h.userQueue.shift()) ?? null : h.users.get(id) ?? null),
        findActiveBan: async () => (take(h.banQueue.shift()) === 'banned' ? { id: 77 } : null),
        importOrgData: async (ndjson: string, onEvent: (e: unknown) => void, merge: unknown) => {
            h.importArgs.push({ ndjson, merge });
            return h.importImpl ? h.importImpl(ndjson, onEvent, merge) : { reanchoredAdminUserId: null };
        },
        getAlliancePeerByInboundKey: async (key: string) => h.peers.get(key) ?? null,
    };
});

vi.mock('../api/services', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/services')>()),
    default: h.wrap('services', (_req, res) => { res.status(200).json({ ok: true }); }),
}));
vi.mock('../api/query', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/query')>()),
    default: h.wrap('query', (req, res) => { res.status(200).json({ ok: true, target: req.query.target ?? null }); }),
    handleManifest: h.wrap('manifest', (_req, res) => { res.status(200).json({ name: 'Org Manifest' }); }),
}));
vi.mock('../api/sw', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/sw')>()),
    default: h.wrap('sw', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        if (!res.headersSent) res.status(200);
        res.send('/* sw v1 */');
    }),
}));
vi.mock('../api/public', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/public')>()),
    default: h.wrap('public', (req, res) => { res.status(200).json({ slug: req.query.slug ?? null }); }),
}));
vi.mock('../api/index', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/index')>()),
    default: h.wrap('ssr', (req, res) => { res.status(200).type('html').send(`<!doctype html><p>ssr ${req.path}</p>`); }),
}));
vi.mock('../api/orgUpload', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/orgUpload')>()),
    default: h.wrap('upload', (_req, res) => { res.status(201).json({ ok: true }); }),
}));

import { signToken, verifyToken } from '../lib/auth';
import { ImportRefusedError } from '../lib/db';

const INDEX_HTML = '<!doctype html><html><head><title>shell</title></head><body>STATIC-SHELL</body></html>';
const EXPECTED_BUILD_ID = createHash('sha256').update(INDEX_HTML).digest('hex').slice(0, 12);
const ADMIN = { id: 1, discordId: 'd1', isSystemAdmin: true, tokensValidFrom: null };
const MEMBER = { id: 2, discordId: 'd2', isSystemAdmin: false, tokensValidFrom: null };
const FUTURE = '2999-01-01T00:00:00.000Z';
const NO_STORE = 'private, no-store, no-cache, must-revalidate';

let server: http.Server;
let port = 0;
let tmpRoot = '';
let setIndexPath: (p: string | null) => void = () => {};
const bulk = new http.Agent({ keepAlive: true, maxSockets: 32 });

beforeAll(async () => {
    tmpRoot = mkdtempSync(join(os.tmpdir(), 'cov-server-'));
    h.distDir = join(tmpRoot, 'dist');
    mkdirSync(join(h.distDir, 'assets'), { recursive: true });
    mkdirSync(join(h.distDir, 'media'), { recursive: true });
    writeFileSync(join(h.distDir, 'index.html'), INDEX_HTML);
    writeFileSync(join(h.distDir, 'assets', 'app-3f9a1c.js'), 'console.log("chunk")');
    writeFileSync(join(h.distDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(h.distDir, 'media', 'logo.png'), 'PNG-BYTES');
    writeFileSync(join(h.distDir, '.secret.json'), '{"canary":"DOTFILE-CANARY"}');
    writeFileSync(join(tmpRoot, 'outside.txt'), 'OUTSIDE-CANARY');
    const mod = await import('../server.ts');
    const buildId = await import('../lib/buildId');
    setIndexPath = buildId.__setIndexPathForTest;
    setIndexPath(join(h.distDir, 'index.html'));
    server = mod.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
    setIndexPath(null);
    bulk.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    vi.unstubAllEnvs();
    rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
    h.logs = [];
    h.calls = [];
    h.handlers = {};
    h.users = new Map<number, UserRow>([[1, ADMIN], [2, MEMBER]]);
    h.userQueue = [];
    h.settingsQueue = [];
    h.banQueue = [];
    h.verifyQueue = [];
    h.importImpl = null;
    h.importArgs = [];
    h.peers = new Map();
    for (const fn of Object.values(h.fed)) fn.mockReset();
});

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

interface Reply { status: number; headers: http.IncomingHttpHeaders; raw: Buffer; text: string; json: any }

function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: string | Buffer; agent?: http.Agent } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { ...opts.headers };
        if (opts.body !== undefined && headers['content-length'] === undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
        const req = http.request({ host: '127.0.0.1', port, path, method, agent: opts.agent ?? false, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                const text = raw.toString('utf8');
                let json: unknown;
                try { json = JSON.parse(text); } catch { json = undefined; }
                resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, text, json });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(opts.body);
    });
}

/** Resolve as soon as the status line arrives, then drop the connection. For a handler that
 *  starts a response and never finishes it. */
function statusOnly(method: string, path: string, headers: Record<string, string>, body = ''): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method, agent: false, headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
            resolve(res.statusCode ?? 0);
            req.destroy();
        });
        req.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'ECONNRESET') reject(e); });
        req.end(body);
    });
}

/** A hand-written request over a bare socket, for request shapes the http client will not emit
 *  (no Host header at all; a POST with neither Content-Length nor Transfer-Encoding). The request
 *  must ask for the connection to close (HTTP/1.0, or `Connection: close`): the server's close
 *  ends the read. The socket is written, never half-closed — Node aborts a request whose client
 *  half-closes before the (async) response is written. */
function rawRequest(head: string[], body = ''): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1');
        let data = '';
        sock.setEncoding('utf8');
        sock.on('data', (c: string) => { data += c; });
        sock.on('end', () => {
            const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0);
            resolve({ status, body: data.slice(data.indexOf('\r\n\r\n') + 4) });
        });
        sock.on('error', reject);
        sock.write(`${head.join('\r\n')}\r\n\r\n${body}`);
    });
}

let ipSeq = 0;
function freshIp(): string {
    ipSeq += 1;
    return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${(ipSeq & 255) || 1}`;
}
const fromIp = (ip: string) => ({ 'cf-connecting-ip': ip });
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const JSON_CT = { 'content-type': 'application/json' };
const bearer = (userId: number) => ({ authorization: `Bearer ${signToken({ userId })}` });
const callsOf = (name: HandlerName) => h.calls.filter((c) => c.name === name);
const logsOf = (msg: string) => h.logs.filter((l) => l.msg === msg);
const ndjsonLines = (t: string) => t.split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function repeat(n: number, fn: (i: number) => Promise<Reply>): Promise<Reply[]> {
    const out: Reply[] = [];
    for (let i = 0; i < n; i++) out.push(await fn(i));
    return out;
}

// ---------------------------------------------------------------------------------------------
// /sw.js render cache. FIRST in the file on purpose: the TTL cache is module state, so this must
// see the very first render of the process (a later successful render stays cached for 10s).
// ---------------------------------------------------------------------------------------------

describe('/sw.js render cache', () => {
    it('/sw.js: a failed render is a 500 that is not cached; the next render is replayed within the TTL with no-store forced', async () => {
        h.handlers.sw = () => { throw new Error('branding read failed'); };
        const failed = await call('GET', '/sw.js', { headers: fromIp(freshIp()) });
        expect(failed.status).toBe(500);
        expect(failed.text).toBe('SW Error');
        expect(logsOf('sw error')).toHaveLength(1);

        delete h.handlers.sw;
        const first = await call('GET', '/sw.js', { headers: fromIp(freshIp()) });
        expect(first.status).toBe(200);
        expect(first.text).toBe('/* sw v1 */');
        expect(first.headers['content-type']).toBe('application/javascript; charset=utf-8');
        // The renderer asked for a day of caching; the route overrides it.
        expect(first.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
        const rendersAfterFirst = callsOf('sw').length;
        expect(rendersAfterFirst).toBe(2);

        const second = await call('GET', '/sw.js', { headers: fromIp(freshIp()) });
        expect(second.text).toBe('/* sw v1 */');
        expect(second.headers['content-type']).toBe('application/javascript; charset=utf-8');
        expect(callsOf('sw')).toHaveLength(rendersAfterFirst);
    });
});

// ---------------------------------------------------------------------------------------------
// Security headers + CSP nonce + compression
// ---------------------------------------------------------------------------------------------

describe('security headers', () => {
    const nonceOf = (csp: string | undefined) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp ?? '')?.[1] ?? '';

    it('sets every hardening header, a fresh 16-byte CSP nonce per response, and no framework fingerprint', async () => {
        const a = await call('GET', '/healthz', { headers: fromIp(freshIp()) });
        const b = await call('GET', '/healthz', { headers: fromIp(freshIp()) });
        expect(a.headers['x-content-type-options']).toBe('nosniff');
        expect(a.headers['x-frame-options']).toBe('DENY');
        expect(a.headers['x-xss-protection']).toBe('0');
        expect(a.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
        expect(a.headers['cross-origin-opener-policy']).toBe('same-origin');
        expect(a.headers['permissions-policy']).toBe('camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');
        expect(a.headers['x-powered-by']).toBeUndefined();

        const csp = String(a.headers['content-security-policy']);
        const na = nonceOf(csp);
        expect(Buffer.from(na, 'base64')).toHaveLength(16);
        expect(na).not.toBe(nonceOf(String(b.headers['content-security-policy'])));
        expect(csp).toContain(`script-src 'self' 'nonce-${na}' https://static.cloudflareinsights.com;`);
        expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
        for (const d of ["default-src 'self'", "base-uri 'self'", "form-action 'self'", "object-src 'none'", "frame-ancestors 'none'", "manifest-src 'self'"]) {
            expect(csp).toContain(d);
        }
        // connect-src is the explicit allow-list (the configured Supabase origin pinned), never a bare https:.
        const connect = /connect-src ([^;]*);/.exec(csp)?.[1] ?? '';
        expect(connect).toContain(`https://${new URL(String(process.env.SUPABASE_URL)).host}`);
        expect(connect.split(' ')).not.toContain('https:');
        // Not production: no HSTS.
        expect(a.headers['strict-transport-security']).toBeUndefined();
    });

    it('hands the SSR renderer the same nonce the CSP header advertises', async () => {
        const r = await call('GET', '/operations/board', { headers: fromIp(freshIp()) });
        expect(r.status).toBe(200);
        expect(callsOf('ssr')).toHaveLength(1);
        expect(callsOf('ssr')[0].nonce).toBe(nonceOf(String(r.headers['content-security-policy'])));
    });

    it('adds HSTS in production, and the production request log carries the path but never the query string', async () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const ip = freshIp();
        let r: Reply;
        try {
            r = await call('GET', '/api/query?target=state&code=OAUTH-CODE-CANARY', { headers: { ...fromIp(ip), 'x-forwarded-host': 'alpha.example.org:8443' } });
            await vi.waitFor(() => expect(logsOf('request')).toHaveLength(1));
        } finally {
            process.env.NODE_ENV = prev;
        }
        expect(r.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
        const fields = logsOf('request')[0].fields ?? {};
        expect(fields).toMatchObject({ method: 'GET', status: 200, path: '/api/query', ip, org: 'alpha' });
        expect(typeof fields.durationMs).toBe('number');
        expect(fields).not.toHaveProperty('url');
        expect(JSON.stringify(fields)).not.toContain('OAUTH-CODE-CANARY');
    });

    it('outside production the request log carries the full URL for debugging', async () => {
        const ip = freshIp();
        await call('GET', '/api/query?target=state&x=1', { headers: fromIp(ip) });
        await vi.waitFor(() => expect(logsOf('request')).toHaveLength(1));
        expect(logsOf('request')[0].fields).toMatchObject({ method: 'GET', status: 200, hostname: '127.0.0.1', url: '/api/query?target=state&x=1', ip });
    });

    it('a host with no name part logs the org as "-" rather than an empty field', async () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const r = await call('GET', '/api/query?target=state', { headers: { ...fromIp(freshIp()), 'x-forwarded-host': ':8443' } });
            expect(r.status).toBe(200);
            await vi.waitFor(() => expect(logsOf('request')).toHaveLength(1));
        } finally {
            process.env.NODE_ENV = prev;
        }
        expect(logsOf('request')[0].fields).toMatchObject({ org: '-' });
    });

    it('compresses a large response for a client that accepts gzip, and not for one that does not', async () => {
        const payload = { blob: 'operations-'.repeat(800) };
        h.handlers.query = (_req, res) => { res.json(payload); };
        const gz = await call('GET', '/api/query?target=state', { headers: { ...fromIp(freshIp()), 'accept-encoding': 'gzip' } });
        expect(gz.headers['content-encoding']).toBe('gzip');
        expect(JSON.parse(gunzipSync(gz.raw).toString('utf8'))).toEqual(payload);
        const plain = await call('GET', '/api/query?target=state', { headers: fromIp(freshIp()) });
        expect(plain.headers['content-encoding']).toBeUndefined();
        expect(plain.json).toEqual(payload);
    });
});

// ---------------------------------------------------------------------------------------------
// /healthz
// ---------------------------------------------------------------------------------------------

describe('/healthz liveness probe', () => {
    it('answers a fixed literal, never cached, stamped with the build id, and is not request-logged', async () => {
        const r = await call('GET', '/healthz', { headers: fromIp(freshIp()) });
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ status: 'ok' });
        expect(r.headers['cache-control']).toBe(NO_STORE);
        expect(r.headers['cdn-cache-control']).toBe('no-store');
        expect(r.headers['x-build-id']).toBe(EXPECTED_BUILD_ID);
        // A control request through the logger proves the logger is live; the probe never reaches it.
        await call('GET', '/api/query?target=state', { headers: fromIp(freshIp()) });
        await vi.waitFor(() => expect(logsOf('request')).toHaveLength(1));
        expect(logsOf('request').some((l) => String(l.fields?.url ?? l.fields?.path).startsWith('/healthz'))).toBe(false);
    });

    it('omits X-Build-Id when no build id can be determined (fail-safe: no header, no reload nag)', async () => {
        setIndexPath(join(tmpRoot, 'no-such-index.html'));
        try {
            const r = await call('GET', '/healthz', { headers: fromIp(freshIp()) });
            expect(r.status).toBe(200);
            expect(r.headers['x-build-id']).toBeUndefined();
            // The browser API routes stamp the same way: no id, no header.
            const q = await call('GET', '/api/query?target=state', { headers: fromIp(freshIp()) });
            expect(q.status).toBe(200);
            expect(q.headers['x-build-id']).toBeUndefined();
        } finally {
            setIndexPath(join(h.distDir, 'index.html'));
        }
    });
});

// ---------------------------------------------------------------------------------------------
// Scanner blackholing + per-IP abuse blocking
// ---------------------------------------------------------------------------------------------

describe('scanner paths and the per-IP abuse blackhole', () => {
    it('404s a scanner probe before any handler, no-store, and logs it once per IP per minute', async () => {
        const ip = freshIp();
        const a = await call('GET', '/wp-login.php', { headers: fromIp(ip) });
        const b = await call('POST', '/xmlrpc.php', { headers: fromIp(ip) });
        expect(a.status).toBe(404);
        expect(a.text).toBe('Not Found');
        expect(a.headers['cache-control']).toBe('no-store');
        expect(b.status).toBe(404);
        expect(logsOf('scanner probe')).toEqual([{ level: 'info', msg: 'scanner probe', fields: { ip, method: 'GET', path: '/wp-login.php' } }]);
        expect(h.calls).toHaveLength(0);
    });

    it('matches the scanner list case-insensitively across its families', async () => {
        for (const p of ['/WP-ADMIN/setup', '/.git/config', '/.env', '/phpMyAdmin/index', '/2023/wp-includes/x', '/cgi-bin/run', '/server-status', '/blog/wp-json']) {
            const r = await call('GET', p, { headers: fromIp(freshIp()) });
            expect(r.status, p).toBe(404);
            expect(r.text, p).toBe('Not Found');
        }
        expect(logsOf('scanner probe')).toHaveLength(8);
        expect(h.calls).toHaveLength(0);
    });

    it('blackholes an IP after 20 bad requests: every later request 404s and no handler runs, while a neighbour is unaffected', async () => {
        const ip = freshIp();
        await repeat(19, () => call('GET', '/.aws/credentials', { headers: fromIp(ip), agent: bulk }));
        expect(logsOf('ip blackholed')).toHaveLength(0);
        await call('GET', '/.aws/credentials', { headers: fromIp(ip) });
        expect(logsOf('ip blackholed')).toEqual([{ level: 'info', msg: 'ip blackholed', fields: { ip, blockSeconds: 300, badRequests: 20, windowSeconds: 60 } }]);

        const blockedProbe = await call('GET', '/healthz', { headers: fromIp(ip) });
        expect(blockedProbe.status).toBe(404);
        expect(blockedProbe.headers['cache-control']).toBe('no-store');
        expect((await call('GET', '/api/query?target=state', { headers: fromIp(ip) })).status).toBe(404);
        expect(callsOf('query')).toHaveLength(0);

        expect((await call('GET', '/healthz', { headers: fromIp(freshIp()) })).status).toBe(200);
    });

    it('never blackholes a loopback caller (a same-host reverse proxy would 404 the whole site)', async () => {
        for (const ip of ['127.0.0.9', '::1']) {
            await repeat(25, () => call('GET', '/wp-admin', { headers: fromIp(ip), agent: bulk }));
            expect((await call('GET', '/healthz', { headers: fromIp(ip) })).status).toBe(200);
        }
        expect(logsOf('ip blackholed')).toHaveLength(0);
    });

    it('counts an ordinary 404 on a probe-shaped path toward the block', async () => {
        const ip = freshIp();
        const rs = await repeat(20, () => call('GET', '/config.php', { headers: fromIp(ip), agent: bulk }));
        expect(rs.every((r) => r.status === 404)).toBe(true);
        await vi.waitFor(() => expect(logsOf('ip blackholed')).toHaveLength(1));
        expect((await call('GET', '/healthz', { headers: fromIp(ip) })).status).toBe(404);
    });

    it('counts non-GET 404s under /api toward the block', async () => {
        const ip = freshIp();
        const rs = await repeat(20, () => call('POST', '/api/no-such-route', { headers: fromIp(ip), agent: bulk }));
        expect(rs[0].status).toBe(404);
        expect(rs[0].json).toEqual({ message: 'Not found' });
        await vi.waitFor(() => expect(logsOf('ip blackholed')).toHaveLength(1));
        expect((await call('GET', '/healthz', { headers: fromIp(ip) })).status).toBe(404);
    });

    it('does NOT count stale-chunk and favicon 404s (an office behind one IP must not lock itself out)', async () => {
        const ip = freshIp();
        await repeat(15, (i) => call('GET', `/assets/stale-chunk-${i}.js`, { headers: fromIp(ip), agent: bulk }));
        await repeat(10, () => call('GET', '/favicon.ico', { headers: fromIp(ip), agent: bulk }));
        expect((await call('GET', '/healthz', { headers: fromIp(ip) })).status).toBe(200);
        expect(logsOf('ip blackholed')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------------------------
// CSRF origin gate
// ---------------------------------------------------------------------------------------------

describe('csrfOriginGate', () => {
    const ok = (extra: Record<string, string>) => ({ ...fromIp(freshIp()), ...JSON_CT, ...extra });
    const body = JSON.stringify({ action: 'operation:create', payload: {} });

    it('refuses a cross-site POST with a fixed 403, no-store, a deduped warning — and never reaches the handler', async () => {
        const r = await call('POST', '/api/services', { headers: ok({ 'sec-fetch-site': 'cross-site' }), body });
        expect(r.status).toBe(403);
        expect(r.json).toEqual({ message: 'Forbidden: cross-site request blocked' });
        expect(r.headers['cache-control']).toBe('no-store');
        expect(callsOf('services')).toHaveLength(0);
        expect(logsOf('cross-site request blocked')).toEqual([{ level: 'warn', msg: 'cross-site request blocked', fields: { path: '/api/services', method: 'POST', secFetchSite: 'cross-site' } }]);
    });

    it('refuses before the body parser runs (a compressed body gets the 403, not the parser 415)', async () => {
        const r = await call('POST', '/api/services', { headers: ok({ 'sec-fetch-site': 'cross-site', 'content-encoding': 'gzip' }), body: gzipSync(body) });
        expect(r.status).toBe(403);
    });

    it('cannot be bypassed with a trailing slash or a case change on the path', async () => {
        for (const p of ['/api/services/', '/API/services', '/api/Services']) {
            const r = await call('POST', p, { headers: ok({ 'sec-fetch-site': 'cross-site' }), body });
            expect(r.status, p).toBe(403);
        }
        expect(callsOf('services')).toHaveLength(0);
    });

    it('guards all four browser paths', async () => {
        for (const p of ['/api/services', '/api/query?target=state', '/api/admin/import-stream', '/api/org/upload']) {
            const r = await call('POST', p, { headers: ok({ 'sec-fetch-site': 'same-site' }), body });
            expect(r.status, p).toBe(403);
            expect(r.json, p).toEqual({ message: 'Forbidden: cross-site request blocked' });
        }
        expect(h.calls).toHaveLength(0);
    });

    it('refuses a state-changing request carrying neither Origin nor Sec-Fetch-Site, logging secFetchSite null', async () => {
        const r = await call('POST', '/api/services', { headers: ok({}), body });
        expect(r.status).toBe(403);
        expect(logsOf('cross-site request blocked')[0].fields).toMatchObject({ secFetchSite: null });
    });

    it('decides on Origin when Sec-Fetch-Site is absent: own host allowed, a foreign or "null" origin refused', async () => {
        expect((await call('POST', '/api/services', { headers: ok({ origin: `http://127.0.0.1:${port}` }), body })).status).toBe(200);
        expect((await call('POST', '/api/services', { headers: ok({ origin: 'https://evil.example' }), body })).status).toBe(403);
        expect((await call('POST', '/api/services', { headers: ok({ origin: 'null' }), body })).status).toBe(403);
        expect(callsOf('services')).toHaveLength(1);
    });

    it('derives our own origin from X-Forwarded-Host (a proxy that rewrites Host keeps working)', async () => {
        expect((await call('POST', '/api/services', { headers: ok({ origin: 'https://org.proxy.example', 'x-forwarded-host': 'org.proxy.example', 'x-forwarded-proto': 'https' }), body })).status).toBe(200);
        expect((await call('POST', '/api/services', { headers: ok({ origin: 'https://org.proxy.example' }), body })).status).toBe(403);
    });

    it('accepts the configured APP_URL origin, read per request', async () => {
        expect((await call('POST', '/api/services', { headers: ok({ origin: 'https://configured.example' }), body })).status).toBe(403);
        vi.stubEnv('APP_URL', 'https://configured.example');
        try {
            expect((await call('POST', '/api/services', { headers: ok({ origin: 'https://configured.example' }), body })).status).toBe(200);
        } finally {
            vi.stubEnv('APP_URL', undefined);
        }
    });

    it('exempts ONLY the three unauthenticated GET targets — and only as a GET with a single string target', async () => {
        const cross = (ip = freshIp()) => ({ ...fromIp(ip), 'sec-fetch-site': 'cross-site' });
        for (const t of ['config', 'manifest', 'feed']) {
            expect((await call('GET', `/api/query?target=${t}`, { headers: cross() })).status, t).toBe(200);
        }
        expect((await call('GET', '/api/query?target=state&subset=hr', { headers: cross() })).status).toBe(403);
        expect((await call('POST', '/api/query?target=config', { headers: cross() })).status).toBe(403);
        // An array-valued target is not a string, so it cannot ride the exemption.
        expect((await call('GET', '/api/query?target=config&target=state', { headers: cross() })).status).toBe(403);
        expect(callsOf('query').map((c) => c.query.target)).toEqual(['config', 'manifest', 'feed']);
    });

    it('with no Host header at all nothing counts as our origin: a POST claiming one is refused, a plain read is served', async () => {
        const refused = await rawRequest(['POST /api/services HTTP/1.0', `CF-Connecting-IP: ${freshIp()}`, 'Origin: http://127.0.0.1', 'Content-Type: application/json', 'Content-Length: 2'], '{}');
        expect(refused.status).toBe(403);
        expect(JSON.parse(refused.body)).toEqual({ message: 'Forbidden: cross-site request blocked' });
        expect(callsOf('services')).toHaveLength(0);

        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const read = await rawRequest(['GET /api/query?target=state HTTP/1.0', `CF-Connecting-IP: ${freshIp()}`]);
            expect(read.status).toBe(200);
            await vi.waitFor(() => expect(logsOf('request').some((l) => l.fields?.path === '/api/query')).toBe(true));
        } finally {
            process.env.NODE_ENV = prev;
        }
        // No host to derive an org from: logged as '-'.
        expect(logsOf('request').find((l) => l.fields?.path === '/api/query')?.fields).toMatchObject({ org: '-', status: 200 });
    });

    it('is NOT mounted on the server-to-server federation routes (a peer has no Origin to send)', async () => {
        h.peers.set('k', { id: 'peer-1', name: 'Ally' });
        h.fed.receiveMirrorPush.mockResolvedValue(undefined);
        const r = await call('POST', '/api/alliance/op-mirror/push', { headers: { ...ok({ 'sec-fetch-site': 'cross-site' }), 'x-api-key': 'k' }, body: '{"op_id":"o"}' });
        expect(r.status).toBe(200);
        expect(h.fed.receiveMirrorPush).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------------------------
// Body parsers: split cap, inflate:false, type handling
// ---------------------------------------------------------------------------------------------

describe('body parsers', () => {
    const big = JSON.stringify({ action: 'operation:create', pad: 'a'.repeat(140_000) });
    const post = (headers: Record<string, string>, payload: string | Buffer) =>
        call('POST', '/api/services', { headers: { ...fromIp(freshIp()), ...SAME_ORIGIN, ...headers }, body: payload });

    it('caps an anonymous caller at 128kb: 413 with the fixed message, handler never runs', async () => {
        const r = await post(JSON_CT, big);
        expect(r.status).toBe(413);
        expect(r.json).toEqual({ message: 'That upload is too large.' });
        expect(callsOf('services')).toHaveLength(0);
        expect(logsOf('request body over cap')).toHaveLength(1);
    });

    it('a forged bearer token buys only the anonymous cap', async () => {
        const forged = signToken({ userId: 1 }).replace(/.$/, (c) => (c === '0' ? '1' : '0'));
        expect((await post({ ...JSON_CT, authorization: `Bearer ${forged}` }, big)).status).toBe(413);
    });

    it('a valid session (header or cookie) gets the 10mb cap and the body is parsed for the handler', async () => {
        expect((await post({ ...JSON_CT, ...bearer(2) }, big)).status).toBe(200);
        expect((await post({ ...JSON_CT, cookie: `myrsi_session=${signToken({ userId: 2 })}` }, big)).status).toBe(200);
        const seen = callsOf('services').map((c) => (c.body as { pad: string }).pad.length);
        expect(seen).toEqual([140_000, 140_000]);
    });

    it('still caps an authenticated caller at 10mb', async () => {
        const r = await post({ ...JSON_CT, ...bearer(2) }, JSON.stringify({ pad: 'c'.repeat(11 * 1024 * 1024) }));
        expect(r.status).toBe(413);
        expect(r.json).toEqual({ message: 'That upload is too large.' });
        expect(callsOf('services')).toHaveLength(0);
    });

    it('refuses a compressed body on BOTH parsers with 415 (inflate:false)', async () => {
        const json = await post({ ...JSON_CT, 'content-encoding': 'gzip' }, gzipSync('{"action":"x"}'));
        expect(json.status).toBe(415);
        expect(json.json).toEqual({ message: 'Unsupported request body encoding.' });
        const form = await post({ 'content-type': 'application/x-www-form-urlencoded', 'content-encoding': 'gzip' }, gzipSync('action=x'));
        expect(form.status).toBe(415);
        expect(callsOf('services')).toHaveLength(0);
    });

    it('answers malformed JSON with an opaque 400 from the terminal handler, not an HTML error page', async () => {
        const r = await post(JSON_CT, '{"action": ');
        expect(r.status).toBe(400);
        expect(r.json).toEqual({ message: 'Malformed request body.' });
        expect(String(r.headers['content-type'])).toContain('application/json');
    });

    it('parses extended urlencoded bodies, under the same anonymous cap', async () => {
        expect((await post({ 'content-type': 'application/x-www-form-urlencoded' }, 'action=auth%3Abegin&payload[a]=1')).status).toBe(200);
        expect(callsOf('services')[0].body).toEqual({ action: 'auth:begin', payload: { a: '1' } });
        expect((await post({ 'content-type': 'application/x-www-form-urlencoded' }, `pad=${'b'.repeat(140_000)}`)).status).toBe(413);
    });

    it('never parses a GET or HEAD body (no credential work, no 400 on junk)', async () => {
        const r = await call('GET', '/api/query?target=state', { headers: { ...fromIp(freshIp()), ...JSON_CT }, body: '{not json' });
        expect(r.status).toBe(200);
        expect(callsOf('query')[0].body).toBeUndefined();
        const head = await call('HEAD', '/api/query?target=state', { headers: { ...fromIp(freshIp()), ...JSON_CT }, body: '{not json' });
        expect(head.status).toBe(200);
    });

    it('parses federation POSTs with the generous cap even though they carry no session', async () => {
        h.peers.set('peer-key', { id: 'peer-1', name: 'Ally' });
        h.fed.receiveMirrorPush.mockResolvedValue(undefined);
        const r = await call('POST', '/api/alliance/op-mirror/push', { headers: { ...fromIp(freshIp()), ...JSON_CT, 'x-api-key': 'peer-key' }, body: big });
        expect(r.status).toBe(200);
        expect((h.fed.receiveMirrorPush.mock.calls[0][1] as { pad: string }).pad).toHaveLength(140_000);
    });

    it('leaves the import-stream body unparsed for its own text parser (a JSON content-type is not eaten)', async () => {
        const ndjson = '{"type":"meta","version":1}\n{"type":"row","table":"users"}\n';
        const r = await call('POST', '/api/admin/import-stream', { headers: { ...fromIp(freshIp()), ...SAME_ORIGIN, ...JSON_CT, ...bearer(1) }, body: ndjson });
        expect(r.status).toBe(200);
        expect(h.importArgs[0].ndjson).toBe(ndjson);
    });
});

// ---------------------------------------------------------------------------------------------
// Rate limiters — limit and keying for every one of them
// ---------------------------------------------------------------------------------------------

describe('rate limiters', () => {
    it('apiLimiter: 100/min per IP on /api, standard headers, a different IP has its own bucket', async () => {
        const ip = freshIp();
        const first = await call('GET', '/api/query?target=state', { headers: fromIp(ip), agent: bulk });
        expect(first.headers['ratelimit-limit']).toBe('100');
        const rest = await repeat(99, () => call('GET', '/api/query?target=state', { headers: fromIp(ip), agent: bulk }));
        expect(rest.every((r) => r.status === 200)).toBe(true);
        const limited = await call('GET', '/api/query?target=state', { headers: fromIp(ip) });
        expect(limited.status).toBe(429);
        expect(limited.headers['ratelimit-remaining']).toBe('0');
        expect(callsOf('query')).toHaveLength(100);
        expect((await call('GET', '/api/query?target=state', { headers: fromIp(freshIp()) })).status).toBe(200);
    });

    it('publicLimiter: 30/min keyed by IP + slug', async () => {
        const ip = freshIp();
        const rs = await repeat(30, () => call('GET', '/api/public?slug=alpha', { headers: fromIp(ip), agent: bulk }));
        expect(rs.every((r) => r.status === 200)).toBe(true);
        expect((await call('GET', '/api/public?slug=alpha', { headers: fromIp(ip) })).status).toBe(429);
        expect((await call('GET', '/api/public?slug=beta', { headers: fromIp(ip) })).status).toBe(200);
        expect((await call('GET', '/api/public?slug=alpha', { headers: fromIp(freshIp()) })).status).toBe(200);
        // No slug at all is its own (empty-slug) bucket for this IP.
        expect((await call('GET', '/api/public', { headers: fromIp(ip) })).status).toBe(200);
        expect(callsOf('public').map((c) => c.query.slug)).toEqual([...Array(30).fill('alpha'), 'beta', 'alpha', undefined]);
    });

    it('authActionLimiter: 10/min per IP, only for auth:* actions, with its JSON message', async () => {
        const ip = freshIp();
        const auth = () => call('POST', '/api/services', { headers: { ...fromIp(ip), ...SAME_ORIGIN, ...JSON_CT }, body: '{"action":"auth:discord_callback"}', agent: bulk });
        const rs = await repeat(10, auth);
        expect(rs.every((r) => r.status === 200)).toBe(true);
        const limited = await auth();
        expect(limited.status).toBe(429);
        expect(limited.json).toEqual({ message: 'Too many authentication attempts. Please wait a minute and try again.' });
        // Non-auth actions and non-string actions from the same IP are untouched by this limiter.
        const other = await call('POST', '/api/services', { headers: { ...fromIp(ip), ...SAME_ORIGIN, ...JSON_CT }, body: '{"action":"operation:create"}' });
        expect(other.status).toBe(200);
        const odd = await call('POST', '/api/services', { headers: { ...fromIp(ip), ...SAME_ORIGIN, ...JSON_CT }, body: '{"action":["auth:x"]}' });
        expect(odd.status).toBe(200);
    });

    it('authActionLimiter keys IPv6 by subnet: rotating the interface bits does not buy a fresh bucket', async () => {
        const send = (ip: string) => call('POST', '/api/services', { headers: { ...fromIp(ip), ...SAME_ORIGIN, ...JSON_CT }, body: '{"action":"auth:begin_oauth"}', agent: bulk });
        const rs = await repeat(10, (i) => send(`2001:db8:abcd:12::${(i + 1).toString(16)}`));
        expect(rs.every((r) => r.status === 200)).toBe(true);
        expect((await send('2001:db8:abcd:12:ffff:ffff:ffff:fffe')).status).toBe(429);
        // A different /56 is a different subscriber.
        expect((await send('2001:db8:abcd:1200::1')).status).toBe(200);
    });

    it('feedLimiter: 30/min keyed on the presented API key (not the IP), IP fallback without a key, target=feed only', async () => {
        const ipA = freshIp();
        const feed = (ip: string, key?: string) => call('GET', '/api/query?target=feed', { headers: { ...fromIp(ip), ...(key ? { 'x-api-key': key } : {}) }, agent: bulk });
        const rs = await repeat(30, () => feed(ipA, 'feed-key-one'));
        expect(rs.every((r) => r.status === 200)).toBe(true);
        expect((await feed(ipA, 'feed-key-one')).status).toBe(429);
        // The same stolen key replayed from another address hits the SAME bucket.
        expect((await feed(freshIp(), 'feed-key-one')).status).toBe(429);
        // Another key from the same address (peers behind one NAT) is unaffected.
        expect((await feed(ipA, 'feed-key-two')).status).toBe(200);
        // Other targets keep the ordinary /api cap only.
        expect((await call('GET', '/api/query?target=state', { headers: fromIp(ipA) })).status).toBe(200);
        // No key: capped per IP.
        const ipC = freshIp();
        const anon = await repeat(30, () => feed(ipC));
        expect(anon.every((r) => r.status === 200)).toBe(true);
        expect((await feed(ipC)).status).toBe(429);
        expect((await feed(freshIp())).status).toBe(200);
    });

    it('orgUploadLimiter: 40/min per IP, ahead of the pre-auth, with its JSON message', async () => {
        const ip = freshIp();
        const up = () => call('POST', '/api/org/upload?for=branding', { headers: { ...fromIp(ip), ...SAME_ORIGIN, 'content-type': 'image/png' }, body: 'x', agent: bulk });
        const rs = await repeat(40, up);
        expect(rs.every((r) => r.status === 401)).toBe(true);
        const limited = await up();
        expect(limited.status).toBe(429);
        expect(limited.json).toEqual({ message: 'Too many uploads. Please slow down and try again shortly.' });
    });

    it('allianceLimiter: 20/min per IP whatever key is presented', async () => {
        const ip = freshIp();
        const rs = await repeat(20, (i) => call('GET', '/api/alliance/profile', { headers: { ...fromIp(ip), 'x-api-key': `k${i}` }, agent: bulk }));
        expect(rs.every((r) => r.status === 403)).toBe(true);
        expect((await call('GET', '/api/alliance/profile', { headers: { ...fromIp(ip), 'x-api-key': 'yet-another' } })).status).toBe(429);
        expect((await call('GET', '/api/alliance/profile', { headers: fromIp(freshIp()) })).status).toBe(403);
    });

    it('swLimiter: 60/min per IP on /sw.js (outside /api, so the global cap does not cover it)', async () => {
        const ip = freshIp();
        const rs = await repeat(60, () => call('GET', '/sw.js', { headers: fromIp(ip), agent: bulk }));
        expect(rs.every((r) => r.status === 200)).toBe(true);
        expect(rs[0].headers['ratelimit-limit']).toBe('60');
        expect((await call('GET', '/sw.js', { headers: fromIp(ip) })).status).toBe(429);
        expect((await call('GET', '/sw.js', { headers: fromIp(freshIp()) })).status).toBe(200);
    });
});

// ---------------------------------------------------------------------------------------------
// Browser API routes: /api/services, /api/query, /api/public, /api/manifest, /sw.js
// ---------------------------------------------------------------------------------------------

describe('browser API route wiring', () => {
    it('/api/services: never cached, stamped with the build id, handler sees the parsed body', async () => {
        const r = await call('POST', '/api/services', { headers: { ...fromIp(freshIp()), ...SAME_ORIGIN, ...JSON_CT }, body: '{"action":"wiki:list","payload":{"q":1}}' });
        expect(r.status).toBe(200);
        expect(r.headers['cache-control']).toBe(NO_STORE);
        expect(r.headers['cdn-cache-control']).toBe('no-store');
        expect(String(r.headers.vary).split(', ')).toEqual(expect.arrayContaining(['Authorization', 'Cookie']));
        expect(r.headers['x-build-id']).toBe(EXPECTED_BUILD_ID);
        expect(callsOf('services')[0].body).toEqual({ action: 'wiki:list', payload: { q: 1 } });
    });

    it('/api/services: a thrown handler error becomes an opaque 500 and is logged', async () => {
        h.handlers.services = () => { throw new Error('relation "users" column secret_col does not exist'); };
        const r = await call('POST', '/api/services', { headers: { ...fromIp(freshIp()), ...SAME_ORIGIN, ...JSON_CT }, body: '{"action":"x"}' });
        expect(r.status).toBe(500);
        expect(r.json).toEqual({ error: 'Internal Server Error' });
        expect(r.text).not.toContain('secret_col');
        expect(logsOf('api service error')).toHaveLength(1);
    });

    it('/api/services: a failure after the response started does not attempt a second response', async () => {
        h.handlers.services = (_req, res) => { res.status(202); res.flushHeaders(); throw new Error('late'); };
        expect(await statusOnly('POST', '/api/services', { ...fromIp(freshIp()), ...SAME_ORIGIN, ...JSON_CT }, '{"action":"x"}')).toBe(202);
        await vi.waitFor(() => expect(logsOf('api service error')).toHaveLength(1));
        expect(logsOf('unhandled request error')).toHaveLength(0);
    });

    it('/api/query: never cached, stamped with the build id', async () => {
        const r = await call('GET', '/api/query?target=state&subset=main', { headers: fromIp(freshIp()) });
        expect(r.status).toBe(200);
        expect(r.headers['cache-control']).toBe(NO_STORE);
        expect(String(r.headers.vary).split(', ')).toEqual(expect.arrayContaining(['Authorization', 'Cookie']));
        expect(r.headers['x-build-id']).toBe(EXPECTED_BUILD_ID);
        expect(callsOf('query')[0].query).toEqual({ target: 'state', subset: 'main' });
    });

    it('/api/query: a thrown handler error becomes an opaque 500 and is logged', async () => {
        h.handlers.query = () => { throw new Error('PGRST116 internal detail'); };
        const r = await call('GET', '/api/query?target=state', { headers: fromIp(freshIp()) });
        expect(r.status).toBe(500);
        expect(r.json).toEqual({ error: 'Internal Server Error' });
        expect(r.text).not.toContain('PGRST116');
        expect(logsOf('api query error')).toHaveLength(1);
    });

    it('/api/query: a failure after the response started does not attempt a second response', async () => {
        h.handlers.query = (_req, res) => { res.status(206); res.flushHeaders(); throw new Error('late'); };
        expect(await statusOnly('GET', '/api/query?target=state', fromIp(freshIp()))).toBe(206);
        await vi.waitFor(() => expect(logsOf('api query error')).toHaveLength(1));
    });

    it('/api/public: a handler failure is a 404, not a 500 that would confirm the slug exists', async () => {
        h.handlers.public = () => { throw new Error('boom'); };
        const r = await call('GET', '/api/public?slug=hidden', { headers: fromIp(freshIp()) });
        expect(r.status).toBe(404);
        expect(r.json).toEqual({ error: 'not_found' });
        expect(logsOf('api public error')).toHaveLength(1);
    });

    it('/api/public: a failure after the response started does not attempt a second response', async () => {
        h.handlers.public = (_req, res) => { res.status(200); res.flushHeaders(); throw new Error('late'); };
        expect(await statusOnly('GET', '/api/public?slug=x', fromIp(freshIp()))).toBe(200);
        await vi.waitFor(() => expect(logsOf('api public error')).toHaveLength(1));
    });

    it('/api/manifest calls the manifest handler directly — a forged target never reaches the generic query handler', async () => {
        const r = await call('GET', '/api/manifest?target=state&subset=hr#', { headers: fromIp(freshIp()) });
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ name: 'Org Manifest' });
        expect(callsOf('manifest')).toHaveLength(1);
        expect(callsOf('query')).toHaveLength(0);
    });

    it('/api/manifest: a thrown error becomes a 500 with a fixed body', async () => {
        h.handlers.manifest = () => { throw new Error('settings read failed'); };
        const r = await call('GET', '/api/manifest', { headers: fromIp(freshIp()) });
        expect(r.status).toBe(500);
        expect(r.json).toEqual({ error: 'Manifest Error' });
        expect(logsOf('manifest error')).toHaveLength(1);
    });

    it('/api/manifest: a failure after the response started does not attempt a second response', async () => {
        h.handlers.manifest = (_req, res) => { res.status(200); res.flushHeaders(); throw new Error('late'); };
        expect(await statusOnly('GET', '/api/manifest', fromIp(freshIp()))).toBe(200);
        await vi.waitFor(() => expect(logsOf('manifest error')).toHaveLength(1));
        expect(logsOf('unhandled request error')).toHaveLength(0);
    });

});

// ---------------------------------------------------------------------------------------------
// /api/alliance/* — server-to-server federation
// ---------------------------------------------------------------------------------------------

describe('/api/alliance/* federation routes', () => {
    const KEY = 'peer-key-good';
    const PEER = { id: 'peer-1', name: 'Allies' };
    const fed = (extra: Record<string, string> = {}) => ({ ...fromIp(freshIp()), 'x-api-key': KEY, ...extra });
    const fedJson = (o: unknown) => ({ headers: fed(JSON_CT), body: JSON.stringify(o) });
    beforeEach(() => { h.peers.set(KEY, PEER); });

    const KEY_GATED: Array<[string, string]> = [
        ['GET', '/api/alliance/profile'], ['GET', '/api/alliance/data'], ['GET', '/api/alliance/op-manifest'],
        ['GET', '/api/alliance/op/op-1'], ['POST', '/api/alliance/op/op-1/accept'], ['POST', '/api/alliance/op/op-1/decline'],
        ['POST', '/api/alliance/op/op-1/rsvp'], ['POST', '/api/alliance/op-mirror/invite'], ['POST', '/api/alliance/op-mirror/push'],
        ['POST', '/api/alliance/op-mirror/revoke'], ['GET', '/api/alliance/roster'], ['GET', '/api/alliance/fleet'],
    ];

    it('every key-gated route refuses a missing or unknown key with 403 forbidden and calls nothing downstream', async () => {
        for (const [method, p] of KEY_GATED) {
            const none = await call(method, p, { headers: fromIp(freshIp()) });
            expect(none.status, `${method} ${p}`).toBe(403);
            expect(none.json, `${method} ${p}`).toEqual({ error: 'forbidden' });
            const wrong = await call(method, p, { headers: { ...fromIp(freshIp()), 'x-api-key': 'not-a-peer' } });
            expect(wrong.status, `${method} ${p}`).toBe(403);
        }
        for (const fn of Object.values(h.fed)) expect(fn).not.toHaveBeenCalled();
    });

    it('federation responses are never cached and never carry the deployment build id', async () => {
        h.fed.getOperationManifestForPeer.mockResolvedValue({ ops: [] });
        const r = await call('GET', '/api/alliance/op-manifest', { headers: fed() });
        expect(r.status).toBe(200);
        expect(r.headers['cache-control']).toBe(NO_STORE);
        expect(r.headers['x-build-id']).toBeUndefined();
    });

    describe('/pair', () => {
        it('forwards exactly the four handshake fields and returns the result', async () => {
            h.fed.respondToPair.mockResolvedValue({ ok: true, peerName: 'Host' });
            const r = await call('POST', '/api/alliance/pair', { headers: { ...fromIp(freshIp()), ...JSON_CT }, body: JSON.stringify({ fromBaseUrl: 'https://a.example', ephemeralPub: 'pub', nonce: 'n', codeProof: 'p', isAdmin: true }) });
            expect(r.status).toBe(200);
            expect(r.json).toEqual({ ok: true, peerName: 'Host' });
            expect(h.fed.respondToPair).toHaveBeenCalledWith({ fromBaseUrl: 'https://a.example', ephemeralPub: 'pub', nonce: 'n', codeProof: 'p' });
        });

        it('tolerates a request with no body (every field undefined, the responder decides)', async () => {
            h.fed.respondToPair.mockRejectedValue(new Error('malformed_request'));
            const r = await call('POST', '/api/alliance/pair', { headers: fromIp(freshIp()) });
            expect(r.status).toBe(403);
            expect(h.fed.respondToPair).toHaveBeenCalledWith({ fromBaseUrl: undefined, ephemeralPub: undefined, nonce: undefined, codeProof: undefined });
        });

        it.each(['no_pending_pairing', 'pairing_expired', 'handshake_verification_failed', 'invalid_from_url', 'malformed_request'])(
            'maps the handshake refusal %s to a bare 403 forbidden', async (reason) => {
                h.fed.respondToPair.mockRejectedValue(new Error(reason));
                const r = await call('POST', '/api/alliance/pair', { headers: { ...fromIp(freshIp()), ...JSON_CT }, body: '{}' });
                expect(r.status).toBe(403);
                expect(r.json).toEqual({ error: 'forbidden' });
                expect(logsOf('alliance pair rejected')).toEqual([{ level: 'warn', msg: 'alliance pair rejected', fields: { reason } }]);
            });

        it('maps any other failure (Error or not) to an opaque 500 pairing_failed', async () => {
            h.fed.respondToPair.mockRejectedValueOnce(new Error('ECDH internal state /var/lib/x'));
            const a = await call('POST', '/api/alliance/pair', { headers: { ...fromIp(freshIp()), ...JSON_CT }, body: '{}' });
            expect(a.status).toBe(500);
            expect(a.json).toEqual({ error: 'pairing_failed' });
            h.fed.respondToPair.mockRejectedValueOnce('a bare string');
            const b = await call('POST', '/api/alliance/pair', { headers: { ...fromIp(freshIp()), ...JSON_CT }, body: '{}' });
            expect(b.status).toBe(500);
            expect(b.json).toEqual({ error: 'pairing_failed' });
            expect(logsOf('alliance pair error')).toHaveLength(2);
            expect(logsOf('alliance pair rejected')).toHaveLength(0);
        });
    });

    describe('/profile', () => {
        it('returns the advertised card to an Active peer', async () => {
            h.fed.getAllianceSelfProfile.mockResolvedValue({ orgName: 'Org', directoryVisible: true, contact: 'ops@org.example' });
            const r = await call('GET', '/api/alliance/profile', { headers: fed() });
            expect(r.json).toEqual({ orgName: 'Org', directoryVisible: true, contact: 'ops@org.example' });
        });

        it('honours an opted-out directory: a minimal card, nothing else, even to an ally', async () => {
            h.fed.getAllianceSelfProfile.mockResolvedValue({ orgName: 'Org', directoryVisible: false, contact: 'LEAK-CANARY' });
            const r = await call('GET', '/api/alliance/profile', { headers: fed() });
            expect(r.json).toEqual({ orgName: '', directoryVisible: false });
            expect(r.text).not.toContain('LEAK-CANARY');
        });

        it('a failure is an opaque 500 profile_failed', async () => {
            h.fed.getAllianceSelfProfile.mockRejectedValue(new Error('db detail'));
            const r = await call('GET', '/api/alliance/profile', { headers: fed() });
            expect(r.status).toBe(500);
            expect(r.json).toEqual({ error: 'profile_failed' });
            expect(logsOf('alliance profile error')).toHaveLength(1);
        });
    });

    describe('/data', () => {
        const DATA = { reports: [{ id: 'r1' }], warrants: [], bulletins: [{ id: 'b1' }, { id: 'b2' }], _meta: { fetchedAt: '2026-01-01T00:00:00.000Z', truncated: true } };

        it('returns the peer-scoped share with counts, and fetchedAt MIRRORS _meta (never the wall clock)', async () => {
            h.fed.getAllianceShareableData.mockResolvedValue(DATA);
            const r = await call('GET', '/api/alliance/data?since=2025-12-31T00:00:00.000Z', { headers: fed() });
            expect(r.json).toEqual({ countReports: 1, countWarrants: 0, countBulletins: 2, fetchedAt: '2026-01-01T00:00:00.000Z', reports: DATA.reports, warrants: [], bulletins: DATA.bulletins, _meta: DATA._meta });
            expect(h.fed.getAllianceShareableData).toHaveBeenCalledWith(PEER, '2025-12-31T00:00:00.000Z');
        });

        it('a repeated since is not a string and is dropped', async () => {
            h.fed.getAllianceShareableData.mockResolvedValue(DATA);
            await call('GET', '/api/alliance/data?since=a&since=b', { headers: fed() });
            expect(h.fed.getAllianceShareableData).toHaveBeenCalledWith(PEER, undefined);
        });

        it('a failure is an opaque 500 data_failed', async () => {
            h.fed.getAllianceShareableData.mockRejectedValue(new Error('x'));
            const r = await call('GET', '/api/alliance/data', { headers: fed() });
            expect(r.status).toBe(500);
            expect(r.json).toEqual({ error: 'data_failed' });
            expect(logsOf('alliance data error')).toHaveLength(1);
        });
    });

    describe('joint-operation routes', () => {
        it('op-manifest is built for the calling peer only', async () => {
            h.fed.getOperationManifestForPeer.mockResolvedValue({ ops: [{ id: 'op-1', version: 3 }] });
            const r = await call('GET', '/api/alliance/op-manifest', { headers: fed() });
            expect(r.json).toEqual({ ops: [{ id: 'op-1', version: 3 }] });
            expect(h.fed.getOperationManifestForPeer).toHaveBeenCalledWith('peer-1');
        });

        it('op snapshot passes a numeric since, and drops a non-numeric or absent one', async () => {
            h.fed.getOperationSnapshotForPeer.mockResolvedValue({ id: 'op-7' });
            const r = await call('GET', '/api/alliance/op/op-7?since=42', { headers: fed() });
            expect(r.json).toEqual({ id: 'op-7' });
            await call('GET', '/api/alliance/op/op-7?since=soon', { headers: fed() });
            await call('GET', '/api/alliance/op/op-7', { headers: fed() });
            expect(h.fed.getOperationSnapshotForPeer.mock.calls).toEqual([['op-7', 'peer-1', 42], ['op-7', 'peer-1', undefined], ['op-7', 'peer-1', undefined]]);
        });

        it('accept and decline act for the calling peer', async () => {
            h.fed.acceptInviteForPeer.mockResolvedValue({ accepted: true });
            expect((await call('POST', '/api/alliance/op/op-2/accept', { headers: fed() })).json).toEqual({ accepted: true });
            expect(h.fed.acceptInviteForPeer).toHaveBeenCalledWith('op-2', 'peer-1');
            h.fed.declineInviteForPeer.mockResolvedValue(undefined);
            expect((await call('POST', '/api/alliance/op/op-2/decline', { headers: fed() })).json).toEqual({ ok: true });
            expect(h.fed.declineInviteForPeer).toHaveBeenCalledWith('op-2', 'peer-1');
        });

        it('rsvp forwards only the whitelisted participant fields, scoped to the calling peer', async () => {
            h.fed.upsertAlliedParticipant.mockResolvedValue(undefined);
            const r = await call('POST', '/api/alliance/op/op-3/rsvp', fedJson({
                remoteUserHandle: 'pilot', displayName: 'Pilot', avatarUrl: 'https://a/p.png', role: 'gunner', shipText: 'Hammerhead',
                rsvpStatus: 'going', isReady: true, peerId: 'peer-EVIL', removed: false,
            }));
            expect(r.json).toEqual({ ok: true });
            expect(h.fed.upsertAlliedParticipant).toHaveBeenCalledWith('op-3', 'peer-1', {
                remoteUserHandle: 'pilot', displayName: 'Pilot', avatarUrl: 'https://a/p.png', role: 'gunner', shipText: 'Hammerhead', rsvpStatus: 'going', isReady: true,
            });
            expect(h.fed.removeAlliedParticipant).not.toHaveBeenCalled();
        });

        it('rsvp with removed:true withdraws only the calling peer\'s participant', async () => {
            h.fed.removeAlliedParticipant.mockResolvedValue(undefined);
            const r = await call('POST', '/api/alliance/op/op-3/rsvp', fedJson({ removed: true, remoteUserHandle: 'pilot' }));
            expect(r.json).toEqual({ ok: true });
            expect(h.fed.removeAlliedParticipant).toHaveBeenCalledWith('op-3', 'peer-1', 'pilot');
            expect(h.fed.upsertAlliedParticipant).not.toHaveBeenCalled();
        });

        it('mirror invite / push / revoke hand the resolved peer (never a body-supplied one) to the receiver', async () => {
            h.fed.receiveMirrorInvite.mockResolvedValue(undefined);
            h.fed.receiveMirrorPush.mockResolvedValue(undefined);
            h.fed.receiveMirrorRevoke.mockResolvedValue(undefined);
            expect((await call('POST', '/api/alliance/op-mirror/invite', fedJson({ op_id: 'op-4', title: 'Raid' }))).json).toEqual({ ok: true });
            expect((await call('POST', '/api/alliance/op-mirror/push', fedJson({ op_id: 'op-4', version: 2 }))).json).toEqual({ ok: true });
            expect((await call('POST', '/api/alliance/op-mirror/revoke', fedJson({ op_id: 'op-4', extra: 1 }))).json).toEqual({ ok: true });
            expect(h.fed.receiveMirrorInvite).toHaveBeenCalledWith(PEER, { op_id: 'op-4', title: 'Raid' });
            expect(h.fed.receiveMirrorPush).toHaveBeenCalledWith(PEER, { op_id: 'op-4', version: 2 });
            expect(h.fed.receiveMirrorRevoke).toHaveBeenCalledWith(PEER, 'op-4');
        });

        it('roster and fleet return the projection, and 403 when the channel is not shared with this peer', async () => {
            for (const [p, fn] of [['/api/alliance/roster', h.fed.getAllyRosterProjection], ['/api/alliance/fleet', h.fed.getAllyFleetProjection]] as const) {
                fn.mockResolvedValueOnce({ members: [{ handle: 'a' }] });
                const shared = await call('GET', p, { headers: fed() });
                expect(shared.json, p).toEqual({ members: [{ handle: 'a' }] });
                fn.mockResolvedValueOnce(null);
                const off = await call('GET', p, { headers: fed() });
                expect(off.status, p).toBe(403);
                expect(off.json, p).toEqual({ error: 'forbidden' });
                expect(fn).toHaveBeenCalledWith(PEER);
            }
        });

        const OP_ROUTES: Array<[string, string, keyof typeof h.fed, string]> = [
            ['GET', '/api/alliance/op-manifest', 'getOperationManifestForPeer', 'alliance op-manifest'],
            ['GET', '/api/alliance/op/op-1', 'getOperationSnapshotForPeer', 'alliance op snapshot'],
            ['POST', '/api/alliance/op/op-1/accept', 'acceptInviteForPeer', 'alliance op accept'],
            ['POST', '/api/alliance/op/op-1/decline', 'declineInviteForPeer', 'alliance op decline'],
            ['POST', '/api/alliance/op/op-1/rsvp', 'upsertAlliedParticipant', 'alliance op rsvp'],
            ['POST', '/api/alliance/op-mirror/invite', 'receiveMirrorInvite', 'alliance op-mirror invite'],
            ['POST', '/api/alliance/op-mirror/push', 'receiveMirrorPush', 'alliance op-mirror push'],
            ['POST', '/api/alliance/op-mirror/revoke', 'receiveMirrorRevoke', 'alliance op-mirror revoke'],
            ['GET', '/api/alliance/roster', 'getAllyRosterProjection', 'alliance roster'],
            ['GET', '/api/alliance/fleet', 'getAllyFleetProjection', 'alliance fleet'],
        ];

        it.each(OP_ROUTES)('%s %s maps forbidden/malformed_request to 403 and anything else to an opaque 500 failed', async (method, p, fnName, label) => {
            const fn = h.fed[fnName];
            for (const denied of ['forbidden', 'malformed_request']) {
                fn.mockRejectedValueOnce(new Error(denied));
                const r = await call(method, p, { headers: fed(JSON_CT), body: '{}' });
                expect(r.status, denied).toBe(403);
                expect(r.json, denied).toEqual({ error: 'forbidden' });
            }
            expect(logsOf(`${label} error`)).toHaveLength(0);
            fn.mockRejectedValueOnce(new Error('connection to 10.0.0.5:5432 refused'));
            const failed = await call(method, p, { headers: fed(JSON_CT), body: '{}' });
            expect(failed.status).toBe(500);
            expect(failed.json).toEqual({ error: 'failed' });
            expect(failed.text).not.toContain('10.0.0.5');
            fn.mockRejectedValueOnce({ not: 'an Error' });
            expect((await call(method, p, { headers: fed(JSON_CT), body: '{}' })).status).toBe(500);
            expect(logsOf(`${label} error`)).toHaveLength(2);
        });
    });
});

// ---------------------------------------------------------------------------------------------
// /api/admin/import-stream — end to end beyond the pre-auth ordering (tests/rawRoutePreAuth.test.ts)
// ---------------------------------------------------------------------------------------------

describe('/api/admin/import-stream', () => {
    const NDJSON = '{"type":"meta","version":1}\n';
    const imp = (query = '', headers: Record<string, string> = bearer(1), body: string = NDJSON) =>
        call('POST', `/api/admin/import-stream${query}`, { headers: { ...fromIp(freshIp()), ...SAME_ORIGIN, ...headers }, body });
    const slotIsFree = async () => { h.importImpl = null; expect((await imp()).status).toBe(200); };

    it('streams NDJSON progress, and a MERGE that re-anchors the admin clears the stale cookie and issues a token for the new id', async () => {
        h.importImpl = async (_n, onEvent) => { onEvent({ type: 'phase', phase: 'users' }); return { reanchoredAdminUserId: 9 }; };
        const r = await imp('?mergeUserId=7');
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
        expect(r.headers['x-accel-buffering']).toBe('no');
        expect(r.headers['cache-control']).toBe(NO_STORE);
        expect(r.headers['set-cookie']).toEqual(['myrsi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']);
        // The merge TARGET is the verified caller, never anything client-supplied.
        expect(h.importArgs[0]).toEqual({ ndjson: NDJSON, merge: { importedUserId: 7, adminUserId: 1 } });
        const lines = ndjsonLines(r.text);
        expect(lines[0]).toEqual({ type: 'phase', phase: 'users' });
        expect(lines[1]).toMatchObject({ type: 'reauth', userId: 9 });
        expect(verifyToken(lines[1].token)?.userId).toBe(9);
        expect(lines).toHaveLength(2);
    });

    it('a merge that keeps the same id issues no new token', async () => {
        h.importImpl = async () => ({ reanchoredAdminUserId: 1 });
        const r = await imp('?mergeUserId=7');
        expect(ndjsonLines(r.text)).toEqual([]);
        expect(r.headers['set-cookie']).toBeDefined();
    });

    it.each(['abc', '0', '-3', '1.5', ''])('mergeUserId=%j is not a positive integer: no merge, no cookie clear', async (v) => {
        const r = await imp(`?mergeUserId=${v}`);
        expect(r.status).toBe(200);
        expect(h.importArgs[0].merge).toBeUndefined();
        expect(r.headers['set-cookie']).toBeUndefined();
    });

    it('a POST with no body at all (no Content-Length, no Transfer-Encoding) is refused 400 and frees the slot', async () => {
        const r = await rawRequest([
            'POST /api/admin/import-stream HTTP/1.1', 'Host: 127.0.0.1', 'Connection: close',
            `CF-Connecting-IP: ${freshIp()}`, 'Sec-Fetch-Site: same-origin', `Authorization: Bearer ${signToken({ userId: 1 })}`,
        ]);
        expect(r.status).toBe(400);
        expect(JSON.parse(r.body)).toEqual({ error: 'No import data provided.' });
        expect(h.importArgs).toHaveLength(0);
        await slotIsFree();
    });

    it('a repeated mergeUserId uses the first value', async () => {
        await imp('?mergeUserId=5&mergeUserId=6');
        expect(h.importArgs[0].merge).toEqual({ importedUserId: 5, adminUserId: 1 });
    });

    it('reports a refused import as refused:true and any other failure as refused:false', async () => {
        h.importImpl = async () => { throw new ImportRefusedError('ship catalog is empty'); };
        expect(ndjsonLines((await imp()).text)).toEqual([{ type: 'error', message: 'ship catalog is empty', refused: true }]);
        h.importImpl = async () => { throw new Error('insert failed on fleet'); };
        expect(ndjsonLines((await imp()).text)).toEqual([{ type: 'error', message: 'insert failed on fleet', refused: false }]);
        h.importImpl = async () => { throw 'not an Error'; };
        expect(ndjsonLines((await imp()).text)).toEqual([{ type: 'error', message: 'Import failed.', refused: false }]);
    });

    it('a fault while reporting a failure mid-stream still ends the response and frees the slot', async () => {
        h.importImpl = async (_n, onEvent) => {
            onEvent({ type: 'phase', phase: 'users' });
            const err = new Error('x');
            Object.defineProperty(err, 'message', { get() { throw new Error('reporting failed'); } });
            throw err;
        };
        const r = await imp();
        expect(r.status).toBe(200);
        expect(ndjsonLines(r.text)).toEqual([{ type: 'phase', phase: 'users' }]);
        expect(logsOf('import-stream error')).toHaveLength(1);
        await slotIsFree();
    });

    describe('the handler re-runs the whole caller ladder (defence in depth)', () => {
        it('a session force-logged-out between the pre-auth and the handler → 401 force_logout', async () => {
            h.settingsQueue = [{}, { force_logout_timestamp: FUTURE }];
            const r = await imp();
            expect(r.status).toBe(401);
            expect(r.json).toEqual({ error: 'Session expired. Please log in again.', force_logout: true });
            expect(h.importArgs).toHaveLength(0);
            await slotIsFree();
        });

        it('a token the handler no longer verifies → 401', async () => {
            h.verifyQueue = ['real', null];
            const r = await imp();
            expect(r.status).toBe(401);
            expect(r.json).toEqual({ error: 'Unauthorized' });
            await slotIsFree();
        });

        it('a session revoked by the watermark at the handler → 401, never re-anchored', async () => {
            h.userQueue = [ADMIN, { ...ADMIN, tokensValidFrom: FUTURE }];
            h.importImpl = async () => ({ reanchoredAdminUserId: 9 });
            const r = await imp('?mergeUserId=7');
            expect(r.status).toBe(401);
            expect(r.json).toEqual({ error: 'Session expired. Please log in again.' });
            expect(h.importArgs).toHaveLength(0);
        });

        it('a ban placed between the pre-auth and the handler → 403', async () => {
            h.banQueue = ['clear', 'banned'];
            const r = await imp();
            expect(r.status).toBe(403);
            expect(r.json).toEqual({ error: 'Forbidden' });
            expect(h.importArgs).toHaveLength(0);
        });

        it('an unavailable ban check at the handler fails closed to a retryable 503 without an error log', async () => {
            const unavailable = Object.assign(new Error('ban read failed'), { name: 'BanCheckUnavailable' });
            h.banQueue = ['clear', unavailable];
            const r = await imp();
            expect(r.status).toBe(503);
            expect(r.json).toEqual({ error: 'Unable to verify account status. Please try again.' });
            expect(logsOf('ban gate failed unexpectedly on import-stream')).toHaveLength(0);
        });

        it('an unexpected ban-check fault at the handler fails closed to 503 AND is logged', async () => {
            h.banQueue = ['clear', new Error('TypeError in ban lookup')];
            const r = await imp();
            expect(r.status).toBe(503);
            expect(logsOf('ban gate failed unexpectedly on import-stream')).toHaveLength(1);
            expect(logsOf('ban gate failed unexpectedly on import-stream')[0].fields).toMatchObject({ userId: 1 });
        });

        it('a database fault in the handler → opaque 500, logged, slot freed', async () => {
            h.userQueue = [ADMIN, new Error('users read failed at /srv/db')];
            const r = await imp();
            expect(r.status).toBe(500);
            expect(r.json).toEqual({ error: 'Internal Server Error' });
            expect(logsOf('import-stream error')).toHaveLength(1);
            await slotIsFree();
        });
    });

    describe('pre-auth fault handling', () => {
        it('an unexpected ban-check fault fails closed to 503 and is logged; an unavailable one is not logged', async () => {
            h.banQueue = [new Error('TypeError in ban lookup')];
            expect((await imp()).status).toBe(503);
            expect(logsOf('ban gate failed unexpectedly on import-stream pre-auth')).toHaveLength(1);
            h.logs = [];
            h.banQueue = [Object.assign(new Error('x'), { name: 'BanCheckUnavailable' })];
            expect((await imp()).status).toBe(503);
            expect(logsOf('ban gate failed unexpectedly on import-stream pre-auth')).toHaveLength(0);
        });

        it('a settings read fault before the parser → opaque 500, logged, and the slot was never taken', async () => {
            h.settingsQueue = [new Error('settings table unreachable')];
            const r = await imp();
            expect(r.status).toBe(500);
            expect(r.json).toEqual({ error: 'Internal Server Error' });
            expect(r.text).not.toContain('unreachable');
            expect(logsOf('import-stream pre-auth error')).toHaveLength(1);
            await slotIsFree();
        });

        it('a Member is refused at the pre-auth (403) — the cookie credential is honoured as well as the header', async () => {
            const r = await imp('', { cookie: `myrsi_session=${signToken({ userId: 2 })}` });
            expect(r.status).toBe(403);
            expect(h.importArgs).toHaveLength(0);
        });
    });
});

// ---------------------------------------------------------------------------------------------
// /api/org/upload
// ---------------------------------------------------------------------------------------------

describe('/api/org/upload', () => {
    const up = (headers: Record<string, string>, body: string | Buffer) =>
        call('POST', '/api/org/upload?for=branding', { headers: { ...fromIp(freshIp()), ...SAME_ORIGIN, ...headers }, body });

    it('a valid session reaches the handler with the raw image bytes', async () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        const r = await up({ ...bearer(2), 'content-type': 'image/png' }, png);
        expect(r.status).toBe(201);
        expect(Buffer.isBuffer(callsOf('upload')[0].body)).toBe(true);
        expect((callsOf('upload')[0].body as Buffer).equals(png)).toBe(true);
    });

    it('a body type outside the image allow-list is left unparsed for the handler to refuse', async () => {
        await up({ ...bearer(2), 'content-type': 'text/html' }, '<script>x</script>');
        expect(callsOf('upload')[0].body).toBeUndefined();
    });

    it('a body over MAX_UPLOAD_BYTES is a 413 before the handler', async () => {
        const r = await up({ ...bearer(2), 'content-type': 'image/png' }, Buffer.alloc(5000, 1));
        expect(r.status).toBe(413);
        expect(callsOf('upload')).toHaveLength(0);
    });

    it('a rejected handler promise becomes a fixed 500 and is logged', async () => {
        h.handlers.upload = async () => { throw new Error('storage bucket detail'); };
        const r = await up({ ...bearer(2), 'content-type': 'image/png' }, 'x');
        expect(r.status).toBe(500);
        expect(r.json).toEqual({ message: 'Upload failed' });
        expect(logsOf('org upload handler error')).toHaveLength(1);
    });

    it('a rejection after the response started does not attempt a second response', async () => {
        h.handlers.upload = async (_req, res) => { res.status(201); res.flushHeaders(); throw new Error('late'); };
        expect(await statusOnly('POST', '/api/org/upload?for=branding', { ...fromIp(freshIp()), ...SAME_ORIGIN, ...bearer(2), 'content-type': 'image/png' }, 'x')).toBe(201);
        await vi.waitFor(() => expect(logsOf('org upload handler error')).toHaveLength(1));
    });
});

// ---------------------------------------------------------------------------------------------
// Static serving, the SSR catch-all, and the terminal handlers
// ---------------------------------------------------------------------------------------------

describe('static files and the SSR catch-all', () => {
    const get = (p: string) => call('GET', p, { headers: fromIp(freshIp()) });

    it('serves built HTML never-cached, hashed assets immutable, and other files for an hour', async () => {
        const html = await get('/index.html');
        expect(html.text).toBe(INDEX_HTML);
        expect(html.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
        expect(html.headers['cdn-cache-control']).toBe('no-store');
        const asset = await get('/assets/app-3f9a1c.js');
        expect(asset.status).toBe(200);
        expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
        const icon = await get('/icon.svg');
        expect(icon.status).toBe(200);
        expect(icon.headers['cache-control']).toBe('public, max-age=3600');
    });

    it('does not auto-serve index.html for "/" — the SSR handler renders it', async () => {
        const r = await get('/');
        expect(r.text).toBe('<!doctype html><p>ssr /</p>');
        expect(callsOf('ssr')).toHaveLength(1);
    });

    it('never serves a dotfile from dist', async () => {
        const r = await get('/.secret.json');
        expect(r.status).toBe(404);
        expect(r.text).not.toContain('DOTFILE-CANARY');
    });

    it('never serves a file outside dist via an encoded traversal', async () => {
        for (const p of ['/%2e%2e/outside.txt', '/assets/%2e%2e/%2e%2e/outside.txt', '/..%2foutside.txt']) {
            const r = await get(p);
            expect(r.status, p).toBeGreaterThanOrEqual(400);
            expect(r.text, p).not.toContain('OUTSIDE-CANARY');
        }
    });

    it('/media gets a wildcard CORS grant on hits and misses alike', async () => {
        const hit = await get('/media/logo.png');
        expect(hit.status).toBe(200);
        expect(hit.headers['access-control-allow-origin']).toBe('*');
        const miss = await get('/media/nope.png');
        expect(miss.status).toBe(404);
        expect(miss.headers['access-control-allow-origin']).toBe('*');
    });

    it('a missing dotted asset is a never-cached 404 that never reaches the SSR handler', async () => {
        const r = await get('/assets/missing-chunk-9.js');
        expect(r.status).toBe(404);
        expect(r.text).toBe('Not Found');
        expect(r.headers['cache-control']).toBe('no-store');
        expect(r.headers['cdn-cache-control']).toBe('no-store');
        expect(callsOf('ssr')).toHaveLength(0);
    });

    it('an .html path that is not on disk is rendered by the SSR handler', async () => {
        const r = await get('/legal/terms.html');
        expect(r.status).toBe(200);
        expect(callsOf('ssr')[0].path).toBe('/legal/terms.html');
    });

    it('an SSR failure falls back to the static shell, never cached', async () => {
        h.handlers.ssr = () => { throw new Error('render failed'); };
        const r = await get('/dashboard');
        expect(r.status).toBe(200);
        expect(r.text).toBe(INDEX_HTML);
        expect(r.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
        expect(r.headers['cdn-cache-control']).toBe('no-store');
        expect(logsOf('ssr handler error')).toHaveLength(1);
    });
});

describe('terminal handlers', () => {
    it('an unmatched /api path is a JSON 404, not the SPA', async () => {
        const r = await call('DELETE', '/api/nothing-here', { headers: fromIp(freshIp()) });
        expect(r.status).toBe(404);
        expect(r.json).toEqual({ message: 'Not found' });
        expect(r.headers['cache-control']).toBe('no-store');
    });

    it('a stray non-GET to a SPA path 303s to a hardcoded "/" (never derived from the request)', async () => {
        for (const p of ['/operations/board', '//evil.example/steal']) {
            const r = await call('PUT', p, { headers: fromIp(freshIp()) });
            expect(r.status, p).toBe(303);
            expect(r.headers.location, p).toBe('/');
        }
    });

    it('OPTIONS on a SPA path is a bodiless 204', async () => {
        const r = await call('OPTIONS', '/operations/board', { headers: fromIp(freshIp()) });
        expect(r.status).toBe(204);
        expect(r.text).toBe('');
    });

    it('stray non-GETs count toward the blackhole — except on the health paths an uptime monitor may POST', async () => {
        const monitor = freshIp();
        await repeat(25, (i) => call('POST', i % 2 ? '/healthz' : '/readyz', { headers: fromIp(monitor), agent: bulk }));
        expect((await call('GET', '/healthz', { headers: fromIp(monitor) })).status).toBe(200);

        const stray = freshIp();
        const rs = await repeat(20, () => call('POST', '/some/spa/path', { headers: fromIp(stray), agent: bulk }));
        expect(rs.every((r) => r.status === 303)).toBe(true);
        expect((await call('GET', '/healthz', { headers: fromIp(stray) })).status).toBe(404);
    });
});
