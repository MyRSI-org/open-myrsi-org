import { describe, it, expect, vi, beforeEach } from 'vitest';

// Dispatcher op-owner-bypass tests.
//
// The isOpOwner bypass lets an op's owner satisfy the operations:manage gate for
//   owner-appropriate edit/lifecycle actions on their own op. It does not extend
//   to finance / payout / alert / participant-mutation / status actions — those
//   always require the real operations:manage permission, even for the owner.
//
// The ownership lookup (db.getFullOperationDetails, ~11 queries) runs only when
//   the cheap permission check has not already passed (short-circuit on hasPerm)
//   and never for the owner-bypass-excluded actions. This is work-avoidance only
//   and does not alter any authorization outcome.

const h = vi.hoisted(() => ({
    decoded: null as any,
    user: null as any,
    op: null as any,
    platformSettings: {} as any,
    calls: {
        getFullOperationDetails: 0,
        getUserById: 0,
        // per-action handler invocations (proves the request reached the handler)
        handlerCalls: [] as string[],
    },
}));

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    isSessionForceLoggedOut: () => false,
    isSessionRevokedByWatermark: () => false,
    tokenIssuedAt: () => new Date(0),
}));

vi.mock('../lib/db', () => ({
    supabase: { auth: { getUser: async () => ({ data: { user: null }, error: 'no' }) } },
    getPlatformSettings: async () => h.platformSettings,
    getUserById: async () => { h.calls.getUserById++; return h.user; },
    getUserByAuthId: async () => h.user,
    getFullOperationDetails: async () => { h.calls.getFullOperationDetails++; return h.op; },
}));

// Stub the operations action module so a dispatched (allowed) op action lands on
// a known inert handler instead of the real db-backed logic. Each handler simply
// records that it was reached and returns a sentinel.
vi.mock('../api/actions/operations', () => {
    const make = (key: string) => async () => { h.calls.handlerCalls.push(key); return { ok: key }; };
    return {
        operationActions: {
            'operation:set_payout_splits': make('operation:set_payout_splits'),
            'operation:add_uec': make('operation:add_uec'),
            'operation:broadcast_alert': make('operation:broadcast_alert'),
            'operation:update_status': make('operation:update_status'),
            'operation:update_phase': make('operation:update_phase'),
            'operation:add_phase': make('operation:add_phase'),
        },
    };
});

// Import AFTER mocks are registered.
import handler from '../api/services';

