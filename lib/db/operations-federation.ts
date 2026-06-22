// =============================================================================
// lib/db/operations-federation.ts — Joint-operation federation (alliance P3)
// =============================================================================
// Host-authoritative mirror: the HOST instance owns the operation; invited allied
// instances get a read-only jsonb snapshot and sync their members' RSVPs back.
// Server-to-server only; reuses the P1/P2 alliance toolkit (callAlliancePeer,
// getAlliancePeerByInboundKey). The SNAPSHOT PROJECTION is the critical security
// surface — it is an explicit allow-list (never a spread of the operation) and is
// unit-tested in tests/operations-federation.projection.test.ts.

import { supabase, handleSupabaseError, safeFetch, broadcastToOrg } from './common.js';
import { getFullOperationDetails } from './ops.js';
import { callAlliancePeer } from './alliances.js';
import { getMaxShareableClearance } from './system.js';
import { sanitizeImageUrl } from '../imageUrl.js';
import { toMirroredOperation } from './mappers.js';
import {
    scheduleDebounced, cancelDebounced, tryConsumeToken,
    getCachedAllianceSyncConfig, recordPeerFailure, recordPeerSuccess,
} from './allianceSyncState.js';
import type { HydratedOperation, User, MirroredOperation, OperationPayoutMode } from '../../types.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'db.operations-federation' });
const nowIso = () => new Date().toISOString();

// Reconcile pulls per peer per cycle — catch-up after downtime is spread over
// successive 2-minute cycles instead of flooding the peer's rate limit.
const MAX_RECONCILE_PULLS_PER_CYCLE = 5;

// Cap allied participant rows per (op, peer). The PK includes the peer-controlled
// remote_user_handle, so without this an accepted ally could spam distinct handles
// to inflate operation_allied_participants and pollute host op-detail with ghosts.
const MAX_ALLIED_PARTICIPANTS_PER_PEER = 200;

// --- Display-only user projection: name + avatar, NO real id / email / perms. ---
function displayUser(u: Partial<User> | undefined, synthId: number): User {
    return { id: synthId, name: u?.name || 'Allied Member', avatarUrl: u?.avatarUrl } as User;
}

/**
 * PURE allow-list projection of a host operation into the snapshot shared with an
 * ally. Returns null if the op carries a sync_restricted marker (caller passes the
 * already-computed flag). NEVER spread `op` — every shared field is explicit, and
 * financial / payout / join_code / log / raw-id fields are neutralised, not copied.
 */
export function projectOperationSnapshot(op: HydratedOperation, hasRestrictedMarker: boolean, recipientPeerId?: string): HydratedOperation | null {
    if (hasRestrictedMarker) return null;
    return {
        id: op.id,
        name: op.name,
        type: op.type,
        status: op.status,
        description: op.description,
        isJoint: op.isJoint,
        isSpecial: op.isSpecial,
        isTraining: op.isTraining,
        clearanceLevel: op.clearanceLevel,
        maxParticipants: op.maxParticipants,
        createdAt: op.createdAt,
        updatedAt: op.updatedAt,
        scheduledStart: op.scheduledStart,
        scheduledEnd: op.scheduledEnd,
        activeStartTime: op.activeStartTime,
        activeEndTime: op.activeEndTime,
        roe: op.roe,
        commanderNotes: op.commanderNotes,
        commsPlan: op.commsPlan || [],
        liveStatus: op.liveStatus,
        locationText: op.locationText,
        additionalLocationTexts: op.additionalLocationTexts,
        location: op.location,
        additionalLocations: op.additionalLocations,
        limitingMarkers: op.limitingMarkers || [],

        // Owner + participants as display-only (no real ids / payout / ships FKs).
        ownerId: 0,
        owner: displayUser(op.owner, 0),
        participants: (op.participants || []).map((p, i) => ({
            userId: i + 1,
            user: displayUser(p.user, i + 1),
            timeJoined: p.timeJoined,
            isReady: p.isReady,
            roleRequested: p.roleRequested,
            shipUtilized: p.shipUtilized,
            rsvpStatus: p.rsvpStatus,
            liveStatus: p.liveStatus,
        })),

        // Structure — keep labels/positions/status; strip every user/unit assignment ref.
        phases: op.phases,
        scheduleEntries: op.scheduleEntries,
        tasks: (op.tasks || []).map((t) => ({ ...t, assignedUserId: undefined, assignedUnitId: undefined, assignedUser: undefined, assignedUnit: undefined })),
        commandNodes: (op.commandNodes || []).map((n) => ({ ...n, assignedUserId: undefined, assignedUnitId: undefined, assignedUser: undefined, assignedUnit: undefined, fleetGroupId: undefined, fleetGroup: undefined })),
        boardElements: op.boardElements,
        logistics: (op.logistics || []).map((l) => ({ ...l, fulfilledByUserId: undefined })),

        // Recipient-aware. Each peer sees only the HOST + its OWN allied
        // org/members — never another ally's roster — and the host's INTERNAL
        // alliance_peers UUID (peerId) is neutralised (mirrors the ownerId:0
        // pattern). When recipientPeerId is absent, peerId is still stripped but
        // no per-peer filter is applied.
        alliedOrgs: (op.alliedOrgs || [])
            .filter((o) => !recipientPeerId || o.peerId === recipientPeerId)
            .map((o) => ({ ...o, peerId: '' })),
        alliedParticipants: (op.alliedParticipants || [])
            .filter((p) => !recipientPeerId || p.peerId === recipientPeerId)
            .map((p) => ({ ...p, peerId: '' })),

        // Financials / internals: type requires the keys, so neutralise (never copy).
        tracksUec: false,
        totalUec: 0,
        totalCosts: 0,
        payoutMode: 'equal' as OperationPayoutMode,
        log: [],
        joinCode: undefined,
        aarSummary: undefined,
        aarLessonsLearned: undefined,
        aarSubmittedAt: undefined,
        aarSubmittedBy: undefined,
        discordEventId: undefined,
        discordAnnouncementChannelId: undefined,
        discordAnnouncementMessageId: undefined,
    } as HydratedOperation;
}

/** Apply an incoming snapshot only if its version is newer (idempotent / drops stale). */
export function shouldApplyVersion(incoming: number, stored: number | null | undefined): boolean {
    return typeof incoming === 'number' && incoming > (stored ?? -1);
}

// =============================================================================
// HOST side
// =============================================================================

/**
 * Is the joint-operations channel currently enabled for this peer? Re-checked at
 * EVERY operations serve path (snapshot / manifest / accept), not just at invite
 * time — so toggling "Joint Ops" off immediately stops serving op content for
 * already-invited ops. Fails closed: a missing/inactive peer or a non-true
 * channel flag → false.
 */
