
import { supabase, handleSupabaseError, safeFetch } from '../common.js';
import { sanitizeTiptapJson } from '../../tiptapValidate.js';
import { normalizeDocMediaForStorage, assertDocImageCap, signDocMediaForClient } from '../../orgMediaDocs.js';
import { stripHtml } from '../../textSanitize.js';
import {
    MotionStatus,
    GovernmentLegislation,
    GovernmentLegislationComment,
    GovernmentMotion,
} from '../../../types.js';
import {
    USER_HYDRATE,
    broadcastGovernmentUpdate,
    toGovernmentLegislation,
    toGovernmentLegislationComment,
    toGovernmentMotion,
    computeVoterHash,
} from './internal.js';

// Motion creation input. Mirrors the MotionData RPC payload in
// api/actions/government.ts (plus the server-injected userId); lib/db cannot
// import from the action layer.
interface MotionInput {
    title?: string;
    description?: unknown;
    restrictedToPositionIds?: number[];
    isSecretBallot?: boolean;
    userId?: number;
}

// ---------------------------------------------------------------------------
// Legislation State
// ---------------------------------------------------------------------------

export async function getLegislationState(): Promise<GovernmentLegislation[]> {
    const result = await safeFetch(
        supabase.from('government_legislation')
            .select(`
                id, title, body, summary, status, author_id, sponsor_position_id, parent_legislation_id, is_constitutional_amendment, voting_start, voting_end, votes_for, votes_against, votes_abstain, passed_at, vetoed_at, vetoed_by_id, veto_reason, repealed_at, repealed_by_legislation_id, created_at, updated_at,
                author:users!government_legislation_author_id_fkey(${USER_HYDRATE}),
                sponsor_position:government_positions!government_legislation_sponsor_position_id_fkey(id, name, icon),
                vetoed_by:users!government_legislation_vetoed_by_id_fkey(${USER_HYDRATE}),
                comments:government_legislation_comments(
                    id, legislation_id, user_id, content, created_at,
                    user:users!government_legislation_comments_user_id_fkey(${USER_HYDRATE})
                ),
                legislation_votes:government_legislation_votes(
                    id, legislation_id, user_id, position_id, vote, cast_at,
                    user:users!government_legislation_votes_user_id_fkey(${USER_HYDRATE}),
                    position:government_positions!government_legislation_votes_position_id_fkey(id, name, icon)
                )
            `)
            
            .order('created_at', { ascending: false }).order('id', { ascending: false })
            .limit(100),
        [], 'government_legislation'
    );

    const legislation = Array.isArray(result)
        ? result.map(r => toGovernmentLegislation(r as unknown as Parameters<typeof toGovernmentLegislation>[0]))
        : [];
    // Legislation bodies may reference private-bucket images by key; sign them for this
    // permitted reader (this runs behind the gov:view gate).
    for (const l of legislation) {
        if (l.body) l.body = await signDocMediaForClient(l.body);
    }
    return legislation;
}

// ---------------------------------------------------------------------------
// Motion State
// ---------------------------------------------------------------------------

export async function getMotionsState(currentUserId?: number): Promise<GovernmentMotion[]> {
    const result = await safeFetch(
        supabase.from('government_motions')
            .select(`
                id, title, description, status, created_by_id, restricted_to_position_ids, voting_start, voting_end, votes_for, votes_against, votes_abstain, is_secret_ballot, concluded_at, created_at, updated_at,
                created_by:users!government_motions_created_by_id_fkey(${USER_HYDRATE})
            `)
            
            .order('created_at', { ascending: false }).order('id', { ascending: false })
            .limit(50),
        [], 'government_motions'
    );

    const motions = Array.isArray(result)
        ? result.map(r => toGovernmentMotion(r as unknown as Parameters<typeof toGovernmentMotion>[0]))
        : [];

    // Check if current user has voted on active motions
    if (currentUserId && motions.length > 0) {
        const activeMotionIds = motions.filter(m => m.status === MotionStatus.Voting).map(m => m.id);
        if (activeMotionIds.length > 0) {
            const { data: voted } = await supabase.from('government_motion_votes')
                .select('motion_id, vote')
                .eq('user_id', currentUserId)
                .in('motion_id', activeMotionIds);
            const votedRows: { motion_id: number; vote: string }[] = voted || [];
            const voteMap = new Map(votedRows.map((v) => [v.motion_id, v.vote]));
            for (const motion of motions) {
                if (voteMap.has(motion.id)) {
                    motion.hasVoted = true;
                    motion.myVote = voteMap.get(motion.id);
                }
            }
        }
    }

    return motions;
}

