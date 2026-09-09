import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Phase 3 item 3 — the FOUR roster egress surfaces, gated with ONE predicate.
//
// Withholding the roster from the `main` bundle is decorative unless every other way
// to get it back is closed with the SAME predicate, so they cannot drift:
//   1. the `main` bundle projection            -> tests/mainBundleProjection.test.ts
//   2. subset=users_slice                      -> here
//   3. subset=user_detail, CROSS-USER only     -> here
//   4. subset=users_presence (the census list) -> tests/dutyAvailabilityQuery.test.ts
//
// TG-8 — HARNESS, STATED PLAINLY. `../lib/db` is MOCKED in this file, so:
//   * The users_slice / user_detail assertions are REAL: the gates live in
//     api/query.ts, above the db calls, and the "never called" halves prove the
//     handler refuses before it fetches.
//   * The initial-state / no-subset assertions are STUB-LEVEL WIRING tests. They
//     prove the boot path THREADS THE VIEWER into getState (and therefore into
//     getMainState) and passes the projection through untouched. They do NOT prove
//     what the projection contains — the only real don't-fetch proof in the wave is
//     tests/mainBundleProjection.test.ts test 2, which records every from(<table>)
//     against the real lib/db.
//
// Both directions everywhere: the denied party is denied AND the entitled party keeps
// access. Over-narrowing breaks the customer's only flow, which is not a safer failure.

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    detail: null as Record<string, unknown> | null,
    calls: {
        usersSlice: [] as number[][],
        getUserById: [] as number[],
        getState: [] as unknown[],
        getMainState: [] as unknown[],
    },
}));

function sbBuilder() {
    const b: any = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'single', 'maybeSingle']) {
        b[m] = () => b;
    }
    b.then = (resolve_: any) => resolve_({ count: 1, data: { id: 4 }, error: null });
    return b;
}

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    tokenIssuedAt: () => new Date(0),
    isSessionRevokedByWatermark: () => false,
    isSessionForceLoggedOut: () => false,
    signRealtimeToken: () => 'rt-token',
}));
vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    isSetupCompleted: async () => true,
    getPlatformSettings: async () => ({}),
    getAllSettings: async () => ({ brandingConfig: { name: 'Org', iconUrl: '/i.svg' } }),
    getUserById: async (id: number) => { h.calls.getUserById.push(id); return h.detail ?? h.user; },
    // The read path now runs the ORG BAN GATE above every other gate.
    // Not banned by default; the ban tests drive the real module.
    findActiveBan: async () => null,
    getBanNotice: async () => null,
    getUsersByIdsLite: async (ids: number[]) => { h.calls.usersSlice.push(ids); return ids.map(id => ({ id, name: `u${id}` })); },
    isAnyStaffOnDuty: async () => true,
    // Viewer-aware, matching the real getMainState: the staff half is ABSENT (not
    // empty) for a non-staff caller.
    getMainState: async (viewer?: { permissions?: string[]; isSystemAdmin?: boolean } | null) => {
        h.calls.getMainState.push(viewer);
        const perms = viewer?.permissions ?? [];
        const isStaff = viewer?.isSystemAdmin === true || perms.includes('user:view:roster') || perms.includes('admin:access');
        const always = { serviceTypes: [{ id: 1, name: 'Security', icon: 'i', color: '#fff', isActive: true }], anyStaffOnDuty: true, orgMeta: { features: { warehouse: { enabled: true } } } };
        return isStaff
            ? { users: [{ id: 9 }], roles: [], securityClearances: [], limitingMarkers: [], ...always }
            : always;
    },
    getState: async (viewer?: { permissions?: string[]; isSystemAdmin?: boolean } | null) => {
        h.calls.getState.push(viewer);
        const perms = viewer?.permissions ?? [];
        const isStaff = viewer?.isSystemAdmin === true || perms.includes('user:view:roster') || perms.includes('admin:access');
        const always = { serviceTypes: [{ id: 1, name: 'Security', icon: 'i', color: '#fff', isActive: true }], anyStaffOnDuty: true, orgMeta: { features: { warehouse: { enabled: true } } }, brandingConfig: { name: 'Org', iconUrl: '/i.svg' } };
        return isStaff
            ? { users: [{ id: 9 }], roles: [], securityClearances: [], limitingMarkers: [], ...always }
            : always;
    },
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

