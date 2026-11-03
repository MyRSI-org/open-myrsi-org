import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

// The HTTP-edge helpers: the terminal error handler, client-IP resolution (the key
// every IP-scoped control shares), the CSRF origin predicate, and the session /
// OAuth-state cookie codecs. Pins the denial/fail-closed branches and the exact
// wire shapes.

const h = vi.hoisted(() => ({ logged: [] as Array<{ level: string; msg: string; fields?: Record<string, unknown> }> }));

vi.mock('../lib/log', () => {
    const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => { h.logged.push({ level, msg, fields }); };
    const child = { error: rec('error'), warn: rec('warn'), info: rec('info'), debug: rec('debug') };
    return { log: { ...child, child: () => child } };
});

import { terminalErrorHandler } from '../lib/terminalErrorHandler';
import { getClientIp } from '../lib/clientIp';
import { checkRequestOrigin, allowedOriginsFor } from '../lib/csrfOrigin';
import {
    resolveCookieSecure, buildSessionCookie, clearSessionCookie, readSessionCookie,
    credentialFromRequest, appendSetCookie, isValidSessionTokenShape, sessionCookieName,
} from '../lib/sessionCookie';
import {
    OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_SECURE, isValidNonceShape, buildOAuthStateCookie,
    clearOAuthStateCookie, readOAuthStateCookie, nonceMatches,
} from '../lib/oauthStateCookie';

const TOKEN = `${'A'.repeat(20)}+/=${'b'.repeat(20)}.${'0123456789abcdef'.repeat(4)}`;

// ---------------------------------------------------------------------------
// terminalErrorHandler
// ---------------------------------------------------------------------------

interface FakeRes {
    headersSent: boolean;
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
    destroyed: boolean;
    setHeader(k: string, v: string): void;
    status(c: number): FakeRes;
    json(b: unknown): FakeRes;
    destroy(): void;
}

