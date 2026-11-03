// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FAKE_ANON_JWT, FAKE_SERVICE_ROLE_JWT, FAKE_SECRET, fakeJwt, LEGACY_CLAIMS } from './supabaseKeyFixtures';

// server.ts's module-load decisions: the production env guards, the anon-key check's three tiers
// and what each logs, the JWT_SECRET tiers as they surface through a real server import, the
// session-cookie warning, `trust proxy`, and the CSP connect-src pin. Each case boots a FRESH
// module registry under its own env, because each of these runs exactly once, at import.
//
// Supabase client construction is made inert: lib/supabaseServer throws at import when
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset, and api/index.ts + api/sw.ts call
// createClient at import (which throws on an empty URL). Either would fire before server.ts's own
// guard — the thing under test here — and shadow it for two of its three variables.

interface LogRecord { level: string; msg: string; fields: Record<string, unknown> | undefined }
const h = vi.hoisted(() => ({ logs: [] as LogRecord[] }));

vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => { h.logs.push({ level, msg, fields }); };
    const logger = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), child: () => logger };
    return { ...actual, log: logger };
});
vi.mock('../lib/supabaseServer', () => ({ supabase: {}, handleSupabaseError: () => undefined }));
vi.mock('@supabase/supabase-js', async (importOriginal) => ({ ...(await importOriginal<typeof import('@supabase/supabase-js')>()), createClient: () => ({}) }));

const PROD: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_ROLE_JWT,
    SECRETS_ENCRYPTION_KEY: 'e'.repeat(16) + 'f'.repeat(48),
    JWT_SECRET: '0123456789abcdef'.repeat(4),
    SUPABASE_ANON_KEY: FAKE_ANON_JWT,
    APP_URL: 'https://org.example',
    TRUST_PROXY_HOPS: undefined,
    TRUST_CF_PROXY: undefined,
    SESSION_COOKIE_SECURE: undefined,
    LIVEKIT_URL: undefined,
};

function env(vars: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
}
async function boot(): Promise<typeof import('../server')> {
    vi.resetModules();
    h.logs = [];
    return import('../server.ts');
}
async function bootError(): Promise<Error | null> {
    return boot().then(() => null, (e: Error) => e);
}
const logsOf = (msg: string) => h.logs.filter((l) => l.msg === msg);

beforeEach(() => { h.logs = []; });
afterEach(() => { vi.unstubAllEnvs(); });

