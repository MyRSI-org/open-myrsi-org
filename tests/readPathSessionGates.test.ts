import { describe, it, expect, vi, beforeEach } from 'vitest';

// Session-gate tests:
//
// 1. hr:get_application_logs is gated at 'hr:recruiter', not the default-Member
//    'hr:view', so a baseline Member cannot loop application ids and harvest
//    recruiter-grade free text and applicant/recruiter real names.
//    getHRApplicationLogs takes no requester, so the gate is the only control.
//
// 2. A force-logged-out (revoked-but-unexpired) session is rejected by GET
//    /api/query?target=initial-state before getState() and before minting a fresh
//    realtime token. The main router skips the force-logout gate for initial-state
//    (skipMaintenanceBlock=true) so handleInitialState re-checks it itself,
//    mirroring the ?target=state force_logout response shape.

// permission map gate (no mocking; import the real map)
describe('HIGH-5 — hr:get_application_logs permission gate', () => {
    it('is gated at hr:recruiter (matches hr:add_log + hr:get_application_data)', async () => {
        const { fullPermissionMap } = await import('../api/services');
        expect(fullPermissionMap['hr:get_application_logs']).toBe('hr:recruiter');
    });

    it('is NOT left at the default-Member hr:view gate', async () => {
        const { fullPermissionMap } = await import('../api/services');
        expect(fullPermissionMap['hr:get_application_logs']).not.toBe('hr:view');
    });

    it('matches its recruiter-grade siblings (single source of drift truth)', async () => {
        const { fullPermissionMap } = await import('../api/services');
        // The logs read must equal its recruiter-grade siblings (the add_log write
        // and the get_application_data vetting read) so the trio cannot drift apart.
        expect(fullPermissionMap['hr:get_application_logs']).toBe(fullPermissionMap['hr:add_log']);
        expect(fullPermissionMap['hr:get_application_logs']).toBe(fullPermissionMap['hr:get_application_data']);
    });
});

// force-logout on ?target=initial-state

const h = vi.hoisted(() => ({
    decoded: null as any,
    user: null as any,
    forceLoggedOut: false,
    watermarkRevoked: false,
    platformSettings: {} as any,
    calls: { getState: 0, signRealtimeToken: 0, getUserById: 0 },
}));

// Chainable, awaitable Supabase stub so handleInitialState's admin-count probe
// resolves count > 0 → "system is set up", so we exercise the real auth +
// force-logout gate rather than the needsSetup short-circuit.
function sbBuilder() {
    const b: any = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'single', 'maybeSingle']) {
        b[m] = () => b;
    }
    b.then = (resolve: any) => resolve({ count: 1, data: { id: 4 }, error: null });
    return b;
}

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    isSessionForceLoggedOut: () => h.forceLoggedOut,
    isSessionRevokedByWatermark: () => h.watermarkRevoked,
    signRealtimeToken: () => { h.calls.signRealtimeToken++; return 'rt-token'; },
    tokenIssuedAt: () => new Date(0),
}));

vi.mock('../lib/db/userFilters', () => ({
    stripSensitiveUserFields: (u: any) => u,
    stripSensitiveUserFieldsBulk: (u: any) => u,
}));

vi.mock('../lib/clearance', () => ({
    filterByClearance: (rows: any) => rows,
}));

vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    getPlatformSettings: async () => h.platformSettings,
    getUserById: async () => { h.calls.getUserById++; return h.user; },
    getAllSettings: async () => ({ brandingConfig: {}, discordConfig: {} }),
    isSetupCompleted: async () => true,
    getState: async () => { h.calls.getState++; return { users: [], discordConfig: {} }; },
}));

// Import AFTER mocks are registered.
import handler from '../api/query';

