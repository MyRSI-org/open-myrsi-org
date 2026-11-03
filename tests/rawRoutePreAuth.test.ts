// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';

// The two raw-body routes in server.ts buffer the request body in ROUTE middleware — up to 64 MB
// for /api/admin/import-stream, up to MAX_UPLOAD_BYTES for /api/org/upload — so whatever gate
// runs after the parser runs after the server has already paid for the body. These tests drive
// the REAL middleware chain (server.ts's exported app on an ephemeral port), because the property
// under test is what Express actually runs first, which source text cannot prove.
//
// HOW "BEFORE THE PARSER" IS OBSERVED. Every body parser in server.ts is inflate:false, so a
// request carrying `Content-Encoding: gzip` is refused by the parser itself with a 415 the moment
// it runs, before reading a byte. A gate that answers 401/403/409 to such a request therefore ran
// BEFORE the parser; a 415 means the parser got there first. The same request from a caller the
// gate admits gets the parser's 415 — proving the gate passes the right callers through rather
// than blocking everything.

const h = vi.hoisted(() => ({
    users: new Map<number, Record<string, unknown>>(),
    /** One-shot overrides consumed by successive getUserById calls (pre-auth first, handler second). */
    userQueue: [] as Array<Record<string, unknown> | null>,
    platformSettings: {} as Record<string, unknown>,
    banned: new Set<number>(),
    banThrows: false,
    banChecks: 0,
    importCalls: 0,
    importImpl: null as null | (() => Promise<{ reanchoredAdminUserId: number | null }>),
}));

vi.mock('../lib/db', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/db')>();
    return {
        ...actual,
        getPlatformSettings: async () => h.platformSettings,
        getUserById: async (id: number) => (h.userQueue.length > 0 ? h.userQueue.shift() : h.users.get(id) ?? null),
        findActiveBan: async ({ userId }: { userId?: number }) => {
            h.banChecks++;
            if (h.banThrows) { const e = new Error('ban read failed'); e.name = 'BanCheckUnavailable'; throw e; }
            return typeof userId === 'number' && h.banned.has(userId) ? { id: 99 } : null;
        },
        importOrgData: async () => {
            h.importCalls++;
            return h.importImpl ? h.importImpl() : { reanchoredAdminUserId: null };
        },
    };
});

import { signToken } from '../lib/auth';

const ADMIN = { id: 1, discordId: 'd1', isSystemAdmin: true, tokensValidFrom: null, permissions: [] };
const MEMBER = { id: 2, discordId: 'd2', isSystemAdmin: false, tokensValidFrom: null, permissions: [] };
const DISPATCHER_ADMIN_ACCESS = { id: 3, discordId: 'd3', isSystemAdmin: false, tokensValidFrom: null, permissions: ['admin:access'] };
const BANNED_ADMIN = { id: 4, discordId: 'd4', isSystemAdmin: true, tokensValidFrom: null, permissions: [] };
const REVOKED_ADMIN = { id: 5, discordId: 'd5', isSystemAdmin: true, tokensValidFrom: '2999-01-01T00:00:00.000Z', permissions: [] };

const bearer = (userId: number) => ({ authorization: `Bearer ${signToken({ userId })}` });
const GZIP = { 'content-encoding': 'gzip' };
const NDJSON = '{"type":"meta","version":1}\n';

/** A correctly signed but EXPIRED session token, minted with the same key lib/auth.ts loaded. */
function expiredToken(userId: number): string {
    const past = Date.now() - 48 * 60 * 60 * 1000;
    const data = Buffer.from(JSON.stringify({ userId, iat: past, exp: past + 1000 })).toString('base64');
    return `${data}.${createHmac('sha256', process.env.JWT_SECRET!).update(data).digest('hex')}`;
}

let server: http.Server;
let port = 0;

beforeAll(async () => {
    const mod = await import('../server.ts');
    server = mod.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
    h.users = new Map<number, Record<string, unknown>>([[1, ADMIN], [2, MEMBER], [3, DISPATCHER_ADMIN_ACCESS], [4, BANNED_ADMIN], [5, REVOKED_ADMIN]]);
    h.userQueue = [];
    h.platformSettings = {};
    h.banned = new Set([4]);
    h.banThrows = false;
    h.importImpl = null;
});

interface Reply { status: number; body: unknown }

function post(path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
    const body = opts.body ?? '';
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path, method: 'POST', agent: false,
            // same-origin satisfies the CSRF gate that runs ahead of both routes.
            headers: { 'sec-fetch-site': 'same-origin', 'content-length': String(Buffer.byteLength(body)), ...opts.headers },
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let parsed: unknown = data;
                try { parsed = JSON.parse(data); } catch { /* NDJSON stream or empty */ }
                resolve({ status: res.statusCode ?? 0, body: parsed });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

/** Declare a huge body and send none of it. A gate ahead of the parser answers at once; a parser
 *  ahead of the gate would sit waiting for 60 MB that never comes, and the test times out. */
function postHeadersOnly(path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path, method: 'POST', agent: false,
            headers: { 'sec-fetch-site': 'same-origin', 'content-length': String(60 * 1024 * 1024), ...headers },
        }, (res) => { res.resume(); resolve(res.statusCode ?? 0); req.destroy(); });
        req.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'ECONNRESET') reject(e); });
        req.flushHeaders();
    });
}

