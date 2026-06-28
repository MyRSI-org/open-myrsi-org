import { describe, it, expect } from 'vitest';
import { stripSensitiveUserFields } from '../lib/db/userFilters';
import type { User } from '../types';

// stripSensitiveUserFields used to short-circuit the entire granular PII ladder on
// `requester.role === 'Admin'`. That `role` value is the INFERRED UserRole tier from
// toUser (lib/db/mappers.ts), which collapses ANY role holding `admin:access` to
// UserRole.Admin. `admin:access` is merely the admin-dashboard gate perm (the seeded
// Dispatcher carries it too), so a scoped custom role granted `admin:access` arrived
// here with role === 'Admin' and received EVERY member's adminNotes / personnelNotes /
// conductRecord / clearanceLevel / limitingMarkers / discordId on the bulk roster.
//
// So the full-record bypass is withheld when the Admin tier is derived solely from
// `admin:access` (no apex-perm backing), falling through to the granular allow-list so
// the role only sees what its explicit perms grant — while genuine Admins (who hold the
// full permission set) and any non-forged Admin tier keep the unstripped view.
//
// A deeper root change — stop inferring UserRole.Admin from `admin:access` in toUser
// (mappers.ts) and in clearance.ts canViewAllClassifications — lives outside this file
// (userFilters.ts only), so toUser/clearance unit tests are not included here.

const sensitiveTarget = (over: Partial<User> = {}): User => ({
    id: 42,
    name: 'Target',
    discordId: '999000111',
    rsiHandle: 'TestPilot',
    role: 'Member',
    isDuty: false,
    adminNotes: 'flagged in review',
    personnelNotes: 'sealed personnel note',
    conductRecord: [{ id: 1 }],
    limitingMarkers: ['NOFORN'],
    clearanceLevel: { id: 2, name: 'Secret', level: 3 } as User['clearanceLevel'],
    permissions: ['operations:create', 'intel:view'],
    createdAt: 'now',
    ...over,
} as User);

const ALL_APEX = [
    'admin:access',
    'admin:user:update',
    'user:manage:personnel_notes',
    'user:manage:conduct_record',
    'admin:user:manage_clearance',
    'admin:view:roster',
];

describe('admin:access tier does NOT grant the Admin PII bypass', () => {
    // A forged Admin tier (role collapsed from admin:access) must not short-circuit
    // to the full record.
    it('strips all sensitive PII when the Admin tier is forged from admin:access only', () => {
        const forged = { id: 7, role: 'Admin', permissions: ['admin:access'] };
        const out = stripSensitiveUserFields(sensitiveTarget(), forged);
        expect(out.adminNotes).toBeUndefined();
        expect(out.personnelNotes).toBeUndefined();
        expect(out.conductRecord).toEqual([]);
        expect(out.limitingMarkers).toEqual([]);
        expect(out.discordId).toBe('');
        expect(out.permissions).toEqual([]);
        expect(out.clearanceLevel).toBeUndefined();
    });

    // Same outcome whichever string the inferred tier surfaces as (Dispatcher is the
    // tier admin:access maps to under the root mapper behaviour).
    it('strips all sensitive PII for an admin:access-only viewer surfaced as the Dispatcher tier', () => {
        const viewer = { id: 7, role: 'Dispatcher', permissions: ['admin:access'] };
        const out = stripSensitiveUserFields(sensitiveTarget(), viewer);
        expect(out.adminNotes).toBeUndefined();
        expect(out.personnelNotes).toBeUndefined();
        expect(out.conductRecord).toEqual([]);
        expect(out.limitingMarkers).toEqual([]);
        expect(out.discordId).toBe('');
        expect(out.permissions).toEqual([]);
        expect(out.clearanceLevel).toBeUndefined();
    });

    // A genuine Admin holds the full permission set — the full bypass is preserved.
    it('preserves the full unstripped record for a genuine apex Admin (all perms)', () => {
        const admin = { id: 1, role: 'Admin', permissions: ALL_APEX };
        const out = stripSensitiveUserFields(sensitiveTarget(), admin);
        expect(out.adminNotes).toBe('flagged in review');
        expect(out.personnelNotes).toBe('sealed personnel note');
        expect(out.conductRecord).toEqual([{ id: 1 }]);
        expect(out.limitingMarkers).toEqual(['NOFORN']);
        expect(out.discordId).toBe('999000111');
        expect(out.permissions).toEqual(['operations:create', 'intel:view']);
        expect(out.clearanceLevel).toBeTruthy();
    });

    // Legacy contract guard: an Admin tier with no admin:access signal (e.g. the
    // existing rosterCapabilityMinimization test's `{role:'Admin', permissions:[]}`)
    // is not treated as forged and keeps the full view.
    it('preserves the legacy Admin-tier bypass when admin:access is absent', () => {
        const out = stripSensitiveUserFields(sensitiveTarget(), { id: 1, role: 'Admin', permissions: [] });
        expect(out.adminNotes).toBe('flagged in review');
        expect(out.permissions).toEqual(['operations:create', 'intel:view']);
        expect(out.clearanceLevel).toBeTruthy();
    });

    // An admin:access role that ALSO holds explicit management perms still sees exactly
    // (and only) the fields those perms grant via the granular ladder.
    it('grants exactly the fields an admin:access role\'s explicit perms allow (no more)', () => {
        const viewer = { id: 7, role: 'Admin', permissions: ['admin:access', 'admin:user:update'] };
        const out = stripSensitiveUserFields(sensitiveTarget(), viewer);
        // admin:user:update grants adminNotes + roster capability (permissions/clearance)
        // + HR metadata, but NOT personnel notes / conduct / limiting markers / discordId.
        expect(out.adminNotes).toBe('flagged in review');
        expect(out.permissions).toEqual(['operations:create', 'intel:view']);
        expect(out.clearanceLevel).toBeTruthy();
        expect(out.personnelNotes).toBeUndefined();
        expect(out.conductRecord).toEqual([]);
        expect(out.limitingMarkers).toEqual([]);
        expect(out.discordId).toBe('');
    });

    // Self path is unaffected: a user still sees their own record (adminNotes blanked
    // for a non-management self, per existing UX intent).
    it('self still sees own personal data; admin:access alone does not unlock own adminNotes', () => {
        const out = stripSensitiveUserFields(sensitiveTarget({ id: 7 }), { id: 7, role: 'Admin', permissions: ['admin:access'] });
        expect(out.personnelNotes).toBe('sealed personnel note');
        expect(out.conductRecord).toEqual([{ id: 1 }]);
        expect(out.adminNotes).toBeUndefined();
    });
});