async function peerOperationsChannelEnabled(peerId: string): Promise<boolean> {
    const { data: peer } = await supabase.from('alliance_peers')
        .select('channels').eq('id', peerId).eq('status', 'Active').maybeSingle();
    return (peer?.channels as { operations?: boolean } | null)?.operations === true;
}

async function operationHasSyncRestrictedMarker(opId: string): Promise<boolean> {
    const { data } = await supabase
        .from('operation_limiting_markers')
        .select('marker:security_limiting_markers!inner(sync_restricted)')
        .eq('operation_id', opId);
    type MarkerEmbed = { sync_restricted?: boolean | null };
    const rows = (data ?? []) as unknown as Array<{ marker: MarkerEmbed | MarkerEmbed[] | null }>;
    return rows.some((r) => {
        const markers = Array.isArray(r.marker) ? r.marker : r.marker ? [r.marker] : [];
        return markers.some((m) => m?.sync_restricted === true);
    });
}

/** Build the projected snapshot for a host-owned operation (null if classified).
 *  Pass recipientPeerId so the snapshot is scoped to that ally. */
export async function buildOperationSnapshot(opId: string, recipientPeerId?: string): Promise<HydratedOperation | null> {
    const op = await getFullOperationDetails(opId);
    if (!op) return null;
    const restricted = await operationHasSyncRestrictedMarker(opId);
    if (restricted) return null;

    // Clearance ceiling at the federation egress. An operation must not be shared
    // above the LESSER of the org-wide shareable ceiling and this peer's
    // outbound_max_clearance — exactly as getAllianceShareableData bounds intel.
    // Without it a classified op (ROE / commander notes / comms-plan channel ids
    // / locations / member identity) would leak in full to an ally configured for
    // a lower clearance. Fail closed: an unknown peer resolves to ceiling 0.
    const opClearance = (op as HydratedOperation).clearanceLevel ?? 0;
    const globalMax = await getMaxShareableClearance();
    let peerMax = 0;
    if (recipientPeerId) {
        const { data: peer } = await supabase.from('alliance_peers')
            .select('outbound_max_clearance').eq('id', recipientPeerId).maybeSingle();
        peerMax = peer?.outbound_max_clearance ?? 0;
    }
    if (opClearance > Math.min(globalMax, peerMax)) return null;

    return projectOperationSnapshot(op as HydratedOperation, false, recipientPeerId);
}

/** Monotonic version bump — version-gates snapshots on the guest side. */
export async function bumpOperationVersion(opId: string): Promise<number> {
    const { data } = await supabase.from('operations').select('joint_version, is_joint').eq('id', opId).maybeSingle();
    if (!data?.is_joint) return data?.joint_version ?? 0;
    const next = (data.joint_version ?? 0) + 1;
    await supabase.from('operations').update({ joint_version: next, updated_at: nowIso() }).eq('id', opId);
    return next;
}

interface OpEnvelopeMeta { v: number; op_id: string; version: number }

async function opEnvelope(opId: string): Promise<OpEnvelopeMeta> {
    const { data } = await supabase.from('operations').select('joint_version').eq('id', opId).maybeSingle();
    return { v: 1, op_id: opId, version: data?.joint_version ?? 0 };
}

/** Host invites an Active peer (with channels.operations) to a joint op + notifies it. */
export async function inviteAllyToOperation(opId: string, peerId: string): Promise<void> {
    const { data: peer } = await supabase.from('alliance_peers').select('status, channels').eq('id', peerId).maybeSingle();
    if (!peer || peer.status !== 'Active' || (peer.channels as { operations?: boolean } | null)?.operations !== true) {
        throw new Error('Peer is not an active ally with joint operations enabled.');
    }
    // Defense-in-depth alongside the egress ceiling in buildOperationSnapshot:
    // refuse the invite outright when the op cannot be shared with this peer
    // (clearance ceiling exceeded, or a sync-restricted marker). buildOperationSnapshot
    // returns null in both cases; reuse it so we don't share or even invite.
    const summary = await buildOperationSnapshot(opId, peerId); // scope to this ally
    if (!summary) {
        throw new Error('This operation cannot be shared with this ally (clearance ceiling exceeded or sync-restricted).');
    }
    const { error } = await supabase.from('operation_allied_orgs')
        .upsert({ operation_id: opId, peer_id: peerId, accepted: false, invited_at: nowIso() }, { onConflict: 'operation_id,peer_id' });
    handleSupabaseError({ error, message: 'Failed to invite ally' });
    await bumpOperationVersion(opId);
    const env = await opEnvelope(opId);
    await callAlliancePeer(peerId, '/api/alliance/op-mirror/invite', { method: 'POST', body: { ...env, snapshot: summary } })
        .catch((e) => log.warn('invite push failed', { opId, peerId, err: e }));
    broadcastToOrg('operation_update', { operationId: opId });
}

/** Host uninvites a peer + tells it to drop the mirror. */
export async function revokeAllyFromOperation(opId: string, peerId: string): Promise<void> {
    await supabase.from('operation_allied_orgs').delete().eq('operation_id', opId).eq('peer_id', peerId);
    await supabase.from('operation_allied_participants').delete().eq('operation_id', opId).eq('peer_id', peerId);
    await callAlliancePeer(peerId, '/api/alliance/op-mirror/revoke', { method: 'POST', body: { v: 1, op_id: opId } })
        .catch((e) => log.warn('revoke push failed', { opId, peerId, err: e }));
    broadcastToOrg('operation_update', { operationId: opId });
}

/**
 * Re-check a peer's shared ops against its current clearance ceiling. Run after an
 * admin lowers the peer's allowed clearance: that change doesn't bump any op
 * version, so the peer would otherwise keep showing ops it's no longer cleared for
 * until they happen to change. Revoke any shared op that no longer fits under the
 * ceiling; leave the rest alone.
 */
export async function reconcilePeerClearanceShares(peerId: string): Promise<void> {
    const { data: shares } = await supabase.from('operation_allied_orgs')
        .select('operation_id').eq('peer_id', peerId);
    for (const row of (shares ?? []) as { operation_id: string }[]) {
        const snapshot = await buildOperationSnapshot(row.operation_id, peerId);
        if (snapshot === null) {
            await revokeAllyFromOperation(row.operation_id, peerId)
                .catch((e) => log.warn('clearance reconcile revoke failed', { opId: row.operation_id, peerId, err: e }));
        }
    }
}

