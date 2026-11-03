import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/users.ts — the privilege guards and every write path they protect.
//
// These are the escalation boundaries: assigning a role (the NEW role's tier),
// changing a user's role (the TARGET's tier, self-lock, Admin-identity apex),
// editing a role's permission set (no amplification, tier ceiling), granting
// clearance / markers (author clamp), and the bulk tools that loop them. Every
// refusal is pinned by message, every fail-closed read (an unresolvable tier is a
// refusal, never tier 1 or tier 4) is pinned, and every write is pinned by its
// exact payload and its id-only broadcast.

const h = vi.hoisted(() => ({
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pushDiscordRoles: vi.fn(),
}));

vi.mock('../lib/db/common', async () => (await import('./cov-db-users-bans-fake')).commonMock);
vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    return { ...actual, log: { ...actual.log, child: () => h.log } };
});
vi.mock('../lib/discord', () => ({
    getDiscordMember: vi.fn(), getDiscordUserById: vi.fn(), buildGlobalAvatarUrl: vi.fn(),
    pushDiscordRolesForUser: (...a: unknown[]) => h.pushDiscordRoles(...a),
}));
vi.mock('../lib/db/system', () => ({ getAllSettings: vi.fn() }));
vi.mock('../lib/db/blueprints', () => ({ withdrawCraftingOffers: vi.fn() }));

import {
    assertCanAssignRole, roleTier, assertCanChangeUsersRole, assertCanManageRolePermissions, updateUser,
    getUserPositionHistory, updateUserClearance, bulkUpdateUserClearances, bulkDemoteUsersToClient,
    bulkPromoteUsersToMember, bulkSetUsersAffiliate, bulkSetUsersVip, bulkAssignUsersUnit,
    bulkAssignUsersRank, bulkAssignUsersPosition, getClearanceHistory,
} from '../lib/db/users';
import type { User } from '../types';
import { sb, resetSb, queue, on, chainOf, argsOf, has, assertNoWildcardSelect, type SbQuery, type SbResult } from './cov-db-users-bans-fake';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const ROLES = { client: { id: 1, name: 'Client' }, member: { id: 2, name: 'Member' }, dispatcher: { id: 3, name: 'Dispatcher' }, admin: { id: 4, name: 'Admin' } };
const UPDATE_ROLE = 'admin:user:update_role';

const ADMIN = { id: 100, roleId: 4, permissions: [UPDATE_ROLE], isSystemAdmin: true } as Partial<User>;
const DISPATCHER = { id: 101, roleId: 3, permissions: [UPDATE_ROLE, 'request:dispatch'] } as Partial<User>;

/** The value of the first .eq(col, v) on a query. */
const eqVal = (q: SbQuery, col: string): unknown => q.calls.find((c) => c.method === 'eq' && c.args[0] === col)?.args[1];
const sel = (q: SbQuery): unknown => argsOf(q, 'select')?.[0];
/** role_permissions rows for a custom role, keyed by role id. */
const rolePerms = (byRole: Record<number, string[]>) => (q: SbQuery): SbResult | undefined => {
    if (q.table !== 'role_permissions') return undefined;
    const names = byRole[eqVal(q, 'role_id') as number] ?? [];
    return { data: names.map((name) => ({ permission: { name } })) };
};
const roleRow = (id: number) => ({ data: { id, name: `R${id}`, is_system: id <= 4 } });

beforeEach(() => {
    resetSb();
    sb.systemRoles = { ...ROLES };
    for (const fn of Object.values(h.log)) fn.mockReset();
    h.pushDiscordRoles.mockReset();
    h.pushDiscordRoles.mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
    assertNoWildcardSelect();
});

describe('roleTier — fail-closed tier resolution', () => {
    it.each([['abc'], [0], [-1], [1.5]])('an unusable id (%s) is a refusal, before any read', async (id) => {
        await expect(roleTier(id as number)).rejects.toThrow('Role privilege tier could not be resolved.');
        expect(sb.queries).toEqual([]);
    });

    it('system roles map 1..4 by identity, with no permission read; numeric strings are coerced', async () => {
        expect(await roleTier(1)).toBe(1);
        expect(await roleTier(2)).toBe(2);
        expect(await roleTier('3' as unknown as number)).toBe(3);
        expect(await roleTier(4)).toBe(4);
        expect(on('role_permissions')).toHaveLength(0);
    });

    it('custom roles are tiered by their permissions (object and array embed shapes)', async () => {
        sb.handler = (q) => {
            const id = eqVal(q, 'role_id');
            const by: Record<number, unknown[]> = {
                10: [{ permission: { name: 'admin:access' } }],
                11: [{ permission: [{ name: 'request:dispatch' }] }],
                12: [{ permission: { name: 'request:triage' } }],
                13: [{ permission: { name: 'request:accept' } }],
                14: [{ permission: [{ name: 'user:toggle_duty' }] }],
                15: [{ permission: null }, { permission: { name: 'wiki:view' } }],
            };
            return { data: by[id as number] ?? null };
        };
        expect(await Promise.all([10, 11, 12, 13, 14, 15, 16].map((id) => roleTier(id)))).toEqual([4, 3, 3, 2, 2, 1, 1]);
        expect(chainOf(on('role_permissions')[0])).toEqual([['select', 'permission:permissions(name)'], ['eq', 'role_id', 10]]);
    });

    it('an unresolved Admin slot never scores a role as the apex; it is read as custom', async () => {
        sb.systemRoles = { client: ROLES.client, member: ROLES.member, dispatcher: ROLES.dispatcher };
        queue('role_permissions', { data: [] });
        expect(await roleTier(4)).toBe(1);
    });

    it('a permission read fault is a refusal, never tier 1', async () => {
        queue('role_permissions', { error: { code: 'XX000' } });
        await expect(roleTier(20)).rejects.toThrow('Role privilege tier could not be resolved.');
    });
});

