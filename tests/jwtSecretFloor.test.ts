import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FAKE_ANON_JWT, FAKE_PUBLISHABLE } from './supabaseKeyFixtures';

// The JWT_SECRET boot guard (lib/auth.ts, evaluated at module load), acting on the tiers in
// lib/sessionSecretPolicy.ts (the rules themselves are pinned in tests/sessionSecretPolicy.test.ts).
//
// Every Discord user who signs in gets a session token signed with JWT_SECRET from the PUBLIC
// auth:discord_callback — a free HMAC sample to crack offline. Presence used to be the only check.
// 15.7.1 first refused every secret under 32 characters or equal to any other key; the owner
// decision of 2026-11-02 narrowed the refusal to the EXPLOITABLE cases so that hosters who set up
// as documented are never forced to rotate (which signs everyone out):
//   production REFUSES: missing, < 16 characters, a copy of a PUBLISHED key (anon / VAPID public);
//   production STARTS with one log.error: 16-31 characters, a copy of a PRIVATE key;
//   outside production it always starts, with one log.warn saying what production would do.
//
// Each case re-imports lib/auth.ts on a fresh module registry, because the check runs once, at
// import, against the environment of that moment.

const STRONG = 'a3f9c2e17b4d58a6e0f1c9b2d7e4a8f35c6b1d9e0a7f2c4b8e1d6a3f9c0b5e7d'; // 64 hex chars
const OTHER_STRONG = '5e0b7c1d9f4a2e8b6c3d0f7a1e9b4c2d8f6a0e3b7c5d1f9a4e2b8c6d0f3a7e1b';
// The shape web-push gives a VAPID public key: an uncompressed P-256 point (0x04 + 64 bytes),
// base64url, 87 characters. Made-up bytes; not a working key.
const FAKE_VAPID_PUBLIC = Buffer.concat([Buffer.from([0x04]), Buffer.from(STRONG + OTHER_STRONG, 'hex')]).toString('base64url');
// Random-looking but below the recommended 32: what a hoster might have from an older guide or a
// password manager. Not crackable, so production must start on it.
const MEDIUM_24 = 'Qm7vR2xK9pL4tW8nB3cY6hJd';

const WEAK_MSG = 'jwt_secret is weaker than recommended; starting anyway, rotate it when convenient';
const DEV_REFUSE_MSG = 'jwt_secret is unsafe; production would refuse to start';
const DEV_WEAK_MSG = 'jwt_secret is weaker than recommended; production would start but log an error';

/** Load lib/auth.ts on a fresh registry with its logger captured. */
async function loadAuth() {
    vi.resetModules();
    const logMod = await import('../lib/log');
    const warn = vi.fn();
    const error = vi.fn();
    const stub = { debug: vi.fn(), info: vi.fn(), warn, error, child: () => stub };
    vi.spyOn(logMod.log, 'child').mockReturnValue(stub);
    const auth = await import('../lib/auth');
    return { auth, warn, error };
}

/** The error a refused load throws, or null when it loaded. */
async function loadError(): Promise<Error | null> {
    return loadAuth().then(() => null, (e: Error) => e);
}

/** Every log call from the module, flattened, for the never-the-value assertions. */
function allLogText(...spies: Array<ReturnType<typeof vi.fn>>): string {
    return JSON.stringify(spies.map((s) => s.mock.calls));
}

/** Only the JWT_SECRET log calls (the module also logs about SUPABASE_JWT_SECRET lazily). */
const jwtCalls = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.filter(([m]) => String(m).startsWith('jwt_secret'));

