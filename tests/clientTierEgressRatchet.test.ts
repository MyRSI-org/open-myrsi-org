import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CLIENT_DENIED_SUBSET_NAMESPACE } from '../lib/clientNamespaces';

// ---------------------------------------------------------------------------
// THE PHASE-LEVEL GATE for the client-tier read boundary.
//
// Every other test in this phase proves ONE item. None of them proves the phase's
// own headline — that an org's EXTERNAL CUSTOMER receives neither the member roster,
// nor the classification taxonomy, nor the role table. This file is that proof, and
// it is owned by no single item on purpose: it lands last and it is what a future
// reader should break first when they want to know whether the boundary still holds.
//
// The artefact the phase was missing is Half A. Before this file, the answer to
// "which /api/query subsets may an external customer read?" lived in a recon
// document, not in the tree — so a NEW subset could be added, be reachable by a
// customer, and nothing anywhere would notice. Half A makes that a CI failure.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ===========================================================================
// HALF A — the STRUCTURAL ratchet, in the manner of tests/wildcardSelectRatchet.ts
// ===========================================================================

// Every subset a Client account may reach, each with the reason it is reachable.
// This list IS the phase's product decision, written down once. It lives in the test
// rather than in source because it is a claim ABOUT the source, and a claim that
// lived in the thing it describes could be edited to match a regression.
const CLIENT_REACHABLE: Readonly<Record<string, string>> = {
    // The boot bundle. Projected per viewer: getMainState withholds the roster, the
    // role table and the taxonomy from a non-staff caller (lib/rosterGate.ts), and
    // projectSettingsForViewer rebuilds the settings blob from an allow-list. What is
    // left for a customer is branding, platform settings and their own identity.
    main: 'branding + platform settings + self; roster/taxonomy withheld one layer down',
    // A customer's own service requests. getRequestsState scopes per caller — a
    // non-duty caller sees only requests they raised.
    requests: 'own service requests only, scoped inside getRequestsState',
    // One request, null unless the caller may see THAT request.
    request_detail: 'own request only; not-visible and absent both surface as null',
    // Org announcements are audience-scoped inside the aggregator.
    announcements: 'audience-scoped announcements the caller is in scope for',
    // Operator-configured external links, filtered to the caller's audience.
    external_tools: 'audience-filtered external links',
    // The caller's own notification feed.
    notifications: 'the caller\'s own notifications',
};

// Subsets whose client-tier gate is INLINE in the case body rather than in the
// SUBSET_REQUIRED_PERMISSION table, because a flat permission entry would deny a
// customer something they are entitled to (their OWN record, via user_detail). The
// predicate is asserted below — this bucket is verified, not merely declared.
const ROSTER_GATED = ['users_slice', 'user_detail', 'users_presence'] as const;
const ROSTER_GATE_PREDICATE = 'mayReceiveRoster';

function handleStateBody(): string {
    const src = read('api/query.ts');
    const start = src.indexOf('async function handleState');
    expect(start, 'handleState not found in api/query.ts').toBeGreaterThan(-1);
    const rest = src.slice(start + 'async function handleState'.length);
    const end = rest.search(/\nasync function |\nexport default /);
    expect(end, 'could not find the end of handleState').toBeGreaterThan(-1);
    return rest.slice(0, end);
}

function permissionGatedSubsets(): string[] {
    const src = read('api/query.ts');
    const start = src.indexOf('const SUBSET_REQUIRED_PERMISSION');
    expect(start, 'SUBSET_REQUIRED_PERMISSION not found').toBeGreaterThan(-1);
    const end = src.indexOf('\n};', start);
    expect(end, 'unterminated SUBSET_REQUIRED_PERMISSION').toBeGreaterThan(-1);
    return [...src.slice(start, end).matchAll(/^ {4}([a-z_]+):/gm)].map((m) => m[1]);
}

