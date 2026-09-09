import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { makeGenGuard, makeSliceCoalescer } from '../lib/sliceCoalescer';

// Phase 3 item 2 — the CLIENT half: the self-identity path and the availability
// scalar's plumbing.
//
// HARNESS, stated plainly (nobody should mistake this for more than it is):
//   * Most assertions here are SOURCE-TEXT RATCHETS in the style of
//     tests/permissionImplicationSites.test.ts. They exist because the wiring they
//     pin is invisible at runtime until the exact race it defends against happens,
//     and every one of them was written after a reviewer proposed removing the very
//     line it pins. A ratchet is cheap and catches the silent revert.
//   * The two ORDERING properties (a stale full fetch losing to a fresher targeted
//     one; a burst of duty flips not dropping the last flip) ARE asserted
//     behaviourally, but against lib/sliceCoalescer's primitives — the same
//     makeGenGuard / makeSliceCoalescer instances the contexts use. The ratchets then
//     pin that the contexts really use them. Rendering the whole provider tree to
//     prove the composition is out of scope for this file; tests/clientAvailabilityGates
//     covers the rendered consumer end.
//
// The behaviour being defended, in one line each:
//   - refreshSelfIdentity replaced a FOUR-FIELD pick that structurally could not
//     carry a role or permission change — the change that matters once the roster
//     stops being the identity carrier.
//   - `permissions` + `role` are the realtime channel REBUILD KEY, so an out-of-order
//     write re-keys the private channel DOWNWARD, silently, for the rest of the session.
//   - The availability scalar is `boolean | null`, and `null` must never collapse to
//     `false`: a read error must not read as "nobody is on duty" at the layer the user
//     actually sees.

const root = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(resolve(root, ...p), 'utf8');

const sessionCtx = read('contexts', 'SessionContext.tsx');
const dataCtx = read('contexts', 'DataContext.tsx');
const membersCtx = read('contexts', 'MembersContext.tsx');
const dashboardView = read('components', 'views', 'operations', 'DashboardView.tsx');
const createRequestModal = read('components', 'modals', 'CreateRequestModal.tsx');
const apiService = read('services', 'apiService.ts');

/** Body of a top-level `const <name> = ...` / `function <name>` up to the next
 *  top-level declaration. CRLF-tolerant: this repo is developed on Windows. */
function sliceFrom(src: string, marker: string, endMarkers: string[]): string {
    const start = src.indexOf(marker);
    expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
    let end = src.length;
    for (const m of endMarkers) {
        const i = src.indexOf(m, start + marker.length);
        if (i > -1 && i < end) end = i;
    }
    return src.slice(start, end);
}

const refreshSelfIdentityBody = sliceFrom(
    sessionCtx,
    'const refreshSelfIdentity = useCallback',
    ['\n    // Register refreshUser with RequestsContext'],
);

