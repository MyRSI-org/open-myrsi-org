import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/users.ts — identity resolution and account lifecycle.
//
// The session-actor resolvers (getUserById / getUserByAuthId / findUserByDiscordId)
// sit under every authenticated request, so their FAILURE DIRECTION is the property
// that matters: a soft-deleted user never resolves, a genuine read fault is never
// reported as "user deleted" (that would clear every session on a DB blip), the
// degraded fallback keeps tokens_valid_from (session revocation), and the Admin
// identity fact is stamped from role IDENTITY. Account creation sanitises the
// client-echoed public fields and refuses duplicate Discord / RSI bindings;
// reactivation copies display fields only (no mass-assignment); deletion
// anonymises, stamps the revocation watermark and revokes push delivery.

const h = vi.hoisted(() => ({
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    withdrawCraftingOffers: vi.fn(),
}));

vi.mock('../lib/db/common', async () => (await import('./cov-db-users-bans-fake')).commonMock);
vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    return { ...actual, log: { ...actual.log, child: () => h.log } };
});
vi.mock('../lib/discord', () => ({
    getDiscordMember: vi.fn(), pushDiscordRolesForUser: vi.fn(async () => undefined),
    getDiscordUserById: vi.fn(), buildGlobalAvatarUrl: vi.fn(),
}));
vi.mock('../lib/db/system', () => ({ getAllSettings: vi.fn() }));
vi.mock('../lib/db/blueprints', () => ({ withdrawCraftingOffers: (...a: unknown[]) => h.withdrawCraftingOffers(...a) }));

import {
    logHrPositionChange, findUserByDiscordId, getUsersByIdsLite, getUserById, getActorLabel,
    getUserByAuthId, getAdmins, createUser, reactivateUser, deleteUser, revokeUserSessions,
    USER_SELECT_QUERY, USER_LIST_SELECT_QUERY, USER_ROSTER_SELECT_QUERY,
} from '../lib/db/users';
import { sb, resetSb, queue, on, chainOf, argsOf, has, assertNoWildcardSelect } from './cov-db-users-bans-fake';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const ADMIN_ROLE = { id: 4, name: 'Admin', is_system: true, role_permissions: [{ permission: { name: 'admin:access' } }] };
const MEMBER_ROLE = { id: 2, name: 'Member', is_system: true, role_permissions: [{ permission: { name: 'request:accept' } }] };

const userRow = (over: Record<string, unknown> = {}) => ({
    id: 5, discord_id: '123456789', name: 'Jenko', display_name: null, avatar_url: 'https://cdn.example.com/a.png',
    rsi_handle: 'Jenko', role_id: 2, reputation: 60, is_duty: false, is_affiliate: false, is_vip: false,
    created_at: '2026-01-01T00:00:00Z', admin_notes: null, personnel_notes: null, rsi_handle_pending: null,
    rsi_verification_code: null, rsi_verified: true, job_title: null, voice_channel_name: null, timezone: null,
    date_format: null, probation_start: null, probation_end: null, tenure_start_date: null,
    tokens_valid_from: '2026-05-01T00:00:00Z', deleted_at: null, role: MEMBER_ROLE, ...over,
});

