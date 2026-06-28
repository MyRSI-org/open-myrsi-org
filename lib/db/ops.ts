

import { HydratedOperation, User, UserRole, OperationTemplatePayload } from '../../types.js';
import { supabase, handleSupabaseError, safeFetch, broadcastToOrg, broadcastToChannel } from './common.js';
import { passesClearance, canViewAllClassifications, assertCanClassify, type ClearanceUser } from '../clearance.js';
import { sendPushToUsers } from '../push.js';
import { toHydratedOperation, minifyUser } from './mappers.js';
import { getUserById } from './users.js';
import { bumpOperationVersion, pushOperationToAllies, scheduleAlliedPush } from './operations-federation.js';
import { stripHtml, stripHtmlSingleLine } from '../textSanitize.js';
import { cache, TTL } from '../cache.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'db.ops' });

const opAccessKey = (operationId: string) =>
    `verifyOpAccess:${operationId}`;

function broadcastOperationUpdate(operationId: string) {
    broadcastToOrg('operation_update', { operationId });
    // Bump the joint-op version so allied mirrors pick up the change on their
    // next poll. No-ops for non-joint ops (self-gated on is_joint).
    void bumpOperationVersion(operationId).catch(() => undefined);
    // Debounced full-snapshot push to accepted allies — N rapid edits coalesce
    // into ONE push. No-op for ops without allies.
    scheduleAlliedPush(operationId);
}

/** Broadcast an operation alert with push notifications. The caller (the
 *  operation:broadcast_alert handler) persists the alert as an ALERT log
 *  entry BEFORE invoking this, so receivers can fetch the content. */
export async function broadcastOperationAlert(operationId: string, message: string) {
    const timestamp = new Date().toISOString();

    // The realtime emit is a TRIGGER ONLY ({operationId, timestamp}). Receivers
    // pull the alert body via the clearance-gated operation:get_latest_alert RPC.
    // Push (encrypted, participant-targeted) still carries the body for
    // notification UX.
    const broadcastPromise = broadcastToChannel('auth-alerts', 'operation_alert', { operationId, timestamp });

    // Get all participant user IDs for push notifications
    const { data: participants } = await supabase
        .from('operation_participants')
        .select('user_id')
        .eq('operation_id', operationId)
        .is('time_left', null);

    const participantIds = (participants || []).map(p => p.user_id);

    // Send push notification to all participants
    const pushPromise = participantIds.length > 0
        ? sendPushToUsers(participantIds, {
            title: 'Operations Alert',
            body: message,
            tag: 'high-priority',
            data: { type: 'operation_alert', operationId, url: `/operations` },
            requireInteraction: true,
            renotify: true,
        })
        : Promise.resolve();

    await Promise.all([broadcastPromise, pushPromise]);
    // Critical event → push the alert-bearing snapshot to accepted allies.
    void pushOperationToAllies(operationId, 'alert').catch(() => undefined);
}

/**
 * Gated fetch backing the operation_alert trigger: the newest ALERT log
 * entry for the op ({message, senderName, timestamp} | null). Callers
 * (operation:get_latest_alert) gate at operations:view + assertOpVisibleToUser
 * so a member can never read alert text for an op above their clearance.
 */
export async function getLatestOperationAlert(operationId: string): Promise<{ message: string; senderName: string; timestamp: string } | null> {
    // Column names: operation_log_entries stores the text in `log_entry` and
    // the kind in `entry_type` (see logOperationEntry + toHydratedOperation's
    // log mapping).
    const { data, error } = await supabase.from('operation_log_entries')
        .select('log_entry, created_at, author:users!operation_log_entries_author_id_fkey(name)')
        .eq('operation_id', operationId)
        .eq('entry_type', 'ALERT')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to get operation alert' });
    if (!data) return null;
    const content = String(data.log_entry || '');
    return {
        // The broadcast_alert handler logs as "Operations Alert: <msg>".
        message: content.replace(/^Operations Alert:\s*/, ''),
        senderName: (data.author as { name?: string } | null)?.name || 'Command',
        timestamp: data.created_at,
    };
}

async function verifyOperationAccessUncached(operationId: string): Promise<{ isJoint: boolean; hostOrgId: string }> {
    const { data: op } = await supabase
        .from('operations')
        .select('is_joint')
        .eq('id', operationId)
        .single();

    if (!op) throw new Error("Operation not found or access denied.");

    return { isJoint: op.is_joint, hostOrgId: '' };
}

/**
 * Verify that the operation exists (and is reachable).
 *
 * Hot path: every board element add/update/delete calls this once. The result is
 * cached for TTL.OP_ACCESS to collapse 30–80 verifies/sec during an active
 * tactical session down to one per operationId per TTL window.
 *
 * Negatives are NOT cached — a throw bubbles through. Stale entries are cleared
 * by active invalidation in `deleteOperation`.
 */
export async function verifyOperationAccess(operationId: string): Promise<{ isJoint: boolean; hostOrgId: string }> {
    const key = opAccessKey(operationId);
    const hit = cache.get<{ isJoint: boolean; hostOrgId: string }>(key);
    if (hit) return hit;

    const result = await verifyOperationAccessUncached(operationId);
    cache.set(key, result, TTL.OP_ACCESS);
    return result;
}

/** Broadcast that an operation changed. */
export async function broadcastOpChange(operationId: string) {
    broadcastOperationUpdate(operationId);
}

// `location:locations(*)` MUST disambiguate the FK: after add-operation-locations.sql
// introduced the operation_locations junction, PostgREST sees two paths from
// operations to locations (operations.location_id direct vs the junction) and
// throws PGRST201 "Ambiguous Join" — silently empties the entire ops list.
// The bang-prefixed FK constraint name forces the direct relationship.
const OPS_SELECT = `
    id, name, owner_id, status, type, description, tracks_uec, total_uec, total_costs, payout_mode, created_at, updated_at, active_start_time, active_end_time, scheduled_start, scheduled_end, is_special, join_code, clearance_level, is_training, max_participants, unit_id, discord_event_id, discord_announcement_channel_id, discord_announcement_message_id, template_id, additional_location_texts, is_joint, joint_version, roe, commander_notes, comms_plan, live_status, aar_summary, aar_lessons_learned, aar_submitted_at, aar_submitted_by, aar_ai_generated_at, location_text, location_id,
    owner:users!operations_owner_id_fkey(id, name, avatar_url),
    participants:operation_participants(user_id, joined_at, is_ready, role_requested, ship_utilized, attendance_status, rsvp_status, rsvp_at, ship_id, user_ship_id, live_status, payout_share_percent, payout_paid_at, payout_paid_by, user:users!operation_participants_user_id_fkey(id, name, avatar_url, role_id, rank:ranks(name, icon_url)), ship:platform_ships!operation_participants_ship_id_fkey(id, name, image_url)),
    log:operation_log_entries(id, operation_id, entry_type, log_entry, author_id, created_at, uec_amount, cost_category, cost_description, author:users!operation_log_entries_author_id_fkey(id, name, avatar_url)),
    limiting_markers:operation_limiting_markers(marker:security_limiting_markers(id, name, code)),
    unit:units(id, name, parent_unit_id, sort_order, leader_id, logo_url, banner_url, motto, description, has_radio_channel, linked_channel_id, is_restricted),
    location:locations!operations_location_id_fkey(id, name, type, parent_id)
`;

/**
 * Visibility predicate for the operations LIST — shared by getOperations and
 * the single-row slice fetch (getOperationByIdLite) so the two paths can never
 * drift. Owners always see their own ops (an admin who created a high-clearance
 * op without holding the matching clearance still sees it); everyone else goes
 * through passesClearance, which enforces the clearance LEVEL, every limiting
 * MARKER on the op, and the operations:manage bypass — the same gate
 * operation:get_details applies. Checking only the level would let a member with
 * sufficient clearance but missing a compartment marker see list rows they're
 * denied from opening; the shared predicate closes that asymmetry.
 *
 * There is deliberately NO participant bypass — a participant added to a
 * compartmented op without holding its marker no longer sees it in their personal
 * lists (they could never open it via get_details anyway). If a participant
 * bypass is ever wanted, add it HERE and to the get_details gate together — never
 * let the two drift.
 *
 * Accepts any op-shaped projection carrying the three gate fields so sibling read
 * paths (e.g. the intel dossier ops list) reuse THIS predicate instead of
 * re-implementing it and drifting.
 */
// Structural viewer type so non-ops modules (intel dossier, radio) can authorize
// against the canonical predicates without importing the full hydrated User.
// `id` is optional: a missing/string id simply never matches a numeric owner_id
// (fail closed — clearance still applies).
export type OpViewer = { id?: number | string } & ClearanceUser;

export function canUserSeeOpInList(
    user: OpViewer,
    op: Pick<HydratedOperation, 'clearanceLevel'> & {
        ownerId?: number | null;
        limitingMarkers?: unknown[];
        // Special-operation participation gate. Optional so sibling
        // callers that don't carry these fields (e.g. the intel dossier ops list)
        // keep their clearance-only behavior — the gate only engages when
        // `isSpecial` is explicitly present on the projection.
        isSpecial?: boolean | null;
        participants?: Array<{ userId?: number | null; timeLeft?: string | null }>;
    },
): boolean {
    const isOwner = op.ownerId != null && op.ownerId === user.id;
    // Clearance LEVEL + every limiting MARKER, with the operations:manage / Admin
    // read-side bypass. Owners always pass.
    if (!isOwner && !passesClearance(user, op.clearanceLevel, op.limitingMarkers, ['operations:manage'])) {
        return false;
    }
    // Special operations are invite-only: visible ONLY to the owner,
    // operations:manage holders (read-side bypass population), and ACTIVE
    // participants — mirrors the client `hasAccess` gate (OperationDetailView),
    // operation:get_details, and assertOpVisibleToUser so list/slice/detail/action
    // cannot drift. A clearance-0 special op must NOT be readable by every member.
    if (op.isSpecial && !isOwner && !canViewAllClassifications(user, ['operations:manage'])) {
        const isActiveParticipant = (op.participants || []).some(
            (p) => p.userId != null && p.userId === user.id && p.timeLeft == null,
        );
        if (!isActiveParticipant) return false;
    }
    return true;
}

/**
 * The join PIN (`join_code`) gates joining a Special Operation; only the
 * commander (owner) and operations:manage holders distribute it. Strip it from
 * every other viewer's copy so the PIN never rides the operations list / slice /
 * detail down to ordinary members. Mutates the freshly-mapped op in
 * place (toHydratedOperation always returns new objects).
 */
function redactJoinCodeForViewer(op: HydratedOperation, user: OpViewer): void {
    if (op.ownerId != null && op.ownerId === user.id) return;
    if (canViewAllClassifications(user, ['operations:manage'])) return;
    op.joinCode = undefined;
}

