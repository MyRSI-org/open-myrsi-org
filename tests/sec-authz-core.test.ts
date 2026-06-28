import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// authz-core cluster — dispatcher/admin authorization checks.
//
//  - admin:update_platform_settings / admin:force_logout_all require the genuine
//    Admin ROLE (handler assertion) and a high-bar perm (not seeded admin:access).
//  - the dispatcher dispatches by OWN-property only — prototype-inherited names
//    ("constructor", …) are rejected and never echo the injected user record.
//  - voice-server (LiveKit) credential write is gated under radio:manage, not
//    the unrelated admin:config:branding bucket.
//  - the operation:update owner-bypass does NOT cover a STATUS change (those
//    always need operations:manage, like the excluded operation:update_status).
//  - warrant:generate_report additionally requires warrant:view, so an
//    intel:create-only holder can't launder warrant caution text into a report.
// =============================================================================

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    ops: {} as Record<string, { ownerId: number }>,
    spies: {
        getPlatformSettings: vi.fn(async () => ({} as Record<string, unknown>)),
        getUserById: vi.fn(async () => h.user),
        getFullOperationDetails: vi.fn(async (id: string) => (h.ops[id] ?? null)),
        updateOperationDetails: vi.fn(async (..._args: unknown[]) => ({})),
        generateReportFromWarrant: vi.fn(async () => ({ id: 'report-1' })),
        updatePlatformSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
    },
}));

// Chainable, awaitable Supabase stub — the operation:update handler may probe the
// operations row for the Discord-mirror block; resolve to a null row so it no-ops.
function sbBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'update', 'delete', 'insert', 'single', 'maybeSingle']) {
        b[m] = () => b;
    }
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return b;
}

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    isSessionForceLoggedOut: () => false,
    isSessionRevokedByWatermark: () => false,
}));

vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    getPlatformSettings: h.spies.getPlatformSettings,
    getUserById: h.spies.getUserById,
    getFullOperationDetails: h.spies.getFullOperationDetails,
    updateOperationDetails: h.spies.updateOperationDetails,
    generateReportFromWarrant: h.spies.generateReportFromWarrant,
    updatePlatformSettings: h.spies.updatePlatformSettings,
}));

// Import AFTER the mocks are registered.
import handler, {
    actions,
    fullPermissionMap,
    OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS,
} from '../api/services';
import { adminActions } from '../api/actions/admin';

