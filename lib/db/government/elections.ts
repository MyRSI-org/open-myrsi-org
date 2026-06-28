
import { supabase, handleSupabaseError, safeFetch } from '../common.js';
import { ElectionType, ElectionStatus, GovernmentElection, GovernmentElectionCandidate } from '../../../types.js';
import {
    log,
    USER_HYDRATE,
    broadcastGovernmentUpdate,
    toGovernmentElection,
    toGovernmentElectionCandidate,
    computeVoterHash,
    TallyResult,
    getVotesForElection,
    getVoterCount,
    tallySimpleMajority,
    tallyPlurality,
    tallyApproval,
    tallyPreferentialFull,
    tallyProportional,
} from './internal.js';
import { appointPositionHolder } from './structure.js';
import type { Tables } from '../rows.js';

// Election creation input. Mirrors the ElectionData RPC payload in
// api/actions/government.ts (plus the server-injected userId); lib/db cannot
// import from the action layer.
interface ElectionInput {
    title?: string;
    positionId?: number;
    description?: string;
    electionType?: string;
    candidacyStart?: string;
    candidacyEnd?: string;
    votingStart?: string;
    votingEnd?: string;
    minCandidates?: number;
    maxWinners?: number;
    minVoterTurnoutPct?: number;
    minVoteThresholdPct?: number;
    allowRunoff?: boolean;
    runoffTopN?: number;
    isByElection?: boolean;
    remainingTermDays?: number;
    userId?: number;
}

// ---------------------------------------------------------------------------
// Election State (included in government subset)
// ---------------------------------------------------------------------------

export async function getElectionsState(currentUserId?: number): Promise<GovernmentElection[]> {
    const electionsResult = await safeFetch(
        supabase.from('government_elections')
            .select(`
                id, position_id, title, description, election_type, status,
                candidacy_start, candidacy_end, voting_start, voting_end,
                min_candidates, max_winners, min_voter_turnout_pct, min_vote_threshold_pct,
                allow_runoff, runoff_top_n, parent_election_id, is_by_election,
                remaining_term_days, created_by_id, concluded_at, conclusion_reason,
                certified_by_id, certified_at, eligible_voter_count, total_votes_cast,
                created_at, updated_at,
                position:government_positions(id, branch_id, name, description, fill_method, term_length_days, max_holders, icon, sort_order, permissions_granted, can_propose_legislation, can_vote_legislation, can_veto_legislation, can_call_elections, can_issue_orders, created_at),
                created_by:users!government_elections_created_by_id_fkey(${USER_HYDRATE}),
                candidates:government_election_candidates(
                    id, election_id, user_id, platform_statement, declared_at, withdrawn_at, is_winner, vote_count, vote_percentage,
                    user:users!government_election_candidates_user_id_fkey(${USER_HYDRATE})
                )
            `)
            
            .order('created_at', { ascending: false })
            .limit(50),
        [], 'government_elections'
    );

    const elections = Array.isArray(electionsResult)
        ? electionsResult.map(r => toGovernmentElection(r as unknown as Parameters<typeof toGovernmentElection>[0]))
        : [];

    // Check if current user has voted in active elections
    if (currentUserId && elections.length > 0) {
        const activeElectionIds = elections
            .filter(e => e.status === ElectionStatus.Voting)
            .map(e => e.id);

        if (activeElectionIds.length > 0) {
            const { data: voted } = await supabase
                .from('government_election_voter_registry')
                .select('election_id')
                .eq('user_id', currentUserId)
                
                .in('election_id', activeElectionIds);

            const votedSet = new Set((voted || []).map((v: { election_id: number }) => v.election_id));
            for (const election of elections) {
                election.hasVoted = votedSet.has(election.id);
            }
        }
    }

    // Filter out withdrawn candidates
    for (const election of elections) {
        if (election.candidates) {
            election.candidates = election.candidates.filter(c => !c.withdrawnAt);
        }
        // Hide vote counts until election is concluded
        if (election.status !== ElectionStatus.Concluded) {
            for (const c of election.candidates || []) {
                c.voteCount = undefined;
                c.votePercentage = undefined;
            }
        }
    }

    return elections;
}