beforeEach(() => {
    resetSb();
    sb.systemRoles = { client: { id: 1, name: 'Client' }, member: { id: 2, name: 'Member' }, admin: { id: 4, name: 'Admin' } };
    for (const fn of Object.values(h.log)) fn.mockReset();
    h.withdrawCraftingOffers.mockReset();
    h.withdrawCraftingOffers.mockResolvedValue({ offersWithdrawn: 0, claimsReleased: 0 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
    assertNoWildcardSelect();
});

describe('logHrPositionChange — service-record timeline', () => {
    it('no change → no writes at all', async () => {
        await logHrPositionChange(5, 3, 3);
        expect(sb.queries).toEqual([]);
    });

    it('reassignment: closes the open row as "reassigned" and opens the new one', async () => {
        await logHrPositionChange(5, 3, 8);
        const [close, open] = on('user_hr_position_history');
        expect(chainOf(close)).toEqual([
            ['update', { ended_at: ISO, end_reason: 'reassigned' }], ['eq', 'user_id', 5], ['is', 'ended_at', null],
        ]);
        expect(chainOf(open)).toEqual([['insert', { user_id: 5, position_id: 8 }]]);
    });

    it('unassignment: closes as "unassigned" and opens nothing', async () => {
        await logHrPositionChange(5, 3, null);
        const qs = on('user_hr_position_history');
        expect(qs).toHaveLength(1);
        expect(argsOf(qs[0], 'update')).toEqual([{ ended_at: ISO, end_reason: 'unassigned' }]);
    });

    it('best-effort: a thrown history write is logged and swallowed', async () => {
        const boom = new Error('history down');
        sb.handler = () => { throw boom; };
        await expect(logHrPositionChange(5, null, 2)).resolves.toBeUndefined();
        expect(h.log.error).toHaveBeenCalledWith('position history log failed', { userId: 5, err: boom });
    });
});

describe('findUserByDiscordId — the login resolver', () => {
    it('excludes soft-deleted rows by default and stamps the Admin identity fact', async () => {
        queue('users', { data: userRow({ role_id: 4, role: ADMIN_ROLE }) });
        const u = await findUserByDiscordId('123456789');
        expect(chainOf(on('users')[0])).toEqual([
            ['select', USER_SELECT_QUERY], ['eq', 'discord_id', '123456789'], ['is', 'deleted_at', null], ['maybeSingle'],
        ]);
        expect(u).toMatchObject({ id: 5, roleId: 4, isSystemAdmin: true, tokensValidFrom: '2026-05-01T00:00:00Z' });
        expect(u).not.toHaveProperty('deletedAt');
    });

    it('includeDeleted drops the filter and surfaces deletedAt for the reactivation flow', async () => {
        queue('users', { data: userRow({ deleted_at: '2026-04-01T00:00:00Z' }) });
        const u = await findUserByDiscordId('123456789', true);
        expect(has(on('users')[0], 'is')).toBe(false);
        expect((u as { deletedAt?: string }).deletedAt).toBe('2026-04-01T00:00:00Z');
        expect(u!.isSystemAdmin).toBe(false);
    });

    it('not found (PGRST116 or no row) → null; any other fault throws', async () => {
        queue('users', { data: null, error: { code: 'PGRST116' } }, { data: null }, { error: { code: 'XX000' } });
        expect(await findUserByDiscordId('1')).toBeNull();
        expect(await findUserByDiscordId('1')).toBeNull();
        await expect(findUserByDiscordId('1')).rejects.toThrow('Failed to find user');
    });
});

describe('getUsersByIdsLite — the users_slice roster patch', () => {
    it('empty / non-array input issues no query', async () => {
        expect(await getUsersByIdsLite([])).toEqual([]);
        expect(await getUsersByIdsLite(undefined as unknown as number[])).toEqual([]);
        expect(sb.queries).toEqual([]);
    });

    it('reads the ROSTER projection (no verification secret, no watermark), live rows only', async () => {
        queue('users', { data: [userRow({ id: 5 }), userRow({ id: 6, name: 'B' })] });
        const out = await getUsersByIdsLite([5, 6]);
        expect(chainOf(on('users')[0])).toEqual([
            ['select', USER_ROSTER_SELECT_QUERY], ['in', 'id', [5, 6]], ['is', 'deleted_at', null],
        ]);
        expect(USER_ROSTER_SELECT_QUERY).not.toContain('rsi_verification_code');
        expect(USER_ROSTER_SELECT_QUERY).not.toContain('tokens_valid_from');
        expect(out.map((u) => [u.id, u.name])).toEqual([[5, 'Jenko'], [6, 'B']]);
    });

    it('THROWS on a fault (a silent [] would evict live users from every roster); null data → []', async () => {
        queue('users', { error: { code: 'XX000' } }, { data: null });
        await expect(getUsersByIdsLite([5])).rejects.toThrow('Failed to get users slice');
        expect(await getUsersByIdsLite([5])).toEqual([]);
    });
});

describe('getUserById — session resolution, fail-safe in both directions', () => {
    it('resolves a live user with the full projection and stamps isSystemAdmin from the role id', async () => {
        queue('users', { data: userRow({ role_id: 4, role: { id: 4, name: 'Renamed', is_system: false, role_permissions: [] } }) });
        const u = await getUserById(5);
        expect(chainOf(on('users')[0])).toEqual([
            ['select', USER_SELECT_QUERY], ['eq', 'id', 5], ['is', 'deleted_at', null], ['single'],
        ]);
        // Not corroborated by the embedded role, but the role id IS the Admin slot.
        expect(u!.isSystemAdmin).toBe(true);
    });

    it('a member resolves with isSystemAdmin false', async () => {
        queue('users', { data: userRow() });
        expect((await getUserById(5))!.isSystemAdmin).toBe(false);
    });

    it('PGRST116 is the only truthful "absent": null, and NO fallback round-trip', async () => {
        queue('users', { error: { code: 'PGRST116', message: 'no rows' } });
        expect(await getUserById(5)).toBeNull();
        expect(on('users')).toHaveLength(1);
        expect(h.log.warn).not.toHaveBeenCalled();
    });

    it('a full-query fault falls back to the list projection, which KEEPS tokens_valid_from', async () => {
        queue('users', { error: { code: 'PGRST200', message: 'missing fk' } }, { data: userRow() });
        const u = await getUserById(5);
        expect(chainOf(on('users')[1])).toEqual([
            ['select', USER_LIST_SELECT_QUERY], ['eq', 'id', 5], ['is', 'deleted_at', null], ['single'],
        ]);
        expect(USER_LIST_SELECT_QUERY).toContain('tokens_valid_from');
        expect(u).toMatchObject({ id: 5, tokensValidFrom: '2026-05-01T00:00:00Z', isSystemAdmin: false });
        expect(h.log.warn).toHaveBeenCalledWith('full user query failed, trying fallback', { userId: 5, message: 'missing fk' });
    });

    it('fallback says absent (PGRST116) → null', async () => {
        queue('users', { error: { code: 'PGRST200', message: 'x' } }, { error: { code: 'PGRST116' } });
        expect(await getUserById(5)).toBeNull();
    });

    it('fallback ALSO faults → THROWS, never a null that reads as "deleted"', async () => {
        queue('users', { error: { code: 'PGRST200', message: 'x' } }, { error: { code: '57P01' } });
        await expect(getUserById(5)).rejects.toThrow('Failed to load user');
    });

    it('fallback returns neither row nor error → null', async () => {
        queue('users', { error: { code: 'PGRST200', message: 'x' } }, { data: null });
        expect(await getUserById(5)).toBeNull();
    });
});

describe('getActorLabel — cosmetic, never throws', () => {
    it('returns the resolved name, or "Unknown" for an absent user', async () => {
        queue('users', { data: userRow({ name: 'Jenko' }) }, { error: { code: 'PGRST116' } });
        expect(await getActorLabel(5)).toBe('Jenko');
        expect(await getActorLabel(6)).toBe('Unknown');
    });

    it('a fail-closed resolver throw is absorbed into "Unknown" with a warn', async () => {
        queue('users', { error: { code: 'PGRST200', message: 'x' } }, { error: { code: '57P01' } });
        expect(await getActorLabel(5)).toBe('Unknown');
        expect(h.log.warn).toHaveBeenCalledWith('actor label lookup failed; logging attribution as Unknown', expect.objectContaining({ userId: 5 }));
    });
});

describe('getUserByAuthId — fallback resolver', () => {
    it('filters soft-deleted rows and maps the user', async () => {
        queue('users', { data: userRow() });
        const u = await getUserByAuthId('auth-1');
        expect(chainOf(on('users')[0])).toEqual([
            ['select', USER_SELECT_QUERY], ['eq', 'auth_user_id', 'auth-1'], ['is', 'deleted_at', null], ['maybeSingle'],
        ]);
        expect(u!.id).toBe(5);
    });

    it('no row → undefined user (maybeSingle reports absence as data null)', async () => {
        queue('users', { data: null });
        expect(await getUserByAuthId('auth-1')).toBeUndefined();
    });

    it('a fault falls back to the list projection; a fallback hit maps', async () => {
        queue('users', { error: { code: 'PGRST200', message: 'x' } }, { data: userRow({ id: 9 }) });
        expect((await getUserByAuthId('auth-1'))!.id).toBe(9);
        expect(argsOf(on('users')[1], 'select')).toEqual([USER_LIST_SELECT_QUERY]);
        expect(argsOf(on('users')[1], 'eq')).toEqual(['auth_user_id', 'auth-1']);
    });

    it('fallback fault throws; fallback absence returns null', async () => {
        queue('users', { error: { code: 'PGRST200', message: 'x' } }, { error: { code: '57P01' } });
        await expect(getUserByAuthId('auth-1')).rejects.toThrow('Failed to load user');
        queue('users', { error: { code: 'PGRST200', message: 'x' } }, { data: null });
        expect(await getUserByAuthId('auth-1')).toBeNull();
    });
});

describe('getAdmins', () => {
    it('reads live holders of the system Admin role', async () => {
        queue('users', { data: [userRow({ id: 1, role_id: 4, role: ADMIN_ROLE }), null] });
        const out = await getAdmins();
        expect(chainOf(on('users')[0])).toEqual([['select', USER_SELECT_QUERY], ['eq', 'role_id', 4], ['is', 'deleted_at', null]]);
        expect(out.map((u) => u.id)).toEqual([1]);
        expect(on('roles')).toHaveLength(0);
    });

    it('unresolved Admin slot: falls back to the highest-id system role', async () => {
        sb.systemRoles = {};
        queue('roles', { data: { id: 12 } });
        queue('users', { data: [] });
        expect(await getAdmins()).toEqual([]);
        expect(chainOf(on('roles')[0])).toEqual([
            ['select', 'id'], ['eq', 'is_system', true], ['order', 'id', { ascending: false }], ['limit', 1], ['maybeSingle'],
        ]);
        expect(argsOf(on('users')[0], 'eq')).toEqual(['role_id', 12]);
    });

    it('null data maps to no admins', async () => {
        queue('users', { data: null });
        expect(await getAdmins()).toEqual([]);
    });

    it('no system role at all → [] without a users read; a users fault throws', async () => {
        sb.systemRoles = {};
        queue('roles', { data: null });
        expect(await getAdmins()).toEqual([]);
        expect(on('users')).toHaveLength(0);

        sb.systemRoles = { admin: { id: 4, name: 'Admin' } };
        queue('users', { error: { code: 'XX000' } });
        await expect(getAdmins()).rejects.toThrow('Failed to find admins');
    });
});

describe('createUser — public finalize_setup chokepoint', () => {
    const input = { discordId: '123456789', name: 'Jenko', avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png', rsiHandle: 'Jenko_01', isAdmin: false };

    const happyPath = () => {
        queue('users',
            { data: null },                 // discord duplicate check
            { data: null },                 // handle collision check
            { data: userRow({ id: 30 }) },  // insert
        );
        queue('security_clearances', { data: { id: 77 } });
    };

    it('inserts a sanitised Client row, re-parents ad-hoc requests, and emits an id-only user_update', async () => {
        happyPath();
        const u = await createUser({ ...input, name: '<b>Jenko</b>\nthe Great' });
        const [dupCheck, handleCheck, insert] = on('users');
        expect(chainOf(dupCheck)).toEqual([
            ['select', 'id'], ['eq', 'discord_id', '123456789'], ['is', 'deleted_at', null], ['maybeSingle'],
        ]);
        // escapeLikePattern makes the ILIKE an exact match: `_` is escaped.
        expect(chainOf(handleCheck)).toEqual([
            ['select', 'id'], ['ilike', 'rsi_handle', 'Jenko\\_01'], ['is', 'deleted_at', null], ['maybeSingle'],
        ]);
        expect(chainOf(on('security_clearances')[0])).toEqual([['select', 'id'], ['eq', 'level', 1], ['maybeSingle']]);
        expect(chainOf(insert)).toEqual([
            ['insert', {
                discord_id: '123456789', name: 'Jenko the Great', avatar_url: 'https://cdn.discordapp.com/avatars/1/a.png',
                rsi_handle: 'Jenko_01', rsi_verified: true, role_id: 1, reputation: 50, clearance_level_id: 77,
            }],
            ['select', USER_SELECT_QUERY],
            ['single'],
        ]);
        expect(chainOf(on('service_requests')[0])).toEqual([
            ['update', { client_id: 30 }], ['ilike', 'unregistered_client_rsi_handle', 'Jenko\\_01'], ['is', 'client_id', null],
        ]);
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { userId: 30 } }]);
        expect(u!.id).toBe(30);
        // Nothing on the success path logs an error.
        expect(h.log.error).not.toHaveBeenCalled();
    });

    it('an Admin seat takes the Admin role; rsiVerified is honoured; no default clearance → null', async () => {
        queue('users', { data: null }, { data: null }, { data: userRow({ id: 31 }) });
        queue('security_clearances', { data: null });
        await createUser({ ...input, isAdmin: true, rsiVerified: false });
        const row = argsOf(on('users')[2], 'insert')![0] as Record<string, unknown>;
        expect(row).toMatchObject({ role_id: 4, rsi_verified: false, clearance_level_id: null });
    });

    it('a markup-only name falls back to the handle; a non-https avatar is dropped to null', async () => {
        happyPath();
        await createUser({ ...input, name: '<img src=x>', avatarUrl: 'javascript:alert(1)' });
        const row = argsOf(on('users')[2], 'insert')![0] as Record<string, unknown>;
        expect(row.name).toBe('Jenko_01');
        expect(row.avatar_url).toBeNull();
    });

    it('refuses a second live row on the same Discord account', async () => {
        queue('users', { data: { id: 2 } });
        await expect(createUser(input)).rejects.toThrow('A user with this Discord account already exists.');
        expect(on('users')).toHaveLength(1);
    });

    it('a duplicate-check fault fails closed', async () => {
        queue('users', { error: { code: 'XX000' } });
        await expect(createUser(input)).rejects.toThrow('Failed to check existing user');
        expect(on('users')).toHaveLength(1);
    });

    it('rejects a non-handle (LIKE wildcard) before any identity lookup', async () => {
        queue('users', { data: null });
        await expect(createUser({ ...input, rsiHandle: '%' })).rejects.toThrow(/not a valid RSI handle/);
        expect(on('users')).toHaveLength(1);
        expect(has(on('users')[0], 'ilike')).toBe(false);
    });

    it('refuses an RSI handle already bound to a live account', async () => {
        queue('users', { data: null }, { data: { id: 3 } });
        await expect(createUser(input)).rejects.toThrow('That RSI handle is already linked to another account.');
        expect(on('users').some((q) => q.op === 'insert')).toBe(false);
    });

    it('an empty discordId skips the duplicate check (handle check still runs)', async () => {
        queue('users', { data: null }, { data: userRow({ id: 32 }) });
        queue('security_clearances', { data: null });
        await createUser({ ...input, discordId: '' });
        expect(has(on('users')[0], 'ilike')).toBe(true);
    });

    it('refuses to create when the needed system role is unresolved (seeding error)', async () => {
        sb.systemRoles = { client: { id: 1, name: 'Client' } };
        queue('users', { data: null }, { data: null });
        await expect(createUser({ ...input, isAdmin: true })).rejects.toThrow('Organization has no Admin role configured. Seeding error.');
        sb.systemRoles = { admin: { id: 4, name: 'Admin' } };
        queue('users', { data: null }, { data: null });
        await expect(createUser(input)).rejects.toThrow('Organization has no Client role configured. Seeding error.');
        expect(on('users').some((q) => q.op === 'insert')).toBe(false);
    });

    it('an insert fault throws with no re-parent and no broadcast', async () => {
        queue('users', { data: null }, { data: null }, { error: { code: '23505' } });
        queue('security_clearances', { data: null });
        await expect(createUser(input)).rejects.toThrow('Failed to create user');
        expect(on('service_requests')).toHaveLength(0);
        expect(sb.broadcasts).toEqual([]);
    });
});

