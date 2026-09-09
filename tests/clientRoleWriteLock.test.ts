import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// The Client system role is CODE-OWNED (lib/clientRolePermissions.ts). Three rules
// stated only in the browser are pinned here on the server:
//
//   1. Its permission set is not editable. The handler DID refuse this before, but
//      through `if (sysRoles.client && sysRoles.client.id === roleId)` — and
//      getSystemRoles() swallows its read errors and returns {} on a DB fault, so
//      the lock silently LIFTED on exactly the fault it matters for. It also
//      compared a raw JSON `roleId`, so `{ roleId: "1" }` skipped it.
//   2. It is not a Discord-role mapping target (nor is Admin). A mapping is a
//      STANDING grant applied by a sync the target can trigger themselves.
//   3. An org import may not re-populate it with the source org's grants. The
//      importer preclears role_permissions and replaces it wholesale, and NOTHING
//      re-asserted the Client lock afterwards.
//
// Both directions are asserted throughout: an Admin keeps editing Member /
// Dispatcher / custom roles and keeps mapping them from Discord; nobody gains a
// write against Client (or Admin, for mappings).
//
// Only lib/db/common is mocked, so these run the REAL handler → real db-layer →
// real predicate chain. Every refusal also asserts NO WRITE was issued, never just
// that a promise rejected.
// =============================================================================


const h = vi.hoisted(() => ({
    systemRoles: {} as Record<string, { id: number; name: string } | undefined>,
    // roleId -> permission names (drives both the Client-grant read and roleTier).
    grants: {} as Record<number, string[]>,
    grantsError: null as { message: string } | null,
    deleteError: null as { message: string } | null,
    roles: [] as Array<{ id: number; name: string; is_system: boolean }>,
    permissions: [] as Array<{ id: number; name: string }>,
    users: {} as Record<number, { id: number; role_id: number }>,
    writes: [] as Array<{ table: string; op: string; payload: unknown; filters: Record<string, unknown> }>,
}));

const PERM_ID = (name: string): number => {
    const found = h.permissions.find((p) => p.name === name);
    return found ? found.id : 900 + name.length;
};

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const filters: Record<string, unknown> = {};
        let op = 'select';
        let payload: unknown = null;
        let cols = '';
        const b: Record<string, unknown> = {};
        b.select = (c?: string) => { if (op === 'select') cols = c ?? ''; return b; };
        b.eq = (c: string, v: unknown) => { filters[c] = v; return b; };
        b.in = (c: string, v: unknown) => { filters[`${c}__in`] = v; return b; };
        for (const m of ['neq', 'is', 'not', 'order', 'limit', 'gte', 'lte', 'gt', 'lt', 'ilike', 'like', 'or', 'range']) {
            b[m] = () => b;
        }
        b.insert = (rows: unknown) => { op = 'insert'; payload = rows; return b; };
        b.update = (patch: unknown) => { op = 'update'; payload = patch; return b; };
        b.upsert = (row: unknown) => { op = 'upsert'; payload = row; return b; };
        b.delete = () => { op = 'delete'; return b; };

        const rows = (): { data: Record<string, unknown>[] | null; error: { message: string } | null } => {
            if (table === 'roles') {
                let r = h.roles.slice();
                if (filters.id !== undefined) r = r.filter((x) => x.id === Number(filters.id));
                if (filters.name !== undefined) r = r.filter((x) => x.name === filters.name);
                if (filters.is_system !== undefined) r = r.filter((x) => x.is_system === filters.is_system);
                return { data: r as unknown as Record<string, unknown>[], error: null };
            }
            if (table === 'role_permissions') {
                if (h.grantsError) return { data: null, error: h.grantsError };
                const names = h.grants[Number(filters.role_id)] || [];
                if (cols.includes('permissions!inner')) {
                    return { data: names.map((n) => ({ permission_id: PERM_ID(n), permissions: { name: n } })), error: null };
                }
                if (cols.includes('permission:permissions')) {
                    return { data: names.map((n) => ({ permission: { name: n } })), error: null };
                }
                return { data: names.map((n) => ({ permission_id: PERM_ID(n) })), error: null };
            }
            if (table === 'permissions') {
                const wanted = filters.name__in as string[] | undefined;
                const p = wanted ? h.permissions.filter((x) => wanted.includes(x.name)) : h.permissions;
                return { data: p as unknown as Record<string, unknown>[], error: null };
            }
            if (table === 'users') {
                const u = filters.id !== undefined ? h.users[Number(filters.id)] : undefined;
                return { data: u ? [u as unknown as Record<string, unknown>] : [], error: null };
            }
            return { data: [], error: null };
        };

        const settle = () => {
            if (op !== 'select') {
                h.writes.push({ table, op, payload, filters: { ...filters } });
                const err = op === 'delete' && table === 'role_permissions' ? h.deleteError : null;
                return Promise.resolve({ data: null, error: err, count: 0 });
            }
            const { data, error } = rows();
            return Promise.resolve({ data, error, count: data ? data.length : 0 });
        };
        b.single = () => settle().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }));
        b.maybeSingle = b.single;
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => h.systemRoles,
    };
});
vi.mock('../lib/push', () => ({ sendPushToAll: () => {}, sendPushToStaff: () => {}, sendPushToPermission: () => {} }));
vi.mock('../lib/db/seeder', () => ({ seedNewOrganization: async () => {}, seedInstall: async () => {} }));