const IMPORT = '/api/admin/import-stream';
const UPLOAD = '/api/org/upload?for=branding';

describe('POST /api/admin/import-stream — the full caller ladder runs BEFORE the 64 MB parser', () => {
    it('no credential → 401, parser never reached', async () => {
        expect((await post(IMPORT, { headers: GZIP, body: 'x' })).status).toBe(401);
    });

    it('a forged signature → 401, parser never reached', async () => {
        const forged = signToken({ userId: 1 }).replace(/.$/, (c) => (c === '0' ? '1' : '0'));
        expect((await post(IMPORT, { headers: { authorization: `Bearer ${forged}`, ...GZIP }, body: 'x' })).status).toBe(401);
    });

    it('a valid Member session → 403 before the parser (the signature alone used to buy the parse)', async () => {
        const r = await post(IMPORT, { headers: { ...bearer(2), ...GZIP }, body: 'x' });
        expect(r.status).toBe(403);
        expect(h.importCalls).toBe(0);
    });

    it('admin:access without the system Admin identity → 403 before the parser', async () => {
        expect((await post(IMPORT, { headers: { ...bearer(3), ...GZIP }, body: 'x' })).status).toBe(403);
    });

    it('a BANNED system Admin → 403 before the parser', async () => {
        expect((await post(IMPORT, { headers: { ...bearer(4), ...GZIP }, body: 'x' })).status).toBe(403);
    });

    it('a ban read fault → retryable 503 before the parser (fails closed, never into a ban screen)', async () => {
        h.banThrows = true;
        expect((await post(IMPORT, { headers: { ...bearer(1), ...GZIP }, body: 'x' })).status).toBe(503);
    });

    it('a session revoked by the per-user watermark → 401 before the parser', async () => {
        expect((await post(IMPORT, { headers: { ...bearer(5), ...GZIP }, body: 'x' })).status).toBe(401);
    });

    it('a FORCE-LOGGED-OUT session → 401 with force_logout, before the parser', async () => {
        h.platformSettings = { force_logout_timestamp: '2999-01-01T00:00:00.000Z' };
        const r = await post(IMPORT, { headers: { ...bearer(1), ...GZIP }, body: 'x' });
        expect(r.status).toBe(401);
        expect(r.body).toMatchObject({ force_logout: true });
    });

    it('a Member declaring a 60 MB body is refused without the server waiting for it', async () => {
        expect(await postHeadersOnly(IMPORT, bearer(2))).toBe(403);
    }, 10_000);

    it('the genuine system Admin passes the gate and reaches the parser (415 on gzip)', async () => {
        expect((await post(IMPORT, { headers: { ...bearer(1), ...GZIP }, body: 'x' })).status).toBe(415);
    });

    it('the genuine system Admin can import', async () => {
        const r = await post(IMPORT, { headers: bearer(1), body: NDJSON });
        expect(r.status).toBe(200);
        expect(h.importCalls).toBeGreaterThan(0);
    });

    it('the handler still runs its OWN admin gate (defence in depth) and frees the slot when it refuses', async () => {
        // Admin at the pre-auth, demoted by the time the handler re-reads the user.
        h.userQueue = [ADMIN, MEMBER];
        const before = h.importCalls;
        expect((await post(IMPORT, { headers: bearer(1), body: NDJSON })).status).toBe(403);
        expect(h.importCalls).toBe(before);
        // The in-handler refusal released the single-flight slot.
        expect((await post(IMPORT, { headers: bearer(1), body: NDJSON })).status).toBe(200);
    });
});

