
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { getOrgSecret } from './secrets.js';
import { supabase } from './db/common.js';
import { assertOpVisibleToUser, canUserSeeOpInList } from './db/ops.js';
import type { OpViewer } from './db/ops.js';
import { assertUnitAccess } from './db/system.js';
import { SecurityDenial } from './errors.js';
import { hasAnyStaffViewPerm } from './staffPerms.js';
import { log as baseLog } from './log.js';

const log = baseLog.child({ module: 'lib.radio' });

const ROOM_PREFIX = 'radio-';
const OP_ROOM_PREFIX = 'op-radio-';

// The radio token-minting + status actions proxy to the external LiveKit API (a
// metered service) and are reachable by any authenticated user (user:manage:self).
// Without a per-user throttle a single member could loop radio:auth /
// radio:op_auth / radio:status to run up the org's LiveKit bill — a cost-DoS. This
// adds a per-user minute + daily cap keyed on the authenticated (server-derived,
// unspoofable) user id, independent of the global per-IP limiter.
//
// In-memory, single-instance — same caveat as authRateLimit.ts / aiRateLimit.ts:
// move to a shared store if the server is ever replicated.

const RADIO_MINUTE_MS = 60_000;
const RADIO_DAY_MS = 86_400_000;
const RADIO_PER_MINUTE = 20;
const RADIO_PER_DAY = 500;
const RADIO_MAX_BUCKETS = 10_000;

interface RadioRateBucket {
    minuteCount: number;
    minuteStart: number;
    dayCount: number;
    dayStart: number;
}

const radioBuckets = new Map<string, RadioRateBucket>();

export interface RadioRateLimitResult {
    ok: boolean;
    /** Seconds until the relevant window resets. 0 when ok. */
    retryAfter: number;
    /** Which window tripped, for the error message. */
    scope?: 'minute' | 'day';
}

/**
 * Record a radio-action attempt for `userId` and decide if it may proceed.
 * Fails open for a missing user id (the actions are reached only after the
 * dispatcher injects the authenticated user, so a real caller always has one).
 * `now` is injectable for tests.
 */
export function checkRadioRateLimit(userId: number | string | undefined | null, now: number = Date.now()): RadioRateLimitResult {
    if (userId === undefined || userId === null || userId === '') return { ok: true, retryAfter: 0 };
    const key = String(userId);

    let b = radioBuckets.get(key);
    if (!b) {
        if (radioBuckets.size >= RADIO_MAX_BUCKETS) return { ok: true, retryAfter: 0 }; // shed under spray; IP limiter still caps
        b = { minuteCount: 0, minuteStart: now, dayCount: 0, dayStart: now };
        radioBuckets.set(key, b);
    }
    if (now - b.minuteStart >= RADIO_MINUTE_MS) { b.minuteCount = 0; b.minuteStart = now; }
    if (now - b.dayStart >= RADIO_DAY_MS) { b.dayCount = 0; b.dayStart = now; }

    if (b.dayCount >= RADIO_PER_DAY) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((b.dayStart + RADIO_DAY_MS - now) / 1000)), scope: 'day' };
    }
    if (b.minuteCount >= RADIO_PER_MINUTE) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((b.minuteStart + RADIO_MINUTE_MS - now) / 1000)), scope: 'minute' };
    }
    b.minuteCount += 1;
    b.dayCount += 1;
    return { ok: true, retryAfter: 0 };
}

/** Throwing convenience wrapper used by the radio action handlers. */
export function assertRadioRateLimit(userId: number | string | undefined | null, now: number = Date.now()): void {
    const r = checkRadioRateLimit(userId, now);
    if (!r.ok) {
        const err = new Error(`Radio request limit reached (per ${r.scope}). Try again in ${r.retryAfter}s.`) as Error & { code?: string };
        err.code = 'RADIO_RATE_LIMITED';
        throw err;
    }
}

/** Periodic cleanup of fully-expired buckets. Returns the number removed. */
export function pruneRadioRateLimitBuckets(now: number = Date.now()): number {
    let removed = 0;
    for (const [k, b] of radioBuckets.entries()) {
        if (now - b.dayStart >= RADIO_DAY_MS && now - b.minuteStart >= RADIO_MINUTE_MS) {
            radioBuckets.delete(k);
            removed++;
        }
    }
    return removed;
}

