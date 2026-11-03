// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isBrowserSafeSupabaseKey, isSecretSupabaseKeyProblem, supabaseKeyProblem, type SupabaseKeyProblem } from '../lib/supabaseKeyGuard';
import { b64url, fakeJwt, LEGACY_CLAIMS, FAKE_ANON_JWT, FAKE_SERVICE_ROLE_JWT, FAKE_PUBLISHABLE, FAKE_SECRET } from './supabaseKeyFixtures';

// SUPABASE_ANON_KEY is PUBLISHED by target=config and every target=initial-state response, and
// nothing used to check it was not the service-role key. lib/supabaseKeyGuard.ts is the
// allow-list that decides; these pin it, and pin that server.ts refuses to boot in production on
// a SECRET key only — an unrecognised value boots (owner decision 2026-11-02), because the
// per-request half (api/query.ts, pinned in tests/queryAnonKeyEgress.test.ts) withholds it anyway.
// What the boot block LOGS is pinned in tests/cov-server-boot.test.ts.
// Keys are realistic fakes (tests/supabaseKeyFixtures.ts), never 'test-anon-key'-style dummies.

describe('isBrowserSafeSupabaseKey — allow-list, fails closed', () => {
    it('accepts a legacy anon JWT', () => {
        expect(isBrowserSafeSupabaseKey(FAKE_ANON_JWT, FAKE_SERVICE_ROLE_JWT)).toBe(true);
    });

    it('accepts a new-style sb_publishable_ key', () => {
        expect(isBrowserSafeSupabaseKey(FAKE_PUBLISHABLE, FAKE_SECRET)).toBe(true);
    });

    it('refuses a legacy service_role JWT (the paste-into-the-wrong-box mistake)', () => {
        expect(isBrowserSafeSupabaseKey(FAKE_SERVICE_ROLE_JWT, undefined)).toBe(false);
        expect(supabaseKeyProblem(FAKE_SERVICE_ROLE_JWT, undefined)).toBe('is a JWT whose role claim is not "anon"');
    });

    it('refuses a new-style sb_secret_ key', () => {
        expect(isBrowserSafeSupabaseKey(FAKE_SECRET, undefined)).toBe(false);
        expect(supabaseKeyProblem(FAKE_SECRET, undefined)).toBe('is a secret key (sb_secret_)');
    });

    it('refuses the service-role value itself, even when it LOOKS publishable', () => {
        // Equality is checked before any format rule, so it holds for a shape this file does
        // not otherwise trust or distrust.
        expect(isBrowserSafeSupabaseKey(FAKE_ANON_JWT, FAKE_ANON_JWT)).toBe(false);
        expect(isBrowserSafeSupabaseKey(FAKE_PUBLISHABLE, FAKE_PUBLISHABLE)).toBe(false);
        expect(isBrowserSafeSupabaseKey(`${FAKE_PUBLISHABLE}\n`, FAKE_PUBLISHABLE)).toBe(false);
        expect(supabaseKeyProblem(FAKE_ANON_JWT, FAKE_ANON_JWT)).toBe('same as SUPABASE_SERVICE_ROLE_KEY');
    });

    it('refuses empty, whitespace, null and undefined', () => {
        for (const v of ['', '   ', null, undefined]) {
            expect(isBrowserSafeSupabaseKey(v, FAKE_SERVICE_ROLE_JWT), String(v)).toBe(false);
            expect(supabaseKeyProblem(v, FAKE_SERVICE_ROLE_JWT)).toBe('missing');
        }
    });

    it('refuses garbage and the unrealistic dummy values this repo used to test with', () => {
        for (const v of ['your-anon-public-key', 'test-anon-key', 'test-service-role-key', 'not.a.jwt!', 'a.b', '....', 'eyJ.eyJ.sig']) {
            expect(isBrowserSafeSupabaseKey(v, undefined), v).toBe(false);
        }
    });

    it('refuses a JWT whose role is anything but anon — authenticated, missing, non-string', () => {
        expect(isBrowserSafeSupabaseKey(fakeJwt({ ...LEGACY_CLAIMS, role: 'authenticated' }), undefined)).toBe(false);
        expect(isBrowserSafeSupabaseKey(fakeJwt({ ...LEGACY_CLAIMS }), undefined)).toBe(false);
        expect(isBrowserSafeSupabaseKey(fakeJwt({ ...LEGACY_CLAIMS, role: ['anon'] }), undefined)).toBe(false);
        expect(isBrowserSafeSupabaseKey(fakeJwt({ ...LEGACY_CLAIMS, role: 'ANON' }), undefined)).toBe(false);
    });

    it('refuses a JWT-shaped value whose payload is not a JSON object', () => {
        const head = b64url({ alg: 'HS256', typ: 'JWT' });
        expect(isBrowserSafeSupabaseKey(`${head}.${Buffer.from('["anon"]').toString('base64url')}.sig`, undefined)).toBe(false);
        expect(isBrowserSafeSupabaseKey(`${head}.${Buffer.from('role=anon').toString('base64url')}.sig`, undefined)).toBe(false);
        // Four segments: not a JWT, even if one of them would decode to an anon claim.
        expect(isBrowserSafeSupabaseKey(`${FAKE_ANON_JWT}.extra`, undefined)).toBe(false);
    });

    it('the problem string never echoes the key, so it is safe to log', () => {
        for (const v of [FAKE_SERVICE_ROLE_JWT, FAKE_SECRET, 'garbage-key-canary']) {
            const p = supabaseKeyProblem(v, undefined) ?? '';
            expect(p).not.toBe('');
            expect(p).not.toContain(v);
            expect(p).not.toContain('canary');
        }
    });
});

