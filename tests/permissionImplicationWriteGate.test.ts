import { describe, it, expect, vi, beforeEach } from 'vitest';

// End-to-end pin for the DISPATCHER write gate (api/services.ts) after it was routed
// through the shared implication table (lib/permissionImplications.ts).
//
// The gate used to be `permissions.includes(requiredPerm)` PLUS one hand-inlined
// special case (`requiredPerm === 'intel:view' && permissions.includes(
// 'intel:view:clearance')`) folded into a six-way composite deny. That inline was the
// third copy of a rule the read gate and the boot aggregate each carried their own
// version of, and it left the Academy with no ladder at all on the write side:
//   * an academy:instruct-only Instructor could CREATE a course and was then 403'd on
//     academy:get_course / the staff bundle that contains it, and
//   * an academy:manage-only Learning Manager was shown the Course Builder by
//     AcademyHubView (pinned by tests/academyMenuGating.test.tsx) and 403'd on every
//     one of the 26 instruct-gated writes.
//
// What must NOT change is the DIRECTION. Ladders climb: a stronger permission
// satisfies a weaker gate and never the reverse. So the anti-regression half of this
// suite is as load-bearing as the widening half — an Instructor must never reach the
// Learning Manager's approve/certify authority, academy:view (documented as
// grantable to the org's external customers) must never reach a write, and the
// implication must not leak sideways out of its own domain.
//
// The composite's other disjuncts (op owner / unit leader / bulletin author / request
// lead) and the second, action-specific gates that run AFTER it are unchanged; the
// warrant:generate_report cases below pin that removing the dead `hasClearanceView`
// flag from the composite did not disturb them.

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    calls: {} as Record<string, number>,
}));

const bump = (k: string) => { h.calls[k] = (h.calls[k] ?? 0) + 1; };

function sbBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'update', 'delete', 'insert', 'single', 'maybeSingle']) b[m] = () => b;
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
    // The org-ban gate runs on every authenticated dispatcher request; null = not banned.
    findActiveBan: async () => null,
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    // Phase 3 item 5: the dispatcher's CLIENT_DENIED_NAMESPACES gate
    // (lib/clientNamespaces.ts) runs for every `academy:`-prefixed action, and this file
    // drives nine of them through the REAL dispatcher. post() below builds an actor with
    // no roleId, i.e. not a client — but the mock has to define the function at all, or
    // the prefix match short-circuits into `db.isClientCaller is not a function`. The
    // client-denied direction is pinned in tests/clientNamespaceDenial.test.ts.
    isClientCaller: async () => false,
    // Academy must be ON, or the namespace fails closed BEFORE the permission gate
    // and every academy assertion below would pass for the wrong reason.
    isOptionalFeatureEnabled: async () => true,
    createCourse: async () => { bump('createCourse'); return { id: 'c1' }; },
    getCourseDetail: async () => { bump('getCourseDetail'); return { id: 'c1', modules: [] }; },
    approveCourse: async () => { bump('approveCourse'); return { id: 'c1', status: 'published' }; },
    getDossier: async () => { bump('getDossier'); return { reports: [], warrants: [], requests: [] }; },
    filterIntelByClearance: (r: unknown[]) => r,
    generateReportFromWarrant: async () => { bump('generateReportFromWarrant'); return { id: 'r1' }; },
}));

import handler from '../api/services';

