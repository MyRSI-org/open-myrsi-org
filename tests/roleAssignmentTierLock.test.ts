import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// The role-write ceiling was ONE-DIRECTIONAL.
//
// assertCanAssignRole caps the tier of the role you may HAND OUT. Nothing capped
// the tier of the user you may STRIP: every role-write path read the target's
// role_id only to skip no-ops. So a delegated admin:user:update_role holder could
// move an Admin onto the Client role — single (admin:update_user) or in bulk
// (admin:bulk_demote_to_client) — bulkPromoteUsersToMember would "promote" an Admin
// to Member, admin:promote_user had no guard at all, and a lone Admin could demote
// their own seat and orphan the org with no in-app route back.
//
// assertCanChangeUsersRole is the missing half. Three things it must get right, all
// pinned below:
//   - tiers come from STORED users.role_id via roleTier(), never from `actor.role`
//     (a free-text role name the mapper collapses into a tier);
//   - the APEX case is a role-IDENTITY compare, because roleTier scores ANY role
//     holding admin:access as 4 and the Admin panel itself is behind admin:access —
//     the realistic delegated "Deputy" already sits at tier 4;
//   - the self-lock coerces the id, because targetUserId is deliberately not an
//     ACTOR_ID_FIELD and PostgREST resolves "7" to row 7.
//
// Both directions: an Admin keeps every reach it has (including demoting another
// Admin from the detail view, and the HR/Clients-tab promote by a delegated role
// that holds none of roleTier's five ladder permissions); nobody gains a write over
// a more-privileged row. Every refusal also asserts NO WRITE was issued.
// =============================================================================

const h = vi.hoisted(() => ({
    systemRoles: {} as Record<string, { id: number; name: string } | undefined>,
    // roleId -> permission names, the source for roleTier's custom-role inference.
    grants: {} as Record<number, string[]>,
    grantsError: null as { message: string } | null,
    roles: [] as Array<{ id: number; name: string; is_system: boolean }>,
    users: {} as Record<number, { id: number; role_id: number }>,
    writes: [] as Array<{ table: string; op: string; payload: unknown; filters: Record<string, unknown> }>,
    rolePermQueries: 0,
}));

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
                return { data: r as unknown as Record<string, unknown>[], error: null };
            }
            if (table === 'role_permissions') {
                h.rolePermQueries++;
                if (h.grantsError) return { data: null, error: h.grantsError };
                const names = h.grants[Number(filters.role_id)] || [];
                if (cols.includes('permission:permissions')) {
                    return { data: names.map((n) => ({ permission: { name: n } })), error: null };
                }
                return { data: names.map((n, i) => ({ permission_id: 100 + i })), error: null };
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
                return Promise.resolve({ data: null, error: null, count: 0 });
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
vi.mock('../lib/discord', () => ({
    getDiscordMember: async () => null,
    pushDiscordRolesForUser: async () => {},
    getDiscordUserById: async () => null,
    buildGlobalAvatarUrl: () => '',
    syncDiscordRoles: async () => ({}),
}));
vi.mock('../lib/push', () => ({
    sendPushToAll: () => {}, sendPushToStaff: () => {}, sendPushToPermission: () => {},
    isAllowedPushEndpoint: () => true, MAX_PUSH_SUBSCRIPTIONS_PER_USER: 5,
}));
vi.mock('../lib/db/seeder', () => ({ seedNewOrganization: async () => {}, seedInstall: async () => {} }));

import {
    roleTier, assertCanChangeUsersRole, updateUser,
    bulkDemoteUsersToClient, bulkPromoteUsersToMember,
} from '../lib/db/users';
import { adminActions } from '../api/actions/admin';
import { UserRole, type User } from '../types';

type Handler = (p: unknown) => unknown;
const promoteUser = (adminActions as unknown as Record<string, Handler>)['admin:promote_user'];

const ROLE_WRITE_PERMS = ['admin:user:update', 'admin:user:update_role'];
// The genuine system Admin (roleId === sysRoles.admin.id).
const ADMIN: Partial<User> = { id: 10, roleId: 4, role: UserRole.Admin, permissions: ['admin:access', ...ROLE_WRITE_PERMS] };
// A delegated seat an operator would actually build: it must hold admin:access to
// see the Admin panel at all, which is exactly why a pure tier compare fails here.
const DEPUTY: Partial<User> = { id: 11, roleId: 9, role: UserRole.Admin, permissions: ['admin:access', 'admin:view:roster', ...ROLE_WRITE_PERMS] };
// A dispatcher-tier delegate with the role perms bolted on.
const STAFF: Partial<User> = { id: 12, roleId: 3, role: UserRole.Dispatcher, permissions: ['admin:access', ...ROLE_WRITE_PERMS] };
// hr:* / admin:user:update_role only — roleTier's five-permission ladder does not
// recognise any of these, so this role scores tier 1. It is the role that runs the
// Clients-tab promote and the HR case-file hire.
const RECRUITER: Partial<User> = { id: 13, roleId: 8, role: UserRole.Client, permissions: ['hr:recruiter', 'hr:manager', 'admin:view:roster', ...ROLE_WRITE_PERMS] };

const userWrites = () => h.writes.filter((w) => w.table === 'users' && w.op === 'update');

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
        { id: 8, name: 'Recruiter', is_system: false },
        { id: 9, name: 'Deputy', is_system: false },
    ];
    h.grants = { 8: ['hr:recruiter', 'hr:manager'], 9: ['admin:access', 'admin:view:roster'] };
    h.grantsError = null;
    h.users = {
        10: { id: 10, role_id: 4 },  // the Admin actor
        11: { id: 11, role_id: 9 },  // the Deputy actor
        20: { id: 20, role_id: 4 },  // another Admin
        21: { id: 21, role_id: 3 },  // a Dispatcher
        22: { id: 22, role_id: 2 },  // a Member
        23: { id: 23, role_id: 1 },  // a Client
        24: { id: 24, role_id: 9 },  // another Deputy (custom, admin:access)
    };
    h.writes = [];
    h.rolePermQueries = 0;
});