/** Test-only: clear all bucket state. */
export function _resetRadioRateLimit(): void {
    radioBuckets.clear();
}

// Authenticated actor passed in by the dispatcher. The radio actions are
// reachable by any authenticated user (user:manage:self), so the LiveKit grant
// must be authorized here against the actor's identity — the client-supplied
// room name / participant name are not trusted.
export interface RadioUser {
    id: number | string;
    name?: string;
    /**
     * Stamped role IDENTITY (lib/db/adminIdentity.ts), consumed by the op-voice
     * path through assertOpVisibleToUser's clearance predicates. `role` is
     * deliberately absent: radio authorization is permission-only (see the
     * isManager note below) and the NAME-derived tier must not be passable in.
     */
    isSystemAdmin?: boolean;
    permissions?: string[];
    clearanceLevel?: { level?: number } | null;
    // Compartment markers participate in op-voice authorization — the dispatcher
    // injects the full authenticated user, so these are present at runtime and
    // consumed by assertOpVisibleToUser.
    limitingMarkers?: unknown[];
    /** Server-loaded unit off the dispatcher-injected User. Never client input. */
    unit?: { id?: number | null; hasRadioChannel?: boolean } | null;
}

// One message for every refusal so it can't be used as an existence oracle (a
// channel that doesn't exist and one the caller may not join must read the same).
// Ids and the discriminating reason go to `fields`, which is log-only.
function denyRadio(channelId: string, reason: string): never {
    throw new SecurityDenial('You are not authorized to join this radio channel.', {
        auditEvent: 'authz.radio.denied', fields: { channelId, reason },
    });
}

/**
 * Resolve the caller-supplied `room` to a SERVER-DERIVED room name, or refuse.
 *
 * The UI builds `radio-<channelId>` where `<channelId>` is one of three classes
 * (components/ui/RadioWidget.tsx):
 *   - a `radio_channels.id` — a base/staff net, joinable by org personnel;
 *   - `unit-<unitId>` — a unit's synthetic squad net, joinable by that unit's own
 *     members (and radio managers);
 *   - `req-<requestId>` — a mission net, joinable by the request's client, its lead
 *     responder or an assigned responder — Clients included, by design.
 *
 * The prefix branches are evaluated BEFORE the `radio_channels` lookup and that
 * order is load-bearing: `radio_channels.id` is a caller-supplied text primary key
 * (db.addRadioChannel), so a channel row named `unit-9` must never be able to
 * launder a caller past the unit gate.
 *
 * The returned name is re-derived from the validated id — the raw client string is
 * never stamped into the LiveKit grant, so `radio-unit-007` and `radio-unit-7`
 * cannot fork into two rooms on a metered service. Throws SecurityDenial (403).
 */