// ---------------------------------------------------------------------------
// Election CRUD
// ---------------------------------------------------------------------------

export async function createElection(data: ElectionInput): Promise<GovernmentElection | null> {
    const payload = {
        position_id: data.positionId,
        title: data.title,
        description: data.description || null,
        election_type: data.electionType || 'SimpleMajority',
        status: 'Draft',
        candidacy_start: data.candidacyStart || null,
        candidacy_end: data.candidacyEnd || null,
        voting_start: data.votingStart || null,
        voting_end: data.votingEnd || null,
        min_candidates: data.minCandidates ?? 1,
        max_winners: data.maxWinners ?? 1,
        min_voter_turnout_pct: data.minVoterTurnoutPct || null,
        min_vote_threshold_pct: data.minVoteThresholdPct || null,
        allow_runoff: data.allowRunoff ?? false,
        runoff_top_n: data.runoffTopN ?? 2,
        is_by_election: data.isByElection ?? false,
        remaining_term_days: data.remainingTermDays || null,
        created_by_id: data.userId,
    };
    const { data: result, error } = await supabase.from('government_elections')
        .insert(payload).select('id, position_id, title, description, election_type, status, candidacy_start, candidacy_end, voting_start, voting_end, min_candidates, max_winners, min_voter_turnout_pct, min_vote_threshold_pct, allow_runoff, runoff_top_n, parent_election_id, is_by_election, remaining_term_days, created_by_id, concluded_at, conclusion_reason, certified_by_id, certified_at, eligible_voter_count, total_votes_cast, created_at, updated_at').single();
    handleSupabaseError({ error, message: 'Failed to create election' });
    broadcastGovernmentUpdate('elections');
    return result ? toGovernmentElection(result) : null;
}

export async function updateElection(electionId: number, updates: Partial<GovernmentElection>) {
    const dbUpdates: Record<string, unknown> = {};
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.electionType !== undefined) dbUpdates.election_type = updates.electionType;
    if (updates.candidacyStart !== undefined) dbUpdates.candidacy_start = updates.candidacyStart;
    if (updates.candidacyEnd !== undefined) dbUpdates.candidacy_end = updates.candidacyEnd;
    if (updates.votingStart !== undefined) dbUpdates.voting_start = updates.votingStart;
    if (updates.votingEnd !== undefined) dbUpdates.voting_end = updates.votingEnd;
    if (updates.minCandidates !== undefined) dbUpdates.min_candidates = updates.minCandidates;
    if (updates.maxWinners !== undefined) dbUpdates.max_winners = updates.maxWinners;
    if (updates.minVoterTurnoutPct !== undefined) dbUpdates.min_voter_turnout_pct = updates.minVoterTurnoutPct;
    if (updates.minVoteThresholdPct !== undefined) dbUpdates.min_vote_threshold_pct = updates.minVoteThresholdPct;
    if (updates.allowRunoff !== undefined) dbUpdates.allow_runoff = updates.allowRunoff;
    if (updates.runoffTopN !== undefined) dbUpdates.runoff_top_n = updates.runoffTopN;
    dbUpdates.updated_at = new Date().toISOString();

    if (Object.keys(dbUpdates).length <= 1) return; // only updated_at

    const { error } = await supabase.from('government_elections')
        .update(dbUpdates).eq('id', electionId);
    handleSupabaseError({ error, message: 'Failed to update election' });
    broadcastGovernmentUpdate('elections');
}

// ---------------------------------------------------------------------------
// Electorate snapshot (turnout-quorum denominator)
// ---------------------------------------------------------------------------