describe('assertCanAssignRole — caps the role being GRANTED', () => {
    it('requires an actor identity, then the update_role permission (no name-based escape)', async () => {
        await expect(assertCanAssignRole(null, 2)).rejects.toThrow('Unauthorized: actor identity required to change role');
        await expect(assertCanAssignRole({ id: 0 }, 2)).rejects.toThrow('Unauthorized: actor identity required to change role');
        await expect(assertCanAssignRole({ id: 5, role: 'Admin' as User['role'], roleId: 4 }, 2)).rejects.toThrow('Forbidden: missing admin:user:update_role permission');
        expect(sb.queries).toEqual([]);
    });

    it('an unknown target role (or a read fault) is refused', async () => {
        queue('roles', { data: null }, { error: { code: 'XX000' } });
        await expect(assertCanAssignRole(ADMIN, 99)).rejects.toThrow('Target role not found');
        await expect(assertCanAssignRole(ADMIN, 99)).rejects.toThrow('Target role not found');
        expect(chainOf(on('roles')[0])).toEqual([['select', 'id, name, is_system'], ['eq', 'id', 99], ['maybeSingle']]);
    });

    it('only a holder of the Admin ROLE (by id) may assign the Admin role', async () => {
        queue('roles', roleRow(4), roleRow(4));
        await expect(assertCanAssignRole(DISPATCHER, 4)).rejects.toThrow('Forbidden: only Admins can assign the Admin role');
        await expect(assertCanAssignRole(ADMIN, 4)).resolves.toBeUndefined();
    });

    it('a custom role carrying admin:access (tier 4) cannot be granted by a Dispatcher (tier 3)', async () => {
        queue('roles', roleRow(10));
        sb.handler = rolePerms({ 10: ['admin:access'] });
        await expect(assertCanAssignRole(DISPATCHER, 10)).rejects.toThrow('Forbidden: cannot assign a role with higher privileges than your own');
    });

    it('a lower or equal tier is allowed (custom dispatch / accept / toggle-duty / none)', async () => {
        sb.handler = (q) => (q.table === 'roles' ? roleRow(eqVal(q, 'id') as number) : rolePerms({ 11: ['request:triage'], 12: ['user:toggle_duty'], 13: [] })(q));
        for (const id of [11, 12, 13, 2]) await expect(assertCanAssignRole(DISPATCHER, id)).resolves.toBeUndefined();
    });

    it('reads array-shaped permission embeds, and a role with no permission rows is tier 1', async () => {
        sb.handler = (q) => {
            if (q.table === 'roles') return roleRow(eqVal(q, 'id') as number);
            if (eqVal(q, 'role_id') === 10) return { data: [{ permission: [{ name: 'admin:access' }] }] };
            return { data: null };
        };
        await expect(assertCanAssignRole(DISPATCHER, 10)).rejects.toThrow('Forbidden: cannot assign a role with higher privileges than your own');
        await expect(assertCanAssignRole({ id: 5, roleId: 11, permissions: [UPDATE_ROLE] }, 12)).resolves.toBeUndefined();
        await expect(assertCanAssignRole({ id: 5, roleId: 11, permissions: [UPDATE_ROLE] }, 2)).rejects.toThrow(/higher privileges/);
    });

    it('an actor whose own role id is unusable is refused (never scored as an unresolved slot)', async () => {
        queue('roles', roleRow(2));
        await expect(assertCanAssignRole({ id: 5, permissions: [UPDATE_ROLE] }, 2)).rejects.toThrow('Role privilege tier could not be resolved.');
    });

    it('a custom-role permission read fault is a refusal', async () => {
        queue('roles', roleRow(10));
        queue('role_permissions', { error: { code: 'XX000' } });
        await expect(assertCanAssignRole(ADMIN, 10)).rejects.toThrow('Role privilege tier could not be resolved.');
    });
});

describe('assertCanChangeUsersRole — caps the TARGET being changed', () => {
    it('requires an actor id and a resolvable actor role', async () => {
        await expect(assertCanChangeUsersRole(undefined, 5, 2)).rejects.toThrow('Unauthorized: actor identity required to change role');
        await expect(assertCanChangeUsersRole({ id: 1 }, 5, 2)).rejects.toThrow('Unauthorized: actor role could not be resolved');
    });

    it.each([['abc'], [0], [-3], [2.5]])('rejects an invalid target id (%s)', async (t) => {
        await expect(assertCanChangeUsersRole(ADMIN, t as number, 2)).rejects.toThrow('Invalid target user id');
        expect(sb.queries).toEqual([]);
    });

    it('reads the target role (soft-deleted included); unknown target or fault → refused', async () => {
        queue('users', { data: null }, { error: { code: 'XX000' } });
        await expect(assertCanChangeUsersRole(ADMIN, 5, 2)).rejects.toThrow('Target user not found');
        await expect(assertCanChangeUsersRole(ADMIN, 5, 2)).rejects.toThrow('Target user not found');
        expect(chainOf(on('users')[0])).toEqual([['select', 'id, role_id'], ['eq', 'id', 5], ['maybeSingle']]);
    });

    it('an unchanged role is a no-op — even on your own record', async () => {
        queue('users', { data: { id: 100, role_id: 4 } });
        await expect(assertCanChangeUsersRole(ADMIN, 100, 4)).resolves.toBeUndefined();
    });

    it('self-demotion is locked, and a numeric-string target id cannot walk past it', async () => {
        queue('users', { data: { id: 100, role_id: 4 } });
        await expect(assertCanChangeUsersRole(ADMIN, '100', 1)).rejects.toThrow('Forbidden: you cannot change your own role');
    });

    it('fails closed when the system roles cannot be resolved', async () => {
        sb.systemRoles = { client: ROLES.client };
        await expect(assertCanChangeUsersRole(ADMIN, 5, 1, { targetRoleId: 2 })).rejects.toThrow('Forbidden: system roles could not be resolved');
    });

    it("only an Admin-role holder may change an Admin's role (identity, not tier)", async () => {
        const deputy = { id: 102, roleId: 10, permissions: [UPDATE_ROLE, 'admin:access'] };
        await expect(assertCanChangeUsersRole(deputy, 5, 1, { targetRoleId: 4 })).rejects.toThrow("Forbidden: only a holder of the Admin role may change an Admin's role");
        await expect(assertCanChangeUsersRole(ADMIN, 5, 1, { targetRoleId: 4 })).resolves.toBeUndefined();
    });

    it('a higher-tier target is refused; a peer is allowed unless blockPeers', async () => {
        sb.handler = rolePerms({ 10: ['admin:access'] });
        await expect(assertCanChangeUsersRole(DISPATCHER, 5, 1, { targetRoleId: 10 })).rejects.toThrow('Forbidden: cannot change the role of a user with higher privileges than your own');
        await expect(assertCanChangeUsersRole(DISPATCHER, 5, 1, { targetRoleId: 3 })).resolves.toBeUndefined();
        await expect(assertCanChangeUsersRole(DISPATCHER, 5, 1, { targetRoleId: 3, blockPeers: true })).rejects.toThrow('Forbidden: cannot change the role of a user at or above your own privilege tier');
        await expect(assertCanChangeUsersRole(DISPATCHER, 5, 3, { targetRoleId: 2, blockPeers: true })).resolves.toBeUndefined();
    });

    it('precomputed actorTier / targetRoleId skip their reads', async () => {
        await assertCanChangeUsersRole({ id: 1, roleId: 30 }, 5, 1, { targetRoleId: 2, actorTier: 3 });
        expect(on('users')).toHaveLength(0);
        // Role 30 is custom: without the precomputed tier it would have been read.
        expect(on('role_permissions')).toHaveLength(0);
    });
});