import { assertRoleIsNotClient, assertRoleIsMappable, enforceClientRolePermissionLock } from '../lib/db/clientRoleLock';
import { repairDatabase } from '../lib/db/system';
import { reconcileRolePermissionsAfterImport, importOrgData } from '../lib/db/importer';
import { adminActions } from '../api/actions/admin';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';

type Handler = (p: unknown) => unknown;
const updateRolePerms = (adminActions as unknown as Record<string, Handler>)['admin:update_role_permissions'];
const updateRankMapping = (adminActions as unknown as Record<string, Handler>)['admin:update_rank_mapping'];

// The genuine system Admin, resolved by role IDENTITY (roleId === sysRoles.admin.id).
const ADMIN = { id: 1, roleId: 4, role: 'Admin', permissions: ['admin:access', 'admin:config:roles', 'admin:config:discord', 'admin:user:update_role'] };

const writesTo = (table: string) => h.writes.filter((w) => w.table === table);

beforeEach(() => {
    h.systemRoles = {
        client: { id: 1, name: 'Client' },
        member: { id: 2, name: 'Member' },
        dispatcher: { id: 3, name: 'Dispatcher' },
        admin: { id: 4, name: 'Admin' },
    };
    h.roles = [
        { id: 1, name: 'Client', is_system: true },
        { id: 2, name: 'Member', is_system: true },
        { id: 3, name: 'Dispatcher', is_system: true },
        { id: 4, name: 'Admin', is_system: true },
        { id: 9, name: 'Deputy', is_system: false },
    ];
    h.permissions = [
        { id: 11, name: 'request:create' }, { id: 12, name: 'request:cancel' }, { id: 13, name: 'request:rate' },
        { id: 40, name: 'admin:access' }, { id: 41, name: 'request:dispatch' },
    ];
    h.grants = { 1: [...CLIENT_DEFAULT_PERMS], 9: ['admin:access'] };
    h.grantsError = null;
    h.deleteError = null;
    h.users = {};
    h.writes = [];
});

// ---------------------------------------------------------------------------
// 1. assertRoleIsNotClient — the predicate
// ---------------------------------------------------------------------------
describe('assertRoleIsNotClient', () => {
    it('refuses the Client role with the exact operator-facing copy', async () => {
        // Byte-exact on purpose. tests/errors.test.ts only feeds this literal to the
        // classifier from a fixture array and would NOT notice a reword — this is
        // the only real pin on the string.
        await expect(assertRoleIsNotClient(1)).rejects.toThrow('The Client role is locked. Its permissions cannot be modified.');
    });

    it('KEEP — every other role stays editable', async () => {
        for (const id of [2, 3, 4, 9]) {
            await expect(assertRoleIsNotClient(id)).resolves.toBeUndefined();
        }
    });

    it('coerces the id — "1" is the Client role too', async () => {
        await expect(assertRoleIsNotClient('1')).rejects.toThrow(/Client role is locked/);
    });

    it('rejects a junk id rather than comparing it', async () => {
        await expect(assertRoleIsNotClient(0)).rejects.toThrow('Invalid role id.');
        await expect(assertRoleIsNotClient('abc')).rejects.toThrow('Invalid role id.');
    });

    it('fails CLOSED when the system roles cannot be resolved', async () => {
        h.systemRoles = {};
        await expect(assertRoleIsNotClient(1)).rejects.toThrow(/Repair Database/);
        await expect(assertRoleIsNotClient(2)).rejects.toThrow(/Repair Database/);
    });
});

