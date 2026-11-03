import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';

// =============================================================================
// lib/auth.ts — session tokens, purpose-bound grants, realtime JWTs and the
// JWT_SECRET boot guard (tiers from lib/sessionSecretPolicy.ts; the full tier matrix is in
// tests/jwtSecretFloor.test.ts).
//
// The statically imported module is loaded with a fixed, strong JWT_SECRET so
// tokens can be forged with a VALID signature (we know the key) to drive the
// post-HMAC shape checks. The boot-time branches are exercised on fresh module
// registries (vi.resetModules), because they run once, at import.
// =============================================================================

const SECRET = 'cov-auth-fixed-secret-0123456789abcdef0123';
vi.hoisted(() => { process.env.JWT_SECRET = 'cov-auth-fixed-secret-0123456789abcdef0123'; });

import {
    signToken,
    verifyToken,
    tokenIssuedAt,
    isSessionForceLoggedOut,
    isSessionRevokedByWatermark,
    signAdminSetupGrant,
    verifyAdminSetupGrant,
    signIdentityGrant,
    verifyIdentityGrant,
    signRealtimeToken,
    TOKEN_LIFETIME_MS,
} from '../lib/auth';

/** Sign ARBITRARY bytes with the real key, so only the post-signature checks decide. */
function forgeRaw(encodedData: string, key = SECRET): string {
    return `${encodedData}.${createHmac('sha256', key).update(encodedData).digest('hex')}`;
}
function forge(payload: unknown, key = SECRET): string {
    return forgeRaw(Buffer.from(JSON.stringify(payload)).toString('base64'), key);
}
function decode(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[0], 'base64').toString());
}
const T0 = new Date('2026-06-01T00:00:00.000Z').getTime();
const MIN = 60_000;

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('session tokens', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
    });

    it('signs base64(JSON).hex-HMAC carrying only userId + iat + a fixed 24h exp', () => {
        const token = signToken({ userId: 7 });
        const [, sig] = token.split('.');
        expect(sig).toMatch(/^[0-9a-f]{64}$/);
        expect(decode(token)).toEqual({ userId: 7, iat: T0, exp: T0 + TOKEN_LIFETIME_MS });
        expect(TOKEN_LIFETIME_MS).toBe(24 * 60 * 60 * 1000);
    });

    it('is valid up to and including the exp instant, and dead one millisecond after', () => {
        const token = signToken({ userId: 7 });
        vi.setSystemTime(T0 + TOKEN_LIFETIME_MS);
        expect(verifyToken(token)).toEqual({ userId: 7, iat: T0, exp: T0 + TOKEN_LIFETIME_MS });
        vi.setSystemTime(T0 + TOKEN_LIFETIME_MS + 1);
        expect(verifyToken(token)).toBeNull();
    });

    it('a token signed with any other key does not verify', () => {
        expect(verifyToken(forge({ userId: 1, exp: T0 + MIN }, 'some-other-key-entirely-0123456789'))).toBeNull();
    });

    it.each([
        ['empty', ''],
        ['no separator', 'abc'],
        ['three segments (a JWT)', 'a.b.c'],
        ['non-hex signature (decodes to the wrong length)', `${Buffer.from('{}').toString('base64')}.zz`],
        ['truncated signature', signToken({ userId: 1 }).slice(0, -2)],
    ])('rejects a malformed token: %s', (_l, token) => {
        expect(verifyToken(token)).toBeNull();
    });

    it('rejects a same-length tampered signature (constant-time compare path)', () => {
        const t = signToken({ userId: 1 });
        const last = t.at(-1)!;
        expect(verifyToken(t.slice(0, -1) + (last === 'a' ? 'b' : 'a'))).toBeNull();
    });

    it.each([
        ['JSON null', 'null'],
        ['a JSON number', '5'],
        ['a JSON string', '"userId"'],
        ['a JSON array', '[1,2]'],
    ])('rejects a validly signed %s payload', (_l, json) => {
        expect(verifyToken(forgeRaw(Buffer.from(json).toString('base64')))).toBeNull();
    });

    it('rejects validly signed bytes that are not JSON at all (parse failure is caught)', () => {
        expect(verifyToken(forgeRaw(Buffer.from('not json {').toString('base64')))).toBeNull();
    });

    it.each([
        ['admin_setup'],
        ['signup_identity'],
        ['anything'],
    ])('rejects a session-shaped payload carrying purpose=%s', (purpose) => {
        expect(verifyToken(forge({ userId: 1, exp: T0 + MIN, purpose }))).toBeNull();
    });

    it('a real admin-setup or identity grant is never accepted as a session', () => {
        expect(verifyToken(signAdminSetupGrant('123'))).toBeNull();
        expect(verifyToken(signIdentityGrant('123', 'MYRSI-1'))).toBeNull();
    });

    it.each([
        ['missing userId', { exp: T0 + MIN }],
        ['string userId', { userId: '1', exp: T0 + MIN }],
        ['missing exp', { userId: 1 }],
        ['string exp', { userId: 1, exp: String(T0 + MIN) }],
        ['null iat', { userId: 1, exp: T0 + MIN, iat: null }],
        ['string iat', { userId: 1, exp: T0 + MIN, iat: 'now' }],
    ])('rejects a validly signed payload with %s', (_l, payload) => {
        expect(verifyToken(forge(payload))).toBeNull();
    });

    it('normalises the result: extra claims (role, isAdmin) never survive verification', () => {
        expect(verifyToken(forge({ userId: 1, exp: T0 + MIN, iat: T0, role: 'Admin', isAdmin: true }))).toEqual({ userId: 1, exp: T0 + MIN, iat: T0 });
        expect(verifyToken(forge({ userId: 1, exp: T0 + MIN }))).toEqual({ userId: 1, exp: T0 + MIN });
    });

    it('signToken ignores caller-supplied exp/iat (a long-lived token cannot be requested)', () => {
        const token = signToken({ userId: 7, exp: T0 + 365 * 24 * 60 * MIN, iat: 0 } as unknown as { userId: number });
        expect(decode(token)).toMatchObject({ iat: T0, exp: T0 + TOKEN_LIFETIME_MS });
    });
});

