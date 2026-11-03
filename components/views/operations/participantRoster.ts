import { OperationStatus } from '../../../types';

// The client's single definition of "who is on an operation's roster", so the read and
// action surfaces cannot drift apart the way they did when lib/db/mappers.ts started
// mapping the real `time_left` (it used to hardcode null, which made every row look
// active and hid every "active == on the roster" assumption below it).
//
// What `timeLeft` means — and it is narrow by construction on the server:
//   * leaving or being removed DELETES the operation_participants row, and
//   * only concluding an op (updateOperationStatus 'Concluded') stamps time_left on
//     every still-active row.
// So a row with `timeLeft` set is exactly "was on the roster when the op concluded".
//
// Two terms, mirroring the server (lib/db/ops.ts):
//   READ  — any roster row, current or former (hasOpReadParticipation). Owner-approved:
//           a former participant of a special operation keeps read access.
//   ACT   — an ACTIVE row only (`assertOpVisibleToUser` default access 'act',
//           `assertIsActiveParticipant`). Readiness, live status, seats, ORBAT
//           assignment and the other writes stay active-only.
//
// Pure and dependency-free (no React) so it is unit-testable on its own. Nothing here is
// a security boundary — the server re-checks every read and write; this only decides
// what the browser renders and which buttons it offers.

/** The minimum a roster row needs for these rules. */
export interface RosterRowLike {
    userId: number;
    timeLeft?: string | null;
}

/** The minimum an operation needs for these rules. `participants` is tolerated missing. */
export interface RosterOperationLike<P extends RosterRowLike> {
    status?: OperationStatus | string;
    participants?: readonly P[] | null;
    /** Not read by these rules (kept so callers can pass a whole operation). */
    isSpecial?: boolean | null;
}

/** Short marker shown beside a former participant in a rendered roster list. */
export const FORMER_PARTICIPANT_LABEL = 'Former';
/** Hover text for that marker — says exactly what "former" means here. */
export const FORMER_PARTICIPANT_TITLE = 'On the roster when this operation concluded';

/**
 * ACTIVE = no departure stamp. `== null` on purpose: the declared type is
 * `timeLeft?: string` (undefined when absent) while the mapper normalises to null,
 * and both mean "never stamped".
 */
export function isActiveRow(row: RosterRowLike): boolean {
    return row.timeLeft == null;
}

/** FORMER = stamped at conclusion. The exact complement of isActiveRow. */
export function isFormerRow(row: RosterRowLike): boolean {
    return !isActiveRow(row);
}

/** Every row of the roster, current and former. Always a fresh array. */
function rosterOf<P extends RosterRowLike>(op: RosterOperationLike<P>): P[] {
    return [...(op.participants ?? [])];
}

/** The ACTIVE rows only — the population every action / assignment control offers. */
export function activeRoster<P extends RosterRowLike>(op: RosterOperationLike<P>): P[] {
    return rosterOf(op).filter(isActiveRow);
}

/**
 * The rows a DISPLAY / READ surface renders and counts.
 *   Concluded op → the whole roster: everyone who was on it at conclusion (stamped),
 *                  plus anyone added afterwards. Without this a concluded op reads
 *                  as having had zero participants.
 *   Any other op → active rows only. A stamped row on a non-concluded op is left over
 *                  from an earlier conclusion (the op was reactivated) and is not
 *                  part of the current roster.
 */
export function displayRoster<P extends RosterRowLike>(op: RosterOperationLike<P>): P[] {
    return op.status === OperationStatus.Concluded ? rosterOf(op) : activeRoster(op);
}

/**
 * READ term: the user has ANY roster row on this op, current or former. Mirrors the
 * server's hasOpReadParticipation. A missing user id is never on the roster.
 */
export function isOnRoster<P extends RosterRowLike>(op: RosterOperationLike<P>, userId: number | null | undefined): boolean {
    if (userId == null) return false;
    return rosterOf(op).some(p => p.userId === userId);
}

/**
 * ACT term: the user has an ACTIVE row on this op. Gates every participant action
 * button (ready, RSVP, withdraw, live status). A missing user id is never active.
 */
export function isActiveParticipant<P extends RosterRowLike>(op: RosterOperationLike<P>, userId: number | null | undefined): boolean {
    if (userId == null) return false;
    return activeRoster(op).some(p => p.userId === userId);
}

/**
 * AAR term: may this participant add an After Action Review entry? The caller adds the
 * owner / operations:manage bypass.
 *
 * The AAR tab exists only on a CONCLUDED op, and concluding stamps every active row, so
 * the ACT term alone would leave nobody who took part able to contribute (only rows
 * added after conclusion). Mirrors the server's gate on operation:add_aar_entry, which
 * takes the READ term (owner decision, 15.7.1): any roster row, current or former, on a
 * special op or not. Clearance and limiting markers are enforced by the server.
 */
export function canAddAarEntry<P extends RosterRowLike>(op: RosterOperationLike<P>, userId: number | null | undefined): boolean {
    return isOnRoster(op, userId);
}

/** The user ids of every roster row, current and former. */
export function rosterUserIds<P extends RosterRowLike>(op: RosterOperationLike<P>): Set<number> {
    return new Set(rosterOf(op).map(p => p.userId));
}
