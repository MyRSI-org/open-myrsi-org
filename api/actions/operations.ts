
import * as db from '../../lib/db.js';
import { toOperationBoardElement } from '../../lib/db/mappers.js';
import {
    createGuildScheduledEvent,
    deleteGuildScheduledEvent,
    updateGuildScheduledEvent,
    listGuildChannels,
    postOperationAnnouncementEmbed,
    editOperationAnnouncementEmbed,
    deleteDiscordChannelMessage,
    type OperationAnnouncementEmbedInput,
} from '../../lib/discord.js';
import { log as baseLog } from '../../lib/log.js';
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
interface SupabaseLikeError {
    code?: string;
    message?: string;
    hint?: string;
    details?: string;
}

// Row shape pulled by buildAnnouncementEmbedInput's `operations` select.
interface OperationEmbedRow {
    id: string;
    name: string;
    description: string | null;
    type: string;
    scheduled_start: string | null;
    scheduled_end: string | null;
    clearance_level: number | null;
    unit_id: number | null;
    location_id: number | null;
    location_text?: string | null;
}

// Branding settings blob the embed pulls name + iconUrl off.
interface BrandingConfig {
    name?: string;
    iconUrl?: string;
}

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

interface GetDetailsPayload { operationId: string; user?: { id?: number; role?: string; permissions?: string[]; clearanceLevel?: { level?: number } | null; limitingMarkers?: unknown[] } }
interface DeletePayload { operationId: string; userId: number }
interface UpdatePayload { operationId: string; updates: OperationUpdates; userId: number; user?: Parameters<typeof db.updateOperationDetails>[3] }
interface RepostAnnouncementPayload { operationId: string; channelId?: string }
interface UpdateStatusPayload { operationId: string; status: string; userId: number }
interface JoinPayload { operationId: string; userId: number; joinCode?: string }
// `user` is the server-injected actor (a full User); typed structurally here to
// the two fields this handler inspects so the `role === 'Admin'` literal compare
// stays valid (a string-enum field would reject the raw-string comparison).
interface LeavePayload { operationId: string; targetUserId?: number; userId: number; user?: { role?: string; permissions?: string[] } }
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
interface AddTaskPayload { operationId: string; data: SubResourceData }
interface UpdateTaskPayload { taskId: number; data: SubResourceData; operationId: string }
interface DeleteTaskPayload { taskId: number; operationId: string }
interface AddCommandNodePayload { operationId: string; data: SubResourceData }
interface UpdateCommandNodePayload { nodeId: number; data: SubResourceData; operationId: string }
interface DeleteCommandNodePayload { nodeId: number; operationId: string }
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