// The org's external customer. Zero permissions is the strongest witness.
const clientUser = { id: 5, role: 'Client', permissions: [], auth_user_id: 'u5' };
const staffUser = { id: 6, role: 'Member', permissions: ['user:view:roster'], auth_user_id: 'u6' };

const asClient = () => { h.decoded = { userId: 5 }; h.user = clientUser; };
const asStaff = () => { h.decoded = { userId: 6 }; h.user = staffUser; };

// handleState resolves the session itself with db.getUserById(decoded.userId) before
// the subset switch runs, so the FIRST recorded call is always the auth resolve. The
// user_detail assertions are about the calls after it.
const detailFetches = () => h.calls.getUserById.slice(1);

beforeEach(() => {
    asClient();
    h.detail = null;
    h.calls = { usersSlice: [], getUserById: [], getState: [], getMainState: [] };
});

describe('10-12 — subset=users_slice', () => {
    it('10. a non-staff caller gets 403 and getUsersByIdsLite is NEVER CALLED', async () => {
        // Both halves matter: the 403 SHAPE (200-with-empty would give `{users: []}` a
        // third meaning, where lib/db/users.ts and lib/sliceMerge.ts both document it as
        // unambiguously "deleted") and DON'T-FETCH.
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice', ids: '1,2,3' }), res);
        expect(res.statusCode).toBe(403);
        expect(h.calls.usersSlice).toHaveLength(0);
    });

    it('11. a staff caller gets the rows, fetched once with the ids (the regression floor)', async () => {
        asStaff();
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice', ids: '1,2,3' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.users).toHaveLength(3);
        expect(h.calls.usersSlice).toEqual([[1, 2, 3]]);
    });

    it('11b. a hand-pruned Admin (isSystemAdmin, no permissions) is staff here too', async () => {
        h.decoded = { userId: 7 };
        h.user = { id: 7, role: 'Admin', permissions: [], isSystemAdmin: true, auth_user_id: 'u7' };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice', ids: '1' }), res);
        expect(res.statusCode).toBe(200);
    });

    it('12. malformed ids still 400 for a NON-STAFF caller — the gate never masks validation', async () => {
        // The entitlement gate sits AFTER the id validation on purpose: a capability
        // denial must never hide a client bug behind a 403.
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'users_slice', ids: '1,abc' }), res);
        expect(res.statusCode).toBe(400);
        expect(h.calls.usersSlice).toHaveLength(0);
    });
});

describe('13-15 — subset=user_detail', () => {
    it('13. SELF is always allowed for a non-staff caller — the identity path must survive', async () => {
        // SessionContext hydrates the caller's own record through exactly this route
        // (fetchUserDetail / refreshSelfIdentity). Break this and Phase 3 item 2's whole
        // identity path is dead: a promoted Client never learns they were promoted.
        h.detail = { id: 5, name: 'Customer' };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'user_detail', id: '5' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.id).toBe(5);
        expect(detailFetches()).toEqual([5]);
    });

    it('14. CROSS-USER is 403 for a non-staff caller, and getUserById is NEVER CALLED', async () => {
        // Without this gate a non-staff caller walks ?id=1..N and reassembles the roster
        // one row at a time, defeating the bundle projection entirely. Don't fetch what
        // you will refuse.
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'user_detail', id: '9' }), res);
        expect(res.statusCode).toBe(403);
        expect(detailFetches()).toHaveLength(0);
    });

    it('14b. the denial is 403, not 404 — the id space is dense and a 404 would leak existence anyway', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'user_detail', id: '99999' }), res);
        expect(res.statusCode).toBe(403);
    });

    it('14c. a malformed id still 400s for a non-staff caller', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'user_detail', id: 'abc' }), res);
        expect(res.statusCode).toBe(400);
        expect(detailFetches()).toHaveLength(0);
    });

    it('15. CROSS-USER is allowed for staff', async () => {
        asStaff();
        h.detail = { id: 9, name: 'Other' };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'user_detail', id: '9' }), res);
        expect(res.statusCode).toBe(200);
        expect(detailFetches()).toEqual([9]);
    });
});