export async function resolveAndAuthorizeRadioRoom(user: RadioUser, room: string): Promise<string> {
    if (typeof room !== 'string' || !room.startsWith(ROOM_PREFIX)) denyRadio(String(room), 'malformed_room');
    const channelId = room.slice(ROOM_PREFIX.length);
    if (!channelId) denyRadio(room, 'empty_channel');

    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    const callerId = Number(user.id); // RadioUser.id is number|string; every id compared below is numeric
    // PERMISSIONS only — deliberately NOT `user.role === 'Admin'`. inferUserRoleTier
    // (lib/db/mappers.ts:143) resolves the Admin tier from the role NAME, so a
    // permissionless custom role called "Commander" or "Director" would otherwise
    // become a radio manager. The real Admin role holds admin:access.
    const isManager = perms.includes('radio:manage') || perms.includes('admin:access');

    // --- Squad net: radio-unit-<unitId> ---
    if (channelId.startsWith('unit-')) {
        const unitId = Number(channelId.slice('unit-'.length));
        if (!Number.isInteger(unitId) || unitId <= 0) denyRadio(channelId, 'bad_unit_id'); // no round-trip on garbage
        const { data: unit, error } = await supabase.from('units')
            .select('id, has_radio_channel').eq('id', unitId).maybeSingle();
        if (error) denyRadio(channelId, 'unit_query_failed');
        if (!unit) denyRadio(channelId, 'unit_not_found');
        if (unit.has_radio_channel === false) denyRadio(channelId, 'unit_radio_disabled');
        if (!isManager) {
            // Membership is the gate even for a NON-restricted unit — a squad net is
            // not a general net. assertUnitAccess stays as the backstop for the
            // restricted case, and must run AFTER the equality check: it returns early
            // on a pre-migration DB with no is_restricted column (lib/db/system.ts).
            if (Number(user.unit?.id ?? 0) !== unitId) denyRadio(channelId, 'not_own_unit');
            await assertUnitAccess(unitId, callerId);
        }
        return `${ROOM_PREFIX}unit-${unitId}`;
    }

    // --- Mission net: radio-req-<requestId> ---
    if (channelId.startsWith('req-')) {
        const requestId = channelId.slice('req-'.length);
        if (!requestId) denyRadio(channelId, 'bad_request_id');
        // Looked up for managers too: a manager may join any EXISTING mission net, but
        // must not be able to mint arbitrary rooms on a metered service.
        const { data: req, error } = await supabase.from('service_requests')
            .select('id, client_id, lead_responder_id').eq('id', requestId).maybeSingle();
        if (error) denyRadio(channelId, 'request_query_failed');
        if (!req) denyRadio(channelId, 'request_not_found');
        if (!isManager) {
            // DELIBERATE DIVERGENCE from assertRequestResponderOrDuty
            // (lib/db/requests.ts:340), which also admits any request-duty holder and
            // bypasses on the role NAME. Live voice is narrower than the text/status
            // actions: party membership only, and no name-derived Admin. A dispatcher
            // reaches every mission net through radio:manage (the seeded Dispatcher
            // holds it), not through request:dispatch.
            const isOwnRequest = req.client_id === callerId;
            // Checked separately for the same reason assertRequestResponderOrDuty does:
            // a lead is normally also a responder row, but nothing guarantees it.
            const isLead = req.lead_responder_id === callerId;
            let isResponder = false;
            if (!isOwnRequest && !isLead) {
                const { data: resp, error: respErr } = await supabase.from('request_responders')
                    .select('user_id').eq('request_id', req.id).eq('user_id', callerId).maybeSingle();
                if (respErr) denyRadio(channelId, 'responder_query_failed');
                isResponder = Boolean(resp);
            }
            if (!isOwnRequest && !isLead && !isResponder) denyRadio(channelId, 'not_request_party');
        }
        return `${ROOM_PREFIX}req-${req.id}`;
    }

    // --- Base / staff net: a radio_channels row ---
    const { data: channel, error: chanErr } = await supabase.from('radio_channels')
        .select('id').eq('id', channelId).maybeSingle();
    if (chanErr) denyRadio(channelId, 'channel_query_failed');
    if (!channel) denyRadio(channelId, 'unknown_channel');

    // Base nets are the org's STAFF comms. The only thing that ever kept a Client off
    // them was RadioWidget's render filter, i.e. cosmetic — radio:auth maps to the
    // user:manage:self pseudo-perm, so any authenticated session reaches here.
    // Permission-gated, not role-tier gated (see isManager above).
    if (!isManager && !hasAnyStaffViewPerm(perms)) denyRadio(channelId, 'base_channel_client');

    // A channel tied to a restricted unit is private to that unit, the same rule
    // the unit's text feed enforces. Without this, any signed-in member could mint
    // a join token for a restricted unit's voice room and listen or talk. Channels
    // not linked to any unit (general comms) stay open to all staff.
    //
    // linked_channel_id has no unique constraint, so check EVERY unit linked to the
    // channel (not one non-deterministic row): the caller must clear assertUnitAccess
    // for each restricted one. That closes the case where a second (e.g. open) unit is
    // pointed at a restricted unit's channel to dodge a single-row lookup.
    const { data: linkedUnits, error: linkErr } = await supabase.from('units')
        .select('id, is_restricted').eq('linked_channel_id', channelId);
    // Fail CLOSED: a failed read here would otherwise degrade into an empty exclusion
    // set and silently open every restricted unit's channel.
    if (linkErr) denyRadio(channelId, 'linked_units_query_failed');
    for (const u of (linkedUnits || [])) {
        if (u.is_restricted) await assertUnitAccess(u.id, callerId);
    }

    return `${ROOM_PREFIX}${channel.id}`;
}