function mockRes() {
    const res: any = { statusCode: 0, body: undefined, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
function mockReq(query: any, token?: string) {
    return { method: 'GET', query, headers: token ? { authorization: `Bearer ${token}` } : {} } as any;
}

const memberUser = { id: 6, role: 'Member', permissions: [] };

beforeEach(() => {
    h.decoded = null;
    h.user = null;
    h.forceLoggedOut = false;
    h.watermarkRevoked = false;
    h.platformSettings = {};
    h.calls = { getState: 0, signRealtimeToken: 0, getUserById: 0 };
});

describe('readpath-authz#1 — force-logout enforced on ?target=initial-state', () => {
    it('force-logged-out token → 401 force_logout BEFORE getState + realtime mint', async () => {
        h.decoded = { userId: 6 };
        h.user = memberUser;
        h.forceLoggedOut = true;
        h.platformSettings = { force_logout_timestamp: '2026-06-01T00:00:00.000Z' };

        const res = mockRes();
        await handler(mockReq({ target: 'initial-state' }, 'revoked-tok'), res);

        // Fail-closed response mirrors the ?target=state path exactly.
        expect(res.statusCode).toBe(401);
        expect(res.body?.force_logout).toBe(true);

        // A revoked session never reaches full state content and never gets a
        // fresh realtime token.
        expect(h.calls.getState).toBe(0);
        expect(h.calls.signRealtimeToken).toBe(0);
        expect(h.calls.getUserById).toBe(0);
    });

    it('valid (non-revoked) token still boots: getState + realtime mint run', async () => {
        h.decoded = { userId: 6 };
        h.user = memberUser;
        h.forceLoggedOut = false;
        h.platformSettings = { force_logout_timestamp: '2026-06-01T00:00:00.000Z' };

        const res = mockRes();
        await handler(mockReq({ target: 'initial-state' }, 'good-tok'), res);

        expect(res.statusCode).toBe(200);
        expect(res.body?.force_logout).toBeUndefined();
        expect(h.calls.getState).toBe(1);
        expect(h.calls.signRealtimeToken).toBe(1);
    });

    it('no force_logout_timestamp set → token boots normally (gate is a no-op)', async () => {
        h.decoded = { userId: 6 };
        h.user = memberUser;
        h.forceLoggedOut = false; // predicate is short-circuited by absent timestamp
        h.platformSettings = {}; // no force_logout_timestamp

        const res = mockRes();
        await handler(mockReq({ target: 'initial-state' }, 'tok'), res);

        expect(res.statusCode).toBe(200);
        expect(h.calls.getState).toBe(1);
        expect(h.calls.signRealtimeToken).toBe(1);
    });
});

// Per-user revocation watermark (tokens_valid_from) on the READ paths. This is
// the gap the dispatcher already closed (api/services.ts) but the read paths
// did not: a token issued before the user's tokens_valid_from (admin revoke /
// soft-delete / ban) must NOT keep reading — even when no PLATFORM-wide
// force_logout_timestamp is set.
describe('readpath-authz#2 — per-user tokens_valid_from enforced on read paths', () => {
    it('initial-state: revoked-by-watermark token drops to public boot (no getState, no realtime mint)', async () => {
        h.decoded = { userId: 6 };
        h.user = { ...memberUser, tokensValidFrom: '2026-06-10T00:00:00.000Z' };
        h.forceLoggedOut = false;   // platform force-logout NOT set
        h.watermarkRevoked = true;  // but THIS user's sessions were individually revoked
        h.platformSettings = {};    // no platform force_logout_timestamp

        const res = mockRes();
        await handler(mockReq({ target: 'initial-state' }, 'revoked-user-tok'), res);

        // Public boot (login screen) — the user was loaded then nulled, so we never
        // re-boot into authenticated state or mint a fresh realtime token.
        expect(res.statusCode).toBe(200);
        expect(res.body?.force_logout).toBeUndefined();
        expect(h.calls.getUserById).toBe(1);
        expect(h.calls.getState).toBe(0);
        expect(h.calls.signRealtimeToken).toBe(0);
    });

    it('state: revoked-by-watermark token → 401 force_logout before serving a subset', async () => {
        h.decoded = { userId: 6 };
        h.user = { ...memberUser, tokensValidFrom: '2026-06-10T00:00:00.000Z' };
        h.forceLoggedOut = false;
        h.watermarkRevoked = true;
        h.platformSettings = {};

        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }, 'revoked-user-tok'), res);

        expect(res.statusCode).toBe(401);
        expect(res.body?.force_logout).toBe(true);
        expect(h.calls.getState).toBe(0);
    });
});
