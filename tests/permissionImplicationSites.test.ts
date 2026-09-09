import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { permissionSatisfied } from '../lib/permissionImplications';
import { STAFF_VIEW_PERMS, hasAnyStaffViewPerm } from '../lib/staffPerms';
import { CLIENT_DEFAULT_PERMS } from '../lib/clientRolePermissions';
import { FEATURE_UPLOAD_PERMS } from '../api/orgUploadPerms';

// The gates that were still re-implementing the permission check by hand after the
// shared implication table (lib/permissionImplications.ts) landed at the read gate,
// the boot aggregate, api/actions/academy isViewer and the two client contexts:
//
//   * lib/staffPerms.ts hasAnyStaffViewPerm — the LiveKit staff discriminator,
//   * api/orgUpload.ts — the media-upload gate,
//   * api/services.ts — the dispatcher write gate (behaviour: see
//     tests/permissionImplicationWriteGate.test.ts; the source-text half is here),
//   * components/utility/NotificationListener.tsx — the one client intel gate that
//     reads the raw session `user` instead of useAuth().hasPermission.
//
// Leaving any of them behind is the cluster being partly done: two copies of one
// rule is exactly how the intel synonym came to exist at three server gates, neither
// client gate, and in three structurally different shapes.

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('lib/staffPerms hasAnyStaffViewPerm — the LiveKit staff discriminator', () => {
    // D1. THE WIDENING. academy:instruct is on STAFF_VIEW_PERMS; academy:manage is
    // not, and holding manage means holding the instructor's authority through the
    // ladder. A Learning Manager is org personnel, so they get the base voice nets,
    // the base room list (lib/radio.ts visibleRadioRoomNames) and the EAM body
    // (api/actions/system.ts broadcast:get_active_eam).
    it('academy:manage is staff through the academy:instruct rung', () => {
        expect(hasAnyStaffViewPerm(['academy:manage'])).toBe(true);
    });

    // D2. THE ANTI-WIDENING, and the single most important assertion at this site.
    // academy:view is documented as grantable to the org's external customers and is
    // deliberately absent from STAFF_VIEW_PERMS. Implications only ever CLIMB, so it
    // must not reach the academy:instruct entry — if it ever did, a customer could
    // mint a LiveKit join token for the org's staff voice nets.
    it('academy:view is still NOT staff', () => {
        expect(hasAnyStaffViewPerm(['academy:view'])).toBe(false);
    });

    it('the other two deliberately-excluded customer-grantable perms are still not staff', () => {
        expect(hasAnyStaffViewPerm(['units:view_all'])).toBe(false);
        expect(hasAnyStaffViewPerm(['marketplace:view'])).toBe(false);
    });

    // D3. The existing tripwire in tests/radioRoomAuthz.test.ts is a STRING-SET
    // disjointness check over the array. Once this gate consults the table, the
    // effective staff set is (list ∪ implications-of-list) — so the invariant has to
    // be re-asserted in its implication-aware form, or a future row in
    // lib/permissionImplications.ts could hand a Client-default permission a staff
    // token from an edit to a different file, with the array check still green.
    it('no CLIENT_DEFAULT_PERMS entry is staff, alone or through the table', () => {
        for (const p of CLIENT_DEFAULT_PERMS) {
            expect(hasAnyStaffViewPerm([p]), p).toBe(false);
            for (const staff of STAFF_VIEW_PERMS) {
                expect(permissionSatisfied([p], staff), `${p} -> ${staff}`).toBe(false);
            }
        }
        expect(hasAnyStaffViewPerm([...CLIENT_DEFAULT_PERMS])).toBe(false);
    });

    // D4. Anti-regression: the predicate still answers its own list, and still fails
    // closed on nothing at all.
    it('still accepts a plain staff read perm and still denies an empty holder', () => {
        expect(hasAnyStaffViewPerm(['operations:view'])).toBe(true);
        expect(hasAnyStaffViewPerm(['intel:view:clearance'])).toBe(true);
        expect(hasAnyStaffViewPerm([])).toBe(false);
        expect(hasAnyStaffViewPerm(undefined)).toBe(false);
        expect(hasAnyStaffViewPerm(null)).toBe(false);
        expect(hasAnyStaffViewPerm(['hr:recruiter'])).toBe(false);
    });
});