// Count the eligible electorate: every non-deleted member whose role grants
// gov:participate (the permission gating gov:cast_election_vote in
// api/services.ts). Snapshotted into government_elections.eligible_voter_count
// when voting opens so concludeElection's min_voter_turnout_pct quorum has a
// denominator (c7 — previously the column was never populated, so the quorum
// branch was dead code). Returns 0 if the permission/role lookup yields nothing;
// the caller persists that and concludeElection fails the quorum CLOSED on a 0.
async function countEligibleVoters(): Promise<number> {
    const { data: perm } = await supabase.from('permissions')
        .select('id')
        .eq('name', 'gov:participate')
        .maybeSingle();
    if (!perm) return 0;

    const { data: rolePerms } = await supabase.from('role_permissions')
        .select('role_id')
        .eq('permission_id', perm.id);
    const roleIds = (rolePerms || []).map((r: { role_id: number }) => r.role_id);
    if (roleIds.length === 0) return 0;

    const { count } = await supabase.from('users')
        .select('id', { count: 'exact', head: true })
        .in('role_id', roleIds)
        .is('deleted_at', null);
    return count || 0;
}

export async function advanceElection(electionId: number) {
    const { data: election, error: fetchErr } = await supabase.from('government_elections')
        .select('id, status, candidacy_start, candidacy_end, voting_start, min_candidates, candidates:government_election_candidates(id, withdrawn_at)')
        .eq('id', electionId).single();
    if (fetchErr || !election) throw new Error('Election not found');

    const activeCandidates = (election.candidates || []).filter((c: { id: number; withdrawn_at: string | null }) => !c.withdrawn_at);
    const now = new Date().toISOString();

    if (election.status === 'Draft') {
        // Advance to Candidacy
        const { error } = await supabase.from('government_elections')
            .update({
                status: 'Candidacy',
                candidacy_start: election.candidacy_start || now,
                updated_at: now
            })
            .eq('id', electionId);
        handleSupabaseError({ error, message: 'Failed to advance election to Candidacy' });

    } else if (election.status === 'Candidacy') {
        // Advance to Voting — check min candidates
        if (activeCandidates.length < election.min_candidates) {
            throw new Error(`Need at least ${election.min_candidates} candidate(s), currently ${activeCandidates.length}`);
        }
        // Snapshot the electorate size at the moment voting opens so the
        // min_voter_turnout_pct quorum in concludeElection becomes enforceable
        // (c7 fix). Without this denominator a 1-voter election would auto-appoint
        // its winner into a veto-capable apex office despite a configured quorum.
        const eligibleVoterCount = await countEligibleVoters();
        const { error } = await supabase.from('government_elections')
            .update({
                status: 'Voting',
                candidacy_end: election.candidacy_end || now,
                voting_start: election.voting_start || now,
                eligible_voter_count: eligibleVoterCount,
                updated_at: now
            })
            .eq('id', electionId);
        handleSupabaseError({ error, message: 'Failed to advance election to Voting' });

    } else if (election.status === 'Voting') {
        // Conclude — tally votes
        await concludeElection(electionId);
        return;

    } else {
        throw new Error(`Cannot advance election from status: ${election.status}`);
    }

    broadcastGovernmentUpdate('elections');
}

// ---------------------------------------------------------------------------
// Candidacy
// ---------------------------------------------------------------------------

export async function declareCandidacy(electionId: number, userId: number, statement: string | null): Promise<GovernmentElectionCandidate | null> {
    const { data: election } = await supabase.from('government_elections')
        .select('status').eq('id', electionId).single();
    if (!election || election.status !== 'Candidacy') throw new Error('Election is not in candidacy phase');

    // Duplicate-candidacy guard: the table has no (election_id,user_id) uniqueness
    // today, so a user could self-declare N times — each row is counted toward
    // `min_candidates` in advanceElection and seeds a distinct votable candidate
    // id. Pre-check for an existing ACTIVE (not withdrawn) candidacy and reject.
    // Once the partial UNIQUE(election_id,user_id) WHERE withdrawn_at IS NULL index
    // lands, a concurrent double-declare races to a 23505 we treat the same way.
    const { count: existing } = await supabase.from('government_election_candidates')
        .select('id', { count: 'exact', head: true })
        .eq('election_id', electionId)
        .eq('user_id', userId)
        .is('withdrawn_at', null);
    if (existing && existing > 0) throw new Error('You have already declared candidacy in this election');

    const { data: result, error } = await supabase.from('government_election_candidates')
        .insert({
            election_id: electionId,
            user_id: userId,
            platform_statement: statement || null,
        })
        .select('id, election_id, user_id, platform_statement, declared_at, withdrawn_at, is_winner, vote_count, vote_percentage')
        .single();
    // 23505 = unique_violation: the atomic guard once the partial UNIQUE index
    // exists. Map it to the same user-facing rejection (fail closed).
    if (error && (error as { code?: string }).code === '23505') {
        throw new Error('You have already declared candidacy in this election');
    }
    handleSupabaseError({ error, message: 'Failed to declare candidacy' });
    broadcastGovernmentUpdate('elections');
    return result ? toGovernmentElectionCandidate(result) : null;
}

