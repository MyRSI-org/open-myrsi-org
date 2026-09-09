import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The operation detail view merges TWO sources with very different freshness:
//
//   leg A — `listOp`, from the row-slice path. Undebounced; lands within one round trip of a
//           realtime broadcast.
//   leg B — `fullDetails`, from the `operation:get_details` RPC. Debounced.
//
// Sub-resources (phases, tasks, command nodes, board elements, …) exist only on leg B and must
// come from it. But every column that lives on the `operations` table is carried by BOTH — and
// for those, leg A is at worst as fresh as leg B and usually fresher. Preferring leg B for them
// renders a value the client already knows is stale.
//
// That was live for six fields. `commsPlan` had been fixed by hand, with a comment explaining
// precisely this, while `roe`, `commanderNotes` and the four `aar*` fields still preferred the
// stale source — one instance patched, the class left open.
//
// Source-text assertions because the merge is a `useMemo` inside a 1000-line view component;
// standing a React tree up to assert a field-precedence rule would test the harness more than
// the rule.

const SRC = readFileSync(
    join(resolve(__dirname, '..'), 'components', 'views', 'operations', 'OperationDetailView.tsx'),
    'utf8',
);

/** Columns on the `operations` table — carried by BOTH legs, so leg A must win. */
const OPERATIONS_TABLE_FIELDS = [
    'roe',
    'commanderNotes',
    'aarSummary',
    'aarLessonsLearned',
    'aarSubmittedAt',
    'aarSubmittedBy',
] as const;

/** Sub-resources that exist ONLY on leg B. Taking these from listOp would render them empty. */
const DETAIL_ONLY_FIELDS = [
    'phases',
    'scheduleEntries',
    'tasks',
    'commandNodes',
    'boardElements',
    'logistics',
    'aarEntries',
    'alliedOrgs',
] as const;

describe('operation detail merge — the fresher source wins', () => {
    it.each(OPERATIONS_TABLE_FIELDS)('%s prefers the row-slice leg, not the debounced one', (field) => {
        // Must NOT be `fullDetails.x ?? listOp.x` — that is the stale-wins direction.
        expect(SRC, `${field} must not prefer fullDetails`).not.toContain(`${field}: fullDetails.${field} ?? listOp.${field}`);
        expect(SRC, `${field} must prefer listOp`).toContain(`${field}: listOp.${field} ?? fullDetails.${field}`);
    });

    // commsPlan is an array, so emptiness rather than nullishness is the right test — keeping
    // its original idiom rather than flattening it into the `??` form.
    it('commsPlan keeps its length-aware preference for the row-slice leg', () => {
        expect(SRC).toContain('commsPlan: listOp.commsPlan?.length ? listOp.commsPlan : fullDetails.commsPlan');
    });

    it.each(DETAIL_ONLY_FIELDS)('%s still comes from the detail leg', (field) => {
        expect(SRC).toContain(`${field}: fullDetails.${field}`);
    });
});

describe('operation detail refresh cannot be starved', () => {
    // Trailing-ONLY debounce re-armed its timer on every broadcast, so a stream of events closer
    // together than the delay starved the refetch forever. That stream is the normal case:
    // pre-mission planning emits a continuous burst of operation_update.
    it('debounces on the leading edge as well as the trailing edge', () => {
        const effect = SRC.slice(SRC.indexOf("'app:realtime:operation-detail-refresh'") - 2200);
        expect(effect).toContain('lastRun');
        expect(effect).toMatch(/now - lastRun >= DETAIL_REFRESH_MS/);
        // The trailing half must survive — dropping it turns a burst into one call per event.
        expect(effect).toContain('window.setTimeout(');
    });

    // Two get_details calls can be in flight at once (mount, realtime refresh, post-action
    // refresh). Without a guard a slow earlier response overwrites a fresh later one and the
    // plan silently reverts.
    it('guards against an out-of-order response clobbering a fresher one', () => {
        expect(SRC).toContain('detailGenRef');
        expect(SRC).toContain('const gen = ++detailGenRef.current');
        expect(SRC).toContain('if (gen !== detailGenRef.current) return');
    });

    // The cleanup must still cancel a pending trailing call, or a late response setStates after
    // unmount.
    it('still cancels a pending refresh on unmount', () => {
        const effect = SRC.slice(SRC.indexOf("'app:realtime:operation-detail-refresh'") - 2200);
        expect(effect).toContain('window.clearTimeout(timer)');
    });
});
