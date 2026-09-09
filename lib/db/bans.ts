
import { supabase, handleSupabaseError, getSystemRoles } from './common.js';
import { requireIntId } from '../pgrest.js';
import { stripHtml, stripHtmlSingleLine } from '../textSanitize.js';
import { SecurityDenial } from '../errors.js';
import type { OrgBan, BanAppeal, BanNotice } from '../../types.js';

// ---------------------------------------------------------------------------
// Org bans — lockout, not removal.
// ---------------------------------------------------------------------------
// THE ENFORCEMENT CONTRACT, in one place:
//
//   findActiveBan() runs on EVERY authenticated request and on the login path. It
//   FAILS CLOSED: a query fault THROWS rather than returning null, because
//   returning "not banned" on a DB blip is the one failure mode that silently
//   un-bans everybody at once. Callers turn that throw into a retryable 503,
//   NEVER into a ban screen — telling an innocent member they are banned because
//   a read failed is its own kind of incident.
//
//   Expiry is evaluated HERE, against the SERVER clock, on every check. The
//   countdown the banned screen renders is cosmetic; no client assertion that its
//   own ban has lapsed is ever trusted. It is applied in JS rather than in the
//   predicate so the query stays a plain probe on the partial unique indexes
//   (WHERE lifted_at IS NULL) — at most one active row per identity comes back.
//
//   The read is deliberately UNCACHED. Caching it would buy a window in which a
//   lifted ban still locks someone out and, worse, one in which a fresh ban has
//   not landed yet. Revisit only with a profile in hand.
//
// SINGLE-ORG: hosted threads an organizationId through every function here and
// carries a portal-owner break-glass. Neither exists in this build — see the note
// above getBanPermissionHolderIds for what replaced the owner check.
//
// Rule 1: every select lists explicit columns. discord_id is read ONLY by the
// enforcement lookup that must match on it; no list or detail read selects it.

/** Columns the staff-facing console renders. Never includes discord_id. */
const BAN_COLS = 'id, user_id, reason, expires_at, banned_at, banned_by, lifted_at, lifted_by, lift_reason';
const APPEAL_COLS = 'id, ban_id, statement, status, reviewed_by, reviewed_at, review_note, created_at';
const BAN_WITH_APPEAL_SELECT = `${BAN_COLS}, appeal:organization_ban_appeals(${APPEAL_COLS})`;

/** The minimum the enforcement path needs to deny a request and explain it. */
const BAN_ENFORCE_COLS = 'id, reason, expires_at, banned_at';

const MAX_REASON_LEN = 1000;
const MAX_STATEMENT_LEN = 4000;
const MAX_LIST = 200;

// Row shapes are declared HERE rather than pulled from Tables<'organization_bans'>,
// following lib/db/securityEvents.ts. These tables are new, so the generated
// lib/database.types.ts does not know them yet — and this way the code compiles
// without a types regeneration against a database that has already been migrated,
// which is a chicken-and-egg the operator should not have to solve.
interface OrgBanRow {
    id: number;
    user_id: number | null;
    reason: string;
    expires_at: string | null;
    banned_at: string;
    banned_by: number | null;
    lifted_at: string | null;
    lifted_by: number | null;
    lift_reason: string | null;
    appeal?: BanAppealRow | BanAppealRow[] | null;
}

interface BanAppealRow {
    id: number;
    ban_id: number;
    statement: string;
    status: string;
    reviewed_by: number | null;
    reviewed_at: string | null;
    review_note: string | null;
    created_at: string;
}

const toBanAppeal = (r: BanAppealRow): BanAppeal => ({
    id: r.id,
    banId: r.ban_id,
    statement: r.statement,
    status: r.status as BanAppeal['status'],
    reviewedById: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
    createdAt: r.created_at,
});