export async function withdrawCandidacy(electionId: number, userId: number) {
    const { error } = await supabase.from('government_election_candidates')
        .update({ withdrawn_at: new Date().toISOString() })
        .eq('election_id', electionId)
        .eq('user_id', userId)

        .is('withdrawn_at', null);
    handleSupabaseError({ error, message: 'Failed to withdraw candidacy' });
    broadcastGovernmentUpdate('elections');
}

// ---------------------------------------------------------------------------
// Voting (secret ballot)
// ---------------------------------------------------------------------------

// Hard ceiling on the size of a single ballot payload. No real ballot
// ranks/approves more than a few dozen candidates, so anything larger is abusive.
// Applied BEFORE any DB work so an oversized array never reaches the insert.
const MAX_BALLOT_SELECTIONS = 64;

export async function castElectionVote(
    electionId: number,
    userId: number,
    selections: { candidateId: number; rankOrder?: number }[]
) {
    if (!Array.isArray(selections) || selections.length === 0) {
        throw new Error('No selections provided');
    }
    // Reject oversized arrays outright rather than truncating — a ballot this
    // large is never legitimate and truncation could silently drop a voter's real
    // choices.
    if (selections.length > MAX_BALLOT_SELECTIONS) {
        throw new Error('Too many selections');
    }

    // Verify election is in Voting phase
    const { data: election } = await supabase.from('government_elections')
        .select('status, election_type, max_winners')
        .eq('id', electionId).single();
    if (!election || election.status !== 'Voting') throw new Error('Election is not in voting phase');

    const elType = election.election_type as ElectionType;

    // Dedup to AT MOST ONE row per candidate per voter (ballot-stuffing guard):
    // tallySimpleMajority/Plurality/Approval/Proportional each count +1 PER ROW,
    // so N rows for the same candidate = N votes from one ballot. Keep the first
    // occurrence of each candidate id (preserving the order the voter supplied,
    // which carries rank intent for preferential ballots).
    const seenCandidates = new Set<number>();
    const dedupedSelections: { candidateId: number; rankOrder?: number }[] = [];
    for (const s of selections) {
        if (typeof s?.candidateId !== 'number' || !Number.isInteger(s.candidateId)) continue;
        if (seenCandidates.has(s.candidateId)) continue;
        seenCandidates.add(s.candidateId);
        dedupedSelections.push(s);
    }
    if (dedupedSelections.length === 0) throw new Error('No valid selections provided');

    // Respect the election's selection-count semantics:
    //  - SimpleMajority / Plurality / ProportionalRepresentation: a single choice
    //    per voter — keep only the first distinct candidate.
    //  - Approval: a voter may approve up to max_winners distinct candidates.
    //  - Preferential: a ranked ballot — one row per distinct candidate (already
    //    deduped above); rank ordering preserved.
    const maxWinners = Math.max(1, election.max_winners ?? 1);
    let scopedSelections: { candidateId: number; rankOrder?: number }[];
    if (elType === ElectionType.Approval) {
        scopedSelections = dedupedSelections.slice(0, maxWinners);
    } else if (elType === ElectionType.Preferential) {
        scopedSelections = dedupedSelections;
    } else {
        // Single-choice methods: exactly one vote row.
        scopedSelections = dedupedSelections.slice(0, 1);
    }

    // Foreign-candidate scope check: selections[].candidateId only has a
    // single-column FK to government_election_candidates, NOT bound to THIS
    // election. Fetch the supplied candidate rows and reject if any belongs to a
    // different election (fail closed) — otherwise a voter could cast a row for a
    // candidate in election B while voting in A, polluting B's tally and getting
    // that user wrongly auto-appointed to A's position at conclude.
    const candidateIds = scopedSelections.map(s => s.candidateId);
    const { data: candidateRows, error: candFetchErr } = await supabase
        .from('government_election_candidates')
        .select('id, election_id, withdrawn_at')
        .in('id', candidateIds);
    handleSupabaseError({ error: candFetchErr, message: 'Failed to validate candidates' });
    const validById = new Map<number, { election_id: number; withdrawn_at: string | null }>(
        (candidateRows || []).map((c: { id: number; election_id: number; withdrawn_at: string | null }) =>
            [c.id, { election_id: c.election_id, withdrawn_at: c.withdrawn_at }])
    );
    for (const cid of candidateIds) {
        const row = validById.get(cid);
        if (!row || row.election_id !== electionId) {
            throw new Error('Invalid candidate selection');
        }
        if (row.withdrawn_at) throw new Error('Cannot vote for a withdrawn candidate');
    }

    // Check if already voted (registry check — the DB constraint is the real guard)
    const { count: alreadyVoted } = await supabase.from('government_election_voter_registry')
        .select('id', { count: 'exact', head: true })
        .eq('election_id', electionId).eq('user_id', userId);
    if (alreadyVoted && alreadyVoted > 0) throw new Error('You have already voted in this election');

    // Record participation FIRST so UNIQUE(election_id, user_id) is the atomic
    // one-vote guard: under a concurrent double-submit the second registry insert
    // fails (23505) BEFORE any ballots are written, so no orphaned duplicate votes.
    const { error: regError } = await supabase.from('government_election_voter_registry').insert({
        election_id: electionId,
        user_id: userId,
    });
    handleSupabaseError({ error: regError, message: 'Failed to record vote participation' });

    const voterHash = computeVoterHash(electionId, userId);

    // Insert ballots (reached only after participation is uniquely recorded above).
    // At most one row per candidate (deduped + scoped above).
    const voteRows = scopedSelections.map(s => ({
        election_id: electionId,
        voter_hash: voterHash,
        candidate_id: s.candidateId,
        rank_order: s.rankOrder ?? null,
    }));

    const { error: voteError } = await supabase.from('government_election_votes').insert(voteRows);
    // 23505 = unique_violation: once the schema's UNIQUE(election_id,
    // candidate_id, voter_hash) index lands it is the atomic per-candidate guard
    // (defends against a concurrent double-cast slipping past the registry race).
    if (voteError && (voteError as { code?: string }).code === '23505') {
        throw new Error('Duplicate vote detected');
    }
    handleSupabaseError({ error: voteError, message: 'Failed to cast vote' });

    broadcastGovernmentUpdate('elections');
}