describe('assertCanManageRolePermissions — no amplification, tier ceiling', () => {
    it('requires an actor identity', async () => {
        await expect(assertCanManageRolePermissions(null, 2, [])).rejects.toThrow('Unauthorized: actor identity required to edit role permissions');
    });

    it('an Admin-role holder may edit any role (including Admin) without holding the permissions', async () => {
        await expect(assertCanManageRolePermissions({ id: 100, roleId: 4, permissions: [] }, 4, ['admin:db:destroy'])).resolves.toBeUndefined();
        expect(on('role_permissions')).toHaveLength(0);
    });

    it('a non-Admin cannot grant a permission they do not hold (first five named)', async () => {
        const perms = ['a', 'b', 'c', 'd', 'e', 'f', 'request:dispatch'];
        await expect(assertCanManageRolePermissions(DISPATCHER, 2, perms)).rejects.toThrow('Forbidden: cannot grant permissions you do not hold (a, b, c, d, e)');
    });

    it('a non-Admin cannot edit a role at or above their own tier (including their own role)', async () => {
        await expect(assertCanManageRolePermissions(DISPATCHER, 3, ['request:dispatch'])).rejects.toThrow('Forbidden: cannot modify the permissions of a role at or above your own privilege tier');
        await expect(assertCanManageRolePermissions(DISPATCHER, 2, ['request:dispatch'])).resolves.toBeUndefined();
    });

    it('a malformed (non-array) permission list holds nothing, so any grant is an escalation', async () => {
        await expect(assertCanManageRolePermissions({ id: 7, roleId: 3, permissions: 'request:dispatch' as unknown as string[] }, 2, ['request:dispatch']))
            .rejects.toThrow('Forbidden: cannot grant permissions you do not hold (request:dispatch)');
    });

    it('an actor with no role id is tier 1, so even the Client role is out of reach; null names are []', async () => {
        await expect(assertCanManageRolePermissions({ id: 7, permissions: [] }, 1, null as unknown as string[])).rejects.toThrow(/at or above your own privilege tier/);
    });
});

describe('updateUser — the generic admin profile edit', () => {
    const oldRow = { role_id: 2, rank_id: 1, position_id: null };
    const baseHandler = (q: SbQuery): SbResult | undefined => {
        if (q.table === 'users' && q.op === 'select' && sel(q) === 'role_id, rank_id, position_id') return { data: oldRow };
        if (q.table === 'users' && q.op === 'select' && sel(q) === 'id, role_id') return { data: { id: 5, role_id: 2 } };
        if (q.table === 'roles') return roleRow(eqVal(q, 'id') as number);
        return undefined;
    };
    const writeOf = () => argsOf(on('users').find((q) => q.op === 'update'), 'update')![0] as Record<string, unknown>;

    it('writes exactly the present fields, sanitised, never the RSI handle; logs position; broadcasts; pushes Discord', async () => {
        sb.handler = baseHandler;
        await updateUser(5, {
            name: '<b>New</b> Name', avatarUrl: 'http://insecure.example/a.png', rankId: 0, unitId: 3,
            positionId: 8, secondaryPositionId: null, adminNotes: 'note', personnelNotes: null,
            voiceChannelName: '', jobTitle: 'Pilot', probationStart: '', probationEnd: '2026-07-01',
            tenureStartDate: '', rsiHandle: 'Hijacked',
        });
        expect(writeOf()).toEqual({
            name: 'New Name', avatar_url: null, rank_id: null, unit_id: 3, position_id: 8, secondary_position_id: null,
            admin_notes: 'note', personnel_notes: null, voice_channel_name: null, job_title: 'Pilot',
            probation_start: null, probation_end: '2026-07-01', tenure_start_date: null,
        });
        const write = on('users').find((q) => q.op === 'update')!;
        expect(chainOf(write).slice(1)).toEqual([['eq', 'id', 5], ['select', 'id'], ['single']]);
        expect(chainOf(on('users')[0])).toEqual([['select', 'role_id, rank_id, position_id'], ['eq', 'id', 5], ['single']]);
        expect(argsOf(on('user_hr_position_history').find((q) => q.op === 'insert'), 'insert')).toEqual([{ user_id: 5, position_id: 8 }]);
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { userId: 5 } }]);
        expect(h.pushDiscordRoles).toHaveBeenCalledWith(5, { oldRankId: 1, newRankId: null, oldRoleId: 2, newRoleId: 2 });
    });

    it('falsy values clear to null; a vanished old row reads as all-null and still logs the position close', async () => {
        sb.handler = (q) => (q.table === 'users' && q.op === 'select' ? { data: null } : undefined);
        await updateUser(5, { unitId: 0, positionId: 0, jobTitle: '', probationEnd: '', rankId: 4 });
        expect(writeOf()).toEqual({ unit_id: null, position_id: null, job_title: null, probation_end: null, rank_id: 4 });
        // old position null → new null: no change, so no history writes.
        expect(on('user_hr_position_history')).toHaveLength(0);
        expect(h.pushDiscordRoles).toHaveBeenCalledWith(5, { oldRankId: null, newRankId: 4, oldRoleId: null, newRoleId: null });
    });

    it('clearing an assigned position closes the open history row', async () => {
        sb.handler = (q) => (q.table === 'users' && q.op === 'select' ? { data: { role_id: 2, rank_id: null, position_id: 8 } } : undefined);
        await updateUser(5, { positionId: null });
        expect(writeOf()).toEqual({ position_id: null });
        expect(argsOf(on('user_hr_position_history')[0], 'update')).toEqual([{ ended_at: ISO, end_reason: 'unassigned' }]);
    });

    it('a name that strips to nothing is a no-op; a plain edit reads no old data and pushes nothing', async () => {
        await updateUser(5, { name: '<i></i>', jobTitle: 'X' });
        expect(writeOf()).toEqual({ job_title: 'X' });
        expect(on('users')).toHaveLength(1);
        expect(h.pushDiscordRoles).not.toHaveBeenCalled();
        expect(on('user_hr_position_history')).toHaveLength(0);
    });

    it('a role change needs an actor and runs BOTH guards before any write', async () => {
        await expect(updateUser(5, { roleId: 3 })).rejects.toThrow('updateUser: actor required when changing roleId');
        await expect(updateUser(5, { roleId: 3 }, { id: 9, roleId: 3, permissions: [] })).rejects.toThrow('Forbidden: missing admin:user:update_role permission');
        expect(on('users').some((q) => q.op === 'update')).toBe(false);
    });

    it('an Admin role change writes role_id and pushes the role delta to Discord', async () => {
        sb.handler = baseHandler;
        await updateUser(5, { roleId: 3 }, ADMIN);
        expect(on('roles')).toHaveLength(1);
        expect(on('users').some((q) => sel(q) === 'id, role_id')).toBe(true);
        expect(writeOf()).toEqual({ role_id: 3 });
        expect(h.pushDiscordRoles).toHaveBeenCalledWith(5, { oldRankId: 1, newRankId: 1, oldRoleId: 2, newRoleId: 3 });
    });

    it('an unchanged rank pushes nothing to Discord', async () => {
        sb.handler = baseHandler;
        await updateUser(5, { rankId: 1 });
        expect(writeOf()).toEqual({ rank_id: 1 });
        expect(h.pushDiscordRoles).not.toHaveBeenCalled();
    });

    it('a Discord push rejection is logged, never surfaced', async () => {
        sb.handler = baseHandler;
        const boom = new Error('discord 500');
        h.pushDiscordRoles.mockRejectedValue(boom);
        await expect(updateUser(5, { rankId: 7 })).resolves.toBeUndefined();
        await vi.waitFor(() => expect(h.log.error).toHaveBeenCalledWith('discord background push failed', { userId: 5, err: boom }));
    });

    it('a clearance write through this path is author-clamped', async () => {
        queue('security_clearances', { data: { level: 3 } });
        const actor = { id: 9, permissions: [], clearanceLevel: { id: 1, level: 2, name: 'L2' } } as unknown as Partial<User>;
        await expect(updateUser(5, { clearanceLevelId: 30 }, actor)).rejects.toThrow('You cannot grant a clearance level above your own.');
        expect(chainOf(on('security_clearances')[0])).toEqual([['select', 'level'], ['eq', 'id', 30], ['maybeSingle']]);
        expect(on('users').some((q) => q.op === 'update')).toBe(false);
        // No actor at all is refused too.
        await expect(updateUser(5, { clearanceLevelId: 30 })).rejects.toThrow('Unauthorized: actor identity required to change clearance');
    });

    it('an intel:manage holder bypasses the clamp; 0 clears to null', async () => {
        await updateUser(5, { clearanceLevelId: 0 }, { id: 9, permissions: ['intel:manage'] });
        expect(writeOf()).toEqual({ clearance_level_id: null });
        expect(on('security_clearances')).toHaveLength(0);
    });

    it('a write fault throws before the broadcast', async () => {
        queue('users', { error: { code: 'XX000' } });
        await expect(updateUser(5, { jobTitle: 'X' })).rejects.toThrow('Failed to update user');
        expect(sb.broadcasts).toEqual([]);
    });
});