const toOrgBan = (r: OrgBanRow): OrgBan => {
    const embedded = Array.isArray(r.appeal) ? r.appeal[0] : r.appeal;
    return {
        id: r.id,
        userId: r.user_id,
        reason: r.reason,
        expiresAt: r.expires_at,
        bannedAt: r.banned_at,
        bannedById: r.banned_by,
        liftedAt: r.lifted_at,
        liftedById: r.lifted_by,
        liftReason: r.lift_reason,
        appeal: embedded ? toBanAppeal(embedded) : null,
    };
};

/** Not lifted, and either permanent or not yet expired — against the SERVER clock. */
const isActive = (row: { expires_at: string | null }, now = Date.now()): boolean =>
    row.expires_at == null || new Date(row.expires_at).getTime() > now;

// The reason is operator-authored free text rendered back to the banned member on
// a blocking screen, so it is stripped at WRITE time — that screen must not be a
// markup-injection surface.
function sanitizeText(raw: unknown, field: string, max: number, multiline = false): string {
    // +1 so an over-long value trips the length check below instead of being
    // silently truncated into something the author did not write.
    const s = (multiline ? stripHtml(raw, max + 1) : stripHtmlSingleLine(raw, max + 1)).trim();
    if (!s) throw new Error(`${field} is required.`);
    if (s.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
    return s;
}

function optionalText(raw: unknown, field: string, max: number): string | null {
    if (raw == null || raw === '') return null;
    const s = stripHtmlSingleLine(raw, max + 1).trim();
    if (!s) return null;
    if (s.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
    return s;
}

/** NULL = permanent. Anything else must be a real, future instant. */
function normalizeExpiry(raw: unknown): string | null {
    if (raw == null || raw === '') return null;
    const at = new Date(typeof raw === 'number' ? raw : String(raw));
    if (Number.isNaN(at.getTime())) throw new Error('Ban expiry is not a valid date.');
    if (at.getTime() <= Date.now()) throw new Error('A temporary ban must expire in the future.');
    // Canonical toISOString on the way in: this codebase compares timestamps as
    // ISO strings in places, and a raw Postgres rendering ('+00', microseconds)
    // does not order lexicographically against one.
    return at.toISOString();
}

/**
 * Thrown when ban state could not be DETERMINED. Callers MUST turn this into a
 * retryable server error, never into a ban screen.
 */
export class BanCheckUnavailable extends Error {
    constructor() {
        super('Unable to verify account status. Please try again.');
        this.name = 'BanCheckUnavailable';
        Object.setPrototypeOf(this, BanCheckUnavailable.prototype);
    }
}

export interface ActiveBanRow {
    id: number;
    reason: string;
    expiresAt: string | null;
    bannedAt: string;
}

/**
 * The enforcement read. Returns the caller's ACTIVE ban, or null.
 *
 * THROWS on a query fault — see the fail-closed contract at the top of this file.
 * Pass whichever identities you hold: the dispatcher has userId, the login path
 * has discordId (before any user row is resolved), and a re-login has both.
 */
export async function findActiveBan(
    subject: { userId?: number | null; discordId?: string | null },
): Promise<ActiveBanRow | null> {
    const userId = typeof subject.userId === 'number' && Number.isSafeInteger(subject.userId) && subject.userId > 0
        ? subject.userId : null;
    const discordId = typeof subject.discordId === 'string' && /^\d{5,25}$/.test(subject.discordId)
        ? subject.discordId : null;
    // No usable identity is NOT an error — an unlinked caller simply has no ban to
    // find. (A malformed discord id is treated as absent rather than interpolated
    // into a filter.)
    if (userId === null && discordId === null) return null;

    // ONE reassigned builder, not two variables. The order ratchet's scanner follows
    // `q = q.…` and cannot follow `const query = base.…`, so the two-variable shape
    // would hide a capped read from the absolute total-order rule.
    let q = supabase.from('organization_bans')
        .select(BAN_ENFORCE_COLS)
        // Rides the partial unique indexes, which are defined WHERE lifted_at IS NULL.
        .is('lifted_at', null);
    // Either identity matching is a hit: a ban placed on the Discord id must survive
    // the user row being soft-deleted and a new one created. Both ids are validated
    // above, so neither can carry PostgREST filter syntax.
    if (userId !== null && discordId !== null) q = q.or(`user_id.eq.${userId},discord_id.eq.${discordId}`);
    else if (userId !== null) q = q.eq('user_id', userId);
    else q = q.eq('discord_id', discordId as string);

    // At most one active row per identity (partial unique indexes), so two. The id
    // tiebreak is required by the absolute order rule and is free here.
    const { data, error } = await q
        .order('banned_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(2);

    // FAIL CLOSED. Do not degrade to "not banned".
    if (error) throw new BanCheckUnavailable();
    const now = Date.now();
    const row = ((data || []) as Array<{ id: number; reason: string; expires_at: string | null; banned_at: string }>)
        .find((r) => isActive(r, now));
    if (!row) return null;
    return { id: row.id, reason: row.reason, expiresAt: row.expires_at ?? null, bannedAt: row.banned_at };
}

/** Close out any active ban on this subject so the new one is the only live row. */
async function supersedeActiveBans(
    subject: { userId: number | null; discordId: string | null },
    actorUserId: number,
): Promise<void> {
    const stamp = {
        lifted_at: new Date().toISOString(),
        lifted_by: actorUserId,
        lift_reason: 'Superseded by a new ban',
    };
    // Two narrow statements rather than one .or(): the partial unique indexes are
    // per-identity, and a combined filter would be harder to keep aligned with them.
    if (subject.userId !== null) {
        const { error } = await supabase.from('organization_bans').update(stamp)
            .eq('user_id', subject.userId).is('lifted_at', null);
        handleSupabaseError({ error, message: 'Failed to supersede existing ban' });
    }
    if (subject.discordId !== null) {
        const { error } = await supabase.from('organization_bans').update(stamp)
            .eq('discord_id', subject.discordId).is('lifted_at', null);
        handleSupabaseError({ error, message: 'Failed to supersede existing ban' });
    }
}

/**
 * Place a ban. Supersedes any existing un-lifted ban on the same subject rather
 * than colliding with the partial unique index — the superseded row is retained,
 * stamped, and stays in the history.
 *
 * Callers MUST have already established that the actor may ban and that the target
 * is permitted (api/actions/bans.ts owns those rules).
 */
export async function createBan(
    input: { userId?: number | null; discordId?: string | null; reason: unknown; expiresAt?: unknown },
    actorUserId: number,
): Promise<OrgBan> {
    const userId = input.userId == null ? null : Number(requireIntId(input.userId, 'userId'));
    const discordId = typeof input.discordId === 'string' && /^\d{5,25}$/.test(input.discordId)
        ? input.discordId : null;
    if (userId === null && discordId === null) {
        throw new Error('A ban needs a member or a linked Discord account to act on.');
    }

    const row = {
        user_id: userId,
        discord_id: discordId,
        reason: sanitizeText(input.reason, 'Ban reason', MAX_REASON_LEN),
        expires_at: normalizeExpiry(input.expiresAt),
        banned_by: actorUserId,
    };

    // INSERT FIRST, supersede only on the collision. The intuitive order — close
    // the old ban, then write the new one — means ANY insert failure (a constraint,
    // a transient fault, a validation change) leaves the subject with NO active ban
    // at all: a ban write that silently UN-bans. PostgREST gives no transaction
    // here, so the ordering IS the safety argument. The worst case this way round
    // is the opposite and harmless: the insert fails and the existing ban stands.
    let { data, error } = await supabase.from('organization_bans').insert(row).select(BAN_COLS).single();
    if ((error as { code?: string } | null)?.code === '23505') {
        await supersedeActiveBans({ userId, discordId }, actorUserId);
        ({ data, error } = await supabase.from('organization_bans').insert(row).select(BAN_COLS).single());
    }
    handleSupabaseError({ error, message: 'Failed to place ban' });
    return toOrgBan(data as unknown as OrgBanRow);
}

/** Lift a ban. The row is retained and stamped — the table IS the audit trail. */
export async function liftBan(banId: unknown, actorUserId: number, liftReason?: unknown): Promise<OrgBan> {
    const id = Number(requireIntId(banId, 'banId'));
    const { data, error } = await supabase.from('organization_bans')
        .update({
            lifted_at: new Date().toISOString(),
            lifted_by: actorUserId,
            lift_reason: optionalText(liftReason, 'Lift reason', MAX_REASON_LEN),
        })
        .eq('id', id)
        // Compare-and-swap: two admins lifting at once must not double-stamp, and a
        // already-lifted id must not be discoverable by a silent no-op.
        .is('lifted_at', null)
        .select(BAN_COLS)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to lift ban' });
    if (!data) {
        throw new SecurityDenial('That ban is not active.', {
            auditEvent: 'authz.resource.denied',
            fields: { banId: id },
        });
    }
    return toOrgBan(data as unknown as OrgBanRow);
}

/** Staff-facing list for the ban console. Capped and totally ordered. */
export async function listBans(opts: { includeLifted?: boolean; limit?: number } = {}): Promise<OrgBan[]> {
    let query = supabase.from('organization_bans').select(BAN_WITH_APPEAL_SELECT);
    if (!opts.includeLifted) query = query.is('lifted_at', null);
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), MAX_LIST);
    const { data, error } = await query
        .order('banned_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit);
    handleSupabaseError({ error, message: 'Failed to load bans' });
    return ((data || []) as unknown as OrgBanRow[]).map(toOrgBan);
}

/** Load a ban by id. Used by the appeal paths. */
export async function getBanById(banId: number): Promise<{ id: number; userId: number | null } | null> {
    const { data, error } = await supabase.from('organization_bans')
        .select('id, user_id')
        .eq('id', banId)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to load ban' });
    const row = data as { id: number; user_id: number | null } | null;
    return row ? { id: row.id, userId: row.user_id } : null;
}

/**
 * What the banned member is shown about THEIR OWN ban. Self-scoped by
 * construction: the caller passes the authenticated user's own id, never a target.
 */
export async function getBanNotice(userId: number, discordId?: string | null): Promise<BanNotice | null> {
    const active = await findActiveBan({ userId, discordId });
    if (!active) return null;
    const { data, error } = await supabase.from('organization_ban_appeals')
        .select('status')
        .eq('ban_id', active.id)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to load appeal status' });
    const status = (data as { status?: string } | null)?.status as BanNotice['appealStatus'] | undefined;
    return {
        banId: active.id,
        reason: active.reason,
        expiresAt: active.expiresAt,
        bannedAt: active.bannedAt,
        appealStatus: status ?? null,
        canAppeal: !status,
    };
}

/**
 * The one write a banned member may perform. One appeal per ban — the unique index
 * on (ban_id) is the real guarantee; the 23505 branch turns the race into a clean
 * message rather than a 500. Without that index the appeal form would be an
 * unmetered insert primitive for a hostile ex-member.
 */
export async function createBanAppeal(banId: number, statement: unknown): Promise<BanAppeal> {
    const text = sanitizeText(statement, 'Appeal statement', MAX_STATEMENT_LEN, true);
    const { data, error } = await supabase.from('organization_ban_appeals').insert({
        ban_id: banId,
        statement: text,
        status: 'pending',
    }).select(APPEAL_COLS).single();
    if ((error as { code?: string } | null)?.code === '23505') {
        throw new Error('You have already appealed this ban.');
    }
    handleSupabaseError({ error, message: 'Failed to submit appeal' });
    return toBanAppeal(data as unknown as BanAppealRow);
}

/** Resolve an appeal. Accepting does NOT lift the ban — the caller does that, audibly. */
export async function reviewBanAppeal(
    appealId: unknown,
    verdict: 'accepted' | 'rejected',
    actorUserId: number,
    note?: unknown,
): Promise<BanAppeal> {
    const id = Number(requireIntId(appealId, 'appealId'));
    const { data, error } = await supabase.from('organization_ban_appeals')
        .update({
            status: verdict,
            reviewed_by: actorUserId,
            reviewed_at: new Date().toISOString(),
            review_note: optionalText(note, 'Review note', MAX_REASON_LEN),
        })
        .eq('id', id)
        // CAS on the pending state so two reviewers cannot both resolve it.
        .eq('status', 'pending')
        .select(APPEAL_COLS)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to review appeal' });
    if (!data) {
        throw new SecurityDenial('That appeal is not pending.', {
            auditEvent: 'authz.resource.denied',
            fields: { appealId: id },
        });
    }
    return toBanAppeal(data as unknown as BanAppealRow);
}

/** Appeals for the admin queue. Capped and totally ordered. */
export async function listBanAppeals(opts: { status?: string; limit?: number } = {}): Promise<BanAppeal[]> {
    let query = supabase.from('organization_ban_appeals').select(APPEAL_COLS);
    if (opts.status) query = query.eq('status', opts.status);
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), MAX_LIST);
    const { data, error } = await query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit);
    handleSupabaseError({ error, message: 'Failed to load appeals' });
    return ((data || []) as unknown as BanAppealRow[]).map(toBanAppeal);
}