function fakeRes(headersSent = false): FakeRes {
    return {
        headersSent,
        statusCode: 200,
        headers: {},
        body: undefined,
        destroyed: false,
        setHeader(k, v) {
            // Node throws ERR_HTTP_HEADERS_SENT here; the handler must never get this far.
            if (this.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
            this.headers[k.toLowerCase()] = v;
        },
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
        destroy() { this.destroyed = true; },
    };
}

const fakeReq = (over: Partial<Request> = {}) => ({
    originalUrl: '/api/services?x=1', method: 'POST', headers: {}, ip: '198.51.100.7', ...over,
}) as unknown as Request;

const next = (() => { throw new Error('next must never be called'); }) as unknown as NextFunction;

function run(err: unknown, res = fakeRes(), req = fakeReq()) {
    terminalErrorHandler(err, req, res as unknown as Response, next);
    return res;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('terminalErrorHandler', () => {
    beforeEach(() => { h.logged = []; delete process.env.TRUST_CF_PROXY; });

    it('is a 4-arity function, so Express registers it as an ERROR handler', () => {
        expect(terminalErrorHandler.length).toBe(4);
    });

    it('destroys the socket (never setHeader/end) when headers are already sent', () => {
        const res = run(new Error('mid-stream failure'), fakeRes(true));
        expect(res.destroyed).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.body).toBeUndefined();
        expect(h.logged).toEqual([{
            level: 'error', msg: 'request error after headers were sent',
            fields: { path: '/api/services?x=1', method: 'POST', err: expect.any(Error) },
        }]);
    });

    it('answers an over-cap body with an uncached 413 and logs the resolved client IP', () => {
        const res = run(Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 }));
        expect(res.statusCode).toBe(413);
        expect(res.body).toEqual({ message: 'That upload is too large.' });
        expect(res.headers['cache-control']).toBe('no-store');
        expect(h.logged[0]).toMatchObject({ level: 'warn', msg: 'request body over cap', fields: { ip: '198.51.100.7', method: 'POST' } });
    });

    it('answers a malformed body with an uncached 400 and does not echo the parser message', () => {
        const res = run(Object.assign(new SyntaxError('Unexpected token } in JSON at position 7'), { type: 'entity.parse.failed', status: 400 }));
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ message: 'Malformed request body.' });
        expect(res.headers['cache-control']).toBe('no-store');
        expect(JSON.stringify(res.body)).not.toContain('Unexpected token');
    });

    it.each(['encoding.unsupported', 'charset.unsupported'])('answers %s with a 415, logged at warn (a client mistake, not a fault)', (type) => {
        const res = run(Object.assign(new Error('unsupported content encoding "gzip"'), { type, status: 415 }));
        expect(res.statusCode).toBe(415);
        expect(res.body).toEqual({ message: 'Unsupported request body encoding.' });
        expect(res.headers['cache-control']).toBe('no-store');
        expect(h.logged).toHaveLength(1);
        expect(h.logged[0]).toMatchObject({ level: 'warn', msg: 'request body encoding refused', fields: { type, ip: '198.51.100.7' } });
    });

    it('anything else: an opaque 500 with a requestId that matches the server-side log line', () => {
        const err = new Error('ENOENT: no such file, open /srv/app/secrets/.env (relation "public.users")');
        const res = run(err);
        expect(res.statusCode).toBe(500);
        const body = res.body as { message: string; requestId: string };
        expect(body.message).toBe('An internal server error occurred.');
        expect(body.requestId).toMatch(UUID_RE);
        expect(JSON.stringify(body)).not.toMatch(/ENOENT|\/srv|public\.users/);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(h.logged).toEqual([{
            level: 'error', msg: 'unhandled request error',
            fields: { requestId: body.requestId, path: '/api/services?x=1', method: 'POST', err },
        }]);
    });

    it('issues a fresh requestId per error', () => {
        const a = (run(new Error('a')).body as { requestId: string }).requestId;
        const b = (run(new Error('b')).body as { requestId: string }).requestId;
        expect(a).not.toBe(b);
    });

    it('keeps an error-range status (status, then statusCode) and clamps anything else to 500', () => {
        expect(run({ status: 404 }).statusCode).toBe(404);
        expect(run({ statusCode: 503 }).statusCode).toBe(503);
        expect(run({ status: 418, statusCode: 502 }).statusCode).toBe(418);
        expect(run({ status: 302 }).statusCode).toBe(500);
        expect(run({ status: 200 }).statusCode).toBe(500);
        expect(run({ status: 600 }).statusCode).toBe(500);
        expect(run({ statusCode: 399 }).statusCode).toBe(500);
    });

    it('survives a null / primitive error value', () => {
        expect(run(null).statusCode).toBe(500);
        expect(run(undefined).statusCode).toBe(500);
        expect(run('string error').statusCode).toBe(500);
    });

    it('end to end under Express: a thrown route error becomes the opaque JSON 500', async () => {
        const app = express();
        app.get('/boom', () => { throw new Error('SELECT * FROM users -- internal detail'); });
        app.use(terminalErrorHandler);
        const server = app.listen(0);
        try {
            const port = (server.address() as { port: number }).port;
            const res = await fetch(`http://127.0.0.1:${port}/boom`);
            expect(res.status).toBe(500);
            expect(res.headers.get('cache-control')).toBe('no-store');
            expect(res.headers.get('content-type')).toMatch(/application\/json/);
            const body = await res.json() as { message: string; requestId: string };
            expect(body.message).toBe('An internal server error occurred.');
            expect(body.requestId).toMatch(UUID_RE);
            expect(JSON.stringify(body)).not.toContain('SELECT');
        } finally {
            server.close();
        }
    });
});

// ---------------------------------------------------------------------------
// getClientIp
// ---------------------------------------------------------------------------

