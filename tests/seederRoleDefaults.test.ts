import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Pins for the seeded Member/Dispatcher default permissions
// (lib/roleDefaultPermissions.ts + lib/db/seeder.ts).
//
// The defect: memberPerms and dispatcherPerms carried ZERO finance:, qm: and
// warehouse: strings, so on every fresh install those three modules were reachable
// only by the Admin role — nav entry hidden, view a lock card, every RPC a 403, and
// sendPushToPermission('finance:approve' | 'qm:manage' | 'warehouse:manage') fanning
// out to exactly one person. Until now NOTHING in tests/ asserted anything about what
// those two roles receive, so the defaults were unshipped behaviour in the CLAUDE.md
// sense: a regression would have been silent.
//
// What is pinned here:
//   1. The three optional modules are present in both tiers, by exact string list.
//   2. Neither tier gains a *:admin module-config bucket, finance:manage, or ANY
//      academy: string — academy:view gates the STAFF bundle in this build
//      (unpublished drafts included) and the member surface academy_my is ungated,
//      so "hosted parity" there would be a widening, not a fix.
//   3. Both directions: Admin and Dispatcher keep everything they hold today, the
//      Client tier gains nothing, and a custom role is never written to.
//   4. Behaviourally: a fresh seed grants the new strings AND stamps the one-shot
//      marker (so Repair's backfill can never fire on an install born correct), while
//      a re-seed over a POPULATED tier — repairDatabase's catastrophic branch, which
//      an admin can reach through the Roles UI — restores nothing.

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, ...rel.split('/')), 'utf8');