/**
 * Resolve a ban target.
 *
 * The Discord id is read from the users row HERE and never taken from the request:
 * it is the durable anchor the whole feature rests on, so letting a caller supply
 * it would let them ban an arbitrary identity — or, worse, anchor a ban on someone
 * else's account while naming an innocent target.
 *
 * DELIBERATELY does NOT filter `deleted_at IS NULL`, unlike academy's
 * assertUserExists. A soft-deleted member is exactly who you most need to be able
 * to ban: deleteUser retains discord_id "for abuse prevention (ban-evasion
 * detection)", and the evasion route is delete-then-sign-in-again. Banning the
 * retained Discord id is the whole point.
 */
export async function loadBanTarget(targetUserId: unknown): Promise<{ id: number; discordId: string | null }> {
    const id = Number(requireIntId(targetUserId, 'targetUserId'));
    const { data, error } = await supabase.from('users')
        .select('id, discord_id')
        .eq('id', id)
        .maybeSingle();
    handleSupabaseError({ error, message: 'Failed to load member' });
    if (!data) {
        throw new SecurityDenial('That member could not be found.', {
            auditEvent: 'authz.invalid_target',
            fields: { targetUserId: id },
        });
    }
    const row = data as { id: number; discord_id: string | null };
    return { id: row.id, discordId: row.discord_id ?? null };
}

