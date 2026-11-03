import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// =============================================================================
// api/actions/user.ts — handler-level behaviour suite (coverage phase 3,
// unit actions-core). Self-service actions: every one acts on the
// dispatcher-forced `userId`, so the contract pinned here is "the db layer is
// called for the CALLER, with exactly these args, and nothing else from the
// payload rides along" — plus the in-handler gates (position-history HR gate,
// restricted-unit access, the unit-leader cosmetic allow-list) and the
// submission throttle, which runs for real (spied, not replaced).
// =============================================================================

const h = vi.hoisted(() => ({
    db: {
        revokeUserSessions: vi.fn(),
        deleteOwnPushSubscription: vi.fn(),
        toggleUserDutyStatus: vi.fn(),
        updateUserHeartbeat: vi.fn(),
        initiateRsiHandleUpdate: vi.fn(),
        verifyRsiUpdate: vi.fn(),
        cancelRsiUpdate: vi.fn(),
        syncUserRoles: vi.fn(),
        updateUserSpecializations: vi.fn(),
        updateUserDisplayName: vi.fn(),
        updateUserPreferences: vi.fn(),
        getClearanceHistory: vi.fn(),
        getUserPositionHistory: vi.fn(),
        updateUser: vi.fn(),
        deleteUser: vi.fn(),
        savePushSubscription: vi.fn(),
        applyForJob: vi.fn(),
        createHRApplication: vi.fn(),
        assertUnitAccess: vi.fn(),
        getUnitFeed: vi.fn(),
        createUnitPost: vi.fn(),
        deleteUnitPost: vi.fn(),
        updateUnit: vi.fn(),
    } as Record<string, Mock<(...args: any[]) => any>>,
    sendPushToUsers: vi.fn(),
}));

vi.mock('../lib/db', () => ({ ...h.db }));
vi.mock('../lib/push', () => ({ sendPushToUsers: h.sendPushToUsers }));
vi.mock('../lib/submissionRateLimit', async (importOriginal) => {
    const real = await importOriginal<typeof import('../lib/submissionRateLimit')>();
    return { ...real, assertSubmissionRateLimit: vi.fn(real.assertSubmissionRateLimit) };
});

import { userActions } from '../api/actions/user';
import { assertSubmissionRateLimit, _resetSubmissionRateLimit } from '../lib/submissionRateLimit';

type AnyHandler = (p: any) => any;
const act = (name: string) => (userActions as unknown as Record<string, AnyHandler>)[name];
const throttle = assertSubmissionRateLimit as unknown as Mock<(...args: any[]) => any>;

// The dispatcher injects the caller's full record; handlers must never forward it.
const INJECTED_USER = { id: 7, permissions: ['user:view:roster'], discordId: 'd-7', adminNotes: 'secret' };

beforeEach(() => {
    for (const fn of Object.values(h.db)) fn.mockReset();
    h.sendPushToUsers.mockReset();
    h.sendPushToUsers.mockResolvedValue(undefined);
    throttle.mockClear();
    _resetSubmissionRateLimit();
});

// ---------------------------------------------------------------------------
describe('user:logout', () => {
    it('drops THIS browser\'s push row for the caller first, then revokes the caller\'s sessions', async () => {
        h.db.revokeUserSessions.mockResolvedValue({ success: true });
        const out = await act('user:logout')({ userId: 7, pushEndpoint: 'https://push.example/ep-1', user: INJECTED_USER });
        expect(out).toEqual({ success: true });
        expect(h.db.deleteOwnPushSubscription).toHaveBeenCalledWith(7, 'https://push.example/ep-1');
        expect(h.db.revokeUserSessions).toHaveBeenCalledWith(7);
        expect(h.db.deleteOwnPushSubscription.mock.invocationCallOrder[0]).toBeLessThan(h.db.revokeUserSessions.mock.invocationCallOrder[0]);
    });

    it.each([['absent', undefined], ['empty', ''], ['non-string', { endpoint: 'x' }]])('skips the push cleanup for an %s endpoint but still revokes', async (_l, pushEndpoint) => {
        await act('user:logout')({ userId: 7, pushEndpoint });
        expect(h.db.deleteOwnPushSubscription).not.toHaveBeenCalled();
        expect(h.db.revokeUserSessions).toHaveBeenCalledWith(7);
    });
});

