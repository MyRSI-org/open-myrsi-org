import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 3 item 3 — the `main` bundle's CLIENT-TIER READ BOUNDARY.
//
// The bundle's audience model used to be "anonymous vs authenticated", and the org's
// EXTERNAL CUSTOMERS (the Client system role) are authenticated — so a customer
// received the member roster, the rank/unit/role tables, the classification ladder and
// the compartment codeword catalogue. getMainState now takes the viewer and withholds
// the personnel half.
//
// HARNESS: `lib/db/common` is mocked with a chainable supabase builder that RECORDS
// every `from(<table>)` and the chain of calls made on it. That recording is what makes
// this file the ONLY real DON'T-FETCH proof in the wave: a delete-pass implementation
// (fetch everything, then strip) passes the shape assertions and fails the recording
// one. A query that was never issued cannot leak, and the roster query alone is 1000
// rows × ~44 columns.
//
// Both directions, always: the denied party is denied AND the entitled party keeps
// access. Over-narrowing here silently denies real staff on customised roles their own
// org's directory, which is the failure mode the permission-set predicate exists to
// avoid.

const STAFF_KEYS = [
    'users', 'ranks', 'units', 'roles', 'locations', 'specializationTags',
    'certifications', 'commendations', 'radioChannels',
    'securityClearances', 'limitingMarkers',
] as const;

// The reference/personnel tables whose rows are the staff half. `users` is handled
// separately: isAnyStaffOnDuty legitimately probes it for EVERY tier (one column, one
// row), so the assertion there is about the ROSTER query, not the table name.
const STAFF_TABLES = [
    'ranks', 'units', 'roles', 'locations', 'specialization_tags',
    'certifications', 'commendations', 'radio_channels',
    'security_clearances', 'security_limiting_markers',
] as const;

const h = vi.hoisted(() => ({
    from: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    rows: {} as Record<string, unknown>,
    warns: [] as unknown[][],
}));

vi.mock('../lib/log', () => {
    const mk = (): Record<string, unknown> => ({
        debug: () => {}, info: () => {},
        warn: (...args: unknown[]) => { h.warns.push(args); },
        error: () => {}, child: () => mk(),
    });
    return { log: mk() };
});

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        h.from.push({ table, calls });
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'gt', 'gte',
            'lt', 'lte', 'contains', 'overlaps', 'range', 'ilike', 'like', 'filter',
            'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => {
            // The duty existence probe is the only `users` read a non-staff caller
            // triggers; give it a row so anyStaffOnDuty is a real boolean.
            if (table === 'users' && calls.some(c => c.method === 'eq' && c.args[0] === 'is_duty')) {
                return Promise.resolve({ data: [{ id: 1 }], error: null });
            }
            return Promise.resolve({ data: h.rows[table] ?? [], error: null });
        };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => {
            calls.push({ method: 'maybeSingle', args: [] });
            const data = h.rows[`${table}:single`] ?? null;
            return Promise.resolve({ data, error: null });
        };
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        getSystemRoles: async () => ({ client: { id: 1, name: 'Client' }, member: { id: 2, name: 'Member' } }),
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

import { getMainState } from '../lib/db';

const SERVICE_TYPES = [
    { id: 1, name: 'Security', icon: 'fa-shield', color: '#fff', description: 'd1', is_active: true, discord_channel_id: '111222333444555666' },
    // An INACTIVE type: RequestCard and ServiceRequestDetailView look a historic
    // request's type up BY NAME across the unfiltered array, so filtering server-side
    // would blank the icon/colour on any request whose type the org later deactivated.
    { id: 2, name: 'Retired Salvage', icon: 'fa-recycle', color: '#000', description: 'd2', is_active: false, discord_channel_id: null },
];

const tablesFetched = () => h.from.map(f => f.table);
const rosterQueryIssued = () => h.from.some(f =>
    f.table === 'users' && f.calls.some(c => c.method === 'select' && String(c.args[0] ?? '').includes('rsi_handle')));