// ---------------------------------------------------------------------------
// Legislation CRUD
// ---------------------------------------------------------------------------

const LEGISLATION_BODY_ERROR = 'Bill text must be a rich-text document.';

// Legislation body is edited via the WikiEditor (Tiptap JSON) — sanitize on save.
// Anything that was NOT an object used to be stored exactly as received, skipping
// sanitizeTiptapJson, the private-media key normalisation and the image cap, so a
// raw RPC could persist an arbitrary string that renders as the bill text. Only an
// absent/empty body keeps the legacy '' (the column default); every other
// non-object is refused rather than guessed at.
function sanitizeLegislationBody(body: unknown): unknown {
    if (body === undefined || body === null || body === '') return '';
    if (typeof body !== 'object') throw new Error(LEGISLATION_BODY_ERROR);
    const safe = normalizeDocMediaForStorage(sanitizeTiptapJson(body, 'wiki'));
    assertDocImageCap(safe);
    return safe;
}

export async function createLegislation(data: Partial<GovernmentLegislation> & { userId?: number }): Promise<GovernmentLegislation | null> {
    const safeBody = sanitizeLegislationBody(data.body);
    const payload = {
        title: data.title,
        body: safeBody,
        summary: data.summary || null,
        status: 'Draft',
        author_id: data.userId,
        sponsor_position_id: data.sponsorPositionId || null,
        parent_legislation_id: data.parentLegislationId || null,
        is_constitutional_amendment: data.isConstitutionalAmendment ?? false,
    };
    const { data: result, error } = await supabase.from('government_legislation')
        .insert(payload).select('id, title, body, summary, status, author_id, sponsor_position_id, parent_legislation_id, is_constitutional_amendment, voting_start, voting_end, votes_for, votes_against, votes_abstain, passed_at, vetoed_at, vetoed_by_id, veto_reason, repealed_at, repealed_by_legislation_id, created_at, updated_at').single();
    handleSupabaseError({ error, message: 'Failed to create legislation' });
    broadcastGovernmentUpdate('legislation');
    return result ? toGovernmentLegislation(result) : null;
}

export async function updateLegislation(legislationId: number, updates: Partial<GovernmentLegislation>) {
    // Cannot update while in Voting status. Fails CLOSED: a discarded read error made
    // an unreadable status pass as "not Voting", letting the text change mid-vote.
    const { data: leg, error: legErr } = await supabase.from('government_legislation')
        .select('status').eq('id', legislationId).single();
    handleSupabaseError({ error: legErr, message: 'Failed to load legislation' });
    if (leg?.status === 'Voting') throw new Error('Cannot modify legislation while voting is active');

    const dbUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.body !== undefined) {
        dbUpdates.body = sanitizeLegislationBody(updates.body);
    }
    if (updates.summary !== undefined) dbUpdates.summary = updates.summary;
    if (updates.sponsorPositionId !== undefined) dbUpdates.sponsor_position_id = updates.sponsorPositionId;
    if (updates.isConstitutionalAmendment !== undefined) dbUpdates.is_constitutional_amendment = updates.isConstitutionalAmendment;

    const { error } = await supabase.from('government_legislation')
        .update(dbUpdates).eq('id', legislationId);
    handleSupabaseError({ error, message: 'Failed to update legislation' });
    broadcastGovernmentUpdate('legislation');
}

export async function proposeLegislation(legislationId: number) {
    const { error } = await supabase.from('government_legislation')
        .update({ status: 'Proposed', updated_at: new Date().toISOString() })
        .eq('id', legislationId).eq('status', 'Draft');
    handleSupabaseError({ error, message: 'Failed to propose legislation' });
    broadcastGovernmentUpdate('legislation');
}