export async function getOperations(user?: User | null): Promise<HydratedOperation[]> {
    if (!user) {
        log.warn('getOperations returning empty — user is null/undefined');
        return [];
    }

    const query = supabase.from('operations').select(OPS_SELECT)

        .order('created_at', { ascending: false }).limit(100);
    // PostgREST infers to-one embeds (owner/unit/location) as arrays under explicit
    // column lists; cast through unknown to the relationship-aware row shape the
    // mapper consumes (the mapper still controls what reaches the wire).
    const data = await safeFetch<Parameters<typeof toHydratedOperation>[0][]>(
        query as unknown as PromiseLike<{ data: Parameters<typeof toHydratedOperation>[0][] | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>,
        [], 'Failed to get operations');
    log.info('getOperations fetched initial rows', { userId: user.id, initialRows: (data || []).length });

    let ops = (data || []).map(toHydratedOperation);

    // Clearance-level filter. Owners and operations managers bypass the cap so an
    // admin who created a high-clearance op without holding the matching clearance
    // still sees it on the list. Without this bypass, an admin without an assigned
    // clearance level (clearance is a separate concept from role) is effectively
    // level 0, which would strip ALL ops with clearance > 0 even ones they own.
    const before = ops.length;
    ops = ops.filter(op => canUserSeeOpInList(user, op));
    if (before > 0 && ops.length === 0) {
        log.warn('getOperations all ops filtered out by clearance — likely a clearance config issue', { filteredCount: before, userId: user.id, clearanceLevel: user.clearanceLevel?.level || 0, canManage: (user.permissions || []).includes('operations:manage') });
    }

    // Redact the join PIN for everyone but the owner / operations:manage holders
    // — the PIN is the only barrier to joining a clearance-0 special
    // op, so it must never ship to ordinary members on the operations subset.
    for (const op of ops) redactJoinCodeForViewer(op, user);

    // Sort by created_at descending (since we merged two arrays)
    ops.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    log.info('getOperations returning ops', { count: ops.length, userId: user.id });
    return ops;
}

/**
 * Single-op fetch in the LIST row shape (OPS_SELECT → toHydratedOperation —
 * sub-resource arrays stay empty; those belong to operation:get_details).
 * Backs the realtime `operation_slice` query subset: an operation_update
 * broadcast carries the operationId, and the client refetches ONLY this row
 * instead of the whole ops list.
 *
 * Returns null when the row is absent OR the caller fails the shared
 * visibility predicate — the client merge removes the row from its list in
 * both cases (deleted op / clearance or marker raised above the viewer).
 *
 * THROWS on query errors (deliberately NOT safeFetch's silent-[] fallback):
 * the client treats null as "remove this row from every viewer's list", so a
 * transient DB error must surface as a 500 — the client then falls back to a
 * full operations refetch instead of wrongly evicting a live op.
 */
/**
 * Clearance gate for op sub-resource actions that are permission-gated only at
 * operations:view (join / rsvp / toggle-ready / timeline / AAR / logistics).
 * verifyOperationAccess checks existence only, so without this a member could act
 * on operations the list/detail gates hide from them (clearance bypass). Owner
 * and operations:manage bypass — the identical predicate the list
 * (canUserSeeOpInList) and detail (operation:get_details) reads apply. Light
 * select: no participant/log embeds.
 */
export async function assertOpVisibleToUser(
    operationId: string,
    user?: OpViewer | null,
    // The join path passes { isJoinAttempt: true }: a first-time joiner is by
    // definition not yet a participant, and the join PIN (verified in
    // joinOperation) is the invite mechanism — so the special-op participation
    // gate below must NOT block joining. The clearance gate still applies.
    opts?: { isJoinAttempt?: boolean },
): Promise<void> {
    if (!user) throw new Error('Authentication required.');
    const { data, error } = await supabase.from('operations')
        .select('id, owner_id, is_special, clearance_level, limiting_markers:operation_limiting_markers(marker:security_limiting_markers(id, name, code))')
        .eq('id', operationId)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to verify operation access' });
    if (!data) throw new Error('Operation not found.');
    const markers = (data.limiting_markers || []).map((m: { marker?: unknown }) => m.marker).filter(Boolean);
    const isOwner = data.owner_id === user.id;
    const canManage = canViewAllClassifications(user, ['operations:manage']);
    const visible = isOwner
        || passesClearance(user, data.clearance_level || 0, markers, ['operations:manage']);
    if (!visible) throw new Error('Insufficient clearance to act on this operation.');

    // Special-operation participation gate: outside the join path a
    // non-owner / non-manager may act on an op's sub-resources only if they are an
    // ACTIVE participant — mirrors canUserSeeOpInList (list/slice) and the
    // operation:get_details deny so the gates can't drift. Lazy lookup: only the
    // special-op, non-privileged case incurs the extra query.
    if (!opts?.isJoinAttempt && data.is_special && !isOwner && !canManage) {
        const { data: membership } = await supabase.from('operation_participants')
            .select('user_id')
            .eq('operation_id', operationId)
            .eq('user_id', user.id)
            .is('time_left', null)
            .maybeSingle();
        if (!membership) throw new Error('Insufficient access to act on this special operation.');
    }
}

// The op's classification, read server-side. Used to stamp an extracted template
// with its source op's clearance so the laundered plan can't be read below it.
export async function getOperationClassification(operationId: string): Promise<{ classificationLevel: number; markerIds: number[] }> {
    const { data } = await supabase.from('operations')
        .select('clearance_level, limiting_markers:operation_limiting_markers(marker:security_limiting_markers(id))')
        .eq('id', operationId)
        .maybeSingle();
    const markerIds = ((data?.limiting_markers || []) as Array<{ marker?: { id?: number } | null }>)
        .map(m => m.marker?.id)
        .filter((n): n is number => typeof n === 'number');
    return { classificationLevel: data?.clearance_level ?? 0, markerIds };
}

export async function getOperationByIdLite(operationId: string, user?: User | null): Promise<HydratedOperation | null> {
    if (!user) return null;
    const { data, error } = await supabase.from('operations')
        .select(OPS_SELECT)
        .eq('id', operationId)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to get operation slice' });
    if (!data) return null;
    const op = toHydratedOperation(data as unknown as Parameters<typeof toHydratedOperation>[0]);
    if (!canUserSeeOpInList(user, op)) return null;
    // Strip the join PIN unless the viewer is the owner / an operations:manage
    // holder — keep the slice path consistent with getOperations.
    redactJoinCodeForViewer(op, user);
    return op;
}

interface CreateOperationInput {
    ownerId?: number;
    userId?: number;
    name?: string;
    type?: string;
    description?: string;
    tracksUec?: boolean;
    isSpecial?: boolean;
    joinCode?: string;
    clearanceLevel?: number;
    isScheduled?: boolean;
    unitId?: number | null;
    isTraining?: boolean;
    maxParticipants?: number | null;
    locationId?: number | null;
    locationText?: string;
    additionalLocationTexts?: unknown;
    additionalLocationIds?: unknown;
    scheduledStart?: string | null;
    scheduledEnd?: string | null;
    isJoint?: boolean;
    roe?: string | null;
    commanderNotes?: string | null;
    templateId?: number | null;
    postDiscordAnnouncement?: boolean;
    discordAnnouncementChannelId?: string;
    markerIds?: number[];
    inlinePhases?: OperationTemplatePayload;
    [key: string]: unknown;
}

export async function createOperation(opData: CreateOperationInput) {
    // Owner is the dispatcher-forced authenticated actor (opData.userId), which
    // MUST win over any client-supplied ownerId — otherwise a caller could set
    // ownerId to a victim and own/command the op as them. ownerId is only the
    // fallback for internal callers that don't inject userId.
    const ownerId = opData.userId || opData.ownerId;

    if (!ownerId) {
        throw new Error("Cannot create operation: Missing Owner ID");
    }

    // operations:create is NOT a clearance bypass. The creator may not set a
    // clearance level above their own, nor attach a compartment marker they don't
    // hold; operations:manage holders (read-side bypass) and Admins classify
    // freely.
    assertCanClassify(opData.user as ClearanceUser | undefined, opData.clearanceLevel ?? 0, opData.markerIds, ['operations:manage']);

    const dbPayload: Record<string, unknown> = {
        name: opData.name,
        type: opData.type,
        // Strip HTML from free-text fields. Description renders as text today (no
        // dangerouslySetInnerHTML) but stripping at the boundary prevents future
        // surfaces from rendering injected markup as HTML.
        description: stripHtml(opData.description, 4000),
        tracks_uec: opData.tracksUec,
        owner_id: ownerId,
        is_special: opData.isSpecial,
        join_code: opData.joinCode,
        clearance_level: opData.clearanceLevel || 0,
        status: opData.isScheduled ? 'Scheduled' : 'Planning',
        unit_id: opData.unitId || null,
        is_training: opData.isTraining || false,
        max_participants: opData.maxParticipants || null,
        location_id: opData.locationId || null,
        // Free-text platform-locations strings (LocationInput component) — preferred
        // over the legacy location_id FK for new ops. Both are written when a
        // legacy locationId is also supplied so list-view callers that joined
        // the locations table keep their data.
        location_text: typeof opData.locationText === 'string' && opData.locationText.trim()
            ? opData.locationText.trim()
            : null,
        additional_location_texts: Array.isArray(opData.additionalLocationTexts)
            ? opData.additionalLocationTexts.filter((s: unknown): s is string => typeof s === 'string' && s.trim() !== '').map((s: string) => s.trim())
            : [],
        scheduled_start: opData.scheduledStart || null,
        scheduled_end: opData.scheduledEnd || null,
        is_joint: opData.isJoint || false,
        roe: opData.roe || null,
        commander_notes: opData.commanderNotes || null,
        // Records which saved template (if any) seeded this op's plan. NULL when
        // the wizard's inline-phases path was used or no template was applied.
        template_id: opData.templateId || null,
        // Discord channel announcement (separate from the Guild Scheduled Event
        // path on `discord_event_id`). The channel ID is captured up-front so
        // we can post the embed once the row exists; the message ID is
        // back-filled by api/actions/operations.ts after the post succeeds.
        discord_announcement_channel_id: opData.postDiscordAnnouncement && opData.discordAnnouncementChannelId
            ? String(opData.discordAnnouncementChannelId).trim()
            : null,
    };

    let { data: op, error } = await supabase.from('operations').insert(dbPayload).select('id, name, owner_id, status, type, description, tracks_uec, total_uec, total_costs, payout_mode, created_at, updated_at, active_start_time, active_end_time, is_special, join_code, clearance_level, is_training, max_participants, unit_id, is_joint, roe, commander_notes, comms_plan, live_status').single();

    // Fallback for outdated DB schemas missing 'Training'/'Social' enum values
    // Error code 22P02 is "invalid text representation" usually for enums
    if (error && error.code === '22P02' && (dbPayload.type === 'Training' || dbPayload.type === 'Social')) {
        log.warn('db migration: operation type not supported by db enum, falling back to non-combat', { operationType: dbPayload.type });
        dbPayload.type = 'Non-Combat';
        // We ensure is_training is true if it wasn't already, so the UI can still show it somewhat correctly
        if (opData.type === 'Training') dbPayload.is_training = true;

        const retry = await supabase.from('operations').insert(dbPayload).select('id, name, owner_id, status, type, description, tracks_uec, total_uec, total_costs, payout_mode, created_at, updated_at, active_start_time, active_end_time, is_special, join_code, clearance_level, is_training, max_participants, unit_id, is_joint, roe, commander_notes, comms_plan, live_status').single();
        op = retry.data;
        error = retry.error;
    }

    // Fallback for DBs that haven't run migrations/add-operations-template-source.sql,
    // OR where the migration ran but PostgREST's schema cache hasn't reloaded.
    // 42703 = Postgres "undefined column" (column truly missing).
    // PGRST204 = PostgREST "Could not find the 'X' column of 'Y' in the schema cache"
    //            (column exists, but PostgREST doesn't know about it yet).
    // Either way, strip template_id and retry so op creation still succeeds; the
    // template-of-origin link is just not recorded for this op.
    const errCode = (error as { code?: string } | null)?.code;
    if (error && (errCode === '42703' || errCode === 'PGRST204') && dbPayload.template_id !== undefined) {
        log.warn("db migration: operations.template_id unavailable — retrying op create without template link. if migration was applied, reload postgrest's schema cache (notify pgrst, 'reload schema')", { errCode });
        delete dbPayload.template_id;
        const retry = await supabase.from('operations').insert(dbPayload).select('id, name, owner_id, status, type, description, tracks_uec, total_uec, total_costs, payout_mode, created_at, updated_at, active_start_time, active_end_time, is_special, join_code, clearance_level, is_training, max_participants, unit_id, is_joint, roe, commander_notes, comms_plan, live_status').single();
        op = retry.data;
        error = retry.error;
    }

    // Fallback for DBs that haven't run migrations/add-operations-location-text.sql.
    // Same shape as the template_id retry above.
    const errCode2 = (error as { code?: string } | null)?.code;
    if (error && (errCode2 === '42703' || errCode2 === 'PGRST204')
        && (dbPayload.location_text !== undefined || dbPayload.additional_location_texts !== undefined)) {
        log.warn('db migration: operations.location_text / additional_location_texts unavailable — retrying op create without them. run migrations/add-operations-location-text.sql', { errCode: errCode2 });
        delete dbPayload.location_text;
        delete dbPayload.additional_location_texts;
        const retry = await supabase.from('operations').insert(dbPayload).select('id, name, owner_id, status, type, description, tracks_uec, total_uec, total_costs, payout_mode, created_at, updated_at, active_start_time, active_end_time, is_special, join_code, clearance_level, is_training, max_participants, unit_id, is_joint, roe, commander_notes, comms_plan, live_status').single();
        op = retry.data;
        error = retry.error;
    }

    // Fallback for DBs that haven't run migrations/add-operation-discord-announcement.sql.
    const errCode3 = (error as { code?: string } | null)?.code;
    if (error && (errCode3 === '42703' || errCode3 === 'PGRST204') && dbPayload.discord_announcement_channel_id !== undefined) {
        log.warn('db migration: operations.discord_announcement_channel_id unavailable — retrying without. run migrations/add-operation-discord-announcement.sql', { errCode: errCode3 });
        delete dbPayload.discord_announcement_channel_id;
        const retry = await supabase.from('operations').insert(dbPayload).select('id, name, owner_id, status, type, description, tracks_uec, total_uec, total_costs, payout_mode, created_at, updated_at, active_start_time, active_end_time, is_special, join_code, clearance_level, is_training, max_participants, unit_id, is_joint, roe, commander_notes, comms_plan, live_status').single();
        op = retry.data;
        error = retry.error;
    }

    handleSupabaseError({ error, message: 'Failed to create operation' });

    if (!op) throw new Error('Failed to create operation: no row returned.');

    // Joint-op security gate: an operation that carries any sync-restricted
    // limiting marker must NOT be sharable as a Joint Operation. We enforce
    // this server-side in addition to the wizard's client-side check so that
    // direct API callers can't bypass it. Reject AFTER the row is created so
    // the response gives a precise error; the partial row is rolled back via
    // explicit delete since we don't run inside a transaction.
    if (op && opData.isJoint && Array.isArray(opData.markerIds) && opData.markerIds.length > 0) {
        const { data: restrictedMarkers, error: markerCheckErr } = await supabase
            .from('security_limiting_markers')
            .select('id, code')
            .in('id', opData.markerIds)
            .eq('sync_restricted', true);
        handleSupabaseError({ error: markerCheckErr, message: 'Failed to check limiting markers for joint sharing' });
        if (restrictedMarkers && restrictedMarkers.length > 0) {
            await supabase.from('operations').delete().eq('id', op.id);
            const codes = restrictedMarkers.map((m: { code: string }) => m.code).join(', ');
            const err = new Error(`Cannot share an operation as a Joint Operation when sync-restricted markers are attached: ${codes}.`) as Error & { code?: string };
            err.code = 'SYNC_RESTRICTED_MARKER_BLOCKS_JOINT';
            throw err;
        }
    }

    if (op && opData.markerIds && opData.markerIds.length > 0) {
        // Verify the supplied marker IDs all exist before attaching them so a
        // caller can't attach arbitrary marker definitions to their operation.
        const { data: validMarkers } = await supabase.from('security_limiting_markers')
            .select('id')
            .in('id', opData.markerIds)
            ;
        if (!validMarkers || validMarkers.length !== opData.markerIds.length) {
            await supabase.from('operations').delete().eq('id', op.id);
            throw new Error('One or more limiting markers are not valid for this organization.');
        }
        const markers = opData.markerIds.map((mid: number) => ({ operation_id: op.id, marker_id: mid }));
        await supabase.from('operation_limiting_markers').insert(markers);
    }

    if (op) {
        // Locations: the legacy operations.location_id column still carries the
        // primary, and operation_locations stores the full set including the
        // primary. Insert primary first (if present) plus any additional ids.
        const locationRows: { operation_id: string; location_id: number; is_primary: boolean }[] = [];
        if (opData.locationId) {
            locationRows.push({ operation_id: op.id, location_id: opData.locationId, is_primary: true });
        }
        if (Array.isArray(opData.additionalLocationIds)) {
            for (const lid of opData.additionalLocationIds) {
                if (!lid || lid === opData.locationId) continue; // de-dupe primary
                locationRows.push({ operation_id: op.id, location_id: lid, is_primary: false });
            }
        }
        if (locationRows.length > 0) {
            const { error: locErr } = await supabase.from('operation_locations').insert(locationRows);
            // Soft-fail: a missing operation_locations table (migration not yet
            // applied) shouldn't break op creation. Surface the warning in logs.
            if (locErr) log.warn('createOperation failed to insert operation_locations', { message: locErr.message });
        }

        // Add owner as leader. Ready state defaults to false — the commander
        // marks themselves ready at their discretion, same as everyone else.
        await supabase.from('operation_participants').insert({
            operation_id: op.id,
            user_id: ownerId,
            is_ready: false,
            role_requested: 'Command',
            attendance_status: 'Registered'
        });

        // Phase tree seeding. The wizard sends EITHER `inlinePhases` (ad-hoc
        // tree built in the form) OR `templateId` (pick from saved templates).
        // Inline takes precedence — a user who picked a template and edited
        // the tree expects their edits to win. Soft-fail so a broken phase
        // payload doesn't kill the otherwise-valid op.
        try {
            if (opData.inlinePhases && Array.isArray(opData.inlinePhases.phases) && opData.inlinePhases.phases.length > 0) {
                const { instantiatePayloadOnOperation } = await import('./operation-templates.js');
                await instantiatePayloadOnOperation(op.id, opData.inlinePhases, {
                    scheduledStart: opData.scheduledStart || null,
                });
            } else if (opData.templateId) {
                const { instantiateTemplateOnOperation } = await import('./operation-templates.js');
                await instantiateTemplateOnOperation(op.id, opData.templateId, {
                    scheduledStart: opData.scheduledStart || null,
                }, (opData as { user?: ClearanceUser | null }).user ?? null);
            }
        } catch (e: unknown) {
            log.warn('createOperation phase seeding failed', { err: e });
        }

        await logOperationEntry(op.id, 'CREATE', 'Operation channel established.', ownerId);
        await broadcastOperationUpdate(op.id);
    }

    // Fetch user details for the return object
    const owner = await getUserById(ownerId);
    const fallbackUser: User = {
        id: ownerId,
        name: 'Commander',
        avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
        discordId: '',
        rsiHandle: 'Unknown',
        role: UserRole.Member,
        roleId: 2,
        reputation: 0,
        isDuty: true,
        permissions: [],
        createdAt: new Date().toISOString()
    };

    // Return constructed HydratedOperation
    return {
        id: op.id,
        name: op.name,
        ownerId: op.owner_id,
        status: op.status,
        type: op.type,
        description: op.description,
        tracksUec: op.tracks_uec,
        totalUec: op.total_uec,
        totalCosts: op.total_costs ?? 0,
        payoutMode: op.payout_mode || 'equal',
        createdAt: op.created_at,
        updatedAt: op.updated_at,
        activeStartTime: op.active_start_time,
        activeEndTime: op.active_end_time,
        isSpecial: op.is_special,
        joinCode: op.join_code,
        clearanceLevel: op.clearance_level,
        isTraining: op.is_training,
        maxParticipants: op.max_participants,
        unitId: op.unit_id,
        limitingMarkers: [],
        // minify the owner so the create response never leaks the owner's
        // adminNotes/clearance/markers/permissions/discordId/RSI code (the
        // fallback is already blank).
        owner: minifyUser(owner) || fallbackUser,
        unit: undefined,
        location: undefined,
        participants: [],
        log: [],
        // Joint operations defaults
        isJoint: op.is_joint || false,
        roe: op.roe || undefined,
        commanderNotes: op.commander_notes || undefined,
        commsPlan: op.comms_plan || [],
        liveStatus: op.live_status || undefined,
        alliedOrgs: [],
        phases: [],
        scheduleEntries: [],
        tasks: [],
        commandNodes: [],
        boardElements: [],
        logistics: [],
        aarEntries: [],
    } as HydratedOperation;
}

export async function getFullOperationDetails(operationId: string) {
    const query = supabase.from('operations').select(`
            id, name, owner_id, status, type, description, tracks_uec, total_uec, total_costs, payout_mode, created_at, updated_at, active_start_time, active_end_time, scheduled_start, scheduled_end, is_special, join_code, clearance_level, is_training, max_participants, unit_id, discord_event_id, discord_announcement_channel_id, discord_announcement_message_id, template_id, additional_location_texts, is_joint, joint_version, roe, commander_notes, comms_plan, live_status, aar_summary, aar_lessons_learned, aar_submitted_at, aar_submitted_by, aar_ai_generated_at, location_text, location_id,
            owner:users!operations_owner_id_fkey(id, name, avatar_url),
            participants:operation_participants(user_id, joined_at, is_ready, role_requested, ship_utilized, attendance_status, rsvp_status, rsvp_at, ship_id, user_ship_id, live_status, payout_share_percent, payout_paid_at, payout_paid_by, user:users!operation_participants_user_id_fkey(id, name, avatar_url, role_id, rank:ranks(name, icon_url)), ship:platform_ships!operation_participants_ship_id_fkey(id, name, image_url)),
            log:operation_log_entries(id, operation_id, entry_type, log_entry, author_id, created_at, uec_amount, cost_category, cost_description, author:users!operation_log_entries_author_id_fkey(id, name, avatar_url)),
            limiting_markers:operation_limiting_markers(marker:security_limiting_markers(id, name, code)),
            unit:units(id, name, parent_unit_id, sort_order, leader_id, logo_url, banner_url, motto, description, has_radio_channel, linked_channel_id, is_restricted),
            location:locations!operations_location_id_fkey(id, name, type, parent_id)
        `).eq('id', operationId).single();
    const { data, error } = await query;
    handleSupabaseError({ error, message: 'Failed to get operation details' });

    // Fetch sub-resources in parallel
    const [phases, scheduleEntries, tasks, commandNodes, boardElements, logistics, aarEntries, additionalLocations, alliedOrgs, alliedParticipants] = await Promise.all([
        safeFetch(supabase.from('operation_phases').select('id, operation_id, name, description, phase_type, sort_order, status, color, created_at').eq('operation_id', operationId).order('sort_order'), [], 'phases'),
        safeFetch(supabase.from('operation_schedule_entries').select('id, operation_id, label, scheduled_time, phase_id, notes, status, sort_order, created_at').eq('operation_id', operationId).order('sort_order'), [], 'schedule'),
        safeFetch(supabase.from('operation_tasks').select('id, operation_id, title, description, task_type, assigned_unit_id, assigned_user_id, phase_id, status, priority, sort_order, created_at, assigned_user:users!operation_tasks_assigned_user_id_fkey(id, name, avatar_url, role_id), assigned_unit:units!operation_tasks_assigned_unit_id_fkey(id, name, parent_unit_id, sort_order, leader_id, logo_url, banner_url, motto, description, has_radio_channel, linked_channel_id, is_restricted)').eq('operation_id', operationId).order('sort_order'), [], 'tasks'),
        safeFetch(supabase.from('operation_command_nodes').select('id, operation_id, parent_id, label, node_type, assigned_user_id, assigned_unit_id, fleet_group_id, pos_x, pos_y, color, icon, sort_order, live_status, created_at, assigned_user:users!operation_command_nodes_assigned_user_id_fkey(id, name, avatar_url, role_id), assigned_unit:units!operation_command_nodes_assigned_unit_id_fkey(id, name, parent_unit_id, sort_order, leader_id, logo_url, banner_url, motto, description, has_radio_channel, linked_channel_id, is_restricted)').eq('operation_id', operationId).order('sort_order'), [], 'command_nodes'),
        safeFetch(supabase.from('operation_board_elements').select('id, operation_id, element_type, label, pos_x, pos_y, width, height, rotation, color, data, layer, sort_order, created_at').eq('operation_id', operationId).order('layer').order('sort_order'), [], 'board'),
        safeFetch(supabase.from('operation_logistics').select('id, operation_id, item_name, quantity_needed, quantity_fulfilled, fulfilled_by_user_id, category, status, notes, created_at').eq('operation_id', operationId).order('created_at'), [], 'logistics'),
        safeFetch(supabase.from('operation_aar_entries').select('id, operation_id, author_id, category, content, upvotes, created_at, author:users!operation_aar_entries_author_id_fkey(id, name, avatar_url, role_id)').eq('operation_id', operationId).order('created_at'), [], 'aar'),
        // operation_locations: junction with the locations row hydrated. Soft-fails
        // if the table doesn't exist (migration not yet applied) → empty array.
        safeFetch(supabase.from('operation_locations').select('is_primary, location:locations(id, name, type, parent_id)').eq('operation_id', operationId), [], 'locations'),
        // Alliance P3 joint-op federation: invited allied peers + their members.
        safeFetch(supabase.from('operation_allied_orgs').select('id, operation_id, peer_id, accepted, invited_at, accepted_at, peer:alliance_peers(label, peer_org_name, peer_org_tag, peer_icon_url)').eq('operation_id', operationId), [], 'allied_orgs'),
        safeFetch(supabase.from('operation_allied_participants').select('operation_id, peer_id, remote_user_handle, display_name, avatar_url, role, ship_text, rsvp_status, is_ready, updated_at').eq('operation_id', operationId), [], 'allied_participants'),
    ]);

    const enriched = {
        ...data,
        phases,
        schedule_entries: scheduleEntries,
        tasks,
        command_nodes: commandNodes,
        board_elements: boardElements,
        logistics,
        aar_entries: aarEntries,
        operation_locations: additionalLocations,
        allied_orgs: alliedOrgs,
        allied_participants: alliedParticipants,
    };
    return toHydratedOperation(enriched as unknown as Parameters<typeof toHydratedOperation>[0]);
}

export async function deleteOperation(operationId: string, userId: number) {
    // Tell accepted allies to drop their mirror BEFORE the cascade removes the
    // operation_allied_orgs rows this reads.
    await pushOperationToAllies(operationId, 'cancel').catch(() => undefined);
    const { error = null } = await supabase.from('operations').delete()
        .eq('id', operationId)
        ;
    handleSupabaseError({ error, message: 'Failed to delete operation' });
    cache.invalidate(opAccessKey(operationId));
    await broadcastOperationUpdate(operationId);
}

interface UpdateOperationInput {
    markerIds?: number[];
    clearanceLevel?: number;
    [key: string]: unknown;
}

export async function updateOperationDetails(operationId: string, updates: UpdateOperationInput, userId: number, actor?: ClearanceUser | null) {
    // Editing an op must not let a caller relabel/downgrade an op they can't
    // currently SEE:
    //   (a) the editor must be cleared to see the LIVE op before mutating any
    //       field (current-visibility guard — blocks downgrade-to-disclose), and
    //   (b) any NEW clearance level / markers must be at/below the actor's own
    //       clearance and use only markers they hold (mislabel-UP guard).
    // operations:manage holders + Admins (the read-side bypass population) may
    // classify freely — identical to createOperation's assertCanClassify gate.
    const { data: live } = await supabase.from('operations')
        .select('id, clearance_level, limiting_markers:operation_limiting_markers(marker:security_limiting_markers(id, name, code))')
        .eq('id', operationId)
        .maybeSingle();
    if (!live) throw new Error("Operation not found or access denied.");
    const liveMarkers = ((live as { limiting_markers?: { marker?: unknown }[] }).limiting_markers || [])
        .map((m) => m.marker).filter(Boolean);
    if (!passesClearance(actor, live.clearance_level ?? 0, liveMarkers, ['operations:manage'])) {
        throw new Error('You are not cleared to edit this operation.');
    }
    // Changing the classification additionally requires the NEW label to be at
    // or below the actor's clearance and to use only markers they hold. Falls
    // back to the live level for marker-only edits.
    if (updates.clearanceLevel !== undefined || updates.markerIds !== undefined) {
        assertCanClassify(actor, updates.clearanceLevel ?? live.clearance_level ?? 0, updates.markerIds, ['operations:manage']);
    }

    const dbUpdates: Record<string, unknown> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    // Strip HTML on description / AAR fields when edited via this path too.
    if (updates.description !== undefined) dbUpdates.description = stripHtml(updates.description, 4000);
    if (updates.type !== undefined) dbUpdates.type = updates.type;
    if (updates.maxParticipants !== undefined) dbUpdates.max_participants = updates.maxParticipants;
    if (updates.tracksUec !== undefined) dbUpdates.tracks_uec = updates.tracksUec;
    if (updates.isSpecial !== undefined) dbUpdates.is_special = updates.isSpecial;
    if (updates.joinCode !== undefined) dbUpdates.join_code = updates.joinCode;
    if (updates.unitId !== undefined) dbUpdates.unit_id = updates.unitId || null;
    if (updates.locationId !== undefined) dbUpdates.location_id = updates.locationId || null;
    if (updates.scheduledStart !== undefined) dbUpdates.scheduled_start = updates.scheduledStart || null;
    if (updates.scheduledEnd !== undefined) dbUpdates.scheduled_end = updates.scheduledEnd || null;
    if (updates.clearanceLevel !== undefined) dbUpdates.clearance_level = updates.clearanceLevel;
    if (updates.roe !== undefined) dbUpdates.roe = updates.roe;
    if (updates.commanderNotes !== undefined) dbUpdates.commander_notes = updates.commanderNotes;
    if (updates.commsPlan !== undefined) dbUpdates.comms_plan = updates.commsPlan;
    if (updates.liveStatus !== undefined) dbUpdates.live_status = updates.liveStatus;
    if (updates.aarSummary !== undefined) dbUpdates.aar_summary = stripHtml(updates.aarSummary, 8000);
    if (updates.aarLessonsLearned !== undefined) dbUpdates.aar_lessons_learned = stripHtml(updates.aarLessonsLearned, 8000);
    if (updates.status !== undefined) {
        dbUpdates.status = updates.status;
        if (updates.status === 'Active' && !dbUpdates.active_start_time) dbUpdates.active_start_time = new Date().toISOString();
        if (updates.status === 'Concluded' && !dbUpdates.active_end_time) dbUpdates.active_end_time = new Date().toISOString();
    }

    // Handle limiting markers separately (delete + re-insert)
    if (updates.markerIds !== undefined) {
        await supabase.from('operation_limiting_markers').delete().eq('operation_id', operationId);
        if (updates.markerIds.length > 0) {
            const markers = updates.markerIds.map((mid: number) => ({ operation_id: operationId, marker_id: mid }));
            await supabase.from('operation_limiting_markers').insert(markers);
        }
    }

    if (Object.keys(dbUpdates).length === 0 && updates.markerIds === undefined) return;

    const { error } = await supabase.from('operations').update(dbUpdates)
        .eq('id', operationId)
        ;
    if (!error) {
        const actor = await getUserById(userId);
        await logOperationEntry(operationId, 'UPDATE', `${actor?.name || 'Unknown'} updated operation details`, userId);
    }
    handleSupabaseError({ error, message: 'Failed to update operation' });
    await broadcastOperationUpdate(operationId);
}

export async function updateOperationStatus(operationId: string, status: string, userId: number) {
    const updates: Record<string, unknown> = { status };
    if (status === 'Active') updates.active_start_time = new Date().toISOString();
    if (status === 'Concluded') {
        updates.active_end_time = new Date().toISOString();
        updates.live_status = null;
    }

    const { error } = await supabase.from('operations').update(updates)
        .eq('id', operationId)
        ;
    if (!error) {
        const actor = await getUserById(userId);
        await logOperationEntry(operationId, 'STATUS_CHANGE', `${actor?.name || 'Unknown'} changed status to ${status}`, userId);
    }
    handleSupabaseError({ error, message: 'Failed to update operation status' });

    // On conclude: reset all participant state and terminate radio
    if (status === 'Concluded') {
        const now = new Date().toISOString();

        // Reset participant readiness, live status, and mark all as left
        await supabase.from('operation_participants').update({
            is_ready: false,
            live_status: null,
            time_left: now,
        }).eq('operation_id', operationId).is('time_left', null);

        // Disconnect participants from radio by clearing their voice channel
        const { data: participants } = await supabase
            .from('operation_participants')
            .select('user_id')
            .eq('operation_id', operationId);
        if (participants?.length) {
            const userIds = participants.map(p => p.user_id);
            await supabase.from('users')
                .update({ voice_channel_name: null })
                .in('id', userIds)
                .not('voice_channel_name', 'is', null);
        }
    }

    await broadcastOperationUpdate(operationId);
    // Critical event → push to accepted allies immediately (hybrid transport).
    void pushOperationToAllies(operationId, 'status_change').catch(() => undefined);
}

// A user_ships row id is an enumerable PK. When a caller binds a ship to an
// operation participation row, verify the ship actually belongs to the user that
// participation is for — otherwise a member could attach another member's ship,
// leaking its custom_name/loadout via the roster embed and corrupting
// fleet/payout attribution. No-op when no ship is being set.
async function assertUserShipOwnedBy(userShipId: number | null | undefined, ownerUserId: number, fnName: string): Promise<void> {
    if (!userShipId) return;
    const { data, error } = await supabase.from('user_ships').select('user_id').eq('id', userShipId).maybeSingle();
    if (error) handleSupabaseError({ error, message: `${fnName}: failed to verify ship ownership` });
    if (!data || data.user_id !== ownerUserId) {
        throw new Error('Selected ship does not belong to this user.');
    }
}

export async function joinOperation(operationId: string, userId: number, joinCode?: string, roleRequested?: string, shipUtilized?: string, shipId?: number, userShipId?: number) {
    await verifyOperationAccess(operationId);
    await assertUserShipOwnedBy(userShipId, userId, 'joinOperation');

    // Fetch operation details for join code / capacity checks
    const { data: op } = await supabase.from('operations').select('is_special, join_code, max_participants').eq('id', operationId).single();

    if (op && op.is_special) {
        if (!joinCode || op.join_code !== joinCode) {
            throw new Error("Invalid Join Code.");
        }
    }

    // Atomic capacity-check + upsert under a row lock (race-1) — concurrent joins
    // serialise on the operations row so max_participants can't be overshot.
    const { error: rpcError } = await supabase.rpc('op_join_participant', {
        p_operation_id: operationId,
        p_user_id: userId,
        p_role_requested: roleRequested ?? null,
        p_ship_utilized: shipUtilized ?? null,
        p_ship_id: shipId ?? null,
        p_user_ship_id: userShipId ?? null,
    });
    if (rpcError) {
        if (typeof rpcError.message === 'string' && rpcError.message.includes('operation_full')) {
            throw new Error("Operation is full.");
        }
        const rpcCode = (rpcError as { code?: string }).code;
        // Soft-fallback if the RPC predates the schema redeploy (function missing):
        // the non-atomic count-then-upsert (the prior behavior).
        if (rpcCode === 'PGRST202' || rpcCode === '42883') {
            if (op && op.max_participants) {
                const { count } = await supabase.from('operation_participants').select('user_id', { count: 'exact', head: true }).eq('operation_id', operationId);
                if ((count || 0) >= op.max_participants) throw new Error("Operation is full.");
            }
            const { error } = await supabase.from('operation_participants').upsert({
                operation_id: operationId,
                user_id: userId,
                role_requested: roleRequested,
                ship_utilized: shipUtilized,
                ship_id: shipId || null,
                user_ship_id: userShipId || null,
                attendance_status: 'Registered',
                is_ready: false,
            }, { onConflict: 'operation_id,user_id', ignoreDuplicates: false });
            handleSupabaseError({ error, message: 'Failed to join operation' });
        } else {
            handleSupabaseError({ error: rpcError, message: 'Failed to join operation' });
        }
    }

    const joiner = await getUserById(userId);
    await logOperationEntry(operationId, 'JOIN', `${joiner?.name || 'Unknown'} joined the operation`, userId);
    await broadcastOperationUpdate(operationId);
}

export async function leaveOperation(operationId: string, userId: number) {
    await verifyOperationAccess(operationId);

    const { error = null } = await supabase.from('operation_participants').delete().eq('operation_id', operationId).eq('user_id', userId);
    if (!error) {
        const leaver = await getUserById(userId);
        await logOperationEntry(operationId, 'LEAVE', `${leaver?.name || 'Unknown'} left the operation`, userId);
    }
    handleSupabaseError({ error, message: 'Failed to leave operation' });
    await broadcastOperationUpdate(operationId);
}

export async function addOperationParticipant(operationId: string, targetUserId: number, adminId: number) {
    await verifyOperationAccess(operationId);

    const { error } = await supabase.from('operation_participants').upsert({
        operation_id: operationId,
        user_id: targetUserId,
        attendance_status: 'Registered',
    }, { onConflict: 'operation_id,user_id', ignoreDuplicates: false });
    if (!error) {
        const [target, admin] = await Promise.all([getUserById(targetUserId), getUserById(adminId)]);
        await logOperationEntry(operationId, 'ADD_MEMBER', `${target?.name || 'Unknown'} added by ${admin?.name || 'Unknown'}`, adminId);
    }
    handleSupabaseError({ error, message: 'Failed to add participant' });
    await broadcastOperationUpdate(operationId);
}

export async function updateOperationParticipant(operationId: string, targetUserId: number, updates: Record<string, unknown>) {
    await verifyOperationAccess(operationId);

    // The target must already be a participant — this mutates an existing row,
    // not creates one, so refuse to silently no-op against a non-participant id.
    const { data: existingParticipant } = await supabase.from('operation_participants')
        .select('user_id').eq('operation_id', operationId).eq('user_id', targetUserId).maybeSingle();
    if (!existingParticipant) {
        throw new Error('Target user is not a participant of this operation.');
    }

    const dbUpdates: Record<string, unknown> = {};
    if (updates.roleRequested !== undefined) dbUpdates.role_requested = updates.roleRequested;
    if (updates.shipUtilized !== undefined) dbUpdates.ship_utilized = updates.shipUtilized;
    if (updates.attendanceStatus !== undefined) dbUpdates.attendance_status = updates.attendanceStatus;
    if (updates.shipId !== undefined) dbUpdates.ship_id = updates.shipId || null;
    if (updates.userShipId !== undefined) {
        const reqUserShipId = typeof updates.userShipId === 'number' ? updates.userShipId : null;
        // Ship must belong to the participant the row is for, not the caller.
        await assertUserShipOwnedBy(reqUserShipId, targetUserId, 'updateOperationParticipant');
        dbUpdates.user_ship_id = reqUserShipId;
    }

    const { error } = await supabase.from('operation_participants').update(dbUpdates)
        .eq('operation_id', operationId).eq('user_id', targetUserId);
    handleSupabaseError({ error, message: 'Failed to update participant' });
    await broadcastOperationUpdate(operationId);
}

export async function logOperationEntry(
    operationId: string,
    type: string,
    entry: string,
    userId: number,
    uecAmount?: number,
    costCategory?: string,
    costDescription?: string,
) {
    const payload: Record<string, unknown> = {
        operation_id: operationId,
        entry_type: type,
        log_entry: entry,
        author_id: userId,
        uec_amount: uecAmount,
    };
    if (costCategory !== undefined) payload.cost_category = costCategory;
    if (costDescription !== undefined) payload.cost_description = costDescription;

    let { error } = await supabase.from('operation_log_entries').insert(payload);
    // Soft-fail: if the cost columns aren't present yet (pre-migration instance),
    // strip them and retry. Cost metadata is preserved in log_entry text by the
    // caller so the human-readable record isn't lost.
    if (error) {
        const code = (error as { code?: string } | null)?.code;
        if ((code === '42703' || code === 'PGRST204') && (payload.cost_category !== undefined || payload.cost_description !== undefined)) {
            log.warn('db migration: operation_log_entries.cost_category/description unavailable; retrying without typed fields');
            delete payload.cost_category;
            delete payload.cost_description;
            const retry = await supabase.from('operation_log_entries').insert(payload);
            error = retry.error;
        }
    }
    handleSupabaseError({ error, message: 'Failed to log operation entry' });
    // Note: Callers are responsible for broadcasting. This avoids double-broadcasts when
    // logOperationEntry is called from within another function that also broadcasts.
}

export async function addOperationCost(
    operationId: string,
    amount: number,
    category: string,
    description: string | undefined,
    userId: number,
) {
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Cost amount must be a positive number.');
    }
    await verifyOperationAccess(operationId);

    // Atomic accumulator on operations.total_costs.
    const { error } = await supabase.rpc('add_cost_to_operation', { op_id: operationId, amount_to_add: Math.floor(amount) });
    if (error) {
        // Soft-fail: function doesn't exist yet (pre-migration). Fall back to a
        // direct increment, but tolerate a missing total_costs column too — in
        // that case we record only the log entry. The migration is required for
        // the metric to display, but the audit trail still lands.
        const code = (error as { code?: string } | null)?.code;
        if (code === '42883' || code === 'PGRST202') {
            log.warn('db migration: add_cost_to_operation() not present; falling back to log-only');
        } else {
            handleSupabaseError({ error, message: 'Failed to record cost' });
        }
    }

    const actor = await getUserById(userId);
    const desc = description?.trim() || '';
    const human = `${actor?.name || 'Unknown'} recorded ${amount} aUEC cost${category ? ` (${category})` : ''}${desc ? `. ${desc}` : ''}`;
    await logOperationEntry(operationId, 'UEC_COST', human, userId, amount, category, desc || undefined);

    await broadcastOperationUpdate(operationId);
}

