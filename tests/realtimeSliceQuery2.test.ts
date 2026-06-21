import { describe, it, expect, vi, beforeEach } from 'vitest';

// Endpoint-level tests for the realtime slice subsets
// (government_* / hr_* / fleet_* / warrant_slice / intel_summary /
// bulletin_slice / wiki_page_slice):
//   1. Every subset is permission-gated at its parent bundle's gate —
//      a caller without the permission 403s BEFORE any db fetch.
//   2. The HR per-array subsets re-apply the REAL viewer redaction (the
//      helpers are imported from the actual lib/db/hr module, not mocked) —
//      a base hr:view caller never receives applicant PII or vettingData.
//   3. wiki_page_slice re-applies the REAL filterByClearance gate — an
//      above-clearance page comes back as null (client removes the row).
//   4. Single-row subsets return null passthrough (not 404) so the client
//      merge can remove rows.

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    warrant: null as unknown,
    bulletin: null as unknown,
    wikiPage: null as unknown,
    hrApplicants: [] as unknown[],
    calls: {
        warrantSlice: [] as string[],
        bulletinSlice: [] as Array<{ id: string; userId?: unknown }>,
        govElections: 0,
        govStructure: 0,
        fleetCatalog: 0,
        intelSummary: 0,
        hrApplicants: 0,
    },
}));

vi.mock('../lib/auth', () => ({ verifyToken: () => h.decoded, tokenIssuedAt: () => new Date(0), isSessionRevokedByWatermark: () => false }));
vi.mock('../lib/db', async () => {
    // The HR redaction helpers are REAL — these tests pin that the per-array
    // subsets cannot regress the viewer redaction by skipping them.
    const hr = await vi.importActual<typeof import('../lib/db/hr')>('../lib/db/hr');
    return {
        getPlatformSettings: async () => ({}),
        getUserById: async () => h.user,
        getAllSettings: async () => ({}),
        // HR — real redaction, controllable rows
        isHrRecruiter: hr.isHrRecruiter,
        redactApplicantsForViewer: hr.redactApplicantsForViewer,
        redactInterviewsForViewer: hr.redactInterviewsForViewer,
        redactTransfersForViewer: hr.redactTransfersForViewer,
        getHRApplications: async () => { h.calls.hrApplicants++; return h.hrApplicants; },
        getAllHRInterviews: async () => [],
        getTransferRequests: async () => [],
        getJobPostings: async () => [],
        getHRInterviewTemplates: async () => [],
        getPersonnelPositions: async () => [],
        // Government
        getGovernmentStructureState: async () => { h.calls.govStructure++; return { governmentBranches: [] }; },
        getElectionsState: async () => { h.calls.govElections++; return [{ id: 1 }]; },
        getLegislationState: async () => [],
        getMotionsState: async () => [],
        // Fleet
        getShipCatalog: async () => { h.calls.fleetCatalog++; return [{ id: 1 }]; },
        getUserShips: async () => [],
        getFleetGroups: async () => [],
        // Warrants / intel / wiki
        getWarrantByIdHydrated: async (id: string) => { h.calls.warrantSlice.push(id); return h.warrant; },
        getIntelTargetIndex: async () => { h.calls.intelSummary++; return []; },
        getIntelHubStats: async () => ({ totalReports: 0, criticalCount: 0, recentCount7d: 0 }),
        getBulletinByIdForViewer: async (id: string, user: { id?: unknown } | null) => { h.calls.bulletinSlice.push({ id, userId: user?.id }); return h.bulletin; },
        getWikiPageById: async () => h.wikiPage,
    };
});

import handler from '../api/query';

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

const noPermsUser = { id: 5, role: 'Client', permissions: [], auth_user_id: 'u5' };

beforeEach(() => {
    h.decoded = { userId: 5 };
    h.user = noPermsUser;
    h.warrant = null;
    h.bulletin = null;
    h.wikiPage = null;
    h.hrApplicants = [];
    h.calls = { warrantSlice: [], bulletinSlice: [], govElections: 0, govStructure: 0, fleetCatalog: 0, intelSummary: 0, hrApplicants: 0 };
});

