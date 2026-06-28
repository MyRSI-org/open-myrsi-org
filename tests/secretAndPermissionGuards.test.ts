import { describe, it, expect } from 'vitest';
import { signAdminSetupGrant, verifyAdminSetupGrant, verifyToken, signToken } from '../lib/auth';
import { filterByClearance, passesClearance } from '../lib/clearance';
import { stripSensitiveUserFields } from '../lib/db/userFilters';
import { encryptSecret, decryptSecret } from '../lib/crypto';
import { actions, fullPermissionMap } from '../api/services';
import type { User } from '../types';

// Regression guards for data-exposure protections. These cover the pure,
// server-side decision logic behind the highest-impact cases.

// --- unauthenticated Admin takeover via finalize_setup ---------------------
describe('admin-setup grant', () => {
    it('round-trips a grant bound to the discord id', () => {
        const token = signAdminSetupGrant('discord-123');
        expect(verifyAdminSetupGrant(token)).toEqual({ discordId: 'discord-123' });
    });

    it('rejects a missing / malformed / tampered grant', () => {
        expect(verifyAdminSetupGrant(undefined)).toBeNull();
        expect(verifyAdminSetupGrant('')).toBeNull();
        expect(verifyAdminSetupGrant('not-a-token')).toBeNull();
        const token = signAdminSetupGrant('discord-123');
        const [body] = token.split('.');
        expect(verifyAdminSetupGrant(`${body}.deadbeef`)).toBeNull();
    });

    it('a session token is NOT accepted as an admin-setup grant (and vice versa)', () => {
        const session = signToken({ userId: 1 });
        expect(verifyAdminSetupGrant(session)).toBeNull();
        // A grant carries purpose:'admin_setup' so it must not pass as a session.
        const grant = signAdminSetupGrant('discord-123');
        expect(verifyToken(grant)).toBeNull();
    });
});

// --- server-side clearance / limiting-marker filtering ---------------------
describe('clearance filter', () => {
    const item = (classificationLevel: number, limitingMarkers: unknown[] = []) => ({ classificationLevel, limitingMarkers });

    it('drops items above the viewer clearance level', () => {
        const viewer = { clearanceLevel: { level: 1 }, limitingMarkers: [], permissions: ['intel:view'], role: 'Member' };
        const out = filterByClearance([item(0), item(1), item(2), item(3)], viewer);
        expect(out.map((i) => i.classificationLevel)).toEqual([0, 1]);
    });

    it('drops items carrying a marker the viewer does not hold (string-keyed)', () => {
        const viewer = { clearanceLevel: { level: 5 }, limitingMarkers: ['NOFORN'], permissions: [], role: 'Member' };
        const out = filterByClearance([item(0, []), item(0, ['NOFORN']), item(0, ['EYES-ONLY'])], viewer);
        expect(out).toHaveLength(2); // the EYES-ONLY item is filtered out
        expect(passesClearance(viewer, 0, ['EYES-ONLY'])).toBe(false);
        expect(passesClearance(viewer, 0, ['NOFORN'])).toBe(true);
    });

    it('enforces compartmentation with OBJECT-shaped markers (the real runtime shape) — holding one marker must NOT grant others', () => {
        // Markers are the embedded security_limiting_markers row on BOTH sides
        // (marker:security_limiting_markers(*)). A naive String(m) comparison
        // collapses every object to '[object Object]' and over-grants — the
        // comparison must be id-keyed instead.
        const noforn = { id: 1, code: 'NOFORN', name: 'No Foreign' };
        const eyesOnly = { id: 2, code: 'EYES-ONLY', name: 'Eyes Only' };
        const viewer = { clearanceLevel: { level: 5 }, limitingMarkers: [noforn], permissions: [], role: 'Member' };
        // Holds NOFORN only:
        expect(passesClearance(viewer, 0, [noforn])).toBe(true);
        expect(passesClearance(viewer, 0, [eyesOnly])).toBe(false); // must be denied — different compartment
        expect(passesClearance(viewer, 0, [noforn, eyesOnly])).toBe(false); // needs BOTH
        const out = filterByClearance([item(0, []), item(0, [noforn]), item(0, [eyesOnly])], viewer);
        expect(out).toHaveLength(2);
    });

    it('Admin and bypass-permission holders see every classification', () => {
        const admin = { clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: [], role: 'Admin' };
        const manager = { clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: ['intel:manage'], role: 'Member' };
        const items = [item(0), item(3, ['NOFORN'])];
        expect(filterByClearance(items, admin, ['intel:manage'])).toHaveLength(2);
        expect(filterByClearance(items, manager, ['intel:manage'])).toHaveLength(2);
    });

    it('a null/clearance-less viewer only sees unclassified, unmarked items', () => {
        expect(passesClearance(null, 0, [])).toBe(true);
        expect(passesClearance(null, 1, [])).toBe(false);
        expect(passesClearance(undefined, 0, ['X'])).toBe(false);
    });
});

