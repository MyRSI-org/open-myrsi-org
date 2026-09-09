import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SUBSET_REQUIRED_PERMISSION } from '../api/query';

// The read-path twin of tests/permissionMapCoverage.test.ts.
//
// The WRITE path has been guarded for several releases: a protected action with no
// `fullPermissionMap` entry fails CI. The READ path had no equivalent, because
// `SUBSET_REQUIRED_PERMISSION` was module-private — so a new `?subset=` could be added to the
// switch, serve real data, and be readable by every authenticated caller with nothing to catch
// it. That includes an external CUSTOMER on the seeded Client role, which is the exact exposure
// Phase 3 spent eight items closing.
//
// BIDIRECTIONAL, like its write-path sibling:
//   direction 1 — every servable subset is gated, or is on a reason-bearing allowlist
//   direction 2 — every map entry names a subset that still exists
// A one-directional test lets a deleted subset leave a stale entry behind, which then reads as
// coverage that does not exist.
//
// The map is imported; the servable set is PARSED from the switch. One literal per fact,
// deliberately: a hand-written `SERVABLE_SUBSETS` list would be a second source of truth that
// can drift from the switch, which is the failure this test exists to prevent.

const ROOT = resolve(__dirname, '..');
const querySrc = readFileSync(join(ROOT, 'api', 'query.ts'), 'utf8');