describe('HALF A — every /api/query state subset is classified', () => {
    const body = handleStateBody();
    const subsets = [...body.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
    const permGated = permissionGatedSubsets();
    const clientDenied = Object.keys(CLIENT_DENIED_SUBSET_NAMESPACE);

    it('the extractor actually found the switch (guard against a silent zero)', () => {
        // A regex that matches nothing would make every assertion below vacuously
        // green — the exact failure mode this repo has been bitten by before.
        expect(subsets.length).toBeGreaterThan(30);
        expect(permGated.length).toBeGreaterThan(20);
        expect(subsets).toContain('main');
    });

    it('no subset is UNCLASSIFIED', () => {
        // The baseline is EMPTY and must stay empty. Adding a subset to handleState
        // without deciding whether an external customer may read it fails here — which
        // is the whole point: the decision becomes mandatory rather than implicit.
        const classified = new Set([
            ...permGated,
            ...clientDenied,
            ...ROSTER_GATED,
            ...Object.keys(CLIENT_REACHABLE),
        ]);
        const UNCLASSIFIED_BASELINE: string[] = [];
        expect(
            subsets.filter((s) => !classified.has(s)),
            'classify the new subset: permission-gate it, deny it to the client tier, '
                + 'roster-gate it inline, or add it to CLIENT_REACHABLE with a reason',
        ).toEqual(UNCLASSIFIED_BASELINE);
    });

    it('the buckets do not overlap — a subset has exactly one story', () => {
        for (const s of Object.keys(CLIENT_REACHABLE)) {
            expect(permGated, `${s} is both client-reachable and permission-gated`).not.toContain(s);
            expect(clientDenied, `${s} is both client-reachable and client-denied`).not.toContain(s);
            expect(ROSTER_GATED, `${s} is both client-reachable and roster-gated`).not.toContain(s);
        }
    });

    it('every declared subset actually exists in handleState', () => {
        // Stops the classification lists rotting into claims about subsets that were
        // renamed or deleted, which would quietly shrink this file's coverage.
        for (const s of [...Object.keys(CLIENT_REACHABLE), ...ROSTER_GATED]) {
            expect(subsets, `${s} is classified here but no longer exists in handleState`).toContain(s);
        }
    });

    it('every ROSTER_GATED subset really carries the inline gate', () => {
        // Verifies the bucket instead of trusting it. Deleting the gate while leaving
        // the subset named here would otherwise read as "classified, therefore safe".
        for (const s of ROSTER_GATED) {
            const at = body.indexOf(`case '${s}':`);
            expect(at, `${s} case not found`).toBeGreaterThan(-1);
            // To the NEXT case label, not a fixed window: these case bodies carry long
            // rationale comments, and a fixed window silently truncates past the gate.
            const nextAt = body.indexOf("case '", at + 6);
            const caseBody = body.slice(at, nextAt > -1 ? nextAt : body.length);
            expect(
                caseBody,
                `${s} is classified roster-gated but its case body does not call ${ROSTER_GATE_PREDICATE}`,
            ).toContain(ROSTER_GATE_PREDICATE);
        }
    });

    it('the no-subset full-state path still exists and is not a way around the table', () => {
        // target=state with no subset returns lib/db.ts getState, which runs the same
        // per-viewer projection. If this case ever stops existing the assertion should
        // be revisited, not deleted.
        expect(handleStateBody()).toContain("case '':");
    });
});

// ===========================================================================
// HALF B — the BEHAVIOURAL ratchet, driving the real handler
// ===========================================================================

// SCOPE, stated honestly. This half drives api/query and therefore proves the
// projection api/query OWNS: the settings blob, rebuilt by projectSettingsForViewer.
// The roster / role-table / taxonomy half of the headline is gated one layer DOWN,
// inside lib/db.ts getMainState via lib/rosterGate.ts, so a test that mocks lib/db
// cannot prove it and must not pretend to — it is pinned by tests/rosterGate.test.ts,
// tests/mainBundleProjection.test.ts, tests/rosterEgressGates.test.ts and
// tests/dbGetStateProjection.test.ts. What IS proved here is that no settings key
// rides `main` to a customer, which is the leak route item 8 closed.

const h = vi.hoisted(() => ({
    decoded: null as { userId: number } | null,
    user: null as Record<string, unknown> | null,
}));

vi.mock('../lib/auth', () => ({
    verifyToken: () => h.decoded,
    tokenIssuedAt: () => new Date(0),
    isSessionRevokedByWatermark: () => false,
}));

// getAllSettings returns a DELIBERATELY OVER-FULL blob: every key the projection is
// supposed to withhold, present at source. If the projection is removed or widened,
// these reach the wire and the assertions below go red.
vi.mock('../lib/db', () => ({
    getPlatformSettings: async () => ({}),
    getUserById: async () => h.user,
    // The read path now runs the ORG BAN GATE above every other gate.
    // Not banned by default; the ban tests drive the real module.
    findActiveBan: async () => null,
    getBanNotice: async () => null,
    getAllSettings: async () => ({
        brandingConfig: { name: 'Org' },
        platformSettings: { maintenanceMode: false },
        wikiHomeConfig: { heroTitle: 'staff wiki home' },
        hrConfig: { probationDays: 30 },
        system_broadcast: { message: 'internal only' },
        orgFeatures: { academy: true },
        schema_version: '15.6.0-open',
        setup_completed: true,
        allianceSelfProfile: { pairingCode: 'SECRET' },
        allianceSyncConfig: { peers: ['a'] },
    }),
    getMainState: async () => ({ ranks: [] }),
}));

import handler from '../api/query';

// Same shape as tests/realtimeSliceQuery.test.ts — the handler only ever touches
// status/json/setHeader, so a full express Response stub would be noise.
function mockRes() {
    const res: any = { statusCode: 0, body: undefined, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
    return res;
}
const mockReq = (query: Record<string, unknown>) =>
    ({ method: 'GET', query, headers: { authorization: 'Bearer tok' } }) as any;

// Keys that must NEVER reach a browser through this route, for ANY caller. Six of
// them reached every authenticated user until item 8: they were never named by the
// old blob-spread, so they shipped by default rather than by decision.
const NEVER_SHIPPED = [
    'system_broadcast', 'orgFeatures', 'schema_version', 'setup_completed',
    'allianceSelfProfile', 'allianceSyncConfig',
];
// Keys a customer must not receive, but staff holding the matching permission may.
const STAFF_ONLY_SETTINGS = ['wikiHomeConfig', 'hrConfig'];

function keysDeep(value: unknown, found = new Set<string>()): Set<string> {
    if (Array.isArray(value)) { for (const v of value) keysDeep(v, found); return found; }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) { found.add(k); keysDeep(v, found); }
    }
    return found;
}