// --- per-user PII stripping ------------------------------------------------
describe('stripSensitiveUserFields', () => {
    const base = {
        id: 7,
        discordId: '999000111',
        rsiHandle: 'TestPilot',
        adminNotes: 'flagged',
        personnelNotes: 'note',
        conductRecord: [{ id: 1 }],
        limitingMarkers: ['NOFORN'],
        rsiHandlePending: 'NewHandle',
        rsiVerificationCode: 'ORG-ABC123',
        role: 'Member',
        permissions: [],
    } as unknown as User;

    it('strips Discord ID + RSI verification material from OTHER members for a rank-and-file viewer', () => {
        const viewer = { id: 42, role: 'Member', permissions: [] };
        const out = stripSensitiveUserFields(base, viewer);
        expect(out.discordId).toBe('');
        expect(out.rsiVerificationCode).toBeUndefined();
        expect(out.rsiHandlePending).toBeUndefined();
        expect(out.adminNotes).toBeUndefined();
        expect(out.personnelNotes).toBeUndefined();
        expect(out.conductRecord).toEqual([]);
        expect(out.limitingMarkers).toEqual([]);
    });

    it('preserves self personal data but still blanks self adminNotes (non-admin) and never exposes own verification code to others', () => {
        const self = { id: 7, role: 'Member', permissions: [] };
        const out = stripSensitiveUserFields(base, self);
        // Self keeps their personal tabs + their own pending verification code.
        expect(out.personnelNotes).toBe('note');
        expect(out.conductRecord).toEqual([{ id: 1 }]);
        expect(out.limitingMarkers).toEqual(['NOFORN']);
        expect(out.rsiVerificationCode).toBe('ORG-ABC123');
        expect(out.discordId).toBe('999000111');
        // adminNotes are admin-only by UX intent — blanked for a non-admin self.
        expect(out.adminNotes).toBeUndefined();
    });

    it('roster/Discord admins retain other members\' Discord IDs (management need)', () => {
        const rosterAdmin = { id: 42, role: 'Dispatcher', permissions: ['admin:view:roster'] };
        const out = stripSensitiveUserFields(base, rosterAdmin);
        expect(out.discordId).toBe('999000111');
        // ...but still never another member's one-time RSI verification code.
        expect(out.rsiVerificationCode).toBeUndefined();
    });

    it('an unauthenticated/unresolved viewer gets everything sensitive stripped', () => {
        const out = stripSensitiveUserFields(base, null);
        expect(out.discordId).toBe('');
        expect(out.adminNotes).toBeUndefined();
        expect(out.rsiVerificationCode).toBeUndefined();
        expect(out.conductRecord).toEqual([]);
    });

    it('drops HR/session metadata for a non-self viewer via the allow-list', () => {
        const rich = {
            ...base,
            jobTitle: 'Quartermaster',
            rsiVerified: true,
            voiceChannelName: 'Ops-1',
            probationStart: '2026-01-01',
            probationEnd: '2026-02-01',
            tenureStartDate: '2025-01-01',
            tokensValidFrom: '2026-06-01',
            auth_user_id: 'auth-uuid-xyz',
            // A field nobody allow-listed must not pass through either.
            someFutureSecret: 'leak-me',
        } as unknown as User;
        const out = stripSensitiveUserFields(rich, { id: 42, role: 'Member', permissions: [] }) as unknown as Record<string, unknown>;
        for (const f of ['jobTitle', 'rsiVerified', 'voiceChannelName', 'probationStart', 'probationEnd', 'tenureStartDate', 'tokensValidFrom', 'auth_user_id', 'someFutureSecret']) {
            expect(out[f], `${f} must not leak to a non-self viewer`).toBeUndefined();
        }
        // ...while the ordinary roster display fields still come through.
        expect(out.id).toBe(7);
        expect(out.rsiHandle).toBe('TestPilot');
    });

    it('lets a member see their OWN HR/session metadata (self path unchanged)', () => {
        const rich = { ...base, jobTitle: 'Quartermaster', rsiVerified: true, tenureStartDate: '2025-01-01' } as unknown as User;
        const out = stripSensitiveUserFields(rich, { id: 7, role: 'Member', permissions: [] }) as unknown as Record<string, unknown>;
        expect(out.jobTitle).toBe('Quartermaster');
        expect(out.rsiVerified).toBe(true);
        expect(out.tenureStartDate).toBe('2025-01-01');
    });

    it('restores HR personnel metadata for an HR-capable (non-Admin) viewer like a Dispatcher', () => {
        const rich = {
            ...base, jobTitle: 'Quartermaster', rsiVerified: true,
            probationStart: '2026-01-01', probationEnd: '2026-02-01', tenureStartDate: '2025-01-01',
        } as unknown as User;
        // Dispatcher-shaped HR viewer (role is not Admin, but holds hr:view).
        const hrViewer = { id: 42, role: 'Dispatcher', permissions: ['hr:view', 'hr:recruiter'] };
        const out = stripSensitiveUserFields(rich, hrViewer) as unknown as Record<string, unknown>;
        expect(out.probationEnd).toBe('2026-02-01');   // the Probation tab depends on this
        expect(out.tenureStartDate).toBe('2025-01-01');
        expect(out.jobTitle).toBe('Quartermaster');
        expect(out.rsiVerified).toBe(true);

        // ...but a rank-and-file member — INCLUDING one holding the seeded-default
        // hr:view (which must NOT confer case-file/personnel PII) — does NOT see them.
        const rankFile = stripSensitiveUserFields(rich, { id: 42, role: 'Member', permissions: ['hr:view'] }) as unknown as Record<string, unknown>;
        expect(rankFile.probationEnd).toBeUndefined();
        expect(rankFile.probationStart).toBeUndefined();
        expect(rankFile.tenureStartDate).toBeUndefined();
        expect(rankFile.jobTitle).toBeUndefined();
        expect(rankFile.rsiVerified).toBeUndefined();
    });
});