function seededFromSchema(): Set<string> {
    const schema = read('schema.sql');
    const start = schema.indexOf('INSERT INTO public.permissions (name, description, category) VALUES');
    const block = schema.slice(start, schema.indexOf('ON CONFLICT', start));
    const set = new Set<string>();
    for (const m of block.matchAll(/\(\s*'([^']+)'\s*,/g)) set.add(m[1]);
    return set;
}

function optionalFeatureNamespaces(): string[] {
    const src = read('api/services.ts');
    const i = src.indexOf('export const OPTIONAL_FEATURE_NAMESPACES');
    const block = src.slice(i, src.indexOf('\n};', i));
    return [...block.matchAll(/^\s*'([a-z_]+:)':/gm)].map(m => m[1]);
}

// ---------------------------------------------------------------------------
// Recorded query layer, so the seeder's real control flow is exercised.
// ---------------------------------------------------------------------------
type Q = { table: string; calls: Array<{ method: string; args: unknown[] }> };

const h = vi.hoisted(() => ({
    queries: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    resolve: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: [] as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => Record<string, unknown>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'lte', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => { const q = { table, calls }; h.queries.push(q); return Promise.resolve(h.resolve(q)); };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (res: any, rej: any) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        getSystemRoles: async () => ({}),
    };
});

import { MEMBER_DEFAULT_PERMS, DISPATCHER_DEFAULT_PERMS, OPTIONAL_MODULE_ROLE_DEFAULTS } from '../lib/roleDefaultPermissions';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';
import { ROLE_DEFAULT_BACKFILL_MARKER_KEY, ALL_BACKFILL_IDS } from '../lib/db/roleDefaults';
import { seedInstall } from '../lib/db/seeder';

const SCHEMA_PERMS = [...seededFromSchema()];
const PERM_ID = new Map(SCHEMA_PERMS.map((name, i) => [name, i + 1]));
const NAME_BY_ID = new Map([...PERM_ID].map(([name, id]) => [id, name]));

const ROLE_IDS = { Client: 1, Member: 2, Dispatcher: 3, Admin: 4, Contractors: 5 };

// The seeded optional-module strings, restated LITERALLY rather than derived from the
// module under test — a prefix test would pass if warehouse:request were swapped for
// warehouse:manage on the Member tier.
const MEMBER_MODULE_GRANTS = [
    'finance:view', 'finance:deposit', 'finance:withdraw_request',
    'qm:view', 'qm:request',
    'warehouse:view', 'warehouse:request',
    'blueprint:view', 'blueprint:register', 'blueprint:request', 'blueprint:craft',
];
const DISPATCHER_MODULE_GRANTS = [
    'finance:view', 'finance:approve',
    'qm:view', 'qm:request', 'qm:manage',
    'warehouse:view', 'warehouse:request', 'warehouse:manage',
    'blueprint:view', 'blueprint:register', 'blueprint:request', 'blueprint:craft', 'blueprint:manage',
];

describe('seeded role defaults — the string lists', () => {
    it('every optional module with a dispatched action namespace reaches the Member tier', () => {
        // gov: is already seeded (gov:view / gov:participate) and academy: is the
        // documented exception, asserted separately below.
        const namespaces = optionalFeatureNamespaces().filter(ns => ns !== 'gov:' && ns !== 'academy:');
        expect(namespaces.sort()).toEqual(['blueprint:', 'finance:', 'marketplace:', 'qm:', 'warehouse:']);
        for (const ns of namespaces) {
            expect(MEMBER_DEFAULT_PERMS.some(p => p.startsWith(ns)), `Member holds nothing in ${ns}`).toBe(true);
        }
    });

    it('…and the Dispatcher tier', () => {
        const namespaces = optionalFeatureNamespaces().filter(ns => ns !== 'gov:' && ns !== 'academy:');
        for (const ns of namespaces) {
            expect(DISPATCHER_DEFAULT_PERMS.some(p => p.startsWith(ns)), `Dispatcher holds nothing in ${ns}`).toBe(true);
        }
    });

    it('grants exactly the agreed optional-module strings, per tier', () => {
        expect(MEMBER_DEFAULT_PERMS).toEqual(expect.arrayContaining(MEMBER_MODULE_GRANTS));
        expect(DISPATCHER_DEFAULT_PERMS).toEqual(expect.arrayContaining(DISPATCHER_MODULE_GRANTS));
        const moduleOnly = (list: readonly string[]) => list.filter(p => /^(finance|qm|warehouse|blueprint):/.test(p)).sort();
        expect(moduleOnly(MEMBER_DEFAULT_PERMS)).toEqual([...MEMBER_MODULE_GRANTS].sort());
        expect(moduleOnly(DISPATCHER_DEFAULT_PERMS)).toEqual([...DISPATCHER_MODULE_GRANTS].sort());
    });

    it('a participation rung always ships with the sibling :view it is unreachable without', () => {
        // The nav entry and the whole view are :view-gated, so :request / :deposit /
        // :withdraw_request without :view is a permission nobody can use.
        let matched = 0;
        for (const perm of MEMBER_DEFAULT_PERMS) {
            const m = /^([a-z]+:)(request|deposit|withdraw_request)$/.exec(perm);
            if (!m) continue;
            matched++;
            expect(MEMBER_DEFAULT_PERMS, `${perm} without ${m[1]}view`).toContain(`${m[1]}view`);
        }
        expect(matched).toBeGreaterThan(0);
    });

    it('no tier below Admin gets a module-config bucket, and finance:manage stays with Admin', () => {
        // finance:manage covers reverse_entry / record_adjustment / account
        // create+update+archive / reconcile — deliberately withheld from Dispatcher.
        const forbidden = ['finance:admin', 'qm:admin', 'warehouse:admin', 'marketplace:admin', 'finance:manage'];
        for (const perm of forbidden) {
            expect(MEMBER_DEFAULT_PERMS).not.toContain(perm);
            expect(DISPATCHER_DEFAULT_PERMS).not.toContain(perm);
        }
    });

    it('academy is deliberately absent, and the reason it is absent still holds', () => {
        expect(MEMBER_DEFAULT_PERMS.filter(p => p.startsWith('academy:'))).toEqual([]);
        expect(DISPATCHER_DEFAULT_PERMS.filter(p => p.startsWith('academy:'))).toEqual([]);

        // The coupling: academy:view is only safe to withhold while it still gates the
        // STAFF bundle and academy_my stays ungated. Scoped to the
        // SUBSET_REQUIRED_PERMISSION literal — academy_my legitimately appears in
        // SUBSET_REQUIRED_FEATURE, so a whole-file assertion would be a trap.
        //
        // Phase 3 item 5 added a SEPARATE, HIGHER-PRECEDENCE boundary above this one: an
        // account on the system Client ROLE SLOT is refused 'academy' and 'academy_my'
        // outright (CLIENT_DENIED_SUBSETS, lib/clientNamespaces.ts, checked in api/query.ts
        // before this permission gate). That does NOT weaken the coupling asserted here and
        // does NOT supersede it: the denial keys on the role slot, this assertion keys on
        // the permission map, and every NON-Client caller — including a permissionless
        // custom "Recruit" role — must still reach academy_my with no academy permission at
        // all. Adding an academy_my key here would take My Academy away from every existing
        // member.
        const query = read('api/query.ts');
        const i = query.indexOf('const SUBSET_REQUIRED_PERMISSION');
        const block = query.slice(i, query.indexOf('\n};', i));
        const entries = block.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
        expect(entries).toContain("academy: 'academy:view',");
        expect(entries).not.toMatch(/^\s*academy_my\s*:/m);
    });

    it('the backfill table is a strict subset of the seeded defaults', () => {
        // The anti-drift pin: the seeder's list and the backfill's list must never
        // become two literals that disagree.
        for (const group of OPTIONAL_MODULE_ROLE_DEFAULTS) {
            expect(group.member.every(p => p.startsWith(group.namespace))).toBe(true);
            expect(group.dispatcher.every(p => p.startsWith(group.namespace))).toBe(true);
            for (const p of group.member) expect(MEMBER_DEFAULT_PERMS).toContain(p);
            for (const p of group.dispatcher) expect(DISPATCHER_DEFAULT_PERMS).toContain(p);
        }
        const flat = (pick: (g: (typeof OPTIONAL_MODULE_ROLE_DEFAULTS)[number]) => readonly string[]) =>
            OPTIONAL_MODULE_ROLE_DEFAULTS.flatMap(pick).sort();
        expect(flat(g => g.member)).toEqual([...MEMBER_MODULE_GRANTS].sort());
        expect(flat(g => g.dispatcher)).toEqual([...DISPATCHER_MODULE_GRANTS].sort());
    });

    it('every default is a real permission in schema.sql §7', () => {
        // A misspelt string is SILENTLY dropped by the seeder's `if (pId)` guard, so
        // nothing else in the system would ever notice.
        const seeded = seededFromSchema();
        for (const p of [...MEMBER_DEFAULT_PERMS, ...DISPATCHER_DEFAULT_PERMS]) {
            expect(seeded.has(p), `${p} is not seeded in schema.sql §7`).toBe(true);
        }
    });

    it('both directions — Member and Dispatcher keep every permission they held before', () => {
        // Frozen snapshot of the pre-fix lists. This is the assertion that makes a
        // future "tidy up the defaults" commit fail rather than silently demote every
        // Dispatcher in every self-hosted org.
        const MEMBER_BEFORE = ['alliance:view', 'user:receive:eam', 'fleet:view', 'fleet:manage_own', 'hr:view', 'intel:view', 'intel:view:clearance', 'intel:create', 'warrant:view', 'operations:view', 'request:create', 'request:create_adhoc', 'request:accept', 'request:start', 'request:complete', 'request:cancel', 'request:rate', 'user:toggle_duty', 'user:view:roster', 'user:manage:self', 'wiki:view', 'gov:view', 'gov:participate', 'marketplace:view', 'marketplace:list', 'marketplace:contract'];
        const DISPATCHER_BEFORE = ['alliance:view', 'radio:manage', 'admin:broadcast:eam', 'user:receive:eam', 'fleet:view', 'fleet:manage_own', 'fleet:manage', 'hr:view', 'hr:recruiter', 'hr:manager', 'hr:admin', 'hr:manage:positions', 'admin:manage:documents', 'intel:view', 'intel:view:clearance', 'intel:create', 'intel:manage', 'warrant:view', 'warrant:create', 'warrant:manage', 'operations:view', 'operations:create', 'operations:manage', 'unit:manage:own', 'request:create', 'request:create_adhoc', 'request:triage', 'request:dispatch', 'request:accept', 'request:start', 'request:complete', 'request:cancel', 'request:delete', 'request:manage_responders', 'request:set_lead', 'request:update', 'request:rate', 'request:view:feedback', 'admin:access', 'admin:config:notices', 'admin:view:roster', 'admin:view:clients', 'user:manage:conduct_record', 'user:toggle_duty', 'admin:award:certification', 'admin:award:commendation', 'user:view:roster', 'user:manage:self', 'wiki:view', 'wiki:add_page', 'wiki:edit_page', 'wiki:delete_page', 'gov:view', 'gov:participate', 'gov:electoral_officer', 'gov:manage', 'marketplace:view', 'marketplace:list', 'marketplace:contract'];
        expect(MEMBER_BEFORE.filter(p => !MEMBER_DEFAULT_PERMS.includes(p))).toEqual([]);
        expect(DISPATCHER_BEFORE.filter(p => !DISPATCHER_DEFAULT_PERMS.includes(p))).toEqual([]);
        expect(MEMBER_DEFAULT_PERMS).toHaveLength(MEMBER_BEFORE.length + MEMBER_MODULE_GRANTS.length);
        expect(DISPATCHER_DEFAULT_PERMS).toHaveLength(DISPATCHER_BEFORE.length + DISPATCHER_MODULE_GRANTS.length);
    });

    it("both directions — the Client tier gains nothing", () => {
        // Also keeps STAFF_VIEW_PERMS ∩ CLIENT_DEFAULT_PERMS = ∅ trivially true.
        expect(CLIENT_DEFAULT_PERMS).toEqual(['request:create', 'request:cancel', 'request:rate']);
        expect(CLIENT_DEFAULT_PERMS.some(p => /^(qm|warehouse|finance|academy):/.test(p))).toBe(false);
    });

    it("Admin's grant is still derived from the catalog, not enumerated", () => {
        // If Admin is ever hoisted into a literal it silently stops picking up new
        // permissions and repairDatabase's sync becomes the only path.
        expect(read('lib/db/seeder.ts')).toContain('const adminPerms = permissions.map(p => p.name);');
    });

    it('the seeder consumes the shared constants rather than its own literals', () => {
        const src = read('lib/db/seeder.ts');
        expect(src).toContain('MEMBER_DEFAULT_PERMS');
        expect(src).toContain('DISPATCHER_DEFAULT_PERMS');
        expect(src).not.toContain("'alliance:view', 'user:receive:eam'");
    });
});

// ---------------------------------------------------------------------------

type World = {
    roles: Array<{ id: number; name: string }>;
    /** existing role_permissions count per role id (fresh install = 0 for all) */
    heldCount: Record<number, number>;
    countError: unknown;
};

let world: World;
let upserted: Array<{ role_id: number; permission_id: number }>;
let markerUpserts: Array<{ key: string; value: { applied?: string[] } }>;

const isHeadCount = (q: Q) => q.calls.some(c => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);
const argOf = (q: Q, method: string) => q.calls.find(c => c.method === method)?.args;

beforeEach(() => {
    h.queries = [];
    upserted = [];
    markerUpserts = [];
    world = {
        roles: [
            { id: ROLE_IDS.Client, name: 'Client' },
            { id: ROLE_IDS.Member, name: 'Member' },
            { id: ROLE_IDS.Dispatcher, name: 'Dispatcher' },
            { id: ROLE_IDS.Admin, name: 'Admin' },
            // A custom role the operator added. Nothing may ever be written to it.
            { id: ROLE_IDS.Contractors, name: 'Contractors' },
        ],
        heldCount: {},
        countError: null,
    };
    h.resolve = (q) => {
        if (q.table === 'roles') return { data: world.roles, error: null };
        if (q.table === 'permissions') return { data: SCHEMA_PERMS.map(name => ({ id: PERM_ID.get(name), name })), error: null };
        if (q.table === 'role_permissions') {
            if (isHeadCount(q)) {
                if (world.countError) return { count: null, error: world.countError };
                const roleId = argOf(q, 'eq')?.[1] as number;
                return { count: world.heldCount[roleId] ?? 0, error: null };
            }
            const rows = argOf(q, 'upsert')?.[0] as Array<{ role_id: number; permission_id: number }> | undefined;
            if (rows) upserted.push(...rows);
            return { data: null, error: null };
        }
        if (q.table === 'settings') {
            const row = argOf(q, 'upsert')?.[0] as { key?: string; value?: { applied?: string[] } } | undefined;
            if (row?.key === ROLE_DEFAULT_BACKFILL_MARKER_KEY) markerUpserts.push({ key: row.key, value: row.value ?? {} });
            return { data: null, error: null };
        }
        return { data: [], error: null };
    };
});

const grantedTo = (roleId: number) => upserted.filter(r => r.role_id === roleId).map(r => NAME_BY_ID.get(r.permission_id)!);

describe('seedInstall — a fresh install', () => {
    it('grants the optional-module defaults to Member and Dispatcher', async () => {
        await seedInstall();
        for (const p of MEMBER_MODULE_GRANTS) expect(grantedTo(ROLE_IDS.Member)).toContain(p);
        for (const p of DISPATCHER_MODULE_GRANTS) expect(grantedTo(ROLE_IDS.Dispatcher)).toContain(p);
        expect(grantedTo(ROLE_IDS.Member).sort()).toEqual([...MEMBER_DEFAULT_PERMS].sort());
        expect(grantedTo(ROLE_IDS.Dispatcher).sort()).toEqual([...DISPATCHER_DEFAULT_PERMS].sort());
    });

    it('is born marked, so the one-shot repair backfill can never fire on it', async () => {
        // Without this stamp the first Repair on a NEW install — step 3 of every
        // upgrade in DEPLOYMENT_GUIDE.md — hands back whatever the operator revoked.
        await seedInstall();
        expect(markerUpserts).toHaveLength(1);
        // EVERY one-shot id: a fresh install is born correct for all of them, so none
        // may fire on a later Repair.
        expect(markerUpserts[0].value.applied).toEqual([...ALL_BACKFILL_IDS]);
    });

    it('both directions — Client and Admin keep their tiers, and no custom role is written to', async () => {
        await seedInstall();
        expect(grantedTo(ROLE_IDS.Client).sort()).toEqual([...CLIENT_DEFAULT_PERMS].sort());
        expect(grantedTo(ROLE_IDS.Admin).sort()).toEqual([...SCHEMA_PERMS].sort());
        expect(upserted.some(r => r.role_id === ROLE_IDS.Contractors)).toBe(false);
        expect(grantedTo(ROLE_IDS.Client).some(p => /^(qm|warehouse|finance|academy):/.test(p))).toBe(false);
    });
});

describe('seedInstall — a re-seed over a populated install', () => {
    // repairDatabase re-enters seedInstall whenever the Admin role holds < 5
    // permissions, which an admin can produce from the Roles UI (no floor there).
    // The upsert is purely additive, so without a freshness check that Repair click
    // would restore every Member/Dispatcher default the operator had revoked.
    it('does not restore a revoked Member or Dispatcher permission', async () => {
        world.heldCount = { [ROLE_IDS.Member]: 20, [ROLE_IDS.Dispatcher]: 55 };
        await seedInstall();
        expect(grantedTo(ROLE_IDS.Member)).toEqual([]);
        expect(grantedTo(ROLE_IDS.Dispatcher)).toEqual([]);
        // Admin is still re-converged — that is WHY this branch fires — and Client is
        // still clamped by repair's strip.
        expect(grantedTo(ROLE_IDS.Admin).sort()).toEqual([...SCHEMA_PERMS].sort());
        expect(grantedTo(ROLE_IDS.Client).sort()).toEqual([...CLIENT_DEFAULT_PERMS].sort());
    });

    it('does not burn the one-shot marker when it seeded neither tier', async () => {
        world.heldCount = { [ROLE_IDS.Member]: 20, [ROLE_IDS.Dispatcher]: 55 };
        await seedInstall();
        expect(markerUpserts).toEqual([]);
    });

    it('a partially-populated install seeds only the empty tier and stays re-armable', async () => {
        world.heldCount = { [ROLE_IDS.Dispatcher]: 55 };
        await seedInstall();
        expect(grantedTo(ROLE_IDS.Member).sort()).toEqual([...MEMBER_DEFAULT_PERMS].sort());
        expect(grantedTo(ROLE_IDS.Dispatcher)).toEqual([]);
        expect(markerUpserts).toEqual([]);
    });

    it('fails closed — an unreadable grant count is treated as populated, not empty', async () => {
        world.countError = { code: '42501', message: 'permission denied' };
        await seedInstall();
        expect(grantedTo(ROLE_IDS.Member)).toEqual([]);
        expect(grantedTo(ROLE_IDS.Dispatcher)).toEqual([]);
        expect(markerUpserts).toEqual([]);
    });
});