describe('round-2 slice subsets are permission-gated at the parent bundle gate', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
        ['government_structure', {}],
        ['government_elections', {}],
        ['government_legislation', {}],
        ['government_motions', {}],
        ['hr_applicants', {}],
        ['hr_interviews', {}],
        ['hr_jobs', {}],
        ['hr_templates', {}],
        ['hr_transfers', {}],
        ['hr_positions', {}],
        ['fleet_catalog', {}],
        ['fleet_user_ships', {}],
        ['fleet_groups', {}],
        ['warrant_slice', { id: 'w1' }],
        ['intel_summary', {}],
        ['bulletin_slice', { id: 'b1' }],
        ['wiki_page_slice', { id: 'p1' }],
    ];
    for (const [subset, extra] of cases) {
        it(`${subset} → 403 for a caller without the gate permission; no db fetch`, async () => {
            const res = mockRes();
            await handler(req({ target: 'state', subset, ...extra }), res);
            expect(res.statusCode).toBe(403);
        });
    }
    it('no fetcher ran during the gate sweep', () => {
        expect(h.calls.govElections + h.calls.govStructure + h.calls.fleetCatalog + h.calls.intelSummary + h.calls.hrApplicants).toBe(0);
        expect(h.calls.warrantSlice).toHaveLength(0);
        expect(h.calls.bulletinSlice).toHaveLength(0);
    });
});

