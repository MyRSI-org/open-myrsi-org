// Fail-closed decision for the Discord OAuth callback CSRF nonce check.
// Extracted as a pure, isolated function so it is unit-testable and a future
// SessionContext refactor cannot silently reintroduce a fail-open
// `if (rawState) { ...check... }` gate (which would let an attacker strip
// `state` and complete a login-CSRF / session-fixation against a victim).
//
// A legitimate login always carries `state` = `login:<nonce>` (or
// `admin_setup:<key>:<nonce>`); the unguessable nonce (crypto.randomUUID,
// stored in sessionStorage before redirect) is the LAST `:`-segment. The code
// may only be exchanged when that nonce is present and matches what we stored.

/**
 * True only if the OAuth callback `state` carries a nonce that matches the
 * one stored before redirect. Returns false (→ abort, do NOT exchange the
 * code) when state is absent, the stored nonce is missing, or they mismatch.
 */
export function isValidOAuthState(rawState: string | null | undefined, storedNonce: string | null | undefined): boolean {
    if (!rawState || !storedNonce) return false;
    const receivedNonce = rawState.split(':').pop();
    return !!receivedNonce && receivedNonce === storedNonce;
}

/**
 * The `state` value the callback forwards to the server — the raw callback state,
 * unchanged. The server derives BOTH halves it needs out of this one string: the
 * CSRF nonce (last `:`-segment, matched against its HttpOnly cookie in
 * api/services.ts) and the admin claim key (segment [1], in api/actions/auth.ts).
 * The client must therefore hand it over verbatim; reshaping it on the way out
 * drops the nonce and desyncs the two halves, which fails the cookie binding and
 * 403s the login attempt. Kept as a named, tested unit so that reshape can't creep back.
 * Kudos to witherfork for the fix, applied in Contexts > SessionContext.tsx.
 */
export function oauthStateForServer(rawState: string | null | undefined): string | null {
    return rawState ?? null;
}
