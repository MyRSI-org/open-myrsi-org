import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { stripSensitiveUserFields, CLEARANCE_VISIBLE_PERMS } from '../lib/db/userFilters';
import { MEMBER_DEFAULT_PERMS, DISPATCHER_DEFAULT_PERMS } from '../lib/roleDefaultPermissions';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';
import type { User } from '../types';
import { stripComments } from './stripComments';

// A member's permission array and clearance level are recon value for the rank-and-file
// (who's an admin / who can see classified). stripSensitiveUserFields draws two
// different boundaries around them:
//
//   permissions[]  → SELF ONLY. No permission buys another member's array. There used
//                    to be a ROSTER_CAPABILITY_PERMS list that restored it, and it
//                    contained 'warrant:view' — a MEMBER_DEFAULT_PERMS entry — so every
//                    seeded member read every other member's complete permission array
//                    (including the Admin's) off the auth-only `main` subset. The only
//                    two client consumers were the HR interviewer/case-officer pickers,
//                    which now read role-level eligibility from the hr:get_eligible_*
//                    RPCs (lib/db/hr.ts) and never see a permission string.
//   clearanceLevel → self, the apex Admin, or a holder of CLEARANCE_VISIBLE_PERMS —
//                    a set pinned DISJOINT from the Member and Client seeds below, so
//                    a future widening that re-universalises it fails here.
//
// Intended, and NOT a regression to "fix": an ordinary Member now sees a blank Security
// Clearance card on another member's service record (MyServiceRecordView). Restoring it
// by adding a Member default to CLEARANCE_VISIBLE_PERMS reopens the leak.

const target = (over: Partial<User> = {}): User => ({
    id: 42, name: 'Target', role: 'Member', isDuty: false,
    permissions: ['operations:create', 'intel:view'],
    clearanceLevel: { id: 2, name: 'Secret', level: 3 } as User['clearanceLevel'],
    createdAt: 'now',
    ...over,
} as User);

const viewer = (perms: string[], id = 7, role = 'Member') => ({ id, role, permissions: perms });

// APEX_ADMIN_PERMS from lib/db/userFilters.ts — the full-record bypass needs role
// IDENTITY *and* this set, so a hand-pruned Admin role still falls to the ladder.
const APEX = [
    'admin:user:update', 'user:manage:personnel_notes', 'user:manage:conduct_record',
    'admin:user:manage_clearance', 'admin:view:roster',
];

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

    // The HR pickers no longer filter the roster by another member's permissions —
    // they call hr:get_eligible_interviewers / hr:get_eligible_officers, which resolve
    // eligibility at the ROLE level server-side. So an HR viewer keeps clearance (they
    // render it on the case file) and is denied the permission array like everyone else.
    it('an HR viewer keeps clearanceLevel but is still denied permissions[]', () => {
        const out = stripSensitiveUserFields(target(), viewer(['hr:recruiter']));
        expect(out.permissions).toEqual([]);
        expect(out.clearanceLevel).toBeTruthy();
    });

    it('a clearance-management viewer keeps clearanceLevel (BulkAssignClearanceModal L-badge) but not permissions[]', () => {
        const out = stripSensitiveUserFields(target(), viewer(['admin:user:manage_clearance']));
        expect(out.clearanceLevel).toBeTruthy();
        expect(out.permissions).toEqual([]);
    });

    it('a dispatch viewer keeps clearanceLevel (the rap sheet) but not permissions[]', () => {
        const out = stripSensitiveUserFields(target(), viewer(['request:dispatch']));
        expect(out.permissions).toEqual([]);
        expect(out.clearanceLevel).toBeTruthy();
    });

    it('keeps everything for the stamped system Admin holding the apex perm set', () => {
        const out = stripSensitiveUserFields(target(), { id: 1, role: 'Admin', isSystemAdmin: true, permissions: APEX });
        expect(out.permissions).toEqual(['operations:create', 'intel:view']);
        expect(out.clearanceLevel).toBeTruthy();
    });

    // ROLE NAME IS NOT AUTHORITY. `role` is name-derived, so a permissionless custom
    // role called 'Commander' arrived as the Admin tier and read every member's
    // permissions + clearance off the auth-only `main` subset.
    it('strips for a forged Admin role NAME with no permissions', () => {
        const out = stripSensitiveUserFields(target(), { id: 1, role: 'Admin', permissions: [] });
        expect(out.permissions).toEqual([]);
        expect(out.clearanceLevel).toBeUndefined();
    });

    it('strips for an unauthenticated viewer (defense-in-depth)', () => {
        const out = stripSensitiveUserFields(target(), null);
        expect(out.permissions).toEqual([]);
        expect(out.clearanceLevel).toBeUndefined();
    });
});