export async function setOperationPayoutMode(
    operationId: string,
    mode: 'equal' | 'weighted' | 'custom',
    userId: number,
) {
    if (!['equal', 'weighted', 'custom'].includes(mode)) {
        throw new Error(`Invalid payout mode: ${mode}`);
    }
    await verifyOperationAccess(operationId);

    // verifyOperationAccess already gates by ally-or-owner; pin the UPDATE to the
    // operation as well so a future regression in the gate can't smuggle a write
    // to another op.
    const { error } = await supabase.from('operations')
        .update({ payout_mode: mode })
        .eq('id', operationId)
        ;
    if (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code === '42703' || code === 'PGRST204') {
            log.warn('db migration: operations.payout_mode unavailable; skipping mode update');
            return;
        }
        handleSupabaseError({ error, message: 'Failed to update payout mode' });
    }

    await broadcastOperationUpdate(operationId);
}

export async function setOperationPayoutSplits(
    operationId: string,
    splits: Array<{ userId: number; percent: number }>,
    actorUserId: number,
) {
    if (!Array.isArray(splits) || splits.length === 0) {
        throw new Error('At least one split row is required.');
    }
    // Each share must be a finite, non-negative percent. Otherwise a negative share
    // offset by larger positives could still sum to ~100% while handing a member a
    // negative payout.
    for (const s of splits) {
        const p = Number(s.percent);
        if (!Number.isFinite(p) || p < 0 || p > 100) {
            throw new Error('Each payout share must be between 0 and 100 percent.');
        }
    }
    const sum = splits.reduce((acc, s) => acc + (Number(s.percent) || 0), 0);
    if (sum < 99.9 || sum > 100.1) {
        throw new Error(`Splits must sum to 100% (got ${sum.toFixed(2)}%).`);
    }
    await verifyOperationAccess(operationId);

    // Verify every userId is a current participant — prevents writing share for
    // users not in the op (which would be silently dropped at update time).
    const { data: participants } = await supabase
        .from('operation_participants')
        .select('user_id')
        .eq('operation_id', operationId);
    const validIds = new Set((participants || []).map((p: { user_id: number }) => p.user_id));
    for (const s of splits) {
        if (!validIds.has(s.userId)) {
            throw new Error(`User ${s.userId} is not a participant of this operation.`);
        }
    }

    // Try one update; on 42703/PGRST204 the column is missing — reject loudly,
    // splits without persistence are pointless.
    const probe = await supabase
        .from('operation_participants')
        .update({ payout_share_percent: splits[0].percent })
        .eq('operation_id', operationId)
        .eq('user_id', splits[0].userId);
    if (probe.error) {
        const code = (probe.error as { code?: string } | null)?.code;
        if (code === '42703' || code === 'PGRST204') {
            throw new Error('Custom splits require a database migration that has not yet been applied. Please contact your administrator.');
        }
        handleSupabaseError({ error: probe.error, message: 'Failed to set payout splits' });
    }

    // Apply remaining rows in parallel.
    await Promise.all(splits.slice(1).map(s =>
        supabase
            .from('operation_participants')
            .update({ payout_share_percent: s.percent })
            .eq('operation_id', operationId)
            .eq('user_id', s.userId)
    ));

    await broadcastOperationUpdate(operationId);
}