export async function generateRadioToken(user: RadioUser, room: string) {
    // Authorization FIRST. The caller-supplied `room` is resolved to a SERVER-derived
    // name across the three channel classes the UI emits; the raw client string is
    // never stamped into the createRoom call or the grant. Throws SecurityDenial (403).
    const validatedRoom = await resolveAndAuthorizeRadioRoom(user, room);

    const apiKey = await getOrgSecret('LIVEKIT_API_KEY');
    const apiSecret = await getOrgSecret('LIVEKIT_API_SECRET');
    const wsUrl = await getOrgSecret('LIVEKIT_URL');

    if (!apiKey || !apiSecret || !wsUrl) throw new Error("Radio configuration missing");

    // Best-effort: set auto-cleanup timeouts on the room. LiveKit auto-creates rooms
    // on first join, so this failing should not block token generation.
    try {
        const svc = new RoomServiceClient(wsUrl, apiKey, apiSecret);
        await svc.createRoom({
            name: validatedRoom,
            emptyTimeout: 300,      // Close room 5 min after last participant leaves
            departureTimeout: 30,   // 30s grace period for reconnects
        });
    } catch (e) {
        log.warn('room pre-create failed', { room: validatedRoom, err: e });
    }

    const at = new AccessToken(apiKey, apiSecret, {
        // Identity + display name are taken from the AUTHENTICATED user, never the
        // client payload — prevents impersonating another member in the room.
        identity: String(user.id),
        name: user.name || String(user.id),
        ttl: '6h', // Auto-expire sessions after 6 hours to prevent indefinite connections
    });
    at.addGrant({ roomJoin: true, room: validatedRoom });

    return { token: await at.toJwt(), url: wsUrl };
}

/**
 * The subset of live LiveKit room names a viewer may be told exist.
 *
 * `radio:status` is mapped to the user:manage:self pseudo-perm, so every
 * authenticated caller — Clients included — reads the room list. Squad and mission
 * rooms could never exist before resolveAndAuthorizeRadioRoom shipped (the base
 * lookup rejected them), so shipping it also turns that list into an enumeration of
 * which requests are live and which restricted squads are talking. This is the
 * matching read-side gate.
 *
 * Deliberately NOT a per-room resolveAndAuthorizeRadioRoom call: the dispatch board
 * polls this every 5s, so the request-party check is batched into two queries
 * regardless of room count. Fails CLOSED — no viewer, or a failed read, drops the
 * room.
 *
 * `op-radio-<uuid>` ROOMS ARE GATED HERE TOO. They used to fall through the
 * "not a `radio-` room" branch and be admitted to every caller unconditionally,
 * which handed any authenticated user — Clients, an org's external customers
 * included — the operation UUID and live headcount of every op currently on voice.
 * That is an enumeration of which operations are running and how many people are on
 * them, and for a SPECIAL (invite-only) or clearance-gated op it is exactly the
 * existence fact the rest of the ops module works to withhold. Joining one of those
 * rooms already required passing assertOpVisibleToUser; only the LIST was open.
 *
 * They are now filtered with canUserSeeOpInList — the same predicate the ops list,
 * slice and detail paths use — so this surface cannot drift from them. Batched into
 * three queries regardless of room count, for the same polling reason as above.
 *
 * A room name matching NEITHER prefix is now DROPPED rather than admitted. There is
 * no third room class today, and "admit anything I do not recognise" is the wrong
 * default for a function whose contract is to fail closed.
 */