// ---------------------------------------------------------------------------
describe('self-scoped passthroughs act on the caller only, with exact args', () => {
    it.each([
        ['user:toggle_duty', { userId: 7, targetUserId: 99 }, 'toggleUserDutyStatus', [7]],
        ['user:heartbeat', { userId: 7 }, 'updateUserHeartbeat', [7]],
        ['user:initiate_rsi_update', { userId: 7, newHandle: 'New_Handle' }, 'initiateRsiHandleUpdate', [7, 'New_Handle']],
        ['user:verify_rsi_update', { userId: 7 }, 'verifyRsiUpdate', [7]],
        ['user:cancel_rsi_update', { userId: 7 }, 'cancelRsiUpdate', [7]],
        // No options object: the self path keeps the db layer's sync cooldown (only the
        // admin path passes bypassCooldown).
        ['user:sync_roles', { userId: 7, bypassCooldown: true }, 'syncUserRoles', [7]],
        ['user:update_specializations', { userId: 7, specializationIds: [1, 2] }, 'updateUserSpecializations', [7, [1, 2]]],
        ['user:update_display_name', { userId: 7, displayName: 'Ace' }, 'updateUserDisplayName', [7, 'Ace']],
        ['user:update_display_name', { userId: 7, displayName: null }, 'updateUserDisplayName', [7, null]],
        ['user:get_clearance_history', { userId: 7, targetUserId: 99 }, 'getClearanceHistory', [7]],
        ['user:set_radio_channel', { userId: 7, channelName: 'Squad-2' }, 'updateUser', [7, { voiceChannelName: 'Squad-2' }]],
        ['user:delete_self', { userId: 7, targetUserId: 99 }, 'deleteUser', [7]],
    ])('%s → db.%s', async (action, payload, dbFn, args) => {
        h.db[dbFn].mockResolvedValue({ marker: dbFn });
        const out = await act(action)({ ...payload, user: INJECTED_USER });
        expect(out).toEqual({ marker: dbFn });
        expect(h.db[dbFn]).toHaveBeenCalledTimes(1);
        expect(h.db[dbFn].mock.calls[0]).toEqual(args);
    });

    it('user:update_preferences forwards ONLY timezone + dateFormat (no other payload key, no injected user)', async () => {
        await act('user:update_preferences')({ userId: 7, timezone: 'Australia/Brisbane', dateFormat: 'iso_24h', role_id: 4, user: INJECTED_USER });
        expect(h.db.updateUserPreferences).toHaveBeenCalledWith(7, { timezone: 'Australia/Brisbane', dateFormat: 'iso_24h' });
    });

    it('user:update_preferences passes explicit undefineds so the db layer can tell "absent"', async () => {
        await act('user:update_preferences')({ userId: 7 });
        expect(h.db.updateUserPreferences.mock.calls[0]).toEqual([7, { timezone: undefined, dateFormat: undefined }]);
    });
});

// ---------------------------------------------------------------------------
describe('user:get_position_history — HR gate on cross-user reads', () => {
    it('self-fetch (no target) needs no permission', async () => {
        h.db.getUserPositionHistory.mockResolvedValue([{ positionName: 'Pilot' }]);
        await expect(act('user:get_position_history')({ userId: 7, user: { permissions: [] } })).resolves.toEqual([{ positionName: 'Pilot' }]);
        expect(h.db.getUserPositionHistory).toHaveBeenCalledWith(7);
    });

    it('an explicit target equal to the caller is still self', async () => {
        await act('user:get_position_history')({ userId: 7, targetUserId: 7 });
        expect(h.db.getUserPositionHistory).toHaveBeenCalledWith(7);
    });

    it('refuses another member\'s history to a rank-and-file caller holding only hr:view (seeded Member perm)', () => {
        expect(() => act('user:get_position_history')({ userId: 7, targetUserId: 8, user: { permissions: ['hr:view', 'user:view:roster'] } }))
            .toThrow('Not authorized to view this user’s position history.');
        expect(h.db.getUserPositionHistory).not.toHaveBeenCalled();
    });

    it('refuses a cross-user read when the caller record carries no permissions at all', () => {
        expect(() => act('user:get_position_history')({ userId: 7, targetUserId: 8 })).toThrow('Not authorized to view this user’s position history.');
        expect(() => act('user:get_position_history')({ userId: 7, targetUserId: 8, user: {} })).toThrow('Not authorized');
        expect(h.db.getUserPositionHistory).not.toHaveBeenCalled();
    });

    it.each(['admin:view:roster', 'admin:user:update', 'hr:recruiter', 'hr:manager', 'hr:admin'])('allows a cross-user read for %s', async (perm) => {
        await act('user:get_position_history')({ userId: 7, targetUserId: 8, user: { permissions: [perm] } });
        expect(h.db.getUserPositionHistory).toHaveBeenCalledWith(8);
    });
});

