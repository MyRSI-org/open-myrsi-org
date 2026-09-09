import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Pins for the ONE-SHOT optional-module role-default backfill
// (lib/db/roleDefaults.ts, wired into repairDatabase).
//
// role_permissions is (role_id, permission_id) with no tombstone,
// updateRolePermissions is delete-all-then-insert, and there is no audit table, so
// "never granted" and "deliberately revoked" are INDISTINGUISHABLE from stored state.
// Repair Database is an unbounded admin click and step 3 of every upgrade in
// DEPLOYMENT_GUIDE.md. The load-bearing property, and the reason this file exists:
//
//   *** Repair can never re-grant a permission an operator deliberately revoked. ***
//
// Three guards make that true — the marker (armed at seed time for fresh installs, so
// the backfill can only ever fire on an install seeded by the OLD code), a role
// identity check (getSystemRoles resolves POSITIONALLY and can put a custom role in
// the member/dispatcher slot on a renamed pre-is_system install), and a namespace
// guard (a namespace the role already holds anything in is skipped whole). Every
// failure path leaves the marker UNWRITTEN, except the deliberate fail-closed one:
// an unreadable marker reads as "already applied", never as "never ran".

type Q = { table: string; calls: Array<{ method: string; args: unknown[] }> };

const h = vi.hoisted(() => ({
    queries: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
    resolve: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: [] as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => Record<string, unknown>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => { const q = { table, calls }; h.queries.push(q); return Promise.resolve(h.resolve(q)); };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (res: any, rej: any) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        getSystemRoles: async () => ({}),
    };
});

import {
    backfillOptionalModuleRoleDefaults,
    markOptionalModuleDefaultsApplied,
    ROLE_DEFAULT_BACKFILL_MARKER_KEY,
    OPTIONAL_MODULE_BACKFILL_ID,
    ALL_BACKFILL_IDS,
} from '../lib/db/roleDefaults';
import { OPTIONAL_MODULE_ROLE_DEFAULTS } from '../lib/roleDefaultPermissions';

const ROLE = {
    client: { id: 1, name: 'Client' },
    member: { id: 2, name: 'Member' },
    dispatcher: { id: 3, name: 'Dispatcher' },
    admin: { id: 4, name: 'Admin' },
};

const CATALOG = [...new Set(OPTIONAL_MODULE_ROLE_DEFAULTS.flatMap(g => [...g.member, ...g.dispatcher]))];
const PERM_ID = new Map(CATALOG.map((name, i) => [name, i + 10]));
const NAME_BY_ID = new Map([...PERM_ID].map(([name, id]) => [id, name]));

type World = {
    /** applied ids in the marker row; null = no settings row at all */
    applied: string[] | null;
    /** permission names the catalog resolves; defaults to the full wanted set */
    catalog: string[];
    /** permission names each role already holds */
    held: Record<number, string[]>;
    errors: Partial<Record<'markerRead' | 'markerWrite' | 'catalog' | 'held' | 'grant', unknown>>;
};

let world: World;

const argOf = (q: Q, method: string) => q.calls.find(c => c.method === method)?.args;
const settingsQueries = () => h.queries.filter(q => q.table === 'settings');
const markerWrites = () => settingsQueries().filter(q => argOf(q, 'upsert'));
const grantWrites = () => h.queries.filter(q => q.table === 'role_permissions' && argOf(q, 'upsert'));
const upsertedRows = () => grantWrites().flatMap(q => (argOf(q, 'upsert')![0] as Array<{ role_id: number; permission_id: number }>));
const grantedNames = (roleId: number) => upsertedRows().filter(r => r.role_id === roleId).map(r => NAME_BY_ID.get(r.permission_id)!);