describe('16-19 — the boot / full-state paths (STUB-LEVEL WIRING, see the TG-8 header)', () => {
    it('16. a non-staff boot threads the viewer into getState and keeps the Client half', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'initial-state' }), res);
        expect(res.statusCode).toBe(200);
        // The viewer really reaches the projection — one projection point, not a second
        // filter bolted onto the boot route.
        expect(h.calls.getState).toHaveLength(1);
        expect((h.calls.getState[0] as { id: number }).id).toBe(5);
        expect(res.body.users).toBeUndefined();
        expect(res.body.roles).toBeUndefined();
        expect(res.body.securityClearances).toBeUndefined();
        expect(res.body.limitingMarkers).toBeUndefined();
        // …and everything a Client boots on survives.
        expect(res.body.currentUser?.id).toBe(5);
        expect(res.body.realtimeToken).toBe('rt-token');
        expect(res.body.serviceTypes).toHaveLength(1);
        expect(res.body.anyStaffOnDuty).toBe(true);
        // TG-9: `features` is the SOLE reader of orgMeta. Losing it silently collapses a
        // Client's nav to Dashboard / Requests / Account / Help.
        expect(res.body.orgMeta?.features).toEqual({ warehouse: { enabled: true } });
    });

    it('17. a staff boot still carries the roster (the regression floor)', async () => {
        asStaff();
        const res = mockRes();
        await handler(mockReq({ target: 'initial-state' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.users).toHaveLength(1);
        expect(res.body.securityClearances).toBeDefined();
    });

    it('18. subset=main keeps serviceTypes and brandingConfig for a non-staff caller', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        expect(res.statusCode).toBe(200);
        expect((h.calls.getMainState[0] as { id: number }).id).toBe(5);
        expect(res.body.users).toBeUndefined();
        expect(res.body.serviceTypes).toHaveLength(1);
        expect(res.body.brandingConfig).toBeDefined();
        expect(res.body.anyStaffOnDuty).toBe(true);
    });

    it('19. target=state with NO subset applies the SAME projection (the legacy path is not a hole)', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'state' }), res);
        expect(res.statusCode).toBe(200);
        expect(h.calls.getState).toHaveLength(1);
        expect((h.calls.getState[0] as { id: number }).id).toBe(5);
        expect(res.body.users).toBeUndefined();
        expect(res.body.serviceTypes).toHaveLength(1);
    });

    it('19b. …and the same path carries the roster for staff', async () => {
        asStaff();
        const res = mockRes();
        await handler(mockReq({ target: 'state' }), res);
        expect(res.body.users).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Source ratchets. Everything below pins a decision that is invisible at runtime
// until the exact failure it prevents happens, which is precisely why each one
// would otherwise be the first thing silently reverted.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(resolve(ROOT, ...p), 'utf8');

describe('TG-13 — `main` must never gain a SUBSET_REQUIRED_PERMISSION entry', () => {
    it('the map has no `main` key', () => {
        // A comment is not enforcement. `main` is auth-only BY DESIGN — a Client
        // legitimately reads serviceTypes, orgMeta.features and the settings blob out of
        // it — and its sensitive half is withheld INSIDE getMainState. A future
        // maintainer "hardening" this by adding a permission here would silently kill
        // every customer's request form.
        const src = read('api', 'query.ts');
        const start = src.indexOf('const SUBSET_REQUIRED_PERMISSION');
        expect(start).toBeGreaterThan(-1);
        const end = src.slice(start).search(/\r?\n\};/);
        expect(end).toBeGreaterThan(-1);
        const body = src.slice(start, start + end);
        expect(body).not.toMatch(/(^|\n)\s*main\s*:/);
        expect(body).not.toMatch(/(^|\n)\s*['"]main['"]\s*:/);
        // user_detail must stay unlisted too: a flat entry there would deny a Client
        // their own record and break the identity path. Its gate is inline and
        // self-exempt.
        expect(body).not.toMatch(/(^|\n)\s*user_detail\s*:/);
    });

    it('one projection point: getState passes the viewer to getMainState', () => {
        // This one change covers BOTH target=initial-state and the no-subset legacy full
        // state. A second projection at either call site would be a place to drift.
        const db = read('lib', 'db.ts');
        expect(db).toContain('getMainState(currentUser)');
        expect(db).toContain('export async function getMainState(viewer: MainStateViewer)');
    });
});

describe('TG-4 — the realtime attachment split in contexts/DataCoreContext.tsx', () => {
    const src = read('contexts', 'DataCoreContext.tsx');
    // CRLF-tolerant: this repo is developed on Windows, and an '\n'-only anchor
    // silently matches nothing there — which would make every assertion below pass or
    // fail for the wrong reason.
    const staffBlockStart = src.search(/if \(isStaffViewer\(\)\) \{\r?\n\s+\/\/ The ten personnel/);
    const staffBlock = (() => {
        const start = src.indexOf('const tableSubsets');
        const guard = src.indexOf('if (isStaffViewer())', start);
        const rel = src.slice(guard).search(/\r?\n {8}\}/);
        return src.slice(guard, guard + rel);
    })();
    const unconditionalBlock = (() => {
        const start = src.indexOf('const tableSubsets');
        return src.slice(start, src.indexOf('if (isStaffViewer())', start));
    })();

    it('the taxonomy tables sit INSIDE the staff guard', () => {
        // postgres_changes ships the FULL CHANGED ROW, so these two were the org's
        // clearance ladder and its compartment codeword catalogue streaming in cleartext
        // to a customer's browser.
        //
        // SCOPE OF CLAIM: this stops the app STREAMING those rows to a customer. It does
        // NOT close the table — the delivery authorization is schema.sql's
        // authenticated_select policy, which Phase 3 item 7 owns. Per CLAUDE.md rule 2 a
        // client-side filter is cosmetic, never security.
        expect(staffBlockStart).toBeGreaterThan(-1);
        for (const table of [
            'security_clearances', 'security_limiting_markers', 'ranks', 'units', 'roles',
            'locations', 'radio_channels', 'specialization_tags', 'certifications', 'commendations',
        ]) {
            expect(staffBlock, `${table} must be staff-gated`).toContain(`['${table}',`);
        }
    });

    it('service_types and external_tools stay UNCONDITIONAL', () => {
        // Both bindings are ungated on the client, and external_tools is audience-scoped
        // server-side. NOTE on the service_types half: the justification once written here —
        // "a Client needs live service-type edits for their request form's picker" — is not
        // true. private.rt_customer_visible_tables() is deliberately EMPTY (schema.sql), and
        // its own comment says a customer's only loss is live updates to that picker,
        // recovered on tab refocus. So service_types is staff-only at the policy layer and an
        // ungated binding delivers a Client nothing. Keeping it ungated is still correct — the
        // client is not the boundary — but do not "restore" the picker claim.
        expect(unconditionalBlock).toContain("['service_types', 'main']");
        expect(unconditionalBlock).toContain("['external_tools', 'external_tools']");
    });

    it('the duty_update handler, the settings handler and the reconnect refetch stay UNCONDITIONAL', () => {
        // duty_update is the availability scalar's only LIVE carrier — gating the FETCH
        // would strand every customer. The payload is gated server-side instead: a
        // non-staff caller's users_presence response is one boolean and an empty array.
        const duty = src.slice(src.indexOf("event: 'duty_update'"), src.indexOf("event: 'new_request'"));
        expect(duty).toContain("callFetcher('users_presence')");
        expect(duty).not.toContain('isStaffViewer');
        // Branding / ToS / serviceTypes refresh for every tier. Anchored on the
        // settings_update BROADCAST, which is the actual carrier: the postgres_changes binding
        // on `settings` that this used to anchor on was inert (the table is not in
        // private.rt_client_tables(), so it is not in the realtime publication) and has been
        // removed. The property under test — every tier refetches 'main' on a settings change,
        // with no staff gate — is unchanged.
        const settings = src.slice(src.indexOf("event: 'settings_update'"));
        expect(settings.slice(0, 900)).toContain("fn('main')");
        expect(settings.slice(0, 900)).not.toContain('isStaffViewer');
        // The reconnect resync is also a PARTIAL net for the promotion case — partial
        // because it is non-force and therefore dedupe-subject, which is why
        // SessionContext carries the explicit staff-transition rehydrate.
        expect(src).toContain('if (wasDisconnected) resyncHotSubsets();');
    });

    it('the user_update window event stays UNCONDITIONAL (item 2 depends on it)', () => {
        const handlerBody = src.slice(src.indexOf("event: 'user_update'"), src.indexOf("event: 'notification_update'"));
        expect(handlerBody).toContain("window.dispatchEvent(new CustomEvent('app:realtime:user-update'");
        // …and the non-staff branch keeps the availability scalar fresh across role
        // changes, which emit user_update and NEVER duty_update.
        expect(handlerBody).toContain("callFetcher('users_presence')");
        const dispatchIdx = handlerBody.indexOf('window.dispatchEvent');
        const elseIdx = handlerBody.indexOf('} else {');
        expect(elseIdx).toBeGreaterThan(-1);
        expect(dispatchIdx).toBeGreaterThan(handlerBody.indexOf('}', elseIdx));
    });
});

describe('TG-2 — promotion hydration (targets admin:promote_user)', () => {
    // COVERAGE GAP, stated: `user:sync_roles` (ROUTE F, the self-service Discord role
    // sync) writes a role and emits NO broadcast at all, so a self-promotion through
    // that path is NOT covered by this and remains reload-required. Closing it is a
    // one-line broadcast in lib/db/users.ts syncUserRoles that neither spec authorises.
    const src = read('contexts', 'SessionContext.tsx');

    it('refreshSelfIdentity rehydrates `main` on the false → true staff transition', () => {
        // Nothing else refetches `main` when a viewer crosses the staff threshold
        // mid-session: registerRealtimeAuth only tears down and rebuilds the realtime
        // channel. After the bundle projection a promoted account holds NO roster, so
        // their member picker, unit tree, clearance/marker dropdowns and org chart
        // render empty until a manual reload.
        expect(src).toContain('const wasStaff =');
        expect(src).toContain('const isStaffNow =');
        expect(src).toContain('if (!wasStaff && isStaffNow) void refreshMainState();');
        // {force:true} — it must bypass the 2s dedupe, which is the whole reason the
        // channel rebuild's own non-force refetch is not enough.
        const dataCtx = read('contexts', 'DataContext.tsx');
        expect(dataCtx).toContain("fetchDataSubset('main', { force: true })");
    });

    it('promoteUserToMember emits the user_update that triggers it', () => {
        // The transition is invisible without this: it was the one role-writing path in
        // lib/db/users.ts with no broadcast. Emit contract pinned in
        // tests/userUpdateBroadcasts.test.ts.
        const users = read('lib', 'db', 'users.ts');
        const start = users.indexOf('export async function promoteUserToMember');
        expect(start).toBeGreaterThan(-1);
        // Both bounds asserted explicitly. Without them a renamed function or an
        // unmatched closing brace yields an empty slice, and the failure reads as
        // "expected '' to contain ..." — true, but it hides WHICH end went missing.
        // The regex is already CRLF-tolerant; this checkout is CRLF.
        const rel = users.slice(start).search(/\r?\n\}\r?\n/);
        expect(rel).toBeGreaterThan(-1);
        expect(users.slice(start, start + rel)).toContain('await broadcastUserUpdate(userId);');
    });
});
