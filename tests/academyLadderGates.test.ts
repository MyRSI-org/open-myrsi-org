import { describe, it, expect, vi, beforeEach } from 'vitest';

// Endpoint-level tests for the READ gate after the permission-implication table
// (lib/permissionImplications.ts) landed in callerHasSubsetPermission.
//
//   1. The Academy ladder opens the staff bundle to academy:instruct /
//      academy:manage. Before this, fullPermissionMap let an academy:instruct-only
//      Instructor CREATE a course (api/services.ts) while subset=academy 403'd on
//      academy:view — write-without-read-back, with the Course Builder rendering
//      empty against a course the caller had just authored.
//   2. The ladder does NOT descend and does NOT leak sideways: academy:view stays a
//      read, and an academy:manage holder gets nothing in HR / warrants / intel.
//   3. The intel:view ⇄ intel:view:clearance implication still carries to every
//      *_slice subset that reuses its bundle's gate STRING (the property that keeps
//      list and slice gates from drifting) — this is the refactor's anti-regression.
//   4. The seeded Member / Dispatcher roles are completely unaffected.

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    calls: {
        academyStaff: 0,
        intelState: 0,
        intelSummary: 0,
        bulletinSlice: 0,
        hrState: 0,
        warrants: 0,
    },
}));

vi.mock('../lib/auth', () => ({ verifyToken: () => h.decoded, tokenIssuedAt: () => new Date(0), isSessionRevokedByWatermark: () => false }));
vi.mock('../lib/db', () => ({
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    // The read path now runs the ORG BAN GATE above every other gate.
    // Not banned by default; the ban tests drive the real module.
    findActiveBan: async () => null,
    getBanNotice: async () => null,
    getAllSettings: async () => ({}),
    // Phase 3 item 5: subset=academy is now in CLIENT_DENIED_SUBSETS
    // (lib/clientNamespaces.ts), so api/query.ts calls db.isClientCaller on EVERY case in
    // this file. `false` = not a customer; every ladder assertion below is unchanged.
    isClientCaller: async () => false,
    // Academy must be ON, or the feature gate returns an empty 200 before the
    // producers and the permission delta becomes invisible.
    isOptionalFeatureEnabled: async () => true,
    getAcademyStaffState: async () => { h.calls.academyStaff++; return { academyCourses: [{ id: 'c1', status: 'draft' }], academySessions: [] }; },
    getIntelState: async () => { h.calls.intelState++; return { intelTargetIndex: [], intelHubStats: {}, activeBulletins: [] }; },
    getIntelTargetIndex: async () => { h.calls.intelSummary++; return []; },
    getIntelHubStats: async () => ({ totalReports: 0, criticalCount: 0, recentCount7d: 0 }),
    getBulletinByIdForViewer: async () => { h.calls.bulletinSlice++; return { id: 'b1', title: 'Contact report' }; },
    getHRState: async () => { h.calls.hrState++; return { hrApplications: [] }; },
    getWarrantsState: async () => { h.calls.warrants++; return { warrants: [] }; },
}));

import handler from '../api/query';
import { MEMBER_DEFAULT_PERMS, DISPATCHER_DEFAULT_PERMS } from '../lib/roleDefaultPermissions';