// ---------------------------------------------------------------------------
// Conclude Election
// ---------------------------------------------------------------------------

export async function concludeElection(electionId: number) {
    const { data: election } = await supabase.from('government_elections')
        .select('id, status, max_winners, election_type, min_voter_turnout_pct, eligible_voter_count, min_vote_threshold_pct, allow_runoff, position_id, voting_end, runoff_top_n, title, created_by_id, candidacy_start, candidacy_end, voting_start, min_candidates, parent_election_id, is_by_election, remaining_term_days, concluded_at, conclusion_reason, certified_by_id, certified_at, total_votes_cast, description, created_at, updated_at, position:government_positions(max_holders)')
        .eq('id', electionId).single();
    if (!election) throw new Error('Election not found');
    if (election.status !== 'Voting') throw new Error('Election is not in voting phase');

    const votes = await getVotesForElection(electionId);
    const voterCount = await getVoterCount(electionId);
    const maxWinners = election.max_winners;

    // Run tally based on election type
    let result: TallyResult;
    const elType = election.election_type as ElectionType;

    if (elType === ElectionType.Preferential) {
        result = await tallyPreferentialFull(electionId, maxWinners);
    } else if (elType === ElectionType.ProportionalRepresentation) {
        result = tallyProportional(votes, maxWinners);
    } else if (elType === ElectionType.Approval) {
        result = tallyApproval(votes, maxWinners);
    } else if (elType === ElectionType.Plurality) {
        result = tallyPlurality(votes, maxWinners);
    } else {
        result = tallySimpleMajority(votes, maxWinners);
    }

    // Check turnout threshold
    let conclusionReason = 'Election concluded normally';
    let status: string = 'Concluded';

    // Turnout quorum (c7). A min_voter_turnout_pct of 0/unset means no quorum is
    // required — skip the gate and conclude normally. When a quorum IS required we
    // MUST have the electorate snapshot taken at the Candidacy->Voting transition
    // to compute turnout; a missing/zero eligible_voter_count makes the quorum
    // unverifiable, so fail CLOSED (treat as not met) rather than silently
    // auto-appointing the winner into a possibly veto-capable apex office.
    const requiredTurnoutPct = election.min_voter_turnout_pct ? parseFloat(election.min_voter_turnout_pct) : 0;
    if (requiredTurnoutPct > 0) {
        const eligible = election.eligible_voter_count || 0;
        if (eligible <= 0) {
            status = 'Cancelled';
            conclusionReason = `Turnout quorum of ${requiredTurnoutPct}% required but the electorate size is unknown — quorum not met`;
            result.isConclusive = false;
        } else {
            const turnoutPct = (voterCount / eligible) * 100;
            if (turnoutPct < requiredTurnoutPct) {
                status = 'Cancelled';
                conclusionReason = `Insufficient voter turnout (${turnoutPct.toFixed(1)}% < ${requiredTurnoutPct}% required)`;
                result.isConclusive = false;
            }
        }
    }

    // Check vote threshold
    if (result.isConclusive && election.min_vote_threshold_pct && result.winners.length > 0) {
        const thresholdPct = parseFloat(election.min_vote_threshold_pct);
        const winnersAboveThreshold = result.winners.filter(w => w.percentage >= thresholdPct);
        if (winnersAboveThreshold.length === 0) {
            if (election.allow_runoff) {
                // Create runoff election
                await createRunoffElection(election, result);
                status = 'Runoff';
                conclusionReason = `No candidate met ${thresholdPct}% threshold — runoff triggered`;
                result.isConclusive = false;
            } else {
                conclusionReason = `No candidate met ${thresholdPct}% threshold — election inconclusive`;
                result.isConclusive = false;
            }
        }
    }

    // Check for tie (when not using proportional)
    if (result.isConclusive && result.winners.length >= 2 && elType !== ElectionType.ProportionalRepresentation) {
        const topVotes = result.winners[0].voteCount;
        const tied = result.winners.filter(w => w.voteCount === topVotes);
        if (tied.length > maxWinners) {
            if (election.allow_runoff) {
                await createRunoffElection(election, result);
                status = 'Runoff';
                conclusionReason = `Tie between ${tied.length} candidates — runoff triggered`;
                result.isConclusive = false;
            } else {
                conclusionReason = `Tie between ${tied.length} candidates — no clear winner`;
                result.isConclusive = false;
            }
        }
    }

    const now = new Date().toISOString();

    // Update candidate vote counts and mark winners
    for (const r of result.allResults) {
        const isWinner = result.isConclusive && result.winners.some(w => w.candidateId === r.candidateId);
        await supabase.from('government_election_candidates')
            .update({
                vote_count: r.voteCount,
                vote_percentage: r.percentage,
                is_winner: isWinner,
            })
            .eq('id', r.candidateId);
    }

    // Update election status
    await supabase.from('government_elections')
        .update({
            status,
            concluded_at: now,
            conclusion_reason: conclusionReason,
            total_votes_cast: voterCount,
            voting_end: election.voting_end || now,
            updated_at: now,
        })
        .eq('id', electionId);

    // Auto-appoint winners to positions
    if (result.isConclusive && status === 'Concluded') {
        for (const winner of result.winners) {
            // Get candidate's user_id + election scope. Defense-in-depth:
            // re-validate that the winning candidate row belongs to THIS election
            // before appointing — a foreign candidate_id that polluted the tally
            // (despite the castElectionVote scope check) must never be appointed
            // to a position they never ran for.
            const { data: candidate } = await supabase.from('government_election_candidates')
                .select('user_id, election_id').eq('id', winner.candidateId).single();
            if (candidate && candidate.election_id === electionId) {
                try {
                    await appointPositionHolder({
                        positionId: election.position_id,
                        userId: candidate.user_id,
                        electionId,
                    });
                } catch (e) {
                    log.warn('auto-appoint election winner failed', { electionId, positionId: election.position_id, candidateId: winner.candidateId, err: e });
                }
            }
        }
    }

    broadcastGovernmentUpdate('elections');
    return { status, conclusionReason, result };
}

