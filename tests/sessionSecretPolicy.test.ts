import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// JWT_SECRET: refuse to boot only where a forged session is a real prospect; warn otherwise.
//
// 15.7.1 first refused every secret under 32 characters or equal to any other key. Hosters
// who set up as documented (`openssl rand -hex 32`, 64 characters, since v15.0.0) were never
// affected, but the hard refusal also forced a rotation — every member signed out — on secrets
// that are not exploitable: a random 24-character value, or a copy of a PRIVATE key (HMAC does
// not reveal its key). The policy now refuses only the exploitable cases and keeps the rest as
// a loud warning, repeated in the admin Database Tools health check so it cannot scroll away.

vi.mock('../lib/db/common', () => {
    const make = () => {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'lt', 'in', 'single', 'maybeSingle', 'delete', 'update', 'insert']) {
            b[m] = () => b;
        }
        (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ data: null, count: 0, error: null });
        return b;
    };
    return {
        supabase: { from: () => make(), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});
vi.mock('../lib/push', () => ({ sendPushToAll: () => {}, sendPushToStaff: () => {}, sendPushToPermission: () => {} }));
vi.mock('../lib/cache', () => ({ cache: { invalidate: () => {}, invalidatePrefix: () => {}, get: () => undefined, set: () => {} }, TTL: {} }));

import {
    assessSessionSecret,
    JWT_SECRET_REFUSE_BELOW,
    JWT_SECRET_RECOMMENDED_LENGTH,
} from '../lib/sessionSecretPolicy';
import { runDatabaseHealthCheck } from '../lib/db/system';
import { fakeJwt, LEGACY_CLAIMS, FAKE_ANON_JWT, FAKE_PUBLISHABLE, FAKE_SECRET } from './supabaseKeyFixtures';

const STRONG = 'a'.repeat(64);             // what `openssl rand -hex 32` produces (length-wise)
const MEDIUM = 'm'.repeat(24);             // random-but-short: uncrackable, below the recommendation
const SHORT = 'myorgsecret';               // the human-typed range

