// Client-side copy and rules shared by the government views. Pure (no React, no
// contexts) so they are testable on their own and cannot drift between the two places
// a template can be applied, or the two places a vote can be cast.

/**
 * The confirmation shown before a government template is applied (admin Government tab
 * and the Restructure wizard). Applying deletes every position server-side, and the
 * database cascades from there — this says exactly what is lost before anyone agrees.
 */
export const TEMPLATE_APPLY_WARNING =
    'Applying a template replaces the whole government structure. Every current position is deleted, '
    + 'and with it every position holder, every election for those positions and every legislation vote '
    + 'cast from them. All branches are replaced by the template\'s. This cannot be undone, and it is '
    + 'refused while any executive order exists. Continue?';

/**
 * How a failed gov:cast_legislation_vote / gov:cast_motion_vote should be handled.
 *
 * The server stores the ballot FIRST and only then refreshes the cached tally. When the
 * refresh fails it rejects with "Your vote was recorded, but the … tally could not be
 * recounted/saved": the vote counts, it is just not reflected in the running totals yet.
 * A retry can only answer "already voted" — so neither of those may be offered as
 * something to try again:
 *   'recorded'      — show the server's message as-is, refetch, offer no retry
 *   'already-voted' — the ballot was stored on an earlier attempt; same handling
 *   'failed'        — nothing was stored; an ordinary failure
 */
export type VoteFailure = 'recorded' | 'already-voted' | 'failed';

export function classifyVoteFailure(message: unknown): VoteFailure {
    if (typeof message !== 'string') return 'failed';
    if (message.startsWith('Your vote was recorded')) return 'recorded';
    if (/already voted/i.test(message)) return 'already-voted';
    return 'failed';
}