// ---------------------------------------------------------------------------
// The boot tier. Refusing to start is reserved for a value that positively IS a secret key;
// isBrowserSafeSupabaseKey (above) stays the only question for what may reach a browser.
// ---------------------------------------------------------------------------
describe('isSecretSupabaseKeyProblem — which problems are worth refusing to boot on', () => {
    // Exhaustive over the union: a Record in the source makes a new member a compile error, and
    // this table makes a silent re-classification of an existing one a test failure.
    const TABLE: Array<[SupabaseKeyProblem, boolean]> = [
        ['missing', false],
        ['same as SUPABASE_SERVICE_ROLE_KEY', true],
        ['is a secret key (sb_secret_)', true],
        ['is a JWT whose role claim is not "anon"', true],
        ['is not a recognised publishable key format', false],
    ];
    it.each(TABLE)('%s → %s', (problem, secret) => {
        expect(isSecretSupabaseKeyProblem(problem)).toBe(secret);
    });

    it('no problem at all is not a secret problem', () => {
        expect(isSecretSupabaseKeyProblem(null)).toBe(false);
        expect(isSecretSupabaseKeyProblem(undefined)).toBe(false);
    });

    it('an unknown string at runtime (incl. an Object.prototype name) is never classed as secret by accident', () => {
        for (const v of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'something new']) {
            expect(isSecretSupabaseKeyProblem(v as SupabaseKeyProblem), v).toBe(false);
        }
    });

    it('end to end from real-shaped keys: the three secret shapes are secret, the placeholder is not', () => {
        const classify = (anon: string | undefined, service?: string) => isSecretSupabaseKeyProblem(supabaseKeyProblem(anon, service));
        expect(classify(FAKE_SERVICE_ROLE_JWT, FAKE_SERVICE_ROLE_JWT)).toBe(true);   // the service-role value
        expect(classify(FAKE_SECRET)).toBe(true);                                    // sb_secret_
        expect(classify(FAKE_SERVICE_ROLE_JWT)).toBe(true);                          // service_role JWT
        expect(classify(fakeJwt({ ...LEGACY_CLAIMS, role: 'authenticated' }))).toBe(true);
        expect(classify('your-anon-public-key')).toBe(false);                        // the .env.example placeholder
        expect(classify(fakeJwt({ ...LEGACY_CLAIMS }))).toBe(false);                 // JWT with no role claim: unrecognised
        expect(classify('')).toBe(false);
        expect(classify(FAKE_ANON_JWT)).toBe(false);
        expect(classify(FAKE_PUBLISHABLE)).toBe(false);
    });

    it('a value the boot tier lets through is STILL not browser-safe (the two questions never merge)', () => {
        for (const v of ['your-anon-public-key', fakeJwt({ ...LEGACY_CLAIMS }), 'test-anon-key']) {
            expect(isSecretSupabaseKeyProblem(supabaseKeyProblem(v, undefined)), v).toBe(false);
            expect(isBrowserSafeSupabaseKey(v, undefined), v).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// The boot half. server.ts runs the check at module load; importing it does not listen
// (isMainModule), so the boot block can be exercised directly. A fresh registry per case,
// because the block runs once, at import.
// ---------------------------------------------------------------------------
describe('server.ts boot check on SUPABASE_ANON_KEY', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    function productionEnv(anonKey: string) {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', FAKE_SERVICE_ROLE_JWT);
        vi.stubEnv('SECRETS_ENCRYPTION_KEY', 'e'.repeat(16) + 'f'.repeat(48));
        vi.stubEnv('JWT_SECRET', '0123456789abcdef'.repeat(4));
        vi.stubEnv('SUPABASE_ANON_KEY', anonKey);
    }

    async function bootServer() {
        vi.resetModules();
        return import('../server.ts');
    }

    it('refuses to start in production when the anon key IS the service-role key', async () => {
        productionEnv(FAKE_SERVICE_ROLE_JWT);
        const err = await bootServer().then(() => null, (e: Error) => e);
        expect(err?.message).toMatch(/Startup aborted: SUPABASE_ANON_KEY same as SUPABASE_SERVICE_ROLE_KEY/);
        // The message names the rule, never the key.
        expect(err?.message).not.toContain(FAKE_SERVICE_ROLE_JWT);
    }, 60_000);

    it('refuses to start in production on an sb_secret_ key', async () => {
        productionEnv(FAKE_SECRET);
        const err = await bootServer().then(() => null, (e: Error) => e);
        expect(err?.message).toMatch(/Startup aborted: SUPABASE_ANON_KEY is a secret key \(sb_secret_\)/);
        expect(err?.message).not.toContain(FAKE_SECRET);
    }, 60_000);

    it('refuses to start in production on a service_role JWT that is not the configured service-role value', async () => {
        const otherProjectServiceRole = fakeJwt({ ...LEGACY_CLAIMS, ref: 'zyxwvutsrqponmlkjihg', role: 'service_role' });
        productionEnv(otherProjectServiceRole);
        const err = await bootServer().then(() => null, (e: Error) => e);
        expect(err?.message).toMatch(/Startup aborted: SUPABASE_ANON_KEY is a JWT whose role claim is not "anon"/);
        expect(err?.message).not.toContain(otherProjectServiceRole);
    }, 60_000);

    it('BOOTS in production on a placeholder that is no key at all (unrecognised is not exploitable)', async () => {
        // The .env.example value. It used to abort boot; it is now an error log + a Database Tools
        // warning, and api/query.ts never ships it (tests/queryAnonKeyEgress.test.ts).
        productionEnv('your-anon-public-key');
        const mod = await bootServer();
        expect(typeof mod.app).toBe('function');
    }, 60_000);

    it('boots in production with a real-shaped anon key', async () => {
        productionEnv(FAKE_ANON_JWT);
        const mod = await bootServer();
        expect(typeof mod.app).toBe('function');
    }, 60_000);

    it('boots in production with the anon key UNSET (nothing to leak; realtime stays off)', async () => {
        productionEnv('');
        const mod = await bootServer();
        expect(typeof mod.app).toBe('function');
    }, 60_000);

    it('outside production a bad key only logs — the per-request guard withholds it', async () => {
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('SUPABASE_ANON_KEY', FAKE_SERVICE_ROLE_JWT);
        const mod = await bootServer();
        expect(typeof mod.app).toBe('function');
    }, 60_000);
});
