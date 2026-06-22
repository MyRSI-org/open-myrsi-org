import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';

// Session-token hardening (HANDOFF s3-7): verifyToken validates the decoded JSON
// shape after the HMAC check and returns a NORMALISED { userId, exp } — it never
// trusts extra payload fields, and the token no longer carries roleId.

const SECRET = 'test-secret-fixed-1234567890abcdef';
vi.hoisted(() => { process.env.JWT_SECRET = 'test-secret-fixed-1234567890abcdef'; });

import { signToken, verifyToken, tokenIssuedAt, verifyAdminSetupGrant, verifyIdentityGrant } from '../lib/auth';

// Forge a token with an arbitrary payload but a VALID signature (we know the key).
function forge(payload: unknown): string {
    const enc = Buffer.from(JSON.stringify(payload)).toString('base64');
    const sig = createHmac('sha256', SECRET).update(enc).digest('hex');
    return `${enc}.${sig}`;
}
const future = Date.now() + 60_000;

describe('verifyToken', () => {
    it('round-trips a signed token to a normalised { userId, exp } (no roleId)', () => {
        const out = verifyToken(signToken({ userId: 5 }))!;
        expect(out.userId).toBe(5);
        expect(typeof out.exp).toBe('number');
        expect((out as unknown as Record<string, unknown>).roleId).toBeUndefined();
    });
    it('drops any extra payload fields even when validly signed', () => {
        const out = verifyToken(forge({ userId: 9, exp: future, roleId: 99, isAdmin: true }))!;
        expect(out).toEqual({ userId: 9, exp: future });
    });
    it('rejects a non-numeric exp (would make the expiry check a no-op)', () => {
        expect(verifyToken(forge({ userId: 1, exp: 'not-a-number' }))).toBeNull();
    });
    it('rejects a non-numeric userId', () => {
        expect(verifyToken(forge({ userId: 'x', exp: future }))).toBeNull();
    });
    it('rejects a token carrying a non-session purpose', () => {
        expect(verifyToken(forge({ userId: 1, exp: future, purpose: 'admin_setup' }))).toBeNull();
    });
    it('rejects a tampered signature', () => {
        const t = signToken({ userId: 1 });
        expect(verifyToken(t.slice(0, -2) + (t.endsWith('aa') ? 'bb' : 'aa'))).toBeNull();
    });
    it('rejects a malformed token', () => {
        expect(verifyToken('garbage')).toBeNull();
        expect(verifyToken(undefined)).toBeNull();
    });
});

// The grant verifiers should check exp is a number like verifyToken does, so a
// signature-valid token with a non-number exp can't end up never expiring.
describe('grant verifiers numeric-exp guard', () => {
    it('verifyAdminSetupGrant accepts a valid numeric-exp grant but rejects a non-numeric exp', () => {
        expect(verifyAdminSetupGrant(forge({ purpose: 'admin_setup', discordId: '123', exp: future }))).toEqual({ discordId: '123' });
        expect(verifyAdminSetupGrant(forge({ purpose: 'admin_setup', discordId: '123', exp: 'never' }))).toBeNull();
        expect(verifyAdminSetupGrant(forge({ purpose: 'admin_setup', discordId: '123' }))).toBeNull(); // exp missing
    });
    it('verifyIdentityGrant accepts a valid numeric-exp grant but rejects a non-numeric exp', () => {
        expect(verifyIdentityGrant(forge({ purpose: 'signup_identity', discordId: '123', exp: future }))).toEqual({ discordId: '123' });
        expect(verifyIdentityGrant(forge({ purpose: 'signup_identity', discordId: '123', exp: 'never' }))).toBeNull();
        expect(verifyIdentityGrant(forge({ purpose: 'signup_identity', discordId: '123' }))).toBeNull(); // exp missing
    });
    it('verifyIdentityGrant carries the server-issued verification code (vc)', () => {
        expect(verifyIdentityGrant(forge({ purpose: 'signup_identity', discordId: '123', vc: 'MYRSI-abc', exp: future })))
            .toEqual({ discordId: '123', vc: 'MYRSI-abc' });
    });
});

// A stolen token is bounded by a FIXED 24h lifetime; revocation comparisons use an
// explicit iat (with a conservative fallback for pre-change tokens).
describe('token issued-at + lifetime', () => {
    it('signToken stamps an explicit iat and a 24h exp', () => {
        const before = Date.now();
        const t = verifyToken(signToken({ userId: 5 }))!;
        expect(typeof t.iat).toBe('number');
        expect(t.iat!).toBeGreaterThanOrEqual(before - 1000);
        expect(t.iat!).toBeLessThanOrEqual(Date.now() + 1000);
        expect(t.exp - t.iat!).toBe(24 * 60 * 60 * 1000);
    });
    it('tokenIssuedAt uses the explicit iat when present', () => {
        const iat = 1_700_000_000_000;
        const t = verifyToken(forge({ userId: 5, iat, exp: future }))!;
        expect(tokenIssuedAt(t).getTime()).toBe(iat);
    });
    it('tokenIssuedAt falls back to exp minus the legacy 7-day lifetime for old tokens (no iat)', () => {
        const exp = future;
        const t = verifyToken(forge({ userId: 5, exp }))!;
        expect(tokenIssuedAt(t).getTime()).toBe(exp - 7 * 24 * 60 * 60 * 1000);
    });
    it('rejects a non-numeric iat', () => {
        expect(verifyToken(forge({ userId: 5, iat: 'soon', exp: future }))).toBeNull();
    });
});