// NOTE — there is deliberately no owner check here.
//
// Hosted matches a ban target against organizations.owner_id, a PORTAL identity
// linked through users.auth_user_id. This build has no portal tier, and the guard
// would be a comparison that is guaranteed false — an "the owner cannot be banned"
// check that looks present while doing nothing.
//
// ban:place enforces RECOVERABILITY instead (api/actions/bans.ts): a ban may not
// leave the org without an un-banned holder of admin:user:ban. That is the property
// the owner check was reaching for, and unlike owner identity it is something this
// schema can actually express.

/**
 * User ids whose role grants the ban permission — who an appeal routes to, and who
 * the recoverability guard counts.
 *
 * TWO ARMS, and the second one is load-bearing.
 *
 *   1. DELEGATED — roles the operator granted the permission to, read out of
 *      role_permissions. This is the only arm that used to exist.
 *   2. IDENTITY — the system Admin role, whether or not role_permissions currently
 *      says so. A permission reaches a role ONLY through seedInstall (first boot)
 *      or repairDatabase (a button an operator has to click), so on an UPGRADED
 *      install admin:user:ban exists in the catalogue while the Admin role holds no
 *      row for it. Arm 1 alone therefore did not list the org's own Admin, and the
 *      "peers do not ban peers" rule in ban:place — whose comment asserts the Admin
 *      is a peer by construction — did not protect them. A delegated ban-holder
 *      could ban the Admin, who then 403s on everything but logout/notice/appeal,
 *      and the break-glass (liftBansOnSystemAdmins, reachable only from Database
 *      Tools) is itself an Admin-gated control. Recovery meant raw SQL.
 *
 * Arm 2 only ever ADDS holders, never removes: an unresolvable Admin slot degrades
 * to arm 1 rather than throwing, so the guard is never weaker than it was and a
 * pre-migration org whose roles cannot be identified keeps a working ban feature.
 * That slot is resolved by role IDENTITY (is_system, with the name fallback in
 * getSystemRoles), never by a bare name match — a custom role called "Admin" must
 * not be able to make its own members unbannable.
 *
 * FAILS CLOSED, unlike its sibling in lib/db/academy.ts. That one feeds a
 * best-effort notification fan-out where an empty result costs a missed ping; this
 * one feeds a SECURITY guard, where an empty result caused by a read fault would
 * read as "nobody can lift bans" and block a legitimate ban — or, if the caller
 * inverted the test, allow one that strands the org. Kept local rather than shared
 * with academy's precisely because the failure contracts differ.
 */
