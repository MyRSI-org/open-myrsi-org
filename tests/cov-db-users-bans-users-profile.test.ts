import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/users.ts — self-service profile, duty / presence, RSI linking, Discord
// sync and web-push subscriptions.
//
// Properties pinned here, beyond the plain query shapes:
//   * duty / presence: the staff-on-duty probe fails to null ("unknown"), never to
//     false, and its role filter is NULL-inclusive; duty broadcasts carry ids only.
//   * RSI linking: a handle must be shape-valid, PROVEN by a server-issued code on
//     the public bio, and unique among live users before it binds — and only then
//     are that handle's ad-hoc requests re-parented.
//   * Discord sync: role mappings onto the Client / Admin system roles are never
//     applied, system roles that cannot be resolved apply NO role mapping, sync
//     never downgrades, and the bulk path emits ONE aggregate id-only frame.
//   * push: the stored jsonb is rebuilt field-by-field (never the caller's object),
//     the endpoint must be an allow-listed https vendor host, the per-user cap
//     evicts the oldest, and the logout delete is pinned to the caller's user id
//     and never logs the endpoint (a delivery capability).

const h = vi.hoisted(() => ({
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getDiscordMember: vi.fn(),
    pushDiscordRoles: vi.fn(),
    getDiscordUserById: vi.fn(),
    buildGlobalAvatarUrl: vi.fn(),
    getAllSettings: vi.fn(),
    verifyRsiHandle: vi.fn(),
}));

vi.mock('../lib/db/common', async () => (await import('./cov-db-users-bans-fake')).commonMock);
vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    return { ...actual, log: { ...actual.log, child: () => h.log } };
});
vi.mock('../lib/discord', () => ({
    getDiscordMember: (...a: unknown[]) => h.getDiscordMember(...a),
    pushDiscordRolesForUser: (...a: unknown[]) => h.pushDiscordRoles(...a),
    getDiscordUserById: (...a: unknown[]) => h.getDiscordUserById(...a),
    buildGlobalAvatarUrl: (...a: unknown[]) => h.buildGlobalAvatarUrl(...a),
}));
vi.mock('../lib/db/system', () => ({ getAllSettings: (...a: unknown[]) => h.getAllSettings(...a) }));
vi.mock('../lib/db/blueprints', () => ({ withdrawCraftingOffers: vi.fn() }));
vi.mock('../lib/rsi', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/rsi')>()),
    verifyRsiHandle: (...a: unknown[]) => h.verifyRsiHandle(...a),
}));

import {
    isAnyStaffOnDuty, getUsersPresenceState, toggleUserAffiliateStatus, toggleUserVipStatus, toggleUserDutyStatus,
    updateUserHeartbeat, refreshUserAvatar, cleanupInactiveDutyUsers, initiateRsiHandleUpdate, verifyRsiUpdate,
    cancelRsiUpdate, updateUserDisplayName, updateUserPreferences, updateUserSpecializations,
    adminAdjustUserReputation, getReputationHistoryForUser, getRatingHistoryForUser, promoteUserToMember,
    syncUserRoles, syncAllMemberRoles, savePushSubscription, deleteOwnPushSubscription,
} from '../lib/db/users';
import { sb, resetSb, queue, on, chainOf, argsOf, has, assertNoWildcardSelect, type SbQuery } from './cov-db-users-bans-fake';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const ROLES = { client: { id: 1, name: 'Client' }, member: { id: 2, name: 'Member' }, dispatcher: { id: 3, name: 'Dispatcher' }, admin: { id: 4, name: 'Admin' } };
const SYNC_OK = 'Identity & Roles Synced';