beforeEach(() => {
    h.from = [];
    h.warns = [];
    h.rows = {
        users: [{ id: 9, name: 'Member', role_id: 2 }],
        ranks: [{ id: 1, name: 'Recruit', sort_order: 1 }],
        units: [{ id: 1, name: 'Alpha', sort_order: 1 }],
        roles: [{ id: 2, name: 'Member', description: null, is_system: true }],
        locations: [{ id: 1, name: 'Port Olisar', parent_id: null, type: 'station' }],
        specialization_tags: [{ id: 1, name: 'Medic' }],
        certifications: [{ id: 1, name: 'EVA' }],
        commendations: [{ id: 1, name: 'Valour' }],
        radio_channels: [{ id: 1, name: 'Command', color: '#f00', sort_order: 1, type: 'base' }],
        security_clearances: [{ id: 1, name: 'Confidential', level: 1, description: null }],
        security_limiting_markers: [{ id: 1, name: 'Ironclad', code: 'IRON', description: null, sync_restricted: true }],
        service_types: SERVICE_TYPES,
        'settings:single': { value: { warehouse: { enabled: true } } },
    };
});

const CLIENT = { permissions: [] as string[] };

describe('1-3, TG-1 — a non-staff caller (the org\'s external customer)', () => {
    it('1. every staff key is ABSENT — not empty', async () => {
        const state = await getMainState(CLIENT);
        for (const key of STAFF_KEYS) {
            // not.toHaveProperty, never toEqual([]). An empty array is indistinguishable
            // from "an org with no members", which would make a genuine roster-fetch
            // failure read as valid data. Every client slice-setter is `if (data.<key>)`,
            // so an ABSENT key is a no-op and the previous value stands.
            expect(state, `staff key '${key}' shipped to a non-staff caller`).not.toHaveProperty(key);
        }
    });

    it('2. THE DON\'T-FETCH PROPERTY — none of the staff queries is ever issued', async () => {
        // A delete-pass implementation passes test 1 and FAILS this one.
        await getMainState(CLIENT);
        for (const table of STAFF_TABLES) {
            expect(tablesFetched(), `queried '${table}' for a non-staff caller`).not.toContain(table);
        }
        // `users` is touched exactly once, by the one-column availability existence
        // probe — never by the 1000-row × ~44-column roster select.
        expect(rosterQueryIssued()).toBe(false);
        const userReads = h.from.filter(f => f.table === 'users');
        expect(userReads).toHaveLength(1);
        expect(userReads[0].calls).toContainEqual({ method: 'select', args: ['id'] });
    });

    it('3. …but KEEPS serviceTypes and orgMeta.features (their only entitled flow)', async () => {
        // Moving getServiceTypes into the staff branch blanks DashboardView's
        // activeServiceTypes and leaves `serviceType` seeded to the hard-coded literal
        // 'Security', which may not exist in the org — a total loss of the customer's
        // only flow by a second route. orgMeta.features is Client-reachable through
        // HelpView and gates the whole nav.
        const state = await getMainState(CLIENT);
        expect(Array.isArray(state.serviceTypes)).toBe(true);
        expect(state.serviceTypes).toHaveLength(2);
        expect(state.orgMeta.features).toEqual({ warehouse: { enabled: true } });
    });

    it('TG-1. …and KEEPS anyStaffOnDuty, typed boolean | null', async () => {
        // Phase 3 item 2's deliverable, and the single easiest thing for this rewrite to
        // delete silently. A non-staff caller is the ONLY caller who cannot derive it
        // from a roster, so it must live in the always-present half. Without it every
        // Client permanently sees "Services Unavailable" and cannot raise a request.
        const state = await getMainState(CLIENT);
        expect(state).toHaveProperty('anyStaffOnDuty');
        expect(typeof state.anyStaffOnDuty === 'boolean' || state.anyStaffOnDuty === null).toBe(true);
        expect(state.anyStaffOnDuty).toBe(true);
    });
});

