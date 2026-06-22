import { describe, it, expect } from 'vitest';
import {
    OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_SECURE, isValidNonceShape, buildOAuthStateCookie,
    clearOAuthStateCookie, readOAuthStateCookie, nonceMatches,
} from '../lib/oauthStateCookie';

// Server half of the OAuth login-CSRF defense (HANDOFF s3-3a). The dispatcher
// mints buildOAuthStateCookie() at auth:begin_oauth and, at auth:discord_callback,
// reads it back with readOAuthStateCookie() and constant-time-compares the state
// nonce via nonceMatches() — failing closed before the code is exchanged.

describe('isValidNonceShape', () => {
    it('accepts a crypto.randomUUID()', () => {
        expect(isValidNonceShape('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    });
    it('rejects empty / too-short / non-string / attribute-injecting values', () => {
        expect(isValidNonceShape('')).toBe(false);
        expect(isValidNonceShape('short')).toBe(false);
        expect(isValidNonceShape(123 as unknown)).toBe(false);
        expect(isValidNonceShape('abc; Domain=evil.test')).toBe(false);
        expect(isValidNonceShape(null)).toBe(false);
    });
});

describe('buildOAuthStateCookie / clearOAuthStateCookie', () => {
    const nonce = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    it('is HttpOnly + SameSite=Lax + bounded lifetime', () => {
        const c = buildOAuthStateCookie(nonce, false);
        expect(c).toContain(`${OAUTH_STATE_COOKIE}=${nonce}`);
        expect(c).toContain('HttpOnly');
        expect(c).toContain('SameSite=Lax');
        expect(c).toMatch(/Max-Age=\d+/);
        expect(c).not.toContain('Secure'); // http request
    });
    it('adds Secure + uses the __Host- prefix over HTTPS', () => {
        const c = buildOAuthStateCookie(nonce, true);
        expect(c).toContain('Secure');
        expect(c).toContain(`${OAUTH_STATE_COOKIE_SECURE}=${nonce}`);
        expect(c).toContain('Path=/');
        expect(c).not.toContain('Domain='); // __Host- forbids Domain
    });
    it('clear sets Max-Age=0', () => {
        expect(clearOAuthStateCookie(false)).toContain('Max-Age=0');
    });
});

describe('readOAuthStateCookie', () => {
    it('extracts the nonce from a cookie header among others (http dev)', () => {
        expect(readOAuthStateCookie(`foo=bar; ${OAUTH_STATE_COOKIE}=abc123; baz=qux`, false)).toBe('abc123');
    });
    it('reads the __Host- prefixed cookie on HTTPS', () => {
        expect(readOAuthStateCookie(`${OAUTH_STATE_COOKIE_SECURE}=abc123`, true)).toBe('abc123');
    });
    it('on HTTPS, a plain (non-__Host-) oauth_state cookie is NOT honored (anti-fixation)', () => {
        expect(readOAuthStateCookie(`${OAUTH_STATE_COOKIE}=attacker-set`, true)).toBeNull();
    });
    it('returns null when absent / empty', () => {
        expect(readOAuthStateCookie('foo=bar', false)).toBeNull();
        expect(readOAuthStateCookie(undefined, false)).toBeNull();
        expect(readOAuthStateCookie(`${OAUTH_STATE_COOKIE}=`, false)).toBeNull();
    });
});

describe('nonceMatches (constant-time)', () => {
    it('true only for an exact match', () => {
        expect(nonceMatches('abcdef', 'abcdef')).toBe(true);
        expect(nonceMatches('abcdef', 'abcdeF')).toBe(false);
        expect(nonceMatches('abc', 'abcdef')).toBe(false);
        expect(nonceMatches(null, 'abc')).toBe(false);
        expect(nonceMatches('abc', undefined)).toBe(false);
    });
});

describe('begin -> callback round-trip', () => {
    it('the nonce set at begin matches the state nonce at callback', () => {
        const nonce = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
        // begin: cookie minted; client redirects with state=login:<nonce>
        const setCookie = buildOAuthStateCookie(nonce, true);
        // browser replays the cookie on the same-origin callback POST
        const cookieHeader = setCookie.split(';')[0]; // "__Host-oauth_state=<nonce>"
        const cookieNonce = readOAuthStateCookie(cookieHeader, true);
        // server derives the nonce from state's last ':'-segment
        const state = `login:${nonce}`;
        const sentNonce = state.split(':').pop()!;
        expect(nonceMatches(sentNonce, cookieNonce)).toBe(true);
        // a forged state (attacker's code, no/another nonce) fails closed
        expect(nonceMatches('login:attacker'.split(':').pop()!, cookieNonce)).toBe(false);
    });
});