// Builds the embed payload for an operation announcement. Pulls branding +
// clearance label + unit name + location text from the DB so the Discord embed
// is self-contained (Discord viewers don't have to click through for context).
async function buildAnnouncementEmbedInput(operationId: string): Promise<OperationAnnouncementEmbedInput | null> {
    // Base columns are guaranteed to exist on every deployed schema. `location_text`
    // is from migrations/add-operations-location-text.sql; embedded joins on
    // `units` and `locations` rely on PostgREST's FK inference and its schema
    // cache. Pull each optional bit separately so a missing column / stale cache
    // / FK ambiguity degrades the embed instead of blanking it.
    const baseSelect = 'id, name, description, type, scheduled_start, scheduled_end, clearance_level, unit_id, location_id';
    const initial = await db.supabase
        .from('operations')
        .select(`${baseSelect}, location_text`)
        .eq('id', operationId)
        
        .single();
    let op = initial.data as OperationEmbedRow | null;
    let opErr = initial.error as SupabaseLikeError | null;

    // Fallback: location_text column not yet present (migration not applied or
    // PostgREST cache stale). Same error codes the createOperation fallback uses.
    const code = opErr?.code;
    if (opErr && (code === '42703' || code === 'PGRST204')) {
        log.warn('operations.location_text unavailable — retrying without', { code, hint: 'run migrations/add-operations-location-text.sql' });
        const retry = await db.supabase
            .from('operations')
            .select(baseSelect)
            .eq('id', operationId)
            
            .single();
        op = retry.data as OperationEmbedRow | null;
        opErr = retry.error as SupabaseLikeError | null;
    }

    if (opErr || !op) {
        if (opErr) log.error('operation lookup failed', { operationId, code: opErr.code, message: opErr.message, hint: opErr.hint || '', details: opErr.details || '' });
        return null;
    }

    // Empty-branch placeholder when the op has no unit/location FK to resolve.
    // Typed to the subset of the single-row response these reads use
    // ({ data: { name } | null }) so the ternary unifies with the query builder
    // (also PromiseLike) without `any`.
    const emptyNamedRow: Promise<{ data: { name: string } | null; error: null }> =
        Promise.resolve({ data: null, error: null });
    const [unitRes, locationRes, settingsRes] = await Promise.all([
        op.unit_id
            ? db.supabase.from('units').select('name').eq('id', op.unit_id).maybeSingle()
            : emptyNamedRow,
        op.location_id
            ? db.supabase.from('locations').select('name').eq('id', op.location_id).maybeSingle()
            : emptyNamedRow,
        db.supabase.from('settings')
            .select('key, value')
            
            .in('key', ['brandingConfig']),
    ]);
    const settingsRows = (settingsRes.data || []) as Array<{ key: string; value: unknown }>;
    const branding = (settingsRows.find((r) => r.key === 'brandingConfig')?.value as BrandingConfig | undefined) || {};

    let clearanceLabel: string | null = null;
    if (typeof op.clearance_level === 'number' && op.clearance_level > 0) {
        const { data: clearance } = await db.supabase
            .from('security_clearances')
            .select('name, level')
            
            .eq('level', op.clearance_level)
            .maybeSingle();
        clearanceLabel = clearance?.name ? `L${clearance.level} — ${clearance.name}` : `Level ${op.clearance_level}`;
    }

    const unitName = unitRes.data?.name || null;
    const locationLabel = (op.location_text && String(op.location_text).trim())
        || locationRes.data?.name
        || null;

    const tenantUrl = await db.getOrgTenantUrl();
    const operationDeepLink = tenantUrl ? `${tenantUrl.replace(/\/$/, '')}/operations/${operationId}` : null;

    return {
        name: op.name,
        description: op.description,
        type: op.type,
        scheduledStart: op.scheduled_start,
        scheduledEnd: op.scheduled_end,
        clearanceLabel,
        unitName,
        locationLabel,
        operationDeepLink,
        branding: { name: branding?.name, iconUrl: branding?.iconUrl },
    };
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
            const discordResult = await createGuildScheduledEvent({
                name: opData.name,
                description: opData.description,
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
                    const post = await postOperationAnnouncementEmbed(
                        String(opData.discordAnnouncementChannelId).trim(),
                        input,
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
        const touched = ['name', 'description', 'scheduledStart', 'scheduledEnd', 'type', 'clearanceLevel', 'unitId', 'locationId', 'locationText'].some(k => updates?.[k] !== undefined);
        if (touched) {
            const { data: op } = await db.supabase.from('operations')
                .select('discord_event_id, discord_announcement_channel_id, discord_announcement_message_id, name, description, scheduled_start, scheduled_end')
                .eq('id', operationId)
                .single();
            if (op?.discord_event_id) {
                const discordResult = await updateGuildScheduledEvent(
                    op.discord_event_id,
                    {
                        // Send the current DB state for the touched fields — picks up
                        // whatever we just wrote, so we never drift from the source of truth.
                        ...(updates.name !== undefined ? { name: op.name } : {}),
                        ...(updates.description !== undefined ? { description: op.description } : {}),
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

        const targetChannel = (channelId && String(channelId).trim()) || op.discord_announcement_channel_id;
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
            const canManage = user?.role === 'Admin' || (Array.isArray(user?.permissions) && user.permissions.includes('operations:manage'));
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
        return db.leaveOperation(operationId, tid);
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
    'operation:add_task': async ({ operationId, data }: AddTaskPayload) => {
        await db.verifyOperationAccess(operationId);
        const r = await db.addOperationTask(operationId, data);
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
    'operation:add_command_node': async ({ operationId, data }: AddCommandNodePayload) => {
        await db.verifyOperationAccess(operationId);
        const r = await db.addCommandNode(operationId, data);
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
    'operation:template:update': async ({ id, name, description, payload }: TemplateUpdatePayload) => {
        const tpl = await db.updateOperationTemplate(id, { name, description, payload });
        await db.broadcastToOrg('operation_templates_changed', { id: tpl.id });
        return tpl;
    },
    'operation:template:delete': async ({ id }: TemplateDeletePayload) => {
        await db.deleteOperationTemplate(id);
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
    'discord:list_guild_channels': async ({ forceRefresh }: ListGuildChannelsPayload) => {
        return listGuildChannels({ forceRefresh: !!forceRefresh });
    },
};
