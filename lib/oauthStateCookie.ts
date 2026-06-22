// Server-side half of the Discord OAuth login-CSRF defense (HANDOFF s3-3a).
//
// The client half (lib/oauthState.ts isValidOAuthState) binds the round-trip in
// sessionStorage — but an XSS foothold can read/write sessionStorage, so it is
// not a sufficient boundary on its own. This adds a SERVER-observed binding: the
// server mints an HttpOnly nonce cookie at `auth:begin_oauth` and refuses to
// exchange the code at `auth:discord_callback` unless the state nonce echoed back
// matches that cookie (constant-time). HttpOnly keeps the cookie out of JS, so an
// XSS that forges the sessionStorage half still can't satisfy the server check.

import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

// On HTTPS use the `__Host-` prefix: the browser then requires Secure, Path=/ and no
// Domain, so another site on a sibling subdomain (or the network) can't overwrite
// this CSRF cookie. The prefix needs Secure, which plain-HTTP dev can't set, so dev
// falls back to the plain name.
export const OAUTH_STATE_COOKIE = 'oauth_state';
export const OAUTH_STATE_COOKIE_SECURE = '__Host-oauth_state';
function oauthCookieName(secure: boolean): string {
    return secure ? OAUTH_STATE_COOKIE_SECURE : OAUTH_STATE_COOKIE;
}
// Short-lived — the redirect to Discord and back is seconds, not minutes.
const MAX_AGE_SECONDS = 600;

// A nonce is the client's crypto.randomUUID(); accept only that shape so a
// crafted value can't smuggle cookie attributes via the Set-Cookie string.
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidNonceShape(nonce: unknown): nonce is string {
    return typeof nonce === 'string' && NONCE_RE.test(nonce);
}

/** Build the Set-Cookie header value that stores the OAuth state nonce.
 *  SameSite=Lax is safe: the cookie is set and read by same-origin XHRs (it just
 *  has to survive the top-level redirect to Discord and back, which it does as a
 *  first-party cookie). Secure is set when the request arrived over HTTPS. */
export function buildOAuthStateCookie(nonce: string, secure: boolean): string {
    const parts = [
        `${oauthCookieName(secure)}=${nonce}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${MAX_AGE_SECONDS}`,
    ];
    if (secure) parts.push('Secure'); // required by the __Host- prefix
    return parts.join('; ');
}

/** Build the Set-Cookie header value that clears the OAuth state cookie. */
export function clearOAuthStateCookie(secure: boolean): string {
    const parts = [`${oauthCookieName(secure)}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

/** Read the OAuth state nonce from the Cookie header, or null. On HTTPS only the
 *  __Host- prefixed cookie is accepted, so a plain `oauth_state` set by another site
 *  isn't read back. */
export function readOAuthStateCookie(cookieHeader: string | undefined | null, secure = false): string | null {
    if (!cookieHeader || typeof cookieHeader !== 'string') return null;
    const wanted = oauthCookieName(secure);
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const name = part.slice(0, eq).trim();
        if (name === wanted) {
            return part.slice(eq + 1).trim() || null;
        }
    }
    return null;
}

/** Constant-time equality for two nonces. False if either is missing/mismatched. */
export function nonceMatches(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}
