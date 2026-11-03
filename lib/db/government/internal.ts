
import { supabase, handleSupabaseError, broadcastToOrg } from '../common.js';
import { toUser, toMiniUser } from '../mappers.js';
import type { Tables, NullToUndefined } from '../rows.js';

// Embed shape accepted by toUser (a hydrated user row); reused across mappers.
type UserEmbed = Parameters<typeof toUser>[0];
import {
    GovernmentConfig, GovernmentBranch, GovernmentPosition,
    GovernmentPositionHolder, GovernmentElection, GovernmentElectionCandidate,
    GovernmentLegislation, GovernmentLegislationComment, GovernmentLegislationVote,
    GovernmentMotion,
    GovernmentType, GovernmentBranchType, PositionFillMethod,
    ElectionType, ElectionStatus, LegislationStatus, MotionStatus
} from '../../../types.js';
import { createHmac } from 'crypto';
import { IMPORTED_BALLOT_HASH_PREFIX } from '../importedBallot.js';
import { log as baseLog } from '../../log.js';

export const log = baseLog.child({ module: 'db.government' });

// ---------------------------------------------------------------------------
// Mappers (snake_case DB rows → camelCase interfaces)
// ---------------------------------------------------------------------------

export const toGovernmentConfig = (row: NullToUndefined<Tables<'government_configs'>>): GovernmentConfig => ({
    id: row.id,
    governmentType: row.government_type as unknown as GovernmentType,
    name: row.name,
    description: row.description || undefined,
    constitutionContent: row.constitution_content || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

export const toGovernmentBranch = (row: NullToUndefined<Tables<'government_branches'>>): GovernmentBranch => ({
    id: row.id,
    name: row.name,
    branchType: row.branch_type as unknown as GovernmentBranchType,
    description: row.description || undefined,
    sortOrder: row.sort_order,
    icon: row.icon || undefined,
    createdAt: row.created_at,
    positions: undefined, // hydrated separately
});

export const toGovernmentPosition = (row: NullToUndefined<Tables<'government_positions'>>): GovernmentPosition => ({
    id: row.id,
    branchId: row.branch_id || undefined,
    name: row.name,
    description: row.description || undefined,
    fillMethod: row.fill_method as unknown as PositionFillMethod,
    termLengthDays: row.term_length_days || undefined,
    maxHolders: row.max_holders,
    icon: row.icon || undefined,
    sortOrder: row.sort_order,
    permissionsGranted: row.permissions_granted || [],
    canProposeLegislation: row.can_propose_legislation,
    canVoteLegislation: row.can_vote_legislation,
    canVetoLegislation: row.can_veto_legislation,
    canCallElections: row.can_call_elections,
    canIssueOrders: row.can_issue_orders || false,
    createdAt: row.created_at,
    currentHolders: undefined, // hydrated separately
} as GovernmentPosition);

export const toGovernmentPositionHolder = (row: NullToUndefined<Tables<'government_position_holders'>> & {
    user?: UserEmbed;
    appointed_by?: UserEmbed;
}): GovernmentPositionHolder => ({
    id: row.id,
    positionId: row.position_id,
    userId: row.user_id,
    user: row.user ? toMiniUser(row.user) : undefined,
    appointedById: row.appointed_by_id || undefined,
    appointedBy: row.appointed_by ? toMiniUser(row.appointed_by) : undefined,
    electionId: row.election_id || undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at || undefined,
    endReason: row.end_reason || undefined,
    createdAt: row.created_at,
});

// ---------------------------------------------------------------------------
// Broadcast helper
// ---------------------------------------------------------------------------

/** Slice discriminators carried on government_update broadcasts so clients
 *  refetch only the affected key-group instead of the full 8-key bundle.
 *  'structure' covers config + branches + positions + holders (cross-row
 *  hydrated together). Discriminator-only payloads, since the db-changes
 *  channel is anon-readable. */
export type GovernmentSlice = 'structure' | 'elections' | 'legislation' | 'motions';

/** Omit `slice` for wholesale changes (template apply) — clients fall back
 *  to the full 'government' refetch. */
export function broadcastGovernmentUpdate(slice?: GovernmentSlice) {
    broadcastToOrg('government_update', slice ? { slices: [slice] } : {});
}

// ---------------------------------------------------------------------------
// Shared select fragment
// ---------------------------------------------------------------------------

export const USER_HYDRATE = 'id, name, avatar_url, role_id, rank_id, rsi_handle';

// ---------------------------------------------------------------------------
// Government Templates (data)
// ---------------------------------------------------------------------------

interface TemplateBranch {
    name: string;
    branchType: GovernmentBranchType;
    icon: string;
    sortOrder: number;
    positions: {
        name: string;
        fillMethod: PositionFillMethod;
        termLengthDays?: number;
        maxHolders: number;
        icon?: string;
        sortOrder: number;
        canProposeLegislation?: boolean;
        canVoteLegislation?: boolean;
        canVetoLegislation?: boolean;
        canCallElections?: boolean;
        permissionsGranted?: string[];
    }[];
}

interface GovernmentTemplate {
    type: GovernmentType;
    name: string;
    description: string;
    branches: TemplateBranch[];
}

export const GOVERNMENT_TEMPLATES: GovernmentTemplate[] = [
    {
        type: GovernmentType.MilitaryJunta,
        name: 'High Command',
        description: 'A military junta led by a supreme commander with an appointed advisory council.',
        branches: [{
            name: 'High Command', branchType: GovernmentBranchType.Executive, icon: 'fa-solid fa-helmet-battle', sortOrder: 0,
            positions: [
                { name: 'Commander-in-Chief', fillMethod: PositionFillMethod.Appointed, maxHolders: 1, sortOrder: 0, icon: 'fa-solid fa-star', canCallElections: true, permissionsGranted: ['gov:manage'] },
                { name: 'Advisory Council Member', fillMethod: PositionFillMethod.Appointed, maxHolders: 3, sortOrder: 1, icon: 'fa-solid fa-shield-halved' },
            ]
        }]
    },
    {
        type: GovernmentType.CorporateBoard,
        name: 'Corporate Board',
        description: 'A corporate governance structure with an appointed CEO and elected board of directors.',
        branches: [
            {
                name: 'Executive', branchType: GovernmentBranchType.Executive, icon: 'fa-solid fa-building', sortOrder: 0,
                positions: [
                    { name: 'CEO', fillMethod: PositionFillMethod.Appointed, maxHolders: 1, sortOrder: 0, icon: 'fa-solid fa-crown', canVetoLegislation: true, canCallElections: true, permissionsGranted: ['gov:manage'] },
                ]
            },
            {
                name: 'Board of Directors', branchType: GovernmentBranchType.Legislative, icon: 'fa-solid fa-users-rectangle', sortOrder: 1,
                positions: [
                    { name: 'Board Director', fillMethod: PositionFillMethod.Elected, termLengthDays: 180, maxHolders: 5, sortOrder: 0, icon: 'fa-solid fa-user-tie', canProposeLegislation: true, canVoteLegislation: true, permissionsGranted: ['gov:elected_official'] },
                ]
            }
        ]
    },
    {
        type: GovernmentType.DemocraticRepublic,
        name: 'Republic',
        description: 'A democratic republic with elected executive, legislative senate, and appointed judiciary.',
        branches: [
            {
                name: 'Executive', branchType: GovernmentBranchType.Executive, icon: 'fa-solid fa-landmark-dome', sortOrder: 0,
                positions: [
                    { name: 'President', fillMethod: PositionFillMethod.Elected, termLengthDays: 90, maxHolders: 1, sortOrder: 0, icon: 'fa-solid fa-star', canVetoLegislation: true, canCallElections: true, permissionsGranted: ['gov:manage'] },
                    { name: 'Vice President', fillMethod: PositionFillMethod.Elected, termLengthDays: 90, maxHolders: 1, sortOrder: 1, icon: 'fa-solid fa-star-half-stroke' },
                ]
            },
            {
                name: 'Senate', branchType: GovernmentBranchType.Legislative, icon: 'fa-solid fa-landmark', sortOrder: 1,
                positions: [
                    { name: 'Senator', fillMethod: PositionFillMethod.Elected, termLengthDays: 120, maxHolders: 10, sortOrder: 0, icon: 'fa-solid fa-scroll', canProposeLegislation: true, canVoteLegislation: true, permissionsGranted: ['gov:elected_official'] },
                ]
            },
            {
                name: 'Judiciary', branchType: GovernmentBranchType.Judicial, icon: 'fa-solid fa-gavel', sortOrder: 2,
                positions: [
                    { name: 'Chief Justice', fillMethod: PositionFillMethod.Appointed, maxHolders: 1, sortOrder: 0, icon: 'fa-solid fa-scale-balanced' },
                ]
            }
        ]
    },
    {
        type: GovernmentType.ConstitutionalMonarchy,
        name: 'The Monarchy',
        description: 'A constitutional monarchy with a hereditary sovereign and an elected parliament.',
        branches: [
            {
                name: 'The Crown', branchType: GovernmentBranchType.Executive, icon: 'fa-solid fa-crown', sortOrder: 0,
                positions: [
                    { name: 'Monarch', fillMethod: PositionFillMethod.Hereditary, maxHolders: 1, sortOrder: 0, icon: 'fa-solid fa-crown', canVetoLegislation: true, canCallElections: true, permissionsGranted: ['gov:manage'] },
                    { name: 'Royal Advisor', fillMethod: PositionFillMethod.Appointed, maxHolders: 2, sortOrder: 1, icon: 'fa-solid fa-hat-wizard' },
                ]
            },
            {
                name: 'Parliament', branchType: GovernmentBranchType.Legislative, icon: 'fa-solid fa-landmark', sortOrder: 1,
                positions: [
                    { name: 'Member of Parliament', fillMethod: PositionFillMethod.Elected, termLengthDays: 90, maxHolders: 15, sortOrder: 0, icon: 'fa-solid fa-scroll', canProposeLegislation: true, canVoteLegislation: true, permissionsGranted: ['gov:elected_official'] },
                ]
            }
        ]
    },
    {
        type: GovernmentType.Westminster,
        name: 'Parliament',
        description: 'A Westminster-style parliamentary system with a bicameral legislature, PM elected by parliament, and proportional representation.',
        branches: [
            {
                name: 'Executive', branchType: GovernmentBranchType.Executive, icon: 'fa-solid fa-landmark-dome', sortOrder: 0,
                positions: [
                    { name: 'Prime Minister', fillMethod: PositionFillMethod.Elected, termLengthDays: 120, maxHolders: 1, sortOrder: 0, icon: 'fa-solid fa-star', canVetoLegislation: false, canCallElections: true, permissionsGranted: ['gov:manage', 'gov:elected_official'] },
                    { name: 'Deputy Prime Minister', fillMethod: PositionFillMethod.Appointed, maxHolders: 1, sortOrder: 1, icon: 'fa-solid fa-star-half-stroke' },
                ]
            },
            {
                name: 'House of Representatives', branchType: GovernmentBranchType.Legislative, icon: 'fa-solid fa-landmark', sortOrder: 1,
                positions: [
                    { name: 'Speaker of the House', fillMethod: PositionFillMethod.Elected, termLengthDays: 120, maxHolders: 1, sortOrder: 0, icon: 'fa-solid fa-gavel', canCallElections: true },
                    { name: 'Representative', fillMethod: PositionFillMethod.Elected, termLengthDays: 120, maxHolders: 15, sortOrder: 1, icon: 'fa-solid fa-scroll', canProposeLegislation: true, canVoteLegislation: true, permissionsGranted: ['gov:elected_official'] },
                ]
            },
            {
                name: 'Senate', branchType: GovernmentBranchType.Legislative, icon: 'fa-solid fa-building-columns', sortOrder: 2,
                positions: [
                    { name: 'Senate President', fillMethod: PositionFillMethod.Elected, termLengthDays: 180, maxHolders: 1, sortOrder: 0, icon: 'fa-solid fa-gavel' },
                    { name: 'Senator', fillMethod: PositionFillMethod.Elected, termLengthDays: 180, maxHolders: 10, sortOrder: 1, icon: 'fa-solid fa-scroll', canProposeLegislation: true, canVoteLegislation: true, permissionsGranted: ['gov:elected_official'] },
                ]
            }
        ]
    },
    {
        type: GovernmentType.Technocracy,
        name: 'Council of Experts',
        description: 'A merit-based government led by a council of subject-matter experts.',
        branches: [{
            name: 'Council of Experts', branchType: GovernmentBranchType.Executive, icon: 'fa-solid fa-microchip', sortOrder: 0,
            positions: [
                { name: 'Director', fillMethod: PositionFillMethod.Merit, maxHolders: 1, sortOrder: 0, icon: 'fa-solid fa-brain', canCallElections: true, canVetoLegislation: true, permissionsGranted: ['gov:manage'] },
                { name: 'Council Member', fillMethod: PositionFillMethod.Merit, maxHolders: 7, sortOrder: 1, icon: 'fa-solid fa-flask', canProposeLegislation: true, canVoteLegislation: true, permissionsGranted: ['gov:elected_official'] },
            ]
        }]
    },
    {
        type: GovernmentType.PirateCode,
        name: 'The Crew',
        description: 'A pirate code governance — the Captain is elected by the crew, challenges welcome.',
        branches: [{
            name: 'The Crew', branchType: GovernmentBranchType.Executive, icon: 'fa-solid fa-skull-crossbones', sortOrder: 0,
            positions: [
                { name: 'Captain', fillMethod: PositionFillMethod.Elected, termLengthDays: 60, maxHolders: 1, sortOrder: 0, icon: 'fa-solid fa-skull-crossbones', canCallElections: true, canVetoLegislation: true, permissionsGranted: ['gov:manage'] },
                { name: 'Quartermaster', fillMethod: PositionFillMethod.Elected, termLengthDays: 60, maxHolders: 1, sortOrder: 1, icon: 'fa-solid fa-coins', canProposeLegislation: true, canVoteLegislation: true, permissionsGranted: ['gov:elected_official'] },
                { name: 'First Mate', fillMethod: PositionFillMethod.Appointed, maxHolders: 1, sortOrder: 2, icon: 'fa-solid fa-anchor' },
            ]
        }]
    },
];

// ---------------------------------------------------------------------------
// Election Mappers
// ---------------------------------------------------------------------------

export const toGovernmentElection = (row: NullToUndefined<Tables<'government_elections'>> & {
    position?: Parameters<typeof toGovernmentPosition>[0] | null;
    created_by?: UserEmbed;
    candidates?: Parameters<typeof toGovernmentElectionCandidate>[0][] | null;
    has_voted?: boolean;
}): GovernmentElection => ({
    id: row.id,
    positionId: row.position_id,
    position: row.position ? toGovernmentPosition(row.position) : undefined,
    title: row.title,
    description: row.description || undefined,
    electionType: row.election_type as unknown as ElectionType,
    status: row.status as unknown as ElectionStatus,
    candidacyStart: row.candidacy_start || undefined,
    candidacyEnd: row.candidacy_end || undefined,
    votingStart: row.voting_start || undefined,
    votingEnd: row.voting_end || undefined,
    minCandidates: row.min_candidates,
    maxWinners: row.max_winners,
    minVoterTurnoutPct: row.min_voter_turnout_pct ? parseFloat(row.min_voter_turnout_pct as unknown as string) : undefined,
    minVoteThresholdPct: row.min_vote_threshold_pct ? parseFloat(row.min_vote_threshold_pct as unknown as string) : undefined,
    allowRunoff: row.allow_runoff,
    runoffTopN: row.runoff_top_n,
    parentElectionId: row.parent_election_id || undefined,
    isByElection: row.is_by_election,
    remainingTermDays: row.remaining_term_days || undefined,
    createdById: row.created_by_id,
    createdBy: row.created_by ? toMiniUser(row.created_by) : undefined,
    concludedAt: row.concluded_at || undefined,
    conclusionReason: row.conclusion_reason || undefined,
    certifiedById: row.certified_by_id || undefined,
    certifiedAt: row.certified_at || undefined,
    eligibleVoterCount: row.eligible_voter_count || undefined,
    totalVotesCast: row.total_votes_cast || undefined,
    candidates: row.candidates?.map(toGovernmentElectionCandidate),
    hasVoted: row.has_voted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

export const toGovernmentElectionCandidate = (row: NullToUndefined<Tables<'government_election_candidates'>> & {
    user?: UserEmbed;
}): GovernmentElectionCandidate => ({
    id: row.id,
    electionId: row.election_id,
    userId: row.user_id,
    user: row.user ? toMiniUser(row.user) : undefined,
    platformStatement: row.platform_statement || undefined,
    declaredAt: row.declared_at,
    withdrawnAt: row.withdrawn_at || undefined,
    isWinner: row.is_winner,
    voteCount: row.vote_count ?? undefined,
    votePercentage: row.vote_percentage ? parseFloat(row.vote_percentage as unknown as string) : undefined,
});

// ---------------------------------------------------------------------------
// Voter hash: keyed one-way hash to prevent double-voting without revealing
// identity.
//
// HMAC-SHA256 with a server-held secret (a pepper) — NOT a bare SHA-256. The
// inputs (electionId/motionId and userId) are small, enumerable integers and
// userIds are widely visible across the app, so an unkeyed digest of
// `${id}:${userId}` could be brute-forced from a DB-only leak of voter_hash to
// re-identify every "secret" ballot. Keying with a secret that never reaches the
// browser/DB makes that offline brute-force infeasible without also holding the
// env secret, so the secret-ballot guarantee actually holds.
//
// The message stays `${electionId}:${userId}` so the hash is still deterministic
// per deployment — this preserves the one-vote guards that key off voter_hash
// (uq_gov_election_vote / uq_gov_motion_vote_hash and the castElectionVote /
// castMotionVote pre-checks). Migration caveat: keying changes the output, so an
// in-flight secret-ballot MOTION cast before this change has a legacy unkeyed
// voter_hash and its caster could vote once more (voter_hash is the motion's
// only secret-ballot guard); elections are unaffected because the per-user
// voter_registry is their real one-vote guard.
//
// Fail closed: refuse to derive a hash when no server secret is configured
// rather than silently falling back to an unkeyed (brute-forceable) digest.
// SECRETS_ENCRYPTION_KEY is required + validated at server boot;
// JWT_SECRET is an acceptable fallback (also required + validated at boot).
// Read at call time so a key rotation/restart is picked up without re-import.
// ---------------------------------------------------------------------------

// ROTATION CAVEAT, and the reason BALLOT_PEPPER exists.
// This keys on SECRETS_ENCRYPTION_KEY, so ROTATING that key changes every hash this function
// produces. For a secret-ballot MOTION mid-vote, voter_hash is the only one-vote guard, so
// everyone who had already voted could vote a second time — the rotation would silently
// re-open the ballot. (Elections are unaffected: voter_registry is their real guard.)
//
// BALLOT_PEPPER lets an operator pin the OLD value across a rotation so dedup survives it.
// Unset, the behaviour is byte-identical to before — the same SECRETS_ENCRYPTION_KEY ||
// JWT_SECRET chain — so this changes nothing for a deployment that never rotates. The admin
// health check warns when a rotation is in flight while a secret ballot is in 'Voting'.
export function computeVoterHash(electionId: number, userId: number): string {
    const secret = process.env.BALLOT_PEPPER || process.env.SECRETS_ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('Cannot compute voter hash: BALLOT_PEPPER / SECRETS_ENCRYPTION_KEY (or JWT_SECRET) is not configured — secret ballots require a server-held key to stay non-de-anonymizable.');
    }
    return createHmac('sha256', secret)
        .update(`${electionId}:${userId}`)
        .digest('hex');
}

// ---------------------------------------------------------------------------
// Tallying Algorithms
// ---------------------------------------------------------------------------

export interface TallyResult {
    winners: { candidateId: number; voteCount: number; percentage: number }[];
    allResults: { candidateId: number; voteCount: number; percentage: number }[];
    totalVotes: number;
    isConclusive: boolean;
    reason?: string;
    /**
     * Set when the count itself ends on a tie that decides who is seated (the
     * ranked-choice count reports it here; concludeElection detects a seat-cutoff tie
     * in the other methods with findSeatCutoffTie). concludeElection sends either
     * through its tie path: a runoff if allowed, otherwise no clear winner.
     */
    tie?: SeatTie;
}

/** A tie that decides a seat: who is tied, and how the conclusion should describe it. */
export interface SeatTie {
    candidateIds: number[];
    label: string;
}

/**
 * A TIE THAT STRADDLES THE SEAT CUTOFF decides nothing on the ballots — only on the
 * order the rows happened to be sorted in.
 *
 * The old check only looked for a tie at the TOP of the table (more candidates tied
 * for first than there are seats). A tie for the LAST seat slipped through: with
 * A 5, B 3, C 3 for two seats, A is clearly in, but B against C is a dead heat, and the
 * stable sort seated whichever candidate's first ballot came first. So: if the last
 * candidate inside the seats has the same count as the first candidate outside them,
 * every candidate on that count is tied, and the result is not decided.
 *
 * Expects allResults sorted by voteCount, descending (every tally returns it so).
 */
export function findSeatCutoffTie(allResults: TallyResult['allResults'], maxWinners: number): SeatTie | null {
    if (maxWinners < 1 || allResults.length <= maxWinners) return null;
    const cutoff = allResults[maxWinners - 1].voteCount;
    if (allResults[maxWinners].voteCount !== cutoff) return null;
    const candidateIds = allResults.filter((r) => r.voteCount === cutoff).map((r) => r.candidateId);
    return { candidateIds, label: `Tie between ${candidateIds.length} candidates` };
}

// Shape of a single ballot row used by the tally algorithms.
interface ElectionVoteRow {
    candidate_id: number;
    rank_order: number | null;
}

/**
 * EVERY BALLOT, or none — a tally is the one read in this codebase where a partial
 * result is worse than an error.
 *
 * This was a single unbounded, unordered select. PostgREST answers an unbounded
 * select with its server-side maximum and a 200, so on an election larger than that
 * cap the tally silently ran over a SUBSET of ballots and returned a winner. Not a
 * degraded read — a wrong result, presented with the same confidence as a right one,
 * in the one module whose entire purpose is that the count can be trusted. This build
 * is deliberately ahead of hosted on election integrity (HMAC voter hashing, enforced
 * quorum, ballot dedup); none of it survives counting the wrong rows.
 *
 * So: page to exhaustion on a total order, then VERIFY the total against an exact
 * count and refuse if they disagree. Neither check alone catches every ballot cast
 * mid-read. A ballot id is a random uuid, so a new ballot sorts anywhere in the order:
 * one that lands after the read position is an extra row, and the count (taken after
 * the pages) refuses on the mismatch. One that lands inside a page already read pushes
 * that page's last row across the boundary instead — the row is read twice, the new
 * ballot is never read, and the totals still agree. So a repeated id refuses as well,
 * the same guard tallyPreferentialFull carries. concludeElection surfaces the throw; a
 * refused tally is re-runnable, a wrong one is not.
 */
const BALLOT_PAGE = 1000;
const BALLOT_MAX_PAGES = 500;   // 500k ballots, far past any org, then refuse
const BALLOT_READ_REFUSAL = 'The ballot count changed while tallying — re-run the count.';

export async function getVotesForElection(electionId: number) {
    const out: Array<{ candidate_id: number; rank_order: number | null }> = [];
    const seenIds = new Set<string>();
    for (let page = 0; page < BALLOT_MAX_PAGES; page++) {
        const from = page * BALLOT_PAGE;
        const { data, error } = await supabase.from('government_election_votes')
            .select('candidate_id, rank_order, id')
            .eq('election_id', electionId)
            .order('id', { ascending: true })
            .range(from, from + BALLOT_PAGE - 1);
        handleSupabaseError({ error, message: 'Failed to fetch votes' });
        const rows = (data || []) as Array<{ candidate_id: number; rank_order: number | null; id: string }>;
        for (const row of rows) {
            if (seenIds.has(row.id)) throw new Error(BALLOT_READ_REFUSAL);
            seenIds.add(row.id);
            out.push(row);
        }
        if (rows.length < BALLOT_PAGE) break;
        if (page === BALLOT_MAX_PAGES - 1) throw new Error('Too many ballots to tally safely — refusing to report a partial count.');
    }

    const { count, error: countErr } = await supabase.from('government_election_votes')
        .select('id', { count: 'exact', head: true })
        .eq('election_id', electionId);
    handleSupabaseError({ error: countErr, message: 'Failed to verify the ballot count' });
    if (count == null || count !== out.length) {
        throw new Error(BALLOT_READ_REFUSAL);
    }
    return out;
}

/**
 * The turnout-quorum DENOMINATOR. The error was discarded and `count || 0` turned any
 * read fault into "nobody was eligible to vote", which makes the min_voter_turnout_pct
 * check compare against zero — the branch either divides by nothing or passes
 * trivially, and an election is certified on a quorum that was never actually tested.
 * Fails closed instead.
 */
export async function getVoterCount(electionId: number): Promise<number> {
    const { count, error } = await supabase.from('government_election_voter_registry')
        .select('id', { count: 'exact', head: true })
        .eq('election_id', electionId);
    handleSupabaseError({ error, message: 'Failed to count the electorate' });
    if (count == null) throw new Error('Could not determine the electorate size — refusing to judge turnout.');
    return count;
}

export function tallySimpleMajority(votes: ElectionVoteRow[], maxWinners: number): TallyResult {
    const counts = new Map<number, number>();
    for (const v of votes) {
        counts.set(v.candidate_id, (counts.get(v.candidate_id) || 0) + 1);
    }
    const totalVotes = votes.length;
    const results = Array.from(counts.entries())
        .map(([candidateId, voteCount]) => ({
            candidateId,
            voteCount,
            percentage: totalVotes > 0 ? (voteCount / totalVotes) * 100 : 0,
        }))
        .sort((a, b) => b.voteCount - a.voteCount);

    return {
        winners: results.slice(0, maxWinners),
        allResults: results,
        totalVotes,
        isConclusive: results.length > 0,
        // Nothing to count is not a NORMAL conclusion — concludeElection keys off
        // `reason` to record WHY instead of "Election concluded normally".
        ...(results.length === 0 ? { reason: 'No votes cast' } : {}),
    };
}

export function tallyPlurality(votes: ElectionVoteRow[], maxWinners: number): TallyResult {
    // Same as simple majority but for multi-seat
    return tallySimpleMajority(votes, maxWinners);
}

export function tallyApproval(votes: ElectionVoteRow[], maxWinners: number): TallyResult {
    // Each voter can vote for multiple candidates — most approvals win
    return tallySimpleMajority(votes, maxWinners);
}

export function tallyPreferential(votes: ElectionVoteRow[], maxWinners: number): TallyResult {
    // True IRV needs voter_hash to group ballots, which isn't in this row shape —
    // see tallyPreferentialFull. This fallback tallies first-preference votes only.
    const firstPreferences = votes.filter(v => v.rank_order === 1 || v.rank_order === null);
    return tallySimpleMajority(firstPreferences, maxWinners);
}

const RANKED_READ_REFUSAL = 'Could not read every ranked ballot — refusing to report a partial count.';

export async function tallyPreferentialFull(electionId: number, maxWinners: number): Promise<TallyResult> {
    // Full IRV: fetch votes with voter_hash for proper ballot reconstruction.
    //
    // Fail closed, as getVotesForElection does. A discarded error read as "No votes
    // cast", which concludeElection files as a terminal Cancelled. The read used to be
    // ONE unbounded select, which PostgREST silently caps at its max-rows — and the
    // count check below then refused every ranked election larger than that cap, so a
    // big election could never conclude at all. It now pages to exhaustion on a TOTAL
    // order, (rank_order, id): rank order is what rebuilds each voter's ballot in
    // preference order, and the id tiebreak makes the paging deterministic.
    //
    // A ballot cast mid-read can sort INTO a page already read (its rank puts it inside
    // that rank's span, and its random uuid id anywhere within it) and shift a row
    // across the page boundary, so the same row would be read twice while the total
    // still matched. A repeated id therefore refuses as well; a ballot that lands after
    // the read position is caught by the exact count. A refused tally is re-runnable, a
    // wrong one is not.
    const allVotes: Array<{ voter_hash: string; candidate_id: number; rank_order: number | null; id: number }> = [];
    const seenIds = new Set<number>();
    for (let page = 0; page < BALLOT_MAX_PAGES; page++) {
        const from = page * BALLOT_PAGE;
        const { data, error: votesErr } = await supabase.from('government_election_votes')
            .select('voter_hash, candidate_id, rank_order, id')
            .eq('election_id', electionId)
            .order('rank_order', { ascending: true })
            .order('id', { ascending: true })
            .range(from, from + BALLOT_PAGE - 1);
        handleSupabaseError({ error: votesErr, message: 'Failed to fetch votes' });
        const rows = (data || []) as typeof allVotes;
        for (const row of rows) {
            if (seenIds.has(row.id)) throw new Error(RANKED_READ_REFUSAL);
            seenIds.add(row.id);
            allVotes.push(row);
        }
        if (rows.length < BALLOT_PAGE) break;
        if (page === BALLOT_MAX_PAGES - 1) throw new Error('Too many ballots to tally safely — refusing to report a partial count.');
    }
    const { count: ballotCount, error: countErr } = await supabase.from('government_election_votes')
        .select('id', { count: 'exact', head: true })
        .eq('election_id', electionId);
    handleSupabaseError({ error: countErr, message: 'Failed to verify the ballot count' });
    if (ballotCount == null || ballotCount !== allVotes.length) {
        throw new Error(RANKED_READ_REFUSAL);
    }

    if (allVotes.length === 0) {
        return { winners: [], allResults: [], totalVotes: 0, isConclusive: false, reason: 'No votes cast' };
    }

    // Fail CLOSED on imported ballots. The importer stamps a UNIQUE
    // IMPORTED_BALLOT_HASH_PREFIX hash on every ballot whose per-voter linkage the
    // source export withheld, so each row would otherwise read as its own
    // single-preference ballot: a rank-3 row would count as a FIRST preference and
    // totalVotes would be the ROW count, not the voter count. There is no correct
    // grouping left to recover (see SYNTHESIZED_NOT_NULL in ../importer.ts), and no
    // number of ballots cast HERE afterwards repairs the imported ones — so refuse,
    // rather than crown a wrong winner into a government office.
    if (allVotes.some((v) => typeof v.voter_hash === 'string' && v.voter_hash.startsWith(IMPORTED_BALLOT_HASH_PREFIX))) {
        return {
            winners: [], allResults: [], totalVotes: 0, isConclusive: false,
            reason: 'Ranked-choice ballots imported from another deployment cannot be re-tallied here — an org export withholds the per-voter grouping, and ballots cast here afterwards do not repair it. Record the result from the source deployment.',
        };
    }

    // Build ballots grouped by voter (rows arrive in rank order, so each voter's list
    // is in preference order).
    const ballotMap = new Map<string, number[]>();
    for (const v of allVotes) {
        if (!ballotMap.has(v.voter_hash)) ballotMap.set(v.voter_hash, []);
        ballotMap.get(v.voter_hash)!.push(v.candidate_id);
    }
    return instantRunoff(Array.from(ballotMap.values()), maxWinners);
}

// Distinct elimination states the tie search below may visit before it gives up.
// Zero-vote ties (the common case: candidates who only appear as later preferences)
// are eliminated together without searching, so a real election never comes close.
const IRV_STATE_BUDGET = 10_000;

type IrvOutcome =
    | { kind: 'won'; results: TallyResult['allResults'] }
    | { kind: 'exhausted' }
    | { kind: 'tie'; results: TallyResult['allResults']; tie: SeatTie };

/**
 * Instant-runoff over grouped ballots (each a candidate list in preference order).
 * Round by round: count each ballot for its highest-ranked continuing candidate; stop
 * when the leader holds a majority of ALL ballots, or the field is no larger than the
 * seats; otherwise eliminate the last-placed candidate.
 *
 * A TIE FOR LAST PLACE used to be broken by sort order — the candidate whose first
 * ballot happened to come last was eliminated, and that arbitrary choice could decide
 * who took office (a 5–5 final round "won" by whoever sorted first). Now every way of
 * breaking the tie is followed. If they all lead to the same seats, the tie did not
 * matter and the count goes on (reporting the rounds of the branch that eliminates the
 * lowest candidate id, so the numbers do not depend on ballot order); if they do not,
 * the ELECTION is tied and comes back
 * inconclusive with `tie` set, for concludeElection's tie path. Elimination states are
 * memoised (an outcome depends only on WHICH candidates are out), and a search that
 * outgrows IRV_STATE_BUDGET fails closed as a tie rather than guessing.
 */
export function instantRunoff(ballots: number[][], maxWinners: number): TallyResult {
    const totalVoters = ballots.length;
    const allCandidateIds = new Set<number>();
    for (const b of ballots) for (const c of b) allCandidateIds.add(c);

    const memo = new Map<string, IrvOutcome>();
    const BUDGET_LABEL = 'Ranked-choice count has too many tied eliminations to resolve safely';
    let budgetHit = false;
    const sortedIds = (ids: number[]) => [...ids].sort((a, b) => a - b).join(',');
    // What an outcome decides: the seated set, a tie (which one, and how described), or nothing.
    // A 'won' never carries a seat-cutoff tie (outcomeFrom turns one into a 'tie'), so
    // its sliced seats are a real decision, not an artefact of the sort.
    const decisionOf = (o: IrvOutcome): string => (o.kind === 'won'
        ? `won:${sortedIds(o.results.slice(0, maxWinners).map((r) => r.candidateId))}`
        : o.kind === 'tie' ? `tie:${sortedIds(o.tie.candidateIds)}:${o.tie.label}` : o.kind);
    const tieLabel = (n: number, remaining: number): string => {
        if (n < remaining) return `Ranked-choice elimination tie between ${n} candidates decides the result`;
        if (remaining === maxWinners + 1) return `Ranked-choice tie between ${n} candidates in the final round`;
        return `Ranked-choice tie between ${n} candidates for ${maxWinners} seat${maxWinners === 1 ? '' : 's'}`;
    };

    function outcomeFrom(eliminated: ReadonlySet<number>): IrvOutcome {
        const key = [...eliminated].sort((a, b) => a - b).join(',');
        const cached = memo.get(key);
        if (cached) return cached;

        const counts = new Map<number, number>();
        for (const cid of allCandidateIds) if (!eliminated.has(cid)) counts.set(cid, 0);
        for (const ballot of ballots) {
            const first = ballot.find((c) => !eliminated.has(c));
            if (first !== undefined) counts.set(first, (counts.get(first) || 0) + 1);
        }
        const results = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([candidateId, voteCount]) => ({
                candidateId,
                voteCount,
                percentage: totalVoters > 0 ? (voteCount / totalVoters) * 100 : 0,
            }));

        let outcome: IrvOutcome;
        if (results.length === 0) {
            outcome = { kind: 'exhausted' };
        } else if (results[0].voteCount > totalVoters / 2 || results.length <= maxWinners) {
            // A majority with more than one seat fills the remaining seats by count, so a
            // dead heat for the LAST seat must be a tie HERE, inside the search. Left as a
            // 'won', decisionOf compared only the sliced seats: branches that each sliced
            // the same set "agreed" even when one of them only got that set by sort order
            // (A 6, B 2, C 2 for two seats), the search returned branches[0], and which
            // branch came first — ballot order, i.e. random uuids — decided the result.
            const cut = findSeatCutoffTie(results, maxWinners);
            outcome = cut ? { kind: 'tie', results, tie: cut } : { kind: 'won', results };
        } else if (memo.size >= IRV_STATE_BUDGET) {
            budgetHit = true;
            outcome = { kind: 'tie', results, tie: { candidateIds: results.map((r) => r.candidateId), label: BUDGET_LABEL } };
        } else {
            const lowest = results[results.length - 1].voteCount;
            // Ascending candidate id, NOT result order. Candidates level on a count sit in
            // the order their first ballot was read, and ballot ids are random uuids; when
            // every branch below agrees, the count reports branches[0]'s rounds, and
            // concludeElection stores each candidate's vote_count from them. Following the
            // branches in read order let the same ballots store different numbers.
            const tied = results.filter((r) => r.voteCount === lowest).map((r) => r.candidateId)
                .sort((a, b) => a - b);
            const without = (ids: number[]) => new Set([...eliminated, ...ids]);
            if (tied.length === 1) {
                outcome = outcomeFrom(without(tied));
            } else if (lowest === 0 && results.length - tied.length >= maxWinners) {
                // Nobody's ballot sits with a zero-vote candidate, so removing them moves
                // no ballot and the order cannot matter — as long as enough candidates
                // remain to fill the seats without them.
                outcome = outcomeFrom(without(tied));
            } else {
                const branches = tied.map((cid) => outcomeFrom(without([cid])));
                const first = branches[0];
                if (branches.every((b) => decisionOf(b) === decisionOf(first))) {
                    // Every way of breaking this tie ends the same: the same seats (the tie
                    // did not matter), or the same later tie (that one is what decides it).
                    outcome = first;
                } else {
                    outcome = { kind: 'tie', results, tie: { candidateIds: tied, label: tieLabel(tied.length, results.length) } };
                }
            }
        }
        memo.set(key, outcome);
        return outcome;
    }

    const outcome = outcomeFrom(new Set());
    if (outcome.kind === 'exhausted') {
        return { winners: [], allResults: [], totalVotes: totalVoters, isConclusive: false, reason: 'IRV inconclusive' };
    }
    if (outcome.kind === 'tie') {
        // A search cut short anywhere surfaces as a tie at the top (an undecided branch
        // makes every branch point above it undecided), so say why rather than name a
        // tie the truncated search may only have imagined.
        const tie = budgetHit ? { candidateIds: outcome.tie.candidateIds, label: BUDGET_LABEL } : outcome.tie;
        return { winners: [], allResults: outcome.results, totalVotes: totalVoters, isConclusive: false, tie };
    }
    return {
        winners: outcome.results.slice(0, maxWinners),
        allResults: outcome.results,
        totalVotes: totalVoters,
        isConclusive: true,
    };
}

export function tallyProportional(votes: ElectionVoteRow[], maxWinners: number): TallyResult {
    // D'Hondt method for proportional seat allocation
    const counts = new Map<number, number>();
    for (const v of votes) {
        counts.set(v.candidate_id, (counts.get(v.candidate_id) || 0) + 1);
    }
    const totalVotes = votes.length;

    // D'Hondt: allocate seats one at a time
    // Each candidate's "quotient" = votes / (seats_won + 1)
    const seatsWon = new Map<number, number>();
    for (const cid of counts.keys()) seatsWon.set(cid, 0);

    const winners: number[] = [];
    for (let seat = 0; seat < maxWinners; seat++) {
        let bestCandidate = -1;
        let bestQuotient = -1;

        for (const [cid, voteCount] of counts) {
            const quotient = voteCount / ((seatsWon.get(cid) || 0) + 1);
            if (quotient > bestQuotient) {
                bestQuotient = quotient;
                bestCandidate = cid;
            }
        }

        if (bestCandidate >= 0) {
            winners.push(bestCandidate);
            seatsWon.set(bestCandidate, (seatsWon.get(bestCandidate) || 0) + 1);
        }
    }

    const uniqueWinners = [...new Set(winners)];
    const results = Array.from(counts.entries())
        .map(([candidateId, voteCount]) => ({
            candidateId,
            voteCount,
            percentage: totalVotes > 0 ? (voteCount / totalVotes) * 100 : 0,
        }))
        .sort((a, b) => b.voteCount - a.voteCount);

    return {
        winners: results.filter(r => uniqueWinners.includes(r.candidateId)),
        allResults: results,
        totalVotes,
        isConclusive: uniqueWinners.length > 0,
        ...(totalVotes === 0 ? { reason: 'No votes cast' } : {}),
    };
}

// ---------------------------------------------------------------------------
// Legislation Mappers
// ---------------------------------------------------------------------------

export const toGovernmentLegislation = (row: NullToUndefined<Tables<'government_legislation'>> & {
    author?: UserEmbed;
    sponsor_position?: Parameters<typeof toGovernmentPosition>[0] | null;
    vetoed_by?: UserEmbed;
    comments?: Parameters<typeof toGovernmentLegislationComment>[0][] | null;
    legislation_votes?: Parameters<typeof toGovernmentLegislationVote>[0][] | null;
}): GovernmentLegislation => ({
    id: row.id,
    title: row.title,
    body: row.body,
    summary: row.summary || undefined,
    status: row.status as unknown as LegislationStatus,
    authorId: row.author_id,
    author: row.author ? toMiniUser(row.author) : undefined,
    sponsorPositionId: row.sponsor_position_id || undefined,
    sponsorPosition: row.sponsor_position ? toGovernmentPosition(row.sponsor_position) : undefined,
    parentLegislationId: row.parent_legislation_id || undefined,
    isConstitutionalAmendment: row.is_constitutional_amendment,
    votingStart: row.voting_start || undefined,
    votingEnd: row.voting_end || undefined,
    votesFor: row.votes_for,
    votesAgainst: row.votes_against,
    votesAbstain: row.votes_abstain,
    passedAt: row.passed_at || undefined,
    vetoedAt: row.vetoed_at || undefined,
    vetoedById: row.vetoed_by_id || undefined,
    vetoedBy: row.vetoed_by ? toMiniUser(row.vetoed_by) : undefined,
    vetoReason: row.veto_reason || undefined,
    repealedAt: row.repealed_at || undefined,
    repealedByLegislationId: row.repealed_by_legislation_id || undefined,
    comments: row.comments?.map(toGovernmentLegislationComment),
    votes: row.legislation_votes?.map(toGovernmentLegislationVote),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

export const toGovernmentLegislationComment = (row: NullToUndefined<Tables<'government_legislation_comments'>> & {
    user?: UserEmbed;
}): GovernmentLegislationComment => ({
    id: row.id,
    legislationId: row.legislation_id,
    userId: row.user_id,
    user: row.user ? toMiniUser(row.user) : undefined,
    content: row.content,
    createdAt: row.created_at,
});

export const toGovernmentLegislationVote = (row: NullToUndefined<Tables<'government_legislation_votes'>> & {
    user?: UserEmbed;
    position?: Parameters<typeof toGovernmentPosition>[0] | null;
}): GovernmentLegislationVote => ({
    id: row.id,
    legislationId: row.legislation_id,
    userId: row.user_id,
    user: row.user ? toMiniUser(row.user) : undefined,
    positionId: row.position_id,
    position: row.position ? toGovernmentPosition(row.position) : undefined,
    vote: row.vote as 'for' | 'against' | 'abstain',
    castAt: row.cast_at,
});

const parseMotionDescription = (raw: unknown): unknown => {
    // Legacy rows: text column was wrapped via to_jsonb() during migration, so
    // a stored Tiptap JSON object now reads back as a JSON-encoded string.
    if (typeof raw === 'string' && raw.length > 0) {
        const trimmed = raw.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed === 'object') return parsed;
            } catch { /* fall through to plain text */ }
        }
    }
    return raw;
};

export const toGovernmentMotion = (row: NullToUndefined<Tables<'government_motions'>> & {
    created_by?: UserEmbed;
}): GovernmentMotion => ({
    id: row.id,
    title: row.title,
    description: parseMotionDescription(row.description) || undefined,
    status: row.status as unknown as MotionStatus,
    createdById: row.created_by_id,
    createdBy: row.created_by ? toMiniUser(row.created_by) : undefined,
    restrictedToPositionIds: row.restricted_to_position_ids || undefined,
    votingStart: row.voting_start || undefined,
    votingEnd: row.voting_end || undefined,
    votesFor: row.votes_for,
    votesAgainst: row.votes_against,
    votesAbstain: row.votes_abstain,
    isSecretBallot: row.is_secret_ballot,
    concludedAt: row.concluded_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});
