import { describe, it, expect } from 'vitest';
import { stripSensitiveUserFields } from '../lib/db/userFilters';
import type { User } from '../types';

// A member's full permission list and clearance are recon value for the rank-and-file
// (who's an admin / who can see classified). stripSensitiveUserFields keeps them for
// the member themselves and for viewers who actually use them (HR/clearance/warrant/
// dispatch/roster screens), and strips them for everyone else.

const target = (over: Partial<User> = {}): User => ({
    id: 42, name: 'Target', role: 'Member', isDuty: false,
    permissions: ['operations:create', 'intel:view'],
    clearanceLevel: { id: 2, name: 'Secret', level: 3 } as User['clearanceLevel'],
    createdAt: 'now',
    ...over,
} as User);

const viewer = (perms: string[], id = 7, role = 'Member') => ({ id, role, permissions: perms });

describe('roster permission/clearance minimization', () => {
    it('strips permissions[] + clearanceLevel for a rank-and-file member viewing another member', () => {
        const out = stripSensitiveUserFields(target(), viewer([]));
        expect(out.permissions).toEqual([]);
        expect(out.clearanceLevel).toBeUndefined();
    });

    it('strips for a Client-tier viewer', () => {
        const out = stripSensitiveUserFields(target(), viewer([], 9, 'Client'));
        expect(out.permissions).toEqual([]);
        expect(out.clearanceLevel).toBeUndefined();
    });

    it("keeps permissions[] + clearanceLevel for the viewer's OWN record (self)", () => {
        const out = stripSensitiveUserFields(target({ id: 7 }), viewer([], 7));
        expect(out.permissions).toEqual(['operations:create', 'intel:view']);
        expect(out.clearanceLevel).toBeTruthy();
    });

    it('keeps for an HR viewer (officer pickers filter members by hr:*)', () => {
        const out = stripSensitiveUserFields(target(), viewer(['hr:recruiter']));
        expect(out.permissions).toEqual(['operations:create', 'intel:view']);
        expect(out.clearanceLevel).toBeTruthy();
    });

    it('keeps for a clearance-management viewer (BulkAssignClearanceModal reads member clearance)', () => {
        const out = stripSensitiveUserFields(target(), viewer(['admin:user:manage_clearance']));
        expect(out.clearanceLevel).toBeTruthy();
        expect(out.permissions.length).toBeGreaterThan(0);
    });

    it('keeps for a dispatch viewer (member selection)', () => {
        const out = stripSensitiveUserFields(target(), viewer(['request:dispatch']));
        expect(out.permissions.length).toBeGreaterThan(0);
    });

    it('keeps everything for an Admin', () => {
        const out = stripSensitiveUserFields(target(), { id: 1, role: 'Admin', permissions: [] });
        expect(out.permissions).toEqual(['operations:create', 'intel:view']);
        expect(out.clearanceLevel).toBeTruthy();
    });

    it('strips for an unauthenticated viewer (defense-in-depth)', () => {
        const out = stripSensitiveUserFields(target(), null);
        expect(out.permissions).toEqual([]);
        expect(out.clearanceLevel).toBeUndefined();
    });
});