describe('20-23. SessionContext — the self-identity path', () => {
    it('20. refreshes the self identity WHOLESALE, not with a hand-maintained field pick', () => {
        expect(refreshSelfIdentityBody).toContain('{ ...prev, ...fullUser }');
        // The four-field pick this replaced could carry heavy arrays and nothing else.
        // user_detail for SELF is a strict superset of the lite roster row, so a spread
        // cannot DROP a key `prev` had — which is exactly why the pick was unnecessary
        // as well as wrong.
        expect(refreshSelfIdentityBody).not.toContain('limitingMarkers: fullUser.limitingMarkers');
        expect(refreshSelfIdentityBody).not.toContain('conductRecord: fullUser.conductRecord');
    });

    it('21. never escalates to refreshUser() — that path is fail-BROKEN, not fail-closed', () => {
        // refreshUser() calls setRealtimeToken(...) unconditionally, and BOTH payloads a
        // faulting server returns omit realtimeToken — so escalating on a fault tears
        // the private realtime channel down for the rest of the session. A stale
        // identity is a UX defect; a dead channel is a broken app.
        expect(refreshSelfIdentityBody).not.toContain('refreshUser');
    });

    it('21b. it is generation-guarded on BOTH sides of the await', () => {
        const beginIdx = refreshSelfIdentityBody.indexOf('identityGuard.begin()');
        const awaitIdx = refreshSelfIdentityBody.indexOf('await fetchUserDetail(');
        const applyIdx = refreshSelfIdentityBody.indexOf('identityGuard.tryApply(');
        const setIdx = refreshSelfIdentityBody.indexOf('setCurrentUser(');
        expect(beginIdx).toBeGreaterThan(-1);
        expect(beginIdx).toBeLessThan(awaitIdx);
        expect(awaitIdx).toBeLessThan(applyIdx);
        expect(applyIdx).toBeLessThan(setIdx);
    });

    it('22. onUserUpdate keeps the bulk `userIds` targeting (open-is-ahead behaviour)', () => {
        // This build understands bulk arrays and the hosted platform does not. A naive
        // port that dropped `userIds` would make every bulk broadcast target everyone.
        expect(sessionCtx).toContain('detail.userIds');
        expect(sessionCtx).toContain('const targetsMe = !ids || ids.includes(currentUser.id);');
        expect(sessionCtx).toContain('void refreshSelfIdentity(currentUser.id);');
    });

    it('23. the roster reconcile SURVIVES — this is a parallel path, not a replacement', () => {
        expect(sessionCtx).toContain('allUsers.find(u => u.id === currentUser?.id)');
        for (const field of [
            'voiceChannelName', 'isDuty', 'roleId', 'role', 'permissions',
            'reputation', 'clearanceLevel', 'rank', 'unit', 'position', 'secondaryPosition',
        ]) {
            expect(sessionCtx, `hasChanged lost its ${field} comparison`).toContain(`updatedUser.${field}`);
        }
        // …and it claims a generation, so a stale in-flight refreshSelfIdentity response
        // cannot overwrite this synchronous, roster-derived write.
        expect(sessionCtx).toContain('identityGuard.tryApply(identityGuard.begin());');
    });
});

describe('24-25. MembersContext — the tri-state, server-primary predicate', () => {
    it('24. the setter is typeof-boolean guarded — `false` lands, `null` does not', () => {
        expect(membersCtx).toContain("registerSliceSetter('anyStaffOnDuty'");
        expect(membersCtx).toContain("typeof data.anyStaffOnDuty === 'boolean'");
        // A truthiness guard would drop `false` — the exact value that gates the
        // customer request form. `!== undefined` would write the server's `null`
        // ("the probe faulted") over a perfectly good last known answer.
        expect(membersCtx).not.toContain('if (data.anyStaffOnDuty)');
        expect(membersCtx).not.toContain('data.anyStaffOnDuty !== undefined');
    });

    it('25. the derivation is SERVER-PRIMARY with the roster only as a fallback', () => {
        const serverIdx = membersCtx.indexOf("typeof serverAnyStaffOnDuty === 'boolean'");
        const rosterIdx = membersCtx.indexOf('members.some(u => u.isDuty)');
        expect(serverIdx).toBeGreaterThan(-1);
        expect(rosterIdx).toBeGreaterThan(serverIdx);
        // A "do I have a roster?" heuristic would make this file's correctness a hostage
        // of the item-3 users_slice gate: mergeUsersSlice APPENDS rows not already
        // present, off a handler attached unconditionally, so a rosterless customer's
        // allUsers can refill row by row and flip the discriminator the instant it
        // crosses the threshold — deriving `false` from two arbitrary rows.
        expect(membersCtx).not.toContain('allUsers.length > 1');
        expect(membersCtx).toContain('anyStaffOnDuty: boolean | null;');
    });
});

