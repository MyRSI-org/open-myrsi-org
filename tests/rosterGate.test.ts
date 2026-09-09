import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mayReceiveRoster, ROSTER_AUTHORITY_PERMS } from '../lib/rosterGate';
import { hasAnyStaffViewPerm } from '../lib/staffPerms';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';
import { CLEARANCE_VISIBLE_PERMS } from '../lib/db/userFilters';

// Phase 3 item 3 — owner decision D4: the roster gate is ONE predicate with THREE
// named disjuncts, and every roster surface calls it.
//
// The failure this file exists to catch is not a leak, it is a CONTRADICTION. Two
// layers of this build answer the same question about the same role:
// lib/db/userFilters.ts hands an `admin:view:roster` / `hr:recruiter` role another
// member's clearanceLevel and personnel metadata, while a two-part gate one layer up
// (isSystemAdmin || hasAnyStaffViewPerm) tells that same role it is an external
// customer with no roster to read. Neither of those perms is in STAFF_VIEW_PERMS and
// lib/permissionImplications.ts has three keys only, so none of them arrives by
// implication — pinned in the other direction by
// tests/permissionImplicationSites.test.ts's `hasAnyStaffViewPerm(['hr:recruiter'])
// === false`.
//
// Blast radius is deliberately narrow: every SEEDED role clears the second disjunct
// on its own, so nothing goes red without this. It is the CUSTOM-role population the
// permission-set predicate was chosen to protect in the first place.

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('mayReceiveRoster — the three disjuncts (owner decision D4)', () => {
    it('1. each disjunct carries a viewer on its own', () => {
        // 1. role IDENTITY, stamped server-side — a hand-pruned Admin with an empty
        //    permission array must not lose its own org's directory.
        expect(mayReceiveRoster({ isSystemAdmin: true, permissions: [] })).toBe(true);
        // 2. any staff capability.
        expect(mayReceiveRoster({ permissions: ['fleet:view'] })).toBe(true);
        // 3. roster/HR authority with NOTHING in STAFF_VIEW_PERMS. This is the
        //    disjunct whose absence is the contradiction described above.
        expect(hasAnyStaffViewPerm(['hr:recruiter'])).toBe(false);
        expect(mayReceiveRoster({ permissions: ['hr:recruiter'] })).toBe(true);
        for (const p of ROSTER_AUTHORITY_PERMS) {
            expect(mayReceiveRoster({ permissions: [p] }), p).toBe(true);
        }
    });

    it('2. fails CLOSED on every empty / malformed viewer', () => {
        expect(mayReceiveRoster(null)).toBe(false);
        expect(mayReceiveRoster(undefined)).toBe(false);
        expect(mayReceiveRoster({})).toBe(false);
        expect(mayReceiveRoster({ permissions: [] })).toBe(false);
        expect(mayReceiveRoster({ permissions: null })).toBe(false);
        // A non-array `permissions` reaches here only from a corrupted row or a future
        // caller passing a client-supplied value; `.includes` on it would throw and a
        // throw inside getMainState is a 500, not a denial.
        expect(mayReceiveRoster({ permissions: 'admin:view:roster' as unknown as string[] })).toBe(false);
        // isSystemAdmin must be the boolean `true`, never a truthy string.
        expect(mayReceiveRoster({ isSystemAdmin: 'yes' as unknown as boolean, permissions: [] })).toBe(false);
    });

    it('3. the org\'s external customers are denied, whole and per string', () => {
        expect(mayReceiveRoster({ permissions: [...CLIENT_DEFAULT_PERMS] })).toBe(false);
        for (const p of CLIENT_DEFAULT_PERMS) {
            expect(mayReceiveRoster({ permissions: [p] }), p).toBe(false);
        }
    });

    it('4. the customer-grantable perms outside the client defaults are denied too', () => {
        // Mirrors the existing pins in tests/permissionImplicationSites.test.ts: these
        // three are excluded from STAFF_VIEW_PERMS on purpose because an org may grant
        // them to a customer, and the implication ladder only ever climbs.
        for (const p of ['marketplace:view', 'academy:view', 'units:view_all']) {
            expect(mayReceiveRoster({ permissions: [p] }), p).toBe(false);
        }
    });
});