describe('production env guards', () => {
    it('refuses to boot without the Supabase URL, service-role key and encryption key, naming each in order', async () => {
        env({ ...PROD, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SECRETS_ENCRYPTION_KEY: '' });
        const err = await bootError();
        expect(err?.message).toBe('Startup aborted: missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SECRETS_ENCRYPTION_KEY');
        const missing = logsOf('required env var not set');
        expect(missing.map((l) => l.fields?.name)).toEqual(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SECRETS_ENCRYPTION_KEY']);
        for (const l of missing) {
            expect(l.level).toBe('error');
            expect(String(l.fields?.hint).length).toBeGreaterThan(20);
        }
    }, 60_000);

    it('names only what is actually missing', async () => {
        env({ ...PROD, SECRETS_ENCRYPTION_KEY: undefined });
        const err = await bootError();
        expect(err?.message).toBe('Startup aborted: missing required env vars: SECRETS_ENCRYPTION_KEY');
        expect(logsOf('required env var not set').map((l) => l.fields?.name)).toEqual(['SECRETS_ENCRYPTION_KEY']);
    }, 60_000);

    it('refuses an encryption key under 32 characters, logging its length but never its value', async () => {
        const shortKey = 'K3Y-CANARY-'.padEnd(31, 'z');
        env({ ...PROD, SECRETS_ENCRYPTION_KEY: shortKey });
        const err = await bootError();
        expect(err?.message).toBe('Startup aborted: SECRETS_ENCRYPTION_KEY must be at least 32 characters.');
        expect(logsOf('SECRETS_ENCRYPTION_KEY too short')[0]).toMatchObject({ level: 'error', fields: { length: 31 } });
        expect(JSON.stringify(h.logs)).not.toContain('K3Y-CANARY');
        expect(err?.message).not.toContain('K3Y-CANARY');
    }, 60_000);

    it('accepts an encryption key of exactly 32 characters', async () => {
        env({ ...PROD, SECRETS_ENCRYPTION_KEY: 'k'.repeat(32) });
        const mod = await boot();
        expect(typeof mod.app).toBe('function');
        expect(logsOf('SECRETS_ENCRYPTION_KEY too short')).toHaveLength(0);
    }, 60_000);

    it('does not run the env guards outside production', async () => {
        env({ NODE_ENV: 'test', SECRETS_ENCRYPTION_KEY: undefined });
        const mod = await boot();
        expect(typeof mod.app).toBe('function');
        expect(logsOf('required env var not set')).toHaveLength(0);
    }, 60_000);
});

describe('SUPABASE_ANON_KEY boot check — what it logs, per tier', () => {
    const UNSET_MSG = 'SUPABASE_ANON_KEY not set — live updates are disabled';
    const SECRET_MSG = 'SUPABASE_ANON_KEY is a secret key, not a browser-safe one; it will not be sent to clients';
    const UNRECOGNISED_MSG = 'SUPABASE_ANON_KEY is not a recognised publishable key — it will not be sent to clients; live updates disabled';
    const anonLogs = () => h.logs.filter((l) => l.msg.startsWith('SUPABASE_ANON_KEY'));

    it.each([
        ['unset', undefined],
        ['empty', ''],
        ['whitespace only', '   '],
    ])('%s is one warning, not an error, and production boots (it leaks nothing; realtime simply stays off)', async (_l, value) => {
        env({ ...PROD, SUPABASE_ANON_KEY: value });
        const mod = await boot();
        expect(typeof mod.app).toBe('function');
        expect(anonLogs()).toEqual([{ level: 'warn', msg: UNSET_MSG, fields: { fix: expect.stringContaining('publishable') } }]);
        expect(h.logs.filter((l) => l.level === 'error')).toEqual([]);
    }, 60_000);

    // A SECRET key: production refuses, after a log.error that names the rule and never the key.
    const OTHER_SERVICE_ROLE_JWT = fakeJwt({ ...LEGACY_CLAIMS, ref: 'zyxwvutsrqponmlkjihg', role: 'service_role' });
    it.each([
        ['the service-role value itself', FAKE_SERVICE_ROLE_JWT, 'same as SUPABASE_SERVICE_ROLE_KEY'],
        ['an sb_secret_ key', FAKE_SECRET, 'is a secret key (sb_secret_)'],
        ['a service_role JWT (not the configured value)', OTHER_SERVICE_ROLE_JWT, 'is a JWT whose role claim is not "anon"'],
    ])('production REFUSES %s, logging the rule first — never the key', async (_l, key, problem) => {
        env({ ...PROD, SUPABASE_ANON_KEY: key });
        const err = await bootError();
        expect(err?.message).toBe(`Startup aborted: SUPABASE_ANON_KEY ${problem}. SUPABASE_ANON_KEY must be the publishable (sb_publishable_…) or legacy anon key, never the service-role / secret key. Supabase Dashboard → Project Settings → API.`);
        expect(anonLogs()).toEqual([{ level: 'error', msg: SECRET_MSG, fields: { problem, fix: expect.stringContaining('never the service-role') } }]);
        expect(JSON.stringify(h.logs)).not.toContain(key);
        expect(err?.message).not.toContain(key);
    }, 60_000);

    it('a secret key outside production logs the broken rule and the fix — never the key — and boots', async () => {
        env({ NODE_ENV: 'test', SUPABASE_ANON_KEY: FAKE_SERVICE_ROLE_JWT });
        const mod = await boot();
        expect(typeof mod.app).toBe('function');
        const [rec] = logsOf(SECRET_MSG);
        expect(rec.level).toBe('error');
        expect(rec.fields?.problem).toBe('is a JWT whose role claim is not "anon"');
        expect(String(rec.fields?.fix)).toContain('publishable');
        expect(JSON.stringify(h.logs)).not.toContain(FAKE_SERVICE_ROLE_JWT);
    }, 60_000);

    // UNRECOGNISED: not exploitable (api/query.ts withholds it per request), so it boots EVERYWHERE.
    it.each([
        ['production', 'production'],
        ['test', 'test'],
    ])('an unrecognised value (the .env.example placeholder) boots in %s with one log.error — never the key', async (_l, nodeEnv) => {
        const placeholder = 'your-anon-public-key';
        env({ ...PROD, NODE_ENV: nodeEnv, SUPABASE_ANON_KEY: placeholder });
        const mod = await boot();
        expect(typeof mod.app).toBe('function');
        expect(anonLogs()).toEqual([{ level: 'error', msg: UNRECOGNISED_MSG, fields: { problem: 'is not a recognised publishable key format', fix: expect.stringContaining('leave it blank') } }]);
        expect(JSON.stringify(h.logs)).not.toContain(placeholder);
    }, 60_000);

    it('an unrecognised canary value never reaches any log field', async () => {
        const canary = 'ANON-CANARY-not-a-key-7f3a9c';
        env({ ...PROD, SUPABASE_ANON_KEY: canary });
        await boot();
        expect(logsOf(UNRECOGNISED_MSG)).toHaveLength(1);
        expect(JSON.stringify(h.logs)).not.toContain('ANON-CANARY');
    }, 60_000);

    it('a real-shaped anon key produces no anon-key log at all', async () => {
        env(PROD);
        await boot();
        expect(anonLogs()).toEqual([]);
    }, 60_000);
});

describe('JWT_SECRET tiers through a real server.ts import (lib/auth.ts is evaluated first)', () => {
    const WEAK_MSG = 'jwt_secret is weaker than recommended; starting anyway, rotate it when convenient';
    const jwtLogs = () => h.logs.filter((l) => l.msg.startsWith('jwt_secret'));

    it('a 24-character secret boots in production with exactly one log.error — never the value', async () => {
        const medium = 'Zt4kW9qL2xR7mB1nC6vY3pHs';
        env({ ...PROD, JWT_SECRET: medium });
        const mod = await boot();
        expect(typeof mod.app).toBe('function');
        expect(jwtLogs()).toEqual([{ level: 'error', msg: WEAK_MSG, fields: { problems: ['shorter than the recommended 32 characters'], hint: expect.stringContaining('openssl rand -hex 32') } }]);
        expect(JSON.stringify(h.logs)).not.toContain(medium);
    }, 60_000);

    it('a copy of the private SECRETS_ENCRYPTION_KEY boots in production with one log.error naming it — never the value', async () => {
        env({ ...PROD, JWT_SECRET: PROD.SECRETS_ENCRYPTION_KEY });
        const mod = await boot();
        expect(typeof mod.app).toBe('function');
        expect(jwtLogs()).toEqual([{ level: 'error', msg: WEAK_MSG, fields: { problems: ['identical to SECRETS_ENCRYPTION_KEY'], hint: expect.any(String) } }]);
        expect(JSON.stringify(h.logs)).not.toContain(PROD.SECRETS_ENCRYPTION_KEY!);
    }, 60_000);

    it('a 15-character secret refuses production boot', async () => {
        env({ ...PROD, JWT_SECRET: 'abcdefghijklmno' });
        const err = await bootError();
        expect(err?.message).toMatch(/^CRITICAL: JWT_SECRET is unsafe \(shorter than 16 characters\)/);
        expect(err?.message).not.toContain('abcdefghijklmno');
    }, 60_000);

    it('a copy of the published SUPABASE_ANON_KEY refuses production boot', async () => {
        env({ ...PROD, JWT_SECRET: FAKE_ANON_JWT });
        const err = await bootError();
        expect(err?.message).toMatch(/^CRITICAL: JWT_SECRET is unsafe \(identical to the published SUPABASE_ANON_KEY\)/);
        expect(err?.message).not.toContain(FAKE_ANON_JWT);
    }, 60_000);

    it('the documented 64-character secret boots silently', async () => {
        env(PROD);
        await boot();
        expect(jwtLogs()).toEqual([]);
    }, 60_000);
});

describe('session cookie mode warning', () => {
    const WARN = 'session cookie will NOT be marked Secure';

    it('warns loudly when the deployment is not https (the cookie can travel over plain HTTP)', async () => {
        env({ ...PROD, APP_URL: 'http://lan.local:3000' });
        await boot();
        expect(logsOf(WARN)).toHaveLength(1);
        expect(logsOf(WARN)[0].fields).toHaveProperty('fix');
    }, 60_000);

    it('is silent on an https deployment and when SESSION_COOKIE_SECURE=1 says TLS terminates upstream', async () => {
        env({ ...PROD, APP_URL: 'https://org.example' });
        await boot();
        expect(logsOf(WARN)).toHaveLength(0);
        env({ APP_URL: 'http://behind-tls-proxy.local', SESSION_COOKIE_SECURE: '1' });
        await boot();
        expect(logsOf(WARN)).toHaveLength(0);
    }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// HTTP against a freshly booted app
// ---------------------------------------------------------------------------------------------

async function withServer(app: import('express').Express, fn: (get: (path: string, headers?: Record<string, string>) => Promise<{ status: number; headers: http.IncomingHttpHeaders }>) => Promise<void>): Promise<void> {
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.once('listening', () => r()));
    const { port } = srv.address() as AddressInfo;
    const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', agent: false, headers }, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
    });
    try {
        await fn(get);
    } finally {
        srv.closeAllConnections();
        await new Promise<void>((r) => srv.close(() => r()));
    }
}

describe('trust proxy', () => {
    it.each([
        [undefined, 0], ['0', 0], ['2', 2], ['-1', 0], ['abc', 0], ['1.5', 0],
    ] as const)('TRUST_PROXY_HOPS=%s → trust proxy %i (anything but a non-negative integer falls back to the secure 0)', async (hops, expected) => {
        env({ NODE_ENV: 'test', TRUST_PROXY_HOPS: hops });
        const { app } = await boot();
        expect(app.get('trust proxy')).toBe(expected);
    }, 60_000);

    it('by default a client-supplied X-Forwarded-For is ignored: the socket peer is the caller', async () => {
        env({ NODE_ENV: 'test', TRUST_PROXY_HOPS: undefined, TRUST_CF_PROXY: undefined });
        const { app } = await boot();
        await withServer(app, async (get) => {
            for (let i = 0; i < 25; i++) await get('/wp-admin', { 'x-forwarded-for': '203.0.113.7' });
            // The probes were attributed to loopback (never blackholed), not to the spoofed address.
            expect((await get('/healthz', { 'x-forwarded-for': '203.0.113.7' })).status).toBe(200);
        });
        expect(logsOf('ip blackholed')).toHaveLength(0);
        expect(logsOf('scanner probe')[0].fields).toMatchObject({ ip: '127.0.0.1' });
    }, 60_000);

    it('with TRUST_PROXY_HOPS=1 the forwarded client address is the key the blackhole uses', async () => {
        env({ NODE_ENV: 'test', TRUST_PROXY_HOPS: '1', TRUST_CF_PROXY: undefined });
        const { app } = await boot();
        await withServer(app, async (get) => {
            for (let i = 0; i < 20; i++) await get('/wp-admin', { 'x-forwarded-for': '203.0.113.7' });
            expect((await get('/healthz', { 'x-forwarded-for': '203.0.113.7' })).status).toBe(404);
            expect((await get('/healthz', { 'x-forwarded-for': '203.0.113.8' })).status).toBe(200);
        });
        expect(logsOf('ip blackholed')[0].fields).toMatchObject({ ip: '203.0.113.7' });
    }, 60_000);
});

describe('CSP connect-src', () => {
    it('pins the exact configured Supabase and LiveKit origins at boot, with no platform wildcard', async () => {
        env({ NODE_ENV: 'test', SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', LIVEKIT_URL: 'wss://radio.example.net' });
        const { app } = await boot();
        await withServer(app, async (get) => {
            const csp = String((await get('/healthz')).headers['content-security-policy']);
            const connect = /connect-src ([^;]*);/.exec(csp)?.[1];
            expect(connect).toBe("'self' https://abcdefghijklmnopqrst.supabase.co wss://abcdefghijklmnopqrst.supabase.co https://radio.example.net wss://radio.example.net https://cloudflareinsights.com");
        });
    }, 60_000);
});
