import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// =============================================================================
// api/actions/notifications.ts — handler-level behaviour suite (coverage
// phase 3, unit actions-core). Every action is scoped to the dispatcher-forced
// `userId`; the notification ids are TARGET ids handed to the db layer, which
// owns the per-row BOLA check. Pinned: exact db args, input normalisation, the
// returned envelope, and that a db-layer denial (foreign id) propagates rather
// than being reported as success.
// =============================================================================

const h = vi.hoisted(() => ({
    db: {
        markNotificationsRead: vi.fn(),
        markAllNotificationsRead: vi.fn(),
        deleteNotification: vi.fn(),
    } as Record<string, Mock<(...args: any[]) => any>>,
}));
vi.mock('../lib/db', () => ({ ...h.db }));

import { notificationActions } from '../api/actions/notifications';
import { SecurityDenial } from '../lib/errors';

type AnyHandler = (p: any) => Promise<any>;
const act = (name: string) => (notificationActions as unknown as Record<string, AnyHandler>)[name];

beforeEach(() => {
    for (const fn of Object.values(h.db)) fn.mockReset();
});

describe('notifications:mark_read', () => {
    it('marks the given ids for the caller and reports how many changed', async () => {
        h.db.markNotificationsRead.mockResolvedValue(2);
        await expect(act('notifications:mark_read')({ userId: 7, notificationIds: [11, 12] })).resolves.toEqual({ success: true, updated: 2 });
        expect(h.db.markNotificationsRead).toHaveBeenCalledWith(7, [11, 12]);
    });

    it.each([['absent', undefined], ['a single id', 11], ['a string', '11,12'], ['an object', { 0: 11 }]])('normalises a non-array id list (%s) to empty', async (_l, notificationIds) => {
        h.db.markNotificationsRead.mockResolvedValue(0);
        await expect(act('notifications:mark_read')({ userId: 7, notificationIds })).resolves.toEqual({ success: true, updated: 0 });
        expect(h.db.markNotificationsRead).toHaveBeenCalledWith(7, []);
    });

    it('a foreign id denial from the db layer propagates (never reported as success)', async () => {
        h.db.markNotificationsRead.mockRejectedValue(new SecurityDenial('Notification not found.', { auditEvent: 'authz.notification.denied' }));
        await expect(act('notifications:mark_read')({ userId: 7, notificationIds: [999] })).rejects.toThrow('Notification not found.');
    });
});

describe('notifications:mark_all_read', () => {
    it('marks the caller\'s whole inbox only', async () => {
        h.db.markAllNotificationsRead.mockResolvedValue(5);
        await expect(act('notifications:mark_all_read')({ userId: 7, targetUserId: 99 })).resolves.toEqual({ success: true, updated: 5 });
        expect(h.db.markAllNotificationsRead.mock.calls).toEqual([[7]]);
    });

    it('propagates a db failure', async () => {
        h.db.markAllNotificationsRead.mockRejectedValue(new Error('Failed to update notifications'));
        await expect(act('notifications:mark_all_read')({ userId: 7 })).rejects.toThrow('Failed to update notifications');
    });
});

describe('notifications:delete', () => {
    it('deletes one notification for the caller, coercing the id to a number', async () => {
        h.db.deleteNotification.mockResolvedValue(undefined);
        await expect(act('notifications:delete')({ userId: 7, notificationId: '42' })).resolves.toEqual({ success: true });
        expect(h.db.deleteNotification).toHaveBeenCalledWith(7, 42);
    });

    it('a missing id reaches the db layer as NaN (whose integer guard refuses it), never as another row', async () => {
        h.db.deleteNotification.mockRejectedValue(new Error('deleteNotification: valid notificationId is required'));
        await expect(act('notifications:delete')({ userId: 7 })).rejects.toThrow('deleteNotification: valid notificationId is required');
        expect(h.db.deleteNotification.mock.calls[0][0]).toBe(7);
        expect(Number.isNaN(h.db.deleteNotification.mock.calls[0][1])).toBe(true);
    });
});