function mockRes() {
    const res: any = { statusCode: 0, body: undefined, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
function mockReq(action: string, payload: any, token = 'tok') {
    return {
        method: 'POST',
        body: { action, payload },
        headers: { authorization: `Bearer ${token}` },
    } as any;
}

const OWNER_ID = 42;
const OP_ID = 'op-owned-by-42';

// An op OWNER who does NOT hold operations:manage (the "ops planner" custom role:
// operations:create + operations:view, no manage). This is the precise attacker
// the owner-bypass narrowing must constrain.
const ownerNoManage = {
    id: OWNER_ID,
    role: 'Member',
    auth_user_id: 'auth-42',
    permissions: ['operations:create', 'operations:view'],
};

// A caller who DOES hold operations:manage (e.g. Dispatcher) — the common path.
const managerUser = {
    id: 7,
    role: 'Member',
    auth_user_id: 'auth-7',
    permissions: ['operations:create', 'operations:view', 'operations:manage'],
};

beforeEach(() => {
    h.decoded = null;
    h.user = null;
    h.op = { id: OP_ID, ownerId: OWNER_ID };
    h.platformSettings = {};
    h.calls = { getFullOperationDetails: 0, getUserById: 0, handlerCalls: [] };
});

describe('auth: only HMAC session tokens are accepted (no Supabase-token fallback)', () => {
    it('a non-verifiable token is rejected 401, never loads a user, never dispatches', async () => {
        h.decoded = null;          // verifyToken → null (e.g. a Supabase/realtime JWT, not our HMAC)
        h.user = ownerNoManage;    // would be returned IF any user lookup ran — it must NOT run
        const res = mockRes();
        await handler(mockReq('operation:update_phase', { operationId: OP_ID, phaseId: 1, data: {} }), res);
        expect(res.statusCode).toBe(401);
        expect(h.calls.getUserById).toBe(0);
        expect(h.calls.handlerCalls).toHaveLength(0);
    });
});

describe('Finding 1 — owner bypass excludes finance/payout/alert/participant/status actions', () => {
    it('op OWNER lacking operations:manage is DENIED a finance action (set_payout_splits)', async () => {
        h.decoded = { userId: OWNER_ID };
        h.user = ownerNoManage;

        const res = mockRes();
        await handler(mockReq('operation:set_payout_splits', { operationId: OP_ID, splits: [] }), res);

        // Fail-closed: 403, handler never reached.
        expect(res.statusCode).toBe(403);
        expect(h.calls.handlerCalls).not.toContain('operation:set_payout_splits');
        // The excluded finance action must not trigger the ownership fetch at all
        // (it can never grant the bypass).
        expect(h.calls.getFullOperationDetails).toBe(0);
    });

    it.each([
        'operation:add_uec',
        'operation:broadcast_alert',
        'operation:update_status',
    ])('op OWNER lacking operations:manage is DENIED %s (excluded from bypass)', async (action) => {
        h.decoded = { userId: OWNER_ID };
        h.user = ownerNoManage;

        const res = mockRes();
        await handler(mockReq(action, { operationId: OP_ID }), res);

        expect(res.statusCode).toBe(403);
        expect(h.calls.handlerCalls).not.toContain(action);
        expect(h.calls.getFullOperationDetails).toBe(0);
    });

    it('op OWNER lacking operations:manage is ALLOWED an owner-appropriate edit (update_phase) via the bypass', async () => {
        h.decoded = { userId: OWNER_ID };
        h.user = ownerNoManage;

        const res = mockRes();
        await handler(mockReq('operation:update_phase', { operationId: OP_ID, phaseId: 1, data: {} }), res);

        // Owner-bypass path: allowed, handler reached.
        expect(res.statusCode).toBe(200);
        expect(h.calls.handlerCalls).toContain('operation:update_phase');
        // The bypass path consulted the ownership lookup (the only thing that
        // grants the owner access here).
        expect(h.calls.getFullOperationDetails).toBe(1);
    });

    it('a NON-owner lacking operations:manage is still DENIED an owner-appropriate edit (bypass is owner-only)', async () => {
        h.decoded = { userId: OWNER_ID };
        h.user = ownerNoManage;
        h.op = { id: OP_ID, ownerId: 999 }; // someone else owns it

        const res = mockRes();
        await handler(mockReq('operation:update_phase', { operationId: OP_ID, phaseId: 1, data: {} }), res);

        expect(res.statusCode).toBe(403);
        expect(h.calls.handlerCalls).not.toContain('operation:update_phase');
        // The lookup was consulted (no perm → must check ownership) but denied.
        expect(h.calls.getFullOperationDetails).toBe(1);
    });
});

describe('Finding 2 — ownership fetch is skipped when the caller already holds the permission', () => {
    it('manager (operations:manage) on a finance action: ALLOWED, getFullOperationDetails NOT called', async () => {
        h.decoded = { userId: managerUser.id };
        h.user = managerUser;

        const res = mockRes();
        await handler(mockReq('operation:set_payout_splits', { operationId: OP_ID, splits: [] }), res);

        expect(res.statusCode).toBe(200);
        expect(h.calls.handlerCalls).toContain('operation:set_payout_splits');
        // The cheap permission check passed → the ~11-query op fetch must NOT run.
        expect(h.calls.getFullOperationDetails).toBe(0);
    });

    it('manager (operations:manage) on an owner-bypassable action: ALLOWED, getFullOperationDetails NOT called', async () => {
        h.decoded = { userId: managerUser.id };
        h.user = managerUser;

        const res = mockRes();
        await handler(mockReq('operation:update_phase', { operationId: OP_ID, phaseId: 1, data: {} }), res);

        expect(res.statusCode).toBe(200);
        expect(h.calls.handlerCalls).toContain('operation:update_phase');
        // hasPerm short-circuits the bypass fetch entirely — no authorization
        // outcome change, only redundant work avoided.
        expect(h.calls.getFullOperationDetails).toBe(0);
    });
});

describe('OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS — exported allow-list contract', () => {
    it('contains every finance/payout/alert/participant-mutation/status action', async () => {
        const { OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS } = await import('../api/services');
        for (const a of [
            'operation:add_uec',
            'operation:add_cost',
            'operation:set_payout_mode',
            'operation:set_payout_splits',
            'operation:toggle_payout_paid',
            'operation:reset_readiness',
            'operation:add_participant',
            'operation:update_participant',
            'operation:broadcast_alert',
            'operation:update_status',
        ]) {
            expect(OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS.has(a)).toBe(true);
        }
    });

    it('every excluded action is gated at operations:manage in the permission map (no over-restriction of view-tier actions)', async () => {
        const { OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS, fullPermissionMap } = await import('../api/services');
        for (const a of OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS) {
            expect(fullPermissionMap[a]).toBe('operations:manage');
        }
    });

    it('does NOT exclude owner-appropriate edit/lifecycle actions (owner can still edit own op)', async () => {
        const { OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS } = await import('../api/services');
        // These remain owner-bypassable so a legitimate owner is not broken.
        for (const a of [
            'operation:update',
            'operation:update_phase',
            'operation:add_phase',
            'operation:update_task',
            'operation:save_board',
        ]) {
            expect(OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS.has(a)).toBe(false);
        }
    });
});