export async function startLegislationDebate(legislationId: number) {
    const { error } = await supabase.from('government_legislation')
        .update({ status: 'Debate', updated_at: new Date().toISOString() })
        .eq('id', legislationId).eq('status', 'Proposed');
    handleSupabaseError({ error, message: 'Failed to start debate' });
    broadcastGovernmentUpdate('legislation');
}

export async function startLegislationVote(legislationId: number) {
    const now = new Date().toISOString();
    const { error } = await supabase.from('government_legislation')
        .update({ status: 'Voting', voting_start: now, updated_at: now })
        .eq('id', legislationId)
        .in('status', ['Proposed', 'Debate']);
    handleSupabaseError({ error, message: 'Failed to start vote' });
    broadcastGovernmentUpdate('legislation');
}

export async function castLegislationVote(
    legislationId: number,
    userId: number,
    positionId: number,
    vote: 'for' | 'against' | 'abstain'
) {
    // Verify legislation is in Voting status
    const { data: leg } = await supabase.from('government_legislation')
        .select('status').eq('id', legislationId).single();
    if (!leg || leg.status !== 'Voting') throw new Error('Legislation is not in voting phase');

    // Verify user holds a position with can_vote_legislation
    const { data: holder } = await supabase.from('government_position_holders')
        .select('position_id, position:government_positions(can_vote_legislation)')
        .eq('user_id', userId).eq('position_id', positionId)
        .is('ended_at', null).single();
    const holderRow = holder as { position?: { can_vote_legislation?: boolean } | null } | null;
    if (!holderRow || !holderRow.position?.can_vote_legislation) {
        throw new Error('You do not hold a position with legislative voting rights');
    }

    // One-person-one-vote. Pre-check, and treat the UNIQUE violation
    // (uq_gov_legislation_vote) as the authoritative atomic guard against a
    // concurrent double-submit.
    const { data: existingVote } = await supabase.from('government_legislation_votes')
        .select('id').eq('legislation_id', legislationId).eq('user_id', userId).maybeSingle();
    if (existingVote) throw new Error('You have already voted on this legislation.');

    const { error } = await supabase.from('government_legislation_votes').insert({
        legislation_id: legislationId,
        user_id: userId,
        position_id: positionId,
        vote,
    });
    if (error && (error as { code?: string }).code === '23505') throw new Error('You have already voted on this legislation.');
    handleSupabaseError({ error, message: 'Failed to cast legislation vote' });

    // The ballot is stored from here on. A tally refresh that fails still throws
    // ('Your vote was recorded, but ...'), but the id-only broadcast goes out regardless
    // — skipping it left every other member unaware that a ballot had landed.
    try {
        await updateLegislationVoteCounts(legislationId);
    } finally {
        broadcastGovernmentUpdate('legislation');
    }
}

// Refreshes the cached votes_* columns the bill shows while voting is open. They no
// longer DECIDE anything — concludeLegislationVote recounts the ballot rows itself —
// but they still fail CLOSED on both I/O steps: a discarded recount read error used to
// fall through `votes || []` and overwrite the tally with 0/0/0, and a discarded tally
// write error left a stale tally with no signal. The ballot row itself is already
// stored — the message says so, so a voter does not retry into "already voted".
async function updateLegislationVoteCounts(legislationId: number) {
    const { data: votes, error: readErr } = await supabase.from('government_legislation_votes')
        .select('vote').eq('legislation_id', legislationId);
    handleSupabaseError({ error: readErr, message: 'Your vote was recorded, but the legislation tally could not be recounted' });
    const counts = { for: 0, against: 0, abstain: 0 };
    for (const v of (votes || [])) {
        if (v.vote in counts) counts[v.vote as keyof typeof counts]++;
    }
    const { error: writeErr } = await supabase.from('government_legislation').update({
        votes_for: counts.for,
        votes_against: counts.against,
        votes_abstain: counts.abstain,
        updated_at: new Date().toISOString(),
    }).eq('id', legislationId);
    handleSupabaseError({ error: writeErr, message: 'Your vote was recorded, but the legislation tally could not be saved' });
}

// ---------------------------------------------------------------------------
// Conclusion recount — every ballot row, or a refusal
// ---------------------------------------------------------------------------