export async function visibleRadioRoomNames(viewer: RadioUser | null | undefined, roomNames: string[]): Promise<Set<string>> {
    const visible = new Set<string>();
    const perms = Array.isArray(viewer?.permissions) ? viewer.permissions : [];
    const isManager = perms.includes('radio:manage') || perms.includes('admin:access');
    const isStaff = hasAnyStaffViewPerm(perms);
    const viewerId = viewer ? Number(viewer.id) : NaN;
    const viewerUnitId = Number(viewer?.unit?.id ?? 0);
    // requestId -> room name, so the party lookup below is two queries, not 2N.
    const requestRooms = new Map<string, string>();
    // operationId -> room name, same reason.
    const opRooms = new Map<string, string>();

    for (const name of roomNames) {
        if (name.startsWith(OP_ROOM_PREFIX)) {
            if (!viewer) continue;
            const opId = name.slice(OP_ROOM_PREFIX.length);
            if (opId) opRooms.set(opId, name);
            continue;
        }
        if (!name.startsWith(ROOM_PREFIX)) continue;   // unknown room class → dropped, not admitted
        if (!viewer) continue;
        if (isManager) { visible.add(name); continue; }
        const channelId = name.slice(ROOM_PREFIX.length);
        if (channelId.startsWith('unit-')) {
            const unitId = Number(channelId.slice('unit-'.length));
            if (Number.isInteger(unitId) && unitId > 0 && viewerUnitId === unitId) visible.add(name);
            continue;
        }
        if (channelId.startsWith('req-')) {
            const requestId = channelId.slice('req-'.length);
            if (requestId) requestRooms.set(requestId, name);
            continue;
        }
        if (isStaff) visible.add(name);
    }

    // ── op-voice rooms: same predicate the ops list/slice/detail paths use ──────
    //
    // Two gates, both from the ops READ path, because this is a LIST: the
    // `operations` query subset requires operations:view (api/query.ts
    // SUBSET_REQUIRED_PERMISSION), and each row is then filtered by
    // canUserSeeOpInList. Knowing an op exists is precisely what a list discloses,
    // so both apply here. This is deliberately stricter than radio:op_auth, which
    // gates JOINING on assertOpVisibleToUser alone — being able to enumerate every
    // running operation is a broader capability than being let into one you were
    // already told about, and the strict direction is the safe one.
    const canListOps = perms.includes('operations:view')
        || perms.includes('operations:manage')
        || perms.includes('admin:access');
    if (opRooms.size > 0 && viewer && canListOps && Number.isFinite(viewerId)) {
        const opIds = [...opRooms.keys()];
        const { data: ops, error: opErr } = await supabase.from('operations')
            .select('id, owner_id, clearance_level, is_special, limiting_markers:operation_limiting_markers(marker:security_limiting_markers(id, name, code))')
            .in('id', opIds).order('id', { ascending: true }).limit(opIds.length);
        // Only the viewer's OWN active participation — that is all the special-op arm
        // of canUserSeeOpInList asks about, and reading the whole roster here would be
        // a second, wider leak in the fix for the first.
        const { data: parts, error: partErr } = await supabase.from('operation_participants')
            .select('operation_id').eq('user_id', viewerId).is('time_left', null)
            // operation_participants has a COMPOSITE primary key (operation_id, user_id)
            // and no id column, so the total order is both of them — same shape as the
            // role_permissions read in lib/db/bans.ts. The cap is exact rather than
            // arbitrary: the PK makes at most one row per (op, user), and this query is
            // already pinned to one user.
            .in('operation_id', opIds)
            .order('operation_id', { ascending: true }).order('user_id', { ascending: true })
            .limit(opIds.length);
        if (opErr || partErr) {
            log.warn('radio status op filter query failed — dropping op rooms', { err: opErr || partErr });
        } else {
            const joined = new Set((parts || []).map((p) => String(p.operation_id)));
            for (const op of (ops || []) as Array<{ id: string; owner_id: number | null; clearance_level: number | null; is_special: boolean | null; limiting_markers?: Array<{ marker?: unknown }> }>) {
                const name = opRooms.get(String(op.id));
                if (!name) continue;
                const markers = (op.limiting_markers || []).map((m) => m.marker).filter(Boolean);
                const canSee = canUserSeeOpInList(viewer as OpViewer, {
                    clearanceLevel: op.clearance_level ?? 0,
                    ownerId: op.owner_id,
                    limitingMarkers: markers,
                    isSpecial: !!op.is_special,
                    participants: joined.has(String(op.id)) ? [{ userId: viewerId, timeLeft: null }] : [],
                });
                if (canSee) visible.add(name);
            }
        }
    }

    if (requestRooms.size === 0 || !Number.isFinite(viewerId)) return visible;
    const ids = [...requestRooms.keys()];
    const { data: reqs, error: reqErr } = await supabase.from('service_requests')
        .select('id, client_id, lead_responder_id').in('id', ids);
    const { data: assigned, error: respErr } = await supabase.from('request_responders')
        .select('request_id').eq('user_id', viewerId).in('request_id', ids);
    if (reqErr || respErr) {
        log.warn('radio status party filter query failed — dropping mission rooms', { err: reqErr || respErr });
        return visible;
    }
    const responderFor = new Set((assigned || []).map(r => String(r.request_id)));
    for (const r of (reqs || [])) {
        const name = requestRooms.get(String(r.id));
        if (!name) continue;
        if (r.client_id === viewerId || r.lead_responder_id === viewerId || responderFor.has(String(r.id))) visible.add(name);
    }
    return visible;
}

