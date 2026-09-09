// The session credential as an HttpOnly cookie.
//
// The 24-hour session token lived in localStorage, so any scripting foothold could lift a live
// session and replay it from anywhere. An HttpOnly cookie is unreadable from JavaScript, so the
// same foothold can only act as the user inside the page it already controls.
//
// A cookie brings a CSRF surface the header-only scheme did not have. `SameSite=Lax` alone is
// not sufficient — it still permits top-level GET navigation, and this app's reads are GETs on
// /api/query — so the cookie path is paired with an Origin / Sec-Fetch-Site check
// (lib/csrfOrigin.ts). Neither control is the whole answer; together they are.
//
// DEPENDENCY-FREE ON PURPOSE. It must not import lib/auth.ts: that module reads JWT_SECRET at
// module scope and THROWS in production, which would drag an env-dependent module into every
// unit test here. The token lifetime is passed in by the caller instead. Same shape, and the
// same reason, as lib/oauthStateCookie.ts — which needs no module mocking at all.

/** On HTTPS use the `__Host-` prefix: the browser then requires Secure, Path=/ and no Domain, so
 *  a sibling subdomain (or a network attacker) cannot overwrite the session cookie. The prefix
 *  REQUIRES Secure, which a plain-HTTP LAN deployment cannot set, so it falls back to the plain
 *  name there. */
export const SESSION_COOKIE = 'myrsi_session';
export const SESSION_COOKIE_SECURE = '__Host-myrsi_session';

export function sessionCookieName(secure: boolean): string {
    return secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE;
}

/**
 * Is this deployment serving over HTTPS?
 *
 * Resolved ONCE, at boot, into a process constant — deliberately NOT per request. A per-request
 * decision derived from `X-Forwarded-Proto` can flap between modes on a spoofed header, and a
 * flapping mode would accept an attacker-settable plain-name cookie on an HTTPS origin. One
 * deployment has one scheme.
 *
 * Precedence: explicit env override, then the resolved public origin. `SESSION_COOKIE_SECURE=0`
 * exists because a self-hoster may genuinely run plain HTTP on a LAN, and setting `Secure` there
 * means the browser silently never stores the cookie — i.e. NOBODY CAN LOG IN, with no error
 * anywhere. That silent total login failure is the worst outcome this module can produce, so the
 * default errs toward working and warns loudly rather than erring toward strict and breaking.
 */
export function resolveCookieSecure(env: {
    SESSION_COOKIE_SECURE?: string;
    APP_URL?: string;
} = {}): boolean {
    const override = env.SESSION_COOKIE_SECURE;
    if (override === '1' || override === 'true') return true;
    if (override === '0' || override === 'false') return false;
    const appUrl = env.APP_URL ?? '';
    return appUrl.startsWith('https://');
}

/**
 * THE deployment's cookie mode. Computed once, at module load, and shared by every surface that
 * reads or writes the session cookie — the dispatcher, the read path, the upload endpoint and
 * the import stream — so they cannot disagree about which cookie name is authoritative.
 *
 * `resolveCookieSecure` above stays pure and is what the tests exercise; this constant is only
 * its binding to the running process.
 */
export const SESSION_COOKIE_IS_SECURE = resolveCookieSecure({
    SESSION_COOKIE_SECURE: process.env.SESSION_COOKIE_SECURE,
    APP_URL: process.env.APP_URL,
});

/**
 * Shape guard for a value read out of a Cookie header.
 *
 * The session token is `base64(JSON) + '.' + sha256hex` (lib/auth.ts). Standard base64's `+`,
 * `/` and `=` are all inside RFC 6265's cookie-octet ranges, so the token needs no re-encoding —
 * do NOT "fix" this to base64url, which would reject every token already issued.
 */
const TOKEN_RE = /^[A-Za-z0-9+/=]{16,4096}\.[0-9a-f]{64}$/;

export function isValidSessionTokenShape(value: unknown): value is string {
    return typeof value === 'string' && TOKEN_RE.test(value);
}

/**
 * Build the Set-Cookie header value carrying the session token.
 *
 * `SameSite=Lax` rather than Strict: Strict would drop the cookie on the top-level return from
 * Discord's OAuth redirect, so a user would land back on the app logged out. Lax keeps that
 * journey working, and the Origin / Sec-Fetch-Site check covers what Lax does not.
 */
export function buildSessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
    const parts = [
        `${sessionCookieName(secure)}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ];
    if (secure) parts.push('Secure'); // required by the __Host- prefix
    return parts.join('; ');
}

/** Build the Set-Cookie header value that clears the session cookie (logout, force-logout). */
export function clearSessionCookie(secure: boolean): string {
    const parts = [`${sessionCookieName(secure)}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

/**
 * Read the session token from a Cookie header, or null.
 *
 * Reads ONLY the name matching the resolved mode. On an HTTPS deployment the plain `myrsi_session`
 * name is ignored entirely, so a cookie planted by a sibling subdomain — which cannot set a
 * `__Host-` cookie — is never accepted as a credential. Values failing the shape guard are
 * discarded rather than passed to the verifier.
 */
export function readSessionCookie(cookieHeader: string | undefined | null, secure: boolean): string | null {
    if (!cookieHeader || typeof cookieHeader !== 'string') return null;
    const wanted = sessionCookieName(secure);
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() !== wanted) continue;
        const value = part.slice(eq + 1).trim();
        return isValidSessionTokenShape(value) ? value : null;
    }
    return null;
}

/**
 * Append a Set-Cookie header without being able to break the response it rides on.
 *
 * `res.append` is the right call in production (it preserves an OAuth-state Set-Cookie already on
 * the response, which `setHeader` would clobber) but this is invoked from DENIAL paths — the
 * force-logout 401s — and a throw there is not a cosmetic failure: it converts the 401 into a
 * 200. That is not hypothetical. It happened: several `res` doubles define `status`/`json`/
 * `setHeader` and no `append`, and the 401 tests went green-to-200 the moment the call was added.
 *
 * Same structural discipline as the dispatcher's audit emitter: clearing a cookie is
 * best-effort, and losing it is bad; losing the denial is worse. Falls back to composing the
 * header by hand, then gives up silently.
 */
export function appendSetCookie(res: unknown, value: string): void {
    const r = res as {
        append?: (name: string, value: string) => unknown;
        getHeader?: (name: string) => unknown;
        setHeader?: (name: string, value: string | string[]) => unknown;
    };
    try {
        if (typeof r?.append === 'function') { r.append('Set-Cookie', value); return; }
        const existing = typeof r?.getHeader === 'function' ? r.getHeader('Set-Cookie') : undefined;
        const next = existing === undefined || existing === null
            ? value
            : (Array.isArray(existing) ? [...existing.map(String), value] : [String(existing), value]);
        r?.setHeader?.('Set-Cookie', next);
    } catch { /* never let a cookie write change the status of the response it rides on */ }
}

/**
 * The credential for a request, from either carrier.
 *
 * DUAL-ACCEPT, cookie preferred. A hard cutover would log out every live session on deploy, and
 * on a deployment where `Secure` resolved wrongly it would log them out permanently with no
 * error message. The header path stays until the localStorage population has drained; removing
 * it is a separate, later change.
 */
export function credentialFromRequest(
    authorizationHeader: string | undefined | null,
    cookieHeader: string | undefined | null,
    secure: boolean,
): string | null {
    const fromCookie = readSessionCookie(cookieHeader, secure);
    if (fromCookie) return fromCookie;
    if (typeof authorizationHeader === 'string') {
        const parts = authorizationHeader.split(' ');
        if (parts.length === 2 && parts[1]) return parts[1];
    }
    return null;
}