const RECOUNT_PAGE = 1000;
const RECOUNT_MAX_PAGES = 500;   // 500k ballots, far past any org, then refuse

interface VoteTally { for: number; against: number; abstain: number }

/**
 * A bill or motion is DECIDED from its ballot rows, never from the cached votes_*
 * columns.
 *
 * The cache is rewritten after every cast, but only on a best-effort path: the ballot
 * is stored first, and a recount or cache write that fails after it leaves the cache
 * one or more votes behind (the voter is told so, and cannot re-cast). The conclusion
 * used to read that cache — so a failed cache refresh after the deciding vote could
 * carry a bill the ballots had defeated, or the reverse.
 *
 * So the conclusion counts the rows itself: paged to exhaustion on a total order (id),
 * then VERIFIED against an exact count taken after the pages. That count alone does not
 * catch every ballot cast mid-read: an identity id is drawn at insert but becomes
 * visible at commit, so a ballot can appear with an id inside a page already read. It
 * then pushes that page's last row across the boundary — read twice, the new ballot
 * never read, and the totals still agree. A repeated id therefore refuses too; a ballot
 * that lands after the read position is caught by the count. Any read error refuses
 * as well. A refused conclusion is re-runnable; a wrong one is on the record. Same
 * shape as getVotesForElection.
 */
async function recountBallots(
    table: 'government_legislation_votes' | 'government_motion_votes',
    parentColumn: 'legislation_id' | 'motion_id',
    parentId: number,
    noun: 'legislation' | 'motion',
): Promise<VoteTally> {
    const refusal = `The ${noun} ballot count changed while it was being recounted — conclude it again.`;
    const tally: VoteTally = { for: 0, against: 0, abstain: 0 };
    const seenIds = new Set<number>();
    for (let page = 0; page < RECOUNT_MAX_PAGES; page++) {
        const from = page * RECOUNT_PAGE;
        const { data, error } = await supabase.from(table)
            .select('id, vote')
            .eq(parentColumn, parentId)
            .order('id', { ascending: true })
            .range(from, from + RECOUNT_PAGE - 1);
        handleSupabaseError({ error, message: `Failed to recount the ${noun} ballots` });
        const rows = (data || []) as Array<{ id: number; vote: string }>;
        for (const r of rows) {
            if (seenIds.has(r.id)) throw new Error(refusal);
            seenIds.add(r.id);
            if (r.vote === 'for') tally.for++;
            else if (r.vote === 'against') tally.against++;
            else if (r.vote === 'abstain') tally.abstain++;
        }
        if (rows.length < RECOUNT_PAGE) break;
        if (page === RECOUNT_MAX_PAGES - 1) throw new Error(`Too many ${noun} ballots to recount safely — refusing to conclude on a partial count.`);
    }

    const { count, error: countErr } = await supabase.from(table)
        .select('id', { count: 'exact', head: true })
        .eq(parentColumn, parentId);
    handleSupabaseError({ error: countErr, message: `Failed to verify the ${noun} ballot count` });
    if (count == null || count !== seenIds.size) throw new Error(refusal);
    return tally;
}

/**
 * What a conclusion decided, carrying the fields its announcement needs: the
 * gov:conclude_* handlers used to read title/status off a result that only held
 * `passed`, so every push said the generic "A bill concluded (final).".
 */
export interface VoteConclusion {
    passed: boolean;
    status: 'Passed' | 'Failed';
    title: string;
}

// Only an item in its voting state ('Voting' — the same word in LegislationStatus and
// MotionStatus, and the only state the UI offers Conclude from) may be concluded. With no
// status check, concluding a Vetoed bill re-decided it from its old ballots — an un-veto —
// and a Draft, or a cancelled motion, could be "concluded" too. The conclusion UPDATE
// carries the same condition, so a status change between the read and the write (a second
// conclusion, a cancel) matches no row and refuses instead of silently overwriting it.

