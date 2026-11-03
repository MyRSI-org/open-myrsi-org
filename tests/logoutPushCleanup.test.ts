import { describe, it, expect, vi, beforeEach } from 'vitest';

// Handler-level pins for the two push actions.
//
// user:logout used to move tokens_valid_from and nothing else, so the browser's push row
// survived the logout and the next person on a shared browser kept receiving the previous
// member's EAM directives, finance memos and personal notifications. It now drops the row
// for the endpoint the browser sends — pinned to the dispatcher-forced caller.
//
// user:subscribe_push used to hand the WHOLE dispatcher payload to savePushSubscription,
// including payload.user (the caller's full user record, injected by the dispatcher), and
// every push_subscriptions row stored a copy of it.

const h = vi.hoisted(() => ({
    calls: [] as string[],
    revoke: vi.fn(async (_userId: number) => undefined as void),
    deletePush: vi.fn(async (_userId: number, _endpoint: unknown) => undefined as void),
    savePush: vi.fn(async (_userId: number, _sub: unknown) => undefined as void),
}));
vi.mock('../lib/db', () => ({
    revokeUserSessions: h.revoke,
    deleteOwnPushSubscription: h.deletePush,
    savePushSubscription: h.savePush,
}));
vi.mock('../lib/push', () => ({ sendPushToUsers: vi.fn(async () => undefined) }));

import { userActions } from '../api/actions/user';

const call = (action: string, p: unknown) =>
    (userActions as Record<string, (x: unknown) => Promise<unknown>>)[action](p);

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-token-1';

beforeEach(() => {
    h.calls = [];
    h.revoke.mockReset();
    h.revoke.mockImplementation(async () => { h.calls.push('revoke'); });
    h.deletePush.mockReset();
    h.deletePush.mockImplementation(async () => { h.calls.push('deletePush'); });
    h.savePush.mockReset();
});

describe('user:logout — drops this browser\'s push subscription', () => {
    it('deletes the caller\'s row for the supplied endpoint, then revokes the sessions', async () => {
        await call('user:logout', { userId: 7, pushEndpoint: ENDPOINT });
        expect(h.deletePush).toHaveBeenCalledTimes(1);
        expect(h.deletePush).toHaveBeenCalledWith(7, ENDPOINT);
        expect(h.revoke).toHaveBeenCalledWith(7);
        expect(h.calls).toEqual(['deletePush', 'revoke']);
    });

    it('tolerates a missing endpoint: no delete, the logout still revokes', async () => {
        await call('user:logout', { userId: 7 });
        expect(h.deletePush).not.toHaveBeenCalled();
        expect(h.revoke).toHaveBeenCalledWith(7);
    });

    it.each([
        ['an empty string', ''],
        ['a number', 12345],
        ['an object', { endpoint: ENDPOINT }],
        ['an array', [ENDPOINT]],
        ['null', null],
    ])('ignores %s as the endpoint', async (_label, pushEndpoint) => {
        await call('user:logout', { userId: 7, pushEndpoint });
        expect(h.deletePush).not.toHaveBeenCalled();
        expect(h.revoke).toHaveBeenCalledWith(7);
    });

    // Cleanup runs first, so a revoke fault cannot skip it.
    it('still drops the push row when the revoke throws', async () => {
        h.revoke.mockImplementation(async () => { throw new Error('Failed to revoke user sessions'); });
        await expect(call('user:logout', { userId: 7, pushEndpoint: ENDPOINT })).rejects.toThrow(/revoke/);
        expect(h.deletePush).toHaveBeenCalledWith(7, ENDPOINT);
    });
});

describe('user:subscribe_push — stores the subscription, never the payload', () => {
    it('passes only endpoint/keys/expirationTime, with no injected user record', async () => {
        const keys = { p256dh: 'BPk', auth: 'aGVsbG8' };
        await call('user:subscribe_push', {
            userId: 3,
            endpoint: ENDPOINT,
            keys,
            expirationTime: null,
            // What the dispatcher injects, and what a crafted body might add.
            user: { id: 3, discordId: '123', permissions: ['admin:access'], adminNotes: 'secret' },
            somethingElse: 'x',
        });
        expect(h.savePush).toHaveBeenCalledTimes(1);
        const [userId, sub] = h.savePush.mock.calls[0];
        expect(userId).toBe(3);
        expect(Object.keys(sub as object).sort()).toEqual(['endpoint', 'expirationTime', 'keys']);
        expect(sub).not.toHaveProperty('user');
        expect(sub).not.toHaveProperty('userId');
        expect(sub).toEqual({ endpoint: ENDPOINT, keys, expirationTime: null });
    });
});