// ---------------------------------------------------------------------------
describe('revocation predicates', () => {
    const iat = Date.parse('2026-06-01T12:00:00.000Z');
    const token = { userId: 1, iat, exp: iat + TOKEN_LIFETIME_MS };

    it('tokenIssuedAt uses iat, or exp minus the legacy 7-day life for pre-iat tokens', () => {
        expect(tokenIssuedAt(token).toISOString()).toBe('2026-06-01T12:00:00.000Z');
        expect(tokenIssuedAt({ userId: 1, exp: iat + 7 * 24 * 60 * MIN }).toISOString()).toBe('2026-06-01T12:00:00.000Z');
    });

    it.each([
        ['isSessionForceLoggedOut', isSessionForceLoggedOut],
        ['isSessionRevokedByWatermark', isSessionRevokedByWatermark],
    ])('%s: revoked strictly before the watermark, live at or after it, and inert when unset', (_l, pred) => {
        expect(pred(token, '2026-06-01T12:00:00.001Z')).toBe(true);
        expect(pred(token, '2026-06-01T12:00:00.000Z')).toBe(false);
        expect(pred(token, '2026-06-01T11:59:59.999Z')).toBe(false);
        expect(pred(token, null)).toBe(false);
        expect(pred(token, undefined)).toBe(false);
        expect(pred(token, '')).toBe(false);
    });

    it('a legacy (no-iat) token is judged by its derived issue time', () => {
        const legacy = { userId: 1, exp: iat + 7 * 24 * 60 * MIN };
        expect(isSessionRevokedByWatermark(legacy, '2026-06-01T12:00:01.000Z')).toBe(true);
        expect(isSessionForceLoggedOut(legacy, '2026-06-01T11:00:00.000Z')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe('admin-setup grant', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
    });

    it('is bound to the discord id, purpose-tagged, and lives exactly 15 minutes', () => {
        const grant = signAdminSetupGrant('discord-1');
        expect(decode(grant)).toEqual({ purpose: 'admin_setup', discordId: 'discord-1', exp: T0 + 15 * MIN });
        expect(verifyAdminSetupGrant(grant)).toEqual({ discordId: 'discord-1' });
        vi.setSystemTime(T0 + 15 * MIN);
        expect(verifyAdminSetupGrant(grant)).toEqual({ discordId: 'discord-1' });
        vi.setSystemTime(T0 + 15 * MIN + 1);
        expect(verifyAdminSetupGrant(grant)).toBeNull();
    });

    it.each([
        ['undefined', undefined],
        ['empty', ''],
        ['no separator', 'abc'],
        ['three segments', 'a.b.c'],
    ])('rejects a malformed grant: %s', (_l, token) => {
        expect(verifyAdminSetupGrant(token)).toBeNull();
    });

    it('rejects a truncated signature and a same-length tampered one', () => {
        const g = signAdminSetupGrant('discord-1');
        expect(verifyAdminSetupGrant(g.slice(0, -2))).toBeNull();
        expect(verifyAdminSetupGrant(g.slice(0, -1) + (g.at(-1) === 'a' ? 'b' : 'a'))).toBeNull();
    });

    it('cannot be satisfied by a session token or an identity grant (purpose binding)', () => {
        expect(verifyAdminSetupGrant(signToken({ userId: 1 }))).toBeNull();
        expect(verifyAdminSetupGrant(signIdentityGrant('discord-1', 'MYRSI-1'))).toBeNull();
    });

    it.each([
        ['an empty discordId', { purpose: 'admin_setup', discordId: '', exp: T0 + MIN }],
        ['a numeric discordId', { purpose: 'admin_setup', discordId: 123, exp: T0 + MIN }],
        ['a string exp', { purpose: 'admin_setup', discordId: 'd', exp: 'never' }],
    ])('rejects a validly signed grant with %s', (_l, payload) => {
        expect(verifyAdminSetupGrant(forge(payload))).toBeNull();
    });

    it('rejects validly signed non-JSON bytes', () => {
        expect(verifyAdminSetupGrant(forgeRaw(Buffer.from('}{').toString('base64')))).toBeNull();
    });
});

// ---------------------------------------------------------------------------
describe('signup identity grant', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
    });

    it('carries the server-issued verification code inside the signature and lives 15 minutes', () => {
        const grant = signIdentityGrant('discord-2', 'MYRSI-ABC123');
        expect(decode(grant)).toEqual({ purpose: 'signup_identity', discordId: 'discord-2', vc: 'MYRSI-ABC123', exp: T0 + 15 * MIN });
        expect(verifyIdentityGrant(grant)).toEqual({ discordId: 'discord-2', vc: 'MYRSI-ABC123' });
        vi.setSystemTime(T0 + 15 * MIN + 1);
        expect(verifyIdentityGrant(grant)).toBeNull();
    });

    it('a client cannot swap in its own verification code: editing vc breaks the signature', () => {
        const grant = signIdentityGrant('discord-2', 'MYRSI-ABC123');
        const [, sig] = grant.split('.');
        const edited = Buffer.from(JSON.stringify({ ...decode(grant), vc: 'MY-CHOSEN-VALUE' })).toString('base64');
        expect(verifyIdentityGrant(`${edited}.${sig}`)).toBeNull();
    });

    it('drops a non-string vc rather than passing it through', () => {
        expect(verifyIdentityGrant(forge({ purpose: 'signup_identity', discordId: 'd', vc: 42, exp: T0 + MIN }))).toEqual({ discordId: 'd', vc: undefined });
    });

    it.each([
        ['undefined', undefined],
        ['no separator', 'abc'],
        ['three segments', 'a.b.c'],
    ])('rejects a malformed grant: %s', (_l, token) => {
        expect(verifyIdentityGrant(token)).toBeNull();
    });

    it('rejects a truncated signature and a same-length tampered one', () => {
        const g = signIdentityGrant('discord-2', 'MYRSI-1');
        expect(verifyIdentityGrant(g.slice(0, -2))).toBeNull();
        expect(verifyIdentityGrant(g.slice(0, -1) + (g.at(-1) === 'a' ? 'b' : 'a'))).toBeNull();
    });

    it('cannot be satisfied by a session token or an admin-setup grant (purpose binding)', () => {
        expect(verifyIdentityGrant(signToken({ userId: 1 }))).toBeNull();
        expect(verifyIdentityGrant(signAdminSetupGrant('discord-2'))).toBeNull();
    });

    it.each([
        ['an empty discordId', { purpose: 'signup_identity', discordId: '', exp: T0 + MIN }],
        ['a missing discordId', { purpose: 'signup_identity', exp: T0 + MIN }],
        ['a string exp', { purpose: 'signup_identity', discordId: 'd', exp: 'never' }],
    ])('rejects a validly signed grant with %s', (_l, payload) => {
        expect(verifyIdentityGrant(forge(payload))).toBeNull();
    });

    it('rejects validly signed non-JSON bytes', () => {
        expect(verifyIdentityGrant(forgeRaw(Buffer.from('}{').toString('base64')))).toBeNull();
    });
});

