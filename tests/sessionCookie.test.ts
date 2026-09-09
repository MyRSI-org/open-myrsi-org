import { describe, it, expect } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    SESSION_COOKIE, SESSION_COOKIE_SECURE, sessionCookieName, resolveCookieSecure,
    isValidSessionTokenShape, buildSessionCookie, clearSessionCookie, readSessionCookie,
    credentialFromRequest, appendSetCookie,
} from '../lib/sessionCookie';
import { checkRequestOrigin, allowedOriginsFor } from '../lib/csrfOrigin';
import { checkUserRateLimit, pruneUserRateLimitBuckets, __resetUserRateLimitForTest, USER_PER_MINUTE } from '../lib/userRateLimit';

// The session token lived in localStorage, so any scripting foothold lifted a live 24-hour
// session. Moving it to an HttpOnly cookie closes that, but a cookie is attached by the browser
// to every request to this origin whoever caused it — so the cookie path also needs a CSRF
// control. Neither half is sufficient alone.

const TOKEN = `${'a'.repeat(40)}.${'0'.repeat(64)}`;

describe('cookie naming and mode', () => {
    // The __Host- prefix makes the browser refuse the cookie unless it is Secure, Path=/ and
    // has no Domain — so a sibling subdomain cannot overwrite the session cookie. It REQUIRES
    // Secure, which a plain-HTTP LAN deployment cannot set, hence the fallback name.
    it('uses the __Host- prefix only when secure', () => {
        expect(sessionCookieName(true)).toBe(SESSION_COOKIE_SECURE);
        expect(sessionCookieName(false)).toBe(SESSION_COOKIE);
        expect(SESSION_COOKIE_SECURE.startsWith('__Host-')).toBe(true);
    });

    it('derives the mode from APP_URL, with an explicit override winning', () => {
        expect(resolveCookieSecure({ APP_URL: 'https://org.example' })).toBe(true);
        expect(resolveCookieSecure({ APP_URL: 'http://192.168.1.10:3000' })).toBe(false);
        expect(resolveCookieSecure({})).toBe(false);
        // The override exists for TLS terminating upstream, where the app itself sees http.
        expect(resolveCookieSecure({ APP_URL: 'http://internal:3000', SESSION_COOKIE_SECURE: '1' })).toBe(true);
        // ...and for a LAN deployment that must NOT get Secure, because a Secure cookie on
        // plain HTTP is silently never stored — i.e. nobody can log in, with no error anywhere.
        expect(resolveCookieSecure({ APP_URL: 'https://org.example', SESSION_COOKIE_SECURE: '0' })).toBe(false);
    });
});

describe('cookie construction', () => {
    it('is HttpOnly, Lax and Path=/, with Secure only in secure mode', () => {
        const secure = buildSessionCookie(TOKEN, true, 86400);
        expect(secure).toContain('HttpOnly');
        expect(secure).toContain('SameSite=Lax');
        expect(secure).toContain('Path=/');
        expect(secure).toContain('Secure');
        expect(secure).toContain('Max-Age=86400');
        expect(secure.startsWith(`${SESSION_COOKIE_SECURE}=${TOKEN};`)).toBe(true);

        const plain = buildSessionCookie(TOKEN, false, 86400);
        expect(plain).not.toContain('Secure');
        expect(plain.startsWith(`${SESSION_COOKIE}=${TOKEN};`)).toBe(true);
    });

    // SameSite=Strict would drop the cookie on the top-level return from Discord's OAuth
    // redirect, landing the user back on the app logged out.
    it('is not SameSite=Strict', () => {
        expect(buildSessionCookie(TOKEN, true, 86400)).not.toContain('SameSite=Strict');
    });

    it('clears with Max-Age=0 and matching attributes', () => {
        expect(clearSessionCookie(true)).toContain('Max-Age=0');
        expect(clearSessionCookie(true)).toContain('Secure');
        expect(clearSessionCookie(false)).not.toContain('Secure');
    });

    it('the token shape survives a cookie value unchanged', () => {
        // base64's +, / and = are all inside RFC 6265's cookie-octet ranges, so the token needs
        // no re-encoding. Do NOT "fix" this to base64url — it would reject every issued token.
        expect(isValidSessionTokenShape(`ab+c/de=${'f'.repeat(20)}.${'0'.repeat(64)}`)).toBe(true);
        expect(isValidSessionTokenShape('not-a-token')).toBe(false);
        expect(isValidSessionTokenShape(`${'a'.repeat(40)}.SHORT`)).toBe(false);
        expect(isValidSessionTokenShape(null)).toBe(false);
    });
});