describe('getUserPositionHistory', () => {
    it('reads the unified view newest-first and maps it', async () => {
        queue('user_position_history_unified', {
            data: [
                { kind: 'hr', id: 1, user_id: 5, position_id: 8, position_name: 'Medic', position_description: null, position_icon: 'x', started_at: 'S', ended_at: null, end_reason: null },
                { kind: 'government', id: 2, user_id: 5, position_id: 9, position_name: 'Speaker', position_description: 'Chairs', position_icon: null, started_at: 'S0', ended_at: 'E0', end_reason: 'term_ended' },
            ],
        });
        expect(await getUserPositionHistory(5)).toEqual([
            { kind: 'hr', id: 1, userId: 5, positionId: 8, positionName: 'Medic', positionDescription: undefined, positionIcon: 'x', startedAt: 'S', endedAt: null, endReason: null },
            { kind: 'government', id: 2, userId: 5, positionId: 9, positionName: 'Speaker', positionDescription: 'Chairs', positionIcon: undefined, startedAt: 'S0', endedAt: 'E0', endReason: 'term_ended' },
        ]);
        expect(chainOf(on('user_position_history_unified')[0])).toEqual([
            ['select', 'kind, id, user_id, position_id, position_name, position_description, position_icon, started_at, ended_at, end_reason'],
            ['eq', 'user_id', 5],
            ['order', 'started_at', { ascending: false }],
        ]);
    });

    it('missing view → []; other fault throws; null data → []', async () => {
        queue('user_position_history_unified', { error: { code: '42P01' } }, { error: { code: 'XX000' } }, { data: null });
        expect(await getUserPositionHistory(5)).toEqual([]);
        await expect(getUserPositionHistory(5)).rejects.toThrow('Failed to load position history');
        expect(await getUserPositionHistory(5)).toEqual([]);
    });
});