/**
 * Push the current snapshot to every ACCEPTED ally (fire-and-forget).
 * Live-sync gating: pushes to a peer marked 'down' are DROPPED, not queued —
 * the guest's reconcile poll converges on recovery (versions make the drop
 * lossless). Each push costs one per-peer budget token; immediate events
 * (status_change / alert / cancel — critical + human-bounded) consume a token
 * when available but are never blocked, while a budget-starved debounced
 * 'full' push re-coalesces 10s later (the trailing snapshot always carries
 * the latest state, so deferring loses nothing).
 */
export async function pushOperationToAllies(opId: string, event: 'status_change' | 'alert' | 'cancel' | 'full'): Promise<void> {
    const immediate = event !== 'full';
    // An immediate push carries the full latest snapshot anyway — supersede
    // (and cancel) any pending coalesced push for this op.
    if (immediate) cancelDebounced(`oppush:${opId}`);
    const { data: allies } = await supabase.from('operation_allied_orgs').select('peer_id').eq('operation_id', opId).eq('accepted', true);
    if (!allies || allies.length === 0) return;
    const peerIds = (allies as { peer_id: string }[]).map((a) => a.peer_id);
    const { data: healthRows } = await supabase.from('alliance_peers')
        .select('id, sync_health, outbound_max_clearance').in('id', peerIds);
    type PeerHealthRow = { id: string; sync_health: string | null; outbound_max_clearance: number | null };
    const peerById = new Map(((healthRows ?? []) as PeerHealthRow[]).map((p) => [p.id, p]));
    const downPeers = new Set(((healthRows ?? []) as PeerHealthRow[])
        .filter((p) => p.sync_health === 'down').map((p) => p.id));
    const env = await opEnvelope(opId);
    // Fetch the op ONCE, then project a RECIPIENT-SCOPED snapshot per peer (each
    // ally sees only the host + its own members; no cross-peer PII / internal
    // peer ids). 'cancel' carries no snapshot.
    const fullOp = event === 'cancel' ? null : await getFullOperationDetails(opId);
    const restricted = fullOp ? await operationHasSyncRestrictedMarker(opId) : false;
    // Apply the per-peer clearance ceiling here too. The push runs on every op
    // change, so without this an op raised above a peer's allowed clearance (or a
    // peer whose ceiling was lowered) would send its full details to that peer.
    // Over the ceiling we send no snapshot — the same thing a poll returns, which
    // also clears any copy the peer already held. A missing peer/ceiling counts as 0.
    const opClearance = fullOp ? ((fullOp as HydratedOperation).clearanceLevel ?? 0) : 0;
    const globalMax = fullOp ? await getMaxShareableClearance() : 0;
    let budgetDeferred = false;
    await Promise.all(peerIds.map((peerId) => {
        if (downPeers.has(peerId)) return Promise.resolve();
        if (!tryConsumeToken(peerId, { force: immediate })) { budgetDeferred = true; return Promise.resolve(); }
        const peerMax = peerById.get(peerId)?.outbound_max_clearance ?? 0;
        const overCeiling = !!fullOp && opClearance > Math.min(globalMax, peerMax);
        const snapshot = (fullOp && !overCeiling) ? projectOperationSnapshot(fullOp as HydratedOperation, restricted, peerId) : null;
        return callAlliancePeer(peerId, '/api/alliance/op-mirror/push', { method: 'POST', body: { ...env, event, snapshot } })
            .then((res) => { if (res) void recordPeerSuccess(peerId).catch(() => undefined); })
            .catch((e) => {
                log.warn('op push failed', { opId, peerId, event, err: e });
                void recordPeerFailure(peerId).catch(() => undefined);
            });
    }));
    if (budgetDeferred && event === 'full') scheduleAlliedPush(opId, 10_000);
}

/**
 * Debounced full-snapshot push — the live-sync hook called by
 * broadcastOperationUpdate (lib/db/ops.ts) on EVERY op mutation. N rapid edits
 * within the trailing window coalesce into ONE push of the latest projected
 * snapshot. No-op for ops without accepted allies (pushOperationToAllies
 * short-circuits on one indexed query). The flush deletes its own debounce
 * entry (scheduleDebounced contract), so the map can't leak deleted ops.
 */
export function scheduleAlliedPush(opId: string, delayMs?: number): void {
    scheduleDebounced(`oppush:${opId}`, delayMs ?? getCachedAllianceSyncConfig().pushDebounceMs,
        () => pushOperationToAllies(opId, 'full'));
}

/** Inbound (guest polls): serve the snapshot to a verified, INVITED ally.
 *  The gate is invite-row-exists (not accepted): an invite IS the host's
 *  deliberate share decision — the invite push already delivers this exact
 *  snapshot to the un-accepted peer (receiveMirrorInvite stores it), and
 *  acceptInviteForPeer returns it on a bare invite row. Matching that posture
 *  here lets the reconcile loop self-heal MISSED invites. Non-invited peers
 *  stay forbidden (pinned by test); the snapshot projection itself never
 *  branches on acceptance, so nothing extra crosses the wire pre-accept. */
export async function getOperationSnapshotForPeer(opId: string, peerId: string, sinceVersion?: number): Promise<{ unchanged: true } | { v: number; op_id: string; version: number; snapshot: HydratedOperation | null }> {
    const { data: ally } = await supabase.from('operation_allied_orgs').select('accepted').eq('operation_id', opId).eq('peer_id', peerId).maybeSingle();
    if (!ally) throw new Error('forbidden');
    // Re-check the peer's channels.operations at serve time — an invite row alone
    // is NOT enough. Disabling "Joint Ops" for a peer must immediately stop
    // serving op content even for already-invited ops.
    if (!(await peerOperationsChannelEnabled(peerId))) throw new Error('forbidden');
    const env = await opEnvelope(opId);
    if (sinceVersion !== undefined && env.version <= sinceVersion) return { unchanged: true };
    const snapshot = await buildOperationSnapshot(opId, peerId); // scope to the requesting ally
    return { ...env, snapshot };
}

/**
 * Inbound (guest reconciles): the live-sync manifest — every op this peer was
 * invited to, with the host's current joint_version for accepted ones, in ONE
 * call (replaces N per-op polls; doubles as the health probe).
 *
 * Built EXCLUSIVELY from the calling peer's own operation_allied_orgs rows — no
 * other peer's invites, no existence disclosure beyond what the peer's own
 * invites already told it. sync_restricted ops appear as id+version only, exactly
 * the poll envelope they already receive (the snapshot itself stays null).
 */