// ---------------------------------------------------------------------------
describe('push actions', () => {
    it('user:subscribe_push stores ONLY the subscription fields — never the injected user record', async () => {
        const keys = { p256dh: 'p-key', auth: 'a-key' };
        await act('user:subscribe_push')({ userId: 7, endpoint: 'https://push.example/ep', keys, expirationTime: null, user: INJECTED_USER, extra: 'x' });
        expect(h.db.savePushSubscription).toHaveBeenCalledTimes(1);
        const [uid, sub] = h.db.savePushSubscription.mock.calls[0];
        expect(uid).toBe(7);
        expect(sub).toEqual({ endpoint: 'https://push.example/ep', keys, expirationTime: null });
        expect(Object.keys(sub).sort()).toEqual(['endpoint', 'expirationTime', 'keys']);
    });

    it('user:test_push sends a fixed test notification to the caller alone', async () => {
        await expect(act('user:test_push')({ userId: 7, targetUserId: 99 })).resolves.toEqual({ success: true });
        expect(h.sendPushToUsers).toHaveBeenCalledWith([7], {
            title: 'Signal Test',
            body: 'Comms Uplink Verified. You are receiving secure alerts.',
            tag: 'system-test',
        });
    });

    it('user:test_push surfaces a push failure rather than claiming success', async () => {
        h.sendPushToUsers.mockRejectedValue(new Error('VAPID not configured'));
        await expect(act('user:test_push')({ userId: 7 })).rejects.toThrow('VAPID not configured');
    });
});

