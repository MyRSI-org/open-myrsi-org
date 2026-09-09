
import * as db from '../../lib/db.js';
import { sendPushToPermission } from '../../lib/push.js';
import { log as baseLog } from '../../lib/log.js';
import type {
    GovernmentConfig,
    GovernmentsFeatureConfig,
    GovernmentBranch,
    GovernmentPosition,
    GovernmentElection,
    GovernmentLegislation,
} from '../../types.js';
import type { GovernmentOrderInput } from '../../lib/db/government/orders.js';

const log = baseLog.child({ module: 'actions.government' });

// ---------------------------------------------------------------------------
// Payload interfaces — colocated, typed at the RPC auth boundary. The dispatcher
// (api/services.ts) types handlers as (payload: any) => Promise<unknown> and
// spreads them into a registry, so narrowing each handler's payload to a precise
// interface is assignment-safe. Nested create/update data shapes are passed
// straight through to lib/db functions (whose params are still `any`), so only
// the fields read directly in this file need precise typing.
// ---------------------------------------------------------------------------

interface UpdateFeatureConfigPayload {
    config: GovernmentsFeatureConfig;
}

interface UpsertConfigPayload {
    config: Partial<GovernmentConfig>;
}

interface ApplyTemplatePayload {
    templateType: string;
}

interface UpdateConstitutionPayload {
    content: unknown;
}

interface CreateBranchPayload {
    branchData: Partial<GovernmentBranch>;
}

interface UpdateBranchPayload {
    branchId: number;
    updates: Partial<GovernmentBranch>;
}

interface DeleteBranchPayload {
    branchId: number;
}

interface ReorderBranchesPayload {
    orderedIds: number[];
}

interface CreatePositionPayload {
    positionData: Partial<GovernmentPosition>;
}

interface UpdatePositionPayload {
    positionId: number;
    updates: Partial<GovernmentPosition>;
}

interface DeletePositionPayload {
    positionId: number;
}

interface ReorderPositionsPayload {
    branchId?: number | null;
    orderedIds: number[];
}

/**
 * Actor the dispatcher injects. The gov authority ceiling reads role IDENTITY
 * (isSystemAdmin) + permissions — never the name-derived `role` tier. Mirrors
 * GovActor in lib/db/government/structure.ts; keep the two in lock-step.
 */
interface GovActor { id?: number; isSystemAdmin?: boolean; permissions?: string[] }

interface AppointHolderPayload {
    positionId: number;
    targetUserId: number;
    userId: number;
    user?: GovActor;
}

interface RemoveHolderPayload {
    holderId: number;
    reason?: string;
    user?: GovActor;
}

// Election creation data — passed through to db.createElection / db.callByElection
// after merging in `userId`. Only `title` is read in this file.
interface ElectionData {
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
}

interface CreateElectionPayload {
    electionData: ElectionData;
    userId: number;
}

interface UpdateElectionPayload {
    electionId: number;
    updates: Partial<GovernmentElection>;
}

interface AdvanceElectionPayload {
    electionId: number;
}

interface CancelElectionPayload {
    electionId: number;
    reason: string;
}

interface CertifyResultsPayload {
    electionId: number;
    userId: number;
}

interface CallByElectionPayload {
    electionData: ElectionData;
    userId: number;
}

interface DeclareCandidacyPayload {
    electionId: number;
    userId: number;
    statement: string | null;
}

interface WithdrawCandidacyPayload {
    electionId: number;
    userId: number;
}

interface CastElectionVotePayload {
    electionId: number;
    userId: number;
    selections: { candidateId: number; rankOrder?: number }[];
}

interface CreateLegislationPayload {
    legislationData: Partial<GovernmentLegislation>;
    userId: number;
}

interface UpdateLegislationPayload {
    legislationId: number;
    updates: Partial<GovernmentLegislation>;
}

interface ProposeLegislationPayload {
    legislationId: number;
}