export interface OperationManifest { v: 1; fetchedAt: string; accepted: Record<string, number>; invited: string[] }
export async function getOperationManifestForPeer(peerId: string): Promise<OperationManifest> {
    const fetchedAt = nowIso();
    // If the peer's operations channel is disabled, serve an EMPTY manifest —
    // never disclose op ids/versions for already-invited ops. Returning empty
    // (rather than throwing) keeps the guest's reconcile loop working: an empty
    // manifest is treated as "no information / mass shrink", never a mass
    // false-revoke.
    if (!(await peerOperationsChannelEnabled(peerId))) return { v: 1, fetchedAt, accepted: {}, invited: [] };
    const { data } = await supabase.from('operation_allied_orgs')
        .select('operation_id, accepted, operation:operations!inner(joint_version)')
        .eq('peer_id', peerId);
    type ManifestRow = { operation_id: string; accepted: boolean; operation: { joint_version: number | null } | { joint_version: number | null }[] | null };
    const accepted: Record<string, number> = {};
    const invited: string[] = [];
    for (const row of (data ?? []) as ManifestRow[]) {
        const op = Array.isArray(row.operation) ? row.operation[0] : row.operation;
        if (!op) continue; // op deleted mid-query — absent, like its cascade-deleted invite row
        if (row.accepted) accepted[row.operation_id] = op.joint_version ?? 0;
        else invited.push(row.operation_id);
    }
    return { v: 1, fetchedAt, accepted, invited };
}

/** Inbound (guest admin accepts): mark the ally accepted, return the first snapshot. */
export async function acceptInviteForPeer(opId: string, peerId: string): Promise<{ v: number; op_id: string; version: number; snapshot: HydratedOperation | null }> {
    // An Active peer must not be able to "accept" an op it was never invited to
    // and walk away with a snapshot — require the invite row to exist before
    // updating/returning.
    const { data: invite } = await supabase.from('operation_allied_orgs')
        .select('peer_id').eq('operation_id', opId).eq('peer_id', peerId).maybeSingle();
    if (!invite) throw new Error('forbidden');
    // Re-check the operations channel here too — the accept response is one of the
    // snapshot egress paths; a peer whose Joint Ops was disabled must not accept +
    // walk away with a fresh snapshot.
    if (!(await peerOperationsChannelEnabled(peerId))) throw new Error('forbidden');
    const { error } = await supabase.from('operation_allied_orgs')
        .update({ accepted: true, accepted_at: nowIso() }).eq('operation_id', opId).eq('peer_id', peerId);
    handleSupabaseError({ error, message: 'Failed to accept invite' });
    broadcastToOrg('operation_update', { operationId: opId });
    const env = await opEnvelope(opId);
    // Scope the returned snapshot to the accepting peer — the accept response is a
    // snapshot egress (alongside invite/poll/push) and must not relay another
    // ally's member roster to this peer.
    return { ...env, snapshot: await buildOperationSnapshot(opId, peerId) };
}

export async function declineInviteForPeer(opId: string, peerId: string): Promise<void> {
    await supabase.from('operation_allied_orgs').delete().eq('operation_id', opId).eq('peer_id', peerId);
    broadcastToOrg('operation_update', { operationId: opId });
}

/** Inbound (guest RSVP push): upsert an allied member's participation snapshot. */
export interface AlliedRsvpInput { remoteUserHandle: string; displayName?: string; avatarUrl?: string; role?: string; shipText?: string; rsvpStatus: string; isReady?: boolean }
export async function upsertAlliedParticipant(opId: string, peerId: string, p: AlliedRsvpInput): Promise<void> {
    const { data: ally } = await supabase.from('operation_allied_orgs').select('accepted').eq('operation_id', opId).eq('peer_id', peerId).maybeSingle();
    if (!ally?.accepted) throw new Error('forbidden');
    const handle = String(p.remoteUserHandle || '').slice(0, 120);
    if (!handle) throw new Error('malformed_request');
    // Bound how many participants a single peer can register for one op. A new
    // handle past the cap is refused; an existing handle still updates (it's an
    // upsert, not growth).
    const { count } = await supabase.from('operation_allied_participants')
        .select('id', { count: 'exact', head: true }).eq('operation_id', opId).eq('peer_id', peerId);
    if ((count || 0) >= MAX_ALLIED_PARTICIPANTS_PER_PEER) {
        const { data: existingRow } = await supabase.from('operation_allied_participants')
            .select('remote_user_handle').eq('operation_id', opId).eq('peer_id', peerId).eq('remote_user_handle', handle).maybeSingle();
        if (!existingRow) throw new Error('participant_limit_reached');
    }
    // Peer-supplied participant fields are stored AND re-rendered in the host's op
    // detail (and re-forwarded in the snapshot). Clamp the avatar to a safe https
    // image URL (reject javascript:/data:/http: → null) and length-cap the free
    // text.
    const cap = (v: unknown, n: number) => (typeof v === 'string' && v ? v.slice(0, n) : null);
    const { error } = await supabase.from('operation_allied_participants').upsert({
        operation_id: opId, peer_id: peerId, remote_user_handle: handle,
        display_name: cap(p.displayName, 120), avatar_url: sanitizeImageUrl(p.avatarUrl) ?? null,
        role: cap(p.role, 120), ship_text: cap(p.shipText, 200),
        rsvp_status: cap(p.rsvpStatus, 40) || 'Pending', is_ready: !!p.isReady, updated_at: nowIso(),
    }, { onConflict: 'operation_id,peer_id,remote_user_handle' });
    handleSupabaseError({ error, message: 'Failed to record allied RSVP' });
    await bumpOperationVersion(opId);
    broadcastToOrg('operation_update', { operationId: opId });
}

/**
 * Inbound (guest RSVP withdrawal): delete an allied member's participation row.
 * The DELETE is scoped EXACTLY like the upsert key — (operation_id, peer_id,
 * remote_user_handle) behind the same accepted-ally gate — so a peer can only
 * ever delete its OWN participant rows. Kills ghost-RSVP accumulation.
 */
export async function removeAlliedParticipant(opId: string, peerId: string, remoteUserHandle: string): Promise<void> {
    const { data: ally } = await supabase.from('operation_allied_orgs').select('accepted').eq('operation_id', opId).eq('peer_id', peerId).maybeSingle();
    if (!ally?.accepted) throw new Error('forbidden');
    const handle = String(remoteUserHandle || '').slice(0, 120);
    if (!handle) throw new Error('malformed_request');
    const { error } = await supabase.from('operation_allied_participants').delete()
        .eq('operation_id', opId).eq('peer_id', peerId).eq('remote_user_handle', handle);
    handleSupabaseError({ error, message: 'Failed to remove allied RSVP' });
    await bumpOperationVersion(opId);
    broadcastToOrg('operation_update', { operationId: opId });
}

// =============================================================================
// GUEST side
// =============================================================================

interface MirrorPayload { v: number; op_id: string; version: number; event?: string; snapshot: HydratedOperation | null }