export async function concludeLegislationVote(legislationId: number): Promise<VoteConclusion> {
    const { data: leg, error: legErr } = await supabase.from('government_legislation')
        .select('id, status, title')
        .eq('id', legislationId).maybeSingle();
    handleSupabaseError({ error: legErr, message: 'Failed to load legislation' });
    if (!leg) throw new Error('Legislation not found');
    if (leg.status !== 'Voting') throw new Error('Legislation is not in voting phase');

    const tally = await recountBallots('government_legislation_votes', 'legislation_id', legislationId, 'legislation');
    const now = new Date().toISOString();
    const passed = tally.for > tally.against;
    const status = passed ? 'Passed' : 'Failed';
    // The cache is brought into line with the recount the decision was taken from.
    const conclusion = {
        status,
        passed_at: passed ? now : null,
        voting_end: now,
        votes_for: tally.for,
        votes_against: tally.against,
        votes_abstain: tally.abstain,
        updated_at: now,
    };
    const { data: concluded, error } = await supabase.from('government_legislation')
        .update(conclusion).eq('id', legislationId).eq('status', 'Voting').select('id');
    handleSupabaseError({ error, message: 'Failed to conclude vote' });
    if (!Array.isArray(concluded) || concluded.length === 0) {
        throw new Error('Legislation is no longer in voting phase — it was not concluded.');
    }
    broadcastGovernmentUpdate('legislation');
    return { passed, status, title: leg.title };
}

export async function vetoLegislation(legislationId: number, userId: number, reason: string) {
    // Verify the user currently holds a position with veto power. (An unreadable list
    // reads as no holdings, so a read fault refuses the veto.)
    const { data: holders } = await supabase.from('government_position_holders')
        .select('position:government_positions(can_veto_legislation)')
        .eq('user_id', userId).is('ended_at', null);
    const holderRows = (holders || []) as { position?: { can_veto_legislation?: boolean } | null }[];
    const canVeto = holderRows.some((h) => h.position?.can_veto_legislation);
    if (!canVeto) throw new Error('You do not hold a position with veto power');

    const now = new Date().toISOString();
    const { error } = await supabase.from('government_legislation').update({
        status: 'Vetoed',
        vetoed_at: now,
        vetoed_by_id: userId,
        veto_reason: reason || null,
        updated_at: now,
    }).eq('id', legislationId).eq('status', 'Passed');
    handleSupabaseError({ error, message: 'Failed to veto legislation' });
    broadcastGovernmentUpdate('legislation');
}

export async function repealLegislation(legislationId: number, repealingLegislationId: number | null) {
    const now = new Date().toISOString();
    const { error } = await supabase.from('government_legislation').update({
        status: 'Repealed',
        repealed_at: now,
        repealed_by_legislation_id: repealingLegislationId || null,
        updated_at: now,
    }).eq('id', legislationId).eq('status', 'Passed');
    handleSupabaseError({ error, message: 'Failed to repeal legislation' });
    broadcastGovernmentUpdate('legislation');
}

// ---------------------------------------------------------------------------
// Legislation Comments
// ---------------------------------------------------------------------------

export async function addLegislationComment(legislationId: number, userId: number, content: string): Promise<GovernmentLegislationComment | null> {
    // Comments are gated at the read-level gov:view perm and rendered to other
    // members — strip markup + cap length at the boundary (defence-in-depth
    // against stored HTML/markup injection).
    const safeContent = stripHtml(content, 4000);
    const { data: result, error } = await supabase.from('government_legislation_comments').insert({
        legislation_id: legislationId,
        user_id: userId,
        content: safeContent,
    }).select('id, legislation_id, user_id, content, created_at').single();
    handleSupabaseError({ error, message: 'Failed to add comment' });
    broadcastGovernmentUpdate('legislation');
    return result ? toGovernmentLegislationComment(result) : null;
}

export async function deleteLegislationComment(commentId: number) {
    const { error } = await supabase.from('government_legislation_comments')
        .delete().eq('id', commentId);
    handleSupabaseError({ error, message: 'Failed to delete comment' });
    broadcastGovernmentUpdate('legislation');
}

// ---------------------------------------------------------------------------
// Motions CRUD
// ---------------------------------------------------------------------------

const MOTION_DESCRIPTION_ERROR = 'Motion description must be a rich-text document.';

