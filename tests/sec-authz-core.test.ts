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
//  - admin:list_testimonial_candidates additionally requires request:view:feedback,
//    so admin:config:branding is not a second, SEARCHABLE route to the free-text
//    client_feedback column that every other read path redacts per viewer.
//  - ADDING an id to featuredTestimonialIds (admin:update_public_page_config) is an
//    indirect read of that same column off the unauthenticated public page, so it
//    needs request:view:feedback too — and fails CLOSED when the stored baseline
//    cannot be read. Reorder/remove stays open to admin:config:branding.
// =============================================================================

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    ops: {} as Record<string, { ownerId: number }>,
    spies: {
        // The org-ban gate runs on every authenticated dispatcher request; null = not banned.
        findActiveBan: async () => null,
        getPlatformSettings: vi.fn(async () => ({} as Record<string, unknown>)),
        getUserById: vi.fn(async () => h.user),
        getFullOperationDetails: vi.fn(async (id: string) => (h.ops[id] ?? null)),
        updateOperationDetails: vi.fn(async (..._args: unknown[]) => ({})),
        generateReportFromWarrant: vi.fn(async () => ({ id: 'report-1' })),
        updatePlatformSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
        getTestimonialCandidates: vi.fn(async (..._args: unknown[]) => ({ items: [], total: 0 })),
        updatePublicPageConfig: vi.fn(async (..._args: unknown[]) => {}),
        getPublicSettings: vi.fn(async () => ({ publicPageConfig: { featuredTestimonialIds: ['SR-OLD'] } })),
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
    // The org-ban gate reads this on EVERY authenticated dispatcher request.
    findActiveBan: async () => null,
    supabase: sbBuilder(),
    getPlatformSettings: h.spies.getPlatformSettings,
    getUserById: h.spies.getUserById,
    getFullOperationDetails: h.spies.getFullOperationDetails,
    updateOperationDetails: h.spies.updateOperationDetails,
    generateReportFromWarrant: h.spies.generateReportFromWarrant,
    updatePlatformSettings: h.spies.updatePlatformSettings,
    getTestimonialCandidates: h.spies.getTestimonialCandidates,
    updatePublicPageConfig: h.spies.updatePublicPageConfig,
    getPublicSettings: h.spies.getPublicSettings,
    // Cache-free Admin-identity re-check for the recovery family (maintenance
    // toggle / force-logout-all). Default false: only the stamped flag admits.
    resolveIsSystemAdminFresh: async () => false,
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

    // Both are RECOVERY controls (they can lock out or sign out the whole platform),
    // so they re-resolve role identity CACHE-FREE on the deny path and are therefore
    // async: they reject rather than throwing synchronously. The danger zone stays
    // sync on the stamped flag (tests/dangerZoneAuthz.test.ts).
    it('handlers reject a non-Admin (Dispatcher) before any DB write', async () => {
        await expect(updateSettings({ user: { role: 'Dispatcher' }, maintenanceMode: true })).rejects.toThrow(/only an admin/i);
        await expect(forceLogout({ user: { role: 'Dispatcher' } })).rejects.toThrow(/only an admin/i);
        expect(h.spies.updatePlatformSettings).not.toHaveBeenCalled();
    });

    // ROLE NAME IS NOT AUTHORITY: `role` is name-derived, so a permissionless custom
    // role called 'Commander' could put the whole platform into maintenance mode —
    // a state only a real Admin can lift.
    it('handlers reject a forged Admin role NAME with no stamped identity', async () => {
        await expect(updateSettings({ user: { role: 'Admin' }, maintenanceMode: true })).rejects.toThrow(/only an admin/i);
        await expect(forceLogout({ user: { role: 'Admin' } })).rejects.toThrow(/only an admin/i);
        expect(h.spies.updatePlatformSettings).not.toHaveBeenCalled();
    });

    it('handlers reject a missing/undefined actor (fail closed)', async () => {
        await expect(updateSettings({ maintenanceMode: true })).rejects.toThrow(/only an admin/i);
        await expect(forceLogout({})).rejects.toThrow(/only an admin/i);
    });

    it('the stamped system Admin is accepted and the expected patch is written', async () => {
        await updateSettings({ user: { isSystemAdmin: true }, maintenanceMode: true });
        expect(h.spies.updatePlatformSettings).toHaveBeenCalledWith({ maintenance_mode: true });

        await forceLogout({ user: { isSystemAdmin: true } });
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

    // The gate is warrant:view ALONE — no role-name bypass. Admin, Dispatcher and
    // Member are all seeded with warrant:view, so an intel:create holder who is a
    // real staff member still passes; a permissionless custom role called 'Commander'
    // can no longer launder warrant caution text into a classification-0 report.
    it('an Admin-NAMED role with intel:create but no warrant:view is DENIED', async () => {
        h.decoded = { userId: 11 };
        h.user = { id: 11, role: 'Admin', permissions: ['intel:create'] };

        const res = mockRes();
        await handler(mockReq('warrant:generate_report', { warrantId: 'w1' }), asResponse(res));

        expect(res.statusCode).toBe(403);
        expect(h.spies.generateReportFromWarrant).not.toHaveBeenCalled();
    });

    it('authoring is still gated at intel:create (the report-write permission)', () => {
        expect(fullPermissionMap['warrant:generate_report']).toBe('intel:create');
    });
});

// ---------------------------------------------------------------------------
// admin:list_testimonial_candidates additionally requires request:view:feedback
// ---------------------------------------------------------------------------
describe('authz-core — testimonial candidate listing requires request:view:feedback', () => {
    it('admin:config:branding WITHOUT request:view:feedback is denied and no feedback is read', async () => {
        h.decoded = { userId: 20 };
        h.user = { id: 20, role: 'Member', permissions: ['admin:config:branding'] };

        const res = mockRes();
        await handler(mockReq('admin:list_testimonial_candidates', { search: 'refund' }), asResponse(res));

        expect(res.statusCode).toBe(403);
        // Denied before the DB round-trip: the free-text column never enters process memory.
        expect(h.spies.getTestimonialCandidates).not.toHaveBeenCalled();
    });

    it('admin:config:branding AND request:view:feedback is allowed', async () => {
        h.decoded = { userId: 21 };
        h.user = { id: 21, role: 'Member', permissions: ['admin:config:branding', 'request:view:feedback'] };

        const res = mockRes();
        await handler(mockReq('admin:list_testimonial_candidates', { search: 'refund' }), asResponse(res));

        expect(res.statusCode).toBe(200);
        expect(h.spies.getTestimonialCandidates).toHaveBeenCalledTimes(1);
    });

    it('an Admin-NAMED role with only the branding perm is DENIED', async () => {
        // Matches redactRequestFeedbackForViewer's maySee, which is now the permission
        // ALONE — the role NAME is inferred from operator-supplied free text, so it
        // admitted a permissionless custom role called 'Commander' to a searchable
        // dump of every client's candid feedback.
        h.decoded = { userId: 22 };
        h.user = { id: 22, role: 'Admin', permissions: ['admin:config:branding'] };

        const res = mockRes();
        await handler(mockReq('admin:list_testimonial_candidates', {}), asResponse(res));

        expect(res.statusCode).toBe(403);
        expect(h.spies.getTestimonialCandidates).not.toHaveBeenCalled();
    });

    it('request:view:feedback WITHOUT the branding perm is still denied (AND, not a swap)', async () => {
        // The seeded Dispatcher holds request:view:feedback; remapping the action to that
        // perm instead of ADDING the second check would hand the whole tier a new route.
        h.decoded = { userId: 23 };
        h.user = { id: 23, role: 'Dispatcher', permissions: ['request:view:feedback', 'request:accept'] };

        const res = mockRes();
        await handler(mockReq('admin:list_testimonial_candidates', {}), asResponse(res));

        expect(res.statusCode).toBe(403);
        expect(h.spies.getTestimonialCandidates).not.toHaveBeenCalled();
    });

    it('the primary gate stays on the branding perm (map pin)', () => {
        expect(fullPermissionMap['admin:list_testimonial_candidates']).toBe('admin:config:branding');
    });

    it('the handler asserts it too, so an in-process caller cannot bypass the dispatcher', async () => {
        const list = (adminActions as Record<string, (p: unknown) => Promise<unknown>>)['admin:list_testimonial_candidates'];

        await expect(list({ user: { id: 24, role: 'Member', permissions: ['admin:config:branding'] } }))
            .rejects.toThrow(/permission to read client feedback/i);
        // Fails closed on a missing actor too.
        await expect(list({})).rejects.toThrow(/permission to read client feedback/i);
        expect(h.spies.getTestimonialCandidates).not.toHaveBeenCalled();

        await list({ user: { id: 25, role: 'Member', permissions: ['request:view:feedback'] } });
        expect(h.spies.getTestimonialCandidates).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// publishing a testimonial is an indirect read of the same client_feedback column
// ---------------------------------------------------------------------------
describe('authz-core — publishing a testimonial requires request:view:feedback', () => {
    const brandingOnly = { id: 30, role: 'Member', permissions: ['admin:config:branding'] };

    it('a branding-only delegate cannot ADD an id to the featured list', async () => {
        h.decoded = { userId: 30 };
        h.user = { ...brandingOnly };

        const res = mockRes();
        await handler(mockReq('admin:update_public_page_config', { enabled: true, featuredTestimonialIds: ['SR-OLD', 'SR-NEW'] }), asResponse(res));

        expect(res.statusCode).toBe(403);
        expect(h.spies.updatePublicPageConfig).not.toHaveBeenCalled();
        // Distinct from the generic gate message, so a stale-config save is diagnosable.
        expect(String(res.body?.message)).toMatch(/View Client Feedback/i);
    });

    it('a branding-only delegate can still reorder/remove already-published ids', async () => {
        h.decoded = { userId: 30 };
        h.user = { ...brandingOnly };

        const res = mockRes();
        await handler(mockReq('admin:update_public_page_config', { featuredTestimonialIds: ['SR-OLD'] }), asResponse(res));

        expect(res.statusCode).toBe(200);
        expect(h.spies.updatePublicPageConfig).toHaveBeenCalledTimes(1);
    });

    it('a save that carries no featured list at all is untouched by the gate', async () => {
        h.decoded = { userId: 30 };
        h.user = { ...brandingOnly };

        const res = mockRes();
        await handler(mockReq('admin:update_public_page_config', { motto: 'Fly safe' }), asResponse(res));

        expect(res.statusCode).toBe(200);
        expect(h.spies.getPublicSettings).not.toHaveBeenCalled();
    });

    it('branding + request:view:feedback may add, and pays no baseline round-trip', async () => {
        h.decoded = { userId: 31 };
        h.user = { id: 31, role: 'Member', permissions: ['admin:config:branding', 'request:view:feedback'] };

        const res = mockRes();
        await handler(mockReq('admin:update_public_page_config', { featuredTestimonialIds: ['SR-OLD', 'SR-NEW'] }), asResponse(res));

        expect(res.statusCode).toBe(200);
        expect(h.spies.updatePublicPageConfig).toHaveBeenCalledTimes(1);
        expect(h.spies.getPublicSettings).not.toHaveBeenCalled();
    });

    it('an EMPTY stored baseline makes every incoming id an add → denied', async () => {
        h.decoded = { userId: 30 };
        h.user = { ...brandingOnly };
        h.spies.getPublicSettings.mockResolvedValueOnce({ publicPageConfig: { featuredTestimonialIds: [] } });

        const res = mockRes();
        await handler(mockReq('admin:update_public_page_config', { featuredTestimonialIds: ['SR-OLD'] }), asResponse(res));

        expect(res.statusCode).toBe(403);
        expect(h.spies.updatePublicPageConfig).not.toHaveBeenCalled();
    });

    it('fails CLOSED with a 403 when the baseline read THROWS (not a 500, not an allow)', async () => {
        // getPublicSettings falls back only on 42P01 and throws on every other error, so
        // the dispatcher must catch it: an unreadable baseline can never be treated as
        // "already contains these ids".
        h.decoded = { userId: 30 };
        h.user = { ...brandingOnly };
        h.spies.getPublicSettings.mockRejectedValueOnce(new Error('boom'));

        const res = mockRes();
        await handler(mockReq('admin:update_public_page_config', { featuredTestimonialIds: ['SR-OLD'] }), asResponse(res));

        expect(res.statusCode).toBe(403);
        expect(h.spies.updatePublicPageConfig).not.toHaveBeenCalled();
    });

    it('the primary gate stays on the branding perm (map pin)', () => {
        expect(fullPermissionMap['admin:update_public_page_config']).toBe('admin:config:branding');
    });
});