describe('assessSessionSecret', () => {
    it('a documented 64-character secret has no problems at all', () => {
        expect(assessSessionSecret({ JWT_SECRET: STRONG })).toEqual({ refuse: [], warn: [] });
    });

    it('missing or empty is refused', () => {
        expect(assessSessionSecret({}).refuse).toEqual(['not configured']);
        expect(assessSessionSecret({ JWT_SECRET: '' }).refuse).toEqual(['not configured']);
    });

    it(`under ${JWT_SECRET_REFUSE_BELOW} characters is refused`, () => {
        const a = assessSessionSecret({ JWT_SECRET: SHORT });
        expect(a.refuse).toEqual([`shorter than ${JWT_SECRET_REFUSE_BELOW} characters`]);
        expect(a.warn).toEqual([]);
        expect(assessSessionSecret({ JWT_SECRET: 'x'.repeat(JWT_SECRET_REFUSE_BELOW - 1) }).refuse).toHaveLength(1);
    });

    it(`${JWT_SECRET_REFUSE_BELOW}-${JWT_SECRET_RECOMMENDED_LENGTH - 1} characters only warns (no forced rotation)`, () => {
        for (const len of [JWT_SECRET_REFUSE_BELOW, MEDIUM.length, JWT_SECRET_RECOMMENDED_LENGTH - 1]) {
            const a = assessSessionSecret({ JWT_SECRET: 'r'.repeat(len) });
            expect(a.refuse, `length ${len}`).toEqual([]);
            expect(a.warn, `length ${len}`).toEqual([`shorter than the recommended ${JWT_SECRET_RECOMMENDED_LENGTH} characters`]);
        }
        expect(assessSessionSecret({ JWT_SECRET: 'r'.repeat(JWT_SECRET_RECOMMENDED_LENGTH) })).toEqual({ refuse: [], warn: [] });
    });

    it.each(['SUPABASE_ANON_KEY', 'VAPID_PUBLIC_KEY'])('a copy of the PUBLISHED %s is refused, even when long', (name) => {
        const a = assessSessionSecret({ JWT_SECRET: STRONG, [name]: STRONG });
        expect(a.refuse).toEqual([`identical to the published ${name}`]);
        expect(a.warn).toEqual([]);
    });

    it.each(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET', 'SECRETS_ENCRYPTION_KEY'])('a copy of the PRIVATE %s only warns', (name) => {
        const a = assessSessionSecret({ JWT_SECRET: STRONG, [name]: STRONG });
        expect(a.refuse).toEqual([]);
        expect(a.warn).toEqual([`identical to ${name}`]);
    });

    it('an empty other key never counts as a match', () => {
        expect(assessSessionSecret({ JWT_SECRET: STRONG, SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' }))
            .toEqual({ refuse: [], warn: [] });
    });

    it('problems combine across tiers', () => {
        const a = assessSessionSecret({ JWT_SECRET: MEDIUM, VAPID_PUBLIC_KEY: MEDIUM, SECRETS_ENCRYPTION_KEY: MEDIUM });
        expect(a.refuse).toEqual(['identical to the published VAPID_PUBLIC_KEY']);
        expect(a.warn).toEqual([
            `shorter than the recommended ${JWT_SECRET_RECOMMENDED_LENGTH} characters`,
            'identical to SECRETS_ENCRYPTION_KEY',
        ]);
    });

    it('reports names only — the secret value never appears in any message', () => {
        const secret = 'Sup3rSecretValue-Do-Not-Log';
        const a = assessSessionSecret({ JWT_SECRET: secret, SUPABASE_ANON_KEY: secret, SUPABASE_JWT_SECRET: secret });
        expect(JSON.stringify(a)).not.toContain(secret);
    });
});

describe('Database Tools health check: Session Secret row', () => {
    beforeEach(() => {
        for (const k of ['SUPABASE_ANON_KEY', 'VAPID_PUBLIC_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET', 'SECRETS_ENCRYPTION_KEY']) vi.stubEnv(k, '');
    });
    afterEach(() => { vi.unstubAllEnvs(); });

    const sessionRow = async () => {
        const rows = await runDatabaseHealthCheck() as Array<{ check: string; status: string; action?: string }>;
        const row = rows.find((r) => r.check.startsWith('Session Secret'));
        expect(row, 'the health check must always report the session secret').toBeDefined();
        return row!;
    };

    it('OK for a documented secret', async () => {
        vi.stubEnv('JWT_SECRET', STRONG);
        expect(await sessionRow()).toMatchObject({ check: 'Session Secret', status: 'OK' });
    });

    it('WARNING (with a rotate action) for a warn-tier secret', async () => {
        vi.stubEnv('JWT_SECRET', STRONG);
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', STRONG);
        const row = await sessionRow();
        expect(row.status).toBe('WARNING');
        expect(row.check).toContain('identical to SUPABASE_SERVICE_ROLE_KEY');
        expect(row.action).toMatch(/Rotating the session secret/);
    });

    it('ERROR for a refuse-tier secret (reachable outside production, where boot only warns)', async () => {
        vi.stubEnv('JWT_SECRET', SHORT);
        const row = await sessionRow();
        expect(row.status).toBe('ERROR');
        expect(row.check).toContain(`shorter than ${JWT_SECRET_REFUSE_BELOW} characters`);
    });

    it('never shows the secret value to the admin screen', async () => {
        const secret = 'Another-Secret-Value-1234567890';
        vi.stubEnv('JWT_SECRET', secret);
        vi.stubEnv('SUPABASE_JWT_SECRET', secret);
        const rows = await runDatabaseHealthCheck();
        expect(JSON.stringify(rows)).not.toContain(secret);
    });
});

// The same "boot only refuses the exploitable case" rule for SUPABASE_ANON_KEY (server.ts): an
// unset or unrecognised value starts with a log line that scrolls away, so the health check
// repeats it. Database Tools renders `check` (not `action`), so the problem must be in `check`.
describe('Database Tools health check: Supabase Anon Key row', () => {
    const SERVICE_ROLE = fakeJwt({ ...LEGACY_CLAIMS, role: 'service_role' });
    beforeEach(() => {
        vi.stubEnv('JWT_SECRET', STRONG);
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE);
    });
    afterEach(() => { vi.unstubAllEnvs(); });

    const anonRow = async () => {
        const rows = await runDatabaseHealthCheck() as Array<{ check: string; status: string; count: number | null; action?: string }>;
        const matching = rows.filter((r) => r.check.startsWith('Supabase Anon Key'));
        expect(matching, 'the health check must always report exactly one anon-key row').toHaveLength(1);
        return matching[0];
    };

    it.each([['unset', undefined], ['empty', ''], ['whitespace only', '  ']])('%s → WARNING: not set, live updates disabled', async (_l, value) => {
        vi.stubEnv('SUPABASE_ANON_KEY', value);
        const row = await anonRow();
        expect(row).toEqual({
            check: 'Supabase Anon Key (not set — live updates disabled)',
            status: 'WARNING',
            count: null,
            action: expect.stringMatching(/^Set SUPABASE_ANON_KEY to the publishable \(sb_publishable_…\) or legacy anon key/),
        });
    });

    it.each([
        ['the service-role value', () => SERVICE_ROLE, 'same as SUPABASE_SERVICE_ROLE_KEY'],
        ['an sb_secret_ key', () => FAKE_SECRET, 'is a secret key (sb_secret_)'],
        ['a service_role JWT', () => fakeJwt({ ...LEGACY_CLAIMS, ref: 'zyxwvutsrqponmlkjihg', role: 'service_role' }), 'is a JWT whose role claim is not "anon"'],
    ])('%s → ERROR naming the rule (reachable only outside production, where boot just logs)', async (_l, key, problem) => {
        vi.stubEnv('SUPABASE_ANON_KEY', key());
        const row = await anonRow();
        expect(row.status).toBe('ERROR');
        expect(row.check).toBe(`Supabase Anon Key (${problem} — withheld from browsers; replace it with the publishable key)`);
        expect(row.action).toMatch(/Never use the service-role \/ sb_secret_ key here$/);
        expect(row.count).toBeNull();
    });

    it.each([
        ['the .env.example placeholder', 'your-anon-public-key'],
        ['a JWT with no role claim', fakeJwt({ ...LEGACY_CLAIMS })],
    ])('%s → WARNING: unrecognised, never sent to browsers', async (_l, key) => {
        vi.stubEnv('SUPABASE_ANON_KEY', key);
        const row = await anonRow();
        expect(row).toEqual({
            check: 'Supabase Anon Key (not a recognised publishable key — never sent to browsers; live updates disabled)',
            status: 'WARNING',
            count: null,
            action: expect.stringContaining('sb_publishable_'),
        });
    });

    it.each([['a legacy anon JWT', FAKE_ANON_JWT], ['an sb_publishable_ key', FAKE_PUBLISHABLE]])('%s → OK', async (_l, key) => {
        vi.stubEnv('SUPABASE_ANON_KEY', key);
        expect(await anonRow()).toEqual({ check: 'Supabase Anon Key', status: 'OK', count: null });
    });

    it.each([
        ['a secret key', FAKE_SECRET],
        ['the service-role value', SERVICE_ROLE],
        ['an unrecognised canary', 'ANON-CANARY-not-a-key-7f3a9c'],
        ['a valid publishable key', FAKE_PUBLISHABLE],
    ])('never shows any part of the key: %s', async (_l, key) => {
        vi.stubEnv('SUPABASE_ANON_KEY', key);
        const text = JSON.stringify(await runDatabaseHealthCheck());
        expect(text).not.toContain(key);
        // Not even a recognisable chunk of it (the signature / random tail).
        expect(text).not.toContain(key.slice(-16));
        expect(text).not.toContain('ANON-CANARY');
    });
});
