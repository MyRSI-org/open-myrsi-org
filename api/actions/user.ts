
import * as db from '../../lib/db.js';
import { sendPushToUsers } from '../../lib/push.js';

/** Actor-id fields the dispatcher injects on every payload. */
interface ActorPayload {
    userId: number;
}

type ToggleDutyPayload = ActorPayload;
interface HeartbeatPayload { userId: number; }
interface InitiateRsiUpdatePayload { userId: number; newHandle: string; }
interface VerifyRsiUpdatePayload { userId: number; }
interface CancelRsiUpdatePayload { userId: number; }
type SyncRolesPayload = ActorPayload;
interface UpdateSpecializationsPayload { userId: number; specializationIds: number[]; }
interface UpdateDisplayNamePayload { userId: number; displayName?: string | null; }
interface UpdatePreferencesPayload {
    userId: number;
    timezone?: string | null;
    dateFormat?: 'compact_12h' | 'iso_24h' | 'us_12h' | null;
}
interface GetClearanceHistoryPayload { userId: number; }

interface GetPositionHistoryPayload extends ActorPayload {
    targetUserId?: number;
    user?: { permissions?: string[] };
}

interface SetRadioChannelPayload extends ActorPayload {
    channelName?: string;
}

type DeleteSelfPayload = ActorPayload;

/** Web Push subscription as sent by the client (PushSubscriptionJSON-shaped). */
interface SubscribePushPayload {
    userId: number;
    endpoint: string;
    keys: { p256dh: string; auth: string };
    expirationTime?: number | null;
}

interface TestPushPayload { userId: number; }

interface ApplyJobPayload { jobId: string; userId: number; statement: string; }

interface SubmitApplicationPayload {
    userId: number;
    rsiHandle: string;
    name?: string;
    discordId?: string;
    referral?: string;
    notes?: string;
    assignedRecruiterId?: number | null;
}

interface UnitFeedPayload extends ActorPayload {
    unitId: number;
}
interface CreateUnitPostPayload extends ActorPayload {
    unitId: number;
    content: string;
}
interface DeleteUnitPostPayload extends ActorPayload {
    postId: string;
    unitId?: number;
    user?: { id?: number; permissions?: string[]; unit?: { id?: number; leaderId?: number } | null };
}

/** Per-unit detail updates applied through db.updateUnit (camelCase fields). */
interface UnitDetailUpdates {
    name?: string;
    parentUnitId?: number | null;
    sortOrder?: number;
    leaderId?: number | null;
    motto?: string | null;
    description?: string | null;
    logoUrl?: string | null;
    hasRadioChannel?: boolean;
    linkedChannelId?: string | null;
    isRestricted?: boolean;
}
interface UpdateUnitDetailsPayload {
    unitId: number;
    updates: UnitDetailUpdates;
}

