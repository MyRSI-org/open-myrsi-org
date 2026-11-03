import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FAKE_ANON_JWT, FAKE_SERVICE_ROLE_JWT, FAKE_PUBLISHABLE, FAKE_SECRET, fakeJwt, LEGACY_CLAIMS } from './supabaseKeyFixtures';
import { isSecretSupabaseKeyProblem, supabaseKeyProblem } from '../lib/supabaseKeyGuard';

// The per-request half of the anon-key guard (api/query.ts). target=config and every
// target=initial-state branch ship SUPABASE_ANON_KEY — two of those branches to a caller with
// no session at all — and used to ship whatever the variable held. Now:
//   * target=config fails closed with its existing 500 and never carries the key;
//   * initial-state OMITS the key from `config` (the app still boots, without realtime).
// The boot half and the guard itself are pinned in tests/supabaseKeyGuard.test.ts.
//
// THIS is the control for an UNRECOGNISED value. Since the owner decision of 2026-11-02 the
// server BOOTS in production on one (the .env.example placeholder, a typo) — only a secret key
// refuses boot — so the per-request guard below is the only thing between such a value and every
// visitor. It must keep withholding everything that is not positively publishable.

const h = vi.hoisted(() => ({
    adminCount: 1,
    decoded: null as null | { userId: number },
    user: null as unknown,
}));

// Chainable, awaitable Supabase stub for handleInitialState's admin-count probe:
// count 0 → the needsSetup branch, count > 0 → the logged-out / authenticated branches.
function sbBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'single', 'maybeSingle']) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) => resolve({ count: h.adminCount, data: { id: 4 }, error: null });
    return b;
}

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    tokenIssuedAt: () => new Date(0),
    isSessionForceLoggedOut: () => false,
    isSessionRevokedByWatermark: () => false,
    signRealtimeToken: () => 'rt-token',
}));
vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    isSetupCompleted: async () => true,
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    findActiveBan: async () => null,
    getBanNotice: async () => null,
    getAllSettings: async () => ({ brandingConfig: { name: 'Org', iconUrl: '/i.svg' }, discordConfig: {} }),
    getSystemRoles: async () => ({ admin: { id: 4 } }),
    getState: async () => ({ users: [], discordConfig: {} }),
}));

import handler from '../api/query';

interface MockRes { statusCode: number; body: Record<string, unknown> & { config?: Record<string, unknown> }; headers: Record<string, string> }
function mockRes() {
    const res = { statusCode: 0, body: {}, headers: {} } as MockRes & Record<string, unknown>;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: MockRes['body']) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    res.getHeader = (k: string) => res.headers[k];
    return res;
}
const mockReq = (target: string, token?: string) =>
    ({ method: 'GET', query: { target }, headers: token ? { authorization: `Bearer ${token}` } : {} }) as never;

async function call(target: string, token?: string) {
    const res = mockRes();
    await handler(mockReq(target, token), res as never);
    return res;
}

const MEMBER = { id: 6, role: 'Member', permissions: [], discordId: 'd6' };

beforeEach(() => {
    h.adminCount = 1; h.decoded = null; h.user = null;
    vi.stubEnv('SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', FAKE_SERVICE_ROLE_JWT);
});
afterEach(() => { vi.unstubAllEnvs(); });

// Every key the guard must withhold, with the reason it is withheld.
const UNSAFE: Array<[string, string]> = [
    ['the service-role JWT itself', FAKE_SERVICE_ROLE_JWT],
    ['an sb_secret_ key', FAKE_SECRET],
    ['a service_role JWT from another project', fakeJwt({ ...LEGACY_CLAIMS, ref: 'zyxwvutsrqponmlkjihg', role: 'service_role' })],
    // Unrecognised values: the server now boots on these, so this guard alone withholds them.
    ['a placeholder that is no key at all', 'your-anon-public-key'],
    ['a JWT with no role claim', fakeJwt({ ...LEGACY_CLAIMS })],
    ['an unrecognised future-looking key format', 'sb_something_new_Xq7PzR2mN8vK4tL1cW9bYd'],
];

