import { describe, it, expect } from 'vitest';
import { minifyUser, blankSensitiveUserFields } from '../lib/db/mappers';
import { UserRole, type User } from '../types';

// minifyUser / blankSensitiveUserFields project an already-mapped User down to a
// safe-to-embed shape. createOperation returns the op owner through minifyUser,
// so this guards against the owner-spoof PII leak (and any other embed of a
// hydrated User) regardless of how the source SELECT was widened.
function fullUser(): User {
    return {
        id: 42, name: 'Cmdr', avatarUrl: 'a.png', discordId: '101953620311810048',
        rsiHandle: 'Cmdr', roleId: 1, role: UserRole.Admin, reputation: 10, isDuty: true,
        permissions: ['admin:access', 'operations:manage'],
        createdAt: 't0',
        adminNotes: 'secret admin note', personnelNotes: 'secret hr note',
        clearanceLevel: { id: 5, level: 5, name: 'TS' } as unknown as User['clearanceLevel'],
        limitingMarkers: [{ id: 1, name: 'NOFORN', code: 'NF' }] as unknown as User['limitingMarkers'],
        conductRecord: [{ id: 'c1', type: 'warning', reason: 'x', enteredBy: { id: 1, name: 'A' }, createdAt: 't' }] as unknown as User['conductRecord'],
        rsiHandlePending: 'PendingHandle',
        rsiVerificationCode: 'VERIFY-1234',
    } as User;
}

describe('blankSensitiveUserFields / minifyUser', () => {
    it('blanks every private/security field but keeps public identity', () => {
        const u = blankSensitiveUserFields(fullUser());
        // public identity preserved
        expect(u.name).toBe('Cmdr');
        expect(u.avatarUrl).toBe('a.png');
        expect(u.role).toBe(UserRole.Admin);
        // sensitive fields blanked
        expect(u.discordId).toBe('');
        expect(u.permissions).toEqual([]);
        expect(u.adminNotes).toBeUndefined();
        expect(u.personnelNotes).toBeUndefined();
        expect(u.clearanceLevel).toBeUndefined();
        expect(u.limitingMarkers).toEqual([]);
        expect(u.conductRecord).toEqual([]);
        expect(u.rsiHandlePending).toBeUndefined();
        expect(u.rsiVerificationCode).toBeUndefined();
    });

    it('the serialized projection contains no secret values', () => {
        const blob = JSON.stringify(minifyUser(fullUser()));
        expect(blob).not.toContain('secret admin note');
        expect(blob).not.toContain('secret hr note');
        expect(blob).not.toContain('VERIFY-1234');
        expect(blob).not.toContain('PendingHandle');
        expect(blob).not.toContain('101953620311810048');
        expect(blob).not.toContain('admin:access');
    });

    it('passes through nullish', () => {
        expect(minifyUser(undefined)).toBeUndefined();
        expect(minifyUser(null)).toBeUndefined();
    });
});

// =============================================================================
// PHASE 3 ITEM 4 — the nine formerly-diverging fields, and the anti-drift pin
// =============================================================================
//
// A10 — the CORRECT reason this was ever safe. An earlier note claimed the minifier's
// divergence "is not a live leak only because no embed selects those columns". That is
// incomplete: minifyUser has one NON-embed input in the tree that a per-embed sweep does
// not cover — lib/db/ops.ts does `owner = await getUserById(ownerId)` and then
// `owner: minifyUser(owner)`, and getUserById returns a full USER_SELECT_QUERY record
// carrying real values in all nine fields. It is safe for a DIFFERENT reason:
// lib/db/ops.ts reads `opData.userId || opData.ownerId`, and `userId` is in
// ACTOR_ID_FIELDS (api/services.ts), so the dispatcher force-overwrites it with the
// authenticated actor and the record is ALWAYS self.
//
// These nine are safe today only because blankSensitiveUserFields became an ALLOW-LIST
// rebuild in wave 1. Nothing pinned that it stays one — until now.

/** A full getUserById-shaped User, not an embed-shaped one: lib/db/ops.ts feeds exactly
 *  this shape into the minifier (TG4(b)). Every optional field carries a sentinel. */
function fullSelfShapedUser(): User {
    return {
        ...fullUser(),
        rsiVerified: false,
        jobTitle: 'SECRET-JOB',
        voiceChannelName: 'SECRET-VOICE',
        timezone: 'SECRET-TZ',
        dateFormat: 'SECRET-DF',
        probationStart: 'SECRET-PS',
        probationEnd: 'SECRET-PE',
        tenureStartDate: 'SECRET-TENURE',
        tokensValidFrom: 'SECRET-TVF',
    } as unknown as User;
}

describe('blankSensitiveUserFields — the nine formerly-diverging fields', () => {
    it('21. every one of the nine reads undefined after the projection, and none survives serialization', () => {
        const full = fullSelfShapedUser();
        const out = blankSensitiveUserFields(full) as unknown as Record<string, unknown>;
        for (const k of ['rsiVerified', 'jobTitle', 'voiceChannelName', 'timezone', 'dateFormat',
            'probationStart', 'probationEnd', 'tenureStartDate', 'tokensValidFrom']) {
            expect(out[k], `${k} survived the projection`).toBeUndefined();
        }
        const blob = JSON.stringify(minifyUser(full));
        for (const sentinel of ['SECRET-JOB', 'SECRET-VOICE', 'SECRET-TZ', 'SECRET-DF',
            'SECRET-PS', 'SECRET-PE', 'SECRET-TENURE', 'SECRET-TVF']) {
            expect(blob, `${sentinel} leaked through minifyUser`).not.toContain(sentinel);
        }
    });

    it('22. the embed boundary and the roster boundary cannot drift apart', async () => {
        // Both now share buildRosterSafeUser. The viewer id MUST differ from the target's
        // (TG4(a)) or stripSensitiveUserFields takes its isSelf short-circuit, which
        // returns `{...base}` — the SOURCE key set — and the comparison would assert
        // nothing meaningful. A zero-permission viewer so no capability restore fires.
        const { stripSensitiveUserFields } = await import('../lib/db/userFilters');
        const full = fullSelfShapedUser();
        const zeroPermViewer = { id: full.id + 1, role: UserRole.Member, isSystemAdmin: false, permissions: [] };
        expect(Object.keys(blankSensitiveUserFields(full)).sort())
            .toEqual(Object.keys(stripSensitiveUserFields(full, zeroPermViewer as never)).sort());
    });
});
