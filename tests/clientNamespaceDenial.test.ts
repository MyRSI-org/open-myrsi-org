import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// PHASE 3 ITEM 5 — the CLIENT-TIER DENIAL boundary.
//
// An org's external customers (accounts on the seeded system Client role) may not enter
// the internal product surfaces in EITHER direction. The registry is
// lib/clientNamespaces.ts; the predicate is db.isClientCaller (lib/db/clientRoleLock.ts,
// a ROLE-SLOT test, deliberately not a permission test); the two consuming gates are the
// dispatcher (api/services.ts) and the read path (api/query.ts).
//
// Sections:
//   A — registry invariants (pure)
//   B — isClientCaller / requireClientRoleId unit
//   C — dispatcher write path, real handler
//   D — read path, real handler
//   F — the user:toggle_duty remap
//
// NOTE ON WHAT THIS FILE MAY NOT CLAIM: the client denial runs ABOVE the optional-feature
// gate on BOTH surfaces, and the reason is UNIFORMITY (one ordering invariant, one
// consistent refusal), NOT module-state secrecy. `orgMeta.features` and the raw
// `orgFeatures` settings key already ship every module's enable state to every
// authenticated caller on the `main` bundle — Phase 3 item 8 owns that.

const h = vi.hoisted(() => ({
    // section B — steerable system-roles memo for the REAL clientRoleLock predicates
    systemRoles: {} as Record<string, { id: number; name?: string }>,
    // sections C/D — the real dispatcher / read handlers, with lib/db wholesale-mocked
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
    enabled: {} as Record<string, boolean>,
    enabledCalls: [] as string[],
    isClient: false,
    isClientCalls: 0,
    calls: {} as Record<string, number>,
}));

function bump(k: string) { h.calls[k] = (h.calls[k] ?? 0) + 1; }

function sbBuilder() {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'gt', 'in', 'update', 'delete', 'insert', 'single', 'maybeSingle']) b[m] = () => b;
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ data: { name: 'Someone' }, error: null, count: 0 });
    return b;
}

vi.mock('../lib/db/common', () => ({
    supabase: { from: () => ({}), rpc: () => Promise.resolve({ data: null, error: null }) },
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
    broadcastToOrg: () => {},
    broadcastToChannel: () => {},
    safeFetch: async () => [],
    getSystemRoles: async () => h.systemRoles,
}));

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    tokenIssuedAt: () => new Date(0),
    isSessionForceLoggedOut: () => false,
    isSessionRevokedByWatermark: () => false,
}));

vi.mock('../lib/discord', () => ({
    notifyDiscordNewRequest: async () => undefined,
    getDiscordMember: async () => null,
    buildGlobalAvatarUrl: () => 'https://cdn/a.png',
}));

vi.mock('../lib/db', () => ({
    supabase: sbBuilder(),
    // The org-ban gate runs on every authenticated dispatcher request; null = not banned.
    findActiveBan: async () => null,
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    getAllSettings: async () => ({}),
    getSystemRoles: async () => ({ admin: { id: 4 } }),
    // The predicate under test is unit-tested in section B against the REAL
    // implementation; here it is a steerable spy so the two GATES can be driven.
    isClientCaller: async () => { h.isClientCalls++; return h.isClient; },
    isOptionalFeatureEnabled: async (f: string) => { h.enabledCalls.push(f); return h.enabled[f] ?? false; },
    // write-path handler stubs
    selfEnroll: async () => { bump('selfEnroll'); },
    createCourse: async () => { bump('createCourse'); return { id: 'c1' }; },
    toggleUserDutyStatus: async () => { bump('toggleUserDutyStatus'); return true; },
    updateUserHeartbeat: async () => { bump('updateUserHeartbeat'); },
    listWarehouseCatalog: async () => { bump('listWarehouseCatalog'); return []; },
    createServiceRequest: async () => { bump('createServiceRequest'); return { id: 'r1', clientId: 9 }; },
    assertRequestOwnerOrDuty: async () => { bump('assertRequestOwnerOrDuty'); },
    updateRequestStatus: async () => { bump('updateRequestStatus'); return { id: 'r1' }; },
    rateRequest: async () => { bump('rateRequest'); return { id: 'r1' }; },
    applyForJob: async () => { bump('applyForJob'); return { id: 'j1' }; },
    createHRApplication: async () => { bump('createHRApplication'); return { id: 'a1' }; },
    // read-path aggregators
    getMainState: async () => { bump('getMainState'); return { users: [] }; },
    getRequestsState: async () => { bump('getRequestsState'); return { serviceRequests: [] }; },
    getUserNotificationState: async () => { bump('getUserNotificationState'); return { notifications: [] }; },
    getAnnouncementsState: async () => { bump('getAnnouncementsState'); return { announcements: [] }; },
    getExternalToolsState: async () => { bump('getExternalToolsState'); return { externalTools: [] }; },
    getMyAcademyState: async () => { bump('getMyAcademyState'); return { academyCatalog: [{ id: 'course' }], academyMyEnrollments: [] }; },
    getAcademyStaffState: async () => { bump('getAcademyStaffState'); return { academyCourses: [], academySessions: [] }; },
}));