// ---------------------------------------------------------------------------
describe('realtime token (HS256 JWT for Supabase Realtime Authorization)', () => {
    const RT_SECRET = 'supabase-project-jwt-secret-for-tests-0123456789';
    const b64urlDecode = (s: string) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

    it('mints a standards-shaped HS256 JWT signed with SUPABASE_JWT_SECRET, 8h life, authenticated role', () => {
        vi.stubEnv('SUPABASE_JWT_SECRET', RT_SECRET);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0 + 999); // sub-second part is floored away
        const jwt = signRealtimeToken(42)!;
        const [header, payload, sig] = jwt.split('.');
        for (const part of [header, payload, sig]) expect(part).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, unpadded
        expect(b64urlDecode(header)).toEqual({ alg: 'HS256', typ: 'JWT' });
        const now = Math.floor(T0 / 1000);
        expect(b64urlDecode(payload)).toEqual({
            role: 'authenticated',
            sub: '00000000-0000-4000-8000-000000000042',
            user_id: 42,
            iat: now,
            exp: now + 8 * 60 * 60,
        });
        const expected = createHmac('sha256', RT_SECRET).update(`${header}.${payload}`).digest('base64url');
        expect(sig).toBe(expected);
        // NOT signed with the session key: a realtime token is not a session credential.
        expect(createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url')).not.toBe(sig);
        expect(verifyToken(jwt)).toBeNull();
    });

    it('keeps sub a valid UUID for ids longer than 12 digits (last 12 kept)', () => {
        vi.stubEnv('SUPABASE_JWT_SECRET', RT_SECRET);
        const payload = b64urlDecode(signRealtimeToken(1234567890123456)!.split('.')[1]);
        expect(payload.sub).toBe('00000000-0000-4000-8000-567890123456');
        expect(payload.sub).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(payload.user_id).toBe(1234567890123456);
    });

    it('fails closed with no SUPABASE_JWT_SECRET: no token, and the operator is told exactly once', async () => {
        vi.stubEnv('SUPABASE_JWT_SECRET', '');
        vi.resetModules();
        const logMod = await import('../lib/log');
        const error = vi.fn();
        const stubLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error, child: () => stubLog };
        vi.spyOn(logMod.log, 'child').mockReturnValue(stubLog);
        const fresh = await import('../lib/auth');
        expect(fresh.signRealtimeToken(1)).toBeNull();
        expect(fresh.signRealtimeToken(2)).toBeNull();
        const realtimeErrors = error.mock.calls.filter(([m]) => String(m).includes('SUPABASE_JWT_SECRET'));
        expect(realtimeErrors).toHaveLength(1);
        // The log names the variable to set, never a value.
        expect(realtimeErrors[0]).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe('JWT_SECRET boot guard', () => {
    async function load(env: Record<string, string>) {
        for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
        vi.resetModules();
        const logMod = await import('../lib/log');
        const warn = vi.fn();
        const error = vi.fn();
        const stubLog = { debug: vi.fn(), info: vi.fn(), warn, error, child: () => stubLog };
        vi.spyOn(logMod.log, 'child').mockReturnValue(stubLog);
        const auth = await import('../lib/auth');
        return { auth, warn, error };
    }
    const CLEAN = { SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_JWT_SECRET: '', SECRETS_ENCRYPTION_KEY: '', SUPABASE_ANON_KEY: '', VAPID_PUBLIC_KEY: '' };

    it('production refuses to load with no secret at all', async () => {
        await expect(load({ ...CLEAN, NODE_ENV: 'production', JWT_SECRET: '' })).rejects.toThrow(/JWT_SECRET is not configured/);
    });

    it('outside production a missing secret falls back to a per-process random key, loudly', async () => {
        const { auth, error } = await load({ ...CLEAN, NODE_ENV: 'development', JWT_SECRET: '' });
        expect(error).toHaveBeenCalledWith(expect.stringMatching(/jwt_secret not set, using ephemeral random secret/), { env: 'dev' });
        // The fallback key really signs and verifies within this process…
        const token = auth.signToken({ userId: 9 });
        expect(auth.verifyToken(token)?.userId).toBe(9);
        // …but it is NOT a guessable constant: neither the empty string nor the fixed test key signed it.
        const [data, sig] = token.split('.');
        expect(createHmac('sha256', '').update(data).digest('hex')).not.toBe(sig);
        expect(createHmac('sha256', SECRET).update(data).digest('hex')).not.toBe(sig);
        // …and a restart (fresh module, fresh random key) invalidates every token it issued.
        const { auth: restarted } = await load({ ...CLEAN, NODE_ENV: 'development', JWT_SECRET: '' });
        expect(restarted.verifyToken(token)).toBeNull();
    });

    it('an empty sibling key never counts as "identical" to the secret', async () => {
        const strong = 'k'.repeat(48);
        const { warn } = await load({ ...CLEAN, NODE_ENV: 'development', JWT_SECRET: strong });
        expect(warn).not.toHaveBeenCalled();
    });

    it('names every reused source at once — published (refuse tier) first, then private — and never the value', async () => {
        const shared = 'shared-value-that-is-long-enough-0123456789';
        const { warn } = await load({ ...CLEAN, NODE_ENV: 'development', JWT_SECRET: shared, SUPABASE_JWT_SECRET: shared, VAPID_PUBLIC_KEY: shared, SECRETS_ENCRYPTION_KEY: shared });
        expect(warn).toHaveBeenCalledTimes(1);
        const [msg, fields] = warn.mock.calls[0] as [string, { problems: string[] }];
        expect(msg).toBe('jwt_secret is unsafe; production would refuse to start');
        expect(fields.problems).toEqual(['identical to the published VAPID_PUBLIC_KEY', 'identical to SUPABASE_JWT_SECRET, SECRETS_ENCRYPTION_KEY']);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(shared);
    });

    it('production starts on a warn-tier secret: one log.error, nothing thrown, the key works', async () => {
        const medium = 'm7Q2v9R4x1K8p3L6t0W5n2B8';
        const { auth, warn, error } = await load({ ...CLEAN, NODE_ENV: 'production', JWT_SECRET: medium });
        expect(auth.verifyToken(auth.signToken({ userId: 3 }))?.userId).toBe(3);
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.mock.calls[0][0]).toBe('jwt_secret is weaker than recommended; starting anyway, rotate it when convenient');
        expect(warn).not.toHaveBeenCalled();
        expect(JSON.stringify(error.mock.calls)).not.toContain(medium);
    });

    it('production refuses a published-key copy even when every length rule is satisfied', async () => {
        const published = 'p'.repeat(64);
        await expect(load({ ...CLEAN, NODE_ENV: 'production', JWT_SECRET: published, SUPABASE_ANON_KEY: published }))
            .rejects.toThrow(/^CRITICAL: JWT_SECRET is unsafe \(identical to the published SUPABASE_ANON_KEY\)/);
    });
});