describe('reading the cookie', () => {
    it('reads only the name matching the mode', () => {
        expect(readSessionCookie(`${SESSION_COOKIE_SECURE}=${TOKEN}`, true)).toBe(TOKEN);
        expect(readSessionCookie(`${SESSION_COOKIE}=${TOKEN}`, false)).toBe(TOKEN);
    });

    // THE ONE THAT MATTERS. A sibling subdomain cannot set a __Host- cookie, but it CAN set a
    // plain `myrsi_session` one. If an HTTPS deployment read the plain name too, that planted
    // value would be accepted as a credential.
    it('IGNORES the plain cookie name on a secure deployment', () => {
        expect(readSessionCookie(`${SESSION_COOKIE}=${TOKEN}`, true)).toBeNull();
    });

    it('discards a malformed value rather than passing it to the verifier', () => {
        expect(readSessionCookie(`${SESSION_COOKIE_SECURE}=garbage`, true)).toBeNull();
        expect(readSessionCookie('', true)).toBeNull();
        expect(readSessionCookie(undefined, true)).toBeNull();
    });

    it('finds the cookie among others', () => {
        const header = `other=1; ${SESSION_COOKIE_SECURE}=${TOKEN}; another=2`;
        expect(readSessionCookie(header, true)).toBe(TOKEN);
    });
});

describe('credentialFromRequest — dual accept', () => {
    it('prefers the cookie', () => {
        const other = `${'b'.repeat(40)}.${'1'.repeat(64)}`;
        expect(credentialFromRequest(`Bearer ${other}`, `${SESSION_COOKIE_SECURE}=${TOKEN}`, true)).toBe(TOKEN);
    });

    // A hard cutover would log out every live session on deploy, and on a deployment where
    // Secure resolved wrongly it would log them out permanently with no error.
    it('still accepts the Authorization header when there is no cookie', () => {
        expect(credentialFromRequest(`Bearer ${TOKEN}`, undefined, true)).toBe(TOKEN);
    });

    it('is null when neither carrier has one', () => {
        expect(credentialFromRequest(undefined, undefined, true)).toBeNull();
        expect(credentialFromRequest('Bearer', undefined, true)).toBeNull();
        expect(credentialFromRequest('', '', true)).toBeNull();
    });
});