describe('getClientIp', () => {
    let saved: string | undefined;
    beforeEach(() => { saved = process.env.TRUST_CF_PROXY; delete process.env.TRUST_CF_PROXY; });
    afterEach(() => { if (saved === undefined) delete process.env.TRUST_CF_PROXY; else process.env.TRUST_CF_PROXY = saved; });

    const req = (headers: Record<string, unknown>, ip?: string) => ({ headers, ip }) as unknown as Request;

    it('IGNORES a spoofable CF-Connecting-IP unless the operator opted in', () => {
        expect(getClientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '203.0.113.5'))).toBe('203.0.113.5');
        process.env.TRUST_CF_PROXY = 'true'; // only the exact '1' opts in
        expect(getClientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '203.0.113.5'))).toBe('203.0.113.5');
    });

    it('honours CF-Connecting-IP with TRUST_CF_PROXY=1', () => {
        process.env.TRUST_CF_PROXY = '1';
        expect(getClientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '203.0.113.5'))).toBe('1.2.3.4');
    });

    it('falls back to req.ip when the trusted header is empty or repeated (array)', () => {
        process.env.TRUST_CF_PROXY = '1';
        expect(getClientIp(req({ 'cf-connecting-ip': '' }, '203.0.113.5'))).toBe('203.0.113.5');
        expect(getClientIp(req({ 'cf-connecting-ip': ['1.2.3.4', '5.6.7.8'] }, '203.0.113.5'))).toBe('203.0.113.5');
        expect(getClientIp(req({}, '203.0.113.5'))).toBe('203.0.113.5');
    });

    it('never hand-parses X-Forwarded-For (that is trust proxy\'s job via req.ip)', () => {
        expect(getClientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.5' }, '10.0.0.1'))).toBe('10.0.0.1');
    });

    it('returns "unknown" when nothing identifies the caller', () => {
        expect(getClientIp(req({}, undefined))).toBe('unknown');
        process.env.TRUST_CF_PROXY = '1';
        expect(getClientIp(req({}, ''))).toBe('unknown');
    });
});

// ---------------------------------------------------------------------------
// CSRF origin predicate
// ---------------------------------------------------------------------------

describe('checkRequestOrigin', () => {
    const ours = ['https://org.example'];
    const check = (method: string, origin: string | null | undefined, secFetchSite: string | null | undefined) =>
        checkRequestOrigin({ method, origin, secFetchSite, allowedOrigins: ours });

    it('treats a missing method as GET (read fail-open only with no signals)', () => {
        expect(check('', null, null)).toBe('allow');
        expect(check('', 'https://evil.example', null)).toBe('deny');
    });

    it('normalises method and Sec-Fetch-Site case', () => {
        expect(check('post', null, null)).toBe('deny');
        expect(check('head', null, null)).toBe('allow');
        expect(check('POST', null, 'SAME-ORIGIN')).toBe('allow');
        expect(check('POST', null, 'Cross-Site')).toBe('deny');
    });

    it('Sec-Fetch-Site decides even when Origin disagrees', () => {
        expect(check('POST', 'https://evil.example', 'same-origin')).toBe('allow');
        expect(check('GET', 'https://org.example', 'cross-site')).toBe('deny');
        expect(check('GET', 'https://org.example', 'same-site')).toBe('deny');
    });

    it('an unknown Sec-Fetch-Site value is denied, not ignored', () => {
        expect(check('GET', 'https://org.example', 'weird')).toBe('deny');
    });

    it('an empty Sec-Fetch-Site / Origin counts as absent', () => {
        expect(check('GET', '', '')).toBe('allow');
        expect(check('DELETE', '', '')).toBe('deny');
        expect(check('PATCH', 'https://org.example', '')).toBe('allow');
    });

    it('a write with an exact allowed Origin passes; a prefix/suffix look-alike does not', () => {
        expect(check('PUT', 'https://org.example', undefined)).toBe('allow');
        expect(check('PUT', 'https://org.example.evil.example', undefined)).toBe('deny');
        expect(check('PUT', 'https://org.example:8443', undefined)).toBe('deny');
        expect(check('GET', 'null', undefined)).toBe('deny');
    });
});

