import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { render, screen, act } from '@testing-library/react';
import React from 'react';

// Phase 3 item 2 — AC-T3: the customer-facing availability gate, end to end.
//
// This is the nine-cell matrix the whole item exists to get right:
//   anyStaffOnDuty (server) ∈ { true, false, null }  ×  allUsers ∈ { [], [self], full }
//
// TWO HALVES, and the file says which is which rather than pretending both are
// rendered end-to-end:
//
//   HALF A (behavioural). MembersProvider is rendered for real, with DataCore
//   mocked, and the nine cells are driven through the SAME registered slice setters
//   the app uses. This is where the discriminator lives, so this is where the matrix
//   belongs. The key property: the server boolean WINS whenever it is a boolean, and
//   the roster is consulted only when it is not — so a rosterless customer whose
//   allUsers refills row-by-row off an unconditional user_update handler can never
//   flip the answer to a fabricated `false`.
//
//   HALF B (source ratchet). QuickRequestForm is a module-private component inside
//   DashboardView and CreateRequestModal pulls in the whole provider tree, so the two
//   consumers' THREE FRAMES are pinned structurally: the `null` branch must come
//   FIRST, must say "Availability Unknown", and must not carry the "no units on duty"
//   copy — because `null` means "we could not find out", and rendering it as "nobody
//   is on duty" asserts a fact we do not have while denying the customer's only flow.

const h = vi.hoisted(() => ({
    setters: new Map<string, (data: Record<string, unknown>) => void>(),
}));

vi.mock('../contexts/DataCoreContext', () => ({
    useDataCore: () => ({
        rpcAction: async () => ({}),
        registerSliceSetter: (key: string, fn: (data: Record<string, unknown>) => void) => {
            h.setters.set(key, fn);
            return () => { h.setters.delete(key); };
        },
    }),
}));

import { MembersProvider, useMembers } from '../contexts/MembersContext';
import { UserRole } from '../types';

const Probe: React.FC = () => {
    const { anyStaffOnDuty } = useMembers();
    return <span data-testid="answer">{anyStaffOnDuty === null ? 'null' : String(anyStaffOnDuty)}</span>;
};

const staffOnDuty = { id: 2, name: 'Responder', role: UserRole.Member, isDuty: true };
const staffOffDuty = { id: 3, name: 'Resting', role: UserRole.Member, isDuty: false };
const self = { id: 5, name: 'Customer', role: UserRole.Client, isDuty: false };

const ROSTERS: Record<string, unknown[]> = {
    empty: [],
    selfOnly: [self],
    // A "full" roster whose duty state DISAGREES with every server answer below, so a
    // cell that reads the roster instead of the server is impossible to miss.
    full: [self, staffOnDuty, staffOffDuty],
};

function apply(payload: Record<string, unknown>) {
    act(() => {
        for (const fn of h.setters.values()) fn(payload);
    });
}

beforeEach(() => {
    h.setters.clear();
});