describe('POST /api/admin/import-stream — one org import at a time', () => {
    it('a concurrent import gets 409 — decided before its body is parsed — and the slot frees when the first finishes', async () => {
        let started!: () => void;
        let finish!: () => void;
        const startedP = new Promise<void>((r) => { started = r; });
        const gate = new Promise<void>((r) => { finish = r; });
        h.importImpl = async () => { started(); await gate; return { reanchoredAdminUserId: null }; };

        const first = post(IMPORT, { headers: bearer(1), body: NDJSON });
        await startedP;
        const callsWhileRunning = h.importCalls;

        const second = await post(IMPORT, { headers: bearer(1), body: NDJSON });
        expect(second.status).toBe(409);
        // gzip: a 409 rather than the parser's 415 proves the busy check precedes the parse.
        expect((await post(IMPORT, { headers: { ...bearer(1), ...GZIP }, body: 'x' })).status).toBe(409);
        expect(h.importCalls).toBe(callsWhileRunning);

        // A non-Admin is refused on identity, and learns nothing about the running import.
        expect((await post(IMPORT, { headers: bearer(2), body: NDJSON })).status).toBe(403);

        finish();
        expect((await first).status).toBe(200);
        h.importImpl = null;
        expect((await post(IMPORT, { headers: bearer(1), body: NDJSON })).status).toBe(200);
    });

    it('a client that DISCONNECTS mid-import does not free the slot while the import is still writing', async () => {
        // importOrgData keeps running after the browser goes away. Freeing the slot on that
        // 'close' would let a second wholesale rewrite start on top of the first.
        let started!: () => void;
        let finish!: () => void;
        const startedP = new Promise<void>((r) => { started = r; });
        const gate = new Promise<void>((r) => { finish = r; });
        let importDone = false;
        h.importImpl = async () => { started(); await gate; importDone = true; return { reanchoredAdminUserId: null }; };

        const req = http.request({
            host: '127.0.0.1', port, path: IMPORT, method: 'POST', agent: false,
            headers: { 'sec-fetch-site': 'same-origin', 'content-length': String(Buffer.byteLength(NDJSON)), ...bearer(1) },
        });
        req.on('error', () => { /* we destroy it on purpose */ });
        req.end(NDJSON);
        await startedP;
        req.destroy();
        // Let the server observe the disconnect before probing.
        await new Promise((r) => setTimeout(r, 100));

        expect((await post(IMPORT, { headers: bearer(1), body: NDJSON })).status).toBe(409);

        h.importImpl = null;
        finish();
        await vi.waitFor(() => expect(importDone).toBe(true));
        await vi.waitFor(async () => {
            expect((await post(IMPORT, { headers: bearer(1), body: NDJSON })).status).toBe(200);
        }, { timeout: 3000, interval: 100 });
    });

    it('a parser refusal (never reaching the handler) frees the slot', async () => {
        expect((await post(IMPORT, { headers: { ...bearer(1), ...GZIP }, body: 'x' })).status).toBe(415);
        expect((await post(IMPORT, { headers: bearer(1), body: NDJSON })).status).toBe(200);
    });

    it('an empty-body refusal inside the handler frees the slot', async () => {
        expect((await post(IMPORT, { headers: bearer(1), body: '' })).status).toBe(400);
        expect((await post(IMPORT, { headers: bearer(1), body: NDJSON })).status).toBe(200);
    });

    it('a failed import frees the slot', async () => {
        h.importImpl = async () => { throw new Error('import blew up'); };
        const failed = await post(IMPORT, { headers: bearer(1), body: NDJSON });
        expect(failed.status).toBe(200);
        // One NDJSON line, so it parses as a single event.
        expect(failed.body).toMatchObject({ type: 'error', message: 'import blew up' });
        h.importImpl = null;
        expect((await post(IMPORT, { headers: bearer(1), body: NDJSON })).status).toBe(200);
    });

    it('an upload ABORTED mid-body frees the slot', async () => {
        const checksBefore = h.banChecks;
        const req = http.request({
            host: '127.0.0.1', port, path: IMPORT, method: 'POST', agent: false,
            headers: { 'sec-fetch-site': 'same-origin', 'content-length': '100000', ...bearer(1) },
        });
        req.on('error', () => { /* we destroy it on purpose */ });
        req.write('{"type":"meta"');
        // Wait until the pre-auth has run its last gate (the ban check precedes the slot grab).
        await vi.waitFor(() => expect(h.banChecks).toBeGreaterThan(checksBefore));
        await new Promise((r) => setImmediate(r));
        // While the stalled upload holds the slot, a second import is busy…
        expect((await post(IMPORT, { headers: bearer(1), body: NDJSON })).status).toBe(409);
        req.destroy();
        // …and once it is abandoned, the slot comes back.
        await vi.waitFor(async () => {
            expect((await post(IMPORT, { headers: bearer(1), body: NDJSON })).status).toBe(200);
        }, { timeout: 3000, interval: 100 });
    });
});

describe('POST /api/org/upload — a valid session is required BEFORE the raw parser', () => {
    const PNG = { 'content-type': 'image/png' };

    it('no credential → 401, parser never reached', async () => {
        const r = await post(UPLOAD, { headers: { ...PNG, ...GZIP }, body: 'x' });
        expect(r.status).toBe(401);
        expect(r.body).toEqual({ message: 'Unauthorized' });
    });

    it('a forged signature → 401, parser never reached', async () => {
        expect((await post(UPLOAD, { headers: { ...PNG, ...GZIP, authorization: 'Bearer eyJ1c2VySWQiOjF9.deadbeef' }, body: 'x' })).status).toBe(401);
    });

    it('an EXPIRED (correctly signed) token → 401, parser never reached', async () => {
        expect((await post(UPLOAD, { headers: { ...PNG, ...GZIP, authorization: `Bearer ${expiredToken(1)}` }, body: 'x' })).status).toBe(401);
    });

    it('an anonymous caller declaring a large body is refused without the server waiting for it', async () => {
        expect(await postHeadersOnly(UPLOAD, PNG)).toBe(401);
    }, 10_000);

    it('a valid session passes through to the parser (415 on gzip) — the full gates stay in the handler', async () => {
        expect((await post(UPLOAD, { headers: { ...PNG, ...GZIP, ...bearer(2) }, body: 'x' })).status).toBe(415);
    });
});
