import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// GET /api/manifest used to pin its query target by MUTATING the request URL
// (`req.url += '&target=manifest'`) and then calling the generic /api/query
// handler. parseurl bails out to url.parse the moment it sees a raw '#', which
// drops everything after it — so `/api/manifest?target=state&subset=hr#` reached
// the router as target='state' (and config / initial-state / feed the same way)
// while riding the manifest route, which sets `Access-Control-Allow-Origin: *`
// and never calls noStore(). Verified against this repo's express 5.2.1; the
// %23-escaped form a browser would send is not the raw byte parseurl scans for,
// so that variant already fell closed to a 404.
//
// The route now calls the EXPORTED handleManifest directly, so the target is
// structurally unforgeable rather than dependent on two URL parsers agreeing.
// These pin both halves: the handler ignores any forged target, and the route
// source can't drift back to the rewrite (or to the multi-tenant CORS grant).

const h = vi.hoisted(() => ({
    decoded: null as any,
    user: null as any,
    calls: { getState: 0, getMainState: 0, getHRState: 0, getWarrantsState: 0 },
}));

// Chainable, awaitable Supabase stub. `data` is a real ROW ARRAY on purpose:
// handleManifest does `(data || []).reduce(...)`, so an object would throw into
// its inner catch and the assertions below would only ever exercise the
// default-manifest fallback.
function sbBuilder() {
    const b: any = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'single', 'maybeSingle']) {
        b[m] = () => b;
    }
    b.then = (done: any) => done({
        data: [{ key: 'brandingConfig', value: { name: 'Test Org' } }],
        error: null,
    });
    return b;
}

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    isSessionForceLoggedOut: () => false,
    isSessionRevokedByWatermark: () => false,
    signRealtimeToken: () => 'rt',
}));
vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    getState: async () => { h.calls.getState++; return {}; },
    getMainState: async () => { h.calls.getMainState++; return { users: [] }; },
    getHRState: async () => { h.calls.getHRState++; return { applicants: [] }; },
    getWarrantsState: async () => { h.calls.getWarrantsState++; return { warrants: [] }; },
}));

import handler, { handleManifest } from '../api/query';

function mockRes() {
    const res: any = { statusCode: 0, body: undefined, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
function mockReq(query: any, token?: string) {
    return { method: 'GET', query, headers: token ? { authorization: `Bearer ${token}` } : {} } as any;
}

// server.ts / api/query.ts are CRLF in the working tree; normalise so the
// multiline route slice below can anchor on '\n});'.
const serverSrc = readFileSync(join(resolve(__dirname, '..'), 'server.ts'), 'utf8').replace(/\r\n/g, '\n');
const querySrc = readFileSync(join(resolve(__dirname, '..'), 'api', 'query.ts'), 'utf8').replace(/\r\n/g, '\n');

beforeEach(() => {
    h.decoded = null; h.user = null;
    h.calls = { getState: 0, getMainState: 0, getHRState: 0, getWarrantsState: 0 };
});

describe('GET /api/manifest — target is structurally unforgeable', () => {
    it('handleManifest ignores a forged target/subset and returns the manifest, touching no aggregator', async () => {
        const res = mockRes();
        await handleManifest(mockReq({ target: 'state', subset: 'hr' }, 'tok'), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.start_url).toBe('/?source=pwa');
        // Proves the settings read really ran (not the inner-catch default manifest).
        expect(res.body.name).toBe('Test Org');
        expect(res.body.icons.length).toBeGreaterThan(0);
        // No state ever crosses this entry point, forged target or not.
        expect(res.body.users).toBeUndefined();
        expect(res.body.applicants).toBeUndefined();
        expect(h.calls).toEqual({ getState: 0, getMainState: 0, getHRState: 0, getWarrantsState: 0 });
    });

    it('sets manifest content-type + edge cache headers and NO Access-Control-Allow-Origin', async () => {
        const res = mockRes();
        await handleManifest(mockReq({ target: 'state', subset: 'hr' }, 'tok'), res);
        expect(res.headers['Content-Type']).toBe('application/manifest+json');
        expect(res.headers['Cache-Control']).toMatch(/s-maxage=60/);
        // Single-org has exactly one origin; the grant is gone and must stay gone.
        expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('the server route calls the sub-handler directly — no URL rewrite, no queryFn, no CORS grant', () => {
        // `req.url =` appears nowhere in server.ts now (assignment only, so the
        // explanatory comment naming `req.url +=` does not trip this).
        expect(serverSrc).not.toMatch(/^\s*req\.url\s*=/m);
        expect(serverSrc).not.toMatch(/app\.options\('\/api\/manifest'/);

        const start = serverSrc.indexOf("app.get('/api/manifest'");
        expect(start).toBeGreaterThan(-1);
        // Slice on '\n});' — the body's own `res.status(500).json({ ... });` is
        // indented, so a bare '});' would truncate the route early.
        const route = serverSrc.slice(start, serverSrc.indexOf('\n});', start));
        expect(route).toMatch(/await handleManifest\(req, res\)/);
        expect(route).not.toMatch(/queryFn/);
        expect(route).not.toMatch(/Access-Control-Allow-Origin/);
    });

    it('api/query.ts exports handleManifest and keeps the target=manifest switch arm', () => {
        expect(querySrc).toMatch(/export async function handleManifest\(req: Request, res: Response\)/);
        // /api/query?target=manifest must keep working — removing the arm would be
        // an unrelated public behaviour change.
        expect(querySrc).toMatch(/case 'manifest': return await handleManifest\(req, res\)/);
    });

    it('negative control: the /api/query read path is unchanged — an unauthenticated state probe still 403s', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'hr' }), res);
        expect(res.statusCode).toBe(403);
        expect(h.calls).toEqual({ getState: 0, getMainState: 0, getHRState: 0, getWarrantsState: 0 });
    });
});
