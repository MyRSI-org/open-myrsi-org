import { describe, it, expect } from 'vitest';
import { OperationStatus } from '../types';
import {
    FORMER_PARTICIPANT_LABEL,
    FORMER_PARTICIPANT_TITLE,
    activeRoster,
    canAddAarEntry,
    displayRoster,
    isActiveParticipant,
    isActiveRow,
    isFormerRow,
    isOnRoster,
    rosterUserIds,
    type RosterRowLike,
} from '../components/views/operations/participantRoster';

// The client's single definition of the two participation terms, mirroring the server:
//   READ — any roster row, current or former (hasOpReadParticipation)
//   ACT  — an ACTIVE row only (time_left IS NULL)
// time_left is stamped ONLY when an op concludes; leaving / removal deletes the row. So a
// stamped row is "was on the roster when the op concluded".

const STAMP = '2026-11-01T10:00:00.000Z';

const active = (userId: number): RosterRowLike => ({ userId, timeLeft: null });
const unstamped = (userId: number): RosterRowLike => ({ userId }); // timeLeft absent (declared type)
const former = (userId: number): RosterRowLike => ({ userId, timeLeft: STAMP });

describe('isActiveRow / isFormerRow', () => {
    it('a null stamp is active, not former', () => {
        expect(isActiveRow(active(1))).toBe(true);
        expect(isFormerRow(active(1))).toBe(false);
    });

    it('an ABSENT stamp is active too (the declared type is `timeLeft?: string`)', () => {
        expect(isActiveRow(unstamped(1))).toBe(true);
        expect(isFormerRow(unstamped(1))).toBe(false);
    });

    it('a stamped row is former, not active', () => {
        expect(isActiveRow(former(1))).toBe(false);
        expect(isFormerRow(former(1))).toBe(true);
    });
});

describe('activeRoster', () => {
    it('keeps only the unstamped rows, in roster order', () => {
        const op = { status: OperationStatus.Active, participants: [former(1), active(2), unstamped(3), former(4)] };
        expect(activeRoster(op).map(p => p.userId)).toEqual([2, 3]);
    });

    it('is active-only on a CONCLUDED op too — it is the action population, not the display one', () => {
        const op = { status: OperationStatus.Concluded, participants: [former(1), active(2)] };
        expect(activeRoster(op).map(p => p.userId)).toEqual([2]);
    });

    it('tolerates a missing or null participants array', () => {
        expect(activeRoster({ status: OperationStatus.Active })).toEqual([]);
        expect(activeRoster({ status: OperationStatus.Active, participants: null })).toEqual([]);
    });
});

describe('displayRoster', () => {
    it('a CONCLUDED op shows the whole roster — everyone stamped at conclusion plus anyone added after', () => {
        const rows = [former(1), former(2), active(3)];
        const op = { status: OperationStatus.Concluded, participants: rows };
        const shown = displayRoster(op);
        expect(shown.map(p => p.userId)).toEqual([1, 2, 3]);
        // Same row objects (callers render their fields) but a FRESH array, so a caller that
        // sorts its result in place cannot reorder the operation's own participants.
        expect(shown[0]).toBe(rows[0]);
        expect(shown).not.toBe(rows);
        shown.reverse();
        expect(rows.map(p => p.userId)).toEqual([1, 2, 3]);
    });

    it.each([OperationStatus.Planning, OperationStatus.Scheduled, OperationStatus.Active])(
        'a %s op shows active rows only — a stamp left over from an earlier conclusion is not on the current roster',
        (status) => {
            const op = { status, participants: [former(1), active(2), unstamped(3)] };
            expect(displayRoster(op).map(p => p.userId)).toEqual([2, 3]);
        },
    );

    it('an op with no status is treated as not concluded', () => {
        expect(displayRoster({ participants: [former(1), active(2)] }).map(p => p.userId)).toEqual([2]);
    });

    it('tolerates a missing participants array on either branch', () => {
        expect(displayRoster({ status: OperationStatus.Concluded })).toEqual([]);
        expect(displayRoster({ status: OperationStatus.Active, participants: null })).toEqual([]);
    });
});

describe('isOnRoster — the READ term', () => {
    const op = { status: OperationStatus.Concluded, participants: [former(7), active(8)] };

    it('a former participant IS on the roster (owner-approved read access)', () => {
        expect(isOnRoster(op, 7)).toBe(true);
    });

    it('an active participant is on the roster', () => {
        expect(isOnRoster(op, 8)).toBe(true);
    });

    it('a member with no row is not', () => {
        expect(isOnRoster(op, 9)).toBe(false);
    });

    it('a missing viewer id is never on the roster — even against a row with no userId match', () => {
        expect(isOnRoster(op, undefined)).toBe(false);
        expect(isOnRoster(op, null)).toBe(false);
        // A malformed row whose userId is itself missing must not match an absent viewer.
        const malformed = { participants: [{ timeLeft: null } as unknown as RosterRowLike] };
        expect(isOnRoster(malformed, undefined)).toBe(false);
    });

    it('tolerates a missing participants array', () => {
        expect(isOnRoster({ status: OperationStatus.Active }, 7)).toBe(false);
    });
});

