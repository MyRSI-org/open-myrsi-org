
import * as db from '../../lib/db.js';
import { toOperationBoardElement } from '../../lib/db/mappers.js';
// Imported DIRECTLY, not through the barrel: lib/db/opAnnouncement.ts reads
// getOrgTenantUrl OFF the barrel, so re-exporting it back out would close a cycle.
import { buildAnnouncementEmbedInput } from '../../lib/db/opAnnouncement.js';
import {
    createGuildScheduledEvent,
    deleteGuildScheduledEvent,
    updateGuildScheduledEvent,
    listGuildChannels,
    postOperationAnnouncementEmbed,
    editOperationAnnouncementEmbed,
    deleteDiscordChannelMessage,
} from '../../lib/discord.js';
import { log as baseLog } from '../../lib/log.js';
import { normaliseDiscordSnowflake } from '../../lib/discordConfigKeys.js';
import { passesClearance, canViewAllClassifications } from '../../lib/clearance.js';
import { assertAiRateLimit } from '../../lib/aiRateLimit.js';
import type {
    OperationPayoutMode,
    OperationTemplatePayload,
} from '../../types.js';

const log = baseLog.child({ module: 'actions.operations' });

// --- Payload shapes ---
// Every mutation payload carries the actor's userId (injected server-side in
// api/services.ts). Numeric ids are numbers; operation ids are string UUIDs.
// The colocated interfaces below narrow each handler's `payload` from the
// dispatcher's `(payload: any)`, which is assignment-safe because the registry
// types handlers as `(payload: any) => Promise<unknown>`.

// Subset of the local Supabase error shape this file inspects.



// Free-form sub-resource payload (phases/schedule/tasks/nodes/board/logistics).
// The lib/db layer accepts `any` for these; we only ever read `status` directly
// (in update_phase), so keep it permissive but indexable.
interface SubResourceData {
    status?: string;
    [key: string]: unknown;
}

// Shape the createOperation handler reads off opData (a superset is forwarded
// to db.createOperation, which accepts the full operation-creation blob).
interface CreateOperationPayload {
    // Required by db.createOperation + the Discord scheduled-event mirror, which
    // pass `name` straight through to a `name: string` field.
    name: string;
    description?: string;
    scheduledStart?: string;
    scheduledEnd?: string;
    createDiscordEvent?: boolean;
    postDiscordAnnouncement?: boolean;
    discordAnnouncementChannelId?: string;
    [key: string]: unknown;
}

// Discord-link mirroring result returned by db.createOperation / updates. We
// only attach soft-fail markers + read `id`, so keep it indexable.
interface OperationMutationResult {
    id?: string;
    [key: string]: unknown;
}

// Fields a generic operation update may touch (forwarded to db.updateOperationDetails).
interface OperationUpdates {
    name?: string;
    description?: string;
    scheduledStart?: string;
    scheduledEnd?: string;
    type?: string;
    clearanceLevel?: number;
    unitId?: number | null;
    locationId?: number | null;
    locationText?: string | null;
    [key: string]: unknown;
}

// `role` is deliberately absent — see the ActorUser note in api/actions/intel.ts.
// This actor flows into the op clearance/marker predicates, which read isSystemAdmin.
interface GetDetailsPayload { operationId: string; user?: { id?: number; isSystemAdmin?: boolean; permissions?: string[]; clearanceLevel?: { level?: number } | null; limitingMarkers?: unknown[] } }
interface DeletePayload { operationId: string; userId: number }
interface UpdatePayload { operationId: string; updates: OperationUpdates; userId: number; user?: Parameters<typeof db.updateOperationDetails>[3] }
interface RepostAnnouncementPayload { operationId: string; channelId?: string }
interface UpdateStatusPayload { operationId: string; status: string; userId: number }
interface JoinPayload { operationId: string; userId: number; joinCode?: string }
// `user` is the server-injected actor (a full User); typed structurally here to the
// one field this handler inspects.
interface LeavePayload { operationId: string; targetUserId?: number; userId: number; user?: { permissions?: string[] } }
interface AddParticipantPayload { operationId: string; targetUserId: number; userId: number }
interface AddUecPayload { operationId: string; amount: number; reason: string; userId: number }
interface AddCostPayload { operationId: string; amount: number; category: string; description: string; userId: number }
interface SetPayoutModePayload { operationId: string; mode: OperationPayoutMode; userId: number }
interface SetPayoutSplitsPayload { operationId: string; splits: Array<{ userId: number; percent: number }>; userId: number }
interface TogglePayoutPaidPayload { operationId: string; targetUserId: number; paid: boolean; userId: number }
interface TimelineAddPayload { operationId: string; entry: string; userId: number }
interface ToggleReadyPayload { operationId: string; userId: number }
interface UpdateParticipantLiveStatusPayload { operationId: string; userId: number; liveStatus: string }
interface ResetReadinessPayload { operationId: string }
interface JoinWithRolePayload { operationId: string; userId: number; roleRequested?: string; shipUtilized?: string; joinCode?: string; shipId?: number; userShipId?: number }
interface UpdateParticipantPayload { operationId: string; targetUserId: number; updates: Record<string, unknown> }
interface RsvpPayload { operationId: string; userId: number; rsvpStatus: string; shipId?: number; userShipId?: number }
interface GetParticipantShipsPayload { operationId: string; userIds?: number[] }
interface UpdateLiveStatusPayload { operationId: string; liveStatus: string; userId: number }
interface AddPhasePayload { operationId: string; data: SubResourceData }
interface UpdatePhasePayload { phaseId: number; data: SubResourceData; operationId: string; userId: number }
interface DeletePhasePayload { phaseId: number; operationId: string }
interface AddScheduleEntryPayload { operationId: string; data: SubResourceData }
interface UpdateScheduleEntryPayload { entryId: number; data: SubResourceData; operationId: string }
interface DeleteScheduleEntryPayload { entryId: number; operationId: string }
interface AddTaskPayload { operationId: string; data: SubResourceData; userId: number }
interface UpdateTaskPayload { taskId: number; data: SubResourceData; operationId: string }
interface DeleteTaskPayload { taskId: number; operationId: string }
interface AddCommandNodePayload { operationId: string; data: SubResourceData; userId: number }
interface UpdateCommandNodePayload { nodeId: number; data: SubResourceData; operationId: string }
interface DeleteCommandNodePayload { nodeId: number; operationId: string }
interface AddShipSlotPayload { operationId: string; data: SubResourceData }
interface UpdateShipSlotPayload { slotId: number; data: SubResourceData; operationId: string }
interface DeleteShipSlotPayload { slotId: number; operationId: string }
interface AssignSlotPayload { operationId: string; slotId: number; targetUserId: number; userId: number; userShipId?: number }
interface ApplyForSlotPayload { operationId: string; slotId: number; userId: number; userShipId?: number }
interface DecideSlotApplicationPayload { operationId: string; slotId: number; targetUserId: number; decision: 'approve' | 'deny'; userId: number }
interface RemoveSlotAssignmentPayload { operationId: string; slotId: number; targetUserId: number }
// NOTE the absence of targetUserId: a member withdraws their OWN seat and nothing
// else. See the handler.
interface WithdrawSlotPayload { operationId: string; slotId: number; userId: number }
interface AddBoardElementPayload { operationId: string; data: SubResourceData; clientNonce?: string }
interface UpdateBoardElementPayload { elementId: number; data: SubResourceData; operationId: string }
interface DeleteBoardElementPayload { elementId: number; operationId: string }
interface SaveBoardPayload { operationId: string; elements: SubResourceData[] }
interface AddLogisticsPayload { operationId: string; data: SubResourceData }
interface UpdateLogisticsPayload { itemId: number; data: SubResourceData; operationId: string }
interface DeleteLogisticsPayload { itemId: number; operationId: string }
interface FulfillLogisticsPayload { itemId: number; quantity: number; userId: number; operationId: string }
interface BroadcastAlertPayload { operationId: string; message: string; userId: number }
interface AddAarEntryPayload { operationId: string; data: SubResourceData; userId: number }
interface DeleteAarEntryPayload { entryId: number; operationId: string }
interface SubmitAarPayload { operationId: string; userId: number; summary: string; lessonsLearned: string }
interface ReopenAarPayload { operationId: string; userId: number }
interface GenerateAarSummaryPayload { operationId: string }
interface TemplateListPayload { [key: string]: unknown }
interface TemplateGetPayload { id: number }
interface TemplateCreatePayload { name: string; description?: string | null; payload: OperationTemplatePayload; userId: number; sourceOperationId?: string }
interface TemplateUpdatePayload { id: number; name?: string; description?: string | null; payload?: OperationTemplatePayload }
interface TemplateDeletePayload { id: number }
interface TemplateFromOperationPayload { operationId: string }
interface ListGuildChannelsPayload { forceRefresh?: boolean }