// A projected op snapshot is tens of KB even with a big command board; this
// caps the attacker-controlled inbound jsonb we'll persist so a paired-but-
// hostile host can't park multi-MB blobs in our mirrored_operations table
// (storage amplification + heavy admin-browser loads). Well under express's
// 10mb body limit; a snapshot beyond it is treated as malformed → dropped.
const MAX_INBOUND_SNAPSHOT_BYTES = 1_000_000;
function boundedInboundSnapshot(snapshot: HydratedOperation | null | undefined): HydratedOperation | null {
    if (snapshot == null) return null;
    if (JSON.stringify(snapshot).length > MAX_INBOUND_SNAPSHOT_BYTES) throw new Error('malformed_request');
    return snapshot;
}

/** Inbound (host invites us): store a pending mirror, visible only to admins. */
export async function receiveMirrorInvite(peer: { id: string }, body: MirrorPayload): Promise<void> {
    if (!body?.op_id || typeof body.op_id !== 'string') throw new Error('malformed_request');
    // Only accept op mirrors from a peer the local org has actually enabled the
    // operations channel for. The op id alone doesn't prove the sender hosts it, so
    // without this any active paired peer could claim to host an op id it learned of
    // and squat the mirror — denying the real host and redirecting members' RSVP
    // details to the attacker. This is the opt-in mirror of the host-side serve gate.
    if (!(await peerOperationsChannelEnabled(peer.id))) return;
    // Refuse to clobber a mirror hosted by a DIFFERENT peer. Otherwise any Active
    // peer could upsert over a victim-hosted mirror (id is the host's
    // operation_id, known to co-allies) — redirecting the guest's RSVP pushes
    // (member PII) to the attacker, spoofing op content, and resetting
    // accepted=false. Mirrors the host_peer_id guard on push/revoke.
    const { data: existing } = await supabase.from('mirrored_operations').select('host_peer_id').eq('id', body.op_id).maybeSingle();
    if (existing && existing.host_peer_id !== peer.id) return;           // not ours — refuse
    const snapshot = boundedInboundSnapshot(body.snapshot);
    const { error } = await supabase.from('mirrored_operations').upsert({
        id: body.op_id, host_peer_id: peer.id,
        snapshot, version: body.version ?? 0, snapshot_updated_at: nowIso(),
        accepted: false, invited_at: nowIso(), revoked_at: null,
    }, { onConflict: 'id' });
    handleSupabaseError({ error, message: 'Failed to receive invite' });
    broadcastToOrg('operation_update', { operationId: body.op_id });
}

/** Inbound (host pushes): version-gated snapshot replacement. */
export async function receiveMirrorPush(peer: { id: string }, body: MirrorPayload): Promise<void> {
    if (!(await peerOperationsChannelEnabled(peer.id))) return;          // ops channel must be enabled for this peer
    const { data: existing } = await supabase.from('mirrored_operations').select('version, host_peer_id').eq('id', body.op_id).maybeSingle();
    if (!existing || existing.host_peer_id !== peer.id) return;          // not ours / unknown
    if (body.event === 'cancel') {
        await supabase.from('mirrored_operations').update({ revoked_at: nowIso(), snapshot_updated_at: nowIso() }).eq('id', body.op_id);
        broadcastToOrg('operation_update', { operationId: body.op_id });
        return;
    }
    if (!shouldApplyVersion(body.version, existing.version)) return;     // stale / duplicate
    const snapshot = boundedInboundSnapshot(body.snapshot);
    await supabase.from('mirrored_operations').update({
        snapshot, version: body.version, snapshot_updated_at: nowIso(),
    }).eq('id', body.op_id);
    broadcastToOrg('operation_update', { operationId: body.op_id });
}

export async function receiveMirrorRevoke(peer: { id: string }, opId: string): Promise<void> {
    if (!(await peerOperationsChannelEnabled(peer.id))) return;          // ops channel must be enabled for this peer
    await supabase.from('mirrored_operations').update({ revoked_at: nowIso() }).eq('id', opId).eq('host_peer_id', peer.id);
    broadcastToOrg('operation_update', { operationId: opId });
}

/** Guest: list mirrored ops. Pending (unaccepted) only surface to admins. */
export async function listMirroredOperations(includePending: boolean): Promise<MirroredOperation[]> {
    let query = supabase.from('mirrored_operations')
        .select('*, peer:alliance_peers(peer_org_name, peer_icon_url, label)')
        .is('revoked_at', null).order('invited_at', { ascending: false });
    if (!includePending) query = query.eq('accepted', true);
    const rows = await safeFetch<Parameters<typeof toMirroredOperation>[0][]>(query, [], 'Failed to list mirrored operations');
    return rows.map(toMirroredOperation);
}

export async function getMirroredOperation(id: string): Promise<MirroredOperation | null> {
    const { data } = await supabase.from('mirrored_operations')
        .select('*, peer:alliance_peers(peer_org_name, peer_icon_url, label)').eq('id', id).is('revoked_at', null).maybeSingle();
    if (!data) return null;
    const mirror = toMirroredOperation(data as Parameters<typeof toMirroredOperation>[0]);
    const { data: parts } = await supabase.from('mirrored_operation_participation')
        .select('*, user:users!mirrored_operation_participation_user_id_fkey(id, name, avatar_url, role_id)').eq('mirror_op_id', id);
    mirror.myParticipation = (parts || []).map((r: { mirror_op_id: string; user_id: number; rsvp_status: string; ship_text: string | null; is_ready: boolean; updated_at: string; user?: { id: number; name: string; avatar_url?: string } | null }) => ({
        mirrorOpId: r.mirror_op_id, userId: r.user_id, rsvpStatus: r.rsvp_status,
        shipText: r.ship_text, isReady: r.is_ready, updatedAt: r.updated_at,
        user: r.user ? ({ id: r.user.id, name: r.user.name, avatarUrl: r.user.avatar_url } as User) : undefined,
    }));
    return mirror;
}

/** Guest admin accepts: confirm with the host, store the first full snapshot. */
export async function acceptMirroredOperation(id: string): Promise<void> {
    const { data: mirror } = await supabase.from('mirrored_operations').select('host_peer_id').eq('id', id).maybeSingle();
    if (!mirror) throw new Error('Mirror not found.');
    const res = await callAlliancePeer(mirror.host_peer_id, `/api/alliance/op/${id}/accept`, { method: 'POST', body: { v: 1, op_id: id } });
    if (!res || !res.ok) throw new Error('Host did not confirm the invite.');
    const payload = await res.json() as MirrorPayload;
    // The guest-INITIATED pull paths must apply the same inbound size cap as the
    // host-pushed paths — a paired-but-hostile host could otherwise park a
    // multi-MB blob in our mirrored_operations table via accept/poll/reconcile.
    const snapshot = boundedInboundSnapshot(payload.snapshot);
    const { error } = await supabase.from('mirrored_operations').update({
        accepted: true, accepted_at: nowIso(),
        snapshot, version: payload.version ?? 0, snapshot_updated_at: nowIso(),
    }).eq('id', id);
    handleSupabaseError({ error, message: 'Failed to accept operation' });
    broadcastToOrg('operation_update', { operationId: id });
}

