import { describe, it, expect, vi, beforeEach } from 'vitest';

// Endpoint-level tests for the realtime slice query subsets
// (GET /api/query?target=state&subset=users_slice|operation_slice|operation_templates):
//   1. users_slice flows through the SHARED return path, so the generic
//      per-requester field strip (stripSensitiveUserFieldsBulk — the REAL
//      implementation, not a mock) applies exactly as it does for 'main'.
//   2. ?ids validation is strict: reject (400) on missing/malformed/oversized
//      input rather than silently dropping tokens; dedupe before fetching;
//      accept both CSV and repeated-param forms.
//   3. operation_slice / operation_templates are permission-gated at
//      operations:view, mirroring the 'operations' subset.

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    sliceUsers: [] as unknown[],
    sliceOp: null as unknown,
    calls: {
        usersSlice: [] as number[][],
        opSlice: [] as Array<{ id: string; userId?: unknown }>,
        templates: 0,
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
    getUsersByIdsLite: async (ids: number[]) => { h.calls.usersSlice.push(ids); return h.sliceUsers; },
    // users_slice now issues the availability probe alongside the roster rows
    // (Phase 3 item 2 — the scalar rides every user_update-triggered response).
    // This factory hand-lists its exports, so an unmocked db.* call throws.
    isAnyStaffOnDuty: async () => true,
    getOperationByIdLite: async (id: string, user: { id?: unknown } | null) => { h.calls.opSlice.push({ id, userId: user?.id }); return h.sliceOp; },
    listOperationTemplates: async () => { h.calls.templates++; return [{ id: 1, name: 'tpl' }]; },
}));

import handler from '../api/query';