// buildAnnouncementEmbedInput moved to lib/db/opAnnouncement.ts so the start-notice
// cron job can reuse it — a lib/ module must not import from api/actions/**.

/**
 * The role to @-mention on an operation announcement, read SERVER-SIDE.
 *
 * Never from a payload, and that is the entire control. Configuring who gets pinged
 * is an admin:config:discord decision; posting an announcement is operations:create.
 * A pingRoleId travelling in a request body would collapse the two and hand every op
 * creator an arbitrary @-mention primitive aimed at any role in the guild.
 *
 * Soft-fails to null: a settings read fault costs the ping, never the announcement.
 */
async function getOperationAnnouncePingRoleId(): Promise<string | null> {
    try {
        const { data } = await db.supabase.from('settings')
            .select('value').eq('key', 'discordConfig').maybeSingle();
        const cfg = (data?.value ?? null) as { operationAnnouncePingRoleId?: unknown } | null;
        return normaliseDiscordSnowflake(cfg?.operationAnnouncePingRoleId, 'operationAnnouncePingRoleId');
    } catch {
        return null;
    }
}

export const operationActions = {
    'operation:create': async (opData: CreateOperationPayload) => {
        const result = await db.createOperation(opData) as unknown as OperationMutationResult;
        // Auto-create reminders if scheduled
        if (opData.scheduledStart && result?.id) {
            await db.createOperationReminders(result.id, opData.scheduledStart);
        }
        // Create Discord Guild Scheduled Event if requested
        if (opData.createDiscordEvent && opData.scheduledStart && opData.scheduledEnd && result?.id) {
            // Resolve the org's tenant URL
            const tenantUrl = await db.getOrgTenantUrl();
            // Discord rejects any scheduled_start_time that isn't strictly in the
            // future. The wizard validates this, but the round-trip (network +
            // server work) can easily push a borderline pick into the past by the
            // time the body lands at Discord. Clamp to now + 60s as a courtesy so
            // the user doesn't see a confusing rejection on submission drift.
            const startMs = new Date(opData.scheduledStart).getTime();
            const minStartMs = Date.now() + 60_000;
            const clampedStartMs = Number.isFinite(startMs) && startMs > minStartMs ? startMs : minStartMs;
            const endMs = new Date(opData.scheduledEnd).getTime();
            // If end ended up ≤ clamped start (e.g. very short event whose start
            // got clamped forward), push end out 15 minutes past the new start.
            const clampedEndMs = Number.isFinite(endMs) && endMs > clampedStartMs ? endMs : clampedStartMs + 15 * 60_000;
            // EGRESS GATE: a Guild Scheduled Event is privacy_level GUILD_ONLY —
            // visible to EVERY member of the Discord server, a strictly wider
            // audience than the operator-picked announcement channel. So a
            // restricted op's briefing must not ride it. The event NAME is
            // unavoidable (Discord requires one) and matches what the collapsed
            // announcement embed keeps; the description is dropped entirely.
            // Same predicate as the embed so the two surfaces cannot drift.
            const restricted = await db.operationIsRestricted(result.id);
            const discordResult = await createGuildScheduledEvent({
                name: opData.name,
                description: restricted ? undefined : opData.description,
                scheduledStart: new Date(clampedStartMs).toISOString(),
                scheduledEnd: new Date(clampedEndMs).toISOString(),
                locationUrl: tenantUrl,
            });
            if (discordResult.eventId) {
                await db.supabase.from('operations').update({ discord_event_id: discordResult.eventId }).eq('id', result.id);
                result.discordEventId = discordResult.eventId;
            } else {
                result.discordEventFailed = discordResult.error || 'Unknown error creating Discord event.';
            }
        }
        // Post the optional channel announcement embed. Independent of the
        // Guild Scheduled Event above — orgs may use one, both, or neither.
        // Soft-fail: a Discord outage / missing perms must not break op create.
        if (opData.postDiscordAnnouncement && opData.discordAnnouncementChannelId && result?.id) {
            try {
                const input = await buildAnnouncementEmbedInput(result.id);
                if (!input) {
                    result.discordAnnouncementFailed = 'Could not load operation details for announcement.';
                } else {
                    // VALIDATE THE CALLER-SUPPLIED CHANNEL, exactly as
                    // operation:repost_announcement does below. Its comment says "both
                    // halves are needed; either alone leaves a door open" — that was
                    // true of repost and false HERE, and this action names the same
                    // destination under the weaker operations:create gate. lib/discord.ts
                    // now refuses a non-snowflake at the sink as well, but the value is
                    // also PERSISTED (lib/db/ops.ts) and re-fired later by the
                    // start-notice cron, so a junk id caught only at the sink becomes a
                    // silent, permanent "the bot doesn't post".
                    const post = await postOperationAnnouncementEmbed(
                        normaliseDiscordSnowflake(opData.discordAnnouncementChannelId, 'discordAnnouncementChannelId') || '',
                        input,
                        { pingRoleId: await getOperationAnnouncePingRoleId() },
                    );
                    if (post.messageId) {
                        await db.supabase.from('operations')
                            .update({ discord_announcement_message_id: post.messageId })
                            .eq('id', result.id);
                        result.discordAnnouncementMessageId = post.messageId;
                    } else {
                        result.discordAnnouncementFailed = post.error || 'Unknown error posting Discord announcement.';
                    }
                }
            } catch (err) {
                log.error('discord announcement post failed', { action: 'operation:create', err });
                result.discordAnnouncementFailed = err instanceof Error ? err.message : 'Unknown error posting Discord announcement.';
            }
        }
        return result;
    },
    'operation:get_details': async ({ operationId, user }: GetDetailsPayload) => {
        const op = await db.getFullOperationDetails(operationId);
        if (!op) return op;
        // The operations LIST filters by clearance, so the detail path must too
        // — otherwise ROE / commander notes / tasks / board leak for ops above
        // the caller's clearance. Owner and operations:manage holders bypass
        // (mirrors getOperations()).
        const isOwner = op.ownerId === user?.id;
        const canManage = canViewAllClassifications(user, ['operations:manage']);
        if (!isOwner && !passesClearance(user, op.clearanceLevel, op.limitingMarkers, ['operations:manage'])) {
            throw new Error('Insufficient clearance to view this operation.');
        }
        // Special operations are invite-only: their planning content
        // (roe / commander notes / comms plan / tasks / board) is readable only by
        // the owner, operations:manage holders, and ACTIVE participants — mirrors
        // the client `hasAccess` gate and canUserSeeOpInList / assertOpVisibleToUser
        // so list / slice / detail / action gates can't drift. A clearance-0
        // special op must not be openable by every member.
        if (op.isSpecial && !isOwner && !canManage
            && !op.participants?.some(p => p.userId === user?.id && p.timeLeft == null)) {
            throw new Error('Insufficient access to view this special operation.');
        }
        // Strip the join PIN for anyone but the owner / managers.
        if (!isOwner && !canManage) op.joinCode = undefined;

        // SEAT APPLICATIONS are organiser-facing. A pending application is a member
        // saying "I want that seat", which they said to the organiser — not to the
        // whole operation. Everyone else sees the assigned seats plus their OWN
        // application, and nobody else's.
        //
        // Done HERE, not in getFullOperationDetails, because that function takes no
        // viewer and has three other callers: the dispatcher's owner probe, the
        // federation snapshot builder, and get_participant_ships. A viewer-dependent
        // filter inside it would either break the probe or leak into federation input.
        // The panel's own canManage check is cosmetic — rule 2.
        if (!isOwner && !canManage && op.shipSlots?.length) {
            for (const slot of op.shipSlots) {
                // `|| []` because the slots and assignments reads soft-fail
                // independently: a TypeError here would 500 the WHOLE detail view for
                // every non-manager, not just hide the seats.
                slot.assignments = (slot.assignments || [])
                    .filter(a => a.status !== 'applied' || a.userId === user?.id);
            }
        }
        return op;
    },
    'operation:delete': async ({ operationId, userId }: DeletePayload) => {
        // Check for linked Discord event / announcement and clean up first
        const { data: op } = await db.supabase.from('operations')
            .select('discord_event_id, discord_announcement_channel_id, discord_announcement_message_id')
            .eq('id', operationId)
            .single();
        if (op?.discord_event_id) {
            await deleteGuildScheduledEvent(op.discord_event_id);
        }
        if (op?.discord_announcement_channel_id && op?.discord_announcement_message_id) {
            await deleteDiscordChannelMessage(op.discord_announcement_channel_id, op.discord_announcement_message_id);
        }
        return db.deleteOperation(operationId, userId);
    },
    'operation:update': async ({ operationId, updates, userId, user }: UpdatePayload) => {
        // Pass the acting user so updateOperationDetails can apply the
        // author-clearance clamp (assertCanClassify) + current-visibility guard
        // (passesClearance against the live row) — operations:create alone is not a
        // clearance bypass, and the op-owner dispatcher bypass makes this reachable.
        const result = await db.updateOperationDetails(operationId, updates, userId, user) as unknown as OperationMutationResult | null;

        // Mirror amendments onto the linked Discord scheduled event + announcement
        // embed, if either are linked. Soft dependency: failures surface as a
        // warning — the DB update still stands.
        // markerIds and isSpecial are in the list because either one RESTRICTS an
        // already-published op (lib/db/ops.ts handles both as ordinary edits) —
        // without them the full briefing stays on Discord, which is the whole
        // egress gate bypassed by a one-field edit.
        const touched = ['name', 'description', 'scheduledStart', 'scheduledEnd', 'type', 'clearanceLevel', 'unitId', 'locationId', 'locationText', 'markerIds', 'isSpecial'].some(k => updates?.[k] !== undefined);
        if (touched) {
            const { data: op } = await db.supabase.from('operations')
                .select('discord_event_id, discord_announcement_channel_id, discord_announcement_message_id, name, description, scheduled_start, scheduled_end')
                .eq('id', operationId)
                .single();
            if (op?.discord_event_id) {
                // EGRESS GATE, same predicate as the announcement embed: the event
                // is GUILD_ONLY, i.e. every guild member. Sent UNCONDITIONALLY when
                // restricted rather than only when `description` was edited —
                // otherwise attaching a marker (or flipping isSpecial) would restrict
                // the op while leaving the previously-published briefing on the event.
                const restricted = await db.operationIsRestricted(operationId);
                const discordResult = await updateGuildScheduledEvent(
                    op.discord_event_id,
                    {
                        // Send the current DB state for the touched fields — picks up
                        // whatever we just wrote, so we never drift from the source of truth.
                        ...(updates.name !== undefined ? { name: op.name } : {}),
                        ...(restricted
                            ? { description: '' }
                            : updates.description !== undefined ? { description: op.description } : {}),
                        ...(updates.scheduledStart !== undefined && op.scheduled_start ? { scheduledStart: op.scheduled_start } : {}),
                        ...(updates.scheduledEnd !== undefined && op.scheduled_end ? { scheduledEnd: op.scheduled_end } : {}),
                    },
                );
                if (!discordResult.ok) {
                    Object.assign(result || {}, { discordEventFailed: discordResult.error || 'Discord event update failed.' });
                }
            }
            // Edit the announcement embed in place when one is linked. Reactions
            // are preserved on edit. If the message was deleted on Discord
            // (404), surface the gone state so the UI can prompt a repost.
            if (op?.discord_announcement_channel_id && op?.discord_announcement_message_id) {
                try {
                    const input = await buildAnnouncementEmbedInput(operationId);
                    if (input) {
                        const editResult = await editOperationAnnouncementEmbed(
                            op.discord_announcement_channel_id,
                            op.discord_announcement_message_id,
                            input,
                        );
                        if (!editResult.ok) {
                            Object.assign(result || {}, { discordAnnouncementFailed: editResult.error || 'Discord announcement edit failed.' });
                            if (editResult.gone) {
                                // The message no longer exists on Discord — clear the stored ID
                                // so the next "Repost Announcement" click starts fresh.
                                await db.supabase.from('operations')
                                    .update({ discord_announcement_message_id: null })
                                    .eq('id', operationId);
                            }
                        }
                    }
                } catch (err) {
                    log.error('discord announcement edit failed', { action: 'operation:update', err });
                    Object.assign(result || {}, { discordAnnouncementFailed: err instanceof Error ? err.message : 'Discord announcement edit failed.' });
                }
            }
        }
        return result;
    },
    // Manual repost / first-time post of the operation announcement embed.
    // - If `channelId` is provided AND differs from the stored channel, the old
    //   message (if any) is deleted and a fresh embed posts to the new channel.
    // - If `channelId` matches the stored channel and a message exists, the
    //   embed is edited in place (reactions preserved).
    // - If no message is stored yet, a fresh embed posts to the chosen channel.
    'operation:repost_announcement': async ({ operationId, channelId }: RepostAnnouncementPayload) => {
        if (!operationId) throw new Error('operationId is required.');
        const { data: op } = await db.supabase.from('operations')
            .select('discord_announcement_channel_id, discord_announcement_message_id')
            .eq('id', operationId)

            .single();
        if (!op) throw new Error('Operation not found or access denied.');

        // VALIDATE THE CALLER-SUPPLIED CHANNEL. `channelId` comes straight off the
        // payload and is the DESTINATION of a bot post — without a shape check this
        // action posts to any string a caller sends. It is also why this action is now
        // in OWNER_BYPASS_EXCLUDED_OPERATION_ACTIONS: an op owner holding only
        // operations:create could otherwise aim the org's announcements at any channel
        // the bot can see. Both halves are needed; either alone leaves a door open.
        const requestedChannel = channelId != null && String(channelId).trim()
            ? normaliseDiscordSnowflake(channelId, 'channelId')
            : null;
        const targetChannel = requestedChannel || op.discord_announcement_channel_id;
        if (!targetChannel) throw new Error('No Discord channel selected for this announcement.');

        const channelChanged = !!op.discord_announcement_channel_id
            && !!op.discord_announcement_message_id
            && targetChannel !== op.discord_announcement_channel_id;


        const input = await buildAnnouncementEmbedInput(operationId);
        if (!input) throw new Error('Could not load operation details for announcement.');

        // Same channel + message exists → edit in place.
        if (op.discord_announcement_message_id && !channelChanged && targetChannel === op.discord_announcement_channel_id) {
            const editResult = await editOperationAnnouncementEmbed(
                targetChannel,
                op.discord_announcement_message_id,
                input,
            );
            if (editResult.ok) return { ok: true, messageId: op.discord_announcement_message_id, channelId: targetChannel, mode: 'edited' };
            // If the message vanished, fall through to a fresh post.
            if (!editResult.gone) return { ok: false, error: editResult.error || 'Edit failed.' };
        }

        // Channel changed → best-effort delete of the prior message before re-posting.
        if (channelChanged && op.discord_announcement_message_id && op.discord_announcement_channel_id) {
            await deleteDiscordChannelMessage(op.discord_announcement_channel_id, op.discord_announcement_message_id);
        }

        // NO PING on a repost, deliberately, and for the same reason
        // editOperationAnnouncementEmbed has none: the announcement is one event.
        // Pinging here would make this action a repeatable @-mention of the org's
        // configured role, which is a different thing from announcing an operation.
        const post = await postOperationAnnouncementEmbed(targetChannel, input);
        if (!post.messageId) return { ok: false, error: post.error || 'Post failed.' };

        await db.supabase.from('operations')
            .update({
                discord_announcement_channel_id: targetChannel,
                discord_announcement_message_id: post.messageId,
            })
            .eq('id', operationId);
        return { ok: true, messageId: post.messageId, channelId: targetChannel, mode: 'posted' };
    },
    'operation:update_status': ({ operationId, status, userId }: UpdateStatusPayload) => db.updateOperationStatus(operationId, status, userId),
    // These operations:view-gated sub-resource actions re-apply the per-op
    // clearance predicate (assertOpVisibleToUser) — without it a member could
    // join/write to ops the list/detail gates hide from them.
    'operation:join': async ({ operationId, userId, joinCode, user }: JoinPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        // isJoinAttempt: a first-time joiner isn't yet a participant, so the
        // special-op participation gate must be skipped here — the join PIN
        // (checked in joinOperation) is the invite. Clearance is still enforced.
        await db.assertOpVisibleToUser(operationId, user, { isJoinAttempt: true });
        return db.joinOperation(operationId, userId, joinCode);
    },
    'operation:leave': async ({ operationId, targetUserId, userId, user }: LeavePayload) => {
        const tid = targetUserId || userId;
        if (tid !== userId) {
            // Removing another participant requires operations:manage. The action
            // itself is gated only by operations:view (every member has that)
            // because the self-leave path is universal — but the targetUserId
            // form is admin-only and must be checked here, not on the client.
            // Permission only — no role-name bypass (see lib/radio.ts:generateOpRadioToken).
            const canManage = Array.isArray(user?.permissions) && user.permissions.includes('operations:manage');
            if (!canManage) {
                throw new Error('Forbidden: removing other participants requires operations:manage.');
            }
        } else {
            // The self-leave path writes a LEAVE log + broadcast on the op —
            // mirror the join/rsvp siblings and gate on the per-op visibility
            // predicate so a member with operations:view but insufficient
            // clearance/marker can't probe a hidden op via leave. (The
            // admin-leave branch above is already gated by operations:manage,
            // which is the read-side bypass — no extra visibility check needed.)
            await db.assertOpVisibleToUser(operationId, user);
        }
        const removed = await db.leaveOperation(operationId, tid);
        // Only a REAL removal, and only when someone removed somebody else. `removed` is
        // deliberately NOT returned to the caller: a boolean answer to "was targetUserId a
        // participant of this operation" is a small membership oracle, and rule 3 says
        // hydrate only what is displayed.
        if (removed && tid !== userId) {
            await db.notifyOperationRemoval(operationId, tid, userId);
        }
    },
    'operation:add_participant': ({ operationId, targetUserId, userId }: AddParticipantPayload) => db.addOperationParticipant(operationId, targetUserId, userId),
    'operation:add_uec': ({ operationId, amount, reason, userId }: AddUecPayload) => db.addOperationUec(operationId, amount, reason, userId),
    'operation:add_cost': ({ operationId, amount, category, description, userId }: AddCostPayload) => db.addOperationCost(operationId, amount, category, description, userId),
    'operation:set_payout_mode': ({ operationId, mode, userId }: SetPayoutModePayload) => db.setOperationPayoutMode(operationId, mode, userId),
    'operation:set_payout_splits': ({ operationId, splits, userId }: SetPayoutSplitsPayload) => db.setOperationPayoutSplits(operationId, splits, userId),
    'operation:toggle_payout_paid': ({ operationId, targetUserId, paid, userId }: TogglePayoutPaidPayload) => db.toggleParticipantPayoutPaid(operationId, targetUserId, paid, userId),
    'operation:timeline_add': async ({ operationId, entry, userId, user }: TimelineAddPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        await db.logOperationEntry(operationId, 'NOTE', entry, userId);
        await db.broadcastOpChange(operationId);
    },
    'operation:toggle_ready': async ({ operationId, userId, user }: ToggleReadyPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        return db.toggleParticipantReady(operationId, userId);
    },
    'operation:update_participant_live_status': async ({ operationId, userId, liveStatus, user }: UpdateParticipantLiveStatusPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        // Mirror the join/rsvp/toggle_ready siblings — gate on the FULL per-op
        // visibility predicate, not existence-only verifyOperationAccess.
        // Without it a member with operations:view but insufficient clearance/marker
        // could write a status + STATUS_CHANGE log onto a hidden op (existence
        // oracle + attributable log injection). The status text is HTML-stripped in
        // the db layer.
        await db.assertOpVisibleToUser(operationId, user);
        return db.updateParticipantLiveStatus(operationId, userId, liveStatus);
    },
    'operation:reset_readiness': ({ operationId }: ResetReadinessPayload) => db.resetOperationReadiness(operationId),
    'operation:join_with_role': async ({ operationId, userId, roleRequested, shipUtilized, joinCode, shipId, userShipId, user }: JoinWithRolePayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        // See operation:join — the join PIN gates special-op joins, so exempt this
        // path from the participation gate while keeping the clearance check.
        await db.assertOpVisibleToUser(operationId, user, { isJoinAttempt: true });
        return db.joinOperation(operationId, userId, joinCode, roleRequested, shipUtilized, shipId, userShipId);
    },
    'operation:update_participant': ({ operationId, targetUserId, updates }: UpdateParticipantPayload) => db.updateOperationParticipant(operationId, targetUserId, updates),
    'operation:rsvp': async ({ operationId, userId, rsvpStatus, shipId, userShipId, user }: RsvpPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        return db.rsvpOperation(operationId, userId, rsvpStatus, shipId, userShipId);
    },

    // Participant fleet lookup
    'operation:get_participant_ships': async ({ operationId, userIds, user }: GetParticipantShipsPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        // Existence-only verifyOperationAccess would let a member with
        // operations:view but insufficient clearance/missing marker read the
        // participant roster + ship loadouts of a hidden op. Use the per-op
        // visibility predicate (clearance level + every marker + owner/manage).
        await db.assertOpVisibleToUser(operationId, user);
        // Validate that the requested user IDs are actual participants
        const op = await db.getFullOperationDetails(operationId);
        if (!op) throw new Error('Operation not found');
        const participantIds = new Set((op.participants || []).map((p) => p.userId));
        const validIds = (userIds || []).filter((id) => participantIds.has(id));
        return db.getUserShipsByUserIds(validIds);
    },

    'operation:update_live_status': ({ operationId, liveStatus, userId }: UpdateLiveStatusPayload) => db.updateLiveStatus(operationId, liveStatus, userId),

    // Phases
    'operation:add_phase': async ({ operationId, data }: AddPhasePayload) => {
        await db.verifyOperationAccess(operationId);
        const r = await db.addOperationPhase(operationId, data);
        await db.broadcastOpChange(operationId);
        return r;
    },
    'operation:update_phase': async ({ phaseId, data, operationId, userId }: UpdatePhasePayload) => {
        await db.verifyOperationAccess(operationId);
        const cascade = await db.updateOperationPhase(phaseId, data, operationId);
        if (data?.status === 'Completed' && (cascade.cascadedTasks > 0 || cascade.cascadedMilestones > 0)) {
            const parts = [];
            if (cascade.cascadedTasks > 0) parts.push(`${cascade.cascadedTasks} task(s)`);
            if (cascade.cascadedMilestones > 0) parts.push(`${cascade.cascadedMilestones} milestone(s)`);
            await db.logOperationEntry(operationId, 'NOTE', `Phase completed — auto-marked ${parts.join(' and ')} as Completed.`, userId);
        }
        await db.broadcastOpChange(operationId);
        return cascade;
    },
    'operation:delete_phase': async ({ phaseId, operationId }: DeletePhasePayload) => {
        await db.verifyOperationAccess(operationId);
        await db.deleteOperationPhase(phaseId, operationId);
        await db.broadcastOpChange(operationId);
    },

    // Schedule
    'operation:add_schedule_entry': async ({ operationId, data }: AddScheduleEntryPayload) => {
        await db.verifyOperationAccess(operationId);
        const r = await db.addScheduleEntry(operationId, data);
        await db.broadcastOpChange(operationId);
        return r;
    },
    'operation:update_schedule_entry': async ({ entryId, data, operationId }: UpdateScheduleEntryPayload) => {
        await db.verifyOperationAccess(operationId);
        await db.updateScheduleEntry(entryId, data, operationId);
        await db.broadcastOpChange(operationId);
    },
    'operation:delete_schedule_entry': async ({ entryId, operationId }: DeleteScheduleEntryPayload) => {
        await db.verifyOperationAccess(operationId);
        await db.deleteScheduleEntry(entryId, operationId);
        await db.broadcastOpChange(operationId);
    },

    // Tasks
    'operation:add_task': async ({ operationId, data, userId }: AddTaskPayload) => {
        await db.verifyOperationAccess(operationId);
        const r = await db.addOperationTask(operationId, data);
        await db.notifyOperationAssignee(operationId, (r as { assigned_user_id?: number } | null)?.assigned_user_id, userId, 'task');
        await db.broadcastOpChange(operationId);
        return r;
    },
    'operation:update_task': async ({ taskId, data, operationId }: UpdateTaskPayload) => {
        await db.verifyOperationAccess(operationId);
        await db.updateOperationTask(taskId, data, operationId);
        await db.broadcastOpChange(operationId);
    },
    'operation:delete_task': async ({ taskId, operationId }: DeleteTaskPayload) => {
        await db.verifyOperationAccess(operationId);
        await db.deleteOperationTask(taskId, operationId);
        await db.broadcastOpChange(operationId);
    },

    // Command Nodes (C2)
    'operation:add_command_node': async ({ operationId, data, userId }: AddCommandNodePayload) => {
        await db.verifyOperationAccess(operationId);
        const r = await db.addCommandNode(operationId, data);
        await db.notifyOperationAssignee(operationId, (r as { assigned_user_id?: number } | null)?.assigned_user_id, userId, 'command');
        await db.broadcastOpChange(operationId);
        return r;
    },
    'operation:update_command_node': async ({ nodeId, data, operationId }: UpdateCommandNodePayload) => {
        await db.verifyOperationAccess(operationId);
        await db.updateCommandNode(nodeId, data, operationId);
        await db.broadcastOpChange(operationId);
    },
    'operation:delete_command_node': async ({ nodeId, operationId }: DeleteCommandNodePayload) => {
        await db.verifyOperationAccess(operationId);
        await db.deleteCommandNode(nodeId, operationId);
        await db.broadcastOpChange(operationId);
    },

    // Ship Slots + Seats (ORBAT multi-crew seats / event ship slots).
    //
    // TWO GATE TIERS, and the split is the point. Slot CRUD is organiser design
    // work (operations:manage) and follows the command-node shape above. The four
    // seat actions touch MEMBER IDENTITY, so they use assertOpVisibleToUser — the
    // clearance/marker/special-op gate — rather than verifyOperationAccess, which
    // in this build is existence-only. Hosted uses its own verifyOperationAccess
    // for all of them; here that would be a clearance bypass, letting a member who
    // cannot see a restricted operation learn (and change) who is crewing it.
    'operation:add_ship_slot': async ({ operationId, data }: AddShipSlotPayload) => {
        await db.verifyOperationAccess(operationId);
        const r = await db.addShipSlot(operationId, data);
        await db.broadcastOpChange(operationId);
        return r;
    },
    'operation:update_ship_slot': async ({ slotId, data, operationId }: UpdateShipSlotPayload) => {
        await db.verifyOperationAccess(operationId);
        await db.updateShipSlot(slotId, data, operationId);
        await db.broadcastOpChange(operationId);
    },
    'operation:delete_ship_slot': async ({ slotId, operationId }: DeleteShipSlotPayload) => {
        await db.verifyOperationAccess(operationId);
        await db.deleteShipSlot(slotId, operationId);
        await db.broadcastOpChange(operationId);
    },
    'operation:assign_slot': async ({ operationId, slotId, targetUserId, userId, userShipId, user }: AssignSlotPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        const target = Number(targetUserId);
        const r = await db.assignSlot(operationId, slotId, target, userId, userShipId != null ? Number(userShipId) : undefined);
        // Through the local helper, never a raw createNotification: it carries the
        // fail-closed participant precondition, the self-skip, and the generic body
        // that keeps operation content out of an unfiltered notification row.
        await db.notifyOperationAssignee(operationId, target, userId, 'seat');
        return r;
    },
    'operation:decide_slot_application': async ({ operationId, slotId, targetUserId, decision, userId, user }: DecideSlotApplicationPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        const target = Number(targetUserId);
        const dec: 'approve' | 'deny' = decision === 'approve' ? 'approve' : 'deny';
        await db.decideSlotApplication(operationId, slotId, target, dec, userId);
        if (dec === 'approve') await db.notifyOperationAssignee(operationId, target, userId, 'seat');
    },
    'operation:remove_slot_assignment': async ({ operationId, slotId, targetUserId, user }: RemoveSlotAssignmentPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        await db.removeSlotAssignment(operationId, slotId, Number(targetUserId));
    },
    'operation:apply_for_slot': async ({ operationId, slotId, userId, userShipId, user }: ApplyForSlotPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        return db.applyForSlot(operationId, slotId, userId, userShipId != null ? Number(userShipId) : undefined);
    },
    'operation:withdraw_slot': async ({ operationId, slotId, userId, user }: WithdrawSlotPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        // `userId` is DISPATCHER-FORCED (ACTOR_ID_FIELDS); `targetUserId` is not, and
        // is deliberately absent from this payload. Reading a target here would let
        // any member withdraw anyone else's seat through an operations:view action.
        await db.removeSlotAssignment(operationId, slotId, userId);
    },

    // Board Elements (Tactical Board)
    // Board edits broadcast a delta on the per-op channel `op-board-{operationId}`
    // (lib/db/ops.ts) instead of `operation_update` on the org-wide channel —
    // narrower fan-out + the client merges the delta directly without a
    // get_details refetch.
    'operation:add_board_element': async ({ operationId, data, clientNonce }: AddBoardElementPayload) => {
        await db.verifyOperationAccess(operationId);
        const row = await db.addBoardElement(operationId, data);
        if (!row) throw new Error('Failed to add board element');
        const element = toOperationBoardElement(row);
        await db.broadcastBoardAdd(operationId, element, clientNonce);
        return element;
    },
    'operation:update_board_element': async ({ elementId, data, operationId }: UpdateBoardElementPayload) => {
        await db.verifyOperationAccess(operationId);
        await db.updateBoardElement(elementId, data, operationId);
        await db.broadcastBoardUpdate(operationId, elementId, data);
    },
    'operation:delete_board_element': async ({ elementId, operationId }: DeleteBoardElementPayload) => {
        await db.verifyOperationAccess(operationId);
        await db.deleteBoardElement(elementId, operationId);
        await db.broadcastBoardDelete(operationId, elementId);
    },
    'operation:save_board': async ({ operationId, elements }: SaveBoardPayload) => {
        await db.verifyOperationAccess(operationId);
        await db.saveBoardLayout(operationId, elements);
        await db.broadcastOpChange(operationId);
    },

    // Logistics. Clearance-aware gate (read/write parity) so a member who can't
    // see a restricted op can't mutate its logistics by id either.
    'operation:add_logistics': async ({ operationId, data, user }: AddLogisticsPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        const r = await db.addLogisticsItem(operationId, data);
        await db.broadcastOpChange(operationId);
        return r;
    },
    'operation:update_logistics': async ({ itemId, data, operationId, user }: UpdateLogisticsPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        await db.updateLogisticsItem(itemId, data, operationId);
        await db.broadcastOpChange(operationId);
    },
    'operation:delete_logistics': async ({ itemId, operationId, user }: DeleteLogisticsPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        await db.deleteLogisticsItem(itemId, operationId);
        await db.broadcastOpChange(operationId);
    },
    'operation:fulfill_logistics': async ({ itemId, quantity, userId, operationId, user }: FulfillLogisticsPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        await db.fulfillLogisticsItem(itemId, quantity, userId, operationId);
        await db.broadcastOpChange(operationId);
    },

    // Operations Alert Broadcast. ORDER MATTERS: persist the ALERT log entry
    // FIRST — the realtime emit is a trigger-only ping and receivers fetch the
    // content (operation:get_latest_alert) the moment it arrives.
    'operation:broadcast_alert': async ({ operationId, message, userId }: BroadcastAlertPayload) => {
        await db.logOperationEntry(operationId, 'ALERT', `Operations Alert: ${message}`, userId);
        await db.broadcastOperationAlert(operationId, message);
        await db.broadcastOpChange(operationId);
    },

    // Gated alert-content fetch for the operation_alert trigger.
    'operation:get_latest_alert': async ({ operationId, user }: { operationId: string; user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        return db.getLatestOperationAlert(operationId);
    },

    // AAR
    'operation:add_aar_entry': async ({ operationId, data, userId, user }: AddAarEntryPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        const r = await db.addAAREntry(operationId, { ...data, userId });
        await db.broadcastOpChange(operationId);
        return r;
    },
    'operation:delete_aar_entry': async ({ entryId, operationId, user }: DeleteAarEntryPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        await db.assertOpVisibleToUser(operationId, user);
        await db.deleteAAREntry(entryId, operationId);
        await db.broadcastOpChange(operationId);
    },
    'operation:submit_aar': async ({ operationId, userId, summary, lessonsLearned }: SubmitAarPayload) => { await db.submitAAR(operationId, userId, summary, lessonsLearned); await db.broadcastOpChange(operationId); },
    'operation:reopen_aar': async ({ operationId, userId }: ReopenAarPayload) => {
        // Per-record check: org admin OR the operation's creator/owner.
        // No standalone permission string — gating is by role + ownership only.
        const [ownerId, systemRoles, user] = await Promise.all([
            db.getOperationOwnerId(operationId),
            db.getSystemRoles(),
            db.getUserById(userId),
        ]);
        const isAdmin = !!(systemRoles.admin && user?.roleId === systemRoles.admin.id);
        const isOwner = ownerId !== null && ownerId === userId;
        if (!isAdmin && !isOwner) {
            const err: Error & { code?: string } = new Error('Only the operation owner or an org admin can reopen an AAR.');
            err.code = 'AAR_REOPEN_FORBIDDEN';
            throw err;
        }
        await db.reopenAAR(operationId);
        await db.logOperationEntry(operationId, 'NOTE', 'AAR reopened for editing.', userId);
        await db.broadcastOpChange(operationId);
    },
    'operation:generate_aar_summary': async ({ operationId, userId }: GenerateAarSummaryPayload & { userId?: number }) => {
        assertAiRateLimit(userId); // per-user Gemini throttle
        const result = await db.generateAARDraftForOperation(operationId);
        await db.broadcastOpChange(operationId);
        return result;
    },

    // Operation Templates — structure-only (phases/milestones/tasks).
    // Realtime: changes broadcast on the db-changes channel under
    // 'operation_templates_changed' so DataContext can refresh the subset.
    'operation:template:list': async ({ user }: TemplateListPayload & { user?: Parameters<typeof db.listOperationTemplates>[0] }) => db.listOperationTemplates(user),
    'operation:template:get': async ({ id, user }: TemplateGetPayload & { user?: Parameters<typeof db.getOperationTemplate>[1] }) => db.getOperationTemplate(id, user),
    'operation:template:create': async ({ name, description, payload, userId, sourceOperationId, user }: TemplateCreatePayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        // When saving an extracted template, the clearance is read from the source
        // op server-side (after re-verifying the author may see it) — never taken
        // from the client — so the template inherits the op's restriction.
        let clearance: { classificationLevel: number; markerIds: number[] } | undefined;
        if (sourceOperationId) {
            await db.assertOpVisibleToUser(sourceOperationId, user);
            clearance = await db.getOperationClassification(sourceOperationId);
        }
        const tpl = await db.createOperationTemplate(userId, name, description ?? null, payload, clearance);
        await db.broadcastToOrg('operation_templates_changed', { id: tpl.id });
        return tpl;
    },
    'operation:template:update': async ({ id, name, description, payload, user }: TemplateUpdatePayload & { user?: Parameters<typeof db.updateOperationTemplate>[2] }) => {
        // Clearance twin of template:get. 'operations:create' is not a clearance
        // check, and this path re-selects the row — payload included — so without
        // the viewer a member below the template's classification could both
        // overwrite it and read back the source op's full plan.
        const tpl = await db.updateOperationTemplate(id, { name, description, payload }, user);
        await db.broadcastToOrg('operation_templates_changed', { id: tpl.id });
        return tpl;
    },
    'operation:template:delete': async ({ id, user }: TemplateDeletePayload & { user?: Parameters<typeof db.deleteOperationTemplate>[1] }) => {
        // Same clearance gate as update — destruction of a classified template
        // must not be reachable from 'operations:create' alone.
        await db.deleteOperationTemplate(id, user);
        await db.broadcastToOrg('operation_templates_changed', { id });
    },
    // Builds (but does not persist) a payload from an existing operation. The
    // client typically follows up with operation:template:create to save it.
    'operation:template:from_operation': async ({ operationId, user }: TemplateFromOperationPayload & { user?: Parameters<typeof db.assertOpVisibleToUser>[1] }) => {
        // Extracting a template pulls the op's full plan (phase/task/milestone
        // names + descriptions) — the same content get_details gates by
        // clearance. operations:create alone is not a clearance/marker check, so
        // a member lacking the op's clearance could otherwise exfiltrate its plan
        // via this path. Gate on the canonical per-op visibility predicate first.
        await db.assertOpVisibleToUser(operationId, user);
        return db.extractTemplatePayloadFromOperation(operationId);
    },
    // JSON import: client supplies a parsed payload (and optional name/description).
    // Validation lives in createOperationTemplate → validateTemplatePayload.
    'operation:template:import': async ({ name, description, payload, userId }: TemplateCreatePayload) => {
        const tpl = await db.createOperationTemplate(userId, name, description ?? null, payload);
        await db.broadcastToOrg('operation_templates_changed', { id: tpl.id });
        return tpl;
    },

    // Discord channel directory — read-only list of voice/text channels in the
    // org's guild, used by the Comms Plan editor's provider dropdown. Cached
    // server-side for 60s; pass `forceRefresh: true` to bypass.
    /**
     * The SAME read as 'discord:list_guild_channels', under a different permission.
     *
     * An alias rather than a re-gate, because fullPermissionMap holds exactly one
     * permission per action: re-gating the existing action on admin:config:discord
     * would take the channel picker away from every op creator who is not a Discord
     * admin. Two actions, two audiences, one implementation.
     *
     * No forceRefresh here — the admin tab loads the directory once per visit and has
     * no reason to hand a caller a cache bypass.
     */
    'discord:list_channels_admin': async () => listGuildChannels({}),
    'discord:list_guild_channels': async ({ forceRefresh }: ListGuildChannelsPayload) => {
        return listGuildChannels({ forceRefresh: !!forceRefresh });
    },
};
