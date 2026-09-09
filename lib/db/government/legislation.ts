
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

export async function createLegislation(data: Partial<GovernmentLegislation> & { userId?: number }): Promise<GovernmentLegislation | null> {
    // Legislation body is edited via the WikiEditor (Tiptap JSON) — sanitize on save.
    const safeBody = data.body && typeof data.body === 'object' ? normalizeDocMediaForStorage(sanitizeTiptapJson(data.body, 'wiki')) : (data.body || '');
    if (safeBody && typeof safeBody === 'object') assertDocImageCap(safeBody);
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
    // Cannot update while in Voting status
    const { data: leg } = await supabase.from('government_legislation')
        .select('status').eq('id', legislationId).single();
    if (leg?.status === 'Voting') throw new Error('Cannot modify legislation while voting is active');

    const dbUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.body !== undefined) {
        dbUpdates.body = updates.body && typeof updates.body === 'object'
            ? normalizeDocMediaForStorage(sanitizeTiptapJson(updates.body, 'wiki'))
            : updates.body;
        if (dbUpdates.body && typeof dbUpdates.body === 'object') assertDocImageCap(dbUpdates.body);
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

    // Update vote counts
    await updateLegislationVoteCounts(legislationId);
    broadcastGovernmentUpdate('legislation');
}

async function updateLegislationVoteCounts(legislationId: number) {
    const { data: votes } = await supabase.from('government_legislation_votes')
        .select('vote').eq('legislation_id', legislationId);
    const counts = { for: 0, against: 0, abstain: 0 };
    for (const v of (votes || [])) {
        if (v.vote in counts) counts[v.vote as keyof typeof counts]++;
    }
    await supabase.from('government_legislation').update({
        votes_for: counts.for,
        votes_against: counts.against,
        votes_abstain: counts.abstain,
        updated_at: new Date().toISOString(),
    }).eq('id', legislationId);
}

export async function concludeLegislationVote(legislationId: number): Promise<{ passed: boolean }> {
    const { data: leg } = await supabase.from('government_legislation')
        .select('votes_for, votes_against, votes_abstain')
        .eq('id', legislationId).single();
    if (!leg) throw new Error('Legislation not found');

    const now = new Date().toISOString();
    const passed = leg.votes_for > leg.votes_against;
    const { error } = await supabase.from('government_legislation').update({
        status: passed ? 'Passed' : 'Failed',
        passed_at: passed ? now : null,
        voting_end: now,
        updated_at: now,
    }).eq('id', legislationId);
    handleSupabaseError({ error, message: 'Failed to conclude vote' });
    broadcastGovernmentUpdate('legislation');
    return { passed };
}

export async function vetoLegislation(legislationId: number, userId: number, reason: string) {
    // Verify user holds a position with veto power
    const { count } = await supabase.from('government_position_holders')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId).is('ended_at', null)
        .not('position_id', 'is', null);

    // Check the positions they hold have veto power
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

export async function createMotion(data: MotionInput): Promise<GovernmentMotion | null> {
    // Motion description is edited via the WikiEditor (Tiptap JSON) — sanitize on save.
    const safeDescription = data.description && typeof data.description === 'object'
        ? sanitizeTiptapJson(data.description, 'wiki')
        : (data.description || null);
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

    // Update counts
    await updateMotionVoteCounts(motionId);
    broadcastGovernmentUpdate('motions');
}

async function updateMotionVoteCounts(motionId: number) {
    const { data: votes } = await supabase.from('government_motion_votes')
        .select('vote').eq('motion_id', motionId);
    const counts = { for: 0, against: 0, abstain: 0 };
    for (const v of (votes || [])) {
        if (v.vote in counts) counts[v.vote as keyof typeof counts]++;
    }
    await supabase.from('government_motions').update({
        votes_for: counts.for,
        votes_against: counts.against,
        votes_abstain: counts.abstain,
        updated_at: new Date().toISOString(),
    }).eq('id', motionId);
}

export async function concludeMotion(motionId: number): Promise<{ passed: boolean }> {
    const { data: motion } = await supabase.from('government_motions')
        .select('votes_for, votes_against').eq('id', motionId).single();
    if (!motion) throw new Error('Motion not found');

    const now = new Date().toISOString();
    const passed = motion.votes_for > motion.votes_against;
    const { error } = await supabase.from('government_motions').update({
        status: passed ? 'Passed' : 'Failed',
        concluded_at: now,
        voting_end: now,
        updated_at: now,
    }).eq('id', motionId);
    handleSupabaseError({ error, message: 'Failed to conclude motion' });
    broadcastGovernmentUpdate('motions');
    return { passed };
}

export async function cancelMotion(motionId: number) {
    const { error } = await supabase.from('government_motions')
        .update({ status: 'Cancelled', concluded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', motionId)
        .in('status', ['Open', 'Voting']);
    handleSupabaseError({ error, message: 'Failed to cancel motion' });
    broadcastGovernmentUpdate('motions');
}
