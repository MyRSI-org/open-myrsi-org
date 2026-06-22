import { describe, it, expect, vi } from 'vitest';

// user:logout is a real server-side logout — it moves the caller's
// tokens_valid_from forward (revokeUserSessions) so a stolen token can't outlive the
// session. userId is set to the signed-in caller, so the handler only logs the
// caller out.

const spies = vi.hoisted(() => ({ revoke: vi.fn(async () => undefined) }));
vi.mock('../lib/db', () => ({ revokeUserSessions: spies.revoke }));
vi.mock('../lib/push', () => ({ sendPushToUsers: vi.fn(async () => undefined) }));

import { userActions } from '../api/actions/user';

const call = (action: string, p: unknown) =>
    (userActions as Record<string, (x: unknown) => Promise<unknown>>)[action](p);

describe('user:logout', () => {
    it('revokes the caller\'s own sessions via the injected userId', async () => {
        await call('user:logout', { userId: 7 });
        expect(spies.revoke).toHaveBeenCalledWith(7);
        expect(spies.revoke).toHaveBeenCalledTimes(1);
    });
});