// ---------------------------------------------------------------------------
describe('HR self-service submissions are throttled per caller before the write', () => {
    it.each([
        ['user:apply_job', 'applyForJob', { jobId: 'job-1', statement: 'hire me' }],
        ['user:submit_application', 'createHRApplication', { rsiHandle: 'Cmdr_Handle', notes: 'hi' }],
    ])('%s throttles on the caller id, then hands the payload to db.%s', (action, dbFn, extra) => {
        h.db[dbFn].mockReturnValue('written');
        const payload = { userId: 21, ...extra };
        expect(act(action)(payload)).toBe('written');
        expect(throttle).toHaveBeenCalledWith(21);
        expect(h.db[dbFn]).toHaveBeenCalledWith(payload);
        expect(throttle.mock.invocationCallOrder[0]).toBeLessThan(h.db[dbFn].mock.invocationCallOrder[0]);
    });

    it.each([
        ['user:apply_job', 'applyForJob'],
        ['user:submit_application', 'createHRApplication'],
    ])('%s: the 6th submission inside a minute is refused by the real limiter and never written', (action, dbFn) => {
        for (let i = 0; i < 5; i++) act(action)({ userId: 22 });
        expect(h.db[dbFn]).toHaveBeenCalledTimes(5);
        let err: (Error & { code?: string }) | undefined;
        try { act(action)({ userId: 22 }); } catch (e) { err = e as Error & { code?: string }; }
        expect(err?.message).toMatch(/^Too many submissions \(per minute\)\. Try again in \d+s\.$/);
        expect(err?.code).toBe('SUBMISSION_RATE_LIMITED');
        expect(h.db[dbFn]).toHaveBeenCalledTimes(5);
    });

    it('the two submission actions share one per-user budget, and another user is unaffected', () => {
        for (let i = 0; i < 3; i++) act('user:apply_job')({ userId: 23 });
        for (let i = 0; i < 2; i++) act('user:submit_application')({ userId: 23 });
        expect(() => act('user:apply_job')({ userId: 23 })).toThrow(/Too many submissions/);
        expect(() => act('user:apply_job')({ userId: 24 })).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
describe('unit feed + posts — restricted-unit access is asserted first', () => {
    it('unit:get_feed asserts access for the caller, then reads the feed', async () => {
        h.db.getUnitFeed.mockResolvedValue([{ id: 'p1' }]);
        await expect(act('unit:get_feed')({ unitId: 3, userId: 7 })).resolves.toEqual([{ id: 'p1' }]);
        expect(h.db.assertUnitAccess).toHaveBeenCalledWith(3, 7);
        expect(h.db.getUnitFeed).toHaveBeenCalledWith(3);
    });

    it('unit:get_feed never reads a restricted feed the caller cannot access', async () => {
        h.db.assertUnitAccess.mockRejectedValue(new Error('This unit is restricted.'));
        await expect(act('unit:get_feed')({ unitId: 3, userId: 7 })).rejects.toThrow('This unit is restricted.');
        expect(h.db.getUnitFeed).not.toHaveBeenCalled();
    });

    it('unit:create_post asserts access, then writes as the caller', async () => {
        h.db.createUnitPost.mockResolvedValue({ id: 'p2' });
        await expect(act('unit:create_post')({ unitId: 3, userId: 7, content: 'o7' })).resolves.toEqual({ id: 'p2' });
        expect(h.db.assertUnitAccess).toHaveBeenCalledWith(3, 7);
        expect(h.db.createUnitPost).toHaveBeenCalledWith(3, 7, 'o7');
    });

    it('unit:create_post writes nothing into a unit the caller cannot access', async () => {
        h.db.assertUnitAccess.mockRejectedValue(new Error('This unit is restricted.'));
        await expect(act('unit:create_post')({ unitId: 3, userId: 7, content: 'o7' })).rejects.toThrow('This unit is restricted.');
        expect(h.db.createUnitPost).not.toHaveBeenCalled();
    });

    it('unit:delete_post gates the claimed unit, then deletes with the caller id + SERVER-injected permissions', async () => {
        h.db.deleteUnitPost.mockResolvedValue({ success: true });
        await act('unit:delete_post')({ postId: 'p9', unitId: 3, userId: 7, user: { id: 7, permissions: ['unit:manage:own'] } });
        expect(h.db.assertUnitAccess).toHaveBeenCalledWith(3, 7);
        expect(h.db.deleteUnitPost).toHaveBeenCalledWith('p9', { id: 7, permissions: ['unit:manage:own'] });
    });

    it('unit:delete_post refuses before deleting when the claimed unit is inaccessible', async () => {
        h.db.assertUnitAccess.mockRejectedValue(new Error('This unit is restricted.'));
        await expect(act('unit:delete_post')({ postId: 'p9', unitId: 3, userId: 7 })).rejects.toThrow('This unit is restricted.');
        expect(h.db.deleteUnitPost).not.toHaveBeenCalled();
    });

    it('unit:delete_post from a legacy caller without unitId skips only the claimed-unit gate', async () => {
        await act('unit:delete_post')({ postId: 'p9', userId: 7 });
        expect(h.db.assertUnitAccess).not.toHaveBeenCalled();
        expect(h.db.deleteUnitPost).toHaveBeenCalledWith('p9', { id: 7, permissions: undefined });
    });
});

// ---------------------------------------------------------------------------
describe('unit:update_details — unit-leader path is restricted to cosmetic fields', () => {
    it('forwards every cosmetic field and drops the structural ones (leader / parent / restricted)', () => {
        act('unit:update_details')({
            unitId: 5,
            updates: {
                name: 'Alpha', sortOrder: 2, motto: 'Ad astra', description: 'desc', logoUrl: 'https://img/l.png',
                hasRadioChannel: true, linkedChannelId: '123',
                leaderId: 99, parentUnitId: 1, isRestricted: false,
            },
        });
        expect(h.db.updateUnit).toHaveBeenCalledWith({
            id: 5, name: 'Alpha', sortOrder: 2, motto: 'Ad astra', description: 'desc', logoUrl: 'https://img/l.png',
            hasRadioChannel: true, linkedChannelId: '123',
        });
    });

    it('a structural-only payload writes nothing but the id', () => {
        act('unit:update_details')({ unitId: 5, updates: { leaderId: 99, parentUnitId: 1, isRestricted: true } });
        expect(h.db.updateUnit).toHaveBeenCalledWith({ id: 5 });
    });

    it('a missing updates object is treated as empty', () => {
        act('unit:update_details')({ unitId: 5 });
        expect(h.db.updateUnit).toHaveBeenCalledWith({ id: 5 });
    });

    it.each([
        ['name', 'N'], ['sortOrder', 0], ['motto', null], ['description', ''], ['logoUrl', null], ['hasRadioChannel', false], ['linkedChannelId', null],
    ])('forwards %s on its own (falsy values included)', (field, value) => {
        act('unit:update_details')({ unitId: 5, updates: { [field]: value } });
        expect(h.db.updateUnit).toHaveBeenCalledWith({ id: 5, [field]: value });
    });

    it('returns the db result', async () => {
        h.db.updateUnit.mockResolvedValue({ id: 5, name: 'Alpha' });
        await expect(act('unit:update_details')({ unitId: 5, updates: { name: 'Alpha' } })).resolves.toEqual({ id: 5, name: 'Alpha' });
    });
});