export async function getBanPermissionHolderIds(permission = 'admin:user:ban'): Promise<number[]> {
    const holderRoleIds = new Set<number>();

    // ── Arm 1: delegated ──────────────────────────────────────────────────────
    const { data: perms, error: permErr } = await supabase.from('permissions')
        .select('id').eq('name', permission).order('id', { ascending: true }).limit(50);
    if (permErr) throw new BanCheckUnavailable();
    const permIds = ((perms || []) as Array<{ id: number }>).map((p) => p.id);
    if (permIds.length > 0) {
        // Ordered by role_id, not id: role_permissions has a COMPOSITE primary key
        // (role_id, permission_id) and no id column, so role_id is the tiebreak available.
        const { data: rp, error: rpErr } = await supabase.from('role_permissions')
            .select('role_id').in('permission_id', permIds).order('role_id', { ascending: true }).limit(2000);
        if (rpErr) throw new BanCheckUnavailable();
        for (const r of (rp || []) as Array<{ role_id: number }>) holderRoleIds.add(r.role_id);
    }

    // ── Arm 2: identity ───────────────────────────────────────────────────────
    // The 5-minute memo is the same one every apex gate reads, and a stale slot can
    // only name a role nobody holds — which degrades to arm 1 rather than widening
    // the set. Not worth a cache-free round trip on a path that also runs per appeal.
    const sysRoles = await getSystemRoles();
    if (sysRoles.admin) holderRoleIds.add(sysRoles.admin.id);

    if (holderRoleIds.size === 0) return [];

    const { data: users, error: userErr } = await supabase.from('users')
        .select('id').in('role_id', [...holderRoleIds]).is('deleted_at', null)
        .order('id', { ascending: true }).limit(500);
    if (userErr) throw new BanCheckUnavailable();
    return ((users || []) as Array<{ id: number }>).map((u) => u.id);
}