describe('CSRF origin check', () => {
    const allowed = ['https://org.example'];
    const base = { allowedOrigins: allowed };

    it('trusts Sec-Fetch-Site above Origin', () => {
        expect(checkRequestOrigin({ ...base, method: 'POST', origin: 'https://evil.example', secFetchSite: 'same-origin' })).toBe('allow');
        expect(checkRequestOrigin({ ...base, method: 'POST', origin: 'https://org.example', secFetchSite: 'cross-site' })).toBe('deny');
    });

    it('allows a direct navigation (Sec-Fetch-Site: none)', () => {
        expect(checkRequestOrigin({ ...base, method: 'GET', origin: null, secFetchSite: 'none' })).toBe('allow');
    });

    // Single-hostname deployment: a same-site-but-different-host request has no legitimate source.
    it('denies same-site as well as cross-site', () => {
        expect(checkRequestOrigin({ ...base, method: 'POST', origin: null, secFetchSite: 'same-site' })).toBe('deny');
    });

    it('falls back to Origin when Sec-Fetch-Site is absent', () => {
        expect(checkRequestOrigin({ ...base, method: 'POST', origin: 'https://org.example', secFetchSite: null })).toBe('allow');
        expect(checkRequestOrigin({ ...base, method: 'POST', origin: 'https://evil.example', secFetchSite: null })).toBe('deny');
    });

    // A sandboxed iframe sends the literal string 'null'. Treating it as absent would let it
    // fall through to the read fail-open.
    it('denies the literal "null" origin', () => {
        expect(checkRequestOrigin({ ...base, method: 'GET', origin: 'null', secFetchSite: null })).toBe('deny');
    });

    // THE DELIBERATE ASYMMETRY. Requiring Sec-Fetch-Site on a GET locks out Safari below 16.4
    // entirely — every read 403s with no way for the user to tell why. A forged cross-site GET
    // still cannot read the response, and this API has no state change behind a GET.
    it('fails OPEN on a read and CLOSED on a write when both signals are absent', () => {
        expect(checkRequestOrigin({ ...base, method: 'GET', origin: null, secFetchSite: null })).toBe('allow');
        expect(checkRequestOrigin({ ...base, method: 'HEAD', origin: null, secFetchSite: null })).toBe('allow');
        expect(checkRequestOrigin({ ...base, method: 'POST', origin: null, secFetchSite: null })).toBe('deny');
        expect(checkRequestOrigin({ ...base, method: 'DELETE', origin: null, secFetchSite: null })).toBe('deny');
    });

    it('derives our own origins from the request host, both schemes', () => {
        const origins = allowedOriginsFor('org.example', true, 'https://configured.example');
        expect(origins).toContain('https://org.example');
        // A proxy may terminate TLS and forward the same Host over plain HTTP; 403-ing a whole
        // deployment over a header the operator does not control is not an acceptable failure.
        expect(origins).toContain('http://org.example');
        expect(origins).toContain('https://configured.example');
    });
});

describe('per-identity throttle', () => {

    it('allows up to the per-minute cap and then refuses with a retry hint', () => {
        __resetUserRateLimitForTest();
        const NOW = 1_000_000;
        for (let i = 0; i < USER_PER_MINUTE; i++) {
            expect(checkUserRateLimit(7, NOW).ok).toBe(true);
        }
        const over = checkUserRateLimit(7, NOW);
        expect(over.ok).toBe(false);
        expect(over.retryAfter).toBeGreaterThan(0);
    });

    it('is per identity, not global', () => {
        __resetUserRateLimitForTest();
        const NOW = 1_000_000;
        for (let i = 0; i < USER_PER_MINUTE; i++) checkUserRateLimit(7, NOW);
        expect(checkUserRateLimit(7, NOW).ok).toBe(false);
        expect(checkUserRateLimit(8, NOW).ok).toBe(true);
    });

    it('resets after the minute window', () => {
        __resetUserRateLimitForTest();
        const NOW = 1_000_000;
        for (let i = 0; i < USER_PER_MINUTE; i++) checkUserRateLimit(7, NOW);
        expect(checkUserRateLimit(7, NOW).ok).toBe(false);
        expect(checkUserRateLimit(7, NOW + 61_000).ok).toBe(true);
    });

    it('prunes, so the map cannot grow until the shed-on-full branch disables it', () => {
        __resetUserRateLimitForTest();
        const NOW = 1_000_000;
        checkUserRateLimit(7, NOW);
        pruneUserRateLimitBuckets(NOW + 25 * 60 * 60 * 1000);
        // Pruned, so this is a fresh bucket rather than a continuation.
        expect(checkUserRateLimit(7, NOW + 25 * 60 * 60 * 1000).ok).toBe(true);
    });
});