describe('api/orgUpload media-upload gate', () => {
    // E1/E2. The gate is `requiredPerms.some(p => permissionSatisfied(userPerms, p))`
    // over FEATURE_UPLOAD_PERMS, which deliberately mirrors the feature's WRITE
    // permission (tests/orgUploadPermParity.test.ts locks the two maps together). So
    // the ladder has to reach it too: a Learning Manager who can approve and publish
    // a course must be able to upload its cover image.
    const gate = (feature: keyof typeof FEATURE_UPLOAD_PERMS, perms: string[]) =>
        [FEATURE_UPLOAD_PERMS[feature]].flat().some(p => permissionSatisfied(perms, p));

    it('academy:manage satisfies the academy upload gate (academy:instruct)', () => {
        expect(FEATURE_UPLOAD_PERMS.academy).toBe('academy:instruct');
        expect(gate('academy', ['academy:manage'])).toBe(true);
        expect(gate('academy', ['academy:instruct'])).toBe(true);
    });

    it('academy:view and an empty holder are still refused', () => {
        expect(gate('academy', ['academy:view'])).toBe(false);
        expect(gate('academy', [])).toBe(false);
    });

    // Anti-regression: every other feature is un-laddered and must answer exactly as
    // a bare includes() did — the any-of wiki pair included.
    it('no other upload feature gains a satisfier', () => {
        for (const [feature, required] of Object.entries(FEATURE_UPLOAD_PERMS)) {
            if (feature === 'academy') continue;
            for (const p of [required].flat()) {
                expect(gate(feature as keyof typeof FEATURE_UPLOAD_PERMS, ['academy:manage']), `${feature} via academy:manage`).toBe(false);
                expect(permissionSatisfied([p], p), p).toBe(true);
            }
        }
        expect(gate('wiki', ['wiki:add_page'])).toBe(true);
        expect(gate('wiki', ['wiki:edit_page'])).toBe(true);
        expect(gate('wiki', ['wiki:view'])).toBe(false);
    });
});

describe('the remaining gates consult the table instead of re-implementing it', () => {
    // Import parity by source text. A missing `.js` breaks `npm run build:server` but
    // NOT `npx tsc --noEmit`; a stray `.js` in a client file breaks the Vite build.
    // The cheapest thing that catches either is a source pin.
    const serverSites: Array<[string, string]> = [
        ['api/services.ts', '../lib/permissionImplications.js'],
        ['lib/staffPerms.ts', './permissionImplications.js'],
        ['api/orgUpload.ts', '../lib/permissionImplications.js'],
    ];
    for (const [file, spec] of serverSites) {
        it(`${file} imports permissionSatisfied WITH the .js extension`, () => {
            expect(read(file)).toContain(`import { permissionSatisfied } from '${spec}'`);
        });
    }

    it('components/utility/NotificationListener.tsx imports it WITHOUT the .js extension', () => {
        const src = read('components/utility/NotificationListener.tsx');
        expect(src).toContain(`import { permissionSatisfied } from '../../lib/permissionImplications'`);
        expect(src).not.toContain(`from '../../lib/permissionImplications.js'`);
    });

    // The hand-inlined copies are gone. Each of these matched before the migration; a
    // re-introduced inline compare is a second source of truth for a rule that now has
    // one home, and it is how the gates drifted apart the first time.
    it('the inlined intel:view ⇄ intel:view:clearance compares are gone from the write gate and the toast gate', () => {
        expect(read('api/services.ts')).not.toMatch(/requiredPerm === 'intel:view'/);
        expect(read('api/services.ts')).not.toMatch(/hasClearanceView/);
        expect(read('components/utility/NotificationListener.tsx')).not.toMatch(/permissions\?\.includes\('intel:view'\)/);
    });

    it('the write gate and the staff/upload gates are no longer bare includes()', () => {
        expect(read('api/services.ts')).toMatch(/const hasPerm = permissionSatisfied\(user\?\.permissions, requiredPerm\)/);
        expect(read('lib/staffPerms.ts')).toMatch(/STAFF_VIEW_PERMS\.some\(\(p\) => permissionSatisfied\(permissions, p\)\)/);
        expect(read('api/orgUpload.ts')).toMatch(/requiredPerms\.some\(p => permissionSatisfied\(userPerms, p\)\)/);
    });

    // The client mirror keeps its role disjunct: the role-name sweep removed role-name
    // authorization from lib/**, api/** and server.ts only, and both client gates
    // (SessionContext.hasPermission, DataCoreContext's isAdminRef) still carry theirs.
    // This listener must stay consistent with them — only the PERMISSION half moved.
    it('the toast gate keeps its client-side Admin disjunct', () => {
        const src = read('components/utility/NotificationListener.tsx');
        expect(src).toMatch(/!permissionSatisfied\(user\?\.permissions, 'intel:view'\) && String\(user\?\.role\) !== UserRole\.Admin/);
    });
});