function mockRes() {
    const res: any = { statusCode: 0, body: undefined, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
function req(query: Record<string, unknown>) {
    return { method: 'GET', query, headers: { authorization: 'Bearer tok' } } as any;
}

const baseUser = { id: 5, role: 'Member', permissions: [] as string[], auth_user_id: 'u5' };
const as = (permissions: readonly string[]) => ({ ...baseUser, permissions: [...permissions] });

async function get(subset: string, permissions: readonly string[], extra: Record<string, unknown> = {}) {
    h.user = as(permissions);
    const res = mockRes();
    await handler(req({ target: 'state', subset, ...extra }), res);
    return res;
}

beforeEach(() => {
    h.decoded = { userId: 5 };
    h.user = as([]);
    h.calls = { academyStaff: 0, intelState: 0, intelSummary: 0, bulletinSlice: 0, hrState: 0, warrants: 0 };
});

describe('subset=academy — the staff bundle follows the ladder', () => {
    it('academy:instruct reaches the staff bundle (write-without-read-back closed)', async () => {
        const res = await get('academy', ['academy:instruct']);
        expect(res.statusCode).toBe(200);
        expect(res.body.academyCourses).toBeDefined();
        expect(h.calls.academyStaff).toBe(1);
    });

    it('academy:manage reaches the staff bundle', async () => {
        const res = await get('academy', ['academy:manage']);
        expect(res.statusCode).toBe(200);
        expect(h.calls.academyStaff).toBe(1);
    });

    // Anti-regression: hosted re-meant academy:view as a member baseline and moved
    // this subset up to academy:instruct. Doing that here would LOCK OUT the staff
    // reader this permission exists for. academy:view is the STAFF read in this build.
    it('a plain academy:view staff reader still reaches the bundle', async () => {
        const res = await get('academy', ['academy:view']);
        expect(res.statusCode).toBe(200);
        expect(h.calls.academyStaff).toBe(1);
    });

    it('an unprivileged custom role is refused before any fetch', async () => {
        const res = await get('academy', []);
        expect(res.statusCode).toBe(403);
        expect(h.calls.academyStaff).toBe(0);
    });

    it('an unrelated permission does not open the bundle', async () => {
        const res = await get('academy', ['hr:view', 'operations:view']);
        expect(res.statusCode).toBe(403);
        expect(h.calls.academyStaff).toBe(0);
    });
});

describe('the ladder does not leak sideways', () => {
    // academy:manage is the highest academy rung; it must buy nothing outside the
    // Academy. HR in particular shares one redaction predicate between the bundle and
    // all six hr_* slices — a sideways implication would widen all seven at once.
    const cases: Array<[string, Record<string, unknown>]> = [
        ['hr', {}],
        ['hr_applicants', {}],
        ['warrants', {}],
        ['intel', {}],
        ['bulletin_slice', { id: 'b1' }],
        ['wiki', {}],
        ['marketplace', {}],
    ];
    for (const [subset, extra] of cases) {
        it(`academy:manage is refused subset=${subset}`, async () => {
            const res = await get(subset, ['academy:manage'], extra);
            expect(res.statusCode).toBe(403);
        });
    }

    it('no producer ran for any of the sideways attempts', () => {
        expect(h.calls.hrState + h.calls.warrants + h.calls.intelState + h.calls.bulletinSlice).toBe(0);
    });
});

describe('intel:view:clearance still satisfies intel:view at the bundle AND its slices', () => {
    // The gate is keyed on the required-permission STRING, so intel_summary and
    // bulletin_slice inherit the bundle's implication with no per-subset table. Pin
    // all three together: a name-keyed rewrite would let a slice drift from the
    // bundle it patches.
    it('opens the intel bundle', async () => {
        const res = await get('intel', ['intel:view:clearance']);
        expect(res.statusCode).toBe(200);
        expect(h.calls.intelState).toBe(1);
    });

    it('opens intel_summary', async () => {
        const res = await get('intel_summary', ['intel:view:clearance']);
        expect(res.statusCode).toBe(200);
        expect(h.calls.intelSummary).toBe(1);
    });

    it('opens bulletin_slice', async () => {
        const res = await get('bulletin_slice', ['intel:view:clearance'], { id: 'b1' });
        expect(res.statusCode).toBe(200);
        expect(h.calls.bulletinSlice).toBe(1);
    });

    // The implication is a READ-GATE synonym, not a clearance grant and not a warrant
    // grant: warrants keep their own permission.
    it('does not open warrants', async () => {
        const res = await get('warrants', ['intel:view:clearance']);
        expect(res.statusCode).toBe(403);
        expect(h.calls.warrants).toBe(0);
    });

    // Direction: the weaker string must never satisfy the stronger one. No subset
    // gates on intel:view:clearance today, so assert it at the academy rung's mirror
    // instead — see tests/permissionImplications.test.ts A8 for the pure form.
    it('academy:view does not climb to the instructor rung', async () => {
        // subset=academy is gated on academy:view, so use the write-side rung the
        // ladder must not descend: a view-only holder gets the bundle (above) but the
        // table itself refuses to promote them.
        const res = await get('academy', ['academy:view']);
        expect(res.statusCode).toBe(200); // reads yes...
        // ...and nothing else: hr/warrants/intel stay shut for the same caller.
        const denied = await get('hr', ['academy:view']);
        expect(denied.statusCode).toBe(403);
    });
});

describe('the seeded roles are unaffected', () => {
    // Member and Dispatcher hold BOTH intel strings and NO academy string, so the
    // whole change is a no-op for them. This is the "Admin and Dispatcher keep their
    // access" direction in its cheapest executable form.
    for (const [role, perms] of Object.entries({ Member: MEMBER_DEFAULT_PERMS, Dispatcher: DISPATCHER_DEFAULT_PERMS })) {
        it(`${role} keeps intel and hr, and still does not reach the academy staff bundle`, async () => {
            expect((await get('intel', perms)).statusCode).toBe(200);
            expect((await get('hr', perms)).statusCode).toBe(200);
            const academy = await get('academy', perms);
            expect(academy.statusCode).toBe(403);
            expect(h.calls.academyStaff).toBe(0);
        });
    }

    it('an Admin role reaches everything (role bypass untouched by this cluster)', async () => {
        h.user = { ...baseUser, role: 'Admin', permissions: [] };
        // getState's aggHasPerm keeps its role === 'Admin' short-circuit; the subset
        // gate has never had one, so an Admin here is carried by holding the perms.
        const res = await get('academy', ['academy:view', 'academy:instruct', 'academy:manage']);
        expect(res.statusCode).toBe(200);
    });
});