export async function toggleParticipantPayoutPaid(
    operationId: string,
    targetUserId: number,
    paid: boolean,
    actorUserId: number,
) {
    await verifyOperationAccess(operationId);

    // Lock once op is concluded so the audit trail is preserved.
    const { data: op } = await supabase
        .from('operations')
        .select('status')
        .eq('id', operationId)
        .single();
    if (op?.status === 'Concluded') {
        throw new Error('Cannot modify payout state on a concluded operation.');
    }

    const update = paid
        ? { payout_paid_at: new Date().toISOString(), payout_paid_by: actorUserId }
        : { payout_paid_at: null, payout_paid_by: null };
    const { error } = await supabase
        .from('operation_participants')
        .update(update)
        .eq('operation_id', operationId)
        .eq('user_id', targetUserId);
    if (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code === '42703' || code === 'PGRST204') {
            log.warn('db migration: payout_paid_at/by unavailable; skipping');
            return;
        }
        handleSupabaseError({ error, message: 'Failed to update payout status' });
    }

    await broadcastOperationUpdate(operationId);
}

export async function addOperationUec(operationId: string, amount: number, reason: string, userId: number) {
    // A deposit must be a positive, finite number within a sane bound. Without this a
    // negative amount could drain the pool and a non-finite / absurd value could
    // corrupt the running total or overflow it.
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000_000_000) {
        throw new Error('Deposit amount must be a positive number.');
    }
    await verifyOperationAccess(operationId);

    const { error } = await supabase.rpc('add_uec_to_operation', { op_id: operationId, amount_to_add: amt });
    if (!error) {
        const actor = await getUserById(userId);
        await logOperationEntry(operationId, 'UEC_DEPOSIT', `${actor?.name || 'Unknown'} deposited ${amount} aUEC. Reason: ${reason}`, userId, amount);
    }
    handleSupabaseError({ error, message: 'Failed to add UEC' });
    await broadcastOperationUpdate(operationId);
}