// The assertions above use synthetic permission arrays. These track the SEEDS, so the
// day someone adds a permission to a seeded role the gate is re-proved against the
// role that actually ships — which is exactly how 'warrant:view' universalised the old
// ROSTER_CAPABILITY_PERMS restore without anyone noticing.
describe('roster minimization holds against the SEEDED roles', () => {
    const seededViewer = (perms: readonly string[], id = 7, role = 'Member') =>
        ({ id, role, permissions: [...perms] });

    it('a viewer holding exactly MEMBER_DEFAULT_PERMS gets neither permissions[] nor clearanceLevel', () => {
        const out = stripSensitiveUserFields(target(), seededViewer(MEMBER_DEFAULT_PERMS));
        expect(out.permissions).toEqual([]);
        expect(out.clearanceLevel).toBeUndefined();
    });

    it('a viewer holding exactly CLIENT_DEFAULT_PERMS gets neither', () => {
        const out = stripSensitiveUserFields(target(), seededViewer(CLIENT_DEFAULT_PERMS, 9, 'Client'));
        expect(out.permissions).toEqual([]);
        expect(out.clearanceLevel).toBeUndefined();
    });

    // The entitled party RETAINS what it needs: fail-closed must not mean fail-broken.
    it('a viewer holding exactly DISPATCHER_DEFAULT_PERMS KEEPS clearanceLevel', () => {
        const out = stripSensitiveUserFields(target(), seededViewer(DISPATCHER_DEFAULT_PERMS, 8, 'Dispatcher'));
        expect(out.clearanceLevel).toBeTruthy();
    });

    it('a viewer holding exactly DISPATCHER_DEFAULT_PERMS is still denied permissions[]', () => {
        const out = stripSensitiveUserFields(target(), seededViewer(DISPATCHER_DEFAULT_PERMS, 8, 'Dispatcher'));
        expect(out.permissions).toEqual([]);
    });

    // NO permission buys another member's permission array — one viewer per string,
    // across every set that has ever gated a field in this module.
    it('no single permission buys another member\'s permissions[]', () => {
        const every = [...new Set([
            ...MEMBER_DEFAULT_PERMS, ...DISPATCHER_DEFAULT_PERMS, ...CLIENT_DEFAULT_PERMS,
            ...CLEARANCE_VISIBLE_PERMS, ...APEX,
            'user:manage:personnel_notes', 'user:manage:conduct_record', 'admin:config:discord',
        ])];
        const leaked = every.filter(p => stripSensitiveUserFields(target(), viewer([p])).permissions.length > 0);
        expect(leaked, `permissions[] leaked to holders of: ${leaked.join(', ')}`).toEqual([]);
    });

    // STRUCTURAL ratchet, not behavioural: a future widening that puts a Member or
    // Client default into the clearance gate re-universalises it, which is precisely
    // how the old restore leaked. This fails before any behaviour test would.
    it('CLEARANCE_VISIBLE_PERMS is disjoint from the Member and Client seeds', () => {
        const memberOverlap = CLEARANCE_VISIBLE_PERMS.filter(p => MEMBER_DEFAULT_PERMS.includes(p));
        const clientOverlap = CLEARANCE_VISIBLE_PERMS.filter(p => CLIENT_DEFAULT_PERMS.includes(p));
        expect(memberOverlap, `these would re-universalise clearanceLevel: ${memberOverlap.join(', ')}`).toEqual([]);
        expect(clientOverlap, `these would hand clearanceLevel to clients: ${clientOverlap.join(', ')}`).toEqual([]);
    });

    // The forged-Admin boundary, now applied to the field most worth forging for.
    // Mirrors tests/sec-user-filters.test.ts's adminNotes/discordId equivalents.
    it('an UNSTAMPED role holding the full apex set is still denied permissions[]', () => {
        const forged = { id: 1, role: 'Admin', isSystemAdmin: undefined, permissions: [...APEX, 'admin:access'] };
        const out = stripSensitiveUserFields(target(), forged);
        expect(out.permissions).toEqual([]);
    });

    // The apex bypass is deliberate and is the ONLY route to another member's array —
    // but it never reaches the self-only RSI proof-of-control pair.
    it('the genuine stamped apex Admin keeps the record but still not another member\'s RSI code', () => {
        const out = stripSensitiveUserFields(
            target({ rsiVerificationCode: 'VERIFY-1234', rsiHandlePending: 'PendingHandle' }),
            { id: 1, role: 'Admin', isSystemAdmin: true, permissions: APEX },
        );
        expect(out.permissions).toEqual(['operations:create', 'intel:view']);
        expect(out.clearanceLevel).toBeTruthy();
        expect(out.rsiVerificationCode).toBeUndefined();
        expect(out.rsiHandlePending).toBeUndefined();
    });

    // The null-requester branch used to be a DENYLIST over `...user`, so the least
    // trusted viewer class got the WIDEST projection. It now runs the same allow-list
    // builder as a non-self member, with no restores.
    it('the unauthenticated branch projects the SAME key set as a non-self member, and no PII', () => {
        const populated = target({
            jobTitle: 'SECRET-JOB', voiceChannelName: 'SECRET-VOICE', timezone: 'SECRET-TZ',
            dateFormat: 'iso_24h', probationStart: 'SECRET-PROBSTART', probationEnd: 'SECRET-PROBEND',
            tenureStartDate: 'SECRET-TENURE', tokensValidFrom: 'SECRET-TVF', rsiVerified: false,
            adminNotes: 'SECRET-ADMIN', personnelNotes: 'SECRET-HR', discordId: 'SECRET-SNOWFLAKE',
            rsiVerificationCode: 'SECRET-CODE', rsiHandlePending: 'SECRET-PENDING',
        });
        const anon = stripSensitiveUserFields(populated, null);
        const member = stripSensitiveUserFields(populated, seededViewer(MEMBER_DEFAULT_PERMS));
        expect(Object.keys(anon).sort()).toEqual(Object.keys(member).sort());

        const blob = JSON.stringify(anon);
        for (const sentinel of [
            'SECRET-JOB', 'SECRET-VOICE', 'SECRET-TZ', 'iso_24h', 'SECRET-PROBSTART',
            'SECRET-PROBEND', 'SECRET-TENURE', 'SECRET-TVF', 'SECRET-ADMIN', 'SECRET-HR',
            'SECRET-SNOWFLAKE', 'SECRET-CODE', 'SECRET-PENDING',
        ]) {
            expect(blob, `unauthenticated projection leaked ${sentinel}`).not.toContain(sentinel);
        }
    });
});