describe('26-27, 30-31. DataContext — where the scalar is applied', () => {
    const presenceBranch = sliceFrom(
        dataCtx,
        "} else if (subset === 'users_presence') {",
        ["} else if (subset === 'warehouse') {"],
    );

    it('26. the scalar is fanned out BEFORE the rows.length > 0 guard', () => {
        // The empty-presence case IS the rosterless-caller case: a non-staff caller's
        // whole users_presence payload is one boolean and an empty array. Applying the
        // scalar inside the rows guard would deliver it to nobody who needs it.
        const applyIdx = presenceBranch.indexOf("applyStateData({ anyStaffOnDuty:");
        const rowsIdx = presenceBranch.indexOf('if (rows.length > 0)');
        expect(applyIdx).toBeGreaterThan(-1);
        expect(rowsIdx).toBeGreaterThan(-1);
        expect(applyIdx).toBeLessThan(rowsIdx);
    });

    it('27. the presence branch never hands the whole payload to applyStateData', () => {
        // applyStateData fans an object out to EVERY registered slice setter with no key
        // filtering (contexts/DataCoreContext.tsx), so a bare applyStateData(data) here
        // would offer the presence response to every domain setter in the app.
        expect(presenceBranch).not.toMatch(/applyStateData\(data\)/);
    });

    it('30. the generation guard covers all four carriers of the scalar', () => {
        // hydrateFullState (initial-state), the `main` branch, the users_presence branch
        // and the users_slice branch. refreshMainState() is {force:true} and fires on
        // EVERY mount of both customer gate components, so a slow `main` overtaking a
        // fresher presence answer is routine, not exotic — and the symptom is a customer
        // permanently pinned at "Services Unavailable" with no self-heal.
        expect(dataCtx).toContain('anyStaffOnDuty: GenGuard;');
        expect(dataCtx).toContain('anyStaffOnDuty: makeGenGuard(),');
        const guarded = dataCtx.match(/guards\.anyStaffOnDuty\.(begin|tryApply)\(/g) || [];
        expect(guarded.length).toBeGreaterThanOrEqual(8); // four sites × begin + tryApply
        expect(dataCtx).toContain('if (!guards.anyStaffOnDuty.tryApply(dutyGen)) delete data.anyStaffOnDuty;');
    });

    it('31. users_presence bypasses the drop-dedupe and uses the trailing-catch-up shape', () => {
        // The 2s dedupe stamps its timestamp at fetch START, has no pending flag and no
        // trailing fetch, so a second duty flip landing 0.1-2.0s into a fetch is dropped
        // PERMANENTLY — and neither `users` nor `user_presence` is in the realtime
        // publication, so duty_update has no postgres_changes twin for the dedupe to
        // suppress. For this subset the dedupe could only ever LOSE.
        expect(dataCtx).toContain('COALESCED_SUBSETS');
        expect(dataCtx).toContain("'users_presence',");
        expect(dataCtx).toContain('ROW_SLICE_SUBSETS.has(subset) || COALESCED_SUBSETS.has(subset)');
        expect(presenceBranch).toContain('presenceCoalescerRef.current');
    });
});

describe('28-29. the consumers — repointed, and NOT over-applied', () => {
    it('28. both customer gates read the shared predicate, not their own roster derivation', () => {
        expect(dashboardView).not.toContain('members.filter(m => m.isDuty)');
        expect(createRequestModal).not.toContain('members.some(m => m.isDuty)');
        expect(dashboardView).toContain('anyStaffOnDuty');
        expect(createRequestModal).toContain('anyStaffOnDuty');
        // The tri-state must reach the UI: an `=== null` branch in both, so "unknown"
        // renders as unknown rather than as "nobody on duty".
        expect(dashboardView).toContain('anyStaffOnDuty === null');
        expect(createRequestModal).toContain('anyStaffOnDuty === null');
    });

    it('29. the three STAFF duty surfaces keep their own roster derivations', () => {
        // ANTI-OVER-APPLICATION. These render a real NUMBER to staff who still hold the
        // roster. Repointing them at the boolean would be a regression, and the server
        // boolean deliberately uses a DIFFERENT definition of "staff" (role_id, not the
        // name-inferred tier), so the two are allowed to disagree on a custom-role org.
        const metrics = read('components', 'views', 'operations', 'dashboard', 'DashboardMetrics.tsx');
        const dutyRoster = read('components', 'views', 'personnel', 'DutyRosterView.tsx');
        const adminPanel = read('components', 'views', 'admin', 'AdminPanelView.tsx');
        expect(metrics).toContain('members.filter((m: any) => m.isDuty).length');
        expect(dutyRoster).toContain('members.filter(m => m.isDuty).length');
        expect(adminPanel).toContain('allUsers.filter(u => u.isDuty');
        for (const [name, src] of [['DashboardMetrics', metrics], ['DutyRosterView', dutyRoster], ['AdminPanelView', adminPanel]] as const) {
            expect(src, `${name} must not be repointed at the customer boolean`).not.toContain('anyStaffOnDuty');
        }
    });
});

describe('AC-T1 / AC-T2 / AC-T4 — the ordering properties, behaviourally', () => {
    it('AC-T1. a slow full fetch resolving AFTER a fresher targeted one does not apply', async () => {
        // The exact shape of the main-vs-users_presence race: `main` is a 14-way
        // Promise.all plus getAllSettings; users_presence is two small queries.
        const guard = makeGenGuard();
        const applied: string[] = [];

        const slowMain = (async () => {
            const gen = guard.begin();
            await new Promise(r => setTimeout(r, 20));
            if (guard.tryApply(gen)) applied.push('main:stale');
        })();
        const fastPresence = (async () => {
            const gen = guard.begin();
            await new Promise(r => setTimeout(r, 1));
            if (guard.tryApply(gen)) applied.push('presence:fresh');
        })();

        await Promise.all([slowMain, fastPresence]);
        expect(applied).toEqual(['presence:fresh']);
    });

    it('AC-T2. two duty flips 500ms apart — the SECOND value is the one that lands', async () => {
        // The dedupe this replaces would drop the second flip outright: the last staffer
        // goes off duty, someone comes on 500 ms later, and every customer reads
        // "Services Unavailable" while the org is crewed, with no self-heal until an
        // unrelated duty flip somewhere in the org.
        const seen: boolean[] = [];
        let serverAnswer = false;
        const coalescer = makeSliceCoalescer<string>(
            async () => {
                await new Promise(r => setTimeout(r, 5));
                seen.push(serverAnswer);
            },
            () => { throw new Error('unexpected coalescer error'); },
        );

        serverAnswer = false;
        const first = coalescer(['presence']);   // flip 1: last staffer goes off duty
        serverAnswer = true;                     // flip 2 happens while flip 1 is in flight
        const second = coalescer(['presence']);
        await Promise.all([first, second]);

        expect(seen.length).toBeGreaterThanOrEqual(1);
        expect(seen[seen.length - 1]).toBe(true); // the trailing catch-up carries the truth
    });

    it('AC-T4. two overlapping identity refreshes — the OLDER response loses', async () => {
        // The cluster's highest-severity failure: a user_detail response issued BEFORE a
        // promotion and resolved AFTER it re-writes role:'Client' plus the Client
        // permission array, and registerRealtimeAuth then re-keys the private realtime
        // channel DOWNWARD for the rest of the session — silently, with no error.
        const guard = makeGenGuard();
        let currentUser = { id: 1, role: 'Client', permissions: [] as string[] };

        const refresh = async (record: typeof currentUser, delayMs: number) => {
            const gen = guard.begin();
            await new Promise(r => setTimeout(r, delayMs));
            if (!guard.tryApply(gen)) return;
            currentUser = { ...currentUser, ...record };
        };

        const stale = refresh({ id: 1, role: 'Client', permissions: [] }, 25);
        const fresh = refresh({ id: 1, role: 'Member', permissions: ['user:view:roster'] }, 1);
        await Promise.all([stale, fresh]);

        expect(currentUser.role).toBe('Member');
        expect(currentUser.permissions).toEqual(['user:view:roster']);
    });
});

describe('AC-T10 — what a 403 on users_presence would actually cost', () => {
    it('handleResponseError branches on 401 ONLY — a 403 never clears the session', () => {
        // The recon spec claimed a 403 here becomes "an unhandled promise rejection".
        // It does not: apiService special-cases 401, and DataContext wraps the whole
        // subset switch in try/catch. The conclusion (keep users_presence answering 200
        // for every tier) stands; the mechanism is a caught error plus a wasted
        // round-trip on every duty flip in the org, for every rosterless caller.
        const body = sliceFrom(apiService, 'private handleResponseError(status: number)', ['\n    async ']);
        expect(body).toContain('if (status === 401)');
        expect(body).not.toContain('403');
        expect(dataCtx).toContain('} catch (error) {');
    });
});