describe('updateUserClearance — clamp, then level + markers + audit row', () => {
    const L2_ACTOR = {
        id: 9, permissions: [], clearanceLevel: { id: 1, level: 2, name: 'L2' },
        limitingMarkers: [{ id: 1 }, { code: 'NF' }, { name: 'Gamma' }, 'raw', null, {}],
    } as unknown as Partial<User>;

    it('Admin: writes level, replaces markers, logs history, broadcasts', async () => {
        queue('users', { data: { clearance_level_id: 1 } }, {});
        await updateUserClearance(5, 100, 2, [1, 3], ADMIN);
        expect(on('security_clearances')).toHaveLength(0);
        expect(chainOf(on('users')[0])).toEqual([['select', 'clearance_level_id'], ['eq', 'id', 5], ['single']]);
        expect(chainOf(on('users')[1])).toEqual([['update', { clearance_level_id: 2 }], ['eq', 'id', 5]]);
        const [del, ins] = on('user_limiting_markers');
        expect(chainOf(del)).toEqual([['delete'], ['eq', 'user_id', 5]]);
        expect(chainOf(ins)).toEqual([['insert', [{ user_id: 5, marker_id: 1 }, { user_id: 5, marker_id: 3 }]]]);
        expect(chainOf(on('clearance_history')[0])).toEqual([['insert', {
            user_id: 5, admin_id: 100, old_level_id: 1, new_level_id: 2, changes_description: 'Updated Clearance Level. Markers set to: [1, 3]',
        }]]);
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { userId: 5 } }]);
    });

    it('clearing: null level, no markers → no marker insert', async () => {
        queue('users', { data: { clearance_level_id: 1 } }, {});
        await updateUserClearance(5, 100, null, [], ADMIN);
        expect(argsOf(on('users')[1], 'update')).toEqual([{ clearance_level_id: null }]);
        expect(on('user_limiting_markers')).toHaveLength(1);
    });

    it('a non-bypass actor may grant at/below their level and only markers they hold (id / code / name / raw)', async () => {
        queue('security_clearances', { data: { level: 2 } });
        queue('users', { data: { clearance_level_id: 1 } }, {});
        await expect(updateUserClearance(5, 9, 20, [1, 'NF', 'Gamma', 'raw', null] as unknown as number[], L2_ACTOR)).resolves.toBeUndefined();
    });

    it('a target level with a null numeric level reads as 0 (always grantable)', async () => {
        queue('security_clearances', { data: { level: null } });
        queue('users', { data: { clearance_level_id: null } }, {});
        await expect(updateUserClearance(5, 9, 20, [], L2_ACTOR)).resolves.toBeUndefined();
    });

    it('refuses a level above the actor, an unknown level, and an unheld marker — before any write', async () => {
        queue('security_clearances', { data: { level: 3 } }, { data: null }, { error: { code: 'XX000' } });
        await expect(updateUserClearance(5, 9, 30, [], L2_ACTOR)).rejects.toThrow('You cannot grant a clearance level above your own.');
        await expect(updateUserClearance(5, 9, 31, [], L2_ACTOR)).rejects.toThrow('Target clearance level not found');
        await expect(updateUserClearance(5, 9, 32, [], L2_ACTOR)).rejects.toThrow('Target clearance level not found');
        await expect(updateUserClearance(5, 9, null, [7], L2_ACTOR)).rejects.toThrow('You cannot grant a limiting marker you do not hold.');
        // An actor holding no markers can grant none.
        await expect(updateUserClearance(5, 9, null, ['[object Object]' as unknown as number], { id: 9, limitingMarkers: [] } as unknown as Partial<User>))
            .rejects.toThrow(/limiting marker you do not hold/);
        expect(on('users')).toHaveLength(0);
    });

    it('a missing actor is refused; an actor with no marker list holds no markers', async () => {
        await expect(updateUserClearance(5, 9, 2, [], undefined)).rejects.toThrow('Unauthorized: actor identity required to change clearance');
        await expect(updateUserClearance(5, 9, null, [1], { id: 9 })).rejects.toThrow('You cannot grant a limiting marker you do not hold.');
        expect(sb.queries).toEqual([]);
    });

    it('unknown user and each write fault surface distinctly', async () => {
        queue('users', { data: null });
        await expect(updateUserClearance(5, 100, 2, [], ADMIN)).rejects.toThrow('User not found');

        queue('users', { data: { clearance_level_id: 1 } }, { error: { code: 'X' } });
        await expect(updateUserClearance(5, 100, 2, [], ADMIN)).rejects.toThrow('Failed to update clearance level');

        queue('users', { data: { clearance_level_id: 1 } }, {});
        queue('user_limiting_markers', { error: { code: 'X' } });
        await expect(updateUserClearance(5, 100, 2, [], ADMIN)).rejects.toThrow('Failed to clear old markers');

        queue('users', { data: { clearance_level_id: 1 } }, {});
        queue('user_limiting_markers', {}, { error: { code: 'X' } });
        await expect(updateUserClearance(5, 100, 2, [1], ADMIN)).rejects.toThrow('Failed to insert new markers');
        expect(sb.broadcasts).toEqual([]);
        expect(on('clearance_history')).toHaveLength(0);
    });
});