// Motion description is edited via the WikiEditor (Tiptap JSON) — sanitize on save.
// The same flaw sanitizeLegislationBody closes: a non-object description used to be
// stored exactly as received, skipping sanitizeTiptapJson, so a raw RPC could persist
// an arbitrary string that renders as the motion text. Only an absent/empty
// description keeps the legacy NULL (what MotionsTab sends for an empty editor);
// every other non-object is refused rather than guessed at.
// Deliberately NO normalizeDocMediaForStorage, unlike the bill body: getMotionsState
// never re-signs private keys (no signDocMediaForClient), so collapsing a signed image
// URL to its bare key here would break the image on the very next read. The image
// cap is pure bounding and does apply.
function sanitizeMotionDescription(description: unknown): unknown {
    if (description === undefined || description === null || description === '') return null;
    if (typeof description !== 'object') throw new Error(MOTION_DESCRIPTION_ERROR);
    const safe = sanitizeTiptapJson(description, 'wiki');
    assertDocImageCap(safe);
    return safe;
}

// There is no motion update path (no gov:update_motion action, no updateMotion): a
// motion's text is fixed at creation, so createMotion is the only description write.
export async function createMotion(data: MotionInput): Promise<GovernmentMotion | null> {
    const safeDescription = sanitizeMotionDescription(data.description);
    // restricted_to_position_ids is an integer[] (no FK constraint possible), so
    // validate each id refers to a real position before storing the vote-restriction
    // set — otherwise a gov:manage holder could write arbitrary/garbage ids.
    let restrictedIds: number[] | null = null;
    if (Array.isArray(data.restrictedToPositionIds) && data.restrictedToPositionIds.length > 0) {
        const wanted = [...new Set(data.restrictedToPositionIds.filter((n) => Number.isInteger(n)))];
        const { data: found } = await supabase.from('government_positions').select('id').in('id', wanted);
        const valid = new Set((found || []).map((p: { id: number }) => p.id));
        if (wanted.some((id) => !valid.has(id))) {
            throw new Error('One or more restricted positions do not exist.');
        }
        restrictedIds = wanted;
    }
    const payload = {
        title: data.title,
        description: safeDescription,
        status: 'Open',
        created_by_id: data.userId,
        restricted_to_position_ids: restrictedIds,
        is_secret_ballot: data.isSecretBallot ?? false,
    };
    const { data: result, error } = await supabase.from('government_motions')
        .insert(payload).select('id, title, description, status, created_by_id, restricted_to_position_ids, voting_start, voting_end, votes_for, votes_against, votes_abstain, is_secret_ballot, concluded_at, created_at, updated_at').single();
    handleSupabaseError({ error, message: 'Failed to create motion' });
    broadcastGovernmentUpdate('motions');
    return result ? toGovernmentMotion(result) : null;
}

export async function startMotionVote(motionId: number) {
    const now = new Date().toISOString();
    const { error } = await supabase.from('government_motions')
        .update({ status: 'Voting', voting_start: now, updated_at: now })
        .eq('id', motionId).eq('status', 'Open');
    handleSupabaseError({ error, message: 'Failed to start motion vote' });
    broadcastGovernmentUpdate('motions');
}

