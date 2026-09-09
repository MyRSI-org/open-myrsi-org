import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { isSyncRestrictedWithheld } from '../lib/markerSyncVisibility';

// Phase 3, owner decision D10 — the UI half.
//
// D10 made `syncRestricted` admin-only in the `limitingMarkers` projection
// (lib/db.ts). The server OMITS the key below admin:access rather than sending
// `false`, because a fabricated `false` asserts "this compartment IS
// federatable". tests/mainBundleProjection.test.ts pins the server side; this
// file pins the consequence the owner asked be made explicit rather than
// silent — the two marker-selection surfaces must SAY the flag is withheld
// instead of rendering a chip-less list that reads as "nothing here blocks
// sharing".
//
// The distinction the predicate exists to protect is `undefined` vs `false`: a
// marker a viewer CAN see that simply is not restricted carries `false`, so
// `!m.syncRestricted` would fire the notice on every org whose compartments are
// all federatable. Test 2 is the one that catches that regression.

const ROOT = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(resolve(ROOT, ...p), 'utf8');

describe('isSyncRestrictedWithheld', () => {
    it('1. true when the server stripped the key from every marker (below admin:access)', () => {
        expect(isSyncRestrictedWithheld([
            { }, { }, { },
        ])).toBe(true);
    });

    it('2. FALSE when the viewer sees the flag and no marker happens to be restricted', () => {
        // The regression this file exists for. All-`false` is a visible answer
        // ("none of these block federation"), not a withheld one, and the notice
        // must not fire on it.
        expect(isSyncRestrictedWithheld([
            { syncRestricted: false }, { syncRestricted: false },
        ])).toBe(false);
    });

    it('3. false when the viewer sees the flag and some marker is restricted', () => {
        expect(isSyncRestrictedWithheld([
            { syncRestricted: false }, { syncRestricted: true },
        ])).toBe(false);
    });

    it('4. false for a mixed payload — one key present means the flag was not withheld', () => {
        expect(isSyncRestrictedWithheld([
            { }, { syncRestricted: true },
        ])).toBe(false);
    });

    it('5. false when there are no markers at all — nothing to label, notice would be noise', () => {
        expect(isSyncRestrictedWithheld([])).toBe(false);
    });

    it('6. false for null / undefined rather than throwing on an unhydrated context', () => {
        expect(isSyncRestrictedWithheld(null)).toBe(false);
        expect(isSyncRestrictedWithheld(undefined)).toBe(false);
    });
});

describe('the two marker-selection surfaces consume the predicate', () => {
    // Source-text ratchets: the rendered condition is invisible to a unit test
    // without mounting the whole provider tree, and the failure mode is silent
    // (a chip-less list that looks fine). Both were written because the obvious
    // "cleanup" is to delete a notice nobody sees as an admin.
    const wizard = read('components', 'modals', 'CreateOperationWizard.tsx');
    const bulk = read('components', 'modals', 'BulkAssignClearanceModal.tsx');

    it('7. CreateOperationWizard imports and renders the notice', () => {
        expect(wizard).toContain("from '../../lib/markerSyncVisibility'");
        expect(wizard).toContain('isSyncRestrictedWithheld(limitingMarkers)');
        expect(wizard).toContain('not shown at your permission level');
    });

    it('8. BulkAssignClearanceModal imports and renders the notice', () => {
        expect(bulk).toContain("from '../../lib/markerSyncVisibility'");
        expect(bulk).toContain('isSyncRestrictedWithheld(limitingMarkers)');
        expect(bulk).toContain('not shown at your permission level');
    });

    it('9. both keep the per-marker chip — it still populates for an admin:access viewer', () => {
        // The strict gate does NOT make these branches dead: an Admin holds
        // admin:access and still gets the key. Deleting them as "unreachable"
        // would regress the Admin's view, which is the mistake this pins against.
        expect(wizard).toContain('m.syncRestricted &&');
        expect(bulk).toContain('m.syncRestricted &&');
    });

    it('10. neither surface uses the falsy test the predicate exists to avoid', () => {
        expect(wizard).not.toContain('!m.syncRestricted');
        expect(bulk).not.toContain('!m.syncRestricted');
    });
});