type Res = {
    statusCode: number;
    body: any;
    headers: Record<string, string>;
    status: (c: number) => Res;
    json: (b: unknown) => Res;
    setHeader: (k: string, v: string) => Res;
};
function mockRes(): Res {
    const res = { statusCode: 0, body: undefined, headers: {} } as Res;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
// The dispatcher's default export is typed against express's Response; our mock
// implements only the surface it exercises (status/json/setHeader), so bridge the
// type at the call boundary without weakening what the assertions read off `res`.
const asResponse = (r: Res) => r as unknown as import('express').Response;
function mockReq(action: string, payload: unknown, token = 'tok') {
    return {
        method: 'POST',
        secure: false,
        query: {},
        headers: { authorization: `Bearer ${token}` },
        body: { action, payload },
    } as any;
}

beforeEach(() => {
    h.decoded = null;
    h.user = null;
    h.ops = {};
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// platform-lifecycle controls require the genuine Admin role + high-bar perm
// ---------------------------------------------------------------------------
describe('authz-core — platform-lifecycle Admin-role gate', () => {
    const updateSettings = (adminActions as Record<string, (p: unknown) => unknown>)['admin:update_platform_settings'];
    const forceLogout = (adminActions as Record<string, (p: unknown) => unknown>)['admin:force_logout_all'];

    it('handlers reject a non-Admin (Dispatcher) synchronously before any DB write', () => {
        expect(() => updateSettings({ user: { role: 'Dispatcher' }, maintenanceMode: true })).toThrow(/only an admin/i);
        expect(() => forceLogout({ user: { role: 'Dispatcher' } })).toThrow(/only an admin/i);
        expect(h.spies.updatePlatformSettings).not.toHaveBeenCalled();
    });

    it('handlers reject a missing/undefined actor (fail closed)', () => {
        expect(() => updateSettings({ maintenanceMode: true })).toThrow(/only an admin/i);
        expect(() => forceLogout({})).toThrow(/only an admin/i);
    });

    it('a genuine Admin is accepted and the expected patch is written', async () => {
        await updateSettings({ user: { role: 'Admin' }, maintenanceMode: true });
        expect(h.spies.updatePlatformSettings).toHaveBeenCalledWith({ maintenance_mode: true });

        await forceLogout({ user: { role: 'Admin' } });
        const arg = h.spies.updatePlatformSettings.mock.calls.at(-1)?.[0] as Record<string, unknown>;
        expect(typeof arg.force_logout_timestamp).toBe('string');
    });

    it('map gates these apex actions at a high-bar perm, NOT the seeded admin:access', () => {
        expect(fullPermissionMap['admin:update_platform_settings']).toBe('admin:db:destroy');
        expect(fullPermissionMap['admin:force_logout_all']).toBe('admin:db:destroy');
        expect(fullPermissionMap['admin:update_platform_settings']).not.toBe('admin:access');
        expect(fullPermissionMap['admin:force_logout_all']).not.toBe('admin:access');
        // The per-user session revoke remains the stronger update_role bar, so the
        // platform-wide controls are at least as strong as the single-user one.
        expect(fullPermissionMap['admin:revoke_user_sessions']).not.toBe('admin:access');
    });
});

// ---------------------------------------------------------------------------
// prototype-inherited pseudo-action dispatch is blocked (own-property only)
// ---------------------------------------------------------------------------
describe('authz-core — own-property dispatch guard', () => {
    it('registry pin: inherited names are NOT own keys (yet resolve truthy — the trap)', () => {
        expect(Object.prototype.hasOwnProperty.call(actions, 'constructor')).toBe(false);
        // Documents WHY truthiness was unsafe: the inherited member is a function.
        expect(typeof (actions as Record<string, unknown>).constructor).toBe('function');
        // Real actions ARE own keys, so the guard never rejects a legit action.
        expect(Object.prototype.hasOwnProperty.call(actions, 'admin:update_user')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(actions, 'operation:update')).toBe(true);
    });

    const inherited = ['constructor', 'valueOf', 'toString', 'hasOwnProperty', '__proto__', 'isPrototypeOf'];
    it.each(inherited)('dispatching inherited "%s" → 400 and never echoes the user record', async (name) => {
        h.decoded = { userId: 1 };
        h.user = { id: 1, role: 'Member', permissions: [], adminNotes: 'PRIVATE STAFF NOTE', tokensValidFrom: null };
        const res = mockRes();
        await handler(mockReq(name, {}), asResponse(res));

        expect(res.statusCode).toBe(400);
        expect(res.body?.data).toBeUndefined();
        // The injected fullUser (with admin-only adminNotes) must never reach the wire.
        expect(JSON.stringify(res.body ?? {})).not.toContain('PRIVATE STAFF NOTE');
    });
});

// ---------------------------------------------------------------------------
// secret-bearing config writes are siloed to their own permission
// ---------------------------------------------------------------------------
describe('authz-core — voice credential write not in the branding bucket', () => {
    it('admin:update_radio_config is gated at the dedicated radio:manage perm', () => {
        expect(fullPermissionMap['admin:update_radio_config']).toBe('radio:manage');
        expect(fullPermissionMap['admin:update_radio_config']).not.toBe('admin:config:branding');
    });

    it('NO secret-bearing config write maps to admin:config:branding (siloing invariant)', () => {
        for (const action of ['admin:update_radio_config', 'admin:update_discord_config', 'admin:update_ai_config']) {
            expect(fullPermissionMap[action], action).not.toBe('admin:config:branding');
        }
        // Each keeps its own dedicated credential permission.
        expect(fullPermissionMap['admin:update_discord_config']).toBe('admin:config:discord');
        expect(fullPermissionMap['admin:update_ai_config']).toBe('admin:config:ai');
    });
});

// ---------------------------------------------------------------------------
// operation:update owner-bypass must not cover a status change
// ---------------------------------------------------------------------------
describe('authz-core — owner-bypass excludes status changes via operation:update', () => {
    it('owner WITHOUT operations:manage cannot change status through operation:update', async () => {
        h.decoded = { userId: 7 };
        h.user = { id: 7, role: 'Member', permissions: ['operations:create'] };
        h.ops = { op1: { ownerId: 7 } }; // caller genuinely owns the op

        const res = mockRes();
        await handler(mockReq('operation:update', { operationId: 'op1', updates: { status: 'Concluded' } }), asResponse(res));

        expect(res.statusCode).toBe(403);
        expect(h.spies.updateOperationDetails).not.toHaveBeenCalled();
    });

    it('owner WITHOUT operations:manage can still make an ordinary (non-status) edit', async () => {
        h.decoded = { userId: 7 };
        h.user = { id: 7, role: 'Member', permissions: ['operations:create'] };
        h.ops = { op1: { ownerId: 7 } };

        const res = mockRes();
        await handler(mockReq('operation:update', { operationId: 'op1', updates: { maxParticipants: 5 } }), asResponse(res));

        expect(res.statusCode).toBe(200);
        expect(h.spies.updateOperationDetails).toHaveBeenCalledTimes(1);
        expect(h.spies.updateOperationDetails.mock.calls[0][0]).toBe('op1');
    });

    it('a holder of operations:manage CAN change status through operation:update', async () => {
        h.decoded = { userId: 8 };
        h.user = { id: 8, role: 'Member', permissions: ['operations:manage'] };

        const res = mockRes();
        await handler(mockReq('operation:update', { operationId: 'op1', updates: { status: 'Concluded' } }), asResponse(res));

        expect(res.statusCode).toBe(200);
        expect(h.spies.updateOperationDetails).toHaveBeenCalledTimes(1);
    });

    it('the manage-only status path stays excluded from the owner bypass (no drift)', () => {
        expect(OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS.has('operation:update_status')).toBe(true);
        expect(fullPermissionMap['operation:update']).toBe('operations:manage');
        expect(fullPermissionMap['operation:update_status']).toBe('operations:manage');
    });
});

// ---------------------------------------------------------------------------
// warrant:generate_report additionally requires warrant:view
// ---------------------------------------------------------------------------
describe('authz-core — warrant:generate_report requires warrant:view', () => {
    it('intel:create WITHOUT warrant:view is denied and the warrant is never read', async () => {
        h.decoded = { userId: 9 };
        h.user = { id: 9, role: 'Member', permissions: ['intel:create'] };

        const res = mockRes();
        await handler(mockReq('warrant:generate_report', { warrantId: 'w1' }), asResponse(res));

        expect(res.statusCode).toBe(403);
        expect(h.spies.generateReportFromWarrant).not.toHaveBeenCalled();
    });

    it('intel:create AND warrant:view is allowed', async () => {
        h.decoded = { userId: 10 };
        h.user = { id: 10, role: 'Member', permissions: ['intel:create', 'warrant:view'] };

        const res = mockRes();
        await handler(mockReq('warrant:generate_report', { warrantId: 'w1' }), asResponse(res));

        expect(res.statusCode).toBe(200);
        expect(h.spies.generateReportFromWarrant).toHaveBeenCalledTimes(1);
    });

    it('an Admin (role) with intel:create satisfies the warrant-visibility gate', async () => {
        h.decoded = { userId: 11 };
        h.user = { id: 11, role: 'Admin', permissions: ['intel:create'] };

        const res = mockRes();
        await handler(mockReq('warrant:generate_report', { warrantId: 'w1' }), asResponse(res));

        expect(res.statusCode).toBe(200);
        expect(h.spies.generateReportFromWarrant).toHaveBeenCalledTimes(1);
    });

    it('authoring is still gated at intel:create (the report-write permission)', () => {
        expect(fullPermissionMap['warrant:generate_report']).toBe('intel:create');
    });
});