// Participant identities + names of every active room — incl. private per-op
// comms — must not be handed to every authenticated member. `includeParticipants`
// is set only for callers holding radio:manage; everyone else receives room names
// + counts (presence) but no identities, and only for rooms `visibleRadioRoomNames`
// says they may know about.
export async function getRadioStatus(opts?: { includeParticipants?: boolean; viewer?: RadioUser | null }) {
    const includeParticipants = !!opts?.includeParticipants;
    const apiKey = await getOrgSecret('LIVEKIT_API_KEY');
    const apiSecret = await getOrgSecret('LIVEKIT_API_SECRET');
    const wsUrl = await getOrgSecret('LIVEKIT_URL');

    if (!apiKey || !apiSecret || !wsUrl) return { activeChannels: [] };

    const svc = new RoomServiceClient(wsUrl, apiKey, apiSecret);
    const allRooms = await svc.listRooms();
    const visible = await visibleRadioRoomNames(opts?.viewer, allRooms.map(r => r.name));
    const rooms = allRooms.filter(r => visible.has(r.name));

    const activeChannels = await Promise.all(rooms.map(async room => {
        // Skip the extra API call for empty rooms, or whenever the caller is not
        // permitted to see participant identities.
        if (!room.numParticipants || !includeParticipants) {
            return {
                roomName: room.name,
                participantCount: room.numParticipants || 0,
                participants: [],
                participantNames: []
            };
        }

        let participants: any[] = [];
        try {
            participants = await svc.listParticipants(room.name);
        } catch (e: any) {
            // Room might have closed between listRooms and listParticipants
            if (e.code === 404 || e.message?.includes('not found')) {
                // Silent ignore, room is gone
            } else {
                log.warn('list participants failed', { room: room.name, err: e });
            }
        }

        return {
            roomName: room.name,
            participantCount: room.numParticipants,
            participants: participants.map(p => p.identity),
            participantNames: participants.map(p => p.name)
        };
    }));

    return { activeChannels };
}

/**
 * Evict a member from every live voice room.
 *
 * VOICE IS THE SECOND CHANNEL A BAN CANNOT REACH. The ban gate refuses REQUESTS,
 * but a LiveKit session is already established — the member holds a room token
 * (issued for up to six hours) and keeps hearing live operational comms until it
 * expires. Web push is the other such channel and is handled by
 * db.dropPushSubscriptions; this is its voice twin.
 *
 * Identity is String(user.id), matching how every token in this file is minted.
 * Best-effort and never throws: a ban must not fail because LiveKit is unreachable
 * or unconfigured. The caller logs.
 */
export async function evictUserFromAllRooms(userId: number): Promise<number> {
    const apiKey = await getOrgSecret('LIVEKIT_API_KEY');
    const apiSecret = await getOrgSecret('LIVEKIT_API_SECRET');
    const wsUrl = await getOrgSecret('LIVEKIT_URL');
    if (!apiKey || !apiSecret || !wsUrl) return 0;

    const identity = String(userId);
    const svc = new RoomServiceClient(wsUrl, apiKey, apiSecret);
    let removed = 0;
    let rooms: Array<{ name: string; numParticipants?: number }>;
    try {
        rooms = await svc.listRooms();
    } catch (e) {
        log.warn('voice eviction: listRooms failed', { err: e });
        return 0;
    }
    // REVOKE THE GRANT, do not merely kick the connection.
    //
    // A bare removeParticipant disconnects the session and leaves the JOIN TOKEN valid
    // — and this file mints them with `ttl: '6h'`. A banned member's client reconnects
    // on its own, or they simply re-enter the room, because the credential that let
    // them in has not changed. That makes the eviction cosmetic on exactly the path
    // ban:place added it for.
    //
    // revokeTokenTs invalidates every token for this identity whose `nbf` precedes the
    // cutoff. The tokens qualify: AccessToken.toJwt() calls jose's
    // `.setNotBefore(new Date())`, so each one carries an `nbf` stamped at mint time.
    // The +60s reaches slightly into the future to cover clock skew between this
    // process and the LiveKit server and to catch a token minted in the same instant as
    // the ban; the only cost is that a ban LIFTED within that minute needs one more
    // token, which the client requests automatically on the next join.
    const revokeTokenTs = BigInt(Math.floor(Date.now() / 1000) + 60);
    for (const room of rooms) {
        if (!room.numParticipants) continue;
        try {
            await svc.removeParticipant(room.name, identity, { revokeTokenTs });
            removed += 1;
        } catch (e: any) {
            // 404 is the ordinary case: they are simply not in this room.
            if (e?.code !== 404 && !String(e?.message || '').includes('not found')) {
                log.warn('voice eviction failed for a room', { room: room.name, err: e });
            }
        }
    }
    return removed;
}

