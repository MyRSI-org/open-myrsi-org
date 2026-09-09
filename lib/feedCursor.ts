/**
 * Validation for the federation feed's `?since=` cursor.
 *
 * WHY THIS IS NOT COSMETIC. The cursor lands in `.gt('created_at', since)` and the
 * response carries `_meta.fetchedAt`, which the consumer stores as its NEXT cursor. So a
 * cursor the server accepts but cannot honour does not fail loudly — it returns an empty
 * or short page, and the consumer advances its cursor past rows it never received. The
 * data loss is silent, permanent for that peer, and looks like "there was no new intel".
 *
 * Two shapes cause it, and neither was rejected before:
 *   * A malformed timestamp. PostgREST raises 22007 on the comparison; depending on how
 *     the caller handles the error that is either a 500 or an empty page.
 *   * A FUTURE timestamp. Perfectly valid SQL, matches nothing, and every subsequent
 *     pull from that peer is empty until the wall clock catches up. A peer whose clock
 *     is a day fast silently loses a day of intel.
 *
 * So the contract is: an absent cursor means "from the beginning" and is fine; a cursor
 * that is present but not honourable is a 400, because telling the caller their cursor
 * is wrong is the only outcome that does not lose data.
 *
 * Dependency-free so it compiles under both tsconfigs and is directly testable.
 */

/**
 * Clock skew allowance between two independently hosted instances. A peer a few seconds
 * ahead is normal and must not be rejected; a peer hours ahead is a misconfiguration
 * that will cost it intel, and it should hear about it.
 */
export const FEED_CURSOR_MAX_SKEW_MS = 5 * 60_000;

export type FeedCursorResult =
    | { ok: true; since: string | undefined }
    | { ok: false; reason: 'malformed' | 'future'; message: string };

export function parseFeedCursor(raw: unknown, nowMs: number = Date.now()): FeedCursorResult {
    // Absent, empty, or repeated (?since=a&since=b arrives as an array) all mean
    // "no cursor". A repeated param is ambiguous rather than malformed — picking one
    // silently is how you serve the wrong window — so treat it as absent and serve from
    // the beginning, which over-serves rather than under-serves. Over-serving is safe
    // here: the consumer dedups, and the alternative loses rows.
    if (raw === undefined || raw === null) return { ok: true, since: undefined };
    if (Array.isArray(raw)) return { ok: true, since: undefined };
    if (typeof raw !== 'string') {
        return { ok: false, reason: 'malformed', message: 'The since cursor must be an ISO-8601 timestamp.' };
    }
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, since: undefined };

    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) {
        return { ok: false, reason: 'malformed', message: 'The since cursor must be an ISO-8601 timestamp.' };
    }
    if (ms > nowMs + FEED_CURSOR_MAX_SKEW_MS) {
        return {
            ok: false,
            reason: 'future',
            message: 'The since cursor is in the future; check this instance\'s clock. Refusing rather than returning an empty page you would treat as "no new intel".',
        };
    }
    // Normalise to the same ISO form the response advertises as the next cursor, so a
    // peer echoing our own fetchedAt back to us compares identically.
    return { ok: true, since: new Date(ms).toISOString() };
}