export async function declineMirroredOperation(id: string): Promise<void> {
    const { data: mirror } = await supabase.from('mirrored_operations').select('host_peer_id').eq('id', id).maybeSingle();
    if (mirror) await callAlliancePeer(mirror.host_peer_id, `/api/alliance/op/${id}/decline`, { method: 'POST', body: { v: 1, op_id: id } }).catch(() => undefined);
    await supabase.from('mirrored_operations').delete().eq('id', id);
    broadcastToOrg('operation_update', { operationId: id });
}

/** Guest poll: pull the latest snapshot from the host if newer. */
export async function pollMirroredOperation(id: string): Promise<void> {
    const { data: mirror } = await supabase.from('mirrored_operations').select('host_peer_id, version').eq('id', id).eq('accepted', true).is('revoked_at', null).maybeSingle();
    if (!mirror) return;
    // Budget gate: a view-mount poll past the per-peer budget serves the
    // current mirror instead — pushes + the reconcile loop keep it fresh now,
    // so a skipped on-mount poll is cosmetic, never a correctness loss.
    if (!tryConsumeToken(mirror.host_peer_id)) return;
    const res = await callAlliancePeer(mirror.host_peer_id, `/api/alliance/op/${id}?since=${mirror.version}`);
    if (!res || !res.ok) return;
    const payload = await res.json() as MirrorPayload | { unchanged: true };
    await supabase.from('mirrored_operations').update({ last_polled_at: nowIso() }).eq('id', id);
    if ('unchanged' in payload) return;
    if (!shouldApplyVersion(payload.version, mirror.version)) return;
    // Cap the host-controlled snapshot on this guest-pull path.
    const snapshot = boundedInboundSnapshot(payload.snapshot);
    await supabase.from('mirrored_operations').update({
        snapshot, version: payload.version, snapshot_updated_at: nowIso(),
    }).eq('id', id);
    broadcastToOrg('operation_update', { operationId: id });
}

/** Guest member RSVPs to a mirrored op: store locally + push to the host immediately. */
export async function rsvpMirroredOperation(id: string, userId: number, rsvpStatus: string, shipText?: string, isReady?: boolean): Promise<void> {
    const { data: mirror } = await supabase.from('mirrored_operations').select('host_peer_id, accepted').eq('id', id).maybeSingle();
    if (!mirror?.accepted) throw new Error('This operation is not active.');
    const { error } = await supabase.from('mirrored_operation_participation').upsert({
        mirror_op_id: id, user_id: userId, rsvp_status: rsvpStatus, ship_text: shipText ?? null, is_ready: !!isReady, updated_at: nowIso(),
    }, { onConflict: 'mirror_op_id,user_id' });
    handleSupabaseError({ error, message: 'Failed to RSVP' });
    const { data: u } = await supabase.from('users').select('name, rsi_handle, avatar_url').eq('id', userId).maybeSingle();
    const handle = (u?.rsi_handle as string) || (u?.name as string) || `user-${userId}`;
    await callAlliancePeer(mirror.host_peer_id, `/api/alliance/op/${id}/rsvp`, {
        method: 'POST',
        body: { v: 1, op_id: id, remoteUserHandle: handle, displayName: u?.name, avatarUrl: u?.avatar_url, shipText, rsvpStatus, isReady: !!isReady },
    }).catch((e) => log.warn('rsvp push failed', { id, userId, err: e }));
    broadcastToOrg('operation_update', { operationId: id });
}

/** Guest member withdraws an RSVP: delete locally + push the removal to the
 *  host (removed:true on the same endpoint) so the host's allied-participant
 *  row doesn't linger as a ghost. Handle derivation mirrors the RSVP push. */
export async function removeMirroredRsvp(id: string, userId: number): Promise<void> {
    const { data: mirror } = await supabase.from('mirrored_operations').select('host_peer_id, accepted').eq('id', id).maybeSingle();
    if (!mirror?.accepted) throw new Error('This operation is not active.');
    await supabase.from('mirrored_operation_participation').delete().eq('mirror_op_id', id).eq('user_id', userId);
    const { data: u } = await supabase.from('users').select('name, rsi_handle').eq('id', userId).maybeSingle();
    const handle = (u?.rsi_handle as string) || (u?.name as string) || `user-${userId}`;
    await callAlliancePeer(mirror.host_peer_id, `/api/alliance/op/${id}/rsvp`, {
        method: 'POST',
        body: { v: 1, op_id: id, remoteUserHandle: handle, removed: true },
    }).catch((e) => log.warn('rsvp removal push failed', { id, userId, err: e }));
    broadcastToOrg('operation_update', { operationId: id });
}

/**
 * Re-push every local member's current RSVP for a peer's accepted mirrors —
 * recovery step after the peer comes back from 'down' (RSVP pushes made while
 * the host was unreachable were fire-and-forget and lost). Budget-gated; if
 * the bucket drains mid-way the remainder waits for the next recovery pass.
 */
export async function pushLocalRsvpsForPeer(peerId: string): Promise<void> {
    const { data: mirrors } = await supabase.from('mirrored_operations')
        .select('id').eq('host_peer_id', peerId).eq('accepted', true).is('revoked_at', null);
    if (!mirrors || mirrors.length === 0) return;
    const { data: parts } = await supabase.from('mirrored_operation_participation')
        .select('mirror_op_id, rsvp_status, ship_text, is_ready, user:users!mirrored_operation_participation_user_id_fkey(name, rsi_handle, avatar_url)')
        .in('mirror_op_id', (mirrors as { id: string }[]).map((m) => m.id));
    type PartRow = { mirror_op_id: string; rsvp_status: string; ship_text: string | null; is_ready: boolean; user: { name: string; rsi_handle: string | null; avatar_url: string | null } | { name: string; rsi_handle: string | null; avatar_url: string | null }[] | null };
    for (const p of (parts ?? []) as PartRow[]) {
        const u = Array.isArray(p.user) ? p.user[0] : p.user;
        const handle = u?.rsi_handle || u?.name;
        if (!handle) continue;
        if (!tryConsumeToken(peerId)) {
            log.info('rsvp recovery re-push deferred (budget)', { peerId });
            return;
        }
        await callAlliancePeer(peerId, `/api/alliance/op/${p.mirror_op_id}/rsvp`, {
            method: 'POST',
            body: {
                v: 1, op_id: p.mirror_op_id, remoteUserHandle: handle, displayName: u?.name,
                avatarUrl: u?.avatar_url, shipText: p.ship_text ?? undefined,
                rsvpStatus: p.rsvp_status, isReady: !!p.is_ready,
            },
        }).catch((e) => log.warn('rsvp recovery re-push failed', { peerId, opId: p.mirror_op_id, err: e }));
    }
}