describe('4-6b, TG-12 — who counts as staff', () => {
    // A PERMISSION set plus the server-stamped role IDENTITY, never a role-tier test:
    // inferUserRoleTier falls THROUGH to UserRole.Client for any custom role holding no
    // tier-marking permission, so a tier test would deny real staff on customised roles.
    for (const perm of ['fleet:view', 'user:view:roster', 'request:dispatch', 'qm:view', 'academy:instruct']) {
        it(`4. a viewer holding ONLY ['${perm}'] gets the full bundle`, async () => {
            const state = await getMainState({ permissions: [perm] });
            for (const key of STAFF_KEYS) {
                expect(state, `over-narrowed: '${perm}' lost '${key}'`).toHaveProperty(key);
            }
            expect(rosterQueryIssued()).toBe(true);
        });
    }

    it('5. implication-aware: academy:manage satisfies the academy:instruct rung', async () => {
        // The gate uses hasAnyStaffViewPerm (permissionSatisfied), not a bare includes():
        // a Learning Manager holding only academy:manage is staff too.
        const state = await getMainState({ permissions: ['academy:manage'] });
        expect(state).toHaveProperty('users');
    });

    for (const [label, viewer] of [
        ['null', null],
        ['undefined', undefined],
        ['{}', {}],
        ['{ permissions: [] }', { permissions: [] }],
        ['{ permissions: null }', { permissions: null }],
    ] as const) {
        it(`6. fails CLOSED for ${label}`, async () => {
            const state = await getMainState(viewer as never);
            expect(state).not.toHaveProperty('users');
            expect(state).toHaveProperty('serviceTypes');
            expect(state).toHaveProperty('anyStaffOnDuty');
        });
    }

    it('6b. a hand-pruned Admin ({ isSystemAdmin: true, permissions: [] }) gets the full bundle', async () => {
        // The first disjunct is the server-stamped identity flag, not a permission. An
        // Admin whose role array has been pruned to nothing must not lose their own org.
        const state = await getMainState({ isSystemAdmin: true, permissions: [] });
        for (const key of STAFF_KEYS) expect(state).toHaveProperty(key);
    });

    for (const perm of ['marketplace:view', 'academy:view', 'units:view_all']) {
        it(`TG-12. a NEGATIVE-tier fixture (['${perm}']) gets the non-staff shape`, async () => {
            // These three are excluded from STAFF_VIEW_PERMS ON PURPOSE: they are
            // grantable to customers. The ladder only climbs, so academy:view does not
            // reach the academy:instruct rung.
            const state = await getMainState({ permissions: [perm] });
            expect(state).not.toHaveProperty('users');
            expect(state).not.toHaveProperty('securityClearances');
            expect(rosterQueryIssued()).toBe(false);
        });
    }
});

describe('TG-11 — the demotion window: the SERVER half is the only half that holds', () => {
    it('a viewer whose permissions no longer satisfy the predicate gets the non-staff shape on the VERY NEXT call', async () => {
        // There is no per-viewer cache and no memoisation: the projection is decided
        // fresh from the row loaded on that request. This matters because the CLIENT
        // half does NOT self-heal — a demoted account keeps staff-shaped permissions in
        // its React state and every realtime handler attached until it reloads, because
        // the roster reconcile that would notice is guarded on the very array this
        // change empties. No leak (the server denies everything), but the residual is
        // "until they reload, with no mechanism that would ever end it" — so this
        // assertion is what makes the server side explicitly the boundary.
        const before = await getMainState({ permissions: ['user:view:roster'] });
        expect(before).toHaveProperty('users');
        const after = await getMainState({ permissions: [] });
        expect(after).not.toHaveProperty('users');
        expect(after).not.toHaveProperty('limitingMarkers');
    });
});

