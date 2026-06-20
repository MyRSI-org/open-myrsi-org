import { describe, it, expect } from 'vitest';
import { isValidOAuthState, oauthStateForServer } from '../lib/oauthState';

// The OAuth callback CSRF decision must fail closed. This pins the extracted pure
// predicate so a SessionContext refactor cannot silently reintroduce the old
// fail-open `if (rawState)` gate.

describe('isValidOAuthState (M10 fail-closed OAuth CSRF)', () => {
    it('rejects a missing state (the session-fixation vector: /?code=ATTACKER with state stripped)', () => {
        expect(isValidOAuthState(null, 'nonce-123')).toBe(false);
        expect(isValidOAuthState(undefined, 'nonce-123')).toBe(false);
        expect(isValidOAuthState('', 'nonce-123')).toBe(false);
    });
    it('rejects when no nonce was stored', () => {
        expect(isValidOAuthState('login:nonce-123', null)).toBe(false);
        expect(isValidOAuthState('login:nonce-123', '')).toBe(false);
    });
    it('rejects a mismatched nonce', () => {
        expect(isValidOAuthState('login:WRONG', 'nonce-123')).toBe(false);
        expect(isValidOAuthState('admin_setup:key:WRONG', 'nonce-123')).toBe(false);
    });
    it('accepts a matching login nonce (last segment)', () => {
        expect(isValidOAuthState('login:nonce-123', 'nonce-123')).toBe(true);
    });
    it('accepts a matching admin_setup nonce regardless of the key segment', () => {
        expect(isValidOAuthState('admin_setup:CLAIMKEY:nonce-123', 'nonce-123')).toBe(true);
        expect(isValidOAuthState('admin_setup::nonce-123', 'nonce-123')).toBe(true);
    });
});

// Pins the client/server state contract: the callback must forward the raw state
// so the server can recover the nonce it matches against its HttpOnly cookie. A
// client-side reshape (the removed nonce-strip) dropped that nonce and 403'd every
// login attempt. serverNonce/serverClaimKey mirror the server-side derivations so a future
// reshape on either side fails here. Prevents regression essentially. 
// Kudos to witherfork for the fix applied in Contexts > SessionContext.tsx
const serverNonce = (state: string | null) => (state ? state.split(':').pop() || null : null); // api/services.ts
const serverClaimKey = (state: string | null) =>
    state && state.startsWith('admin_setup:') ? state.split(':')[1] : null;                     // api/actions/auth.ts

describe('oauthStateForServer (client/server state contract)', () => {
    const NONCE = 'nonce-123';

    it('forwards a login state so the server still recovers the nonce', () => {
        const sent = oauthStateForServer(`login:${NONCE}`);
        expect(serverNonce(sent)).toBe(NONCE);
        expect(serverClaimKey(sent)).toBeNull();
    });

    it('forwards an admin_setup state so the server recovers both nonce and claim key', () => {
        const sent = oauthStateForServer(`admin_setup:SETUP-x:${NONCE}`);
        expect(serverNonce(sent)).toBe(NONCE);
        expect(serverClaimKey(sent)).toBe('SETUP-x');
    });

    it('keeps the nonce on a keyless admin_setup state (empty key → server skips the claim)', () => {
        const sent = oauthStateForServer(`admin_setup::${NONCE}`);
        expect(serverNonce(sent)).toBe(NONCE);
        expect(serverClaimKey(sent)).toBe('');
    });

    it('passes a missing state through as null so the server fails closed', () => {
        expect(oauthStateForServer(null)).toBeNull();
        expect(oauthStateForServer(undefined)).toBeNull();
    });

    it('regression: the old strip dropped the nonce the cookie binding needs', () => {
        // The removed code sent `null` for a login and `admin_setup:<key>` for a
        // claim — both lose the last-segment nonce, so the server's cookie match
        // fails. Contrast with the verbatim forward, which preserves it.
        expect(serverNonce(null)).toBeNull();                       // old login send
        expect(serverNonce('admin_setup:SETUP-x')).toBe('SETUP-x'); // old claim send → key, not nonce
        expect(serverNonce(oauthStateForServer(`login:${NONCE}`))).toBe(NONCE);
    });
});