export async function generateOpRadioToken(user: RadioUser, operationId: string) {
    // Confirm the operation exists + load the owner id for the bypass below.
    const { data: op, error: opErr } = await supabase
        .from('operations')
        .select('id, owner_id')
        .eq('id', operationId)
        .single();
    if (opErr || !op) throw new Error('Operation not found');

    // Tie voice access to the canonical per-op visibility predicate. Owner /
    // operations:manage bypass; everyone else needs operations:view (this action
    // is reachable by any authenticated user via user:manage:self, so the view
    // permission must be re-checked here) AND assertOpVisibleToUser, which
    // enforces the clearance level and every limiting marker.
    const perms = user.permissions || [];
    const isOwner = op.owner_id === user.id;
    // PERMISSIONS only, matching the base-channel branch above (resolveAndAuthorizeRadioRoom):
    // `role` is the NAME-derived tier, so a permissionless custom role called
    // "Commander" bypassed the per-op clearance/marker check below. Admin and
    // Dispatcher are both seeded with operations:manage.
    const canManage = perms.includes('operations:manage');
    if (!isOwner && !canManage) {
        if (!perms.includes('operations:view')) {
            throw new Error('Insufficient clearance to join this operation channel.');
        }
        await assertOpVisibleToUser(operationId, user);
    }

    const apiKey = await getOrgSecret('LIVEKIT_API_KEY');
    const apiSecret = await getOrgSecret('LIVEKIT_API_SECRET');
    const wsUrl = await getOrgSecret('LIVEKIT_URL');
    if (!apiKey || !apiSecret || !wsUrl) throw new Error('Radio configuration missing');

    const roomName = `op-radio-${operationId}`;

    // Best-effort: set auto-cleanup timeouts on the room
    try {
        const svc = new RoomServiceClient(wsUrl, apiKey, apiSecret);
        await svc.createRoom({
            name: roomName,
            emptyTimeout: 300,      // Close room 5 min after last participant leaves
            departureTimeout: 30,   // 30s grace period for reconnects
        });
    } catch (e) {
        log.warn('room pre-create failed', { room: roomName, err: e });
    }

    const at = new AccessToken(apiKey, apiSecret, {
        // Identity + name from the authenticated user, never the client payload.
        identity: String(user.id),
        name: user.name || String(user.id),
        ttl: '6h', // Auto-expire sessions after 6 hours
    });
    at.addGrant({ roomJoin: true, room: roomName });

    return { token: await at.toJwt(), url: wsUrl, roomName };
}

export async function rebootRadioNetwork() {
    const apiKey = await getOrgSecret('LIVEKIT_API_KEY');
    const apiSecret = await getOrgSecret('LIVEKIT_API_SECRET');
    const wsUrl = await getOrgSecret('LIVEKIT_URL');

    if (!apiKey || !apiSecret || !wsUrl) throw new Error("Radio configuration missing");

    const svc = new RoomServiceClient(wsUrl, apiKey, apiSecret);
    try {
        const rooms = await svc.listRooms();
        const promises = rooms.map(room => svc.deleteRoom(room.name));
        await Promise.allSettled(promises);
        return { success: true, count: rooms.length };
    } catch (e: any) {
        log.error('radio network reboot failed', { err: e });
        throw e;
    }
}