describe('bulkUpdateUserClearances — per-user contract, partial success', () => {
    /** users: id → clearance_level_id (absent = unknown user). */
    const world = (levels: Record<number, number | null>, fail: Partial<Record<string, number>> = {}) => (q: SbQuery): SbResult | undefined => {
        // The target user of a query: its id / user_id filter, or the first inserted row's user_id.
        const payload = (argsOf(q, 'insert') ?? argsOf(q, 'upsert'))?.[0];
        const firstRow = (Array.isArray(payload) ? payload[0] : payload) as { user_id?: number } | undefined;
        const uid = (eqVal(q, 'id') ?? eqVal(q, 'user_id') ?? firstRow?.user_id) as number | undefined;
        const failFor = fail[`${q.table}:${q.op}`];
        if (failFor !== undefined && failFor === uid) return { error: { code: 'X' } };
        if (q.table === 'users' && q.op === 'select') return uid !== undefined && uid in levels ? { data: { clearance_level_id: levels[uid] } } : { data: null };
        return {};
    };

    it('empty input is a no-op; a bad mode throws; the clamp runs once before any write', async () => {
        expect(await bulkUpdateUserClearances([], 100, 2, [], 'replace', ADMIN)).toEqual({ updated: 0, total: 0 });
        await expect(bulkUpdateUserClearances([5], 100, 2, [], 'merge' as 'add', ADMIN)).rejects.toThrow('bulkUpdateUserClearances: markerMode must be "replace" or "add"');
        await expect(bulkUpdateUserClearances([5], 100, null, [9], 'replace', { id: 9, limitingMarkers: [] } as unknown as Partial<User>))
            .rejects.toThrow('You cannot grant a limiting marker you do not hold.');
        expect(sb.queries).toEqual([]);
    });

    it('replace mode: level + delete/insert markers + one audit row per user; unknown ids skipped; ONE bulk broadcast of updated ids', async () => {
        sb.handler = world({ 5: 1, 7: 2 });
        const out = await bulkUpdateUserClearances([5, 6, 7], 100, 2, [1], 'replace', ADMIN);
        expect(out).toEqual({ updated: 2, total: 3 });
        expect(h.log.warn).toHaveBeenCalledWith('bulkUpdateUserClearances skipping unknown user', { userId: 6 });
        const levelWrites = on('users').filter((q) => q.op === 'update');
        expect(levelWrites.map((q) => chainOf(q))).toEqual([
            [['update', { clearance_level_id: 2 }], ['eq', 'id', 5]],
            [['update', { clearance_level_id: 2 }], ['eq', 'id', 7]],
        ]);
        expect(on('user_limiting_markers').map((q) => q.op)).toEqual(['delete', 'insert', 'delete', 'insert']);
        expect(on('clearance_history').map((q) => argsOf(q, 'insert')![0])).toEqual([
            { user_id: 5, admin_id: 100, old_level_id: 1, new_level_id: 2, changes_description: 'Updated Clearance Level. Markers set to: [1] (bulk).' },
            // Level unchanged for user 7 → no "Updated Clearance Level." prefix.
            { user_id: 7, admin_id: 100, old_level_id: 2, new_level_id: 2, changes_description: 'Markers set to: [1] (bulk).' },
        ]);
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { bulk: true, count: 2, userIds: [5, 7] } }]);
    });

    it('add mode with level untouched: conflict-ignoring upsert, history keeps the old level', async () => {
        sb.handler = world({ 5: 3 });
        await bulkUpdateUserClearances([5], 100, undefined, [1, 2], 'add', ADMIN);
        expect(on('users').some((q) => q.op === 'update')).toBe(false);
        expect(chainOf(on('user_limiting_markers')[0])).toEqual([
            ['upsert', [{ user_id: 5, marker_id: 1 }, { user_id: 5, marker_id: 2 }], { onConflict: 'user_id,marker_id', ignoreDuplicates: true }],
        ]);
        expect(argsOf(on('clearance_history')[0], 'insert')).toEqual([{
            user_id: 5, admin_id: 100, old_level_id: 3, new_level_id: 3, changes_description: 'Markers added: [1, 2] (bulk).',
        }]);
    });

    it('add mode with no markers writes no marker rows; replace with no markers only clears', async () => {
        sb.handler = world({ 5: 1 });
        await bulkUpdateUserClearances([5], 100, null, [], 'add', ADMIN);
        expect(on('user_limiting_markers')).toHaveLength(0);
        expect(argsOf(on('users').find((q) => q.op === 'update'), 'update')).toEqual([{ clearance_level_id: null }]);
        sb.queries = [];
        await bulkUpdateUserClearances([5], 100, undefined, [], 'replace', ADMIN);
        expect(on('user_limiting_markers').map((q) => q.op)).toEqual(['delete']);
    });

    it.each([
        ['users:update', 'bulkUpdateUserClearances level update failed', 'replace'],
        ['user_limiting_markers:delete', 'bulkUpdateUserClearances marker clear failed', 'replace'],
        ['user_limiting_markers:insert', 'bulkUpdateUserClearances marker insert failed', 'replace'],
        ['user_limiting_markers:upsert', 'bulkUpdateUserClearances marker upsert failed', 'add'],
    ] as const)('a %s fault skips that user (no audit row, not in the broadcast)', async (key, msg, mode) => {
        sb.handler = world({ 5: 1, 6: 1 }, { [key]: 5 });
        const out = await bulkUpdateUserClearances([5, 6], 100, 2, [1], mode, ADMIN);
        expect(out).toEqual({ updated: 1, total: 2 });
        expect(h.log.error).toHaveBeenCalledWith(msg, expect.objectContaining({ userId: 5 }));
        expect(on('clearance_history').map((q) => (argsOf(q, 'insert')![0] as { user_id: number }).user_id)).toEqual([6]);
        expect(sb.broadcasts[0].payload).toEqual({ bulk: true, count: 1, userIds: [6] });
    });

    it('a thrown per-user error is caught and the batch continues', async () => {
        const inner = world({ 6: 1 });
        sb.handler = (q) => {
            if (q.table === 'users' && eqVal(q, 'id') === 5) throw new Error('driver');
            return inner(q);
        };
        expect(await bulkUpdateUserClearances([5, 6], 100, 2, [], 'replace', ADMIN)).toEqual({ updated: 1, total: 2 });
        expect(h.log.error).toHaveBeenCalledWith('bulkUpdateUserClearances unexpected error', expect.objectContaining({ userId: 5 }));
    });
});