interface StartLegislationDebatePayload {
    legislationId: number;
}

interface StartLegislationVotePayload {
    legislationId: number;
}

interface CastLegislationVotePayload {
    legislationId: number;
    userId: number;
    positionId: number;
    vote: 'for' | 'against' | 'abstain';
}

interface ConcludeLegislationVotePayload {
    legislationId: number;
}

interface VetoLegislationPayload {
    legislationId: number;
    userId: number;
    reason: string;
}

interface RepealLegislationPayload {
    legislationId: number;
    repealingLegislationId: number | null;
}

interface AddLegislationCommentPayload {
    legislationId: number;
    userId: number;
    content: string;
}

interface DeleteLegislationCommentPayload {
    commentId: number;
}

// Motion creation data — passed through to db.createMotion after merging in
// `userId`. Only `title` is read in this file.
interface MotionData {
    title?: string;
    description?: unknown;
    restrictedToPositionIds?: number[];
    isSecretBallot?: boolean;
}

interface CreateMotionPayload {
    motionData: MotionData;
    userId: number;
}

interface StartMotionVotePayload {
    motionId: number;
}

interface CastMotionVotePayload {
    motionId: number;
    userId: number;
    vote: 'for' | 'against' | 'abstain';
}

interface ConcludeMotionPayload {
    motionId: number;
}

interface CancelMotionPayload {
    motionId: number;
}

interface ListOrdersPayload {
    userId: number;
}

interface GetOrderPayload {
    orderId: string;
    userId: number;
}

interface GetMyIssuingPositionsPayload {
    userId: number;
}

interface CreateOrderPayload {
    input: GovernmentOrderInput;
    userId: number;
}

interface UpdateOrderPayload {
    orderId: string;
    patch: Partial<GovernmentOrderInput>;
    userId: number;
}

interface RevokeOrderPayload {
    orderId: string;
    reason: string;
    userId: number;
}

interface DeleteOrderPayload {
    orderId: string;
    userId: number;
}

// Narrow view of the fields read off a db result when composing notifications.
// db handlers return mapped domain objects (or null/void/any); this reads `id`,
// `title`, `status` defensively, preserving the original `(result as any)?.field`
// semantics (missing/non-object → undefined → notification fallbacks apply).
interface NotifiableResult {
    id?: number | string;
    title?: string;
    status?: string;
}

function asResult(result: unknown): NotifiableResult {
    return result && typeof result === 'object' ? (result as NotifiableResult) : {};
}

/**
 * Fire-and-forget push to every member who can see government. Silences any
 * errors so the caller never blocks on delivery or push infra trouble.
 */
function notifyOrg(title: string, body: string, tag: string, data: Record<string, unknown> = {}) {
    sendPushToPermission('gov:view', {
        title,
        body,
        tag,
        data: { view: 'government', ...data },
    }).catch((err) => log.warn('push failed', { err }));
}