/**
 * Which of these users currently hold an ACTIVE ban.
 *
 * Used by the recoverability guard in ban:place — a ban must never leave the org
 * with nobody able to lift one. Fails closed like findActiveBan: if we cannot
 * determine who is banned, we must not conclude that somebody is available.
 */
export async function filterActivelyBanned(userIds: number[]): Promise<Set<number>> {
    const ids = userIds.filter((id) => Number.isSafeInteger(id) && id > 0);
    if (ids.length === 0) return new Set();
    const { data, error } = await supabase.from('organization_bans')
        .select('user_id, expires_at')
        .in('user_id', ids)
        .is('lifted_at', null)
        // EXACTLY ids.length, not MAX_LIST. The partial unique index on (user_id)
        // WHERE lifted_at IS NULL guarantees at most one active row per id, so this
        // is an exact ceiling that can never truncate — and a truncating cap here
        // would silently under-report who is banned, which is the direction that
        // strands the org.
        .order('id', { ascending: true })
        .limit(ids.length);
    if (error) throw new BanCheckUnavailable();
    const now = Date.now();
    const out = new Set<number>();
    for (const r of (data || []) as Array<{ user_id: number | null; expires_at: string | null }>) {
        if (r.user_id != null && isActive(r, now)) out.add(r.user_id);
    }
    return out;
}

