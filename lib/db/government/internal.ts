
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

export function computeVoterHash(electionId: number, userId: number): string {
    const secret = process.env.SECRETS_ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('Cannot compute voter hash: SECRETS_ENCRYPTION_KEY (or JWT_SECRET) is not configured — secret ballots require a server-held key to stay non-de-anonymizable.');
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
}

// Shape of a single ballot row used by the tally algorithms.
interface ElectionVoteRow {
    candidate_id: number;
    rank_order: number | null;
}

export async function getVotesForElection(electionId: number) {
    const { data, error } = await supabase.from('government_election_votes')
        .select('candidate_id, rank_order')
        .eq('election_id', electionId);
    handleSupabaseError({ error, message: 'Failed to fetch votes' });
    return data || [];
}

export async function getVoterCount(electionId: number): Promise<number> {
    const { count } = await supabase.from('government_election_voter_registry')
        .select('id', { count: 'exact', head: true })
        .eq('election_id', electionId);
    return count || 0;
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

export async function tallyPreferentialFull(electionId: number, maxWinners: number): Promise<TallyResult> {
    // Full IRV: fetch votes with voter_hash for proper ballot reconstruction
    const { data: allVotes } = await supabase.from('government_election_votes')
        .select('voter_hash, candidate_id, rank_order')
        .eq('election_id', electionId)
        .order('rank_order');

    if (!allVotes || allVotes.length === 0) {
        return { winners: [], allResults: [], totalVotes: 0, isConclusive: false, reason: 'No votes cast' };
    }

    // Build ballots grouped by voter
    const ballotMap = new Map<string, number[]>();
    for (const v of allVotes) {
        if (!ballotMap.has(v.voter_hash)) ballotMap.set(v.voter_hash, []);
        ballotMap.get(v.voter_hash)!.push(v.candidate_id);
    }
    const ballots = Array.from(ballotMap.values());
    const totalVoters = ballots.length;

    // Get all candidate IDs
    const allCandidateIds = new Set<number>();
    for (const b of ballots) for (const c of b) allCandidateIds.add(c);

    const eliminated = new Set<number>();
    const roundResults: Map<number, number>[] = [];

    // Run IRV rounds
    while (true) {
        const counts = new Map<number, number>();
        for (const cid of allCandidateIds) {
            if (!eliminated.has(cid)) counts.set(cid, 0);
        }

        // Count first valid preference for each ballot
        for (const ballot of ballots) {
            for (const candidateId of ballot) {
                if (!eliminated.has(candidateId)) {
                    counts.set(candidateId, (counts.get(candidateId) || 0) + 1);
                    break;
                }
            }
        }

        roundResults.push(new Map(counts));

        // Check if anyone has majority
        const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) break;

        const leader = sorted[0];
        if (leader[1] > totalVoters / 2 || sorted.length <= maxWinners) {
            // Winner found
            const results = sorted.map(([candidateId, voteCount]) => ({
                candidateId,
                voteCount,
                percentage: totalVoters > 0 ? (voteCount / totalVoters) * 100 : 0,
            }));
            return {
                winners: results.slice(0, maxWinners),
                allResults: results,
                totalVotes: totalVoters,
                isConclusive: true,
            };
        }

        // Eliminate lowest
        const lowest = sorted[sorted.length - 1];
        eliminated.add(lowest[0]);
    }

    return { winners: [], allResults: [], totalVotes: totalVoters, isConclusive: false, reason: 'IRV inconclusive' };
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