describe('HALF B — no settings key rides `main` to an external customer', () => {
    beforeEach(() => { h.decoded = { userId: 5 }; });

    it('a Client receives neither the staff config keys nor the never-shipped ones', async () => {
        h.user = { id: 5, role: 'Client', permissions: ['request:create'], auth_user_id: 'u5' };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        expect(res.statusCode).toBe(200);
        const keys = keysDeep(res.body);
        for (const k of [...NEVER_SHIPPED, ...STAFF_ONLY_SETTINGS]) {
            expect(keys, `${k} reached an external customer through subset=main`).not.toContain(k);
        }
    });

    it('a customer on a CUSTOM role is closed too, not just the seeded Client role', async () => {
        // The residual the phase accepted for the Academy does NOT apply here: this
        // boundary is permission-shaped, so an org whose customers sit on a bespoke
        // "Prospect" role are covered by the same projection.
        h.user = { id: 7, role: 'Member', permissions: ['request:create', 'marketplace:view'], auth_user_id: 'u7' };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        const keys = keysDeep(res.body);
        for (const k of [...NEVER_SHIPPED, ...STAFF_ONLY_SETTINGS]) {
            expect(keys, `${k} reached a custom-role customer`).not.toContain(k);
        }
    });

    it('the never-shipped keys are withheld from STAFF as well — they are not a tier boundary', async () => {
        h.user = { id: 6, role: 'Member', permissions: ['wiki:view', 'hr:view', 'user:view:roster'], auth_user_id: 'u6' };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        const keys = keysDeep(res.body);
        for (const k of NEVER_SHIPPED) {
            expect(keys, `${k} is not a staff/customer question — it must never ship`).not.toContain(k);
        }
    });

    it('POSITIVE FLOOR — staff still receive the config their screens need', async () => {
        // Without this, over-narrowing the projection would pass every assertion above
        // while breaking the wiki home page and the HR probation tab.
        h.user = { id: 6, role: 'Member', permissions: ['wiki:view', 'hr:view'], auth_user_id: 'u6' };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        const keys = keysDeep(res.body);
        for (const k of STAFF_ONLY_SETTINGS) {
            expect(keys, `${k} must still reach the staff caller who holds its permission`).toContain(k);
        }
        expect(keys).toContain('brandingConfig');
    });
});