// =============================================================================
// GUEST side — reconciliation (the live-sync anti-entropy loop)
// =============================================================================
// Pushes are the latency optimization; THIS loop is the correctness mechanism.
// One manifest call per peer per cycle converges everything pushes can miss:
// missed invites/accepts, stale mirrors, host version regressions (backup
// restores), and revoked/deleted ops — with a false-revoke guard so a
// transient host hiccup can never mass-revoke mirrors.

// In-process absence streaks (`${peerId}:${opId}` → consecutive well-formed
// manifests missing the op). Reset on restart — worst case a revoke waits one
// extra cycle; never incorrect.
const mirrorMissingStreaks = new Map<string, number>();
// Per-peer streak of anomalous (mass-shrink) manifests.
const massShrinkStreaks = new Map<string, number>();

/** TEST ONLY: reset reconcile streak state. */
export function __resetReconcileStateForTests(): void {
    mirrorMissingStreaks.clear();
    massShrinkStreaks.clear();
}

export interface MirrorReconcileResult {
    /** A well-formed manifest was received and processed. */
    ok: boolean;
    /** The peer answered (even if not ok) — transport is alive. */
    peerUp: boolean;
    pulled: number;
    revoked: number;
    /** Pulls deferred to the next cycle (per-cycle cap / budget). */
    deferred: number;
    /** Operator-visible anomaly raised this pass (regression heal, mass shrink). */
    alert?: string;
}

const NO_INFO: Omit<MirrorReconcileResult, 'peerUp'> = { ok: false, pulled: 0, revoked: 0, deferred: 0 };

/**
 * Reconcile our mirrors of a host peer against its manifest.
 * Throws on transport failure (caller feeds the health state machine).
 */
export async function reconcileMirrorsWithPeer(peerId: string): Promise<MirrorReconcileResult> {
    // Same opt-in as the push ingest: only sync op mirrors with a peer the local org
    // has enabled the operations channel for, so a peer we don't run joint ops with
    // can't seed a squatted mirror via the manifest-pull path either.
    if (!(await peerOperationsChannelEnabled(peerId))) return { ...NO_INFO, peerUp: false };
    const res = await callAlliancePeer(peerId, '/api/alliance/op-manifest');
    if (!res) return { ...NO_INFO, peerUp: false };            // peer not Active locally — config, not health
    if (!res.ok) {
        log.warn('op-manifest fetch rejected', { peerId, status: res.status });
        return { ...NO_INFO, peerUp: true };                    // peer is up; "no information", never revoke
    }
    let manifest: OperationManifest | null = null;
    try { manifest = await res.json() as OperationManifest; } catch { manifest = null; }
    if (!manifest || manifest.v !== 1 || typeof manifest.accepted !== 'object' || manifest.accepted === null || !Array.isArray(manifest.invited)) {
        log.warn('op-manifest malformed', { peerId });
        return { ...NO_INFO, peerUp: true };                    // malformed = no information
    }

    const { data: mirrorRows } = await supabase.from('mirrored_operations')
        .select('id, version, accepted, revoked_at').eq('host_peer_id', peerId);
    type MirrorRow = { id: string; version: number; accepted: boolean; revoked_at: string | null };
    const mirrors = (mirrorRows ?? []) as MirrorRow[];
    const byId = new Map(mirrors.map((m) => [m.id, m]));

    // ---- plan pulls ---------------------------------------------------------
    type PullKind = 'stale' | 'regression' | 'missing-accepted' | 'missing-invite' | 'resurrect' | 'reinvite';
    const pulls: Array<{ opId: string; kind: PullKind; local: MirrorRow | null }> = [];
    for (const [opId, version] of Object.entries(manifest.accepted)) {
        if (typeof version !== 'number' || !Number.isFinite(version)) continue;
        const local = byId.get(opId) ?? null;
        if (!local) pulls.push({ opId, kind: 'missing-accepted', local });            // missed invite+accept
        // The host lists this op as accepted (its accepted flag is only ever set
        // by OUR /accept call) — so it is authoritative for "alive + accepted".
        else if (local.revoked_at) pulls.push({ opId, kind: 'resurrect', local });    // heal a spurious local revoke (any version)
        else if (!local.accepted) pulls.push({ opId, kind: 'missing-accepted', local }); // heal a lost accept-ack (host latched accepted, we didn't)
        else if (version > local.version) pulls.push({ opId, kind: 'stale', local });
        else if (version < local.version) pulls.push({ opId, kind: 'regression', local }); // host rolled back (backup restore)
    }
    for (const opId of manifest.invited) {
        if (typeof opId !== 'string' || !opId) continue;
        const local = byId.get(opId) ?? null;
        if (!local) pulls.push({ opId, kind: 'missing-invite', local });               // missed invite push
        else if (local.revoked_at) pulls.push({ opId, kind: 'reinvite', local });      // missed RE-invite after revoke
    }

    // ---- execute pulls (per-cycle cap + per-peer budget) --------------------
    let pulled = 0;
    let deferred = 0;
    let alert: string | undefined;
    for (const p of pulls) {
        if (pulled >= MAX_RECONCILE_PULLS_PER_CYCLE || !tryConsumeToken(peerId)) {
            deferred = pulls.length - pulled;
            break;
        }
        const outcome = await pullMirrorFromHost(peerId, p.opId, p.kind, p.local).catch((e) => {
            log.warn('reconcile pull failed', { peerId, opId: p.opId, kind: p.kind, err: e });
            return null;
        });
        if (outcome === 'applied') pulled++;
        if (outcome === 'regression-healed') {
            pulled++;
            alert = 'Peer reported older operation versions — it may have been restored from a backup. Mirrors were reset to its current state.';
            log.warn('mirror version regression healed', { peerId, opId: p.opId });
        }
    }

    // ---- revokes: manifest-absence with the false-revoke guard --------------
    // A live (non-revoked) mirror absent from BOTH manifest sections means the
    // host deleted the op or withdrew the invite — but only after TWO
    // consecutive well-formed manifests say so, and never in a mass-shrink
    // anomaly (host mid-recovery serving a half-empty list).
    const present = new Set<string>([...Object.keys(manifest.accepted), ...manifest.invited]);
    const liveLocal = mirrors.filter((m) => !m.revoked_at);
    const absent = liveLocal.filter((m) => !present.has(m.id));
    let revoked = 0;

    // A single-mirror peer is included (>= 1): if its one mirror vanishes, that
    // is a 100% shrink and must get the same anomaly hold as a multi-mirror
    // mass shrink — otherwise a 1-mirror peer would have no protection beyond
    // the 2-cycle streak, and a transient host hiccup could flicker the lone
    // mirror revoked→restored. Revoke-by-absence is only the slow backstop
    // (explicit cancel/revoke push is primary), so erring conservative is right.
    const isMassShrink = liveLocal.length >= 1 && absent.length > liveLocal.length / 2;
    if (isMassShrink) {
        const streak = (massShrinkStreaks.get(peerId) ?? 0) + 1;
        massShrinkStreaks.set(peerId, streak);
        if (streak < 3) {
            // Anomaly: hold ALL revokes (don't even advance per-op streaks).
            alert = alert ?? `Peer manifest dropped ${absent.length} of ${liveLocal.length} mirrored operations — holding revokes (anomaly guard).`;
            log.warn('op-manifest mass shrink — revokes held', { peerId, absent: absent.length, live: liveLocal.length, streak });
            return { ok: true, peerUp: true, pulled, revoked: 0, deferred, alert };
        }
        // The shrink persisted across 3+ manifests — it's real; fall through
        // to normal streak processing (each op still needs its own 2 passes).
    } else {
        massShrinkStreaks.delete(peerId);
    }

    for (const m of liveLocal) {
        const key = `${peerId}:${m.id}`;
        if (!present.has(m.id)) {
            const streak = (mirrorMissingStreaks.get(key) ?? 0) + 1;
            if (streak >= 2) {
                await supabase.from('mirrored_operations').update({ revoked_at: nowIso() })
                    .eq('id', m.id).eq('host_peer_id', peerId);
                broadcastToOrg('operation_update', { operationId: m.id });
                mirrorMissingStreaks.delete(key);
                revoked++;
            } else {
                mirrorMissingStreaks.set(key, streak);
            }
        } else {
            mirrorMissingStreaks.delete(key);
        }
    }

    return { ok: true, peerUp: true, pulled, revoked, deferred, alert };
}