/**
 * BREAK-GLASS: lift any active ban held by a system Admin.
 *
 * The peer rule in ban:place means an Admin can never BE banned — arm 2 of
 * getBanPermissionHolderIds lists the system Admin role unconditionally, so an Admin
 * is a peer by construction. This exists for the one ordering that gets past that
 * rule, and for installs upgraded before arm 2 existed: ban a
 * member FIRST, then promote them. If the org then loses its other
 * admin:user:ban holders, the ban is unliftable and the org is stuck.
 *
 * So this does not override an operator decision — it restores an invariant the
 * ban path already enforces at write time, and only ever for the exact set of
 * people that path would have refused to ban. Narrow on purpose: role IDENTITY
 * (is_system), never the role NAME, so a custom role called "Admin" is not a
 * self-unban route.
 *
 * Lives in repairDatabase, not schema.sql: that script is a re-runnable
 * convergence script and this is one-time STATE. Reported in repair's return
 * string rather than done silently — an operator who runs Repair for an unrelated
 * reason must be told a ban was lifted.
 */
export async function liftBansOnSystemAdmins(): Promise<number> {
    const roles = await getSystemRoles();
    const adminRoleId = roles.admin?.id;
    if (!adminRoleId) return 0;

    const { data: admins, error: adminErr } = await supabase.from('users')
        .select('id').eq('role_id', adminRoleId).is('deleted_at', null)
        .order('id', { ascending: true }).limit(500);
    if (adminErr) throw new BanCheckUnavailable();
    const adminIds = ((admins || []) as Array<{ id: number }>).map((u) => u.id);
    if (adminIds.length === 0) return 0;

    // Only the ACTIVELY banned — an expired-but-unlifted row is already harmless,
    // and stamping it would rewrite history for no gain.
    const banned = await filterActivelyBanned(adminIds);
    if (banned.size === 0) return 0;

    // Resolve the ban ids FIRST rather than taking them off an UPDATE … RETURNING.
    // The returning form is an unbounded read (the order ratchet caught it), and this
    // way the count reported to the operator is exact rather than inferred. Capped at
    // EXACTLY the subject count, which the partial unique index on (user_id) WHERE
    // lifted_at IS NULL makes an exact ceiling that can never truncate.
    const { data: rows, error: readErr } = await supabase.from('organization_bans')
        .select('id')
        .in('user_id', [...banned])
        .is('lifted_at', null)
        .order('id', { ascending: true })
        .limit(banned.size);
    if (readErr) throw new BanCheckUnavailable();
    const banIds = ((rows || []) as Array<{ id: number }>).map((r) => r.id);
    if (banIds.length === 0) return 0;

    const { error } = await supabase.from('organization_bans')
        .update({
            lifted_at: new Date().toISOString(),
            // NULL, not the operator running Repair: no person made this decision,
            // and attributing it to whoever clicked the button would put a name in
            // the accountable history that does not belong there. The lift_reason
            // is what the console renders in its place.
            lifted_by: null,
            lift_reason: 'Lifted by Database Repair: the subject holds the Admin role',
        })
        .in('id', banIds)
        .is('lifted_at', null);
    handleSupabaseError({ error, message: 'Failed to lift bans on Admin-role holders' });
    return banIds.length;
}

/**
 * Drop a banned member's web-push subscriptions.
 *
 * Push is one of two channels the ban gate cannot reach: it is a server-initiated
 * send to a device endpoint, not a request we get to refuse. Without this a banned
 * member keeps receiving operation alerts, request updates and notification pings —
 * org operational content — on their phone, indefinitely.
 *
 * The other unreachable channel is LIVE VOICE, handled separately in ban:place.
 */
export async function dropPushSubscriptions(userId: number): Promise<void> {
    const { error } = await supabase.from('push_subscriptions')
        .delete()
        .eq('user_id', Number(requireIntId(userId, 'userId')));
    handleSupabaseError({ error, message: 'Failed to clear push subscriptions' });
}