const eqVal = (q: SbQuery, col: string): unknown => q.calls.find((c) => c.method === 'eq' && c.args[0] === col)?.args[1];
const sel = (q: SbQuery): unknown => argsOf(q, 'select')?.[0];
/** Let fire-and-forget work (avatar refresh, push catch handlers) settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    resetSb();
    sb.systemRoles = { ...ROLES };
    for (const fn of Object.values(h.log)) fn.mockReset();
    for (const k of ['getDiscordMember', 'pushDiscordRoles', 'getDiscordUserById', 'buildGlobalAvatarUrl', 'getAllSettings', 'verifyRsiHandle'] as const) h[k].mockReset();
    h.pushDiscordRoles.mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
    assertNoWildcardSelect();
});

describe('isAnyStaffOnDuty — the customer-facing availability boolean', () => {
    it('existence probe over live on-duty users, excluding the Client role NULL-inclusively', async () => {
        queue('users', { data: [{ id: 3 }] });
        expect(await isAnyStaffOnDuty()).toBe(true);
        expect(chainOf(on('users')[0])).toEqual([
            ['select', 'id'], ['is', 'deleted_at', null], ['eq', 'is_duty', true], ['limit', 1],
            ['or', 'role_id.is.null,role_id.neq.1'],
        ]);
    });

    it('nobody on duty → false (empty or null data)', async () => {
        queue('users', { data: [] }, { data: null });
        expect(await isAnyStaffOnDuty()).toBe(false);
        expect(await isAnyStaffOnDuty()).toBe(false);
    });

    it('an unresolvable Client role answers WITHOUT the exclusion (over-count) and warns', async () => {
        sb.systemRoles = {};
        queue('users', { data: [{ id: 1 }] });
        expect(await isAnyStaffOnDuty()).toBe(true);
        expect(has(on('users')[0], 'or')).toBe(false);
        expect(h.log.warn).toHaveBeenCalledWith('staff-on-duty probe: Client system role unresolved, customers may be counted as available');
    });

    it('a probe fault or a role-lookup throw is null ("unknown"), never false', async () => {
        const err = { code: 'XX000' };
        queue('users', { error: err });
        expect(await isAnyStaffOnDuty()).toBeNull();
        expect(h.log.warn).toHaveBeenCalledWith('staff-on-duty availability probe failed', { err });

        const boom = new Error('roles down');
        sb.systemRolesThrows = boom;
        expect(await isAnyStaffOnDuty()).toBeNull();
        expect(h.log.warn).toHaveBeenCalledWith('staff-on-duty availability probe threw', { err: boom });
    });
});

describe('getUsersPresenceState — slim duty refresh', () => {
    it('joins live users to presence timestamps', async () => {
        queue('users', { data: [{ id: 1, is_duty: true }, { id: 2, is_duty: null }] });
        queue('user_presence', { data: [{ user_id: 1, last_active_at: 'T1' }, { user_id: 9, last_active_at: null }] });
        expect(await getUsersPresenceState()).toEqual({
            usersPresence: [
                { userId: 1, isDuty: true, lastActiveAt: 'T1' },
                { userId: 2, isDuty: false, lastActiveAt: null },
            ],
        });
        expect(chainOf(on('users')[0])).toEqual([['select', 'id, is_duty'], ['is', 'deleted_at', null]]);
        expect(chainOf(on('user_presence')[0])).toEqual([['select', 'user_id, last_active_at']]);
    });

    it('a users fault returns an empty list with a warn; missing presence → null timestamps', async () => {
        const err = { code: 'XX000' };
        queue('users', { error: err }, { data: [{ id: 1, is_duty: false }] });
        queue('user_presence', { data: null }, { data: null });
        expect(await getUsersPresenceState()).toEqual({ usersPresence: [] });
        expect(h.log.warn).toHaveBeenCalledWith('users presence query failed', { err });
        expect(await getUsersPresenceState()).toEqual({ usersPresence: [{ userId: 1, isDuty: false, lastActiveAt: null }] });
    });

    it('null users data → empty list', async () => {
        queue('users', { data: null });
        expect(await getUsersPresenceState()).toEqual({ usersPresence: [] });
    });
});

describe('affiliate / VIP toggles — Client-only', () => {
    it('flips the flag on a Client and emits an id-only user_update', async () => {
        queue('users', { data: { id: 5, role_id: 1, is_affiliate: false } }, {});
        expect(await toggleUserAffiliateStatus(5)).toEqual({ isAffiliate: true });
        expect(chainOf(on('users')[0])).toEqual([['select', 'id, role_id, is_affiliate'], ['eq', 'id', 5], ['maybeSingle']]);
        expect(chainOf(on('users')[1])).toEqual([['update', { is_affiliate: true }], ['eq', 'id', 5]]);
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { userId: 5 } }]);
    });

    it('VIP reads and writes is_vip', async () => {
        queue('users', { data: { id: 5, role_id: 1, is_vip: true } }, {});
        expect(await toggleUserVipStatus(5)).toEqual({ isVip: false });
        expect(argsOf(on('users')[0], 'select')).toEqual(['id, role_id, is_vip']);
        expect(argsOf(on('users')[1], 'update')).toEqual([{ is_vip: false }]);
    });

    it('unknown user → USER_NOT_FOUND; staff target or unresolved Client role → NOT_A_CLIENT', async () => {
        queue('users', { data: null });
        await expect(toggleUserVipStatus(5)).rejects.toMatchObject({ code: 'USER_NOT_FOUND', message: 'User not found in organization.' });
        queue('users', { data: { id: 5, role_id: 2, is_vip: false } });
        await expect(toggleUserVipStatus(5)).rejects.toMatchObject({ code: 'NOT_A_CLIENT', message: 'Affiliate / VIP flags can only be set on Client users.' });
        sb.systemRoles = {};
        queue('users', { data: { id: 5, role_id: 1, is_vip: false } });
        await expect(toggleUserVipStatus(5)).rejects.toMatchObject({ code: 'NOT_A_CLIENT' });
        expect(on('users').some((q) => q.op === 'update')).toBe(false);
        expect(sb.broadcasts).toEqual([]);
    });

    it('a write fault throws before the broadcast', async () => {
        queue('users', { data: { id: 5, role_id: 1, is_vip: false } }, { error: { code: 'X' } });
        await expect(toggleUserVipStatus(5)).rejects.toThrow('Failed to toggle is_vip');
        expect(sb.broadcasts).toEqual([]);
    });
});

describe('toggleUserDutyStatus — presence refresh on going ON duty', () => {
    it('ON: writes is_duty, refreshes user_presence, broadcasts { userId } only', async () => {
        queue('users', { data: { is_duty: false } }, {});
        await toggleUserDutyStatus(5);
        expect(chainOf(on('users')[0])).toEqual([['select', 'is_duty'], ['eq', 'id', 5], ['maybeSingle']]);
        expect(chainOf(on('users')[1])).toEqual([['update', { is_duty: true }], ['eq', 'id', 5]]);
        expect(chainOf(on('user_presence')[0])).toEqual([['upsert', { user_id: 5, last_active_at: ISO }, { onConflict: 'user_id' }]]);
        expect(sb.broadcasts).toEqual([{ event: 'duty_update', payload: { userId: 5 } }]);
    });

    it('OFF: no presence write', async () => {
        queue('users', { data: { is_duty: true } }, {});
        await toggleUserDutyStatus(5);
        expect(argsOf(on('users')[1], 'update')).toEqual([{ is_duty: false }]);
        expect(on('user_presence')).toHaveLength(0);
    });

    it('an unknown user is a silent no-op: no write, no broadcast', async () => {
        queue('users', { data: null });
        await expect(toggleUserDutyStatus(5)).resolves.toBeUndefined();
        expect(on('users')).toHaveLength(1);
        expect(sb.broadcasts).toEqual([]);
    });

    it('a write fault throws: no presence write, no broadcast', async () => {
        queue('users', { data: { is_duty: false } }, { error: { code: 'X' } });
        await expect(toggleUserDutyStatus(5)).rejects.toThrow('Failed to toggle duty status');
        expect(on('user_presence')).toHaveLength(0);
        expect(sb.broadcasts).toEqual([]);
    });
});

describe('updateUserHeartbeat + lazy avatar refresh', () => {
    const userRow = { id: 5, discord_id: '123456789', avatar_url: 'https://cdn.discordapp.com/avatars/123456789/old.png' };

    it('touches user_presence (never users) and returns the force-logout stamp', async () => {
        queue('users', { data: null });
        queue('settings', { data: { value: { force_logout_timestamp: '2026-05-31T00:00:00Z', other: 'x' } } });
        expect(await updateUserHeartbeat(5)).toEqual({ force_logout_timestamp: '2026-05-31T00:00:00Z' });
        expect(chainOf(on('user_presence')[0])).toEqual([['update', { last_active_at: ISO }], ['eq', 'user_id', 5]]);
        expect(chainOf(on('settings')[0])).toEqual([['select', 'value'], ['eq', 'key', 'platformSettings'], ['maybeSingle']]);
        expect(on('users').every((q) => q.op === 'select')).toBe(true);
    });

    it('no settings row → null stamp; a presence write fault is a warn, not a throw', async () => {
        const err = { code: 'X' };
        queue('user_presence', { error: err });
        queue('users', { data: null });
        queue('settings', { data: null });
        expect(await updateUserHeartbeat(5)).toEqual({ force_logout_timestamp: null });
        expect(h.log.warn).toHaveBeenCalledWith('heartbeat update failed', { err });
    });

    it('stale cache: re-resolves the global avatar and persists a changed URL, then stamps the refresh', async () => {
        queue('users', { data: userRow }, {});
        queue('user_presence', {}, { data: { avatar_refreshed_at: new Date(NOW - 25 * HOUR).toISOString() } }, {});
        h.getDiscordUserById.mockResolvedValue({ id: '123456789', avatar: 'new' });
        h.buildGlobalAvatarUrl.mockReturnValue('https://cdn.discordapp.com/avatars/123456789/new.png');
        await updateUserHeartbeat(5);
        await flush();
        expect(chainOf(on('users')[0])).toEqual([['select', 'id, discord_id, avatar_url'], ['eq', 'id', 5], ['maybeSingle']]);
        expect(chainOf(on('user_presence')[1])).toEqual([['select', 'avatar_refreshed_at'], ['eq', 'user_id', 5], ['maybeSingle']]);
        expect(h.getDiscordUserById).toHaveBeenCalledWith('123456789');
        expect(chainOf(on('users')[1])).toEqual([['update', { avatar_url: 'https://cdn.discordapp.com/avatars/123456789/new.png' }], ['eq', 'id', 5]]);
        expect(chainOf(on('user_presence')[2])).toEqual([['update', { avatar_refreshed_at: ISO }], ['eq', 'user_id', 5]]);
    });

    it('an unchanged URL is not rewritten (no users fan-out), but the refresh is stamped', async () => {
        queue('users', { data: userRow });
        queue('user_presence', {}, { data: null }, {});
        h.getDiscordUserById.mockResolvedValue({ id: '123456789', avatar: 'old' });
        h.buildGlobalAvatarUrl.mockReturnValue(userRow.avatar_url);
        await updateUserHeartbeat(5);
        await flush();
        expect(on('users').some((q) => q.op === 'update')).toBe(false);
        expect(argsOf(on('user_presence')[2], 'update')).toEqual([{ avatar_refreshed_at: ISO }]);
    });

    it('a fresh cache (< 24h) skips Discord entirely; an unparseable stamp counts as stale', async () => {
        queue('users', { data: userRow }, { data: userRow });
        queue('user_presence', {}, { data: { avatar_refreshed_at: new Date(NOW - HOUR).toISOString() } });
        await updateUserHeartbeat(5);
        await flush();
        expect(h.getDiscordUserById).not.toHaveBeenCalled();

        queue('user_presence', {}, { data: { avatar_refreshed_at: 'not-a-date' } }, {});
        h.getDiscordUserById.mockResolvedValue({ id: '123456789' });
        h.buildGlobalAvatarUrl.mockReturnValue(null);
        await updateUserHeartbeat(5);
        await flush();
        expect(h.getDiscordUserById).toHaveBeenCalledTimes(1);
    });

    it('a Discord lookup failure stamps the refresh (retry in 24h) and writes no avatar', async () => {
        queue('users', { data: userRow });
        queue('user_presence', {}, { data: null }, {});
        h.getDiscordUserById.mockRejectedValue(new Error('no bot token'));
        await updateUserHeartbeat(5);
        await flush();
        expect(on('users').some((q) => q.op === 'update')).toBe(false);
        expect(argsOf(on('user_presence')[2], 'update')).toEqual([{ avatar_refreshed_at: ISO }]);
    });

    it('a Discord user without an id is a silent no-op (no stamp)', async () => {
        queue('users', { data: userRow });
        queue('user_presence', {}, { data: null });
        h.getDiscordUserById.mockResolvedValue({});
        await updateUserHeartbeat(5);
        await flush();
        expect(on('user_presence')).toHaveLength(2);
    });

    it('an unlinked user, or a row read fault, never reaches Discord', async () => {
        queue('users', { data: { ...userRow, discord_id: null } }, { error: { code: 'X' } });
        await updateUserHeartbeat(5);
        await updateUserHeartbeat(5);
        await flush();
        expect(h.getDiscordUserById).not.toHaveBeenCalled();
        expect(on('user_presence').filter((q) => sel(q) === 'avatar_refreshed_at')).toHaveLength(0);
    });

    it('a thrown refresh is caught and warned, never surfaced', async () => {
        const boom = new Error('driver');
        sb.handler = (q) => {
            if (q.table === 'users' && sel(q) === 'id, discord_id, avatar_url') throw boom;
            return undefined;
        };
        await expect(updateUserHeartbeat(5)).resolves.toEqual({ force_logout_timestamp: null });
        await flush();
        expect(h.log.warn).toHaveBeenCalledWith('avatar lazy refresh failed', { userId: 5, err: boom });
    });
});

describe('refreshUserAvatar (OAuth callback)', () => {
    it('writes the avatar then stamps the refresh on user_presence', async () => {
        await refreshUserAvatar(5, 'https://cdn.discordapp.com/avatars/1/a.png');
        expect(chainOf(on('users')[0])).toEqual([['update', { avatar_url: 'https://cdn.discordapp.com/avatars/1/a.png' }], ['eq', 'id', 5]]);
        expect(chainOf(on('user_presence')[0])).toEqual([['update', { avatar_refreshed_at: ISO }], ['eq', 'user_id', 5]]);
    });

    it('rethrows the write error and skips the stamp', async () => {
        const err = { code: 'X', message: 'm' };
        queue('users', { error: err });
        await expect(refreshUserAvatar(5, 'u')).rejects.toBe(err);
        expect(on('user_presence')).toHaveLength(0);
    });
});

describe('cleanupInactiveDutyUsers — the duty sweep', () => {
    it('clears is_duty for on-duty users whose presence is older than the configured timeout', async () => {
        h.getAllSettings.mockResolvedValue({ brandingConfig: { dutyTimeoutMinutes: 45 } });
        queue('user_presence', { data: [{ user_id: 3 }, { user_id: 4 }] });
        queue('users', { data: [{ id: 3, name: 'A' }] });
        expect(await cleanupInactiveDutyUsers()).toEqual([{ id: 3, name: 'A' }]);
        expect(h.getAllSettings).toHaveBeenCalledWith({ decryptSecrets: false });
        expect(chainOf(on('user_presence')[0])).toEqual([['select', 'user_id'], ['lt', 'last_active_at', new Date(NOW - 45 * MIN).toISOString()]]);
        expect(chainOf(on('users')[0])).toEqual([
            ['update', { is_duty: false }], ['eq', 'is_duty', true], ['in', 'id', [3, 4]], ['select', 'id, name'],
        ]);
        expect(sb.broadcasts).toEqual([{ event: 'duty_update', payload: { cleanup: true } }]);
    });

    it('defaults to 30 minutes; nobody stale (empty or null) → no users write', async () => {
        h.getAllSettings.mockResolvedValue({ brandingConfig: {} });
        queue('user_presence', { data: [] }, { data: null });
        expect(await cleanupInactiveDutyUsers()).toEqual([]);
        expect(argsOf(on('user_presence')[0], 'lt')).toEqual(['last_active_at', new Date(NOW - 30 * MIN).toISOString()]);
        expect(await cleanupInactiveDutyUsers()).toEqual([]);
        expect(on('users')).toHaveLength(0);
        expect(sb.broadcasts).toEqual([]);
    });

    it('a presence fault, an update fault, or a settings throw → [] with an error log, no broadcast', async () => {
        h.getAllSettings.mockResolvedValue({ brandingConfig: { dutyTimeoutMinutes: 30 } });
        queue('user_presence', { error: { code: 'X' } });
        expect(await cleanupInactiveDutyUsers()).toEqual([]);
        expect(h.log.error).toHaveBeenCalledWith('reading stale presence failed', { err: { code: 'X' } });
        expect(on('users')).toHaveLength(0);

        queue('user_presence', { data: [{ user_id: 3 }] });
        queue('users', { data: null, error: { code: 'Y' } });
        expect(await cleanupInactiveDutyUsers()).toEqual([]);
        expect(h.log.error).toHaveBeenCalledWith('duty user cleanup failed', { err: { code: 'Y' } });

        const boom = new Error('settings down');
        h.getAllSettings.mockRejectedValue(boom);
        expect(await cleanupInactiveDutyUsers()).toEqual([]);
        expect(h.log.error).toHaveBeenCalledWith('duty cleanup processing failed', { err: boom });
        expect(sb.broadcasts).toEqual([]);
    });
});

describe('RSI handle linking — prove control, then bind', () => {
    it('initiate: rejects a non-handle; stores the pending handle and a high-entropy server code', async () => {
        await expect(initiateRsiHandleUpdate(5, 'bad handle%')).rejects.toThrow(/not a valid RSI handle/);
        expect(sb.queries).toEqual([]);
        const { code } = await initiateRsiHandleUpdate(5, 'New_Handle');
        expect(code).toMatch(/^MYRSI-[A-Za-z0-9_-]{12}$/);
        expect(chainOf(on('users')[0])).toEqual([['update', { rsi_handle_pending: 'New_Handle', rsi_verification_code: code }], ['eq', 'id', 5]]);
        const again = await initiateRsiHandleUpdate(5, 'New_Handle');
        expect(again.code).not.toBe(code);
    });

    it('initiate: a write fault throws', async () => {
        queue('users', { error: { code: 'X' } });
        await expect(initiateRsiHandleUpdate(5, 'Ok')).rejects.toThrow('Failed to initiate RSI handle update');
    });

    it('verify: proven + unique → binds the handle, clears the pending pair, re-parents ad-hoc requests', async () => {
        queue('users', { data: { rsi_handle_pending: 'New_Handle', rsi_verification_code: 'MYRSI-abcdefghijkl' } }, { data: null }, {});
        h.verifyRsiHandle.mockResolvedValue(true);
        await verifyRsiUpdate(5);
        expect(h.verifyRsiHandle).toHaveBeenCalledWith('New_Handle', 'MYRSI-abcdefghijkl');
        const [fetch, unique, write] = on('users');
        expect(chainOf(fetch)).toEqual([['select', 'rsi_handle_pending, rsi_verification_code'], ['eq', 'id', 5], ['single']]);
        expect(chainOf(unique)).toEqual([
            ['select', 'id'], ['ilike', 'rsi_handle', 'New\\_Handle'], ['neq', 'id', 5], ['is', 'deleted_at', null], ['maybeSingle'],
        ]);
        expect(chainOf(write)).toEqual([
            ['update', { rsi_handle: 'New_Handle', rsi_handle_pending: null, rsi_verification_code: null, rsi_verified: true }],
            ['eq', 'id', 5],
        ]);
        expect(chainOf(on('service_requests')[0])).toEqual([
            ['update', { client_id: 5 }], ['ilike', 'unregistered_client_rsi_handle', 'New\\_Handle'], ['is', 'client_id', null],
        ]);
    });

    it('verify: refuses without a pending pair, without proof, or when the handle is taken — nothing bound', async () => {
        queue('users', { data: { rsi_handle_pending: null, rsi_verification_code: 'c' } }, { data: null });
        await expect(verifyRsiUpdate(5)).rejects.toThrow('No pending verification found.');
        await expect(verifyRsiUpdate(5)).rejects.toThrow('No pending verification found.');
        expect(h.verifyRsiHandle).not.toHaveBeenCalled();

        queue('users', { data: { rsi_handle_pending: 'H', rsi_verification_code: 'MYRSI-x' } });
        h.verifyRsiHandle.mockResolvedValue(false);
        await expect(verifyRsiUpdate(5)).rejects.toThrow('We could not find your verification code on that RSI profile. Add it to your bio, then try again.');

        queue('users', { data: { rsi_handle_pending: 'H', rsi_verification_code: 'MYRSI-x' } }, { data: { id: 8 } });
        h.verifyRsiHandle.mockResolvedValue(true);
        await expect(verifyRsiUpdate(5)).rejects.toThrow('That RSI handle is already linked to another account.');

        expect(on('users').some((q) => q.op === 'update')).toBe(false);
        expect(on('service_requests')).toHaveLength(0);
    });

    it('verify: a fetch fault throws; a bind fault throws WITHOUT re-parenting', async () => {
        queue('users', { error: { code: 'X' } });
        await expect(verifyRsiUpdate(5)).rejects.toThrow('Failed to fetch user verification data');

        queue('users', { data: { rsi_handle_pending: 'H', rsi_verification_code: 'MYRSI-x' } }, { data: null }, { error: { code: '23505' } });
        h.verifyRsiHandle.mockResolvedValue(true);
        await expect(verifyRsiUpdate(5)).rejects.toThrow('Failed to update RSI handle');
        expect(on('service_requests')).toHaveLength(0);
    });

    it('cancel clears the pending pair; a fault throws', async () => {
        await cancelRsiUpdate(5);
        expect(chainOf(on('users')[0])).toEqual([['update', { rsi_handle_pending: null, rsi_verification_code: null }], ['eq', 'id', 5]]);
        queue('users', { error: { code: 'X' } });
        await expect(cancelRsiUpdate(5)).rejects.toThrow('Failed to cancel RSI update');
    });
});

describe('profile preferences', () => {
    it('display name: trimmed, capped at 32, empty / non-string clears', async () => {
        await updateUserDisplayName(5, '  Ace  ');
        await updateUserDisplayName(5, 'x'.repeat(32));
        await updateUserDisplayName(5, '   ');
        await updateUserDisplayName(5, null);
        expect(on('users').map((q) => argsOf(q, 'update')![0])).toEqual([
            { display_name: 'Ace' }, { display_name: 'x'.repeat(32) }, { display_name: null }, { display_name: null },
        ]);
        expect(argsOf(on('users')[0], 'eq')).toEqual(['id', 5]);
        await expect(updateUserDisplayName(5, 'y'.repeat(33))).rejects.toThrow('Display name must be 32 characters or fewer.');
        expect(on('users')).toHaveLength(4);
        queue('users', { error: { code: 'X' } });
        await expect(updateUserDisplayName(5, 'A')).rejects.toThrow('Failed to update display name');
    });

    it('preferences: writes only present keys, validated strictly', async () => {
        await updateUserPreferences(5, { timezone: 'Europe/London', dateFormat: 'iso_24h' });
        await updateUserPreferences(5, { timezone: null });
        await updateUserPreferences(5, { timezone: '', dateFormat: '' });
        await updateUserPreferences(5, { timezone: undefined, dateFormat: null });
        await updateUserPreferences(5, { dateFormat: undefined });
        expect(on('users').map((q) => argsOf(q, 'update')![0])).toEqual([
            { timezone: 'Europe/London', date_format: 'iso_24h' },
            { timezone: null },
            { timezone: null, date_format: null },
            { timezone: null, date_format: null },
            { date_format: null },
        ]);
    });

    it('preferences: no keys → no write; invalid zone / preset → refused', async () => {
        await updateUserPreferences(5, {});
        expect(sb.queries).toEqual([]);
        await expect(updateUserPreferences(5, { timezone: 'Mars/Olympus_Mons' })).rejects.toThrow(/Invalid timezone/);
        await expect(updateUserPreferences(5, { timezone: 42 as unknown as string })).rejects.toThrow(/Invalid timezone/);
        await expect(updateUserPreferences(5, { dateFormat: 'yyyy' })).rejects.toThrow('Invalid date format. Use compact_12h, iso_24h, us_12h, or null to reset.');
        expect(sb.queries).toEqual([]);
        queue('users', { error: { code: 'X' } });
        await expect(updateUserPreferences(5, { timezone: 'UTC' })).rejects.toThrow('Failed to update preferences');
    });

    it('specializations: delete then insert; empty list only clears; each fault surfaces', async () => {
        await updateUserSpecializations(5, [2, 3]);
        expect(on('user_specializations').map(chainOf)).toEqual([
            [['delete'], ['eq', 'user_id', 5]],
            [['insert', [{ user_id: 5, specialization_id: 2 }, { user_id: 5, specialization_id: 3 }]]],
        ]);
        sb.queries = [];
        await updateUserSpecializations(5, []);
        expect(on('user_specializations').map((q) => q.op)).toEqual(['delete']);
        queue('user_specializations', { error: { code: 'X' } });
        await expect(updateUserSpecializations(5, [1])).rejects.toThrow('Failed to clear specializations');
        queue('user_specializations', {}, { error: { code: 'X' } });
        await expect(updateUserSpecializations(5, [1])).rejects.toThrow('Failed to add specializations');
    });
});

describe('reputation & rating history', () => {
    it('admin adjust: verifies the target, then calls the audited RPC', async () => {
        queue('users', { data: { id: 5 } });
        await adminAdjustUserReputation(5, 70, 100, 'Great op');
        expect(chainOf(on('users')[0])).toEqual([['select', 'id'], ['eq', 'id', 5], ['maybeSingle']]);
        expect(sb.rpcCalls).toEqual([{ fn: 'admin_adjust_reputation', args: { user_id_in: 5, new_reputation_in: 70, admin_id_in: 100, reason_in: 'Great op' } }]);
    });

    it('admin adjust: unknown target never reaches the RPC; an RPC fault throws', async () => {
        queue('users', { data: null });
        await expect(adminAdjustUserReputation(5, 70, 100, 'r')).rejects.toThrow('User not found in this organization');
        expect(sb.rpcCalls).toEqual([]);
        queue('users', { data: { id: 5 } });
        sb.rpcResult = { error: { code: 'P0001' } };
        await expect(adminAdjustUserReputation(5, 70, 100, 'r')).rejects.toThrow('Failed to adjust reputation');
    });

    it('reputation history: newest-first, admin narrowed to a mini user (no discord id / notes)', async () => {
        queue('reputation_history', {
            data: [{
                id: 1, user_id: 5, admin_user_id: 100, change_date: 'D', old_reputation: 50, new_reputation: 70, reason: 'r',
                adminUser: { id: 100, name: 'Boss', avatar_url: 'https://cdn.example.com/b.png', discord_id: '999', admin_notes: 'secret' },
            }],
        });
        const [entry] = await getReputationHistoryForUser(5);
        expect(entry).toMatchObject({ id: 1, userId: 5, adminUserId: 100, changeDate: 'D', oldReputation: 50, newReputation: 70, reason: 'r' });
        expect(entry.adminUser).toMatchObject({ id: 100, name: 'Boss' });
        expect(JSON.stringify(entry)).not.toContain('secret');
        expect(JSON.stringify(entry)).not.toContain('999');
        const q = on('reputation_history')[0];
        expect(sel(q)).toBe('id, user_id, admin_user_id, change_date, old_reputation, new_reputation, reason, adminUser:users!reputation_history_admin_user_id_fkey(id, name, avatar_url)');
        expect(chainOf(q).slice(1)).toEqual([['eq', 'user_id', 5], ['order', 'change_date', { ascending: false }]]);
        queue('reputation_history', { error: { code: 'X' } }, { data: null });
        await expect(getReputationHistoryForUser(5)).rejects.toThrow('Failed to get reputation history');
        expect(await getReputationHistoryForUser(5)).toEqual([]);
    });

    it('rating history: responder participation → rated requests, mapped', async () => {
        queue('request_responders', { data: [{ request_id: 10 }, { request_id: 11 }] });
        queue('service_requests', { data: [
            { id: 10, service_type: 'Medical', client_rating: 5, updated_at: 'U1', client: { rsi_handle: 'Cli' } },
            { id: 11, service_type: 'Escort', client_rating: 3, updated_at: 'U2', client: null },
        ] });
        expect(await getRatingHistoryForUser(5)).toEqual([
            { requestId: 10, serviceType: 'Medical', clientRating: 5, date: 'U1', clientRsiHandle: 'Cli', rating: 5 },
            { requestId: 11, serviceType: 'Escort', clientRating: 3, date: 'U2', clientRsiHandle: 'Unknown', rating: 3 },
        ]);
        expect(chainOf(on('request_responders')[0])).toEqual([['select', 'request_id'], ['eq', 'user_id', 5]]);
        expect(chainOf(on('service_requests')[0])).toEqual([
            ['select', 'id, service_type, client_rating, updated_at, client:users!service_requests_client_id_fkey(rsi_handle)'],
            ['in', 'id', [10, 11]], ['eq', 'rated', true], ['not', 'client_rating', 'is', null], ['order', 'updated_at', { ascending: false }],
        ]);
    });

    it('rating history: no participation → [] with no second read; each fault is opaque', async () => {
        queue('request_responders', { data: [] });
        expect(await getRatingHistoryForUser(5)).toEqual([]);
        expect(on('service_requests')).toHaveLength(0);
        queue('request_responders', { error: { code: 'X', message: 'relation "request_responders" column y' } });
        await expect(getRatingHistoryForUser(5)).rejects.toThrow(/^Failed to get rating history$/);
        queue('request_responders', { data: [{ request_id: 1 }] });
        queue('service_requests', { error: { code: 'X' } });
        await expect(getRatingHistoryForUser(5)).rejects.toThrow('Failed to get rating history');
        queue('request_responders', { data: [{ request_id: 1 }] });
        queue('service_requests', { data: null });
        expect(await getRatingHistoryForUser(5)).toEqual([]);
    });
});

describe('promoteUserToMember — Discord sync side effect', () => {
    it('writes the Member role and pushes the role delta to Discord', async () => {
        queue('users', { data: { role_id: 1 } }, {});
        await promoteUserToMember(5);
        expect(chainOf(on('users')[0])).toEqual([['select', 'role_id'], ['eq', 'id', 5], ['maybeSingle']]);
        expect(chainOf(on('users')[1])).toEqual([['update', { role_id: 2 }], ['eq', 'id', 5]]);
        expect(h.pushDiscordRoles).toHaveBeenCalledWith(5, { oldRoleId: 1, newRoleId: 2 });
    });

    it('unknown user or unresolved Member role → throws before any write', async () => {
        queue('users', { data: null });
        await expect(promoteUserToMember(5)).rejects.toThrow('User not found in this organization');
        sb.systemRoles = { client: ROLES.client };
        queue('users', { data: { role_id: 1 } });
        await expect(promoteUserToMember(5)).rejects.toThrow('Cannot promote user: Member role not found');
        expect(on('users').some((q) => q.op === 'update')).toBe(false);
        expect(sb.broadcasts).toEqual([]);
        expect(h.pushDiscordRoles).not.toHaveBeenCalled();
    });

    it('an existing Member is not pushed again; a push rejection is logged only', async () => {
        queue('users', { data: { role_id: 2 } }, {});
        await promoteUserToMember(5);
        expect(h.pushDiscordRoles).not.toHaveBeenCalled();
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { userId: 5 } }]);

        const boom = new Error('discord');
        h.pushDiscordRoles.mockRejectedValue(boom);
        queue('users', { data: { role_id: null } }, {});
        await promoteUserToMember(6);
        await flush();
        expect(h.pushDiscordRoles).toHaveBeenCalledWith(6, { oldRoleId: null, newRoleId: 2 });
        expect(h.log.error).toHaveBeenCalledWith('discord background push failed', { userId: 6, err: boom });
    });
});

describe('syncUserRoles — Discord → platform, never a downgrade, never onto Client/Admin', () => {
    const discordUser = { id: '123456789', username: 'jenko', global_name: 'Jenko G', avatar: 'abc', discriminator: '0' };
    const MAPPINGS = [
        { discord_role_id: 'r-rank', rank_id: 7, role_id: null },
        { discord_role_id: 'r-disp', rank_id: null, role_id: 3 },
        { discord_role_id: 'r-admin', rank_id: null, role_id: 4 },
        { discord_role_id: 'r-client', rank_id: null, role_id: 1 },
        { discord_role_id: 'r-custom', rank_id: null, role_id: 10 },
    ];
    const setup = (roleId: number | null, memberRoles: unknown, over: Record<string, unknown> = {}) => {
        queue('users', { data: { discord_id: '123456789', role_id: roleId, discord_synced_at: null, ...over } }, {});
        queue('rank_mappings', { data: MAPPINGS });
        h.getDiscordMember.mockResolvedValue({ roles: memberRoles, nick: null, user: discordUser });
        h.buildGlobalAvatarUrl.mockReturnValue('https://cdn.discordapp.com/avatars/123456789/abc.png');
    };
    const written = () => argsOf(on('users').find((q) => q.op === 'update'), 'update')![0] as Record<string, unknown>;

    it('Client: rank applied, promoted to the mapped Dispatcher role; Admin/Client mappings ignored even when held first', async () => {
        setup(1, ['r-admin', 'r-client', 'r-rank', 'r-disp']);
        expect(await syncUserRoles(5)).toBe(SYNC_OK);
        expect(chainOf(on('users')[0])).toEqual([['select', 'discord_id, role_id, discord_synced_at'], ['eq', 'id', 5], ['single']]);
        expect(chainOf(on('rank_mappings')[0])).toEqual([['select', 'discord_role_id, rank_id, role_id']]);
        expect(h.getDiscordMember).toHaveBeenCalledWith('123456789');
        expect(written()).toEqual({
            rank_id: 7, role_id: 3, name: 'Jenko G', avatar_url: 'https://cdn.discordapp.com/avatars/123456789/abc.png', discord_synced_at: ISO,
        });
        expect(h.buildGlobalAvatarUrl).toHaveBeenCalledWith(discordUser);
        expect(h.log.warn).toHaveBeenCalledWith('sync ignoring unmappable discord role mappings', { count: 2, rolesResolved: true });
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { userId: 5 } }]);
        expect(chainOf(on('user_presence')[0])).toEqual([['update', { avatar_refreshed_at: ISO }], ['eq', 'user_id', 5]]);
    });

    it('unresolvable system roles apply NO role mapping at all (fail closed)', async () => {
        sb.systemRoles = {};
        setup(1, ['r-disp', 'r-rank']);
        await syncUserRoles(5);
        expect(written()).not.toHaveProperty('role_id');
        expect(written().rank_id).toBe(7);
        expect(h.log.warn).toHaveBeenCalledWith('sync ignoring unmappable discord role mappings', { count: 4, rolesResolved: false });
    });

    it('a Member is promoted on a strict tier upgrade', async () => {
        setup(2, ['r-disp']);
        await syncUserRoles(5);
        expect(written().role_id).toBe(3);
        expect(h.log.info).toHaveBeenCalledWith('sync promoting user tier', { userId: 5, fromTier: 2, toTier: 3, roleId: 3 });
    });

    it('a Dispatcher mapped to a Member-tier custom role is NOT downgraded', async () => {
        setup(3, ['r-custom']);
        await syncUserRoles(5);
        expect(written()).not.toHaveProperty('role_id');
        expect(h.log.info).toHaveBeenCalledWith('sync preserving role, skipping discord override', { userId: 5, currentTier: 3, mappedTier: 2 });
    });

    it('an Admin mapped to Dispatcher keeps Admin (tier 4 is never downgraded)', async () => {
        setup(4, ['r-disp']);
        await syncUserRoles(5);
        expect(written()).not.toHaveProperty('role_id');
        expect(h.log.info).toHaveBeenCalledWith('sync preserving role, skipping discord override', { userId: 5, currentTier: 4, mappedTier: 3 });
    });

    it('no mapping rows at all (null) → identity refresh only', async () => {
        queue('users', { data: { discord_id: '1', role_id: 1, discord_synced_at: null } }, {});
        queue('rank_mappings', { data: null });
        h.getDiscordMember.mockResolvedValue({ roles: ['r-disp'], nick: null });
        expect(await syncUserRoles(5)).toBe(SYNC_OK);
        expect(written()).toEqual({ discord_synced_at: ISO });
        expect(h.log.warn).not.toHaveBeenCalled();
    });

    it('a custom-role holder (Member tier) can be promoted to Dispatcher', async () => {
        setup(10, ['r-disp']);
        await syncUserRoles(5);
        expect(written().role_id).toBe(3);
    });

    it('a user with no role row gets no role from a mapping', async () => {
        setup(null, ['r-disp']);
        await syncUserRoles(5);
        expect(written()).not.toHaveProperty('role_id');
    });

    it('rank-only mapping auto-promotes a Client to Member, and nobody else', async () => {
        setup(1, ['r-rank']);
        await syncUserRoles(5);
        expect(written()).toMatchObject({ rank_id: 7, role_id: 2 });
        expect(h.log.info).toHaveBeenCalledWith('sync auto-promoting user from client to member', { userId: 5, roleId: 2 });

        sb.queries = [];
        setup(3, ['r-rank']);
        await syncUserRoles(5);
        expect(written()).not.toHaveProperty('role_id');

        sb.queries = [];
        sb.systemRoles = { client: ROLES.client, admin: ROLES.admin };
        setup(1, ['r-rank']);
        await syncUserRoles(5);
        expect(written()).not.toHaveProperty('role_id');

        sb.queries = [];
        setup(null, ['r-rank']);
        await syncUserRoles(5);
        expect(written()).not.toHaveProperty('role_id');
    });

    it('name precedence: nick > global name > username; no Discord user → no identity write, no presence stamp', async () => {
        setup(2, []);
        h.getDiscordMember.mockResolvedValue({ roles: [], nick: 'Nicky', user: discordUser });
        await syncUserRoles(5);
        expect(written().name).toBe('Nicky');

        sb.queries = [];
        setup(2, []);
        h.getDiscordMember.mockResolvedValue({ roles: [], nick: null, user: { ...discordUser, global_name: null } });
        await syncUserRoles(5);
        expect(written().name).toBe('jenko');

        sb.queries = [];
        sb.broadcasts = [];
        setup(2, 'not-an-array');
        h.getDiscordMember.mockResolvedValue({ roles: 'not-an-array', nick: null });
        await syncUserRoles(5);
        expect(written()).toEqual({ discord_synced_at: ISO });
        expect(on('user_presence')).toHaveLength(0);
        // The stamp alone is still a write, so the receiver is still told.
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { userId: 5 } }]);
    });

    it('cooldown: a recent sync short-circuits before Discord unless bypassed', async () => {
        queue('users', { data: { discord_id: '1', role_id: 2, discord_synced_at: new Date(NOW - 10 * MIN).toISOString() } });
        expect(await syncUserRoles(5)).toBe('SYNC_COOLDOWN:50');
        expect(h.getDiscordMember).not.toHaveBeenCalled();

        setup(2, [], { discord_synced_at: new Date(NOW - 10 * MIN).toISOString() });
        expect(await syncUserRoles(5, { bypassCooldown: true })).toBe(SYNC_OK);

        setup(2, [], { discord_synced_at: new Date(NOW - 2 * HOUR).toISOString() });
        expect(await syncUserRoles(5)).toBe(SYNC_OK);
    });

    it('not in the guild → message, no write; suppressBroadcast silences the per-user frame', async () => {
        queue('users', { data: { discord_id: '1', role_id: 2, discord_synced_at: null } });
        h.getDiscordMember.mockResolvedValue(null);
        expect(await syncUserRoles(5)).toBe('User not in Discord server');
        expect(on('users').some((q) => q.op === 'update')).toBe(false);

        setup(2, []);
        expect(await syncUserRoles(5, { suppressBroadcast: true })).toBe(SYNC_OK);
        expect(sb.broadcasts).toEqual([]);
    });

    it('each read / write fault throws; a failed write emits nothing', async () => {
        queue('users', { error: { code: 'X' } });
        await expect(syncUserRoles(5)).rejects.toThrow('Failed to fetch user for sync');
        queue('users', { data: null });
        await expect(syncUserRoles(5)).rejects.toThrow('User not found');

        queue('users', { data: { discord_id: '1', role_id: 2, discord_synced_at: null } });
        h.getDiscordMember.mockResolvedValue({ roles: [] });
        queue('rank_mappings', { error: { code: 'X' } });
        await expect(syncUserRoles(5)).rejects.toThrow('Failed to fetch rank mappings');

        queue('users', { data: { discord_id: '1', role_id: 2, discord_synced_at: null } }, { error: { code: 'X' } });
        queue('rank_mappings', { data: [] });
        await expect(syncUserRoles(5)).rejects.toThrow('Failed to update synced user');
        expect(sb.broadcasts).toEqual([]);
    });
});

describe('syncAllMemberRoles — one aggregate frame, 15-minute bulk cooldown', () => {
    // bulkSyncTimestamps is module state, so every test runs an hour after the last.
    let clock = NOW;
    const advance = () => { clock += HOUR; vi.setSystemTime(clock); };

    it('syncs every live user, collecting only the ids that reached the write', async () => {
        advance();
        sb.handler = (q) => {
            if (q.table === 'users' && sel(q) === 'id') return { data: [{ id: 1 }, { id: 2 }, { id: 3 }] };
            if (q.table === 'users' && sel(q) === 'discord_id, role_id, discord_synced_at') {
                const id = eqVal(q, 'id') as number;
                return id === 3 ? { error: { code: 'X' } } : { data: { discord_id: `D${id}`, role_id: 2, discord_synced_at: null } };
            }
            if (q.table === 'rank_mappings') return { data: [] };
            return undefined;
        };
        h.getDiscordMember.mockImplementation(async (d: string) => (d === 'D2' ? null : { roles: [] }));
        await syncAllMemberRoles();
        expect(chainOf(on('users')[0])).toEqual([['select', 'id'], ['is', 'deleted_at', null]]);
        expect(h.log.error).toHaveBeenCalledWith('sync user failed', expect.objectContaining({ userId: 3 }));
        // Exactly ONE frame — no per-user user_update.
        expect(sb.broadcasts).toEqual([{ event: 'user_update', payload: { bulk: true, count: 1, userIds: [1] } }]);
    });

    it('refuses a second bulk run inside 15 minutes', async () => {
        advance();
        queue('users', { data: [] });
        await syncAllMemberRoles();
        vi.setSystemTime(clock + 5 * MIN);
        await expect(syncAllMemberRoles()).rejects.toThrow('BULK_SYNC_COOLDOWN:10');
    });

    it('a run where nothing synced emits nothing; a fetch fault logs and returns', async () => {
        advance();
        queue('users', { data: [{ id: 1 }] }, { data: { discord_id: 'D1', role_id: 2, discord_synced_at: null } });
        h.getDiscordMember.mockResolvedValue(null);
        await syncAllMemberRoles();
        expect(sb.broadcasts).toEqual([]);

        advance();
        const err = { code: 'X' };
        queue('users', { error: err });
        await expect(syncAllMemberRoles()).resolves.toBeUndefined();
        expect(h.log.error).toHaveBeenCalledWith('fetch users for sync failed', { err });
        expect(sb.broadcasts).toEqual([]);

        advance();
        queue('users', { data: null });
        await syncAllMemberRoles();
        expect(sb.broadcasts).toEqual([]);
    });
});

describe('savePushSubscription — narrowed, allow-listed, capped', () => {
    const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
    const keys = { p256dh: 'BPk', auth: 'aut' };

    it.each([
        ['an internal host', 'https://10.0.0.5/push'],
        ['plain http', 'http://fcm.googleapis.com/x'],
        ['a lookalike host', 'https://evilgoogleapis.com/x'],
        ['a non-URL', 'not a url'],
        ['nothing', undefined],
    ])('rejects %s as the endpoint (stored blind-SSRF)', async (_l, endpoint) => {
        await expect(savePushSubscription(5, { endpoint: endpoint as string, keys })).rejects.toThrow('Invalid push subscription endpoint.');
        expect(sb.queries).toEqual([]);
    });

    it.each([
        [{ p256dh: '', auth: 'a' }], [{ p256dh: 'p', auth: '' }], [{ p256dh: 1, auth: 'a' }], [undefined],
    ])('rejects missing / non-string keys (%j)', async (k) => {
        await expect(savePushSubscription(5, { endpoint: ENDPOINT, keys: k as typeof keys })).rejects.toThrow('Invalid push subscription keys.');
        expect(sb.queries).toEqual([]);
    });

    it('stores exactly what web-push needs — never the caller object (no smuggled user record)', async () => {
        queue('push_subscriptions', {}, { data: [] }, {});
        const sub = {
            endpoint: ENDPOINT, keys: { ...keys, extra: 'x' }, expirationTime: 1_700_000_000_000,
            user: { id: 5, adminNotes: 'secret', permissions: ['admin:access'] },
        };
        await savePushSubscription(5, sub as unknown as Parameters<typeof savePushSubscription>[1]);
        const [dedupe, list, insert] = on('push_subscriptions');
        expect(chainOf(dedupe)).toEqual([['delete'], ['eq', 'endpoint', ENDPOINT]]);
        expect(chainOf(list)).toEqual([['select', 'id, created_at'], ['eq', 'user_id', 5], ['order', 'created_at', { ascending: true }]]);
        expect(chainOf(insert)).toEqual([['insert', {
            user_id: 5, endpoint: ENDPOINT, p256dh: 'BPk', auth: 'aut',
            subscription: { endpoint: ENDPOINT, keys: { p256dh: 'BPk', auth: 'aut' }, expirationTime: 1_700_000_000_000 },
        }]]);
        expect(JSON.stringify(argsOf(insert, 'insert'))).not.toContain('secret');
    });

    it('expirationTime: null is kept; a non-finite or non-number value is dropped', async () => {
        for (const expirationTime of [null, Number.NaN, Number.POSITIVE_INFINITY, '123']) {
            sb.queries = [];
            queue('push_subscriptions', {}, { data: [] }, {});
            await savePushSubscription(5, { endpoint: ENDPOINT, keys, expirationTime: expirationTime as number | null });
            const stored = (argsOf(on('push_subscriptions')[2], 'insert')![0] as { subscription: Record<string, unknown> }).subscription;
            if (expirationTime === null) expect(stored).toHaveProperty('expirationTime', null);
            else expect(stored).not.toHaveProperty('expirationTime');
        }
    });

    it('at the 20-per-user cap evicts the oldest so the new one fits; below the cap evicts nothing', async () => {
        const existing = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 100 + i, created_at: `C${i}` }));
        queue('push_subscriptions', {}, { data: existing(22) }, {}, {});
        await savePushSubscription(5, { endpoint: ENDPOINT, keys });
        const qs = on('push_subscriptions');
        expect(qs.map((q) => q.op)).toEqual(['delete', 'select', 'delete', 'insert']);
        expect(chainOf(qs[2])).toEqual([['delete'], ['in', 'id', [100, 101, 102]]]);

        sb.queries = [];
        queue('push_subscriptions', {}, { data: existing(19) }, {});
        await savePushSubscription(5, { endpoint: ENDPOINT, keys });
        expect(on('push_subscriptions').map((q) => q.op)).toEqual(['delete', 'select', 'insert']);
    });

    it('an insert fault throws', async () => {
        queue('push_subscriptions', {}, { data: null }, { error: { code: 'X' } });
        await expect(savePushSubscription(5, { endpoint: ENDPOINT, keys })).rejects.toThrow('Failed to save push subscription');
    });
});

describe('deleteOwnPushSubscription — logout, caller-pinned, never logs the endpoint', () => {
    const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/capability-token-xyz';

    it('deletes only the caller\'s row for that endpoint', async () => {
        await deleteOwnPushSubscription(5, ENDPOINT);
        expect(chainOf(on('push_subscriptions')[0])).toEqual([['delete'], ['eq', 'user_id', 5], ['eq', 'endpoint', ENDPOINT]]);
    });

    it.each([
        [0, ENDPOINT], [1.5, ENDPOINT], [5, 42], [5, ''], [5, `https://x/${'a'.repeat(2048)}`],
    ])('ignores an invalid user (%s) or endpoint without querying', async (uid, ep) => {
        await expect(deleteOwnPushSubscription(uid as number, ep)).resolves.toBeUndefined();
        expect(sb.queries).toEqual([]);
    });

    it('best-effort: a fault or a throw is logged WITHOUT the endpoint, never rethrown', async () => {
        queue('push_subscriptions', { error: { code: '57014', message: 'timeout' } });
        await expect(deleteOwnPushSubscription(5, ENDPOINT)).resolves.toBeUndefined();
        expect(h.log.error).toHaveBeenCalledWith('failed to drop push subscription on logout', { userId: 5, code: '57014', message: 'timeout' });

        const boom = new Error('driver');
        sb.handler = () => { throw boom; };
        await expect(deleteOwnPushSubscription(5, ENDPOINT)).resolves.toBeUndefined();
        expect(h.log.error).toHaveBeenCalledWith('failed to drop push subscription on logout', { userId: 5, err: boom });
        expect(JSON.stringify(h.log.error.mock.calls)).not.toContain('capability-token-xyz');
    });
});