// ---------------------------------------------------------------------------
// 1. roleTier — the resolver everything else trusts
// ---------------------------------------------------------------------------
describe('roleTier', () => {
    it('KEEP — system roles resolve from getSystemRoles with no role_permissions read', async () => {
        for (const [id, tier] of [[1, 1], [2, 2], [3, 3], [4, 4]] as const) {
            expect(await roleTier(id)).toBe(tier);
        }
        expect(h.rolePermQueries).toBe(0);
    });

    it('KEEP — a custom role is inferred from its grants', async () => {
        expect(await roleTier(9)).toBe(4);   // admin:access
        expect(await roleTier(8)).toBe(1);   // no ladder permission at all
    });

    it('fails CLOSED on a role_permissions read fault instead of scoring tier 1', async () => {
        h.grantsError = { message: 'boom' };
        await expect(roleTier(9)).rejects.toThrow(/tier could not be resolved/);
    });

    it('fails CLOSED on an unusable id rather than matching an UNRESOLVED system slot', async () => {
        // With the Admin slot missing, the old `sysIds.indexOf(roleId)` matched
        // `undefined` at index 3 and scored a missing role as tier 4 — the apex.
        h.systemRoles = { client: { id: 1, name: 'Client' }, member: { id: 2, name: 'Member' }, dispatcher: { id: 3, name: 'Dispatcher' } };
        await expect(roleTier(undefined as unknown as number)).rejects.toThrow(/tier could not be resolved/);
        await expect(roleTier(0)).rejects.toThrow(/tier could not be resolved/);
    });
});