export async function castMotionVote(
    motionId: number,
    userId: number,
    vote: 'for' | 'against' | 'abstain'
) {
    const { data: motion } = await supabase.from('government_motions')
        .select('status, is_secret_ballot, restricted_to_position_ids')
        .eq('id', motionId).single();
    if (!motion || motion.status !== 'Voting') throw new Error('Motion is not in voting phase');

    // Check position restriction
    if (motion.restricted_to_position_ids && motion.restricted_to_position_ids.length > 0) {
        const { count } = await supabase.from('government_position_holders')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId).is('ended_at', null)
            .in('position_id', motion.restricted_to_position_ids);
        if (!count || count === 0) throw new Error('You do not hold a required position to vote on this motion');
    }

    // One-person-one-vote. computeVoterHash is deterministic, so a re-vote yields
    // the same voter_hash and trips uq_gov_motion_vote_hash; the non-secret path
    // trips uq_gov_motion_vote_user. Pre-check + 23505 guard.
    if (motion.is_secret_ballot) {
        const voterHash = computeVoterHash(motionId, userId);
        const { data: existingVote } = await supabase.from('government_motion_votes')
            .select('id').eq('motion_id', motionId).eq('voter_hash', voterHash).maybeSingle();
        if (existingVote) throw new Error('You have already voted on this motion.');
        const { error } = await supabase.from('government_motion_votes').insert({
            motion_id: motionId,
            voter_hash: voterHash,
            vote,
        });
        if (error && (error as { code?: string }).code === '23505') throw new Error('You have already voted on this motion.');
        handleSupabaseError({ error, message: 'Failed to cast motion vote' });
    } else {
        const { data: existingVote } = await supabase.from('government_motion_votes')
            .select('id').eq('motion_id', motionId).eq('user_id', userId).maybeSingle();
        if (existingVote) throw new Error('You have already voted on this motion.');
        const { error } = await supabase.from('government_motion_votes').insert({
            motion_id: motionId,
            user_id: userId,
            vote,
        });
        if (error && (error as { code?: string }).code === '23505') throw new Error('You have already voted on this motion.');
        handleSupabaseError({ error, message: 'Failed to cast motion vote' });
    }

    // The ballot is stored from here on — as in castLegislationVote, a failed tally
    // refresh still throws, but the id-only broadcast goes out regardless.
    try {
        await updateMotionVoteCounts(motionId);
    } finally {
        broadcastGovernmentUpdate('motions');
    }
}

// Same fail-closed contract as updateLegislationVoteCounts: these cached columns are
// display-only (concludeMotion recounts the ballot rows), but neither a recount read
// error (formerly 0/0/0) nor a tally write error may pass silently.
async function updateMotionVoteCounts(motionId: number) {
    const { data: votes, error: readErr } = await supabase.from('government_motion_votes')
        .select('vote').eq('motion_id', motionId);
    handleSupabaseError({ error: readErr, message: 'Your vote was recorded, but the motion tally could not be recounted' });
    const counts = { for: 0, against: 0, abstain: 0 };
    for (const v of (votes || [])) {
        if (v.vote in counts) counts[v.vote as keyof typeof counts]++;
    }
    const { error: writeErr } = await supabase.from('government_motions').update({
        votes_for: counts.for,
        votes_against: counts.against,
        votes_abstain: counts.abstain,
        updated_at: new Date().toISOString(),
    }).eq('id', motionId);
    handleSupabaseError({ error: writeErr, message: 'Your vote was recorded, but the motion tally could not be saved' });
}

export async function concludeMotion(motionId: number): Promise<VoteConclusion> {
    const { data: motion, error: motionErr } = await supabase.from('government_motions')
        .select('id, status, title').eq('id', motionId).maybeSingle();
    handleSupabaseError({ error: motionErr, message: 'Failed to load motion' });
    if (!motion) throw new Error('Motion not found');
    // Voting state only — see the note above concludeLegislationVote.
    if (motion.status !== 'Voting') throw new Error('Motion is not in voting phase');

    // Decided from the ballot rows (see recountBallots), and the cache updated to match.
    const tally = await recountBallots('government_motion_votes', 'motion_id', motionId, 'motion');
    const now = new Date().toISOString();
    const passed = tally.for > tally.against;
    const status = passed ? 'Passed' : 'Failed';
    const conclusion = {
        status,
        concluded_at: now,
        voting_end: now,
        votes_for: tally.for,
        votes_against: tally.against,
        votes_abstain: tally.abstain,
        updated_at: now,
    };
    const { data: concluded, error } = await supabase.from('government_motions')
        .update(conclusion).eq('id', motionId).eq('status', 'Voting').select('id');
    handleSupabaseError({ error, message: 'Failed to conclude motion' });
    if (!Array.isArray(concluded) || concluded.length === 0) {
        throw new Error('Motion is no longer in voting phase — it was not concluded.');
    }
    broadcastGovernmentUpdate('motions');
    return { passed, status, title: motion.title };
}

export async function cancelMotion(motionId: number) {
    const { error } = await supabase.from('government_motions')
        .update({ status: 'Cancelled', concluded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', motionId)
        .in('status', ['Open', 'Voting']);
    handleSupabaseError({ error, message: 'Failed to cancel motion' });
    broadcastGovernmentUpdate('motions');
}