describe('isActiveParticipant — the ACT term', () => {
    const op = { status: OperationStatus.Concluded, participants: [former(7), active(8), unstamped(10)] };

    it('a former participant is NOT a participant for actions', () => {
        expect(isActiveParticipant(op, 7)).toBe(false);
    });

    it('an active participant is (null or absent stamp)', () => {
        expect(isActiveParticipant(op, 8)).toBe(true);
        expect(isActiveParticipant(op, 10)).toBe(true);
    });

    it('a member with no row is not', () => {
        expect(isActiveParticipant(op, 9)).toBe(false);
    });

    it('a missing viewer id is never active — even against a row with no userId', () => {
        expect(isActiveParticipant(op, undefined)).toBe(false);
        expect(isActiveParticipant(op, null)).toBe(false);
        const malformed = { participants: [{ timeLeft: null } as unknown as RosterRowLike] };
        expect(isActiveParticipant(malformed, undefined)).toBe(false);
    });

    it('tolerates a missing participants array', () => {
        expect(isActiveParticipant({ status: OperationStatus.Active, participants: null }, 8)).toBe(false);
    });
});

describe('canAddAarEntry — the AAR contribution term (concluded ops only)', () => {
    // The AAR tab exists only on a CONCLUDED op, and concluding stamps every active row.
    // The server gate on operation:add_aar_entry is assertOpVisibleToUser with the READ
    // term (owner decision): any roster row, current or former, special op or not.
    const concluded = (isSpecial: boolean | undefined, ...participants: RosterRowLike[]) =>
        ({ status: OperationStatus.Concluded, isSpecial, participants });

    it('a FORMER participant of a concluded NON-special op may contribute', () => {
        expect(canAddAarEntry(concluded(false, former(7), former(8)), 7)).toBe(true);
    });

    it('a missing isSpecial reads as non-special', () => {
        expect(canAddAarEntry(concluded(undefined, former(7)), 7)).toBe(true);
        expect(canAddAarEntry({ participants: [former(7)], isSpecial: null }, 7)).toBe(true);
    });

    it('a FORMER participant of a concluded SPECIAL op may contribute too (the server read term)', () => {
        expect(canAddAarEntry(concluded(true, former(7), active(8)), 7)).toBe(true);
    });

    it('an ACTIVE row (added after conclusion) may contribute on a special op too', () => {
        expect(canAddAarEntry(concluded(true, former(8), active(7)), 7)).toBe(true);
        expect(canAddAarEntry(concluded(true, unstamped(7)), 7)).toBe(true);
    });

    it('a non-participant may not, special or not', () => {
        expect(canAddAarEntry(concluded(false, former(8), active(9)), 7)).toBe(false);
        expect(canAddAarEntry(concluded(true, former(8), active(9)), 7)).toBe(false);
    });

    it('a missing viewer id never matches, even a row with no userId', () => {
        const malformed = { status: OperationStatus.Concluded, isSpecial: false, participants: [{ timeLeft: STAMP } as unknown as RosterRowLike] };
        expect(canAddAarEntry(malformed, undefined)).toBe(false);
        expect(canAddAarEntry(concluded(false, former(7)), null)).toBe(false);
    });

    it('tolerates a missing participants array', () => {
        expect(canAddAarEntry({ status: OperationStatus.Concluded, isSpecial: false, participants: null }, 7)).toBe(false);
    });
});

describe('rosterUserIds', () => {
    it('collects every row, current AND former', () => {
        const ids = rosterUserIds({ participants: [former(1), active(2), unstamped(3)] });
        expect([...ids].sort()).toEqual([1, 2, 3]);
    });

    it('returns a fresh, mutable set (callers add the owner to it)', () => {
        const op = { participants: [active(2)] };
        const a = rosterUserIds(op);
        a.add(99);
        expect([...rosterUserIds(op)]).toEqual([2]);
    });

    it('is empty for a missing participants array', () => {
        expect(rosterUserIds({}).size).toBe(0);
    });
});

describe('former-participant marker copy', () => {
    it('says what "former" means here', () => {
        expect(FORMER_PARTICIPANT_LABEL).toBe('Former');
        expect(FORMER_PARTICIPANT_TITLE).toBe('On the roster when this operation concluded');
    });
});