export async function toggleParticipantReady(operationId: string, userId: number) {
    await verifyOperationAccess(operationId);

    const { data } = await supabase.from('operation_participants').select('is_ready').eq('operation_id', operationId).eq('user_id', userId).single();
    const newStatus = !data?.is_ready;
    const { error } = await supabase.from('operation_participants').update({ is_ready: newStatus }).eq('operation_id', operationId).eq('user_id', userId);
    handleSupabaseError({ error, message: 'Failed to toggle ready status' });
    await broadcastOperationUpdate(operationId);
}

export async function updateParticipantLiveStatus(operationId: string, userId: number, liveStatus: string) {
    await verifyOperationAccess(operationId);

    // The free-text status is both persisted and embedded in a STATUS_CHANGE log
    // entry. Strip HTML at the boundary so injected markup can't ride into a
    // future surface that renders the status / log as HTML, and cap its length.
    const safeStatus = stripHtmlSingleLine(liveStatus, 200);

    const { error } = await supabase.from('operation_participants')
        .update({ live_status: safeStatus })
        .eq('operation_id', operationId)
        .eq('user_id', userId);
    handleSupabaseError({ error, message: 'Failed to update participant live status' });
    const actor = await getUserById(userId);
    await logOperationEntry(operationId, 'STATUS_CHANGE', `${actor?.name || 'Unknown'} set personal status to ${safeStatus}`, userId);
    await broadcastOperationUpdate(operationId);
}