export const userActions = {
    // Real logout, server-side: move the caller's tokens_valid_from forward so a
    // stolen token can't outlive the session (the dispatcher rejects any token issued
    // before that time). userId is forced to the signed-in caller, so this only ever
    // logs the caller out.
    'user:logout': ({ userId }: { userId: number }) => db.revokeUserSessions(userId),
    'user:toggle_duty': ({ userId }: ToggleDutyPayload) => db.toggleUserDutyStatus(userId),
    'user:heartbeat': ({ userId }: HeartbeatPayload) => db.updateUserHeartbeat(userId),
    'user:initiate_rsi_update': ({ userId, newHandle }: InitiateRsiUpdatePayload) => db.initiateRsiHandleUpdate(userId, newHandle),
    'user:verify_rsi_update': ({ userId }: VerifyRsiUpdatePayload) => db.verifyRsiUpdate(userId),
    'user:cancel_rsi_update': ({ userId }: CancelRsiUpdatePayload) => db.cancelRsiUpdate(userId),
    'user:sync_roles': ({ userId }: SyncRolesPayload) => db.syncUserRoles(userId),
    'user:update_specializations': ({ userId, specializationIds }: UpdateSpecializationsPayload) => db.updateUserSpecializations(userId, specializationIds),
    'user:update_display_name': ({ userId, displayName }: UpdateDisplayNamePayload) => db.updateUserDisplayName(userId, displayName),
    'user:update_preferences': ({ userId, timezone, dateFormat }: UpdatePreferencesPayload) => db.updateUserPreferences(userId, { timezone, dateFormat }),
    'user:get_clearance_history': ({ userId }: GetClearanceHistoryPayload) => db.getClearanceHistory(userId),
    // Position history (HR + Government, unified). Self-fetch is always allowed;
    // cross-user fetch requires hr:view or admin:user:update permission.
    'user:get_position_history': ({ targetUserId, userId, user }: GetPositionHistoryPayload) => {
        const target = targetUserId ?? userId;
        const isSelf = target === userId;
        const perms: string[] = user?.permissions || [];
        const canViewOthers = perms.includes('hr:view') || perms.includes('admin:user:update');
        if (!isSelf && !canViewOthers) throw new Error('Not authorized to view this user’s position history.');
        return db.getUserPositionHistory(target);
    },
    'user:set_radio_channel': ({ userId, channelName }: SetRadioChannelPayload) => db.updateUser(userId, { voiceChannelName: channelName }),
    'user:delete_self': ({ userId }: DeleteSelfPayload) => db.deleteUser(userId),
    'user:subscribe_push': (payload: SubscribePushPayload) => db.savePushSubscription(payload.userId, payload),
    'user:test_push': async ({ userId }: TestPushPayload) => {
        await sendPushToUsers([userId], {
            title: 'Signal Test',
            body: 'Comms Uplink Verified. You are receiving secure alerts.',
            tag: 'system-test'
        });
        return { success: true };
    },

    // --- HR SELF-SERVICE ---
    'user:apply_job': (payload: ApplyJobPayload) => db.applyForJob(payload),
    'user:submit_application': (payload: SubmitApplicationPayload) => db.createHRApplication(payload),

    // --- UNIT ACTIONS ---
    // Each per-unit RPC asserts access against the is_restricted flag.
    // assertUnitAccess lets admins with the units:view_all bypass through.
    'unit:get_feed': async ({ unitId, userId }: UnitFeedPayload) => {
        await db.assertUnitAccess(unitId, userId);
        return db.getUnitFeed(unitId);
    },
    'unit:create_post': async ({ unitId, userId, content }: CreateUnitPostPayload) => {
        await db.assertUnitAccess(unitId, userId);
        return db.createUnitPost(unitId, userId, content);
    },
    'unit:delete_post': async ({ postId, unitId, userId, user }: DeleteUnitPostPayload) => {
        // unitId is sent alongside postId so the restricted-unit access gate can
        // apply to the claimed unit; a legacy caller that omits it skips only that.
        // Authorization for the DELETE itself is computed inside deleteUnitPost
        // against the POST's OWN unit — never the client-supplied unitId.
        if (unitId) await db.assertUnitAccess(unitId, userId);
        return db.deleteUnitPost(postId, { id: userId, permissions: user?.permissions });
    },
    'unit:update_details': ({ unitId, updates }: UpdateUnitDetailsPayload) => {
        // This is the unit-LEADER edit path — the dispatcher lets a unit's own
        // leader through even without unit:manage:own. Restrict it to COSMETIC
        // fields. The structural fields (leaderId = hand off / orphan
        // leadership, parentUnitId = re-parent the org tree, isRestricted = flip
        // the visibility gate) are admin-only and must go through
        // admin:update_unit (gated admin:config:units).
        const u = updates || {};
        return db.updateUnit({
            id: unitId,
            ...(u.name !== undefined ? { name: u.name } : {}),
            ...(u.sortOrder !== undefined ? { sortOrder: u.sortOrder } : {}),
            ...(u.motto !== undefined ? { motto: u.motto } : {}),
            ...(u.description !== undefined ? { description: u.description } : {}),
            ...(u.logoUrl !== undefined ? { logoUrl: u.logoUrl } : {}),
            ...(u.hasRadioChannel !== undefined ? { hasRadioChannel: u.hasRadioChannel } : {}),
            ...(u.linkedChannelId !== undefined ? { linkedChannelId: u.linkedChannelId } : {}),
        });
    },
};
