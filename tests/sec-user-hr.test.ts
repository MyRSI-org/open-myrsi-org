import { describe, it, expect, beforeEach, vi } from 'vitest';

// Security coverage for the user-hr cluster:
//   user:get_position_history must restrict cross-user reads to genuine HR /
//   roster-admin staff — NOT the rank-and-file 'hr:view' the seeded Member holds.
//   hr:request_transfer must throttle per-user and bound the free-text reason
//   (parity with the other member-initiated self-service writes).

const spies = vi.hoisted(() => ({
    getUserPositionHistory: vi.fn(),
    assertSubmissionRateLimit: vi.fn(),
    from: vi.fn(),
    insert: vi.fn(),
}));

vi.mock('../lib/submissionRateLimit', () => ({ assertSubmissionRateLimit: spies.assertSubmissionRateLimit }));
vi.mock('../lib/push', () => ({ sendPushToUsers: vi.fn() }));
vi.mock('../lib/db', () => ({
    getUserPositionHistory: spies.getUserPositionHistory,
    supabase: { from: spies.from },
}));
// NB: lib/textSanitize is intentionally NOT mocked — we exercise the real stripHtml.

import { userActions } from '../api/actions/user';
import { hrActions } from '../api/actions/hr';

type Handler = (p: unknown) => unknown;
const callUser = (name: string, p: unknown) => (userActions as Record<string, Handler>)[name](p);
const callHr = (name: string, p: unknown) => (hrActions as Record<string, Handler>)[name](p);

beforeEach(() => {
    spies.getUserPositionHistory.mockReset().mockResolvedValue([]);
    spies.assertSubmissionRateLimit.mockReset();
    spies.insert.mockReset().mockResolvedValue({ error: null });
    spies.from.mockReset().mockReturnValue({ insert: spies.insert });
});

describe('user:get_position_history is HR/roster-restricted for cross-user reads', () => {
    it('denies a rank-and-file member (hr:view only) reading another user and never queries the DB', () => {
        // The handler throws synchronously on the deny path, before touching the DB.
        expect(() =>
            callUser('user:get_position_history', {
                targetUserId: 42,
                userId: 7,
                user: { id: 7, permissions: ['user:manage:self', 'hr:view', 'user:view:roster'] },
            }),
        ).toThrow(/not authorized/i);
        expect(spies.getUserPositionHistory).not.toHaveBeenCalled();
    });

    it('allows a genuine HR recruiter to read another user', async () => {
        await callUser('user:get_position_history', {
            targetUserId: 42,
            userId: 7,
            user: { id: 7, permissions: ['user:manage:self', 'hr:recruiter'] },
        });
        expect(spies.getUserPositionHistory).toHaveBeenCalledWith(42);
    });

    it('allows a roster admin (admin:view:roster) to read another user', async () => {
        await callUser('user:get_position_history', {
            targetUserId: 42,
            userId: 7,
            user: { id: 7, permissions: ['admin:view:roster'] },
        });
        expect(spies.getUserPositionHistory).toHaveBeenCalledWith(42);
    });

    it('always allows self-fetch even with only hr:view', async () => {
        await callUser('user:get_position_history', {
            targetUserId: 7,
            userId: 7,
            user: { id: 7, permissions: ['hr:view'] },
        });
        expect(spies.getUserPositionHistory).toHaveBeenCalledWith(7);
    });
});

describe('hr:request_transfer throttles and bounds the reason', () => {
    it('consults the per-user throttle with the user id before writing', async () => {
        await callHr('hr:request_transfer', { userId: 9, targetUnitId: 1, currentUnitId: null, reason: 'x' });
        expect(spies.assertSubmissionRateLimit).toHaveBeenCalledWith(9);
        expect(spies.insert).toHaveBeenCalled();
    });

    it('a throttle rejection blocks the DB write (fails closed)', async () => {
        spies.assertSubmissionRateLimit.mockImplementation(() => { throw new Error('Too many submissions'); });
        await expect(
            callHr('hr:request_transfer', { userId: 9, targetUnitId: 1, currentUnitId: null, reason: 'x' }),
        ).rejects.toThrow(/too many/i);
        expect(spies.insert).not.toHaveBeenCalled();
    });

    it('rejects an over-long reason and never writes', async () => {
        await expect(
            callHr('hr:request_transfer', { userId: 9, targetUnitId: 1, currentUnitId: null, reason: 'x'.repeat(5001) }),
        ).rejects.toThrow(/too long/i);
        expect(spies.insert).not.toHaveBeenCalled();
    });

    it('strips HTML from the persisted reason (defense in depth)', async () => {
        await callHr('hr:request_transfer', {
            userId: 9, targetUnitId: 1, currentUnitId: null, reason: '<script>bad</script>ok',
        });
        expect(spies.insert).toHaveBeenCalledTimes(1);
        const row = spies.insert.mock.calls[0][0] as { reason: string };
        expect(row.reason).toBe('badok');
    });
});