// --- secret encryption fails CLOSED -----------------------------------------
// The vitest env does NOT set SECRETS_ENCRYPTION_KEY (tests/setup.ts), so the
// encrypt path must refuse rather than silently store plaintext.
describe('encryptSecret fail-closed', () => {
    it('throws when no encryption key is configured (never returns plaintext)', () => {
        expect(() => encryptSecret('super-secret-bot-token')).toThrow(/SECRETS_ENCRYPTION_KEY/);
    });
    it('still treats empty input as a no-op (nothing to protect)', () => {
        expect(encryptSecret('')).toBe('');
    });
    it('decrypt still passes plaintext through (read path unaffected)', () => {
        expect(decryptSecret('not-encrypted')).toBe('not-encrypted');
    });
});

// --- dead, weakly-gated action removed --------------------------------------
describe('dead system:global_search action removed', () => {
    it('is absent from both the action registry and the permission map', () => {
        expect('system:global_search' in actions).toBe(false);
        expect('system:global_search' in fullPermissionMap).toBe(false);
    });
});

// --- permission gate values (drift guard) -----------------------------------
// permissionMapCoverage asserts an entry EXISTS; these pin the VALUE so a
// silent downgrade (e.g. back to a weaker permission) fails CI.
describe('permission gate values', () => {
    it('intel:generate_summary is gated at intel:manage (writes the manager-only AI cache)', () => {
        expect(fullPermissionMap['intel:generate_summary']).toBe('intel:manage');
    });
});