async function createRunoffElection(parentElection: Tables<'government_elections'>, tallyResult: TallyResult) {
    const topN = parentElection.runoff_top_n || 2;
    const topCandidates = tallyResult.allResults.slice(0, topN);

    const { data: runoff, error } = await supabase.from('government_elections')
        .insert({
            position_id: parentElection.position_id,
            title: `${parentElection.title} — Runoff`,
            description: `Runoff election following inconclusive results.`,
            election_type: parentElection.election_type,
            status: 'Candidacy',
            candidacy_start: new Date().toISOString(),
            min_candidates: 2,
            max_winners: parentElection.max_winners,
            allow_runoff: false,
            runoff_top_n: 2,
            parent_election_id: parentElection.id,
            created_by_id: parentElection.created_by_id,
        })
        .select('id')
        .single();

    if (error || !runoff) {
        log.error('create runoff election failed', { parentElectionId: parentElection.id, err: error });
        return;
    }

    // Pre-register top candidates in runoff
    for (const r of topCandidates) {
        const { data: origCandidate } = await supabase.from('government_election_candidates')
            .select('user_id, platform_statement').eq('id', r.candidateId).single();
        if (origCandidate) {
            await supabase.from('government_election_candidates').insert({
                election_id: runoff.id,
                user_id: origCandidate.user_id,
                platform_statement: origCandidate.platform_statement,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// By-Elections & Cancellation
// ---------------------------------------------------------------------------

export async function callByElection(data: ElectionInput) {
    // Calculate remaining term if the position has a term length
    const { data: position } = await supabase.from('government_positions')
        .select('term_length_days').eq('id', data.positionId).single();

    return createElection({
        ...data,
        isByElection: true,
        remainingTermDays: position?.term_length_days || null,
    });
}

export async function cancelElection(electionId: number, reason: string) {
    const { error } = await supabase.from('government_elections')
        .update({
            status: 'Cancelled',
            concluded_at: new Date().toISOString(),
            conclusion_reason: reason || 'Cancelled by electoral officer',
            updated_at: new Date().toISOString(),
        })
        .eq('id', electionId)
        
        .in('status', ['Draft', 'Candidacy', 'Voting']);
    handleSupabaseError({ error, message: 'Failed to cancel election' });
    broadcastGovernmentUpdate('elections');
}

export async function certifyElection(electionId: number, userId: number) {
    const { error } = await supabase.from('government_elections')
        .update({
            certified_by_id: userId,
            certified_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq('id', electionId)
        
        .eq('status', 'Concluded');
    handleSupabaseError({ error, message: 'Failed to certify election' });
    broadcastGovernmentUpdate('elections');
}