describe('permitted callers reach the slice producers', () => {
    it('government_elections returns only the elections key', async () => {
        h.user = { ...noPermsUser, permissions: ['gov:view'] };
        const res = mockRes();
        await handler(req({ target: 'state', subset: 'government_elections' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.governmentElections).toEqual([{ id: 1 }]);
        expect(res.body.governmentLegislation).toBeUndefined();
        expect(h.calls.govElections).toBe(1);
        expect(h.calls.govStructure).toBe(0);
    });

    it('fleet_catalog returns only the shipCatalog key', async () => {
        h.user = { ...noPermsUser, permissions: ['fleet:view'] };
        const res = mockRes();
        await handler(req({ target: 'state', subset: 'fleet_catalog' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.shipCatalog).toEqual([{ id: 1 }]);
        expect(res.body.userShips).toBeUndefined();
    });

    it('intel:view:clearance synonym opens intel_summary (same as the intel bundle)', async () => {
        h.user = { ...noPermsUser, permissions: ['intel:view:clearance'] };
        const res = mockRes();
        await handler(req({ target: 'state', subset: 'intel_summary' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.intelHubStats).toBeDefined();
        expect(res.body.activeBulletins).toBeUndefined();
    });

    it('warrant_slice null passthrough (deleted warrant → client removes the row)', async () => {
        h.user = { ...noPermsUser, permissions: ['warrant:view'] };
        h.warrant = null;
        const res = mockRes();
        await handler(req({ target: 'state', subset: 'warrant_slice', id: 'w1' }), res);
        expect(res.statusCode).toBe(200);
        expect('warrant' in res.body).toBe(true);
        expect(res.body.warrant).toBeNull();
        expect(h.calls.warrantSlice).toEqual(['w1']);
    });

    it('warrant_slice / bulletin_slice / wiki_page_slice 400 without id', async () => {
        h.user = { ...noPermsUser, permissions: ['warrant:view', 'intel:view', 'wiki:view'] };
        for (const subset of ['warrant_slice', 'bulletin_slice', 'wiki_page_slice']) {
            const res = mockRes();
            await handler(req({ target: 'state', subset }), res);
            expect(res.statusCode, subset).toBe(400);
        }
    });

    it('bulletin_slice threads the requester into the clearance-filtered fetcher', async () => {
        h.user = { ...noPermsUser, permissions: ['intel:view'] };
        h.bulletin = { id: 'b1', title: 'Contact report' };
        const res = mockRes();
        await handler(req({ target: 'state', subset: 'bulletin_slice', id: 'b1' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.bulletin.id).toBe('b1');
        expect(h.calls.bulletinSlice).toEqual([{ id: 'b1', userId: 5 }]);
    });
});

describe('hr per-array subsets re-apply the REAL H2 viewer redaction', () => {
    const SECRET_NAME = 'SECRET-APPLICANT-NAME';
    const SECRET_VETTING = 'SECRET-VETTING-VERDICT';
    const applicantRow = () => ({
        id: 'app1', status: 'pending', createdAt: 't',
        applicantName: SECRET_NAME, rsiHandle: 'secret-handle', applicantDiscordId: '12345',
        referralSource: 'REFERRAL', notes: 'recruiter notes',
        vettingData: { comments: { rsiProfile: SECRET_VETTING } },
        interviews: [],
    });

    it('base hr:view caller gets applicants with ALL PII blanked', async () => {
        h.user = { ...noPermsUser, permissions: ['hr:view'] };
        h.hrApplicants = [applicantRow()];
        const res = mockRes();
        await handler(req({ target: 'state', subset: 'hr_applicants' }), res);
        expect(res.statusCode).toBe(200);
        const a = res.body.hr.applicants[0];
        expect(a.applicantName).toBe('');
        expect(a.rsiHandle).toBe('');
        expect(a.applicantDiscordId).toBe('');
        expect(a.referralSource).toBeUndefined();
        expect(a.notes).toBeUndefined();
        expect(a.vettingData).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toContain(SECRET_NAME);
        expect(JSON.stringify(res.body)).not.toContain(SECRET_VETTING);
    });

    it('hr:recruiter caller keeps applicant identity (but the producer strips vettingData upstream)', async () => {
        h.user = { ...noPermsUser, permissions: ['hr:view', 'hr:recruiter'] };
        h.hrApplicants = [{ ...applicantRow(), vettingData: undefined }];
        const res = mockRes();
        await handler(req({ target: 'state', subset: 'hr_applicants' }), res);
        const a = res.body.hr.applicants[0];
        expect(a.applicantName).toBe(SECRET_NAME);
        // vettingData NEVER rides a bulk list — only the
        // per-applicant hr:get_application_data lazy fetch.
        expect(a.vettingData).toBeUndefined();
    });
});

describe('wiki_page_slice re-applies the REAL clearance filter', () => {
    it('above-clearance page → { wikiPage: null } (client removes the row)', async () => {
        h.user = { ...noPermsUser, permissions: ['wiki:view'], clearanceLevel: { level: 0 } };
        h.wikiPage = { id: 'p1', title: 'Classified SOP', classificationLevel: 5, limitingMarkers: [] };
        const res = mockRes();
        await handler(req({ target: 'state', subset: 'wiki_page_slice', id: 'p1' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.wikiPage).toBeNull();
    });

    it('at-clearance page comes through', async () => {
        h.user = { ...noPermsUser, permissions: ['wiki:view'], clearanceLevel: { level: 5 } };
        h.wikiPage = { id: 'p1', title: 'SOP', classificationLevel: 5, limitingMarkers: [] };
        const res = mockRes();
        await handler(req({ target: 'state', subset: 'wiki_page_slice', id: 'p1' }), res);
        expect(res.body.wikiPage.id).toBe('p1');
    });

    it('marker-restricted page is hidden from a viewer without the marker even at clearance', async () => {
        h.user = { ...noPermsUser, permissions: ['wiki:view'], clearanceLevel: { level: 5 }, limitingMarkers: [] };
        h.wikiPage = { id: 'p1', title: 'Compartmented SOP', classificationLevel: 0, limitingMarkers: [{ id: 9, code: 'NDL' }] };
        const res = mockRes();
        await handler(req({ target: 'state', subset: 'wiki_page_slice', id: 'p1' }), res);
        expect(res.body.wikiPage).toBeNull();
    });
});