describe('AC-T3 half A — the tri-state × roster matrix (behavioural)', () => {
    for (const [rosterName, roster] of Object.entries(ROSTERS)) {
        it(`server=true  roster=${rosterName} → true (open the form)`, () => {
            render(<MembersProvider><Probe /></MembersProvider>);
            apply({ users: roster, anyStaffOnDuty: true });
            expect(screen.getByTestId('answer').textContent).toBe('true');
        });

        it(`server=false roster=${rosterName} → false (Services Unavailable)`, () => {
            // The cell that a truthiness-guarded setter would silently drop, leaving the
            // customer's form open against an empty room. `full` also contains an on-duty
            // staffer, so a roster-first derivation would answer `true` here.
            render(<MembersProvider><Probe /></MembersProvider>);
            apply({ users: roster, anyStaffOnDuty: false });
            expect(screen.getByTestId('answer').textContent).toBe('false');
        });
    }

    it('server=null roster=empty → null (genuinely unknown: no answer and nothing to derive from)', () => {
        render(<MembersProvider><Probe /></MembersProvider>);
        apply({ users: [], anyStaffOnDuty: null });
        expect(screen.getByTestId('answer').textContent).toBe('null');
    });

    it('server=null roster=selfOnly → false (the roster fallback: a Client is not staff)', () => {
        render(<MembersProvider><Probe /></MembersProvider>);
        apply({ users: ROSTERS.selfOnly, anyStaffOnDuty: null });
        expect(screen.getByTestId('answer').textContent).toBe('false');
    });

    it('server=null roster=full → true (the roster fallback finds the on-duty member)', () => {
        render(<MembersProvider><Probe /></MembersProvider>);
        apply({ users: ROSTERS.full, anyStaffOnDuty: null });
        expect(screen.getByTestId('answer').textContent).toBe('true');
    });

    it('a null AFTER a boolean leaves the last known answer standing — it does not blank it', () => {
        // The server sends `null` for "the probe faulted". Writing that over a good
        // answer would turn one flaky query into a denied customer flow.
        render(<MembersProvider><Probe /></MembersProvider>);
        apply({ users: [], anyStaffOnDuty: true });
        expect(screen.getByTestId('answer').textContent).toBe('true');
        apply({ anyStaffOnDuty: null });
        expect(screen.getByTestId('answer').textContent).toBe('true');
    });

    it('the cold-start default is null, not false', () => {
        // Before any response arrives a rosterless customer must see the honest
        // "unknown" frame, never "there are no units on duty".
        render(<MembersProvider><Probe /></MembersProvider>);
        expect(screen.getByTestId('answer').textContent).toBe('null');
    });

    it('a roster that refills row-by-row CANNOT override a server boolean', () => {
        // mergeUsersSlice APPENDS rows not already present, off a user_update handler
        // attached unconditionally. A "do I have a roster?" heuristic would flip the
        // discriminator the instant allUsers crossed its threshold and derive `false`
        // from two arbitrary rows — permanent denial of the customer flow, in this file,
        // looking like somebody else's bug.
        render(<MembersProvider><Probe /></MembersProvider>);
        apply({ anyStaffOnDuty: true });
        apply({ users: [self] });
        expect(screen.getByTestId('answer').textContent).toBe('true');
        apply({ users: [self, staffOffDuty] });
        expect(screen.getByTestId('answer').textContent).toBe('true');
    });
});

describe('AC-T3 half B — the three frames, in order (source ratchet)', () => {
    const root = resolve(__dirname, '..');
    const dashboardView = readFileSync(resolve(root, 'components', 'views', 'operations', 'DashboardView.tsx'), 'utf8');
    const createRequestModal = readFileSync(resolve(root, 'components', 'modals', 'CreateRequestModal.tsx'), 'utf8');

    it('DashboardView QuickRequestForm: unknown frame first, then unavailable, then the form', () => {
        const nullIdx = dashboardView.indexOf('if (anyStaffOnDuty === null) {');
        const falseIdx = dashboardView.indexOf('if (!anyStaffOnDuty) {');
        expect(nullIdx).toBeGreaterThan(-1);
        expect(falseIdx).toBeGreaterThan(nullIdx);
        const unknownFrame = dashboardView.slice(nullIdx, falseIdx);
        expect(unknownFrame).toContain('Availability Unknown');
        // `null` must NOT render the "nobody on duty" copy — that asserts a fact we do
        // not have — and must NOT open the form: unknown must not widen.
        expect(unknownFrame).not.toContain('Services Unavailable');
        expect(unknownFrame).not.toContain('units on duty.');
        // …and it must offer the stranded customer a way out. refreshMainState() is
        // {force:true}, so it bypasses the 2s dedupe and really re-probes.
        expect(unknownFrame).toContain('refreshMainState()');
        expect(dashboardView.slice(falseIdx)).toContain('Services Unavailable');
    });

    it('CreateRequestModal: the same three frames, Client-scoped', () => {
        const nullIdx = createRequestModal.indexOf('if (isClient && anyStaffOnDuty === null) {');
        const falseIdx = createRequestModal.indexOf('if (isClient && !anyStaffOnDuty) {');
        expect(nullIdx).toBeGreaterThan(-1);
        expect(falseIdx).toBeGreaterThan(nullIdx);
        const unknownFrame = createRequestModal.slice(nullIdx, falseIdx);
        expect(unknownFrame).toContain('Availability Unknown');
        expect(unknownFrame).not.toContain('Service Unavailable');
        expect(unknownFrame).toContain('refreshMainState()');
        // Both gates are Client-only: staff open this modal on a customer's behalf and
        // must never be blocked by the customer-facing availability answer.
        expect(createRequestModal).toContain('isClient &&');
    });
});