describe('wiring — a predicate nothing calls is not a control', () => {
    const src = readFileSync(join(resolve(__dirname, '..'), 'server.ts'), 'utf8');

    it('mounts the CSRF gate on the four browser paths, and NOT on /api as a whole', () => {
        expect(src).toContain("const CSRF_GUARDED_PATHS = ['/api/services', '/api/query', '/api/admin/import-stream', '/api/org/upload']");
        expect(src).toContain('checkRequestOrigin({');
        // Federation is server-to-server on x-api-key: a peer has no Origin header, and seven of
        // those routes are POSTs, so guarding /api wholesale would hard-403 pairing and
        // mirror-push while GET routes kept working — a partial break, harder to diagnose.
        //
        // Matched as a PATTERN, not a literal containing '\n'. server.ts is 100% CRLF, so any
        // assertion whose needle carries a bare LF is structurally incapable of failing — it
        // would pass no matter what the file said. Same family as a regex matching its own
        // explanatory comment.
        expect(src).not.toMatch(/app\.use\(\s*['"]\/api['"]\s*,[^)]*checkRequestOrigin/);
    });

    // THE BYPASS THIS GATE MUST NOT HAVE. Express routes with `strict routing` and
    // `case sensitive routing` both DISABLED by default, so `/api/services/` and `/API/services`
    // reach the same handler. An exact-string `req.path === …` check misses both, and
    // SameSite=Lax does not cover the gap: a page on a sibling origin can POST to
    // `https://org.example/api/services/`, the browser attaches the session cookie, and the
    // mutation runs as the victim. Mounting with app.use() applies Express's own normalisation.
    it('matches the guarded paths the way the ROUTER does, not by exact string', () => {
        expect(src).toContain('for (const guardedPath of CSRF_GUARDED_PATHS) app.use(guardedPath, csrfOriginGate)');
        expect(src).not.toMatch(/CSRF_GUARDED_PATHS\.includes\(\s*req\.path\s*\)/);
    });

    // Body parsing runs before the dispatcher's auth, so the cap must be chosen in the parser
    // middleware. A gate placed after the parser would be reading a body already buffered.
    it('runs the CSRF gate BEFORE the body parsers', () => {
        const csrfAt = src.indexOf('const CSRF_GUARDED_PATHS');
        const parserAt = src.indexOf('app.use(bodyLimitChooser(');
        expect(csrfAt).toBeGreaterThan(-1);
        expect(parserAt).toBeGreaterThan(csrfAt);
    });

    it('splits the body cap and exempts the two streaming surfaces on BOTH parsers', () => {
        expect(src).toContain("const ANON_BODY_LIMIT = '128kb'");
        expect(src).toContain("const AUTHED_BODY_LIMIT = '10mb'");
        expect(src).toContain('app.use(bodyLimitChooser((limit) => express.json({ limit })))');
        expect(src).toContain('app.use(bodyLimitChooser((limit) => express.urlencoded({ extended: true, limit })))');
        // One chooser feeds both parsers, so the two caps cannot drift.
        const chooser = src.slice(src.indexOf('function bodyLimitChooser'));
        expect(chooser.slice(0, 1400)).toContain("req.path === '/api/admin/import-stream'");
        expect(chooser.slice(0, 1400)).toContain("req.path.startsWith('/api/alliance/')");
        // GET/HEAD short-circuit, so a static asset hit does not pay for a token verify.
        expect(chooser.slice(0, 1400)).toContain("req.method === 'GET' || req.method === 'HEAD'");
    });

    // Exported and tested but never called in production, so their maps only grew; once full,
    // the shed-on-full branch permits every untracked key and the throttle quietly stops working.
    it('wires every rate-limit prune into the periodic sweep', () => {
        for (const prune of [
            'pruneAuthRateLimitBuckets(now)',
            'pruneOrgUploadBuckets(now)',
            'pruneAiRateLimitBuckets(now)',
            'pruneSubmissionRateLimitBuckets(now)',
            'pruneRadioRateLimitBuckets(now)',
            'pruneUserRateLimitBuckets(now)',
        ]) {
            expect(src, `${prune} must be in the sweep`).toContain(prune);
        }
    });
});

// RUNTIME tests, not source-text ones. Every wiring assertion above reads server.ts as a string,
// and a string assertion cannot tell you that the middleware it found actually behaves. The
// alliance body-parser break below is the archetype: the source-text pin asserting the chooser
// MENTIONS '/api/alliance/' passed happily while `req.body` was undefined on every federation
// POST. These exercise the real Express matching and parser selection.
describe('runtime — Express matching and parser selection', () => {
    // Rebuilt here rather than importing server.ts, which opens a listener, registers cron jobs
    // and needs a database. The SHAPE is what is under test: the same mount strategy and the
    // same chooser branches.
    async function call(app: express.Express, method: string, path: string, body?: string, headers: Record<string, string> = {}) {
        const server = app.listen(0);
        try {
            const port = (server.address() as { port: number }).port;
            const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                method,
                headers: { 'Content-Type': 'application/json', ...headers },
                body,
            });
            return { status: res.status, json: await res.json().catch(() => null) as Record<string, unknown> | null };
        } finally {
            server.close();
        }
    }

    function buildApp() {
        const app = express();
        const gate: express.RequestHandler = (req, res, next) => {
            const verdict = checkRequestOrigin({
                method: req.method,
                origin: req.headers['origin'] as string | undefined,
                secFetchSite: req.headers['sec-fetch-site'] as string | undefined,
                allowedOrigins: ['http://localhost'],
            });
            if (verdict === 'deny') { res.status(403).json({ blocked: true }); return; }
            next();
        };
        for (const p of ['/api/services', '/api/query', '/api/admin/import-stream', '/api/org/upload']) app.use(p, gate);

        const chooser = (parserFor: (limit: string) => express.RequestHandler): express.RequestHandler => {
            const anon = parserFor('128kb');
            const authed = parserFor('10mb');
            return (req, res, next) => {
                if (req.method === 'GET' || req.method === 'HEAD') return next();
                if (req.path === '/api/admin/import-stream') return next();
                if (req.path.startsWith('/api/alliance/')) return authed(req, res, next);
                return (req.headers['x-fake-auth'] === '1' ? authed : anon)(req, res, next);
            };
        };
        app.use(chooser((limit) => express.json({ limit })));
        app.all(/(.*)/, (req, res) => {
            res.json({ bodyType: typeof req.body, keys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : null });
        });
        return app;
    }

    // BLOCKER: the two global parsers are the ONLY JSON parser in the app. `return next()` for
    // alliance skipped both, leaving req.body undefined — /pair then 403s as "forbidden",
    // op-mirror/push 500s, and rsvp writes undefined fields. Five of seven POST routes dead.
    it('a federation POST still arrives with a PARSED body', async () => {
        const r = await call(buildApp(), 'POST', '/api/alliance/pair', JSON.stringify({ fromBaseUrl: 'https://peer.example' }));
        expect(r.status).toBe(200);
        expect(r.json?.bodyType).toBe('object');
        expect(r.json?.keys).toEqual(['fromBaseUrl']);
    });

    it('import-stream reaches its own parser unparsed', async () => {
        const r = await call(buildApp(), 'POST', '/api/admin/import-stream', '{"a":1}', { 'sec-fetch-site': 'same-origin' });
        expect(r.json?.bodyType).toBe('undefined');
    });

    it('an ordinary dispatch is parsed', async () => {
        const r = await call(buildApp(), 'POST', '/api/services', JSON.stringify({ action: 'x' }), { 'sec-fetch-site': 'same-origin' });
        expect(r.json?.keys).toEqual(['action']);
    });

    // BLOCKER: `strict routing` and `case sensitive routing` are both DISABLED by default, so
    // these all reach the same handler while an exact-string match misses them.
    it.each([
        ['/api/services', 'exact'],
        ['/api/services/', 'trailing slash'],
        ['/API/services', 'uppercase'],
        ['/api/Services', 'mixed case'],
    ])('blocks a cross-site POST to %s (%s)', async (path) => {
        const r = await call(buildApp(), 'POST', path, JSON.stringify({ action: 'x' }), { 'sec-fetch-site': 'cross-site' });
        expect(r.status).toBe(403);
        expect(r.json?.blocked).toBe(true);
    });

    it('lets a same-origin POST through on every one of those forms', async () => {
        for (const path of ['/api/services', '/api/services/', '/API/services']) {
            const r = await call(buildApp(), 'POST', path, JSON.stringify({ action: 'x' }), { 'sec-fetch-site': 'same-origin' });
            expect(r.status, path).toBe(200);
        }
    });

    // Federation must never be subject to the origin gate: a peer sends no Origin header, and
    // seven of its routes are POSTs — which fail CLOSED when both signals are absent.
    it('does NOT apply the origin gate to federation', async () => {
        const r = await call(buildApp(), 'POST', '/api/alliance/op-mirror/push', JSON.stringify({ x: 1 }));
        expect(r.status).toBe(200);
    });
});

describe('wiring — the dispatcher accepts and issues the cookie', () => {
    const src = readFileSync(join(resolve(__dirname, '..'), 'api', 'services.ts'), 'utf8');

    it('reads the credential from either carrier', () => {
        expect(src).toContain("credentialFromRequest(req.headers['authorization'], req.headers['cookie'], SESSION_COOKIE_IS_SECURE)");
    });

    it('mints the cookie on login and clears it on logout', () => {
        expect(src).toContain('buildSessionCookie(issued, SESSION_COOKIE_IS_SECURE');
        expect(src).toContain("if (action === 'user:logout')");
        expect(src).toContain('clearSessionCookie(SESSION_COOKIE_IS_SECURE)');
        // Through the guarded helper, never a bare res.append — see the structural-guard test.
        expect(src).toContain('appendSetCookie(res,');
        expect(src).not.toContain("res.append('Set-Cookie'");
    });

    // The logout clear must run BEFORE dispatch, not in the success branch. The client can only
    // remove its localStorage copy, never the HttpOnly cookie — so a failing user:logout
    // (offline, or revokeUserSessions throwing) would show a logout, land the user on `/`, and
    // leave a live 24-hour cookie that signs them straight back in on the next page load.
    it('clears the cookie on logout even when the handler throws', () => {
        const clearAt = src.indexOf("if (action === 'user:logout')");
        const dispatchAt = src.indexOf('const result = await actions[action](payload, token ?? undefined);', clearAt - 2000);
        expect(clearAt).toBeGreaterThan(-1);
        // The clear sits above the try/dispatch, not inside its success path.
        expect(src.slice(clearAt, clearAt + 400)).toContain('appendSetCookie');
        expect(clearAt).toBeLessThan(src.indexOf('const result = await actions[action](payload, token ?? undefined);', clearAt));
        expect(dispatchAt).toBeGreaterThan(-1);
    });

    // A revoked cookie left planted for 24 hours is a session someone else can resume. Every
    // force-logout 401 actively removes it.
    it('clears the cookie on every force-logout 401', () => {
        const q = readFileSync(join(resolve(__dirname, '..'), 'api', 'query.ts'), 'utf8');
        for (const [name, body] of [['services', src], ['query', q]] as const) {
            const forceLogouts = body.split('force_logout: true').length - 1;
            const clears = body.split('appendSetCookie(res, clearSessionCookie').length - 1;
            expect(clears, `${name}: every force_logout 401 must clear the cookie`).toBeGreaterThanOrEqual(forceLogouts);
        }
    });

    it('applies the per-identity throttle to authenticated dispatch', () => {
        expect(src).toContain('checkUserRateLimit(user.id)');
    });
});

describe('appendSetCookie — a cookie write must never change the response it rides on', () => {
    // THE FAIL-OPEN THIS EXISTS TO STOP, and it is not hypothetical: several `res` doubles
    // define status/json/setHeader and no `append`, so adding a bare res.append to the
    // force-logout path turned two 401 assertions into 200s. Clearing a cookie is best-effort;
    // losing it is bad, losing the DENIAL is worse.
    it('does not throw when the response has no append()', () => {
        const res: Record<string, unknown> = { statusCode: 0, headers: {} as Record<string, unknown> };
        res.setHeader = (k: string, v: unknown) => { (res.headers as Record<string, unknown>)[k] = v; };
        res.getHeader = (k: string) => (res.headers as Record<string, unknown>)[k];
        expect(() => appendSetCookie(res, 'a=1')).not.toThrow();
        expect((res.headers as Record<string, unknown>)['Set-Cookie']).toBe('a=1');
    });

    it('does not throw when the response has nothing at all', () => {
        expect(() => appendSetCookie({}, 'a=1')).not.toThrow();
        expect(() => appendSetCookie(null, 'a=1')).not.toThrow();
        expect(() => appendSetCookie({ append: () => { throw new Error('boom'); } }, 'a=1')).not.toThrow();
    });

    it('prefers append(), so an existing Set-Cookie is not clobbered', () => {
        const calls: Array<[string, string]> = [];
        appendSetCookie({ append: (k: string, v: string) => { calls.push([k, v]); } }, 'b=2');
        expect(calls).toEqual([['Set-Cookie', 'b=2']]);
    });

    it('accumulates rather than replacing when falling back', () => {
        const headers: Record<string, unknown> = { 'Set-Cookie': 'first=1' };
        appendSetCookie({
            getHeader: (k: string) => headers[k],
            setHeader: (k: string, v: unknown) => { headers[k] = v; },
        }, 'second=2');
        expect(headers['Set-Cookie']).toEqual(['first=1', 'second=2']);
    });
});

describe('wiring — every credential-extraction site moved together', () => {
    // Seven sites read the Authorization header. One left behind would keep working for
    // header sessions and silently 401 every cookie session on that surface only.
    const files = ['api/services.ts', 'api/query.ts', 'api/orgUpload.ts', 'server.ts'];
    it('no surface still parses the Authorization header by hand', () => {
        for (const f of files) {
            const src = readFileSync(join(resolve(__dirname, '..'), f), 'utf8');
            // PATTERN, not a literal. Two of the seven original sites read
            // `(authHeader as string).split(' ')[1]`, which does not contain the literal
            // "authHeader.split(' ')[1]" — so the obvious assertion would have passed with both
            // sites left behind, i.e. it would not have tested the property it names.
            expect(src, `${f} must not hand-parse the header`).not.toMatch(/authHeader[^\n]*\.split\(/);
        }
    });
});

describe('cookie proof comes only from a request that REQUIRED a session', () => {
    // noteCookieAuthWorked DELETES the localStorage token. Inferring it from any 200
    // was the trap this module's own comments describe: several surfaces answer 200 to
    // an anonymous caller (target=config and target=manifest are pre-auth boot
    // payloads, auth:* are PUBLIC_ACTIONS, target=initial-state has an unauthenticated
    // variant). On a deployment where the cookie does not stick — plain HTTP, or a
    // proxy stripping Set-Cookie — the fallback token was thrown away on the strength
    // of a request that proved nothing, and the member re-authenticated every load.
    const api = readFileSync(resolve(__dirname, '..', 'services', 'apiService.ts'), 'utf8');

    it('the inference is gated on a session-required endpoint, not on `response.ok` alone', () => {
        const line = api.split('\n').find(l => l.includes('this.noteCookieAuthWorked()') && l.includes('response.ok'));
        expect(line, 'the cookie-proof inference moved or was removed').toBeTruthy();
        expect(line, 'any 200 still proves the cookie — including anonymous ones').toMatch(/target=state/);
    });

    it('proof still deletes the fallback token — the point of proving it', () => {
        const fn = api.slice(api.indexOf('public noteCookieAuthWorked'), api.indexOf('private logoutRedirectPending'));
        expect(fn).toMatch(/localStorage\.removeItem\('myrsi_auth_token'\)/);
        expect(fn, 'the one-shot guard is what stops it thrashing').toMatch(/if \(this\.cookieProven\) return;/);
    });
});