describe('7-9 — the always-present half, projected', () => {
    it('7. orgMeta.memberCount never ships, to anyone', async () => {
        // Derived from the roster array this function no longer sends, zero readers
        // repo-wide, and org headcount is not a customer's business.
        for (const viewer of [CLIENT, { permissions: ['user:view:roster'] }, { isSystemAdmin: true, permissions: [] }]) {
            const state = await getMainState(viewer);
            expect(state.orgMeta).not.toHaveProperty('memberCount');
        }
    });

    it('8. serviceTypes.discordChannelId is admin-config: absent for staff, present for the config holder', async () => {
        const staff = await getMainState({ permissions: ['fleet:view'] });
        expect(staff.serviceTypes[0]).not.toHaveProperty('discordChannelId');
        // Rebuilt by allow-list rather than by deleting one key, so a future column added
        // to service_types cannot ride to a non-admin.
        expect(Object.keys(staff.serviceTypes[0]).sort())
            .toEqual(['color', 'description', 'icon', 'id', 'isActive', 'name']);

        const admin = await getMainState({ permissions: ['admin:config:servicetypes'] });
        expect(admin.serviceTypes[0].discordChannelId).toBe('111222333444555666');
    });

    it('9. an isActive:false service type survives for EVERY tier', async () => {
        for (const viewer of [CLIENT, { permissions: ['admin:config:servicetypes'] }]) {
            const state = await getMainState(viewer);
            expect(state.serviceTypes.map(t => t.name)).toContain('Retired Salvage');
        }
    });
});

describe('D10 — syncRestricted is admin-only for every tier below admin:access', () => {
    const marker = (state: Awaited<ReturnType<typeof getMainState>>) => state.limitingMarkers![0] as Record<string, unknown>;

    for (const perm of ['intel:view', 'hr:view', 'fleet:view', 'wiki:view', 'qm:view']) {
        it(`ABSENT (not false) for ['${perm}']`, async () => {
            const state = await getMainState({ permissions: [perm] });
            const m = marker(state);
            // OMITTED, never `false`. LimitingMarker.syncRestricted is optional, and a
            // fabricated `false` would assert "this compartment IS federatable" — the
            // one thing the flag must never say by accident.
            expect(m).not.toHaveProperty('syncRestricted');
            expect(m.code).toBe('IRON'); // the marker itself still ships
        });
    }

    // THE STAFF TIERS THAT KEEP THE BUNDLE AND LOSE THE FLAG. Each fixture pairs the
    // capability perm with the domain read perm its real holder also has (an ops lead
    // holds operations:view; a clearance admin holds the roster read) — otherwise the
    // viewer would not reach getStaffMainState at all and the test would be asserting
    // the absence of the whole bundle rather than of the flag. `limitingMarkers` is
    // present for each; only `syncRestricted` is gone.
    //
    // This is owner decision D10 as written, and it is deliberately NOT widened to
    // operations:manage / admin:user:manage_clearance. The cost is cosmetic and is
    // recorded in lib/db.ts: CreateOperationWizard (entry gate operations:create)
    // loses the "SYNC RESTRICTED" badge for a planner without admin:access. The
    // federation withholding itself is enforced server-side against the DB column in
    // lib/db/operations-federation.ts and is untouched by this projection.
    for (const viewer of [
        { permissions: ['operations:view', 'operations:manage'] },
        { permissions: ['user:view:roster', 'admin:user:manage_clearance'] },
    ]) {
        it(`ABSENT for ${JSON.stringify(viewer)} — below admin:access`, async () => {
            const state = await getMainState(viewer);
            const m = marker(state);
            expect(m).not.toHaveProperty('syncRestricted');
            expect(m.code).toBe('IRON');
        });
    }

    for (const viewer of [
        { permissions: ['admin:access'] },
        { isSystemAdmin: true, permissions: [] },
    ]) {
        it(`PRESENT for ${JSON.stringify(viewer)}`, async () => {
            const state = await getMainState(viewer);
            expect(marker(state).syncRestricted).toBe(true);
        });
    }
});

describe('TG-7 — the 1000-row truncation warning survives the split', () => {
    it('still fires for a staff viewer on a 1000-row roster', async () => {
        // The ONLY signal an org has outgrown the cap, and losing it is silent.
        h.rows.users = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, name: `u${i}`, role_id: 2 }));
        await getMainState({ permissions: ['user:view:roster'] });
        expect(h.warns.some(w => String(w[0]).includes('1000-row cap'))).toBe(true);
    });

    it('does not fire below the cap', async () => {
        await getMainState({ permissions: ['user:view:roster'] });
        expect(h.warns.some(w => String(w[0]).includes('1000-row cap'))).toBe(false);
    });
});