export async function resetOperationReadiness(operationId: string) {
    await verifyOperationAccess(operationId);

    const { error } = await supabase.from('operation_participants').update({ is_ready: false }).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to reset readiness' });
    await broadcastOperationUpdate(operationId);
}

export async function rsvpOperation(operationId: string, userId: number, rsvpStatus: string, shipId?: number, userShipId?: number) {
    await verifyOperationAccess(operationId);
    await assertUserShipOwnedBy(userShipId, userId, 'rsvpOperation');

    const updates: Record<string, unknown> = { rsvp_status: rsvpStatus, rsvp_at: new Date().toISOString() };
    if (shipId !== undefined) updates.ship_id = shipId || null;
    if (userShipId !== undefined) updates.user_ship_id = userShipId || null;

    const { error } = await supabase.from('operation_participants')
        .update(updates)
        .eq('operation_id', operationId)
        .eq('user_id', userId);
    handleSupabaseError({ error, message: 'Failed to update RSVP' });
    await broadcastOperationUpdate(operationId);
}

export async function createOperationReminders(operationId: string, scheduledStart: string) {
    const startTime = new Date(scheduledStart).getTime();
    const reminders = [
        { remind_at: new Date(startTime - 30 * 60000).toISOString() }, // 30 min before
        { remind_at: new Date(startTime - 5 * 60000).toISOString() }   // 5 min before
    ].filter(r => new Date(r.remind_at) > new Date()); // Only create future reminders

    if (reminders.length === 0) return;

    const rows = reminders.map(r => ({
        operation_id: operationId,
        remind_at: r.remind_at,
        sent: false
    }));

    await supabase.from('operation_reminders').insert(rows);
}

export async function updateLiveStatus(operationId: string, liveStatus: string, userId: number) {
    const { error } = await supabase.from('operations')
        .update({ live_status: liveStatus })
        .eq('id', operationId)
        ;
    handleSupabaseError({ error, message: 'Failed to update live status' });
    const actor = await getUserById(userId);
    await logOperationEntry(operationId, 'STATUS_CHANGE', `${actor?.name || 'Unknown'} set live status to ${liveStatus}`, userId);
    await broadcastOperationUpdate(operationId);
}

// =============================================================================
// Phase CRUD
// =============================================================================

export async function addOperationPhase(operationId: string, data: Record<string, unknown>) {
    const { data: result, error } = await supabase.from('operation_phases').insert({
        operation_id: operationId,
        name: data.name,
        description: data.description || null,
        phase_type: data.phaseType || 'sequential',
        sort_order: data.sortOrder || 0,
        status: data.status || 'Pending',
        color: data.color || null,
    }).select('id, operation_id, name, description, phase_type, sort_order, status, color, created_at').single();
    handleSupabaseError({ error, message: 'Failed to add phase' });
    return result;
}

export async function updateOperationPhase(phaseId: number, data: Record<string, unknown>, operationId?: string): Promise<{ cascadedTasks: number; cascadedMilestones: number }> {
    // Scope by the (already verified) operation so a foreign child id can't be
    // mutated by passing your own operationId past verifyOperationAccess.
    if (!operationId) throw new Error('updateOperationPhase: operationId is required');
    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.phaseType !== undefined) updates.phase_type = data.phaseType;
    if (data.sortOrder !== undefined) updates.sort_order = data.sortOrder;
    if (data.status !== undefined) updates.status = data.status;
    if (data.color !== undefined) updates.color = data.color;
    const { error } = await supabase.from('operation_phases').update(updates).eq('id', phaseId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to update phase' });

    // When a phase transitions to Completed, cascade child tasks and schedule
    // entries whose status is Pending/Active onto Completed. Failed and Skipped
    // children are intentionally left alone — their terminal state is meaningful.
    // Schedule entries default to a null status, which the UI treats as Pending,
    // so null is included in the cascade-eligible set. The cascade UPDATEs are
    // scoped by operation_id too so a foreign phaseId can't cascade across ops.
    if (data.status === 'Completed') {
        const { data: cascadedTasks, error: taskErr } = await supabase
            .from('operation_tasks')
            .update({ status: 'Completed' })
            .eq('operation_id', operationId)
            .eq('phase_id', phaseId)
            .in('status', ['Pending', 'Active'])
            .select('id');
        handleSupabaseError({ error: taskErr, message: 'Failed to cascade phase completion to tasks' });

        // Schedule entries: catch null/Pending/Active in two passes (Supabase doesn't
        // support OR with .in/.is in a single chained call cleanly).
        const { data: cascadedActive, error: actErr } = await supabase
            .from('operation_schedule_entries')
            .update({ status: 'Completed' })
            .eq('operation_id', operationId)
            .eq('phase_id', phaseId)
            .in('status', ['Pending', 'Active'])
            .select('id');
        handleSupabaseError({ error: actErr, message: 'Failed to cascade phase completion to milestones' });

        const { data: cascadedNull, error: nullErr } = await supabase
            .from('operation_schedule_entries')
            .update({ status: 'Completed' })
            .eq('operation_id', operationId)
            .eq('phase_id', phaseId)
            .is('status', null)
            .select('id');
        handleSupabaseError({ error: nullErr, message: 'Failed to cascade phase completion to milestones' });

        return {
            cascadedTasks: (cascadedTasks || []).length,
            cascadedMilestones: ((cascadedActive || []).length) + ((cascadedNull || []).length),
        };
    }

    return { cascadedTasks: 0, cascadedMilestones: 0 };
}