/** The `switch (subset)` inside handleState — the authoritative set of servable subsets. */
function servableSubsets(): string[] {
    const fnAt = querySrc.indexOf('async function handleState');
    expect(fnAt, 'handleState not found — this test parses it').toBeGreaterThan(-1);
    const switchAt = querySrc.indexOf('switch (subset)', fnAt);
    expect(switchAt, 'the subset switch moved — re-anchor this parser').toBeGreaterThan(-1);
    // Walk to the switch's closing brace so a later switch in the file is never scanned.
    const open = querySrc.indexOf('{', switchAt);
    let depth = 0, end = querySrc.length;
    for (let i = open; i < querySrc.length; i++) {
        const c = querySrc[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = querySrc.slice(open, end);
    // Every named label sits at exactly 12 spaces in this switch; `case undefined:` and
    // `case '':` are the only others and are deliberately excluded (they are the no-subset
    // full-state arm, gated separately).
    return [...body.matchAll(/^ {12}case '([a-z_]+)':/gm)].map(m => m[1]);
}

/**
 * The ONLY subsets an authenticated caller may read with no per-subset permission.
 *
 * The value is the REASON. Adding an entry here PUBLISHES THAT SUBSET TO EVERY AUTHENTICATED
 * MEMBER, including an external customer on the Client role. Do not add one to make a test
 * pass — gate the subset, deny it to the client tier, or roster-gate it inline.
 */
const AUTH_ONLY_SUBSETS: Readonly<Record<string, string>> = {
    main: 'boot bundle; the roster and taxonomy are withheld INSIDE getMainState by mayReceiveRoster, and the settings blob is rebuilt per viewer by projectSettingsForViewer. A flat map entry here would kill the Client request form.',
    requests: 'own requests only; canSeeAllRequests scopes the query in SQL.',
    request_detail: 'same predicate as the list; not-visible and absent both surface as 404, so it is not an existence oracle.',
    announcements: 'audience-scoped inside getAnnouncementsState; admin:config:notices sees all.',
    external_tools: 'audience-filtered inside getExternalToolsState; admin:config:tools sees all.',
    notifications: 'self-scoped by currentUser.id inside getUserNotificationState — a caller can only ever read their own bell, so a permission would gate nobody.',
    academy_my: 'a permission-LESS member surface by design; governed by the client-tier denial list and SUBSET_REQUIRED_FEATURE, not by a permission.',
    users_slice: 'roster-gated INLINE by mayReceiveRoster — a flat entry would deny a member their own record.',
    user_detail: 'roster-gated INLINE by mayReceiveRoster; a caller may always read their own record.',
    users_presence: 'roster-gated INLINE; a non-staff caller receives one boolean and an empty array.',
};

const servable = servableSubsets();
const mapped = Object.keys(SUBSET_REQUIRED_PERMISSION);

describe('read-path permission coverage', () => {
    // ANTI-VACUITY. Every assertion below is derived from a source parse, so a parser that
    // silently matches nothing would make the whole file pass while guarding nothing.
    it('the parser actually found the switch and the map', () => {
        expect(servable.length).toBeGreaterThan(40);
        expect(mapped.length).toBeGreaterThan(30);
        // Spot-check both ends against known members rather than counts alone.
        expect(servable).toContain('warrants');
        expect(servable).toContain('main');
        expect(mapped).toContain('warrants');
        expect(mapped).not.toContain('main');
    });

    // DIRECTION 1 — nothing servable is ungated by accident.
    it('every servable subset is gated by a permission or a reason-bearing allowlist', () => {
        const ungated = servable
            .filter(s => !Object.prototype.hasOwnProperty.call(SUBSET_REQUIRED_PERMISSION, s))
            .filter(s => !Object.prototype.hasOwnProperty.call(AUTH_ONLY_SUBSETS, s));
        expect(
            ungated,
            `these subsets are readable by EVERY authenticated caller with no permission check.\n` +
            `Gate them in SUBSET_REQUIRED_PERMISSION, or add a reason to AUTH_ONLY_SUBSETS and be sure it is true:\n${ungated.join('\n')}`,
        ).toEqual([]);
    });

    // DIRECTION 2 — the map does not claim coverage it no longer has.
    it('every map entry names a subset that still exists', () => {
        const stale = mapped.filter(s => !servable.includes(s));
        expect(stale, `stale SUBSET_REQUIRED_PERMISSION entries (the subset was removed):\n${stale.join('\n')}`).toEqual([]);
    });

    // The allowlist is the dangerous half, so it gets the same treatment.
    it('the auth-only allowlist has no stale entries either', () => {
        const stale = Object.keys(AUTH_ONLY_SUBSETS).filter(s => !servable.includes(s));
        expect(stale, `auth-only entries naming a subset that no longer exists:\n${stale.join('\n')}`).toEqual([]);
    });

    it('no subset is both gated and on the auth-only allowlist', () => {
        const both = mapped.filter(s => Object.prototype.hasOwnProperty.call(AUTH_ONLY_SUBSETS, s));
        expect(both, `contradictory: gated AND declared auth-only:\n${both.join('\n')}`).toEqual([]);
    });

    it('every auth-only entry carries a real reason, not a placeholder', () => {
        for (const [subset, reason] of Object.entries(AUTH_ONLY_SUBSETS)) {
            expect(reason.length, `${subset}: the reason is what stops this list growing silently`).toBeGreaterThan(40);
        }
    });

    // Mirrored gates: rule 2 requires the list, detail and slice paths to agree. A slice with a
    // weaker gate than the list it patches is a bypass with extra steps.
    it('every slice/aggregate subset carries the same permission as its parent bundle', () => {
        // EXPLICIT, never derived from the name: only five of these end in `_slice`, and
        // `users_presence`.split('_')[0] is `users`, which is not a subset at all.
        const SLICE_PARENT: Readonly<Record<string, string>> = {
            operation_slice: 'operations',
            operation_templates: 'operations',
            warrant_slice: 'warrants',
            intel_summary: 'intel',
            bulletin_slice: 'intel',
            hr_applicants: 'hr', hr_interviews: 'hr', hr_jobs: 'hr',
            hr_templates: 'hr', hr_transfers: 'hr', hr_positions: 'hr',
            wiki_page_slice: 'wiki',
            fleet_catalog: 'fleet', fleet_user_ships: 'fleet', fleet_groups: 'fleet',
            government_structure: 'government', government_elections: 'government', government_legislation: 'government',
        };
        const mismatched: string[] = [];
        for (const [slice, parent] of Object.entries(SLICE_PARENT)) {
            if (!servable.includes(slice)) continue; // covered by the stale-entry checks above
            const sliceGate = SUBSET_REQUIRED_PERMISSION[slice];
            const parentGate = SUBSET_REQUIRED_PERMISSION[parent];
            if (sliceGate !== parentGate) mismatched.push(`${slice}: '${sliceGate}' but parent ${parent}: '${parentGate}'`);
        }
        expect(mismatched, `slice gates that drifted from their parent bundle:\n${mismatched.join('\n')}`).toEqual([]);
    });
});
