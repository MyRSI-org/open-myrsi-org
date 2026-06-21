import { describe, it, expect, vi, beforeEach } from 'vitest';

// admin:update_user is gated on the WEAKER admin:user:update perm, so it must
// never write clearance. Clearance is writable ONLY via admin:update_user_clearance
// (gated on admin:user:manage_clearance + audit-logged). The handler strips
// clearanceLevelId from the generic profile-edit payload before calling
// db.updateUser — defense-in-depth on top of the db-layer assertCanGrantClearance
// clamp (pinned separately in userClearanceGrantClamp.test.ts).

const cap = vi.hoisted(() => ({ updateUser: null as null | { targetUserId: number; updates: Record<string, unknown>; actor: unknown } }));

vi.mock('../lib/db', () => ({
    updateUser: (targetUserId: number, updates: Record<string, unknown>, actor: unknown) => {
        cap.updateUser = { targetUserId, updates, actor };
        return Promise.resolve({ id: targetUserId });
    },
}));
// Passthrough stripActorFields — the clearanceLevelId strip happens BEFORE it, so
// a passthrough is enough to observe the handler's own filtering.
vi.mock('../api/services', () => ({ stripActorFields: (x: Record<string, unknown>) => x }));
vi.mock('../lib/discord', () => ({}));
vi.mock('../lib/db/system', () => ({ MAX_IMPORT_BATCH_SIZE: 100 }));
vi.mock('../api/public', () => ({ invalidatePublicCache: () => {} }));

import { adminActions } from '../api/actions/admin';

beforeEach(() => { cap.updateUser = null; });

describe('admin:update_user — clearance mass-assignment strip', () => {
    it('removes clearanceLevelId before calling db.updateUser, keeps benign fields', async () => {
        await (adminActions as Record<string, (p: unknown) => unknown>)['admin:update_user']({
            targetUserId: 7,
            user: { id: 2, role: 'Member', permissions: ['admin:user:update'] },
            name: 'Renamed',
            clearanceLevelId: 5,
        });

        expect(cap.updateUser).not.toBeNull();
        expect(cap.updateUser!.targetUserId).toBe(7);
        // The privileged column never reaches the generic update path.
        expect('clearanceLevelId' in cap.updateUser!.updates).toBe(false);
        // Benign profile fields still flow through.
        expect(cap.updateUser!.updates.name).toBe('Renamed');
    });
});