describe('the boot tier and the egress guard are different questions', () => {
    it('the unrecognised values above are ones boot lets through — and are in the withheld set', () => {
        const letThroughAtBoot = UNSAFE.filter(([, key]) => !isSecretSupabaseKeyProblem(supabaseKeyProblem(key, FAKE_SERVICE_ROLE_JWT)));
        expect(letThroughAtBoot.map(([label]) => label)).toEqual([
            'a placeholder that is no key at all',
            'a JWT with no role claim',
            'an unrecognised future-looking key format',
        ]);
    });
});

describe('target=config — fails closed, never carries an unsafe key', () => {
    it.each(UNSAFE)('%s → the existing 500, and the key is nowhere in the response', async (_label, key) => {
        vi.stubEnv('SUPABASE_ANON_KEY', key);
        const res = await call('config');
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ message: 'Server configuration error.' });
        expect(JSON.stringify(res.body)).not.toContain(key);
    });

    it('an anon-shaped key that EQUALS the service-role key is withheld too', async () => {
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', FAKE_ANON_JWT);
        vi.stubEnv('SUPABASE_ANON_KEY', FAKE_ANON_JWT);
        const res = await call('config');
        expect(res.statusCode).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain(FAKE_ANON_JWT);
    });

    it.each([
        ['a legacy anon JWT', FAKE_ANON_JWT],
        ['an sb_publishable_ key', FAKE_PUBLISHABLE],
    ])('%s is served unchanged', async (_label, key) => {
        vi.stubEnv('SUPABASE_ANON_KEY', key);
        const res = await call('config');
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', supabaseAnonKey: key });
    });
});

describe('target=initial-state — an unsafe key is OMITTED from config on every branch', () => {
    const BRANCHES: Array<[string, () => void, string | undefined]> = [
        ['needsSetup (no Admin yet, unauthenticated)', () => { h.adminCount = 0; }, undefined],
        ['logged-out (set up, no session)', () => { h.adminCount = 1; }, undefined],
        ['authenticated', () => { h.adminCount = 1; h.decoded = { userId: 6 }; h.user = MEMBER; }, 'tok'],
    ];

    for (const [label, arrange, token] of BRANCHES) {
        it.each(UNSAFE)(`${label}: %s never ships`, async (_k, key) => {
            arrange();
            vi.stubEnv('SUPABASE_ANON_KEY', key);
            const res = await call('initial-state', token);
            expect(res.statusCode).toBe(200);
            expect(res.body.config).toEqual({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co' });
            expect(res.body.config).not.toHaveProperty('supabaseAnonKey');
            expect(JSON.stringify(res.body)).not.toContain(key);
        });

        it(`${label}: a real anon key still ships, so realtime keeps working`, async () => {
            arrange();
            vi.stubEnv('SUPABASE_ANON_KEY', FAKE_ANON_JWT);
            const res = await call('initial-state', token);
            expect(res.statusCode).toBe(200);
            expect(res.body.config).toEqual({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', supabaseAnonKey: FAKE_ANON_JWT });
        });
    }

    it('the branches above are the ones they claim to be (not one branch three times)', async () => {
        vi.stubEnv('SUPABASE_ANON_KEY', FAKE_ANON_JWT);
        h.adminCount = 0;
        expect((await call('initial-state')).body.needsSetup).toBe(true);
        h.adminCount = 1;
        const loggedOut = (await call('initial-state')).body;
        expect(loggedOut.needsSetup).toBeUndefined();
        expect(loggedOut.currentUser).toBeUndefined();
        h.decoded = { userId: 6 }; h.user = MEMBER;
        const authed = (await call('initial-state', 'tok')).body;
        expect(authed.error).toBeUndefined();
        expect((authed.currentUser as { id: number }).id).toBe(6);
        expect(authed.realtimeToken).toBe('rt-token');
    });
});