describe('parity ratchets — the two layers must not contradict each other', () => {
    it('5. every CLEARANCE_VISIBLE_PERMS entry either is staff or is roster authority', () => {
        // THE D4 FIX, ratcheted. If a later change adds a clearance-visible perm
        // without adding it here, that role reads another member's clearanceLevel
        // while being told it has no roster to read it from.
        for (const p of CLEARANCE_VISIBLE_PERMS) {
            const covered = hasAnyStaffViewPerm([p]) || ROSTER_AUTHORITY_PERMS.includes(p);
            expect(covered, `${p} is clearance-visible but not roster-entitled`).toBe(true);
            expect(mayReceiveRoster({ permissions: [p] }), p).toBe(true);
        }
    });

    it('6. ROSTER_AUTHORITY_PERMS is disjoint from CLIENT_DEFAULT_PERMS', () => {
        // The union of the three disjuncts must stay a strict NARROWING of the
        // pre-Phase-3 "any authenticated caller" audience, never a widening.
        for (const p of ROSTER_AUTHORITY_PERMS) {
            expect(CLIENT_DEFAULT_PERMS.includes(p), p).toBe(false);
        }
    });

    it('6b. ROSTER_AUTHORITY_PERMS adds nothing that STAFF_VIEW_PERMS already admits', () => {
        // Not a style rule: an entry that is already staff would make the parity
        // ratchet above pass for the wrong reason, hiding a genuine gap.
        for (const p of ROSTER_AUTHORITY_PERMS) {
            expect(hasAnyStaffViewPerm([p]), `${p} is already in STAFF_VIEW_PERMS`).toBe(false);
        }
    });
});

describe('source ratchets — one home, two module systems', () => {
    it('7. the server import carries .js and the client import does not', () => {
        // A missing `.js` breaks `npm run build:server` but NOT `npx tsc --noEmit`; a
        // stray `.js` in a client file breaks the Vite build. Neither is caught by a
        // behavioural test. Precedent: tests/permissionImplicationSites.test.ts.
        expect(read('lib/rosterGate.ts')).toContain(`import { hasAnyStaffViewPerm } from './staffPerms.js'`);
        for (const f of ['lib/db.ts', 'api/query.ts']) {
            expect(read(f), f).toMatch(/import \{ mayReceiveRoster \} from '\.\.?\/(lib\/)?rosterGate\.js'/);
        }
        for (const f of ['contexts/DataCoreContext.tsx', 'contexts/SessionContext.tsx']) {
            const src = read(f);
            expect(src, f).toContain(`import { mayReceiveRoster } from '../lib/rosterGate'`);
            expect(src, f).not.toContain(`from '../lib/rosterGate.js'`);
        }
    });

    it('8. no call site keeps a second inline copy of the predicate', () => {
        // R4. Two copies of one rule is exactly how the gates drifted apart before.
        // The failure mode of a drift here is a staff viewer whose roster EMPTIES
        // mid-session: the bundle gate admits them, the users_slice gate denies them,
        // and mergeUsersSlice evicts the requested ids on the denial.
        for (const f of ['lib/db.ts', 'api/query.ts', 'contexts/DataCoreContext.tsx', 'contexts/SessionContext.tsx']) {
            const src = read(f);
            expect(src, f).toContain('mayReceiveRoster(');
            expect(src, `${f} re-inlines hasAnyStaffViewPerm`).not.toMatch(/[^.\w]hasAnyStaffViewPerm\(/);
            expect(src, `${f} re-inlines STAFF_VIEW_PERMS`).not.toContain('STAFF_VIEW_PERMS.some');
        }
    });

    it('8b. all four server roster surfaces run it', () => {
        // main (the bundle projection) + the three read routes. users_presence is item
        // 2's gate by assignment, but it withholds the same census the other three
        // withhold, so it must ask the same question.
        const q = read('api/query.ts');
        expect(q).toContain('if (!mayReceiveRoster(currentUser)) {');                       // users_slice
        expect(q).toContain('if (parsedUserId !== currentUser.id && !mayReceiveRoster(currentUser)) {'); // user_detail
        expect(q).toContain('const isRosterViewer = mayReceiveRoster(currentUser);');       // users_presence
        expect(read('lib/db.ts')).toContain('const isRosterViewer = mayReceiveRoster({');   // the bundle
    });

    it('9. lib/rosterGate.ts imports nothing under lib/db/**', () => {
        // eslint.config.js makes any lib/db import a LINT ERROR in components/,
        // contexts/, hooks/ and services/ — and the client half of this predicate lives
        // in contexts/. This is why ROSTER_AUTHORITY_PERMS is not re-exported from
        // lib/db/userFilters.ts, where its mirror lives.
        const src = read('lib/rosterGate.ts');
        expect(src).not.toMatch(/from '\.\/db/);
        expect(src).not.toMatch(/from '\.\.\/lib\/db/);
        expect(src).not.toContain('supabase');
    });

    it('9b. it does not claim to close the taxonomy question', () => {
        // Owner decision D7: Route A closes in items 7 (schema.sql rt-is-staff-policy) and
        // 8 (settings-projection). system:get_clearances / system:get_markers were DELETED
        // by item 5 in wave 3; the `authenticated` PostgREST grant is what remains. No
        // comment or test may claim the taxonomy is closed until item 7 lands.
        const src = read('lib/rosterGate.ts');
        expect(src).toContain('WHAT THIS DOES NOT CLOSE');
        expect(src).toContain('rt_client_tables');
    });
});