describe('HALF B (source) — the two entry points cannot drift apart', () => {
    it('both `main` and the full-state aggregate project the settings blob', () => {
        // api/query.ts serves subset=main; lib/db.ts getState serves initial-state and
        // the no-subset full state. Two doors to one blob: if either stops projecting,
        // the keys above return through that door only, which is exactly how they
        // shipped unnoticed the first time.
        expect(read('api/query.ts')).toContain('projectSettingsForViewer(settings, currentUser?.permissions)');
        expect(read('lib/db.ts')).toContain('projectSettingsForViewer(settings, currentUser?.permissions)');
    });
});

// ===========================================================================
// HALF C — the honest note on what the SQL layer now does
// ===========================================================================

describe('HALF C — the PostgREST route to the taxonomy is closed, not merely unused', () => {
    // This block used to be specified as a NEGATIVE: it was to record that roles,
    // security_clearances and security_limiting_markers remained readable by any live
    // member straight out of PostgREST, so Half B proved an application-layer boundary
    // only. That residual is CLOSED as of the rt_is_staff() policy split, and this
    // block is inverted to say so — a ratchet that documented a residual which no
    // longer exists would send the next reader looking for a hole that was filled.
    const schema = () => read('schema.sql');

    it('the three tables stay in rt_client_tables() — STAFF still need them live', () => {
        // Removing them would fix the customer leak by breaking every staff member's
        // live org-chart and clearance updates. The fix is the policy, not the array.
        const start = schema().indexOf('CREATE OR REPLACE FUNCTION private.rt_client_tables(');
        const body = schema().slice(start, schema().indexOf('$$;', start));
        for (const t of ['roles', 'security_clearances', 'security_limiting_markers']) {
            expect(body, `${t} must stay realtime-published for staff`).toContain(`'${t}'`);
        }
    });

    it('and they take the STAFF-ONLY policy arm, so a customer cannot read them', () => {
        // rt_customer_visible_tables() is the allowlist; empty means every table in
        // rt_client_tables() falls to `rt_is_live_member() AND rt_is_staff()`.
        const start = schema().indexOf('CREATE OR REPLACE FUNCTION private.rt_customer_visible_tables(');
        expect(start, 'the customer-visible allowlist is gone — the split was reverted').toBeGreaterThan(-1);
        const body = schema().slice(start, schema().indexOf('$$;', start));
        for (const t of ['roles', 'security_clearances', 'security_limiting_markers']) {
            expect(body, `${t} became customer-visible — the phase headline is now false`).not.toContain(`'${t}'`);
        }
        // Comment-stripped and split by arm. The loop's rationale block contains the
        // word ELSE in prose, so a raw-text regex matches the COMMENT and stays green
        // even when the two policy arms are swapped — which is exactly what the first
        // version of this assertion did.
        const stripped = schema().replace(/--[^\n]*/g, '');
        const branchAt = stripped.indexOf('IF t = ANY (private.rt_customer_visible_tables())');
        expect(branchAt, 'the staff/customer policy branch is gone').toBeGreaterThan(-1);
        const branch = stripped.slice(branchAt, stripped.indexOf('END IF;', branchAt));
        const elseArm = branch.slice(branch.indexOf('ELSE'));
        expect(elseArm, 'every unlisted table must fall to the staff-only predicate')
            .toContain('USING (private.rt_is_live_member() AND private.rt_is_staff());');
    });
});