type Res = { statusCode: number; body: any; headers: Record<string, string>; status: (c: number) => Res; json: (b: unknown) => Res; setHeader: (k: string, v: string) => Res };
function mockRes(): Res {
    const res = { statusCode: 0, body: undefined, headers: {} } as Res;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
const asResponse = (r: Res) => r as unknown as import('express').Response;
function mockReq(action: string, payload: unknown = {}) {
    return { method: 'POST', secure: false, query: {}, headers: { authorization: 'Bearer tok' }, body: { action, payload } } as any;
}

/** Drive the real dispatcher as a custom role holding exactly `permissions`. */
async function post(permissions: string[], action: string, payload: unknown = {}): Promise<Res> {
    h.user = { id: 1, role: 'Member', permissions, isSystemAdmin: false };
    const res = mockRes();
    await handler(mockReq(action, payload), asResponse(res));
    return res;
}

beforeEach(() => {
    h.decoded = { userId: 1 };
    h.user = null;
    h.calls = {};
});

describe('write gate — the Academy ladder climbs', () => {
    // C1. The largest single widening in the cluster, and the one the client has been
    // promising all along: academy:manage satisfies the academy:instruct gate on all
    // 26 authoring actions. Assert the HANDLER ran, not merely "not 403" — an
    // undefined db stub would 500, which is also not 403 and would prove nothing.
    it('academy:manage reaches an academy:instruct-gated write', async () => {
        const res = await post(['academy:manage'], 'academy:create_course', { title: 'Nav 101' });
        expect(res.statusCode).toBe(200);
        expect(h.calls.createCourse).toBe(1);
    });

    // C2. The write-without-read-back defect: an Instructor could create a course and
    // was then refused the read of the course they had just authored.
    it('academy:instruct reaches an academy:view-gated read action', async () => {
        const res = await post(['academy:instruct'], 'academy:get_course', { courseId: 'c1' });
        expect(res.statusCode).toBe(200);
        expect(h.calls.getCourseDetail).toBe(1);
    });

    it('academy:manage also reaches the academy:view-gated read action', async () => {
        const res = await post(['academy:manage'], 'academy:get_course', { courseId: 'c1' });
        expect(res.statusCode).toBe(200);
        expect(h.calls.getCourseDetail).toBe(1);
    });
});

describe('write gate — the ladder never descends and never leaks sideways', () => {
    // C3. An Instructor must not gain the Learning Manager's approve authority.
    it('academy:instruct is still refused an academy:manage-gated action', async () => {
        const res = await post(['academy:instruct'], 'academy:approve_course', { courseId: 'c1' });
        expect(res.statusCode).toBe(403);
        expect(h.calls.approveCourse).toBeUndefined();
    });

    // C4. academy:view is documented as grantable to the org's external customers
    // (lib/staffPerms.ts) — it is a read and must never climb into authoring.
    it('academy:view is still refused an academy:instruct-gated write', async () => {
        const res = await post(['academy:view'], 'academy:create_course', { title: 'x' });
        expect(res.statusCode).toBe(403);
        expect(h.calls.createCourse).toBeUndefined();
    });

    // C6. "Gains none": the table has exactly three rows, so every other required
    // permission answers exactly as a bare includes() did.
    it('an unprivileged custom role gains nothing', async () => {
        expect((await post([], 'academy:create_course', { title: 'x' })).statusCode).toBe(403);
        expect((await post(['hr:view'], 'academy:get_course', { courseId: 'c1' })).statusCode).toBe(403);
        expect(h.calls.createCourse).toBeUndefined();
        expect(h.calls.getCourseDetail).toBeUndefined();
    });

    it('academy:manage buys nothing outside the Academy', async () => {
        expect((await post(['academy:manage'], 'intel:get_dossier', { targetId: 't1' })).statusCode).toBe(403);
        expect(h.calls.getDossier).toBeUndefined();
    });
});

describe('write gate — the intel synonym survives the refactor', () => {
    // C5. This was live behaviour via the hand-inlined `hasClearanceView` flag and was
    // COMPLETELY unpinned (`grep -rn hasClearanceView tests/` returned nothing), so
    // deleting that flag from the six-way composite could have silently dropped it.
    it('intel:view:clearance still satisfies an intel:view-gated action', async () => {
        const res = await post(['intel:view:clearance'], 'intel:get_dossier', { targetId: 't1' });
        expect(res.statusCode).toBe(200);
        expect(h.calls.getDossier).toBe(1);
    });

    // The direction that must never invert.
    it('intel:view does NOT climb to an intel:create-gated action', async () => {
        const res = await post(['intel:view'], 'intel:create_report', { targetId: 't1' });
        expect(res.statusCode).toBe(403);
    });
});

describe('write gate — the action-specific second gates still fire', () => {
    // C7. warrant:generate_report is mapped to intel:create and then requires
    // warrant:view in ADDITION, so an intel:create-only holder cannot launder
    // warrant:view-gated caution text into a classification-0 report. That gate runs
    // after the composite the refactor edited.
    it('intel:create alone is still refused warrant:generate_report', async () => {
        const res = await post(['intel:create'], 'warrant:generate_report', { warrantId: 'w1' });
        expect(res.statusCode).toBe(403);
        expect(h.calls.generateReportFromWarrant).toBeUndefined();
    });

    it('intel:view alone is still refused warrant:generate_report', async () => {
        const res = await post(['intel:view'], 'warrant:generate_report', { warrantId: 'w1' });
        expect(res.statusCode).toBe(403);
        expect(h.calls.generateReportFromWarrant).toBeUndefined();
    });

    // The positive control: without it the two denials above could be passing for an
    // unrelated reason (a missing stub, a mis-typed action name).
    it('intel:create + warrant:view reaches the handler', async () => {
        const res = await post(['intel:create', 'warrant:view'], 'warrant:generate_report', { warrantId: 'w1' });
        expect(res.statusCode).toBe(200);
        expect(h.calls.generateReportFromWarrant).toBe(1);
    });
});

describe('write gate — an unmapped protected action still fails closed', () => {
    // The BOLA gate denies any PROTECTED_PREFIXES action with no fullPermissionMap
    // entry. permissionSatisfied fails closed on an empty required string, so routing
    // the gate through it cannot turn a missing map entry into an allow.
    it('denies a protected action that has no permission map entry', async () => {
        const res = await post(['academy:manage'], 'academy:not_a_real_action', {});
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).not.toBe(200);
    });
});