function mockRes() {
    const res: any = { statusCode: 0, body: undefined, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
function mockReq(query: Record<string, unknown>) {
    return { method: 'GET', query, headers: { authorization: 'Bearer tok' } } as any;
}

const clientUser = { id: 5, role: 'Client', permissions: [], auth_user_id: 'u5' };
const memberUser = { id: 6, role: 'Member', permissions: ['operations:view'], auth_user_id: 'u6' };
// users_slice is STAFF-gated as of Phase 3 item 3 (getMainState no longer ships the
// roster to a non-staff caller, so the old "they already have it all in main"
// justification is gone). The ids-validation and field-strip suites below are about
// PARSING and REDACTION, not entitlement, so they run under a staff fixture and keep
// pinning exactly what they were written to pin. The entitlement gate itself is
// asserted in both directions in tests/rosterEgressGates.test.ts.
const staffUser = { id: 6, role: 'Member', permissions: ['user:view:roster'], auth_user_id: 'u6' };

beforeEach(() => {
    h.decoded = { userId: 5 };
    h.user = clientUser;
    h.sliceUsers = [];
    h.sliceOp = null;
    h.calls = { usersSlice: [], opSlice: [], templates: 0 };
});

describe('subset=users_slice — strict ids validation', () => {
    it('400 when ids is missing', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice' }), res);
        expect(res.statusCode).toBe(400);
        expect(h.calls.usersSlice).toHaveLength(0);
    });

    it('400 on ANY malformed token (no silent partial match)', async () => {
        for (const ids of ['1,abc', '-3', '1.5', '1,,2', 'NaN']) {
            const res = mockRes();
            await handler(mockReq({ target: 'state', subset: 'users_slice', ids }), res);
            expect(res.statusCode, `ids=${ids}`).toBe(400);
        }
        expect(h.calls.usersSlice).toHaveLength(0);
    });

    it('400 when more than 100 ids are requested', async () => {
        const ids = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice', ids }), res);
        expect(res.statusCode).toBe(400);
        expect(h.calls.usersSlice).toHaveLength(0);
    });

    it('dedupes ids and accepts both CSV and repeated-param forms', async () => {
        // 200-path: needs the staff entitlement now, or the parse assertions below
        // never run.
        h.decoded = { userId: 6 }; h.user = staffUser;
        let res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice', ids: '1,2,2,3' }), res);
        expect(res.statusCode).toBe(200);
        expect(h.calls.usersSlice[0]).toEqual([1, 2, 3]);

        res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice', ids: ['4', '5,6'] }), res);
        expect(res.statusCode).toBe(200);
        expect(h.calls.usersSlice[1]).toEqual([4, 5, 6]);
    });

    it('403 without an authenticated user', async () => {
        h.decoded = null; h.user = null;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice', ids: '1' }), res);
        expect(res.statusCode).toBe(403);
        expect(h.calls.usersSlice).toHaveLength(0);
    });
});

describe('subset=users_slice — per-requester field strip (real userFilters)', () => {
    const SECRET_ADMIN = 'SECRET-ADMIN-NOTE';
    const SECRET_PNOTE = 'SECRET-PERSONNEL-NOTE';
    const targetUser = () => ({
        id: 7, name: 'Target', discordId: '99887766',
        adminNotes: SECRET_ADMIN, personnelNotes: SECRET_PNOTE,
        conductRecord: [{ id: 1, reason: 'x' }], limitingMarkers: [{ id: 9 }],
        rsiVerificationCode: 'verify-me',
    });

    it('a non-privileged requester gets the row with every sensitive field stripped', async () => {
        // "Non-privileged" here means "holds no HR/roster-admin capability", NOT "not
        // staff": this test is about the per-field STRIP, and a caller who cannot reach
        // the subset at all would assert nothing about it. user:view:roster is the
        // seeded Member default and buys none of the fields checked below.
        h.decoded = { userId: 6 }; h.user = staffUser;
        h.sliceUsers = [targetUser()];
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice', ids: '7' }), res);
        expect(res.statusCode).toBe(200);
        const row = res.body.users[0];
        expect(row.id).toBe(7);
        expect(row.adminNotes).toBeUndefined();
        expect(row.personnelNotes).toBeUndefined();
        expect(row.conductRecord).toEqual([]);
        expect(row.limitingMarkers).toEqual([]);
        expect(row.discordId).toBe('');
        expect(row.rsiVerificationCode).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toContain(SECRET_ADMIN);
        expect(JSON.stringify(res.body)).not.toContain(SECRET_PNOTE);
    });

    it('a NON-STAFF caller gets 403 even for their own id — user_detail is the self path', async () => {
        // Phase 3 item 3: there is no self carve-out on users_slice. A non-staff
        // viewer's own record reaches them through subset=user_detail (the identity
        // path SessionContext.refreshSelfIdentity uses), which allows self
        // unconditionally. Adding a self branch HERE would couple the roster gate to
        // the availability discriminator for no gain, and would give the wire shape a
        // third meaning: lib/db/users.ts getUsersByIdsLite and lib/sliceMerge.ts both
        // document `{users: []}` as unambiguously "deleted".
        h.decoded = { userId: 7 };
        h.user = { id: 7, role: 'Client', permissions: [], auth_user_id: 'u7' };
        h.sliceUsers = [targetUser()];
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice', ids: '7' }), res);
        expect(res.statusCode).toBe(403);
        expect(res.body.users).toBeUndefined();
        expect(h.calls.usersSlice).toHaveLength(0);
    });

    it('a STAFF caller viewing their own row keeps personnelNotes/conductRecord but never adminNotes', async () => {
        // Keeps stripSensitiveUserFields' isSelf branch covered on this route — the
        // 403 test above removes the only other self case from this file.
        h.decoded = { userId: 7 };
        h.user = { id: 7, role: 'Member', permissions: ['user:view:roster'], auth_user_id: 'u7' };
        h.sliceUsers = [targetUser()];
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice', ids: '7' }), res);
        expect(res.statusCode).toBe(200);
        const row = res.body.users[0];
        expect(row.personnelNotes).toBe(SECRET_PNOTE);
        expect(row.conductRecord).toHaveLength(1);
        expect(row.adminNotes).toBeUndefined();
    });
});

describe('subset=operation_slice — permission gate + null passthrough', () => {
    it('403 for a user without operations:view; fetcher never called', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'operation_slice', id: 'op-1' }), res);
        expect(res.statusCode).toBe(403);
        expect(h.calls.opSlice).toHaveLength(0);
    });

    it('400 when id is missing', async () => {
        h.decoded = { userId: 6 }; h.user = memberUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'operation_slice' }), res);
        expect(res.statusCode).toBe(400);
    });

    it('200 with { operation: null } when the op is absent/not visible (client removes the row)', async () => {
        h.decoded = { userId: 6 }; h.user = memberUser;
        h.sliceOp = null;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'operation_slice', id: 'op-1' }), res);
        expect(res.statusCode).toBe(200);
        expect('operation' in res.body).toBe(true);
        expect(res.body.operation).toBeNull();
        expect(h.calls.opSlice[0]).toEqual({ id: 'op-1', userId: 6 });
    });

    it('200 with the op for a permitted caller', async () => {
        h.decoded = { userId: 6 }; h.user = memberUser;
        h.sliceOp = { id: 'op-1', name: 'Strike' };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'operation_slice', id: 'op-1' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.operation.id).toBe('op-1');
    });
});

describe('subset=operation_templates — permission gate', () => {
    it('403 for a user without operations:view', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'operation_templates' }), res);
        expect(res.statusCode).toBe(403);
        expect(h.calls.templates).toBe(0);
    });

    it('200 with templates for a permitted caller', async () => {
        h.decoded = { userId: 6 }; h.user = memberUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'operation_templates' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.operationTemplates).toEqual([{ id: 1, name: 'tpl' }]);
        expect(h.calls.templates).toBe(1);
    });
});