import {
    CLIENT_DENIED_NAMESPACES,
    CLIENT_DENIED_SUBSETS,
    CLIENT_DENIED_SUBSET_NAMESPACE,
    CLIENT_DENIED_MESSAGE,
} from '../lib/clientNamespaces';
import { isClientCaller, requireClientRoleId } from '../lib/db/clientRoleLock';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';
import { MEMBER_DEFAULT_PERMS, DISPATCHER_DEFAULT_PERMS } from '../lib/roleDefaultPermissions';
import servicesHandler, { fullPermissionMap, PROTECTED_PREFIXES } from '../api/services';
import queryHandler, { SUBSET_REQUIRED_FEATURE } from '../api/query';

const REPO = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const DEFAULT_ROLES = {
    client: { id: 1, name: 'Client' },
    member: { id: 2, name: 'Member' },
    dispatcher: { id: 3, name: 'Dispatcher' },
    admin: { id: 4, name: 'Admin' },
};

type Res = {
    statusCode: number; body: any; headers: Record<string, string>;
    status: (c: number) => Res; json: (b: unknown) => Res; setHeader: (k: string, v: string) => Res;
};
function mockRes(): Res {
    const res = { statusCode: 0, body: undefined, headers: {} } as Res;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
const asResponse = (r: Res) => r as unknown as import('express').Response;
const postReq = (action: string, payload: unknown = {}) =>
    ({ method: 'POST', secure: false, query: {}, headers: { authorization: 'Bearer tok' }, body: { action, payload } }) as any;
const getReq = (query: Record<string, unknown>) =>
    ({ method: 'GET', query, headers: { authorization: 'Bearer tok' } }) as any;

/** POST through the REAL dispatcher. */
async function post(action: string, payload: unknown = {}) {
    const res = mockRes();
    await servicesHandler(postReq(action, payload), asResponse(res));
    return res;
}
/** GET through the REAL read path. */
async function get(query: Record<string, unknown>) {
    const res = mockRes();
    await queryHandler(getReq(query), asResponse(res));
    return res;
}

const CLIENT_USER = { id: 9, role: 'Client', permissions: [...CLIENT_DEFAULT_PERMS], roleId: 1 };
const MEMBER_USER = { id: 6, role: 'Member', permissions: ['user:view:roster'], roleId: 2 };

beforeEach(() => {
    h.systemRoles = { ...DEFAULT_ROLES };
    h.decoded = { userId: 9 };
    h.user = { ...CLIENT_USER };
    h.enabled = { academy: true };
    h.enabledCalls = [];
    h.isClient = false;
    h.isClientCalls = 0;
    h.calls = {};
});

// ---------------------------------------------------------------------------
// Section A — registry invariants
// ---------------------------------------------------------------------------

describe('client namespace denial — A: registry invariants', () => {
    it('A1. every denied namespace is a real, protected action prefix', () => {
        expect(CLIENT_DENIED_NAMESPACES.length).toBeGreaterThan(0);
        for (const ns of CLIENT_DENIED_NAMESPACES) {
            // A namespace that forgot its colon ('academy' vs 'academy:') silently gates
            // nothing — the exact fail-open class a prefix registry invites.
            expect(ns.endsWith(':')).toBe(true);
            expect(PROTECTED_PREFIXES).toContain(ns);
            expect(Object.keys(fullPermissionMap).some(a => a.startsWith(ns))).toBe(true);
        }
    });

    it('A2. every denied read subset NAMES a denied write namespace (explicit pairing, not derived)', () => {
        // Do NOT re-derive the namespace from the subset name. `'academy_my'.split('_')[0]`
        // happening to give 'academy' is a naming coincidence: the phase's other candidates
        // are the roster subsets, and 'users_presence'.split('_')[0] is 'users' while the
        // action prefix is 'user:' — a namespace this registry must never deny wholesale.
        for (const [subset, ns] of Object.entries(CLIENT_DENIED_SUBSET_NAMESPACE)) {
            expect(CLIENT_DENIED_NAMESPACES).toContain(ns);
            expect(CLIENT_DENIED_SUBSETS).toContain(subset);
        }
        expect([...CLIENT_DENIED_SUBSETS].sort())
            .toEqual(Object.keys(CLIENT_DENIED_SUBSET_NAMESPACE).sort());
    });

    it('A3. no denied namespace covers an action a Client is ENTITLED to (anti-lockout)', () => {
        for (const [action, perm] of Object.entries(fullPermissionMap)) {
            if (!CLIENT_DEFAULT_PERMS.includes(perm as string)) continue;
            const denied = CLIENT_DENIED_NAMESPACES.find(p => action.startsWith(p));
            expect(denied, `${action} (${perm}) is a Client entitlement but matches denied prefix ${denied}`).toBeUndefined();
        }
    });

    it('A4. the user: self-service namespace is never denied wholesale', () => {
        // Denying 'user:' would lock a customer out of user:apply_job /
        // user:submit_application, i.e. out of ever becoming a member — the single worst
        // regression available in this registry.
        expect(CLIENT_DENIED_NAMESPACES).not.toContain('user:');
        for (const a of ['user:apply_job', 'user:submit_application', 'user:delete_self', 'user:logout']) {
            expect(CLIENT_DENIED_NAMESPACES.some(p => a.startsWith(p))).toBe(false);
        }
    });

    it('A5. every denied subset is a real query subset', () => {
        // A source-text check against the `case` arm rather than a table lookup. That is now a
        // CHOICE, not a constraint: SUBSET_REQUIRED_PERMISSION is exported (for
        // tests/readPathPermissionCoverage.test.ts). Kept as-is because what this assertion
        // needs is "the subset is servable", which the switch answers and the map does not —
        // an auth-only subset is servable and absent from the map by design.
        const querySrc = read('api/query.ts');
        for (const s of CLIENT_DENIED_SUBSETS) {
            const known = Object.prototype.hasOwnProperty.call(SUBSET_REQUIRED_FEATURE, s)
                || querySrc.includes(`case '${s}':`);
            expect(known, `${s} is denied but is not a known subset — a dead gate`).toBe(true);
        }
    });

    it('A6. both consuming surfaces use the SHARED message constant, not a local copy', () => {
        for (const f of ['api/services.ts', 'api/query.ts']) {
            const src = read(f);
            expect(src).toContain('CLIENT_DENIED_MESSAGE');
            // and never an inlined duplicate of the literal
            expect(src).not.toContain(`'${CLIENT_DENIED_MESSAGE}'`);
        }
        expect(CLIENT_DENIED_MESSAGE).toMatch(/client accounts/i);
    });
});

// ---------------------------------------------------------------------------
// Section B — isClientCaller / requireClientRoleId
// ---------------------------------------------------------------------------

describe('client namespace denial — B: isClientCaller / requireClientRoleId', () => {
    it('B1. an absent identity is treated as a customer, never as staff', async () => {
        expect(await isClientCaller(null)).toBe(true);
        expect(await isClientCaller(undefined)).toBe(true);
    });

    it('B2. an account on the Client role slot is a client', async () => {
        expect(await isClientCaller({ roleId: 1, permissions: [] })).toBe(true);
    });

    it('B3. an account on any other seeded or custom role is not', async () => {
        for (const rid of [2, 3, 4, 9]) {
            expect(await isClientCaller({ roleId: rid, permissions: [] })).toBe(false);
        }
    });

    it('B4. a PERMISSIONLESS custom role is admitted — the "Recruit" case', async () => {
        // This is the case a permission-only predicate gets WRONG, and it is why the
        // predicate is role-slot-keyed. An org's "Recruit"/"Probationary" role exists to
        // run the induction course and holds nothing; `!hasAnyStaffViewPerm` would deny it
        // the Academy. Do not "simplify" isClientCaller to a permission test.
        expect(await isClientCaller({ roleId: 9, permissions: [] })).toBe(false);
    });

    it('B5. a custom Instructor role is admitted', async () => {
        expect(await isClientCaller({ roleId: 9, permissions: ['academy:view', 'academy:instruct'] })).toBe(false);
    });

    it('B6. a Client that drifted into a staff grant is STILL a client', async () => {
        // assertRoleIsNotClient stops the Roles UI writing one, but the seeder,
        // repairDatabase, the org importer and hand-run SQL are four writers it does not
        // cover. The slot is what decides, not the grant.
        expect(await isClientCaller({ roleId: 1, permissions: ['academy:instruct', 'hr:view', 'admin:access'] })).toBe(true);
    });

    it('B7. an unresolvable Client slot falls back to the permission test, in BOTH directions', async () => {
        h.systemRoles = {};
        expect(await isClientCaller({ roleId: 9, permissions: [] })).toBe(true);
        expect(await isClientCaller({ roleId: 9, permissions: ['hr:view'] })).toBe(false);
    });

    it('B8. an unusable role id routes to the permission fallback, never to "allow"', async () => {
        // toUser maps a missing role_id to 0, and 0 compares false against every real role
        // id — which would read as "not a customer" if it reached the comparison.
        for (const rid of [0, undefined, null, 'abc', -1, 1.5] as const) {
            expect(await isClientCaller({ roleId: rid as never, permissions: [] })).toBe(true);
            expect(await isClientCaller({ roleId: rid as never, permissions: ['operations:view'] })).toBe(false);
        }
    });

    it('B9. a string role id is coerced (1 === "1" is false)', async () => {
        expect(await isClientCaller({ roleId: '1', permissions: [] })).toBe(true);
    });

    it('B10. the STALE-MEMO window fails OPEN, and that is the accepted residual', async () => {
        // getSystemRoles is a 5-minute IN-PROCESS memo and lib/db/importer.ts deletes and
        // re-inserts the whole roles table. On a second instance whose memo was never
        // invalidated, the memoised Client id points at a deleted row, the real Client's
        // new id compares false, and a genuine Client is ADMITTED for up to
        // TTL.SYSTEM_ROLES. Asserted here in the direction it actually goes so the
        // predicate's "fails closed at every unknown" docblock is never read as a
        // completeness claim. Same window assertRoleIsNotClient (a stronger control)
        // already accepts. The one-line upgrade is getSystemRolesUncached, at the cost of
        // one `roles` query per academy call.
        h.systemRoles = { client: { id: 99 } };
        expect(await isClientCaller({ roleId: 1, permissions: [...CLIENT_DEFAULT_PERMS] })).toBe(false);
    });

    it('B11. requireClientRoleId returns the slot id', async () => {
        expect(await requireClientRoleId()).toBe(1);
    });

    it('B12. requireClientRoleId THROWS when the slot is unresolvable (write-side fail-closed)', async () => {
        h.systemRoles = {};
        await expect(requireClientRoleId()).rejects.toThrow(/Repair Database/);
    });
});

// ---------------------------------------------------------------------------
// Section C — the dispatcher write path (real api/services handler)
// ---------------------------------------------------------------------------

describe('client namespace denial — C: dispatcher write path', () => {
    it('C1. a Client is refused academy:self_enroll even though it maps to user:manage:self', async () => {
        // THE HEADLINE. academy:self_enroll and its siblings sit on the
        // 'user:manage:self' pseudo-permission, i.e. "any authenticated session" is the
        // entire gate. Without the denial this reaches the handler.
        h.isClient = true;
        h.user = { ...CLIENT_USER };
        const res = await post('academy:self_enroll', { sessionId: 's1' });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/not available to client accounts/i);
        expect(h.calls.selfEnroll ?? 0).toBe(0);
    });

    it('C2. a member with zero academy permissions still self-enrols', async () => {
        h.isClient = false;
        h.decoded = { userId: 6 };
        h.user = { ...MEMBER_USER };
        const res = await post('academy:self_enroll', { sessionId: 's1' });
        expect(res.statusCode).toBe(200);
        expect(h.calls.selfEnroll).toBe(1);
    });

    it('C3. a PERMISSIONLESS custom role still self-enrols — the Recruit case, end to end', async () => {
        h.isClient = false;
        h.user = { id: 11, role: 'Member', permissions: [], roleId: 9 };
        h.decoded = { userId: 11 };
        const res = await post('academy:self_enroll', { sessionId: 's1' });
        expect(res.statusCode).toBe(200);
        expect(h.calls.selfEnroll).toBe(1);
    });

    it('C4. an instructor on a custom role still reaches the staff academy actions', async () => {
        h.isClient = false;
        h.user = { id: 12, role: 'Member', permissions: ['academy:instruct'], roleId: 9 };
        h.decoded = { userId: 12 };
        const res = await post('academy:create_course', { title: 'x' });
        expect(res.statusCode).toBe(200);
        expect(h.calls.createCourse).toBe(1);
    });

    it('C5. the Client keeps request:create / request:cancel / request:rate', async () => {
        h.isClient = true;
        h.user = { ...CLIENT_USER };
        const cases: Array<[string, Record<string, unknown>, string]> = [
            ['request:create', { newRequest: { title: 't' } }, 'createServiceRequest'],
            ['request:cancel', { requestId: 'r1' }, 'updateRequestStatus'],
            ['request:rate', { requestId: 'r1', rating: 5 }, 'rateRequest'],
        ];
        for (const [action, payload, counter] of cases) {
            const res = await post(action, payload);
            expect(res.statusCode, action + ' -> ' + JSON.stringify(res.body)).toBe(200);
            expect(h.calls[counter]).toBeGreaterThan(0);
        }
    });

    it('C6. the Client keeps user:apply_job and user:submit_application', async () => {
        // A customer must always be able to become a member. This is the single worst
        // regression available in a prefix registry, so it is pinned end to end.
        h.isClient = true;
        h.user = { ...CLIENT_USER, permissions: [...CLIENT_DEFAULT_PERMS] };
        const a = await post('user:apply_job', { jobId: 'j1' });
        expect(a.statusCode).toBe(200);
        expect(h.calls.applyForJob).toBe(1);
        const b = await post('user:submit_application', { answers: {} });
        expect(b.statusCode).toBe(200);
        expect(h.calls.createHRApplication).toBe(1);
    });

    it('C7. the client denial runs BEFORE the feature gate — same refusal whether the module is on or off', async () => {
        // The read and write surfaces now put the registry in the SAME position, so there
        // is ONE ordering invariant rather than two that can be "harmonised" apart. The
        // reason is uniformity — one consistent refusal, and the tier answer never depends
        // on an unrelated settings read. It is NOT a module-state non-disclosure control
        // and nothing here claims it is: orgMeta.features and the raw 'orgFeatures'
        // settings key already ship every module's enable state to every caller on the
        // `main` bundle. Phase 3 item 8 owns that.
        h.isClient = true;
        h.user = { ...CLIENT_USER };
        for (const on of [true, false]) {
            h.enabled = { academy: on };
            h.enabledCalls = [];
            const res = await post('academy:self_enroll', { sessionId: 's1' });
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toMatch(/not available to client accounts/i);
            expect(res.body.message).not.toMatch(/feature is not enabled/i);
            expect(h.enabledCalls).not.toContain('academy');
        }
        expect(h.calls.selfEnroll ?? 0).toBe(0);
    });

    it('C8. the denial is the FIRST gate in the dispatcher source (index ratchet, CRLF-safe)', () => {
        const src = read('api/services.ts');
        const iExists = src.indexOf('Own-property check, NOT truthiness (see public-branch note above)');
        const iDeny = src.indexOf('CLIENT-TIER NAMESPACE DENIAL');
        const iFeature = src.indexOf('// Optional-feature gate: when a module is toggled OFF');
        const iBola = src.indexOf('BOLA MITIGATION');
        for (const [name, i] of Object.entries({ iExists, iDeny, iFeature, iBola })) {
            expect(i, name + ' marker not found — the ratchet would pass vacuously').toBeGreaterThan(-1);
        }
        expect(iDeny).toBeGreaterThan(iExists);
        expect(iDeny).toBeLessThan(iFeature);
        expect(iDeny).toBeLessThan(iBola);
    });

    it('C9. isClientCaller is NOT consulted outside a denied namespace (hot path)', async () => {
        h.isClient = true;
        h.user = { ...CLIENT_USER, permissions: [...CLIENT_DEFAULT_PERMS, 'warehouse:view'] };
        h.enabled = { warehouse: true };
        const probes: Array<[string, Record<string, unknown>]> = [
            ['request:create', { newRequest: { title: 't' } }],
            ['user:heartbeat', {}],
            ['warehouse:list_catalog', {}],
        ];
        for (const [action, payload] of probes) await post(action, payload);
        expect(h.isClientCalls).toBe(0);
    });

    it('C10. an unknown action still 400s ABOVE the denial', async () => {
        h.isClient = true;
        h.user = { ...CLIENT_USER };
        const res = await post('academy:not_a_real_action', {});
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/Invalid action/);
        expect(h.isClientCalls).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Section D — the read path (real api/query handler)
// ---------------------------------------------------------------------------

describe('client namespace denial — D: read path', () => {
    it('D1. a Client is refused subset=academy_my', async () => {
        h.isClient = true;
        const res = await get({ target: 'state', subset: 'academy_my' });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/not available to client accounts/i);
        expect(h.calls.getMyAcademyState ?? 0).toBe(0);
    });

    it('D2. a Client is refused subset=academy_my even when the Academy module is OFF', async () => {
        // 403, not the feature gate's 200-with-an-empty-body. Same ordering as the
        // dispatcher — uniformity, not secrecy (see C7).
        h.isClient = true;
        h.enabled = { academy: false };
        const res = await get({ target: 'state', subset: 'academy_my' });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/not available to client accounts/i);
        expect(h.enabledCalls).not.toContain('academy');
        expect(h.calls.getMyAcademyState ?? 0).toBe(0);
    });

    it('D3. a member with NO academy permission still gets academy_my', async () => {
        // academy_my is deliberately permission-less and never gets an entry in
        // SUBSET_REQUIRED_PERMISSION — academy:view is the STAFF read in this build.
        h.isClient = false;
        h.decoded = { userId: 6 };
        h.user = { ...MEMBER_USER };
        const res = await get({ target: 'state', subset: 'academy_my' });
        expect(res.statusCode).toBe(200);
        expect(res.body.academyCatalog).toHaveLength(1);
        expect(h.calls.getMyAcademyState).toBe(1);
    });

    it('D4. a Client is refused subset=academy with the CLIENT message, above the academy:view gate', async () => {
        h.isClient = true;
        const res = await get({ target: 'state', subset: 'academy' });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/not available to client accounts/i);
        expect(res.body.message).not.toMatch(/Insufficient permissions/);
        expect(h.calls.getAcademyStaffState ?? 0).toBe(0);
    });

    it('D5. a Client keeps requests / notifications / announcements / external_tools', async () => {
        h.isClient = true;
        for (const s of ['requests', 'notifications', 'announcements', 'external_tools']) {
            const res = await get({ target: 'state', subset: s });
            expect(res.statusCode, s + ' -> ' + JSON.stringify(res.body)).toBe(200);
        }
    });

    it('D6. the read denial is the FIRST gate in the source (index ratchet, CRLF-safe)', () => {
        const src = read('api/query.ts');
        const iAuth = src.indexOf('Forbidden: Authentication required.');
        const iDeny = src.indexOf('CLIENT-TIER SUBSET DENIAL');
        const iPerm = src.indexOf('const requiredPerm = SUBSET_REQUIRED_PERMISSION[');
        const iFeat = src.indexOf('const requiredFeature = SUBSET_REQUIRED_FEATURE[');
        for (const [name, i] of Object.entries({ iAuth, iDeny, iPerm, iFeat })) {
            expect(i, name + ' marker not found — the ratchet would pass vacuously').toBeGreaterThan(-1);
        }
        expect(iDeny).toBeGreaterThan(iAuth);
        expect(iDeny).toBeLessThan(iPerm);
        expect(iDeny).toBeLessThan(iFeat);
    });

    it('D7. the ARRAY form ?subset[]=academy_my is REJECTED, never served', async () => {
        // CLIENT_DENIED_SUBSETS.includes(subset) does not coerce, which is the one shape
        // on this path that could fail OPEN. handleState normalises req.query.subset ONCE:
        // any non-string collapses to a sentinel that matches no gate and no `case`, so it
        // falls through to the switch's `default:` 400 — narrower than before, and the
        // aggregator is never reached in either direction.
        h.isClient = true;
        const asClient = await get({ target: 'state', subset: ['academy_my'] });
        expect(asClient.statusCode).toBe(400);
        expect(asClient.body.message).toMatch(/Unknown subset/);
        expect(h.calls.getMyAcademyState ?? 0).toBe(0);

        h.isClient = false;
        h.decoded = { userId: 6 };
        h.user = { ...MEMBER_USER };
        const asMember = await get({ target: 'state', subset: ['academy_my'] });
        expect(asMember.statusCode).toBe(400);
        expect(asMember.body.message).toMatch(/Unknown subset/);
        expect(h.calls.getMyAcademyState ?? 0).toBe(0);
    });

    it('D8. isClientCaller is NOT consulted for a subset outside the denied set (hot path)', async () => {
        h.isClient = true;
        await get({ target: 'state', subset: 'requests' });
        await get({ target: 'state', subset: 'main' });
        expect(h.isClientCalls).toBe(0);
    });

    it('D9. the subset normalisation exists exactly once, and every gate is keyed off it', () => {
        const src = read('api/query.ts');
        expect(src).toContain('const rawSubset = req.query.subset;');
        expect(src).toContain('__non_string_subset__');
        expect(src.split('const rawSubset = req.query.subset;').length - 1).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Section F — the user:toggle_duty remap
// ---------------------------------------------------------------------------

describe('client namespace denial — F: the user:toggle_duty remap', () => {
    it('F1. the action is gated on the PERMISSION of the same name, not the pseudo-perm', () => {
        expect(fullPermissionMap['user:toggle_duty']).toBe('user:toggle_duty');
        expect(fullPermissionMap['user:toggle_duty']).not.toBe('user:manage:self');
    });

    it('F2. the remap cannot strand a seeded role — the permission exists and is a default', () => {
        expect(MEMBER_DEFAULT_PERMS).toContain('user:toggle_duty');
        expect(DISPATCHER_DEFAULT_PERMS).toContain('user:toggle_duty');
        // A permission not in the global list can never be granted through the Roles UI.
        expect(read('lib/db/system.ts')).toContain("name: 'user:toggle_duty'");
        expect(read('schema.sql')).toContain("('user:toggle_duty'");
    });

    it('F3. Admin holds it by GRANT, not by a code bypass — and that is accepted', () => {
        // The BOLA gate has no isSystemAdmin bypass (api/services.ts: "Admin role bypasses
        // via permissions"), so an Admin role stripped of user:toggle_duty through the
        // Roles UI loses its own self-toggle. Accepted: the seeder grants Admin the full
        // permission set, so no seeded install can reach that state by accident.
        expect(read('lib/db/seeder.ts')).toContain('const adminPerms = permissions.map(p => p.name);');
        expect(read('api/services.ts')).toContain('Admin role bypasses via permissions');
    });

    it('F4. dispatcher, both directions: a permission holder toggles, a Client does not', async () => {
        h.isClient = false;
        h.decoded = { userId: 6 };
        h.user = { id: 6, role: 'Member', permissions: ['user:toggle_duty'] };
        const ok = await post('user:toggle_duty', {});
        expect(ok.statusCode).toBe(200);
        expect(h.calls.toggleUserDutyStatus).toBe(1);

        h.isClient = true;
        h.decoded = { userId: 9 };
        h.user = { ...CLIENT_USER };
        const denied = await post('user:toggle_duty', {});
        expect(denied.statusCode).toBe(403);
        expect(denied.body.message).toMatch(/Insufficient permissions/i);
        expect(h.calls.toggleUserDutyStatus).toBe(1);
    });

    it('F5. admin:toggle_duty (toggling SOMEONE ELSE) is untouched', () => {
        expect(fullPermissionMap['admin:toggle_duty']).toBe('admin:user:update');
    });
});