describe('bulk role tools — two-sided ceiling, partial success, one broadcast', () => {
    const many = Array.from({ length: 101 }, (_, i) => i + 1);

    it('caps a single call at 100 targets', async () => {
        await expect(bulkDemoteUsersToClient(many, ADMIN)).rejects.toThrow('bulkDemoteUsersToClient: bulk action capped at 100 users per call (got 101).');
        await expect(bulkPromoteUsersToMember(many, ADMIN)).rejects.toThrow('bulkPromoteUsersToMember: bulk action capped at 100 users per call (got 101).');
        expect(sb.queries).toEqual([]);
    });

    it('empty input → zeros, no reads, no broadcast', async () => {
        expect(await bulkDemoteUsersToClient([], ADMIN)).toEqual({ updated: 0, total: 0, skipped: 0 });
        expect(await bulkPromoteUsersToMember([], ADMIN)).toEqual({ updated: 0, total: 0, skipped: 0 });
        expect(sb.queries).toEqual([]);
        expect(sb.broadcasts).toEqual([]);
    });

    it('refuses when the destination system role is unresolved', async () => {
        sb.systemRoles = { admin: ROLES.admin };
        await expect(bulkDemoteUsersToClient([5], ADMIN)).rejects.toThrow('bulkDemoteUsersToClient: no Client system role configured for this org');
        await expect(bulkPromoteUsersToMember([5], ADMIN)).rejects.toThrow('bulkPromoteUsersToMember: no Member system role configured for this org');
    });

    it('the assign gate is hoisted: an actor without update_role is refused before the loop', async () => {
        await expect(bulkDemoteUsersToClient([5], { id: 9, roleId: 3, permissions: [] })).rejects.toThrow('Forbidden: missing admin:user:update_role permission');
        expect(on('users')).toHaveLength(0);
    });

    it('demote: skips absent / already-Client / Admin-tier peers / failed writes; writes only the rest', async () => {
        const roleOf: Record<number, number | undefined> = { 10: undefined, 11: 1, 12: 4, 13: 2, 14: 3 };
        sb.handler = (q) => {
            if (q.table === 'roles') return roleRow(eqVal(q, 'id') as number);
            const uid = eqVal(q, 'id') as number;
            if (q.table === 'users' && q.op === 'select') return { data: roleOf[uid] === undefined ? null : { role_id: roleOf[uid] } };
            if (q.table === 'users' && q.op === 'update' && uid === 14) return { error: { message: 'write failed' } };
            return undefined;
        };
        expect(await bulkDemoteUsersToClient([10, 11, 12, 13, 14], ADMIN)).toEqual({ updated: 1, total: 5, skipped: 4 });
        const writes = on('users').filter((q) => q.op === 'update');
        expect(writes.map((q) => chainOf(q))).toEqual([
            [['update', { role_id: 1 }], ['eq', 'id', 13]],
            [['update', { role_id: 1 }], ['eq', 'id', 14]],
        ]);
        expect(chainOf(on('users')[0])).toEqual([['select', 'role_id'], ['eq', 'id', 10], ['maybeSingle']]);
        expect(h.log.warn).toHaveBeenCalledWith('bulkDemoteUsersToClient skipping user not in org', { userId: 10 });
        expect(h.log.warn).toHaveBeenCalledWith('bulkDemoteUsersToClient skipped user', { userId: 12, message: 'Forbidden: cannot change the role of a user at or above your own privilege tier' });
        expect(h.log.warn).toHaveBeenCalledWith('bulkDemoteUsersToClient update failed', { userId: 14, message: 'write failed' });
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { bulk: true, count: 1, userIds: [13] } }]);
    });

    it('promote: a Dispatcher promotes a Client, but not a peer, an Admin, or an existing Member', async () => {
        const roleOf: Record<number, number | undefined> = { 20: 1, 21: 3, 22: 4, 23: undefined, 24: 2, 25: 1 };
        sb.handler = (q) => {
            if (q.table === 'roles') return roleRow(eqVal(q, 'id') as number);
            const uid = eqVal(q, 'id') as number;
            if (q.table === 'users' && q.op === 'select') return { data: roleOf[uid] === undefined ? null : { role_id: roleOf[uid] } };
            if (q.table === 'users' && q.op === 'update' && uid === 25) return { error: { message: 'write failed' } };
            return undefined;
        };
        expect(await bulkPromoteUsersToMember([20, 21, 22, 23, 24, 25], DISPATCHER)).toEqual({ updated: 1, total: 6, skipped: 5 });
        expect(on('users').filter((q) => q.op === 'update').map((q) => eqVal(q, 'id'))).toEqual([20, 25]);
        expect(argsOf(on('users').find((q) => q.op === 'update'), 'update')).toEqual([{ role_id: 2 }]);
        expect(h.log.warn).toHaveBeenCalledWith('bulkPromoteUsersToMember skipped user', { userId: 22, message: "Forbidden: only a holder of the Admin role may change an Admin's role" });
        expect(h.log.warn).toHaveBeenCalledWith('bulkPromoteUsersToMember update failed', { userId: 25, message: 'write failed' });
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { bulk: true, count: 1, userIds: [20] } }]);
    });

    it('a batch where nothing changed still emits one (empty) aggregate frame', async () => {
        sb.handler = (q) => (q.table === 'roles' ? roleRow(2) : { data: { role_id: 2 } });
        expect(await bulkPromoteUsersToMember([5], ADMIN)).toEqual({ updated: 0, total: 1, skipped: 1 });
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { bulk: true, count: 0, userIds: [] } }]);
    });
});

describe('bulkSetUsersAffiliate / bulkSetUsersVip — Client-only explicit setters', () => {
    const many = Array.from({ length: 101 }, (_, i) => i + 1);

    it('cap, empty, and unresolved Client role', async () => {
        await expect(bulkSetUsersAffiliate(many, true)).rejects.toThrow('bulkSetUsersClientFlag: bulk action capped at 100 users per call (got 101).');
        expect(await bulkSetUsersVip([], true)).toEqual({ updated: 0, total: 0, skipped: 0 });
        sb.systemRoles = {};
        await expect(bulkSetUsersAffiliate([1], true)).rejects.toThrow('bulkSetUsersClientFlag: no Client system role configured for this org');
        expect(sb.queries).toEqual([]);
    });

    it('affiliate: skips absent / non-Client / already-set / failed / thrown; writes the rest', async () => {
        const rows: Record<number, unknown> = {
            1: null, 2: { role_id: 2, is_affiliate: false }, 3: { role_id: 1, is_affiliate: true },
            4: { role_id: 1, is_affiliate: false }, 5: { role_id: 1, is_affiliate: null },
        };
        sb.handler = (q) => {
            const uid = eqVal(q, 'id') as number;
            if (uid === 6) throw new Error('driver');
            if (q.op === 'select') return { data: rows[uid] };
            if (q.op === 'update' && uid === 5) return { error: { code: 'X' } };
            return {};
        };
        expect(await bulkSetUsersAffiliate([1, 2, 3, 4, 5, 6], true)).toEqual({ updated: 1, total: 6, skipped: 5 });
        expect(chainOf(on('users')[0])).toEqual([['select', 'role_id, is_affiliate'], ['eq', 'id', 1], ['maybeSingle']]);
        expect(on('users').filter((q) => q.op === 'update').map((q) => chainOf(q))).toEqual([
            [['update', { is_affiliate: true }], ['eq', 'id', 4]],
            [['update', { is_affiliate: true }], ['eq', 'id', 5]],
        ]);
        expect(h.log.warn).toHaveBeenCalledWith('bulkSetUsersClientFlag skipped user', { userId: 6, message: 'driver' });
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { bulk: true, count: 1, userIds: [4] } }]);
    });

    it('vip: reads and writes is_vip', async () => {
        queue('users', { data: { role_id: 1, is_vip: true } }, {});
        expect(await bulkSetUsersVip([9], false)).toEqual({ updated: 1, total: 1, skipped: 0 });
        expect(argsOf(on('users')[0], 'select')).toEqual(['role_id, is_vip']);
        expect(argsOf(on('users')[1], 'update')).toEqual([{ is_vip: false }]);
    });
});