beforeEach(() => {
    h.queries = [];
    world = {
        applied: null,
        catalog: [...CATALOG],
        held: { [ROLE.member.id]: ['operations:view'], [ROLE.dispatcher.id]: ['operations:manage'] },
        errors: {},
    };
    h.resolve = (q) => {
        if (q.table === 'settings') {
            if (argOf(q, 'upsert')) return world.errors.markerWrite ? { data: null, error: world.errors.markerWrite } : { data: null, error: null };
            if (world.errors.markerRead) return { data: null, error: world.errors.markerRead };
            return { data: world.applied === null ? null : { value: { applied: world.applied } }, error: null };
        }
        if (q.table === 'permissions') {
            if (world.errors.catalog) return { data: null, error: world.errors.catalog };
            return { data: world.catalog.map(name => ({ id: PERM_ID.get(name), name })), error: null };
        }
        if (q.table === 'role_permissions') {
            if (argOf(q, 'upsert')) return world.errors.grant ? { data: null, error: world.errors.grant } : { data: null, error: null };
            if (world.errors.held) return { data: null, error: world.errors.held };
            const roleId = argOf(q, 'eq')?.[1] as number;
            return { data: (world.held[roleId] || []).map(name => ({ permission_id: PERM_ID.get(name) ?? 999, permissions: { name } })), error: null };
        }
        return { data: [], error: null };
    };
});

describe('one-shot backfill — the happy path', () => {
    it('grants the module defaults to roles that hold none of the namespace', async () => {
        const r = await backfillOptionalModuleRoleDefaults(ROLE);
        expect(r.status).toBe('granted');
        expect(grantedNames(ROLE.member.id).sort()).toEqual(
            [...OPTIONAL_MODULE_ROLE_DEFAULTS.flatMap(g => g.member)].sort());
        expect(grantedNames(ROLE.dispatcher.id).sort()).toEqual(
            [...OPTIONAL_MODULE_ROLE_DEFAULTS.flatMap(g => g.dispatcher)].sort());
        expect(r.granted).toBe(upsertedRows().length);
        expect(r.skipped).toEqual([]);
    });

    it('stamps the marker as an ARRAY entry so a future one-shot can add its own id', async () => {
        world.applied = ['some-earlier-backfill@1'];
        await backfillOptionalModuleRoleDefaults(ROLE);
        expect(markerWrites()).toHaveLength(1);
        const row = argOf(markerWrites()[0], 'upsert')![0] as { key: string; value: { applied: string[] } };
        expect(row.key).toBe(ROLE_DEFAULT_BACKFILL_MARKER_KEY);
        // Every id that RAN, unioned onto whatever was already recorded.
        expect(row.value.applied).toEqual(['some-earlier-backfill@1', ...ALL_BACKFILL_IDS]);
    });

    it('the ids are per GROUP, so a module added later is not decorative', () => {
        // The defect this shape exists to prevent: with one file-wide id, every group
        // added after an install passed the one-shot is unreachable forever — the
        // marker already names the id, the whole pass short-circuits, and the new
        // namespace is silently never granted on any existing deployment.
        expect(ALL_BACKFILL_IDS.length).toBeGreaterThan(1);
        for (const g of OPTIONAL_MODULE_ROLE_DEFAULTS) expect(typeof g.backfillId).toBe('string');
    });
});