// ---------------------------------------------------------------------------
// 2. admin:update_role_permissions — the live handler, end to end
// ---------------------------------------------------------------------------
describe('admin:update_role_permissions', () => {
    it('refuses the Client role and issues NO role_permissions write', async () => {
        await expect(updateRolePerms({ roleId: 1, permissionNames: ['admin:access'], user: ADMIN }))
            .rejects.toThrow('The Client role is locked. Its permissions cannot be modified.');
        expect(writesTo('role_permissions')).toEqual([]);
    });

    it('refuses a STRING Client id — the old compare let `{ roleId: "1" }` through', async () => {
        await expect(updateRolePerms({ roleId: '1', permissionNames: ['admin:access'], user: ADMIN }))
            .rejects.toThrow(/Client role is locked/);
        expect(writesTo('role_permissions')).toEqual([]);
    });

    // The single most important assertion in this file: on a getSystemRoles read
    // fault the OLD handler short-circuited false, assertCanManageRolePermissions
    // returned early for an Admin actor, and updateRolePermissions issued a
    // delete + insert on role 1 — granting the Client role admin:access.
    it('fails CLOSED on an unresolvable system-role read, with no write', async () => {
        h.systemRoles = {};
        await expect(updateRolePerms({ roleId: 1, permissionNames: ['admin:access'], user: ADMIN }))
            .rejects.toThrow(/Repair Database/);
        expect(writesTo('role_permissions')).toEqual([]);
    });

    it('KEEP — an Admin still rewrites the Dispatcher role, and the write lands', async () => {
        await expect(updateRolePerms({ roleId: 3, permissionNames: ['request:dispatch'], user: ADMIN })).resolves.toBeUndefined();
        const rp = writesTo('role_permissions');
        expect(rp.some((w) => w.op === 'delete' && Number(w.filters.role_id) === 3)).toBe(true);
        expect(rp.some((w) => w.op === 'insert')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 3. assertRoleIsMappable + admin:update_rank_mapping
// ---------------------------------------------------------------------------
describe('assertRoleIsMappable', () => {
    it('refuses Client (it shadows every other mapping and pins its holders)', async () => {
        await expect(assertRoleIsMappable(1)).rejects.toThrow(/Client role cannot be mapped/);
    });

    it('refuses Admin (a standing grant administered outside this app)', async () => {
        await expect(assertRoleIsMappable(4)).rejects.toThrow(/Admin role cannot be mapped/);
    });

    it('KEEP — Member, Dispatcher and custom roles stay mappable', async () => {
        for (const id of [2, 3, 9]) await expect(assertRoleIsMappable(id)).resolves.toBeUndefined();
    });

    it('fails CLOSED when the system roles cannot be resolved', async () => {
        h.systemRoles = {};
        await expect(assertRoleIsMappable(2)).rejects.toThrow(/Repair Database/);
    });
});

describe('admin:update_rank_mapping', () => {
    it('refuses a Client mapping and writes no rank_mappings row', async () => {
        await expect(updateRankMapping({ discordRoleId: '123', rankId: '', roleId: 1, user: ADMIN }))
            .rejects.toThrow(/Client role cannot be mapped/);
        expect(writesTo('rank_mappings')).toEqual([]);
    });

    // assertCanAssignRole short-circuits its Admin-role ceiling for an actor who
    // HOLDS the Admin role, so before this guard an Admin could wire "anyone with
    // this Discord role becomes Admin" with no approval step and no audit row.
    it('refuses an Admin mapping even for a genuine Admin actor', async () => {
        await expect(updateRankMapping({ discordRoleId: '123', rankId: '', roleId: 4, user: ADMIN }))
            .rejects.toThrow(/Admin role cannot be mapped/);
        expect(writesTo('rank_mappings')).toEqual([]);
    });

    it('KEEP — a Member mapping is written exactly as before', async () => {
        await expect(updateRankMapping({ discordRoleId: '123', rankId: '', roleId: 2, user: ADMIN })).resolves.toBeUndefined();
        const rm = writesTo('rank_mappings');
        expect(rm.length).toBe(1);
        expect(rm[0].op).toBe('upsert');
        expect(rm[0].payload).toMatchObject({ discord_role_id: '123', role_id: 2 });
    });

    it('KEEP — clearing a mapping (no rank, no role) is never refused', async () => {
        await expect(updateRankMapping({ discordRoleId: '123', rankId: '', roleId: undefined, user: ADMIN })).resolves.toBeUndefined();
        expect(writesTo('rank_mappings').map((w) => w.op)).toEqual(['delete']);
    });
});

// ---------------------------------------------------------------------------
// 4. enforceClientRolePermissionLock — the reconvergence
// ---------------------------------------------------------------------------
describe('enforceClientRolePermissionLock', () => {
    it('strips exactly the excess grants, scoped to the role and those permission ids', async () => {
        h.grants[1] = [...CLIENT_DEFAULT_PERMS, 'admin:access'];
        await expect(enforceClientRolePermissionLock(1)).resolves.toEqual({ stripped: 1 });
        const del = writesTo('role_permissions').filter((w) => w.op === 'delete');
        expect(del.length).toBe(1);
        expect(Number(del[0].filters.role_id)).toBe(1);
        expect(del[0].filters.permission_id__in).toEqual([40]);
    });

    it('is idempotent — a compliant Client role issues NO delete', async () => {
        h.grants[1] = [...CLIENT_DEFAULT_PERMS];
        await expect(enforceClientRolePermissionLock(1)).resolves.toEqual({ stripped: 0 });
        expect(writesTo('role_permissions')).toEqual([]);
    });

    it('fails CLOSED on a grants read fault — never reports a lock it did not verify', async () => {
        h.grantsError = { message: 'boom' };
        await expect(enforceClientRolePermissionLock(1)).rejects.toThrow(/could not be read/);
        expect(writesTo('role_permissions')).toEqual([]);
    });

    it('surfaces a failed delete rather than reporting a strip that did not happen', async () => {
        h.grants[1] = [...CLIENT_DEFAULT_PERMS, 'admin:access'];
        h.deleteError = { message: 'nope' };
        await expect(enforceClientRolePermissionLock(1)).rejects.toThrow(/Failed to strip/);
    });

    it('refuses a junk role id — a destructive delete never runs off a guess', async () => {
        await expect(enforceClientRolePermissionLock(0)).rejects.toThrow('Invalid role id.');
        expect(writesTo('role_permissions')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 5. The import surface — the write path that skipped the lock entirely
// ---------------------------------------------------------------------------
describe('reconcileRolePermissionsAfterImport', () => {
    it('strips the imported Client role back to the build defaults', async () => {
        h.grants[1] = [...CLIENT_DEFAULT_PERMS, 'admin:access'];
        const res = await reconcileRolePermissionsAfterImport();
        expect(res.clientStripped).toBe(1);
        expect(res.warnings).toEqual([]);
        const del = writesTo('role_permissions').filter((w) => w.op === 'delete' && Number(w.filters.role_id) === 1);
        expect(del.length).toBe(1);
    });

    // The import has just deleted and re-inserted the whole roles table, so the
    // 5-minute getSystemRoles memo is stale BY CONSTRUCTION here. Resolving through
    // it could point the DELETE at whatever imported role now owns that id.
    it('resolves the Client role by NAME, not through the cached getSystemRoles memo', async () => {
        // Stale memo: says Client is id 7. The imported roles table says id 1.
        h.systemRoles = { client: { id: 7, name: 'Client' }, admin: { id: 4, name: 'Admin' } };
        h.grants[1] = [...CLIENT_DEFAULT_PERMS, 'admin:access'];
        h.grants[7] = ['request:dispatch', 'admin:access'];
        await reconcileRolePermissionsAfterImport();
        const del = writesTo('role_permissions').filter((w) => w.op === 'delete');
        expect(del.length).toBe(1);
        expect(Number(del[0].filters.role_id)).toBe(1);
        expect(del.some((w) => Number(w.filters.role_id) === 7)).toBe(false);
    });

    it('declines rather than guessing when the import carries no role named Client', async () => {
        h.roles = h.roles.filter((r) => r.name !== 'Client');
        const res = await reconcileRolePermissionsAfterImport();
        expect(res.clientStripped).toBe(0);
        expect(res.warnings).toEqual([]);
        expect(writesTo('role_permissions').filter((w) => w.op === 'delete')).toEqual([]);
    });

    // Refusal-vs-failure: every neighbouring reconcile in the importer returns a
    // count and logs. A throw here would report failure for an import whose rows are
    // ALL already written, and in merge mode would fire restoreAdminRow over the
    // admin the re-anchor just bound.
    it('never throws on a fault — it reports a warning', async () => {
        h.grantsError = { message: 'boom' };
        const res = await reconcileRolePermissionsAfterImport();
        expect(res.clientStripped).toBe(0);
        expect(res.warnings.length).toBe(1);
        expect(res.warnings[0]).toMatch(/Repair Database/);
    });
});

describe('importOrgData reports the Client strip as a warning', () => {
    const NDJSON = [
        '{"kind":"header","version":1,"tableOrder":["roles"],"manifest":{"roles":1}}',
        '{"kind":"row","t":"roles","r":{"id":1,"name":"Client"}}',
    ].join('\n');

    it('completes and warns about what it removed', async () => {
        h.grants[1] = [...CLIENT_DEFAULT_PERMS, 'admin:access'];
        const events: string[] = [];
        const result = await importOrgData(NDJSON, (e) => { if (e.type === 'warning') events.push(e.message); });
        expect(result.warnings.some((w) => /Client role held beyond/.test(w))).toBe(true);
        expect(events.some((w) => /Client role held beyond/.test(w))).toBe(true);
        // Scoped to the imported Client role, not to the PRE_CLEAR sweep.
        expect(writesTo('role_permissions').filter((w) => w.op === 'delete' && Number(w.filters.role_id) === 1).length).toBe(1);
    });

    it('KEEP — a compliant imported Client role produces no warning and no scoped delete', async () => {
        h.grants[1] = [...CLIENT_DEFAULT_PERMS];
        const result = await importOrgData(NDJSON);
        expect(result.warnings.some((w) => /Client role held beyond/.test(w))).toBe(false);
        expect(writesTo('role_permissions').filter((w) => w.op === 'delete' && w.filters.role_id !== undefined)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 6. repairDatabase — the strip's failure must stay LOCAL to the strip
// ---------------------------------------------------------------------------
describe('repairDatabase and the Client lock', () => {
    // Repair holds the org's last-resort recovery: the null-role backfill, the
    // module-defaults backfill, the "ensure at least one Admin exists" promotion and
    // the stale-reminder drain all run AFTER the Client strip, in one uncaught block.
    // The strip's predicate throws (that is right for the RPC and for the import) —
    // so Repair must contain it, or a transient role_permissions read fault costs the
    // operator every recovery step, on the very tool the fault's error copy tells
    // them to run.
    beforeEach(() => {
        // Enough admin grants that repair does not take its re-seed branch.
        h.grants[4] = ['admin:access', 'admin:config:roles', 'admin:config:discord', 'admin:user:update', 'admin:user:update_role', 'admin:db:destroy'];
    });

    it('carries on past a Client-grants read fault and still runs the recovery steps', async () => {
        h.grantsError = { message: 'transient' };
        const res = await repairDatabase();
        expect(res.success).toBe(true);
        expect(res.message).toMatch(/Client role permission lock could not be verified/);
        // The null-role backfill (writes users.role_id = the Member role) is the very
        // next statement after the strip, and the reminder drain is the last.
        expect(h.writes.some((w) => w.table === 'users' && w.op === 'update' && (w.payload as { role_id?: number }).role_id === 2)).toBe(true);
        expect(h.writes.some((w) => w.table === 'operation_reminders' && w.op === 'update')).toBe(true);
    });

    it('reports what it stripped when the lock does converge', async () => {
        h.grants[1] = [...CLIENT_DEFAULT_PERMS, 'admin:access'];
        const res = await repairDatabase();
        expect(res.success).toBe(true);
        expect(res.message).toMatch(/Stripped 1 excess permission\(s\) from the Client role\./);
    });

    it('says nothing about the Client role when there was nothing to strip', async () => {
        const res = await repairDatabase();
        expect(res.message).not.toMatch(/Client role/);
    });
});