beforeEach(() => {
    // Distinct, strong values for every key the reuse rules compare against, so a case only
    // trips the rule it is about.
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-' + OTHER_STRONG);
    vi.stubEnv('SUPABASE_JWT_SECRET', 'project-jwt-' + OTHER_STRONG);
    vi.stubEnv('SECRETS_ENCRYPTION_KEY', 'encryption-' + OTHER_STRONG);
    // The published keys, realistic and present, so the strong-secret cases also prove they cause
    // no false positive.
    vi.stubEnv('SUPABASE_ANON_KEY', FAKE_ANON_JWT);
    vi.stubEnv('VAPID_PUBLIC_KEY', FAKE_VAPID_PUBLIC);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('production: REFUSES only the exploitable JWT_SECRET cases', () => {
    beforeEach(() => { vi.stubEnv('NODE_ENV', 'production'); });

    it('refuses a 15-character secret (the human-typed range)', async () => {
        vi.stubEnv('JWT_SECRET', 'x'.repeat(15));
        await expect(loadAuth()).rejects.toThrow(/^CRITICAL: JWT_SECRET is unsafe \(shorter than 16 characters\)\. /);
    });

    it('refuses the kind of placeholder secret a test or a quick-start leaves behind', async () => {
        vi.stubEnv('JWT_SECRET', 'changeme');
        await expect(loadAuth()).rejects.toThrow(/JWT_SECRET is unsafe \(shorter than 16 characters\)/);
    });

    // The published keys are the case the length rules cannot catch: each is already 32+
    // characters, and each is handed to anyone who asks (target=config / initial-state for the
    // anon key, the public system:get_push_config for VAPID). A JWT_SECRET pasted from one of them
    // would be a public signing key: anyone with no account could sign an Admin session.
    it.each([
        ['SUPABASE_ANON_KEY', 'a legacy anon JWT', FAKE_ANON_JWT],
        ['SUPABASE_ANON_KEY', 'an sb_publishable_ key', FAKE_PUBLISHABLE],
        ['VAPID_PUBLIC_KEY', 'a VAPID public key', FAKE_VAPID_PUBLIC],
    ])('refuses a secret pasted from the published %s (%s), which clears every length rule', async (name, _shape, published) => {
        expect(published.length).toBeGreaterThanOrEqual(32);
        vi.stubEnv(name, published);
        vi.stubEnv('JWT_SECRET', published);
        const err = await loadError();
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toContain(`CRITICAL: JWT_SECRET is unsafe (identical to the published ${name})`);
        expect(err!.message).not.toContain(published);
    });

    it('names every broken rule at once — both tiers — so the operator fixes it in one pass', async () => {
        vi.stubEnv('SECRETS_ENCRYPTION_KEY', 'short-shared');
        vi.stubEnv('JWT_SECRET', 'short-shared');
        await expect(loadAuth()).rejects.toThrow(/JWT_SECRET is unsafe \(shorter than 16 characters; identical to SECRETS_ENCRYPTION_KEY\)/);
    });

    it('never puts the secret itself in the error, and carries the rotation guidance', async () => {
        const secret = `leak-canary-${STRONG}`;
        vi.stubEnv('VAPID_PUBLIC_KEY', secret);
        vi.stubEnv('JWT_SECRET', secret);
        const err = await loadError();
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).not.toContain(secret);
        expect(err!.message).not.toContain('leak-canary');
        expect(err!.message).toContain('openssl rand -hex 32');
        expect(err!.message).toContain('PUBLIC_SALT');
        expect(err!.message).toContain('Rotating the session secret');
    });

    it('still refuses a MISSING secret, with the original not-configured message', async () => {
        vi.stubEnv('JWT_SECRET', '');
        const err = await loadError();
        expect(err?.message).toMatch(/^CRITICAL: JWT_SECRET is not configured\. Set JWT_SECRET to a dedicated random value/);
        expect(err?.message).not.toContain('is unsafe');
    });
});

describe('production: STARTS with one log.error on the non-exploitable cases', () => {
    beforeEach(() => { vi.stubEnv('NODE_ENV', 'production'); });

    it('a random 24-character secret boots, signs and verifies, and logs the problem + fix once', async () => {
        vi.stubEnv('JWT_SECRET', MEDIUM_24);
        const { auth, warn, error } = await loadAuth();
        const token = auth.signToken({ userId: 42 });
        expect(auth.verifyToken(token)?.userId).toBe(42);
        expect(jwtCalls(error)).toEqual([[WEAK_MSG, { problems: ['shorter than the recommended 32 characters'], hint: expect.stringContaining('openssl rand -hex 32') }]]);
        expect(jwtCalls(warn)).toEqual([]);
        expect(allLogText(warn, error)).not.toContain(MEDIUM_24);
    });

    it.each([16, 31])('the warn tier is inclusive of %i characters', async (len) => {
        vi.stubEnv('JWT_SECRET', 'k'.repeat(len));
        const { error } = await loadAuth();
        expect(jwtCalls(error)).toHaveLength(1);
        expect(jwtCalls(error)[0][0]).toBe(WEAK_MSG);
    });

    it.each([
        'SUPABASE_SERVICE_ROLE_KEY',
        'SUPABASE_JWT_SECRET',
        'SECRETS_ENCRYPTION_KEY',
    ])('a copy of the PRIVATE %s boots with a log.error naming the source, never the value', async (name) => {
        const reused = `reused-${name}-${STRONG}`;
        vi.stubEnv(name, reused);
        vi.stubEnv('JWT_SECRET', reused);
        const { auth, warn, error } = await loadAuth();
        expect(auth.verifyToken(auth.signToken({ userId: 5 }))?.userId).toBe(5);
        expect(jwtCalls(error)).toEqual([[WEAK_MSG, { problems: [`identical to ${name}`], hint: expect.any(String) }]]);
        expect(allLogText(warn, error)).not.toContain(reused);
    });

    it('the log carries both warn-tier problems and the full fix hint', async () => {
        vi.stubEnv('SUPABASE_JWT_SECRET', MEDIUM_24);
        vi.stubEnv('JWT_SECRET', MEDIUM_24);
        const { error } = await loadAuth();
        const [, fields] = jwtCalls(error)[0] as [string, { problems: string[]; hint: string }];
        expect(fields.problems).toEqual(['shorter than the recommended 32 characters', 'identical to SUPABASE_JWT_SECRET']);
        expect(fields.hint).toContain('PUBLIC_SALT');
        expect(fields.hint).toContain('Rotating the session secret');
    });

    it('a strong, dedicated secret boots silently, and that key really signs and verifies', async () => {
        vi.stubEnv('JWT_SECRET', STRONG);
        const { auth, warn, error } = await loadAuth();
        expect(auth.verifyToken(auth.signToken({ userId: 42 }))?.userId).toBe(42);
        expect(jwtCalls(error)).toEqual([]);
        expect(jwtCalls(warn)).toEqual([]);
    });

    it('exactly 32 characters (the recommendation) is silent', async () => {
        vi.stubEnv('JWT_SECRET', 'k'.repeat(32));
        const { error } = await loadAuth();
        expect(jwtCalls(error)).toEqual([]);
    });
});

describe('outside production: every problem starts, with one log.warn saying what production would do', () => {
    beforeEach(() => { vi.stubEnv('NODE_ENV', 'test'); });

    it('a refuse-tier (short) secret loads and says production would refuse', async () => {
        vi.stubEnv('JWT_SECRET', 'dev-secret');
        const { auth, warn, error } = await loadAuth();
        expect(typeof auth.signToken).toBe('function');
        expect(jwtCalls(warn)).toEqual([[DEV_REFUSE_MSG, { problems: ['shorter than 16 characters'], hint: expect.any(String) }]]);
        expect(jwtCalls(error)).toEqual([]);
        expect(allLogText(warn, error)).not.toContain('dev-secret');
    });

    it.each([
        ['SUPABASE_ANON_KEY', FAKE_ANON_JWT],
        ['VAPID_PUBLIC_KEY', FAKE_VAPID_PUBLIC],
    ])('a secret pasted from the published %s loads and says production would refuse, naming the source only', async (name, published) => {
        vi.stubEnv(name, published);
        vi.stubEnv('JWT_SECRET', published);
        const { auth, warn } = await loadAuth();
        expect(typeof auth.signToken).toBe('function');
        expect(jwtCalls(warn)).toEqual([[DEV_REFUSE_MSG, { problems: [`identical to the published ${name}`], hint: expect.any(String) }]]);
        expect(allLogText(warn)).not.toContain(published);
    });

    it('a warn-tier (24-character) secret says production would start but log an error', async () => {
        vi.stubEnv('JWT_SECRET', MEDIUM_24);
        const { warn, error } = await loadAuth();
        expect(jwtCalls(warn)).toEqual([[DEV_WEAK_MSG, { problems: ['shorter than the recommended 32 characters'], hint: expect.any(String) }]]);
        expect(jwtCalls(error)).toEqual([]);
        expect(allLogText(warn, error)).not.toContain(MEDIUM_24);
    });

    it('a copy of a private key warns, naming the source, never the value', async () => {
        const reused = `shared-${STRONG}`;
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', reused);
        vi.stubEnv('JWT_SECRET', reused);
        const { warn } = await loadAuth();
        expect(jwtCalls(warn)).toEqual([[DEV_WEAK_MSG, { problems: ['identical to SUPABASE_SERVICE_ROLE_KEY'], hint: expect.any(String) }]]);
        expect(allLogText(warn)).not.toContain(reused);
    });

    it('stays silent for a strong, dedicated secret', async () => {
        vi.stubEnv('JWT_SECRET', STRONG);
        const { warn, error } = await loadAuth();
        expect(jwtCalls(warn)).toEqual([]);
        expect(jwtCalls(error)).toEqual([]);
    });
});