// ---------------------------------------------------------------------------
// Client-side ratchet: the safety case for withholding permissions[] entirely
// ---------------------------------------------------------------------------
// Deleting the roster restore is only safe because NOTHING in the browser reads
// another member's permission array. That was established by a one-time grep, which
// decays the moment someone writes `members.filter(m => m.permissions...)` again.
// This makes it mechanical. Client files sit outside the coverage gate
// (vite.config.ts counts lib/** + api/** only), so a source scan is the right
// instrument and costs nothing.

const ROOT = resolve(__dirname, '..');
const CLIENT_DIRS = ['components', 'contexts', 'hooks', 'services'];

// Receivers whose `.permissions` is the CALLER'S OWN array, or a Role's permission
// list — neither is another member's roster row. Every entry was read against the
// live tree; adding one is a decision, not a formality.
//   currentUser / user / cu / updatedUser → the session actor (self)
//   role                                  → a Role object, not a User
const SELF_OR_ROLE_RECEIVERS = new Set(['currentUser', 'user', 'cu', 'updatedUser', 'role']);

function walkClient(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walkClient(rel, acc);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) acc.push(rel);
    }
    return acc;
}

// Comment blanking is the shared, string-aware helper (tests/stripComments.ts).

const PERMISSIONS_READ = /([A-Za-z_$][\w$]*)\s*\??\.\s*permissions\b/g;

function foreignPermissionReads(rel: string, src: string): string[] {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    PERMISSIONS_READ.lastIndex = 0;
    while ((m = PERMISSIONS_READ.exec(src)) !== null) {
        if (!SELF_OR_ROLE_RECEIVERS.has(m[1])) out.push(`${rel}: ${m[1]}.permissions`);
    }
    return out;
}

describe('no client code reads another member\'s permissions[]', () => {
    it('components / contexts / hooks / services read .permissions only off self or a Role', () => {
        const offenders: string[] = [];
        for (const dir of CLIENT_DIRS) {
            for (const rel of walkClient(dir)) {
                const src = stripComments(readFileSync(join(ROOT, rel.split('/').join(sep)), 'utf8'));
                offenders.push(...foreignPermissionReads(rel, src));
            }
        }
        expect(
            offenders,
            `A client file reads a non-self permission array. stripSensitiveUserFields no longer ships it, `
            + `so this renders as an empty array for every viewer — resolve eligibility server-side instead `
            + `(see hr:get_eligible_interviewers / hr:get_eligible_officers):\n${offenders.join('\n')}`,
        ).toEqual([]);
    });

    // An empty-baseline scan that matches nothing passes green and protects nothing.
    it('the scan actually fires on the pattern this cluster removed', () => {
        const fixture = `const a = members.filter(m => m.permissions.includes('hr:admin'));`;
        expect(foreignPermissionReads('fixture.tsx', fixture)).toEqual(['fixture.tsx: m.permissions']);
        // …and does not fire on the self / Role receivers it must tolerate.
        expect(foreignPermissionReads('fixture.tsx', `currentUser?.permissions.includes('x')`)).toEqual([]);
        expect(foreignPermissionReads('fixture.tsx', `new Set(role.permissions)`)).toEqual([]);
    });

    it('scans a plausible number of client files (guards a silently broken walker)', () => {
        const files = CLIENT_DIRS.flatMap(d => walkClient(d));
        expect(files.length).toBeGreaterThan(200);
    });
});