export async function deleteOperationPhase(phaseId: number, operationId?: string) {
    // Scope by the (already verified) operation so a foreign child id can't be
    // deleted by passing your own operationId past verifyOperationAccess.
    if (!operationId) throw new Error('deleteOperationPhase: operationId is required');
    const { error } = await supabase.from('operation_phases').delete()
        .eq('id', phaseId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to delete phase' });
}

// =============================================================================
// Schedule Entry CRUD
// =============================================================================

export async function addScheduleEntry(operationId: string, data: Record<string, unknown>) {
    // scheduled_time was made nullable in migrations/add-operation-locations.sql.
    // A bare empty string from the form is normalised to null so callers can
    // pass through React form state without conditional casting.
    const scheduledTime = data.scheduledTime || null;
    const { data: result, error } = await supabase.from('operation_schedule_entries').insert({
        operation_id: operationId,
        label: data.label,
        scheduled_time: scheduledTime,
        phase_id: data.phaseId || null,
        notes: data.notes || null,
        status: data.status || null,
        sort_order: data.sortOrder || 0,
    }).select('id, operation_id, label, scheduled_time, phase_id, notes, status, sort_order, created_at').single();
    handleSupabaseError({ error, message: 'Failed to add schedule entry' });
    return result;
}

export async function updateScheduleEntry(entryId: number, data: Record<string, unknown>, operationId?: string) {
    // Scope by the (already verified) operation.
    if (!operationId) throw new Error('updateScheduleEntry: operationId is required');
    const updates: Record<string, unknown> = {};
    if (data.label !== undefined) updates.label = data.label;
    // Empty string → null lets the form clear a previously-set time.
    if (data.scheduledTime !== undefined) updates.scheduled_time = data.scheduledTime || null;
    if (data.phaseId !== undefined) updates.phase_id = data.phaseId || null;
    if (data.notes !== undefined) updates.notes = data.notes;
    if (data.status !== undefined) updates.status = data.status;
    if (data.sortOrder !== undefined) updates.sort_order = data.sortOrder;
    const { error } = await supabase.from('operation_schedule_entries').update(updates).eq('id', entryId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to update schedule entry' });
}

export async function deleteScheduleEntry(entryId: number, operationId?: string) {
    if (!operationId) throw new Error('deleteScheduleEntry: operationId is required');
    const { error } = await supabase.from('operation_schedule_entries').delete()
        .eq('id', entryId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to delete schedule entry' });
}

// =============================================================================
// Task CRUD
// =============================================================================

export async function addOperationTask(operationId: string, data: Record<string, unknown>) {
    const { data: result, error } = await supabase.from('operation_tasks').insert({
        operation_id: operationId,
        title: data.title,
        description: data.description || null,
        task_type: data.taskType || 'primary',
        assigned_unit_id: data.assignedUnitId || null,
        assigned_user_id: data.assignedUserId || null,
        phase_id: data.phaseId || null,
        status: data.status || 'Pending',
        priority: data.priority || 'Normal',
        sort_order: data.sortOrder || 0,
    }).select('id, operation_id, title, description, task_type, assigned_unit_id, assigned_user_id, phase_id, status, priority, sort_order, created_at').single();
    handleSupabaseError({ error, message: 'Failed to add task' });
    return result;
}

export async function updateOperationTask(taskId: number, data: Record<string, unknown>, operationId?: string) {
    // Scope by the (already verified) operation.
    if (!operationId) throw new Error('updateOperationTask: operationId is required');
    const updates: Record<string, unknown> = {};
    if (data.title !== undefined) updates.title = data.title;
    if (data.description !== undefined) updates.description = data.description;
    if (data.taskType !== undefined) updates.task_type = data.taskType;
    if (data.assignedUnitId !== undefined) updates.assigned_unit_id = data.assignedUnitId || null;
    if (data.assignedUserId !== undefined) updates.assigned_user_id = data.assignedUserId || null;
    if (data.phaseId !== undefined) updates.phase_id = data.phaseId || null;
    if (data.status !== undefined) updates.status = data.status;
    if (data.priority !== undefined) updates.priority = data.priority;
    if (data.sortOrder !== undefined) updates.sort_order = data.sortOrder;
    const { error } = await supabase.from('operation_tasks').update(updates).eq('id', taskId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to update task' });
}

export async function deleteOperationTask(taskId: number, operationId?: string) {
    if (!operationId) throw new Error('deleteOperationTask: operationId is required');
    const { error } = await supabase.from('operation_tasks').delete()
        .eq('id', taskId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to delete task' });
}

// =============================================================================
// Command Node CRUD (C2)
// =============================================================================

export async function addCommandNode(operationId: string, data: Record<string, unknown>) {
    const { data: result, error } = await supabase.from('operation_command_nodes').insert({
        operation_id: operationId,
        parent_id: data.parentId || null,
        label: data.label,
        node_type: data.nodeType || 'position',
        assigned_user_id: data.assignedUserId || null,
        assigned_unit_id: data.assignedUnitId || null,
        fleet_group_id: data.fleetGroupId || null,
        pos_x: data.posX || 0,
        pos_y: data.posY || 0,
        color: data.color || null,
        icon: data.icon || null,
        sort_order: data.sortOrder || 0,
    }).select('id, operation_id, parent_id, label, node_type, assigned_user_id, assigned_unit_id, fleet_group_id, pos_x, pos_y, color, icon, sort_order, live_status, created_at').single();
    handleSupabaseError({ error, message: 'Failed to add command node' });
    return result;
}

export async function updateCommandNode(nodeId: number, data: Record<string, unknown>, operationId?: string) {
    // Scope by the (already verified) operation.
    if (!operationId) throw new Error('updateCommandNode: operationId is required');
    const updates: Record<string, unknown> = {};
    if (data.parentId !== undefined) updates.parent_id = data.parentId || null;
    if (data.label !== undefined) updates.label = data.label;
    if (data.nodeType !== undefined) updates.node_type = data.nodeType;
    if (data.assignedUserId !== undefined) updates.assigned_user_id = data.assignedUserId || null;
    if (data.assignedUnitId !== undefined) updates.assigned_unit_id = data.assignedUnitId || null;
    if (data.fleetGroupId !== undefined) updates.fleet_group_id = data.fleetGroupId || null;
    if (data.posX !== undefined) updates.pos_x = data.posX;
    if (data.posY !== undefined) updates.pos_y = data.posY;
    if (data.color !== undefined) updates.color = data.color;
    if (data.icon !== undefined) updates.icon = data.icon;
    if (data.sortOrder !== undefined) updates.sort_order = data.sortOrder;
    if (data.liveStatus !== undefined) updates.live_status = data.liveStatus || null;
    const { error } = await supabase.from('operation_command_nodes').update(updates).eq('id', nodeId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to update command node' });
}

export async function deleteCommandNode(nodeId: number, operationId?: string) {
    if (!operationId) throw new Error('deleteCommandNode: operationId is required');
    const { error } = await supabase.from('operation_command_nodes').delete()
        .eq('id', nodeId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to delete command node' });
}

// =============================================================================
// Board Element CRUD (Tactical Board)
// =============================================================================

/**
 * Per-op realtime channel for tactical board deltas.
 *
 * A dedicated channel narrows the fan-out: the board audience is small
 * (typically 1–5 users actively viewing a given operation), so board mutations
 * go to `op-board-{operationId}` instead of the org-wide `operation_update`
 * (which fans out to every connected user). Other detail mutations (phases,
 * tasks, command nodes, logistics, AAR) still go through `broadcastOpChange()`
 * so OperationDetailView refetches them.
 */
function boardChannelName(operationId: string) {
    return `op-board-${operationId}`;
}

export async function broadcastBoardAdd(operationId: string, element: unknown, clientNonce?: string) {
    await broadcastToChannel(boardChannelName(operationId), 'board_element_update', {
        operationId, op: 'add', element, clientNonce,
    });
}

export async function broadcastBoardUpdate(operationId: string, elementId: number, changes: unknown) {
    await broadcastToChannel(boardChannelName(operationId), 'board_element_update', {
        operationId, op: 'update', elementId, changes,
    });
}

export async function broadcastBoardDelete(operationId: string, elementId: number) {
    await broadcastToChannel(boardChannelName(operationId), 'board_element_update', {
        operationId, op: 'delete', elementId,
    });
}

export async function addBoardElement(operationId: string, data: Record<string, unknown>) {
    const { data: result, error } = await supabase.from('operation_board_elements').insert({
        operation_id: operationId,
        element_type: data.elementType || 'unit',
        label: data.label || null,
        pos_x: data.posX || 0,
        pos_y: data.posY || 0,
        width: data.width || null,
        height: data.height || null,
        rotation: data.rotation || 0,
        color: data.color || null,
        data: data.data || {},
        layer: data.layer || 0,
        sort_order: data.sortOrder || 0,
    }).select('id, operation_id, element_type, label, pos_x, pos_y, width, height, rotation, color, data, layer, sort_order, created_at').single();
    handleSupabaseError({ error, message: 'Failed to add board element' });
    return result;
}

export async function updateBoardElement(elementId: number, data: Record<string, unknown>, operationId?: string) {
    // Scope by the (already verified) operation.
    if (!operationId) throw new Error('updateBoardElement: operationId is required');
    const updates: Record<string, unknown> = {};
    if (data.elementType !== undefined) updates.element_type = data.elementType;
    if (data.label !== undefined) updates.label = data.label;
    if (data.posX !== undefined) updates.pos_x = data.posX;
    if (data.posY !== undefined) updates.pos_y = data.posY;
    if (data.width !== undefined) updates.width = data.width;
    if (data.height !== undefined) updates.height = data.height;
    if (data.rotation !== undefined) updates.rotation = data.rotation;
    if (data.color !== undefined) updates.color = data.color;
    if (data.data !== undefined) updates.data = data.data;
    if (data.layer !== undefined) updates.layer = data.layer;
    if (data.sortOrder !== undefined) updates.sort_order = data.sortOrder;
    const { error } = await supabase.from('operation_board_elements').update(updates).eq('id', elementId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to update board element' });
}

export async function deleteBoardElement(elementId: number, operationId?: string) {
    if (!operationId) throw new Error('deleteBoardElement: operationId is required');
    const { error } = await supabase.from('operation_board_elements').delete()
        .eq('id', elementId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to delete board element' });
}

export async function saveBoardLayout(operationId: string, elements: Record<string, unknown>[]) {
    // Diff-based save: UPDATE rows that have an `id`, INSERT rows that don't,
    // DELETE rows whose IDs aren't in the provided payload. This is the safe
    // replacement for the old DELETE-all + re-INSERT — two officers editing
    // different elements no longer wipe each other's work.
    const { data: existing, error: fetchError } = await supabase
        .from('operation_board_elements')
        .select('id')
        .eq('operation_id', operationId);
    handleSupabaseError({ error: fetchError, message: 'Failed to load existing board layout' });

    const existingIds = new Set<number>((existing || []).map((r: { id: number }) => Number(r.id)));
    const providedIds = new Set<number>(
        elements.filter(e => e.id !== undefined && e.id !== null && Number(e.id) > 0).map(e => Number(e.id)),
    );

    const toMap = (e: Record<string, unknown>) => ({
        operation_id: operationId,
        element_type: e.elementType || 'unit',
        label: e.label ?? null,
        pos_x: e.posX ?? 0,
        pos_y: e.posY ?? 0,
        width: e.width ?? null,
        height: e.height ?? null,
        rotation: e.rotation ?? 0,
        color: e.color ?? null,
        data: e.data ?? {},
        layer: e.layer ?? 0,
        sort_order: e.sortOrder ?? 0,
    });

    // Reap rows no longer present in the payload
    const toDelete = Array.from(existingIds).filter(id => !providedIds.has(id));
    if (toDelete.length > 0) {
        const { error } = await supabase.from('operation_board_elements').delete().in('id', toDelete);
        handleSupabaseError({ error, message: 'Failed to reap removed board elements' });
    }

    // Update rows that carry an existing id
    for (const el of elements) {
        const id = Number(el.id);
        if (id > 0 && existingIds.has(id)) {
            const { error } = await supabase.from('operation_board_elements').update(toMap(el)).eq('id', id);
            handleSupabaseError({ error, message: 'Failed to update board element' });
        }
    }

    // Insert rows without an id (new elements from the caller)
    const toInsert = elements.filter(e => !(Number(e.id) > 0)).map(toMap);
    if (toInsert.length > 0) {
        const { error } = await supabase.from('operation_board_elements').insert(toInsert);
        handleSupabaseError({ error, message: 'Failed to insert new board elements' });
    }
}

// =============================================================================
// Logistics CRUD
// =============================================================================

export async function addLogisticsItem(operationId: string, data: Record<string, unknown>) {
    const { data: result, error } = await supabase.from('operation_logistics').insert({
        operation_id: operationId,
        item_name: data.itemName,
        quantity_needed: data.quantityNeeded || 1,
        quantity_fulfilled: data.quantityFulfilled || 0,
        category: data.category || 'general',
        status: data.status || 'Needed',
        notes: data.notes || null,
    }).select('id, operation_id, item_name, quantity_needed, quantity_fulfilled, fulfilled_by_user_id, category, status, notes, created_at').single();
    handleSupabaseError({ error, message: 'Failed to add logistics item' });
    return result;
}

export async function updateLogisticsItem(itemId: number, data: Record<string, unknown>, operationId?: string) {
    // Scope by the (already verified) operation.
    if (!operationId) throw new Error('updateLogisticsItem: operationId is required');
    const updates: Record<string, unknown> = {};
    if (data.itemName !== undefined) updates.item_name = data.itemName;
    if (data.quantityNeeded !== undefined) updates.quantity_needed = data.quantityNeeded;
    if (data.quantityFulfilled !== undefined) updates.quantity_fulfilled = data.quantityFulfilled;
    if (data.fulfilledByUserId !== undefined) updates.fulfilled_by_user_id = data.fulfilledByUserId || null;
    if (data.category !== undefined) updates.category = data.category;
    if (data.status !== undefined) updates.status = data.status;
    if (data.notes !== undefined) updates.notes = data.notes;
    const { error } = await supabase.from('operation_logistics').update(updates).eq('id', itemId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to update logistics item' });
}

export async function deleteLogisticsItem(itemId: number, operationId?: string) {
    if (!operationId) throw new Error('deleteLogisticsItem: operationId is required');
    const { error } = await supabase.from('operation_logistics').delete()
        .eq('id', itemId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to delete logistics item' });
}

// Largest single fulfilment increment accepted from a client. Defends the
// integer accumulator (quantity_fulfilled) against an absurd/overflowing value
// while staying well above any realistic logistics quantity.
const MAX_FULFILL_QUANTITY = 1_000_000;

export async function fulfillLogisticsItem(itemId: number, quantity: number, userId: number, operationId?: string) {
    // Scope by the (already verified) operation so a foreign itemId can't be
    // fulfilled by passing your own operationId past verifyOperationAccess.
    if (!operationId) throw new Error('fulfillLogisticsItem: operationId is required');
    // Clamp the increment to a non-negative bounded integer — a NaN/negative/
    // fractional/huge client value must not corrupt the fulfilment accumulator.
    const qty = Math.floor(Number(quantity));
    if (!Number.isFinite(qty) || qty < 0 || qty > MAX_FULFILL_QUANTITY) {
        throw new Error(`Fulfilment quantity must be between 0 and ${MAX_FULFILL_QUANTITY}.`);
    }
    const { data: item } = await supabase.from('operation_logistics').select('quantity_fulfilled, quantity_needed').eq('id', itemId).eq('operation_id', operationId).single();
    if (!item) throw new Error('Logistics item not found');
    const newFulfilled = (item.quantity_fulfilled || 0) + qty;
    const newStatus = newFulfilled >= item.quantity_needed ? 'Fulfilled' : newFulfilled > 0 ? 'Partial' : 'Needed';
    const { error } = await supabase.from('operation_logistics').update({
        quantity_fulfilled: newFulfilled,
        fulfilled_by_user_id: userId,
        status: newStatus,
    }).eq('id', itemId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to fulfill logistics item' });
}

// =============================================================================
// AAR CRUD
// =============================================================================

export async function addAAREntry(operationId: string, data: Record<string, unknown>) {
    const { data: result, error } = await supabase.from('operation_aar_entries').insert({
        operation_id: operationId,
        // Author is ALWAYS the dispatcher-injected actor (data.userId), never
        // data.authorId. The dispatcher's actor-field overwrite is top-level only
        // and does NOT recurse into payload.data, so honouring a nested `authorId`
        // would let an attacker forge AAR attribution to another user.
        author_id: data.userId,
        category: data.category || 'observation',
        content: data.content,
    }).select('id, operation_id, author_id, category, content, upvotes, created_at').single();
    handleSupabaseError({ error, message: 'Failed to add AAR entry' });
    return result;
}

export async function deleteAAREntry(entryId: number, operationId?: string) {
    if (!operationId) throw new Error('deleteAAREntry: operationId is required');
    const { error } = await supabase.from('operation_aar_entries').delete()
        .eq('id', entryId).eq('operation_id', operationId);
    handleSupabaseError({ error, message: 'Failed to delete AAR entry' });
}

const AAR_AI_COOLDOWN_MS = 3 * 60 * 60 * 1000;

export async function generateAARDraftForOperation(operationId: string) {
    const { generateAARSummary } = await import('../ai.js');

    const { data: op, error } = await supabase
        .from('operations')
        .select('id, name, type, status, description, scheduled_start, scheduled_end, aar_ai_generated_at, location:locations!operations_location_id_fkey(name)')
        .eq('id', operationId)
        
        .single();
    handleSupabaseError({ error, message: 'Failed to load operation for AAR draft' });
    if (!op) throw new Error('Operation not found');

    if (op.aar_ai_generated_at) {
        const last = new Date(op.aar_ai_generated_at).getTime();
        const elapsed = Date.now() - last;
        if (elapsed < AAR_AI_COOLDOWN_MS) {
            const retryAt = new Date(last + AAR_AI_COOLDOWN_MS).toISOString();
            const err = new Error('AAR_COOLDOWN_ACTIVE') as Error & { code?: string; retryAt?: string; cooldownMs?: number };
            err.code = 'AAR_COOLDOWN_ACTIVE';
            err.retryAt = retryAt;
            err.cooldownMs = AAR_AI_COOLDOWN_MS - elapsed;
            throw err;
        }
    }

    const [{ count: participantCount }, { data: entries }] = await Promise.all([
        supabase.from('operation_participants').select('user_id', { count: 'exact', head: true }).eq('operation_id', operationId),
        supabase.from('operation_aar_entries')
            .select('category, content, author:users!operation_aar_entries_author_id_fkey(name)')
            .eq('operation_id', operationId)
            .order('created_at'),
    ]);

    const draft = await generateAARSummary({
        name: op.name,
        type: op.type,
        status: op.status,
        description: op.description,
        scheduledStart: op.scheduled_start,
        scheduledEnd: op.scheduled_end,
        location: (op.location as { name?: string } | null)?.name,
        participantCount: participantCount || 0,
        entries: ((entries || []) as unknown as Array<{ category: string; content: string; author?: { name?: string } | null }>).map((e) => ({
            category: e.category,
            content: e.content,
            authorName: e.author?.name,
        })),
    });

    const generatedAt = new Date().toISOString();
    const { error: stampError } = await supabase
        .from('operations')
        .update({ aar_ai_generated_at: generatedAt })
        .eq('id', operationId)
        ;
    handleSupabaseError({ error: stampError, message: 'Failed to record AAR generation timestamp' });

    return { ...draft, aarAiGeneratedAt: generatedAt };
}

export async function submitAAR(operationId: string, userId: number, summary: string, lessonsLearned: string) {
    const { error } = await supabase.from('operations').update({
        // Strip HTML from AAR free-text fields at the save boundary.
        aar_summary: stripHtml(summary, 8000),
        aar_lessons_learned: stripHtml(lessonsLearned, 8000),
        aar_submitted_at: new Date().toISOString(),
        aar_submitted_by: userId,
    }).eq('id', operationId);
    handleSupabaseError({ error, message: 'Failed to submit AAR' });
}

// Clears submission stamps so the AAR can be edited again. Summary and
// lessons-learned are preserved — the user is amending their previous
// submission, not starting over. The action handler enforces who is allowed
// to call this (op owner or org admin).
export async function reopenAAR(operationId: string) {
    const { error } = await supabase.from('operations').update({
        aar_submitted_at: null,
        aar_submitted_by: null,
    }).eq('id', operationId);
    handleSupabaseError({ error, message: 'Failed to reopen AAR' });
}

// Returns just the owner_id for an operation — used for per-record permission
// checks on actions that don't have a role-level capability (e.g. AAR reopen).
export async function getOperationOwnerId(operationId: string): Promise<number | null> {
    const { data, error } = await supabase
        .from('operations')
        .select('owner_id')
        .eq('id', operationId)
        .single();
    handleSupabaseError({ error, message: 'Failed to fetch operation owner' });
    return data?.owner_id ?? null;
}