describe('one-shot backfill — a revoke must stick', () => {
    it('a second run is a no-op: the marker suppresses it entirely', async () => {
        // THE pin. An operator revokes finance:view from Member, then runs Repair as
        // part of the next upgrade. Nothing may hand it back.
        world.applied = [...ALL_BACKFILL_IDS];
        world.held = { [ROLE.member.id]: [], [ROLE.dispatcher.id]: [] };
        const r = await backfillOptionalModuleRoleDefaults(ROLE);
        expect(r).toEqual({ status: 'already-applied', granted: 0, skipped: [] });
        expect(h.queries.filter(q => q.table === 'role_permissions')).toEqual([]);
        expect(h.queries.filter(q => q.table === 'permissions')).toEqual([]);
        expect(markerWrites()).toEqual([]);
    });

    it('an install marked for the ORIGINAL one-shot still receives a LATER group — and only that group', async () => {
        // The other half of the same rule. An operator who revoked finance:view before
        // this build existed must not get it back; a module whose one-shot they have
        // never seen must still reach them.
        const legacy = OPTIONAL_MODULE_ROLE_DEFAULTS.filter(g => g.backfillId === OPTIONAL_MODULE_BACKFILL_ID);
        const later = OPTIONAL_MODULE_ROLE_DEFAULTS.filter(g => g.backfillId !== OPTIONAL_MODULE_BACKFILL_ID);
        expect(later.length).toBeGreaterThan(0);

        world.applied = [OPTIONAL_MODULE_BACKFILL_ID];
        world.held = { [ROLE.member.id]: [], [ROLE.dispatcher.id]: [] };
        const r = await backfillOptionalModuleRoleDefaults(ROLE);
        expect(r.status).toBe('granted');
        expect(grantedNames(ROLE.member.id).sort()).toEqual([...later.flatMap(g => g.member)].sort());
        for (const g of legacy) {
            for (const p of g.member) expect(grantedNames(ROLE.member.id), `${p} was re-granted`).not.toContain(p);
        }
        // Only the ids that actually ran are burned.
        const row = argOf(markerWrites()[0], 'upsert')![0] as { value: { applied: string[] } };
        expect(row.value.applied.sort()).toEqual([...ALL_BACKFILL_IDS].sort());
    });

    it('a namespace the operator has already configured is left alone, whole', async () => {
        world.held = { [ROLE.member.id]: ['warehouse:view'], [ROLE.dispatcher.id]: ['operations:manage'] };
        const r = await backfillOptionalModuleRoleDefaults(ROLE);
        expect(r.status).toBe('granted');
        expect(grantedNames(ROLE.member.id).some(p => p.startsWith('warehouse:'))).toBe(false);
        expect(grantedNames(ROLE.member.id)).toContain('qm:view');
        expect(grantedNames(ROLE.member.id)).toContain('finance:view');
        expect(r.skipped).toContain('Member:warehouse:');
    });

    it('an install with every namespace configured burns the shot without granting', async () => {
        // "At most once, ever": the operator has made their choices in all three
        // namespaces, so a later Repair must not revisit them either.
        const oneOfEach = OPTIONAL_MODULE_ROLE_DEFAULTS.map(g => g.member[0]);
        world.held = {
            [ROLE.member.id]: oneOfEach,
            [ROLE.dispatcher.id]: oneOfEach,
        };
        const r = await backfillOptionalModuleRoleDefaults(ROLE);
        expect(r.status).toBe('skipped-configured');
        expect(grantWrites()).toEqual([]);
        expect(markerWrites()).toHaveLength(1);
    });

    it('markOptionalModuleDefaultsApplied stamps without granting (the seed-time arm)', async () => {
        await markOptionalModuleDefaultsApplied();
        expect(h.queries.filter(q => q.table === 'role_permissions')).toEqual([]);
        const row = argOf(markerWrites()[0], 'upsert')![0] as { value: { applied: string[] } };
        // ALL ids: a fresh install is born correct for every group, so none of them
        // may fire on it later.
        expect(row.value.applied).toEqual([...ALL_BACKFILL_IDS]);
    });

    it('a re-arm is idempotent — an already-applied marker is not rewritten', async () => {
        world.applied = [...ALL_BACKFILL_IDS];
        await markOptionalModuleDefaultsApplied();
        expect(markerWrites()).toEqual([]);
    });
});

describe('one-shot backfill — fail closed in both directions', () => {
    it('a marker READ fault suppresses the backfill (a read error is never "absent")', async () => {
        world.errors.markerRead = { code: '42P01', message: 'relation does not exist' };
        const r = await backfillOptionalModuleRoleDefaults(ROLE);
        expect(r.status).toBe('already-applied');
        expect(grantWrites()).toEqual([]);
        expect(markerWrites()).toEqual([]);
    });

    it('a permission-catalog fault aborts the pass without writing the marker', async () => {
        world.errors.catalog = { code: '08006', message: 'connection failure' };
        const r = await backfillOptionalModuleRoleDefaults(ROLE);
        expect(r.status).toBe('failed');
        expect(grantWrites()).toEqual([]);
        expect(markerWrites()).toEqual([]);
    });

    it('an INCOMPLETE catalog aborts rather than granting a subset and sealing the rest out', async () => {
        // repairDatabase's own catalog top-up only LOGS on failure, so a name really
        // can be missing here. Granting part of the set and then stamping would make
        // the remainder unreachable on this install forever.
        world.catalog = CATALOG.filter(n => n !== 'finance:approve');
        const r = await backfillOptionalModuleRoleDefaults(ROLE);
        expect(r.status).toBe('failed');
        expect(grantWrites()).toEqual([]);
        expect(markerWrites()).toEqual([]);
    });

    it('a grants READ fault aborts the pass without writing the marker', async () => {
        world.errors.held = { code: '42501', message: 'permission denied' };
        const r = await backfillOptionalModuleRoleDefaults(ROLE);
        expect(r.status).toBe('failed');
        expect(grantWrites()).toEqual([]);
        expect(markerWrites()).toEqual([]);
    });

    it('a grant WRITE fault does not write the marker', async () => {
        world.errors.grant = { code: '23503', message: 'foreign key violation' };
        const r = await backfillOptionalModuleRoleDefaults(ROLE);
        expect(r.status).toBe('failed');
        expect(markerWrites()).toEqual([]);
    });

    it('a marker WRITE fault still reports the grant it actually made', async () => {
        world.errors.markerWrite = { code: '08006', message: 'connection failure' };
        const r = await backfillOptionalModuleRoleDefaults(ROLE);
        expect(r.status).toBe('granted');
        expect(r.granted).toBeGreaterThan(0);
    });
});

