import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 3 item 2 — the availability scalar, HANDLER half.
//
// tests/dutyAvailability.test.ts pins the DB probe itself against the real
// `../lib/db` barrel. This file pins the /api/query response shapes, which needs a
// MOCKED `../lib/db` — the two are mutually exclusive in one module graph, which is
// why they are separate files.
//
// Three contracts, in both directions:
//
//   1. `users_presence` answers 200 for EVERY authenticated tier. The duty_update
//      handler that drives it is attached UNCONDITIONALLY on the base channel
//      (contexts/DataCoreContext.tsx), so a 403 here would cost a wasted round-trip
//      on every duty flip in the org for every rosterless caller and — decisively —
//      the loss of the one scalar those callers are entitled to.
//   2. The `usersPresence` LIST is a ROSTER surface (it enumerates every live user id
//      plus each one's lastActiveAt, which would make a ?id=1..N user_detail walk
//      trivial), so it is withheld from a non-staff caller by the SAME predicate as
//      the `main` bundle projection and the users_slice / user_detail gates. The
//      non-staff branch must not merely return an empty array — it must NOT ISSUE
//      the query at all.
//   3. The scalar's FAIL DIRECTION survives the handler: `null` means "the probe
//      could not answer" and must never be flattened to `false` on the wire.
//
// The users_slice leg is asserted under a STAFF fixture on purpose: Phase 3 item 3
// gates that subset to staff (403), and the scalar rides its 200 for the callers who
// still reach it. A non-staff caller's live carrier is users_presence.

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    presence: [] as Array<{ userId: number; isDuty: boolean; lastActiveAt: string | null }>,
    onDuty: true as boolean | null,
    calls: { presence: 0, probe: 0, usersSlice: [] as number[][] },
}));

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    tokenIssuedAt: () => new Date(0),
    isSessionRevokedByWatermark: () => false,
    signRealtimeToken: () => 'rt-token',
}));
vi.mock('../lib/db', () => ({
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    // The read path now runs the ORG BAN GATE above every other gate.
    // Not banned by default; the ban tests drive the real module.
    findActiveBan: async () => null,
    getBanNotice: async () => null,
    getAllSettings: async () => ({}),
    // The factory hand-lists its exports, so an unmocked db.* call throws — which is
    // exactly how a future handler edit that forgets one of these gets caught.
    getUsersPresenceState: async () => { h.calls.presence++; return { usersPresence: h.presence }; },
    isAnyStaffOnDuty: async () => { h.calls.probe++; return h.onDuty; },
    getUsersByIdsLite: async (ids: number[]) => { h.calls.usersSlice.push(ids); return ids.map((id) => ({ id, name: `u${id}` })); },
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

// The org's external customer: authenticated, zero permissions, no staff capability.
const clientUser = { id: 5, role: 'Client', permissions: [], auth_user_id: 'u5' };
// Staff by the SHARED predicate (lib/staffPerms.ts) — a seeded Member default.
const staffUser = { id: 6, role: 'Member', permissions: ['user:view:roster'], auth_user_id: 'u6' };
// A hand-pruned Admin: no permissions at all, staff by the server-stamped identity flag.
const adminUser = { id: 7, role: 'Admin', permissions: [], isSystemAdmin: true, auth_user_id: 'u7' };

const CENSUS = [
    { userId: 6, isDuty: true, lastActiveAt: '2026-01-01T00:00:00Z' },
    { userId: 8, isDuty: false, lastActiveAt: null },
];

beforeEach(() => {
    h.decoded = { userId: 5 };
    h.user = clientUser;
    h.presence = [...CENSUS];
    h.onDuty = true;
    h.calls = { presence: 0, probe: 0, usersSlice: [] };
});

describe('subset=users_presence — the scalar reaches every tier', () => {
    it('9. 200 for a Client with zero permissions, carrying anyStaffOnDuty', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_presence' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.anyStaffOnDuty).toBe(true);
        expect(h.calls.probe).toBe(1);
    });

    it('10. 200 for a staff member, carrying the scalar', async () => {
        h.decoded = { userId: 6 }; h.user = staffUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_presence' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.anyStaffOnDuty).toBe(true);
    });

    it('11. a faulting probe rides the wire as null — NEVER false', async () => {
        // `false` is "nobody is on duty", an assertion of fact. `null` is "we could not
        // find out". The client renders a third, honest frame for null and keeps its
        // last known answer; flattening to false would deny the customer flow while
        // telling them a falsehood about why.
        h.onDuty = null;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_presence' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.anyStaffOnDuty).toBeNull();
        expect(res.body.anyStaffOnDuty).not.toBe(false);
    });

    it('11b. `false` survives the wire and is not dropped as falsy', async () => {
        h.onDuty = false;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_presence' }), res);
        expect(res.body).toHaveProperty('anyStaffOnDuty');
        expect(res.body.anyStaffOnDuty).toBe(false);
    });
});

describe('subset=users_presence — the LIST is a roster surface', () => {
    it('12. a non-staff caller gets { usersPresence: [] } and getUsersPresenceState is NEVER CALLED', async () => {
        // Don't-fetch, not fetch-then-empty: the census enumerates every live user id in
        // the org. A query that was never issued cannot leak.
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_presence' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.usersPresence).toEqual([]);
        expect(h.calls.presence).toBe(0);
        // …and the one thing they ARE entitled to still arrives.
        expect(res.body.anyStaffOnDuty).toBe(true);
    });

    it('13. a staff caller gets the full census (the regression floor)', async () => {
        h.decoded = { userId: 6 }; h.user = staffUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_presence' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.usersPresence).toHaveLength(2);
        expect(res.body.usersPresence[0].userId).toBe(6);
        expect(h.calls.presence).toBe(1);
    });

    it('13b. a hand-pruned Admin (isSystemAdmin, no permissions) still gets the census', async () => {
        // The first disjunct of the shared staff predicate is the server-stamped
        // identity flag, not a permission — an Admin role with its array pruned to
        // nothing must not lose its own org's directory.
        h.decoded = { userId: 7 }; h.user = adminUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_presence' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.usersPresence).toHaveLength(2);
        expect(h.calls.presence).toBe(1);
    });

    it('13c. an unauthenticated caller gets 403 and neither query runs', async () => {
        h.decoded = null; h.user = null;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_presence' }), res);
        expect(res.statusCode).toBe(403);
        expect(h.calls.presence).toBe(0);
        expect(h.calls.probe).toBe(0);
    });
});

describe('subset=users_slice — the role-change freshness carrier', () => {
    it('14. carries anyStaffOnDuty alongside the rows for a caller entitled to reach it', async () => {
        // Role changes and soft-deletes change the availability answer and emit
        // `user_update`, which the client routes to users_slice — never to
        // users_presence. Without the scalar here the answer goes stale on every
        // demotion for the whole window between a page load and the next duty flip.
        h.decoded = { userId: 6 }; h.user = staffUser;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice', ids: '8' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.anyStaffOnDuty).toBe(true);
        expect(h.calls.usersSlice[0]).toEqual([8]);
    });
});