/** Fetch one op snapshot from the host and apply it per the reconcile kind. */
async function pullMirrorFromHost(
    peerId: string, opId: string,
    kind: 'stale' | 'regression' | 'missing-accepted' | 'missing-invite' | 'resurrect' | 'reinvite',
    local: { version: number; revoked_at: string | null } | null,
): Promise<'applied' | 'regression-healed' | 'skipped'> {
    // 'stale' can use the delta form; every other kind needs the full snapshot
    // (regression MUST bypass ?since= — the host's version is LOWER, so since
    // would answer {unchanged} and the deadlock would persist).
    const useSince = kind === 'stale' && local !== null;
    const res = await callAlliancePeer(peerId, `/api/alliance/op/${opId}${useSince ? `?since=${local.version}` : ''}`);
    if (!res || !res.ok) return 'skipped';
    const payload = await res.json() as MirrorPayload | { unchanged: true };
    if ('unchanged' in payload) return 'skipped';
    if (typeof payload.version !== 'number' || payload.op_id !== opId) return 'skipped';
    // Every reconcile-pull branch persists this host-controlled snapshot — cap it
    // here (one call covers all branches) so a hostile host can't park a multi-MB
    // blob in our mirrored_operations table via the unattended reconcile cron.
    const snapshot = boundedInboundSnapshot(payload.snapshot);

    if (kind === 'missing-accepted' || kind === 'missing-invite') {
        // Ownership guard — mirrors receiveMirrorInvite/receiveMirrorPush. This is
        // the ONLY reconcile branch that writes via the id-only PK upsert (every
        // other branch scopes its UPDATE with .eq('host_peer_id', peerId)). Without
        // this check a co-ally serving a forged manifest listing another trusted
        // host's opId would clobber that mirror — taking it over, redirecting our
        // members' RSVP PII to the attacker, and locking out the real host. Refuse
        // when the row already belongs to a different host.
        const { data: existing } = await supabase.from('mirrored_operations')
            .select('host_peer_id').eq('id', opId).maybeSingle();
        if (existing && existing.host_peer_id !== peerId) return 'skipped';

        const accepted = kind === 'missing-accepted';
        const { error } = await supabase.from('mirrored_operations').upsert({
            id: opId, host_peer_id: peerId,
            snapshot, version: payload.version, snapshot_updated_at: nowIso(),
            accepted, invited_at: nowIso(), accepted_at: accepted ? nowIso() : null, revoked_at: null,
        }, { onConflict: 'id' });
        handleSupabaseError({ error, message: 'Failed to heal missing mirror' });
    } else if (kind === 'regression') {
        // EXPLICIT override of the shouldApplyVersion gate — reachable ONLY from
        // this reconcile pull of a fresh authoritative manifest, NEVER from an
        // inbound push (receiveMirrorPush stays strictly version-gated).
        await supabase.from('mirrored_operations').update({
            snapshot, version: payload.version, snapshot_updated_at: nowIso(),
        }).eq('id', opId).eq('host_peer_id', peerId);
        broadcastToOrg('operation_update', { operationId: opId });
        return 'regression-healed';
    } else if (kind === 'resurrect') {
        // Revoked locally but the host lists it under accepted+alive (a spurious
        // local revoke, or our cancel handling raced a missed re-share). The
        // host's accepted flag is authoritative — only our own /accept sets it —
        // so restore fully as accepted.
        await supabase.from('mirrored_operations').update({
            snapshot, version: payload.version, snapshot_updated_at: nowIso(),
            accepted: true, accepted_at: nowIso(), revoked_at: null,
        }).eq('id', opId).eq('host_peer_id', peerId);
    } else if (kind === 'reinvite') {
        // Missed re-invite after a revoke: back to a pending invite for admins.
        await supabase.from('mirrored_operations').update({
            snapshot, version: payload.version, snapshot_updated_at: nowIso(),
            accepted: false, accepted_at: null, invited_at: nowIso(), revoked_at: null,
        }).eq('id', opId).eq('host_peer_id', peerId);
    } else {
        // 'stale' — same version-gated apply as a push.
        const { data: existing } = await supabase.from('mirrored_operations')
            .select('version').eq('id', opId).eq('host_peer_id', peerId).maybeSingle();
        if (!existing || !shouldApplyVersion(payload.version, existing.version)) return 'skipped';
        await supabase.from('mirrored_operations').update({
            snapshot, version: payload.version, snapshot_updated_at: nowIso(),
        }).eq('id', opId).eq('host_peer_id', peerId);
    }
    broadcastToOrg('operation_update', { operationId: opId });
    return 'applied';
}