export const governmentActions = {
    // Feature Toggle
    'gov:update_feature_config': ({ config }: UpdateFeatureConfigPayload) =>
        db.updateGovernmentsConfig(config),

    // Config
    'gov:upsert_config': ({ config }: UpsertConfigPayload) =>
        db.upsertGovernmentConfig(config),

    'gov:apply_template': ({ templateType }: ApplyTemplatePayload) =>
        db.applyGovernmentTemplate(templateType),

    'gov:get_templates': async () =>
        db.getGovernmentTemplates(),

    'gov:update_constitution': ({ content }: UpdateConstitutionPayload) =>
        db.updateConstitution(content),

    // Branches
    'gov:create_branch': ({ branchData }: CreateBranchPayload) =>
        db.createGovernmentBranch(branchData),

    'gov:update_branch': ({ branchId, updates }: UpdateBranchPayload) =>
        db.updateGovernmentBranch(branchId, updates),

    'gov:delete_branch': ({ branchId }: DeleteBranchPayload) =>
        db.deleteGovernmentBranch(branchId),

    'gov:reorder_branches': ({ orderedIds }: ReorderBranchesPayload) =>
        db.reorderGovernmentBranches(orderedIds),

    // Positions
    'gov:create_position': ({ positionData }: CreatePositionPayload) =>
        db.createGovernmentPosition(positionData),

    'gov:update_position': ({ positionId, updates }: UpdatePositionPayload) =>
        db.updateGovernmentPosition(positionId, updates),

    'gov:delete_position': ({ positionId }: DeletePositionPayload) =>
        db.deleteGovernmentPosition(positionId),

    'gov:reorder_positions': ({ branchId, orderedIds }: ReorderPositionsPayload) =>
        db.reorderGovernmentPositions(branchId ?? null, orderedIds),

    // Position Holders
    'gov:appoint_holder': ({ positionId, targetUserId, userId, user }: AppointHolderPayload) =>
        db.appointPositionHolder({ positionId, userId: targetUserId, appointedById: userId }, user),

    'gov:remove_holder': ({ holderId, reason, user }: RemoveHolderPayload) =>
        db.removePositionHolder(holderId, reason || 'removed', user),

    // Elections
    'gov:create_election': async ({ electionData, userId }: CreateElectionPayload) => {
        const result = await db.createElection({ ...electionData, userId });
        const title = asResult(result).title || electionData?.title || 'An election';
        notifyOrg('Election called',
            `${title} has been scheduled. Watch this space for candidacy and voting windows.`,
            `gov-election-created-${asResult(result).id}`,
            { tab: 'elections', electionId: asResult(result).id });
        return result;
    },

    'gov:update_election': ({ electionId, updates }: UpdateElectionPayload) =>
        db.updateElection(electionId, updates),

    'gov:advance_election': async ({ electionId }: AdvanceElectionPayload) => {
        const result = await db.advanceElection(electionId);
        const status = asResult(result).status;
        const title = asResult(result).title || 'An election';
        if (status === 'CandidacyOpen') {
            notifyOrg('Candidacy open',
                `${title} — declare your candidacy if you want to run.`,
                `gov-election-candidacy-${electionId}`,
                { tab: 'elections', electionId });
        } else if (status === 'Voting') {
            notifyOrg('Voting open',
                `${title} — polls are now open. Cast your vote.`,
                `gov-election-voting-${electionId}`,
                { tab: 'elections', electionId });
        } else if (status === 'Concluded' || status === 'Certified') {
            notifyOrg('Election concluded',
                `${title} — results are in.`,
                `gov-election-concluded-${electionId}`,
                { tab: 'elections', electionId });
        }
        return result;
    },

    'gov:cancel_election': async ({ electionId, reason }: CancelElectionPayload) => {
        const result = await db.cancelElection(electionId, reason);
        notifyOrg('Election cancelled',
            reason ? `An election was cancelled: ${String(reason).slice(0, 140)}` : 'An election was cancelled.',
            `gov-election-cancelled-${electionId}`,
            { tab: 'elections', electionId });
        return result;
    },

    'gov:certify_results': async ({ electionId, userId }: CertifyResultsPayload) => {
        const result = await db.certifyElection(electionId, userId);
        const title = asResult(result).title || 'An election';
        notifyOrg('Results certified',
            `${title} — results have been certified.`,
            `gov-election-certified-${electionId}`,
            { tab: 'elections', electionId });
        return result;
    },

    'gov:call_by_election': async ({ electionData, userId }: CallByElectionPayload) => {
        const result = await db.callByElection({ ...electionData, userId });
        notifyOrg('By-election called',
            `${electionData?.title || 'A by-election'} has been called.`,
            `gov-by-election-${asResult(result).id}`,
            { tab: 'elections', electionId: asResult(result).id });
        return result;
    },

    'gov:declare_candidacy': ({ electionId, userId, statement }: DeclareCandidacyPayload) =>
        db.declareCandidacy(electionId, userId, statement),

    'gov:withdraw_candidacy': ({ electionId, userId }: WithdrawCandidacyPayload) =>
        db.withdrawCandidacy(electionId, userId),

    'gov:cast_election_vote': ({ electionId, userId, selections }: CastElectionVotePayload) =>
        db.castElectionVote(electionId, userId, selections),

    // Legislation
    'gov:create_legislation': ({ legislationData, userId }: CreateLegislationPayload) =>
        db.createLegislation({ ...legislationData, userId }),

    'gov:update_legislation': ({ legislationId, updates }: UpdateLegislationPayload) =>
        db.updateLegislation(legislationId, updates),

    'gov:propose_legislation': async ({ legislationId }: ProposeLegislationPayload) => {
        const result = await db.proposeLegislation(legislationId);
        const title = asResult(result).title || 'A bill';
        notifyOrg('Legislation proposed',
            `${title} — now on the floor for debate.`,
            `gov-legislation-proposed-${legislationId}`,
            { tab: 'legislation', legislationId });
        return result;
    },

    'gov:start_legislation_debate': ({ legislationId }: StartLegislationDebatePayload) =>
        db.startLegislationDebate(legislationId),

    'gov:start_legislation_vote': async ({ legislationId }: StartLegislationVotePayload) => {
        const result = await db.startLegislationVote(legislationId);
        const title = asResult(result).title || 'A bill';
        notifyOrg('Vote opened',
            `${title} is now open for voting.`,
            `gov-legislation-voting-${legislationId}`,
            { tab: 'legislation', legislationId });
        return result;
    },

    'gov:cast_legislation_vote': ({ legislationId, userId, positionId, vote }: CastLegislationVotePayload) =>
        db.castLegislationVote(legislationId, userId, positionId, vote),

    'gov:conclude_legislation_vote': async ({ legislationId }: ConcludeLegislationVotePayload) => {
        const result = await db.concludeLegislationVote(legislationId);
        const title = asResult(result).title || 'A bill';
        const status = asResult(result).status;
        const verdict = status === 'Passed' ? 'passed'
            : status === 'Defeated' ? 'was defeated'
            : `concluded (${status || 'final'})`;
        notifyOrg('Legislation concluded',
            `${title} ${verdict}.`,
            `gov-legislation-concluded-${legislationId}`,
            { tab: 'legislation', legislationId });
        return result;
    },

    'gov:veto_legislation': async ({ legislationId, userId, reason }: VetoLegislationPayload) => {
        const result = await db.vetoLegislation(legislationId, userId, reason);
        const title = asResult(result).title || 'A bill';
        notifyOrg('Bill vetoed',
            reason ? `${title} was vetoed: ${String(reason).slice(0, 140)}` : `${title} was vetoed.`,
            `gov-legislation-vetoed-${legislationId}`,
            { tab: 'legislation', legislationId });
        return result;
    },

    'gov:repeal_legislation': async ({ legislationId, repealingLegislationId }: RepealLegislationPayload) => {
        const result = await db.repealLegislation(legislationId, repealingLegislationId);
        notifyOrg('Legislation repealed',
            `A previously-passed bill has been repealed.`,
            `gov-legislation-repealed-${legislationId}`,
            { tab: 'legislation', legislationId });
        return result;
    },

    'gov:add_legislation_comment': ({ legislationId, userId, content }: AddLegislationCommentPayload) =>
        db.addLegislationComment(legislationId, userId, content),

    'gov:delete_legislation_comment': ({ commentId }: DeleteLegislationCommentPayload) =>
        db.deleteLegislationComment(commentId),

    // Motions
    'gov:create_motion': async ({ motionData, userId }: CreateMotionPayload) => {
        const result = await db.createMotion({ ...motionData, userId });
        const title = asResult(result).title || motionData?.title || 'A motion';
        notifyOrg('Motion raised',
            `${title} — new motion on the floor.`,
            `gov-motion-created-${asResult(result).id}`,
            { tab: 'motions', motionId: asResult(result).id });
        return result;
    },

    'gov:start_motion_vote': async ({ motionId }: StartMotionVotePayload) => {
        const result = await db.startMotionVote(motionId);
        const title = asResult(result).title || 'A motion';
        notifyOrg('Motion vote open',
            `${title} is open for voting.`,
            `gov-motion-voting-${motionId}`,
            { tab: 'motions', motionId });
        return result;
    },

    'gov:cast_motion_vote': ({ motionId, userId, vote }: CastMotionVotePayload) =>
        db.castMotionVote(motionId, userId, vote),

    'gov:conclude_motion': async ({ motionId }: ConcludeMotionPayload) => {
        const result = await db.concludeMotion(motionId);
        const title = asResult(result).title || 'A motion';
        const status = asResult(result).status;
        const verdict = status === 'Passed' ? 'passed'
            : status === 'Failed' || status === 'Defeated' ? 'was defeated'
            : `concluded (${status || 'final'})`;
        notifyOrg('Motion concluded',
            `${title} ${verdict}.`,
            `gov-motion-concluded-${motionId}`,
            { tab: 'motions', motionId });
        return result;
    },

    'gov:cancel_motion': async ({ motionId }: CancelMotionPayload) => {
        const result = await db.cancelMotion(motionId);
        notifyOrg('Motion cancelled',
            'A motion was withdrawn from the floor.',
            `gov-motion-cancelled-${motionId}`,
            { tab: 'motions', motionId });
        return result;
    },

    // --- ORDERS ---
    'gov:list_orders': ({ userId }: ListOrdersPayload) =>
        db.listGovernmentOrders(userId),

    'gov:get_order': ({ orderId, userId }: GetOrderPayload) =>
        db.getGovernmentOrder(orderId, userId),

    'gov:get_my_issuing_positions': ({ userId }: GetMyIssuingPositionsPayload) =>
        db.getMyOrderIssuingPositions(userId),

    'gov:create_order': async ({ input, userId }: CreateOrderPayload) => {
        const result = await db.createGovernmentOrder(input, userId);
        const title = asResult(result).title || input?.title || 'An executive order';
        // Orders are often published in 'Draft' first; only notify once it goes live.
        if (!asResult(result).status || asResult(result).status === 'Active') {
            notifyOrg('Executive order issued',
                `${title} is now in force.`,
                `gov-order-issued-${asResult(result).id}`,
                { tab: 'orders', orderId: asResult(result).id });
        }
        return result;
    },

    'gov:update_order': async ({ orderId, patch, userId }: UpdateOrderPayload) => {
        const result = await db.updateGovernmentOrder(orderId, patch, userId);
        // A status flip from Draft → Active publishes the order — notify on that transition.
        // Compared as a widened string to preserve the original runtime check (the
        // GovernmentOrderInput status union is lower-case, so a strict `=== 'Active'`
        // would be flagged as a non-overlapping comparison).
        if ((patch?.status as string | undefined) === 'Active') {
            const title = asResult(result).title || 'An executive order';
            notifyOrg('Executive order issued',
                `${title} is now in force.`,
                `gov-order-issued-${orderId}`,
                { tab: 'orders', orderId });
        }
        return result;
    },

    'gov:revoke_order': async ({ orderId, reason, userId }: RevokeOrderPayload) => {
        const result = await db.revokeGovernmentOrder(orderId, reason, userId);
        const title = asResult(result).title || 'An executive order';
        notifyOrg('Executive order revoked',
            reason ? `${title} was revoked: ${String(reason).slice(0, 140)}` : `${title} was revoked.`,
            `gov-order-revoked-${orderId}`,
            { tab: 'orders', orderId });
        return result;
    },

    'gov:delete_order': ({ orderId, userId }: DeleteOrderPayload) =>
        db.deleteGovernmentOrder(orderId, userId),
};