// ---------------------------------------------------------------------------
// 2. assertCanChangeUsersRole — KEEP direction
// ---------------------------------------------------------------------------
describe('assertCanChangeUsersRole — privileged roles keep their reach', () => {
    it('an Admin may demote a Dispatcher, a Member and a Client', async () => {
        for (const target of [21, 22, 23]) {
            await expect(assertCanChangeUsersRole(ADMIN, target, 1)).resolves.toBeUndefined();
        }
    });

    it('an Admin may demote ANOTHER Admin from the single-user detail view', async () => {
        await expect(assertCanChangeUsersRole(ADMIN, 20, 1)).resolves.toBeUndefined();
    });

    it('a Dispatcher-tier delegate may still change a Member', async () => {
        await expect(assertCanChangeUsersRole(STAFF, 22, 1)).resolves.toBeUndefined();
    });

    it('bulk promote off the Clients tab still works for an Admin (blockPeers, Client target)', async () => {
        await expect(assertCanChangeUsersRole(ADMIN, 23, 2, { blockPeers: true })).resolves.toBeUndefined();
    });

    it('a tier-1 delegated Recruiter may still promote a Client', async () => {
        await expect(assertCanChangeUsersRole(RECRUITER, 23, 2)).resolves.toBeUndefined();
    });

    it('a no-op role write is not a privilege change — it returns before any check', async () => {
        // Includes the actor's own row: an editor that echoes the unchanged roleId
        // must not be refused a save that changes nothing.
        await expect(assertCanChangeUsersRole(ADMIN, 10, 4)).resolves.toBeUndefined();
        await expect(assertCanChangeUsersRole(STAFF, 21, 3)).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 3. assertCanChangeUsersRole — GAIN NOTHING direction
// ---------------------------------------------------------------------------
describe('assertCanChangeUsersRole — the target-side ceiling', () => {
    it('a Dispatcher-tier delegate cannot strip an Admin', async () => {
        await expect(assertCanChangeUsersRole(STAFF, 20, 1)).rejects.toThrow(/only a holder of the Admin role/);
    });

    // The realistic delegation. roleTier scores Deputy 4 because it holds
    // admin:access — which it MUST, to open the Admin panel — so a plain
    // `targetTier > actorTier` compare would let it demote a real Admin.
    it('a tier-4 custom "Deputy" cannot strip a genuine Admin', async () => {
        await expect(assertCanChangeUsersRole(DEPUTY, 20, 1)).rejects.toThrow(/only a holder of the Admin role/);
    });

    it('KEEP — that same Deputy still manages everyone below the apex', async () => {
        for (const target of [21, 22, 23]) {
            await expect(assertCanChangeUsersRole(DEPUTY, target, 1)).resolves.toBeUndefined();
        }
    });

    it('nobody changes their own role', async () => {
        await expect(assertCanChangeUsersRole(ADMIN, 10, 1)).rejects.toThrow(/your own role/);
    });

    // targetUserId is deliberately NOT in ACTOR_ID_FIELDS, so it arrives verbatim
    // off the JSON body — and PostgREST resolves "10" to row 10. `"10" === 10` is
    // false, so an uncoerced self-compare is a one-character bypass.
    it('the self-lock survives a STRING target id', async () => {
        await expect(assertCanChangeUsersRole(ADMIN, '10', 1)).rejects.toThrow(/your own role/);
    });

    it('blockPeers refuses a peer-tier target (the bulk contract)', async () => {
        await expect(assertCanChangeUsersRole(ADMIN, 20, 1, { blockPeers: true })).rejects.toThrow(/at or above/);
        await expect(assertCanChangeUsersRole(ADMIN, 24, 1, { blockPeers: true })).rejects.toThrow(/at or above/);
    });

    // The pin that this guard is immune to the forgeable role NAME: role 99 has no
    // grants at all, so its stored tier is 1 regardless of what `actor.role` says.
    it('a forged actor.role="Admin" on a permissionless role is refused', async () => {
        const FORGED: Partial<User> = { id: 12, roleId: 99, role: UserRole.Admin, permissions: [] };
        h.users[12] = { id: 12, role_id: 99 };
        await expect(assertCanChangeUsersRole(FORGED, 20, 1)).rejects.toThrow(/only a holder of the Admin role/);
        await expect(assertCanChangeUsersRole(FORGED, 21, 1)).rejects.toThrow(/higher privileges/);
    });

    it('fails CLOSED on a missing target row, a missing actor and a missing actor role', async () => {
        await expect(assertCanChangeUsersRole(ADMIN, 999, 1)).rejects.toThrow(/Target user not found/);
        await expect(assertCanChangeUsersRole(null, 20, 1)).rejects.toThrow(/actor identity required/);
        await expect(assertCanChangeUsersRole({ id: 10 }, 20, 1)).rejects.toThrow(/actor role could not be resolved/);
        await expect(assertCanChangeUsersRole(ADMIN, 'abc', 1)).rejects.toThrow(/Invalid target user id/);
    });

    it('fails CLOSED when the Admin system role cannot be resolved', async () => {
        h.systemRoles = { client: { id: 1, name: 'Client' } };
        await expect(assertCanChangeUsersRole(ADMIN, 21, 1)).rejects.toThrow(/system roles could not be resolved/);
    });
});

// ---------------------------------------------------------------------------
// 4. Wiring — every actor-driven role write, asserting NO WRITE on refusal
// ---------------------------------------------------------------------------
describe('updateUser (admin:update_user)', () => {
    it('a Dispatcher-tier delegate can no longer demote an Admin, and nothing is written', async () => {
        await expect(updateUser(20, { roleId: 1 }, STAFF)).rejects.toThrow(/only a holder of the Admin role/);
        expect(userWrites()).toEqual([]);
    });

    it('a lone Admin can no longer self-demote, and nothing is written', async () => {
        await expect(updateUser(10, { roleId: 1 }, ADMIN)).rejects.toThrow(/your own role/);
        expect(userWrites()).toEqual([]);
    });

    it('KEEP — an Admin still demotes a Dispatcher and the row is written', async () => {
        await expect(updateUser(21, { roleId: 1 }, ADMIN)).resolves.toBeUndefined();
        expect(userWrites().some((w) => (w.payload as { role_id?: number }).role_id === 1)).toBe(true);
    });

    it('KEEP — the missing-permission message still wins over the target ceiling', async () => {
        // Order matters: assertCanAssignRole runs first so the common case keeps its
        // own error copy.
        await expect(updateUser(20, { roleId: 1 }, { id: 99, roleId: 2, permissions: [] }))
            .rejects.toThrow(/missing admin:user:update_role/);
    });
});

describe('bulkDemoteUsersToClient (admin:bulk_demote_to_client)', () => {
    it('counts a refused Admin target as skipped and writes nothing for it', async () => {
        await expect(bulkDemoteUsersToClient([20], ADMIN)).resolves.toEqual({ updated: 0, total: 1, skipped: 1 });
        expect(userWrites()).toEqual([]);
    });

    it('one refusal does NOT abort the batch — partial success is preserved', async () => {
        const res = await bulkDemoteUsersToClient([20, 22], ADMIN);
        expect(res).toEqual({ updated: 1, total: 2, skipped: 1 });
        const written = userWrites();
        expect(written.length).toBe(1);
        expect(Number(written[0].filters.id)).toBe(22);
    });

    it('the actor cannot include themselves in the batch', async () => {
        await expect(bulkDemoteUsersToClient([10], ADMIN)).resolves.toEqual({ updated: 0, total: 1, skipped: 1 });
        expect(userWrites()).toEqual([]);
    });

    it('KEEP — an empty batch still short-circuits without touching the guards', async () => {
        await expect(bulkDemoteUsersToClient([], { id: 99, roleId: 1, permissions: [] })).resolves.toEqual({ updated: 0, total: 0, skipped: 0 });
    });
});

describe('bulkPromoteUsersToMember (admin:bulk_promote_users)', () => {
    it('refuses to "promote" an Admin to Member — a demotion by another name', async () => {
        await expect(bulkPromoteUsersToMember([20], ADMIN)).resolves.toEqual({ updated: 0, total: 1, skipped: 1 });
        expect(userWrites()).toEqual([]);
    });

    it('KEEP — the Clients-tab flow still promotes Client-tier rows', async () => {
        const res = await bulkPromoteUsersToMember([23], ADMIN);
        expect(res).toEqual({ updated: 1, total: 1, skipped: 0 });
        expect(userWrites().length).toBe(1);
    });
});

describe('admin:promote_user', () => {
    it('refuses an Admin target — the handler forwarded no actor and had no guard at all', async () => {
        await expect(promoteUser({ targetUserId: 20, user: STAFF })).rejects.toThrow(/only a holder of the Admin role/);
        expect(userWrites()).toEqual([]);
    });

    it('refuses a tier-4 Deputy promoting a genuine Admin down to Member', async () => {
        await expect(promoteUser({ targetUserId: 20, user: DEPUTY })).rejects.toThrow(/only a holder of the Admin role/);
        expect(userWrites()).toEqual([]);
    });

    // The delegation this action exists for. assertCanAssignRole is deliberately NOT
    // asserted here: its ladder does not know admin:user:update_role or hr:*, so a
    // Recruiter scores tier 1 and Member (tier 2) would have started throwing —
    // breaking the Clients-tab promote button and the HR case-file approval.
    it('KEEP — a delegated tier-1 Recruiter still promotes a Client to Member', async () => {
        await expect(promoteUser({ targetUserId: 23, user: RECRUITER })).resolves.toBeUndefined();
        expect(userWrites().some((w) => (w.payload as { role_id?: number }).role_id === 2)).toBe(true);
    });

    it('KEEP — an Admin still promotes a Client', async () => {
        await expect(promoteUser({ targetUserId: 23, user: ADMIN })).resolves.toBeUndefined();
    });
});