describe('allowedOriginsFor', () => {
    it('lists the request scheme first, then the other scheme, for the same host', () => {
        expect(allowedOriginsFor('org.example', true)).toEqual(['https://org.example', 'http://org.example']);
        expect(allowedOriginsFor('lan.box:3000', false)).toEqual(['http://lan.box:3000', 'https://lan.box:3000']);
    });

    it('adds the configured public origin (normalised to its origin)', () => {
        expect(allowedOriginsFor('internal:3000', false, 'https://Public.Example/app/path?x=1'))
            .toEqual(['http://internal:3000', 'https://internal:3000', 'https://public.example']);
    });

    it('ignores a missing host and an unparseable/empty APP_URL', () => {
        expect(allowedOriginsFor(undefined, true, 'https://public.example')).toEqual(['https://public.example']);
        expect(allowedOriginsFor('', true, 'not a url')).toEqual([]);
        expect(allowedOriginsFor(null, false, '')).toEqual([]);
        expect(allowedOriginsFor(null, false, null)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

describe('session cookie codec', () => {
    it('resolveCookieSecure: explicit override (both spellings) beats APP_URL; default is HTTPS-iff-https APP_URL', () => {
        expect(resolveCookieSecure({ SESSION_COOKIE_SECURE: 'true', APP_URL: 'http://lan' })).toBe(true);
        expect(resolveCookieSecure({ SESSION_COOKIE_SECURE: 'false', APP_URL: 'https://org.example' })).toBe(false);
        expect(resolveCookieSecure({ SESSION_COOKIE_SECURE: 'yes', APP_URL: 'https://org.example' })).toBe(true);
        expect(resolveCookieSecure({ SESSION_COOKIE_SECURE: 'yes' })).toBe(false);
        expect(resolveCookieSecure()).toBe(false);
    });

    it('token shape: exact base64 body + 64 lowercase hex, length-bounded', () => {
        expect(isValidSessionTokenShape(TOKEN)).toBe(true);
        expect(isValidSessionTokenShape(`${'a'.repeat(15)}.${'0'.repeat(64)}`)).toBe(false);
        expect(isValidSessionTokenShape(`${'a'.repeat(4097)}.${'0'.repeat(64)}`)).toBe(false);
        expect(isValidSessionTokenShape(`${'a'.repeat(20)}.${'A'.repeat(64)}`)).toBe(false);
        expect(isValidSessionTokenShape(`${'a'.repeat(20)};Path=/.${'0'.repeat(64)}`)).toBe(false);
        expect(isValidSessionTokenShape(123)).toBe(false);
    });

    it('Max-Age is floored and never negative', () => {
        expect(buildSessionCookie(TOKEN, false, 86_399.9)).toContain('Max-Age=86399');
        expect(buildSessionCookie(TOKEN, false, -5)).toContain('Max-Age=0');
        expect(buildSessionCookie(TOKEN, true, 10)).toBe(`__Host-myrsi_session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=10; Secure`);
    });

    it('clear cookie names the same mode and expires immediately', () => {
        expect(clearSessionCookie(true)).toBe('__Host-myrsi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
        expect(clearSessionCookie(false)).toBe('myrsi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    });

    it('reads past attribute-only segments and other cookies, and takes only the first matching name', () => {
        const name = sessionCookieName(false);
        expect(readSessionCookie(`flag; theme=dark; ${name}=${TOKEN}`, false)).toBe(TOKEN);
        expect(readSessionCookie(`${name}=garbage; ${name}=${TOKEN}`, false)).toBeNull();
        expect(readSessionCookie(`x${name}=${TOKEN}`, false)).toBeNull();
        expect(readSessionCookie(undefined, false)).toBeNull();
        expect(readSessionCookie(42 as unknown as string, false)).toBeNull();
        expect(readSessionCookie('theme=dark', true)).toBeNull();
    });

    it('credentialFromRequest takes the header only in "<scheme> <token>" form', () => {
        expect(credentialFromRequest('Bearer tok', null, false)).toBe('tok');
        expect(credentialFromRequest('Bearer', null, false)).toBeNull();
        expect(credentialFromRequest('Bearer ', null, false)).toBeNull();
        expect(credentialFromRequest('Bearer a b', null, false)).toBeNull();
        expect(credentialFromRequest(undefined, undefined, true)).toBeNull();
        // a malformed cookie does not block the header path
        expect(credentialFromRequest('Bearer tok', '__Host-myrsi_session=bad', true)).toBe('tok');
    });

    it('credentialFromRequest prefers a valid cookie of the resolved mode over the header', () => {
        expect(credentialFromRequest('Bearer header-tok', `__Host-myrsi_session=${TOKEN}`, true)).toBe(TOKEN);
        // the plain name is NOT the credential on a secure deployment
        expect(credentialFromRequest('Bearer header-tok', `myrsi_session=${TOKEN}`, true)).toBe('header-tok');
    });
});

describe('appendSetCookie fallbacks', () => {
    function headerRes(initial: unknown) {
        const headers: Record<string, unknown> = {};
        if (initial !== undefined) headers['Set-Cookie'] = initial;
        return {
            headers,
            res: { getHeader: (k: string) => headers[k], setHeader: (k: string, v: unknown) => { headers[k] = v; } },
        };
    }

    it('uses append() when present and never touches setHeader', () => {
        const appended: Array<[string, string]> = [];
        const setHeader = vi.fn();
        appendSetCookie({ append: (k: string, v: string) => { appended.push([k, v]); }, setHeader, getHeader: () => 'old=1' }, 'z=9');
        expect(appended).toEqual([['Set-Cookie', 'z=9']]);
        expect(setHeader).not.toHaveBeenCalled();
    });

    it('appends to an existing ARRAY of cookies without losing any', () => {
        const { headers, res } = headerRes(['a=1', 'b=2']);
        appendSetCookie(res, 'c=3');
        expect(headers['Set-Cookie']).toEqual(['a=1', 'b=2', 'c=3']);
    });

    it('sets the single value when there is none yet (undefined or null)', () => {
        const u = headerRes(undefined);
        appendSetCookie(u.res, 'c=3');
        expect(u.headers['Set-Cookie']).toBe('c=3');
        const n = headerRes(null);
        appendSetCookie(n.res, 'c=3');
        expect(n.headers['Set-Cookie']).toBe('c=3');
    });

    it('works with a setHeader-only response (no getHeader)', () => {
        const set: Array<[string, unknown]> = [];
        appendSetCookie({ setHeader: (k: string, v: unknown) => { set.push([k, v]); } }, 'd=4');
        expect(set).toEqual([['Set-Cookie', 'd=4']]);
    });

    it('swallows a throwing setHeader (the denial it rides on must survive)', () => {
        expect(() => appendSetCookie({ getHeader: () => 'a=1', setHeader: () => { throw new Error('sent'); } }, 'e=5')).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// OAuth state cookie
// ---------------------------------------------------------------------------

describe('OAuth state cookie codec', () => {
    const NONCE = '3f2b8c1e-7d4a-4f6b-9a0c-1e2d3c4b5a69';

    it('nonce shape: uuid-like only, so a value cannot smuggle cookie attributes', () => {
        expect(isValidNonceShape(NONCE)).toBe(true);
        expect(isValidNonceShape('short')).toBe(false);
        expect(isValidNonceShape(`${'a'.repeat(20)}; Domain=evil.example`)).toBe(false);
        expect(isValidNonceShape('a'.repeat(129))).toBe(false);
        expect(isValidNonceShape(null)).toBe(false);
    });

    it('builds the cookie with the __Host- name and Secure only in secure mode', () => {
        expect(buildOAuthStateCookie(NONCE, true)).toBe(`${OAUTH_STATE_COOKIE_SECURE}=${NONCE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure`);
        expect(buildOAuthStateCookie(NONCE, false)).toBe(`${OAUTH_STATE_COOKIE}=${NONCE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
    });

    it('clears the cookie for both modes', () => {
        expect(clearOAuthStateCookie(true)).toBe('__Host-oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
        expect(clearOAuthStateCookie(false)).toBe('oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    });

    it('reads past attribute-only segments; an empty value reads as null', () => {
        expect(readOAuthStateCookie(`flag; oauth_state=${NONCE}`)).toBe(NONCE);
        expect(readOAuthStateCookie('oauth_state=  ; other=1')).toBeNull();
        expect(readOAuthStateCookie('other=1')).toBeNull();
        expect(readOAuthStateCookie(null)).toBeNull();
        expect(readOAuthStateCookie(7 as unknown as string)).toBeNull();
    });

    it('on HTTPS reads ONLY the __Host- cookie, never a plain one planted by a sibling', () => {
        expect(readOAuthStateCookie(`oauth_state=${NONCE}`, true)).toBeNull();
        expect(readOAuthStateCookie(`oauth_state=planted; __Host-oauth_state=${NONCE}`, true)).toBe(NONCE);
    });

    it('nonceMatches: equal only for identical non-empty values', () => {
        expect(nonceMatches(NONCE, NONCE)).toBe(true);
        expect(nonceMatches(NONCE, NONCE.toUpperCase())).toBe(false);
        expect(nonceMatches(NONCE, NONCE.slice(0, -1))).toBe(false);
        expect(nonceMatches('', '')).toBe(false);
        expect(nonceMatches(null, NONCE)).toBe(false);
        expect(nonceMatches(NONCE, undefined)).toBe(false);
    });
});