describe('one-shot backfill — both directions: who must gain nothing', () => {
    it('an unprivileged CUSTOM role in the member slot is declined, not granted to', async () => {
        // getSystemRoles falls back to roles[1] / roles[2] by id on a renamed,
        // pre-is_system install, so "member" can be a role nobody chose. The namespace
        // guard does not save you: a custom role holds nothing in these namespaces,
        // which is exactly the case the guard permits.
        const r = await backfillOptionalModuleRoleDefaults({
            member: { id: 7, name: 'Contractors' },
            dispatcher: ROLE.dispatcher,
        });
        expect(r.status).toBe('skipped-roles');
        expect(grantWrites()).toEqual([]);
        expect(markerWrites()).toEqual([]);
    });

    it('an unresolved system role is never guessed at', async () => {
        const r = await backfillOptionalModuleRoleDefaults({ member: undefined, dispatcher: ROLE.dispatcher });
        expect(r.status).toBe('skipped-roles');
        expect(grantWrites()).toEqual([]);
        expect(markerWrites()).toEqual([]);
    });

    it('never writes to the Client or Admin role', async () => {
        await backfillOptionalModuleRoleDefaults(ROLE);
        expect(upsertedRows().length).toBeGreaterThan(0);
        for (const row of upsertedRows()) {
            expect([ROLE.member.id, ROLE.dispatcher.id]).toContain(row.role_id);
        }
        expect(grantedNames(ROLE.client.id)).toEqual([]);
        expect(grantedNames(ROLE.admin.id)).toEqual([]);
    });

    it('never grants a module-config bucket, finance:manage, or any academy permission', async () => {
        await backfillOptionalModuleRoleDefaults(ROLE);
        const names = upsertedRows().map(r => NAME_BY_ID.get(r.permission_id)!);
        expect(names.length).toBeGreaterThan(0);
        for (const forbidden of ['finance:admin', 'qm:admin', 'warehouse:admin', 'marketplace:admin', 'finance:manage']) {
            expect(names).not.toContain(forbidden);
        }
        expect(names.some(n => n.startsWith('academy:'))).toBe(false);
    });

    it('unlocks no action OUTSIDE the namespace it is granted for', async () => {
        // The class of miss this guards against: fullPermissionMap's two destructive
        // module resets used to sit on 'finance:manage' / 'qm:manage' while living in
        // the admin: section ~140 lines away from the finance:/qm: blocks — and
        // 'admin:' is not an OPTIONAL_FEATURE_NAMESPACES prefix, so the feature gate
        // never covered them. Granting a module perm must never reach across
        // namespaces like that again.
        await backfillOptionalModuleRoleDefaults(ROLE);
        const granted = new Set(upsertedRows().map(r => NAME_BY_ID.get(r.permission_id)!));
        expect(granted.size).toBeGreaterThan(0);

        const crossNamespace = (mapSrc: string) => {
            const map = mapSrc.slice(mapSrc.indexOf('fullPermissionMap'));
            return [...map.matchAll(/'([a-z][a-z0-9_:]+)'\s*:\s*'([a-z][a-z0-9_:]+)'/g)]
                .filter(([, action, perm]) => granted.has(perm) && !action.startsWith(perm.slice(0, perm.indexOf(':') + 1)))
                .map(([, action, perm]) => `${action} <- ${perm}`);
        };

        const services = readFileSync(resolve(__dirname, '..', 'api', 'services.ts'), 'utf8');
        expect(crossNamespace(services)).toEqual([]);
        // The detector is live, not vacuous: the pre-fix mapping is caught.
        expect(crossNamespace("fullPermissionMap = {\n    'admin:db:reset_quartermaster': 'qm:manage',\n}"))
            .toEqual(['admin:db:reset_quartermaster <- qm:manage']);
    });

    it('the module-reset handlers carry the genuine-Admin backstop this grant depends on', async () => {
        // Hard prerequisite for granting qm:manage to the seeded Dispatcher: without a
        // role gate on the handler, that grant would hand every Dispatcher a button
        // that deletes every quartermaster issuance, movement and location outright.
        const admin = readFileSync(resolve(__dirname, '..', 'api', 'actions', 'admin.ts'), 'utf8');
        for (const action of ['admin:db:reset_finances', 'admin:db:reset_quartermaster']) {
            const line = admin.split('\n').find(l => l.includes(`'${action}':`));
            expect(line, `${action} handler not found`).toBeTruthy();
            expect(line, `${action} has no genuine-Admin gate`).toMatch(/assert(AdminRole|DomainResetPerm)\(/);
        }
    });
});

describe('one-shot backfill — wire-level hygiene', () => {
    it('no wildcard reaches the wire on this path', async () => {
        await backfillOptionalModuleRoleDefaults(ROLE);
        const selects = h.queries.flatMap(q => q.calls.filter(c => c.method === 'select').map(c => c.args[0]));
        expect(selects.length).toBeGreaterThan(0);
        for (const s of selects) {
            expect(typeof s).toBe('string');
            expect(String(s)).not.toContain('*');
        }
    });
});

describe('the backfill is actually wired into Repair', () => {
    // Without this the module can exist, pass everything above, and never run.
    const SYSTEM_SRC = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'system.ts'), 'utf8');
    const SEEDER_SRC = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'seeder.ts'), 'utf8');

    it('repairDatabase calls it after the Client strip and before the reminder drain', async () => {
        const at = (needle: string) => SYSTEM_SRC.indexOf(needle);
        expect(at('backfillOptionalModuleRoleDefaults(')).toBeGreaterThan(-1);
        expect(at('backfillOptionalModuleRoleDefaults(')).toBeGreaterThan(at('ALLOWED_CLIENT_PERMS'));
        expect(at('backfillOptionalModuleRoleDefaults(')).toBeLessThan(at('drainStaleOperationReminders()'));
    });

    it('repair drops the stale system-role memo before resolving the roles it writes to', async () => {
        // getSystemRoles caches for 5 minutes and is called twice earlier in the same
        // run, BEFORE the is_system stamp — so without this the backfill (and the
        // pre-existing Client strip) act on the pre-stamp positional fallback.
        const stamp = SYSTEM_SRC.indexOf("update({ is_system: true })");
        const resolveRoles = SYSTEM_SRC.indexOf('const repairedRoles = await getSystemRoles();');
        const invalidate = SYSTEM_SRC.indexOf("cache.invalidate('system_roles');", stamp);
        expect(invalidate).toBeGreaterThan(stamp);
        expect(invalidate).toBeLessThan(resolveRoles);
    });

    it('the seeder arms the marker so the backfill can never fire on a fresh install', async () => {
        expect(SEEDER_SRC).toContain('markOptionalModuleDefaultsApplied()');
    });

    it('every backfill outcome gets its own operator-facing message', async () => {
        // Four of the five returns are zero-granted and only ONE of them means
        // "nothing needed doing". Reporting a read fault as "already configured" is
        // what would make Repair untrustworthy.
        const tail = SYSTEM_SRC.slice(SYSTEM_SRC.indexOf('const grantNote'));
        const block = tail.slice(0, tail.indexOf('return {'));
        for (const status of ['granted', 'skipped-configured', 'skipped-roles', 'failed', 'already-applied']) {
            expect(block).toContain(`'${status}':`);
        }
        expect(block).toContain('could not be applied');
        expect(block).not.toMatch(/'failed':\s*' Module role defaults were left alone/);
    });
});