describe('reactivateUser — no mass-assignment on re-login', () => {
    it('copies ONLY name / avatar_url and clears deleted_at', async () => {
        queue('users', { data: userRow({ name: 'Back' }) });
        const u = await reactivateUser(5, {
            name: 'Back', avatar_url: 'https://x.example/a.png', role_id: 4, reputation: 100, clearance_level_id: 9,
        } as unknown as Parameters<typeof reactivateUser>[1]);
        expect(chainOf(on('users')[0])).toEqual([
            ['update', { deleted_at: null, name: 'Back', avatar_url: 'https://x.example/a.png' }],
            ['eq', 'id', 5],
            ['select', USER_SELECT_QUERY],
            ['single'],
        ]);
        expect(u!.name).toBe('Back');
    });

    it('omitted fields stay untouched; a fault throws', async () => {
        queue('users', { data: userRow() }, { error: { code: 'XX000' } });
        await reactivateUser(5, {});
        expect(argsOf(on('users')[0], 'update')).toEqual([{ deleted_at: null }]);
        await expect(reactivateUser(5, {})).rejects.toThrow('Failed to reactivate user');
    });
});

describe('deleteUser — anonymise, revoke, stand down', () => {
    const anonymised = {
        deleted_at: ISO, name: 'Deleted User', avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png',
        voice_channel_name: null, is_duty: false, tokens_valid_from: ISO,
    };

    it('anonymises (keeping discord_id / rsi_handle), stamps the watermark, drops push, withdraws crafting, broadcasts', async () => {
        queue('users', { data: { id: 5 } }, {});
        await deleteUser(5);
        const [probe, write] = on('users');
        expect(chainOf(probe)).toEqual([['select', 'id'], ['eq', 'id', 5], ['maybeSingle']]);
        expect(chainOf(write)).toEqual([['update', anonymised], ['eq', 'id', 5]]);
        expect(Object.keys(anonymised)).not.toContain('discord_id');
        expect(chainOf(on('push_subscriptions')[0])).toEqual([['delete'], ['eq', 'user_id', 5]]);
        expect(h.withdrawCraftingOffers).toHaveBeenCalledWith(5);
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { userId: 5 } }]);
    });

    it.each([['42703'], ['PGRST204']])('pre-migration (%s): retries WITHOUT tokens_valid_from', async (code) => {
        queue('users', { data: { id: 5 } }, { error: { code } }, {});
        await deleteUser(5);
        const writes = on('users').filter((q) => q.op === 'update');
        expect(writes).toHaveLength(2);
        const { tokens_valid_from: _drop, ...rest } = anonymised;
        void _drop;
        expect(argsOf(writes[1], 'update')).toEqual([rest]);
    });

    it('unknown user → throws, nothing written', async () => {
        queue('users', { data: null });
        await expect(deleteUser(5)).rejects.toThrow('User not found');
        expect(on('users').some((q) => q.op === 'update')).toBe(false);
        expect(sb.broadcasts).toEqual([]);
    });

    it('a write fault throws BEFORE any cleanup or broadcast', async () => {
        queue('users', { data: { id: 5 } }, { error: { code: 'XX000' } });
        await expect(deleteUser(5)).rejects.toThrow('Failed to delete user');
        expect(on('push_subscriptions')).toHaveLength(0);
        expect(h.withdrawCraftingOffers).not.toHaveBeenCalled();
        expect(sb.broadcasts).toEqual([]);
    });

    it('cleanup failures are logged, never rethrown — the removal stands', async () => {
        queue('users', { data: { id: 5 } }, {});
        queue('push_subscriptions', { error: { code: '57014', message: 'timeout' } });
        h.withdrawCraftingOffers.mockRejectedValue(new Error('module off'));
        await expect(deleteUser(5)).resolves.toBeUndefined();
        expect(h.log.error).toHaveBeenCalledWith('failed to revoke push subscriptions for deleted user', { userId: 5, code: '57014', message: 'timeout' });
        expect(h.log.error).toHaveBeenCalledWith('failed to stand down crafting offers for deleted user', expect.objectContaining({ userId: 5 }));
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { userId: 5 } }]);
    });

    it('a THROWN push cleanup is also absorbed', async () => {
        const boom = new Error('driver');
        sb.handler = (q) => {
            if (q.table === 'push_subscriptions') throw boom;
            return q.op === 'select' ? { data: { id: 5 } } : {};
        };
        await expect(deleteUser(5)).resolves.toBeUndefined();
        expect(h.log.error).toHaveBeenCalledWith('failed to revoke push subscriptions for deleted user', { userId: 5, err: boom });
    });
});

describe('revokeUserSessions — advance the watermark', () => {
    it('stamps tokens_valid_from = now and emits an id-only user_update', async () => {
        queue('users', { data: { id: 5 } }, {});
        await revokeUserSessions(5);
        expect(chainOf(on('users')[1])).toEqual([['update', { tokens_valid_from: ISO }], ['eq', 'id', 5]]);
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { userId: 5 } }]);
    });

    it.each([[0], [-1], [1.5], [Number.NaN]])('rejects an invalid id (%s) with no query', async (id) => {
        await expect(revokeUserSessions(id)).rejects.toThrow('Invalid user id.');
        expect(sb.queries).toEqual([]);
    });

    it('unknown user → throws; write fault → throws; neither broadcasts', async () => {
        queue('users', { data: null });
        await expect(revokeUserSessions(5)).rejects.toThrow('User not found.');
        queue('users', { data: { id: 5 } }, { error: { code: 'XX000' } });
        await expect(revokeUserSessions(5)).rejects.toThrow('Failed to revoke user sessions');
        expect(sb.broadcasts).toEqual([]);
    });
});