describe('bulkAssignUsersUnit / Rank / Position', () => {
    it('cap names the caller; empty is a no-op', async () => {
        await expect(bulkAssignUsersRank(Array.from({ length: 101 }, (_, i) => i + 1), 1)).rejects.toThrow('bulkAssignUsersRank: bulk action capped at 100 users per call (got 101).');
        expect(await bulkAssignUsersUnit([], 1)).toEqual({ updated: 0, total: 0, skipped: 0 });
        expect(sb.queries).toEqual([]);
    });

    it('validates the assigned id once, against the right table', async () => {
        queue('units', { data: null });
        await expect(bulkAssignUsersUnit([5], 3)).rejects.toThrow('bulkAssignUsersUnit: target units id not found');
        expect(chainOf(on('units')[0])).toEqual([['select', 'id'], ['eq', 'id', 3], ['maybeSingle']]);
        queue('ranks', { data: null });
        await expect(bulkAssignUsersRank([5], 3)).rejects.toThrow('bulkAssignUsersRank: target ranks id not found');
        queue('personnel_positions', { data: null });
        await expect(bulkAssignUsersPosition([5], 3)).rejects.toThrow('bulkAssignUsersPosition: target personnel_positions id not found');
        expect(on('users')).toHaveLength(0);
    });

    it('unit: skips absent / unchanged / failed / thrown, writes the rest, one broadcast', async () => {
        queue('units', { data: { id: 3 } });
        const rows: Record<number, unknown> = { 1: null, 2: { unit_id: 3 }, 4: { unit_id: 1 }, 5: { unit_id: null } };
        sb.handler = (q) => {
            if (q.table !== 'users') return undefined;
            const uid = eqVal(q, 'id') as number;
            if (uid === 6) throw new Error('driver');
            if (q.op === 'select') return { data: rows[uid] };
            if (q.op === 'update' && uid === 5) return { error: { code: 'X' } };
            return {};
        };
        expect(await bulkAssignUsersUnit([1, 2, 4, 5, 6], 3)).toEqual({ updated: 1, total: 5, skipped: 4 });
        expect(chainOf(on('users')[0])).toEqual([['select', 'unit_id'], ['eq', 'id', 1], ['maybeSingle']]);
        expect(on('users').filter((q) => q.op === 'update').map((q) => argsOf(q, 'update')![0])).toEqual([{ unit_id: 3 }, { unit_id: 3 }]);
        expect(h.log.warn).toHaveBeenCalledWith('bulkAssignUsersScalar skipped user', { fnName: 'bulkAssignUsersUnit', userId: 6, message: 'driver' });
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { bulk: true, count: 1, userIds: [4] } }]);
        // Only position changes feed the service-record timeline.
        expect(on('user_hr_position_history')).toHaveLength(0);
    });

    it('position: a null target clears without validation and logs the history change', async () => {
        queue('users', { data: { position_id: 8 } }, {});
        expect(await bulkAssignUsersPosition([5], null)).toEqual({ updated: 1, total: 1, skipped: 0 });
        expect(on('personnel_positions')).toHaveLength(0);
        expect(argsOf(on('users')[1], 'update')).toEqual([{ position_id: null }]);
        expect(argsOf(on('user_hr_position_history')[0], 'update')).toEqual([{ ended_at: ISO, end_reason: 'unassigned' }]);
    });

    it('rank: writes rank_id with no history', async () => {
        queue('ranks', { data: { id: 2 } });
        queue('users', { data: { rank_id: 1 } }, {});
        expect(await bulkAssignUsersRank([5], 2)).toEqual({ updated: 1, total: 1, skipped: 0 });
        expect(argsOf(on('users')[1], 'update')).toEqual([{ rank_id: 2 }]);
        expect(on('user_hr_position_history')).toHaveLength(0);
    });
});

describe('bulk loops — a non-Error throw is stringified into the skip log, and the batch continues', () => {
    const throwFor = (badId: number) => (q: SbQuery): SbResult | undefined => {
        if (q.table === 'roles') return roleRow(eqVal(q, 'id') as number);
        if (q.table === 'units') return { data: { id: 3 } };
        // A non-Error rejection, as some drivers produce.
        if (q.table === 'users' && eqVal(q, 'id') === badId) throw 'socket-reset';
        if (q.table === 'users' && q.op === 'select') return { data: { role_id: 1, unit_id: null, is_vip: false } };
        return undefined;
    };

    it.each([
        ['bulkDemoteUsersToClient', () => bulkDemoteUsersToClient([7, 8], ADMIN), { userId: 7, message: 'socket-reset' }, 0],
        ['bulkPromoteUsersToMember', () => bulkPromoteUsersToMember([7, 8], ADMIN), { userId: 7, message: 'socket-reset' }, 1],
        ['bulkSetUsersClientFlag', () => bulkSetUsersVip([7, 8], true), { userId: 7, message: 'socket-reset' }, 1],
        ['bulkAssignUsersScalar', () => bulkAssignUsersUnit([7, 8], 3), { fnName: 'bulkAssignUsersUnit', userId: 7, message: 'socket-reset' }, 1],
    ] as const)('%s', async (name, run, logged, updated) => {
        sb.handler = throwFor(7);
        const out = await run();
        expect(out).toEqual({ updated, total: 2, skipped: 2 - updated });
        expect(h.log.warn).toHaveBeenCalledWith(`${name} skipped user`, logged);
    });
});

describe('getClearanceHistory', () => {
    it('reads with explicit embeds, newest-first, and maps names from object / array / missing embeds', async () => {
        queue('clearance_history', {
            data: [
                { id: 1, user_id: 5, admin_id: 100, old_level_id: 1, new_level_id: 2, changes_description: 'd1', created_at: 'C1', admin: { name: 'Boss' }, oldLevel: [{ name: 'L1' }], newLevel: { name: 'L2' } },
                { id: 2, user_id: 5, admin_id: 101, old_level_id: null, new_level_id: null, changes_description: 'd2', created_at: 'C2', admin: null, oldLevel: [], newLevel: undefined },
            ],
        });
        expect(await getClearanceHistory(5)).toEqual([
            { id: 1, userId: 5, adminId: 100, adminName: 'Boss', oldLevelId: 1, newLevelId: 2, oldLevelName: 'L1', newLevelName: 'L2', changesDescription: 'd1', createdAt: 'C1' },
            { id: 2, userId: 5, adminId: 101, adminName: 'Unknown', oldLevelId: undefined, newLevelId: undefined, oldLevelName: undefined, newLevelName: undefined, changesDescription: 'd2', createdAt: 'C2' },
        ]);
        const q = on('clearance_history')[0];
        expect(argsOf(q, 'eq')).toEqual(['user_id', 5]);
        expect(argsOf(q, 'order')).toEqual(['created_at', { ascending: false }]);
        expect(String(sel(q))).toContain('admin:users!clearance_history_admin_id_fkey(name)');
        expect(has(q, 'limit')).toBe(false);
    });

    it('null data → []', async () => {
        queue('clearance_history', { data: null });
        expect(await getClearanceHistory(5)).toEqual([]);
    });
});
