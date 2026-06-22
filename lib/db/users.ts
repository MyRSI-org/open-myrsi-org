
import { User, ClearanceHistoryEntry, PositionHistoryEntry } from '../../types.js';
import { supabase, handleSupabaseError, broadcastToOrg, getSystemRoles } from './common.js';
import { escapeLikePattern } from '../pgrest.js';
import type { Tables } from './rows.js';
import { toUser, toReputationHistoryEntry, toRatingHistoryEntry } from './mappers.js';
import { getAllSettings } from './system.js';
import { getDiscordMember, pushDiscordRolesForUser, getDiscordUserById, buildGlobalAvatarUrl } from '../discord.js';
import { isValidTimezone, isValidDateFormat } from '../time.js';
import { isAllowedPushEndpoint, MAX_PUSH_SUBSCRIPTIONS_PER_USER } from '../push.js';
import { canViewAllClassifications, type ClearanceUser } from '../clearance.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'db.users' });

async function broadcastUserUpdate(userId?: number) {
    broadcastToOrg('user_update', { userId });
}

/**
 * Log an HR position assignment change in user_hr_position_history. Closes
 * any open row for this user, opens a new row when newPositionId is non-null.
 *
 * Called from every write path that mutates users.position_id — direct
 * updateUser, bulkAssignUsersPosition, processJobApproval — so the unified
 * service-record timeline doesn't lose entries depending on which UI was used.
 *
 * Best-effort: errors are logged and swallowed so a history failure can't
 * block the underlying user update from succeeding.
 */
export async function logHrPositionChange(
    userId: number,
    oldPositionId: number | null,
    newPositionId: number | null,
): Promise<void> {
    if (oldPositionId === newPositionId) return;
    try {
        // Close any open row for this user (single-org: user_id alone scopes it).
        await supabase.from('user_hr_position_history')
            .update({
                ended_at: new Date().toISOString(),
                end_reason: newPositionId === null ? 'unassigned' : 'reassigned',
            })
            .eq('user_id', userId)
            .is('ended_at', null);

        if (newPositionId !== null) {
            await supabase.from('user_hr_position_history').insert({
                user_id: userId,
                position_id: newPositionId,
            });
        }
    } catch (err) {
        log.error('position history log failed', { userId, err });
    }
}

// Lightweight query for list/roster views. Excludes the heavy nested arrays
// (limiting_markers, full certifications, full commendations, conductRecord)
// which are only read in admin/personal detail views — those views lazy-load
// via the user_detail query target.
//
// Kept: specializations (DispatchModal/AddResponderModal show the first 2 spec
// tags inline) and certifications/commendations as ID-only stubs (bulk-award
// modals filter members who already hold a cert/commendation by template id;
// names/dates render in lazy-loaded detail views).
export const USER_LIST_SELECT_QUERY = `
    *,
    role:roles!inner(id, name, description, role_permissions(permission:permissions(name))),
    rank:ranks(*),
    unit:units!unit_id(*),
    position:personnel_positions!position_id(*),
    secondaryPosition:personnel_positions!secondary_position_id(*),
    clearance_level:security_clearances(*),
    specializations:user_specializations(specialization:specialization_tags(*)),
    certifications:user_certifications!user_id(certification:certifications(id)),
    commendations:user_commendations!user_id(commendation:commendations(id))
`;

// Full query for detail views (includes all nested relations)
export const USER_SELECT_QUERY = `
    *,
    role:roles!inner(id, name, description, role_permissions(permission:permissions(name))),
    rank:ranks(*),
    unit:units!unit_id(*),
    position:personnel_positions!position_id(*),
    secondaryPosition:personnel_positions!secondary_position_id(*),
    clearance_level:security_clearances(*),
    limiting_markers:user_limiting_markers(marker:security_limiting_markers(id, name, code, description)),
    specializations:user_specializations(specialization:specialization_tags(*)),
    certifications:user_certifications!user_id(awarded_at, awardedBy:users!awarded_by(id, name, avatar_url), certification:certifications(*)),
    commendations:user_commendations!user_id(id, awarded_at, reason, awardedBy:users!awarded_by(id, name, avatar_url), commendation:commendations(*)),
    conductRecord:conduct_records!user_id(*, enteredBy:users!entered_by_id(id, name, avatar_url))
`;

export async function findUserByDiscordId(discordId: string, includeDeleted = false) {
    let query = supabase.from('users').select(USER_SELECT_QUERY).eq('discord_id', discordId);

    if (!includeDeleted) {
        query = query.is('deleted_at', null);
    }
    const { data, error } = await query.maybeSingle();
    // Warn but don't error if just not found (handleSupabaseError throws)
    if (error && error.code !== 'PGRST116') handleSupabaseError({ error, message: 'Failed to find user' });

    // Data might be null
    if (!data) return null;

    const user = toUser(data);
    if (user && data.deleted_at) {
        (user as User & { deletedAt?: string | null }).deletedAt = data.deleted_at;
    }
    return user;
}

/**
 * Lite multi-row roster fetch backing the realtime `users_slice` query subset.
 * Returns rows in the SAME shape as the getMainState roster
 * (USER_LIST_SELECT_QUERY → toUser, deleted excluded) so the client can splice
 * them into its existing users array when a user_update broadcast carries the
 * affected id(s), instead of refetching the whole 'main' bundle.
 *
 * THROWS on any query error rather than returning [] — the client merge
 * removes requested-but-absent ids (deleted users), so a silent [] on a
 * transient error would mass-evict live users from every connected roster.
 * The resulting 500 makes the client fall back to a full 'main' refetch.
 */
export async function getUsersByIdsLite(userIds: number[]): Promise<User[]> {
    if (!Array.isArray(userIds) || userIds.length === 0) return [];
    const { data, error } = await supabase.from('users')
        .select(USER_LIST_SELECT_QUERY)
        .in('id', userIds)
        .is('deleted_at', null);
    handleSupabaseError({ error, message: 'Failed to get users slice' });
    return (data || []).map(toUser).filter(Boolean) as User[];
}

export async function getUserById(userId: number) {
    // Exclude soft-deleted users. This is the session-resolution query on BOTH
    // api/services.ts (mutations) and api/query.ts (reads) plus op actor/target
    // resolution, so a soft-deleted user must not keep access for the life of
    // their JWT. Reactivation flows go through
    // findUserByDiscordId(includeDeleted)/reactivateUser, not this resolver, so
    // they are unaffected.
    const { data, error } = await supabase.from('users').select(USER_SELECT_QUERY).eq('id', userId).is('deleted_at', null).single();
    if (!error) return toUser(data);
    // Full user query failed (possibly due to missing FK/table from a new migration).
    // Try with the lighter list query as a fallback to avoid breaking auth.
    log.warn('full user query failed, trying fallback', { userId, message: error.message });
    const { data: fallback, error: fbErr } = await supabase.from('users').select(USER_LIST_SELECT_QUERY).eq('id', userId).is('deleted_at', null).single();
    if (!fbErr && fallback) return toUser(fallback);
    return null;
}

export async function getUserByAuthId(authId: string) {
    // Filter deleted_at like getUserById: a soft-deleted/banned user must not
    // resolve to an authenticated session via this fallback resolver either.
    const query = supabase.from('users').select(USER_SELECT_QUERY).eq('auth_user_id', authId).is('deleted_at', null);
    const { data, error } = await query.maybeSingle();
    if (!error) return toUser(data);
    log.warn('full user query failed, trying fallback', { authId, message: error.message });
    const fallbackQuery = supabase.from('users').select(USER_LIST_SELECT_QUERY).eq('auth_user_id', authId).is('deleted_at', null);
    const { data: fallback, error: fbErr } = await fallbackQuery.maybeSingle();
    if (!fbErr && fallback) return toUser(fallback);
    return null;
}

export async function getAdmins() {
    let adminRoleId: number | null = null;
    const sysRoles = await getSystemRoles();
    if (sysRoles.admin) adminRoleId = sysRoles.admin.id;
    if (!adminRoleId) {
        // Global fallback: find highest-ID system role (Admin is always seeded last)
        const { data: globalAdmin } = await supabase.from('roles')
            .select('id').eq('is_system', true).order('id', { ascending: false }).limit(1).maybeSingle();
        if (!globalAdmin) return [];
        adminRoleId = globalAdmin.id;
    }
    const query = supabase.from('users').select(USER_SELECT_QUERY).eq('role_id', adminRoleId).is('deleted_at', null);

    const { data, error } = await query;
    handleSupabaseError({ error, message: 'Failed to find admins' });
    return (data || []).map(toUser).filter(Boolean) as User[];
}

export async function createUser(userData: { discordId: string, name: string, avatarUrl: string, rsiHandle: string, isAdmin: boolean, rsiVerified?: boolean }) {
    // Block duplicate-row account-squatting on discord_id. The public
    // auth:finalize_setup path forwards a client-supplied discordId straight here;
    // without this pre-check an attacker could insert a second users row bound to
    // a victim's Discord snowflake. Fail closed on any existing non-deleted user
    // for the same discord_id.
    if (userData.discordId) {
        const { data: existing, error: existErr } = await supabase.from('users')
            .select('id')
            .eq('discord_id', userData.discordId)
            .is('deleted_at', null)
            .maybeSingle();
        if (existErr) handleSupabaseError({ error: existErr, message: 'Failed to check existing user' });
        if (existing) {
            throw new Error('A user with this Discord account already exists.');
        }
    }

    // One RSI handle maps to one account. Refuse to bind a handle already linked to a
    // live user — blocks impersonation collisions and the absorption of another
    // user's handle-keyed ad-hoc requests (the re-parent below). escapeLikePattern
    // makes the ILIKE an exact, case-insensitive match.
    if (userData.rsiHandle) {
        const { data: handleTaken } = await supabase.from('users')
            .select('id')
            .ilike('rsi_handle', escapeLikePattern(userData.rsiHandle))
            .is('deleted_at', null)
            .maybeSingle();
        if (handleTaken) {
            throw new Error('That RSI handle is already linked to another account.');
        }
    }

    // 1. Determine role via system role helper (is_system flag + ID order)
    const sysRoles = await getSystemRoles();

    let roleId: number;
    if (userData.isAdmin) {
        if (!sysRoles.admin) throw new Error("Organization has no Admin role configured. Seeding error.");
        roleId = sysRoles.admin.id;
    } else {
        if (!sysRoles.client) throw new Error("Organization has no Client role configured. Seeding error.");
        roleId = sysRoles.client.id;
    }

    // Safe lookup for default clearance (Level 1) to prevent FK errors if table is empty
    const { data: defaultClearance } = await supabase.from('security_clearances').select('id').eq('level', 1).maybeSingle();
    const clearanceId = defaultClearance ? defaultClearance.id : null;

    const { data, error } = await supabase.from('users').insert({
        discord_id: userData.discordId,
        name: userData.name,
        avatar_url: userData.avatarUrl,
        rsi_handle: userData.rsiHandle,
        rsi_verified: userData.rsiVerified ?? true,
        role_id: roleId,
        reputation: 50,
        clearance_level_id: clearanceId
    }).select(USER_SELECT_QUERY).single();

    // If creation successful, link any past ad-hoc requests
    if (!error && data) {
        await supabase.from('service_requests')
            .update({ client_id: data.id })
            .ilike('unregistered_client_rsi_handle', escapeLikePattern(userData.rsiHandle))
            .is('client_id', null);

        try {
            /* single-org: no member count recalculation */;
        } catch (err) {
            log.error('member count update failed after user creation', { err });
        }

        await broadcastUserUpdate(data.id);
    }

    handleSupabaseError({ error, message: 'Failed to create user' });
    return toUser(data);
}

// The un-delete-on-login write copies ONLY these display fields from the caller's
// blob — never spread `updates` raw, which could carry role_id / reputation /
// clearance and turn a re-login into a privilege escalation (mass-assignment).
const REACTIVATE_FIELDS = ['name', 'avatar_url'] as const;

export async function reactivateUser(userId: number, updates: Partial<Tables<'users'>>) {
    const safe: Record<string, unknown> = { deleted_at: null };
    for (const f of REACTIVATE_FIELDS) {
        if (updates[f] !== undefined) safe[f] = updates[f];
    }
    const query = supabase.from('users').update(safe).eq('id', userId);

    const { data, error } = await query.select(USER_SELECT_QUERY).single();

    handleSupabaseError({ error, message: 'Failed to reactivate user' });
    return toUser(data);
}

/**
 * Privilege-escalation guard for any code path that mutates a user's role_id.
 *
 * Rules (any failure throws):
 *   1. Actor must hold `admin:user:update_role` (or be the system Admin). The
 *      action `admin:update_user` is gated on the strictly weaker
 *      `admin:user:update` (rank/unit/notes); without this check a `roleId` on
 *      the same payload would let anyone with `admin:user:update` promote
 *      themselves or others to Admin.
 *   2. The system Admin role can only ever be assigned by another Admin.
 *   3. Actor cannot assign a role whose effective tier exceeds their own —
 *      including custom roles whose permissions imply a higher tier (e.g. a
 *      custom role granting `admin:access`).
 */
export async function assertCanAssignRole(actor: Partial<User> | null | undefined, newRoleId: number) {
    if (!actor || !actor.id) throw new Error('Unauthorized: actor identity required to change role');

    const isActorAdmin = actor.role === 'Admin';
    const actorPerms: string[] = Array.isArray(actor.permissions) ? actor.permissions : [];
    if (!isActorAdmin && !actorPerms.includes('admin:user:update_role')) {
        throw new Error('Forbidden: missing admin:user:update_role permission');
    }

    const { data: targetRole, error: tErr } = await supabase.from('roles')
        .select('id, name, is_system')
        .eq('id', newRoleId)
        .maybeSingle();
    if (tErr || !targetRole) throw new Error('Target role not found');

    const sysRoles = await getSystemRoles();
    if (sysRoles.admin && targetRole.id === sysRoles.admin.id && !isActorAdmin) {
        throw new Error('Forbidden: only Admins can assign the Admin role');
    }

    // Tier resolution: system roles map to 1..4 by Client/Member/Dispatcher/Admin
    // order; custom roles are inferred from permissions, mirroring toUser() in
    // mappers.ts so a renamed/custom role can't sneak past by being unranked.
    const sysIds = [sysRoles.client?.id, sysRoles.member?.id, sysRoles.dispatcher?.id, sysRoles.admin?.id];
    const tierOfRole = async (roleId: number): Promise<number> => {
        const idx = sysIds.indexOf(roleId);
        if (idx >= 0) return idx + 1;
        const { data: rolePerms } = await supabase.from('role_permissions')
            .select('permission:permissions(name)')
            .eq('role_id', roleId);
        const names = ((rolePerms || []) as Array<{ permission?: { name?: string } | { name?: string }[] | null }>)
            .map((rp) => (Array.isArray(rp.permission) ? rp.permission[0]?.name : rp.permission?.name))
            .filter(Boolean);
        if (names.includes('admin:access')) return 4;
        if (names.some((n) => n === 'request:dispatch' || n === 'request:triage')) return 3;
        if (names.some((n) => n === 'request:accept' || n === 'user:toggle_duty')) return 2;
        return 1;
    };

    const targetTier = await tierOfRole(targetRole.id);
    const actorTier = await tierOfRole(actor.roleId as number);
    if (targetTier > actorTier) {
        throw new Error('Forbidden: cannot assign a role with higher privileges than your own');
    }
}

/**
 * Resolve a role's effective privilege tier (1=Client … 4=Admin). System roles
 * map by Client/Member/Dispatcher/Admin order; custom/renamed roles are inferred
 * from their permissions, mirroring toUser() in mappers.ts so an unranked role
 * can't sneak past a tier check.
 */
export async function roleTier(roleId: number): Promise<number> {
    const sysRoles = await getSystemRoles();
    const sysIds = [sysRoles.client?.id, sysRoles.member?.id, sysRoles.dispatcher?.id, sysRoles.admin?.id];
    const idx = sysIds.indexOf(roleId);
    if (idx >= 0) return idx + 1;
    const { data: rolePerms } = await supabase.from('role_permissions')
        .select('permission:permissions(name)')
        .eq('role_id', roleId);
    const names = ((rolePerms || []) as Array<{ permission?: { name?: string } | { name?: string }[] | null }>)
        .map((rp) => (Array.isArray(rp.permission) ? rp.permission[0]?.name : rp.permission?.name))
        .filter(Boolean) as string[];
    if (names.includes('admin:access')) return 4;
    if (names.some((n) => n === 'request:dispatch' || n === 'request:triage')) return 3;
    if (names.some((n) => n === 'request:accept' || n === 'user:toggle_duty')) return 2;
    return 1;
}

/**
 * Privilege-escalation guard for WRITING a role's permission set
 * (admin:update_role_permissions). admin:config:roles alone would let a non-Admin
 * "role manager" grant admin:access (or any permission) to their own role and
 * become Admin. Enforce, for non-Admin actors:
 *   (a) No amplification — cannot grant a permission the actor doesn't hold.
 *   (b) Tier ceiling — cannot edit a role at or above the actor's own tier
 *       (which includes the actor's own role).
 */
export async function assertCanManageRolePermissions(
    actor: Partial<User> | null | undefined,
    roleId: number,
    permissionNames: string[],
) {
    if (!actor || !actor.id) throw new Error('Unauthorized: actor identity required to edit role permissions');
    if (actor.role === 'Admin') return; // Admins have full control over role config

    const actorPerms: string[] = Array.isArray(actor.permissions) ? actor.permissions : [];

    const escalating = (permissionNames || []).filter((p) => !actorPerms.includes(p));
    if (escalating.length > 0) {
        throw new Error(`Forbidden: cannot grant permissions you do not hold (${escalating.slice(0, 5).join(', ')})`);
    }

    const targetTier = await roleTier(roleId);
    const actorTier = actor.roleId ? await roleTier(actor.roleId as number) : 1;
    if (targetTier >= actorTier) {
        throw new Error('Forbidden: cannot modify the permissions of a role at or above your own privilege tier');
    }
}

/**
 * Editable user fields accepted by {@link updateUser}, in the camelCase shape
 * the RPC layer forwards. All optional; only present keys are written. The
 * index signature keeps it assignable from the loosely-typed admin payloads
 * (which carry `[key: string]: unknown`) while preserving precise types for
 * the fields this function actually consumes.
 */
interface UpdateUserInput {
    name?: string;
    avatarUrl?: string;
    rsiHandle?: string;
    roleId?: number;
    rankId?: number | null;
    unitId?: number | null;
    clearanceLevelId?: number | null;
    positionId?: number | null;
    secondaryPositionId?: number | null;
    adminNotes?: string | null;
    personnelNotes?: string | null;
    voiceChannelName?: string | null;
    jobTitle?: string | null;
    probationStart?: string | null;
    probationEnd?: string | null;
    tenureStartDate?: string | null;
    [key: string]: unknown;
}

export async function updateUser(userId: number, updates: UpdateUserInput, actor?: Partial<User>) {
    // Privilege-escalation guard: any caller mutating role_id must identify the
    // actor so we can verify they're allowed to assign that specific role.
    if (updates.roleId) {
        if (!actor) throw new Error('updateUser: actor required when changing roleId');
        await assertCanAssignRole(actor, updates.roleId);
    }

    // Get old role/rank/position for member count check, Discord sync, and HR position-history logging.
    let oldRoleId: number | null = null;
    let oldRankId: number | null = null;
    let oldPositionId: number | null = null;
    const needsOldData = updates.roleId || updates.rankId !== undefined || updates.positionId !== undefined;
    if (needsOldData) {
        const { data: userData } = await supabase.from('users').select('role_id, rank_id, position_id').eq('id', userId).single();
        oldRoleId = userData?.role_id || null;
        oldRankId = userData?.rank_id || null;
        oldPositionId = userData?.position_id || null;
    }

    const dbUpdates: Partial<Tables<'users'>> = {};
    if (updates.name) dbUpdates.name = updates.name;
    if (updates.avatarUrl) dbUpdates.avatar_url = updates.avatarUrl;
    if (updates.rsiHandle) dbUpdates.rsi_handle = updates.rsiHandle;
    if (updates.rankId !== undefined) dbUpdates.rank_id = updates.rankId || null;
    if (updates.unitId !== undefined) dbUpdates.unit_id = updates.unitId || null;
    if (updates.clearanceLevelId !== undefined) {
        // A clearance write through the generic profile-edit path must be
        // author-clamped exactly like the dedicated updateUserClearance path —
        // otherwise admin:update_user (weaker than manage_clearance) becomes a
        // back door to grant clearance above the actor's own. Only runs when
        // clearanceLevelId is present (plain profile edits that omit it are
        // unaffected). updateUser writes no markers here.
        await assertCanGrantClearance(actor, updates.clearanceLevelId || null, null);
        dbUpdates.clearance_level_id = updates.clearanceLevelId || null;
    }
    if (updates.positionId !== undefined) dbUpdates.position_id = updates.positionId || null;
    if (updates.secondaryPositionId !== undefined) dbUpdates.secondary_position_id = updates.secondaryPositionId || null;

    if (updates.roleId) {
        // Single-org: no member cap on role changes.
        dbUpdates.role_id = updates.roleId;
    }
    if (updates.adminNotes !== undefined) dbUpdates.admin_notes = updates.adminNotes;
    if (updates.personnelNotes !== undefined) dbUpdates.personnel_notes = updates.personnelNotes;
    if (updates.voiceChannelName !== undefined) dbUpdates.voice_channel_name = updates.voiceChannelName || null;
    if (updates.jobTitle !== undefined) dbUpdates.job_title = updates.jobTitle || null;
    if (updates.probationStart !== undefined) dbUpdates.probation_start = updates.probationStart || null;
    if (updates.probationEnd !== undefined) dbUpdates.probation_end = updates.probationEnd || null;
    // Empty-string clears the override; any non-null/non-empty value sets it.
    if (updates.tenureStartDate !== undefined) dbUpdates.tenure_start_date = updates.tenureStartDate || null;

    const { error } = await supabase.from('users').update(dbUpdates)
        .eq('id', userId)
        .select('id').single();
    handleSupabaseError({ error, message: 'Failed to update user' });

    // HR position history — capture forward-only assignments so the service-record
    // timeline has something to show. Best-effort, swallowed inside the helper.
    if (updates.positionId !== undefined) {
        await logHrPositionChange(userId, oldPositionId, updates.positionId || null);
    }

    await broadcastUserUpdate(userId);

    // Bi-directional Discord sync: push rank/role changes to Discord
    const rankChanged = updates.rankId !== undefined && updates.rankId !== oldRankId;
    const roleChanged = updates.roleId && updates.roleId !== oldRoleId;
    if (rankChanged || roleChanged) {
        pushDiscordRolesForUser(userId, {
            oldRankId,
            newRankId: updates.rankId !== undefined ? (updates.rankId || null) : oldRankId,
            oldRoleId,
            newRoleId: updates.roleId || oldRoleId,
        }).catch(err => log.error('discord background push failed', { userId, err }));
    }
}

/**
 * Read a user's full position history from the unified view (HR + Government,
 * chronological newest-first). Callers without HR-management permission may
 * only fetch their own history (enforced at the action layer).
 */
export async function getUserPositionHistory(userId: number): Promise<PositionHistoryEntry[]> {
    const { data, error } = await supabase
        .from('user_position_history_unified')
        .select('*')
        .eq('user_id', userId)
        .order('started_at', { ascending: false });
    if (error) {
        // 42P01 = view missing (pre-migration); degrade gracefully so the
        // service-record page still renders other sections.
        if (error.code === '42P01') return [];
        handleSupabaseError({ error, message: 'Failed to load position history' });
    }
    type PositionHistoryRow = {
        kind: string;
        id: number;
        user_id: number;
        position_id: number;
        position_name: string;
        position_description: string | null;
        position_icon: string | null;
        started_at: string;
        ended_at: string | null;
        end_reason: string | null;
    };
    return ((data || []) as PositionHistoryRow[]).map((row) => ({
        kind: row.kind as PositionHistoryEntry['kind'],
        id: row.id,
        userId: row.user_id,
        positionId: row.position_id,
        positionName: row.position_name,
        positionDescription: row.position_description || undefined,
        positionIcon: row.position_icon || undefined,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        endReason: row.end_reason,
    }));
}

/**
 * Author-clearance clamp for user clearance GRANTS.
 *
 * A user's clearance level + held limiting markers ARE the read-side visibility
 * key (passesClearance keys off them). Without a clamp, any holder of
 * `admin:user:manage_clearance` (or `admin:user:update`) — delegatable granular
 * catalog permissions, NOT Admin — could grant themselves or a colluder a
 * clearance level / markers ABOVE the granter's own, then read every classified
 * report/bulletin/op/wiki via the normal read paths. Write-side mirror of
 * assertCanClassify, applied to user clearance assignment instead of content
 * labels.
 *
 * Rule (fails closed; only applied when the update actually changes
 * clearance/markers — a plain profile edit must be unaffected):
 *   - Admins and holders of an org-wide all-classifications bypass
 *     (canViewAllClassifications, e.g. `intel:manage`) may grant anything.
 *   - Everyone else: the target LEVEL must be at/below the actor's own clearance
 *     level, and every applied markerId must be one the actor personally holds.
 *
 * `levelId` is the security_clearances PK (FK), NOT the numeric level — it is
 * resolved to its numeric `level` here before comparison.
 */
const CLEARANCE_GRANT_BYPASS = ['intel:manage'];

async function assertCanGrantClearance(
    actor: Partial<User> | null | undefined,
    levelId: number | null | undefined,
    markerIds: number[] | null | undefined,
): Promise<void> {
    if (canViewAllClassifications(actor as ClearanceUser | null | undefined, CLEARANCE_GRANT_BYPASS)) return;

    if (!actor || !actor.id) {
        throw new Error('Unauthorized: actor identity required to change clearance');
    }

    const actorLevel = (actor as ClearanceUser).clearanceLevel?.level ?? 0;

    // Resolve the target clearance FK to its numeric level. A null/0 levelId
    // means "clear clearance" (down to nothing) — always allowed.
    if (levelId) {
        const { data: target, error } = await supabase.from('security_clearances')
            .select('level')
            .eq('id', levelId)
            .maybeSingle();
        if (error || !target) {
            throw new Error('Target clearance level not found');
        }
        const targetLevel = (target as { level?: number | null }).level ?? 0;
        if (targetLevel > actorLevel) {
            throw new Error('You cannot grant a clearance level above your own.');
        }
    }

    if (markerIds && markerIds.length > 0) {
        const held = new Set<string>(
            ((actor as ClearanceUser).limitingMarkers || []).map((m) => {
                if (m && typeof m === 'object') {
                    const o = m as Record<string, unknown>;
                    if (o.id !== undefined && o.id !== null) return String(o.id);
                    if (o.code !== undefined && o.code !== null) return String(o.code);
                    if (o.name !== undefined && o.name !== null) return String(o.name);
                }
                return String(m);
            }),
        );
        for (const mid of markerIds) {
            if (mid === undefined || mid === null) continue;
            if (!held.has(String(mid))) {
                throw new Error('You cannot grant a limiting marker you do not hold.');
            }
        }
    }
}

export async function updateUserClearance(userId: number, adminId: number, levelId: number | null, markerIds: number[], actor?: Partial<User>) {
    // Author-clamp the requested grant against the acting user's own
    // clearance/markers (Admin / all-classifications bypass exempt).
    await assertCanGrantClearance(actor, levelId, markerIds);


    // 1. Get old data for history
    const { data: user } = await supabase.from('users').select('clearance_level_id').eq('id', userId).single();
    if (!user) throw new Error('User not found');
    const oldLevelId = user.clearance_level_id;

    // 2. Update Level
    const { error: userError } = await supabase.from('users').update({ clearance_level_id: levelId || null })
        .eq('id', userId);
    handleSupabaseError({ error: userError, message: 'Failed to update clearance level' });

    // 3. Update Markers (Delete old, insert new)
    const { error: delError } = await supabase.from('user_limiting_markers').delete().eq('user_id', userId);
    handleSupabaseError({ error: delError, message: 'Failed to clear old markers' });

    if (markerIds.length > 0) {
        const { error: insError } = await supabase.from('user_limiting_markers').insert(
            markerIds.map(mid => ({ user_id: userId, marker_id: mid }))
        );
        handleSupabaseError({ error: insError, message: 'Failed to insert new markers' });
    }

    // 4. Log History
    await supabase.from('clearance_history').insert({
        user_id: userId,
        admin_id: adminId,
        old_level_id: oldLevelId,
        new_level_id: levelId,
        changes_description: `Updated Clearance Level. Markers set to: [${markerIds.join(', ')}]`
    });
    await broadcastUserUpdate(userId);
}

// Bulk version of updateUserClearance. Loops the same per-user contract
// (level update + marker write + clearance_history audit row) so the audit
// grain stays one-row-per-user. Differences vs the single-user path:
//   - levelId === undefined leaves the level alone (single-user always sets it)
//   - markerMode='add' uses ON CONFLICT DO NOTHING instead of delete-then-insert
//   - unknown user IDs in the payload are skipped, not thrown — partial
//     success is returned so the UI can toast "Updated X of Y"
//   - one broadcastUserUpdate at the end (with bulk:true marker), not per user
export async function bulkUpdateUserClearances(
    targetUserIds: number[],
    adminId: number,
    levelId: number | null | undefined,
    markerIds: number[],
    markerMode: 'replace' | 'add',
    actor?: Partial<User>,
): Promise<{ updated: number; total: number }> {
    if (!Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return { updated: 0, total: 0 };
    }
    if (markerMode !== 'replace' && markerMode !== 'add') {
        throw new Error('bulkUpdateUserClearances: markerMode must be "replace" or "add"');
    }

    // Author-clamp the requested grant once up front (the requested level +
    // markers are constant across the batch). Throws before any write if the actor
    // is granting above their own clearance / unheld markers. levelId === undefined
    // means "leave level alone" — no level grant to clamp.
    await assertCanGrantClearance(actor, levelId ?? null, markerIds);

    let updated = 0;
    // Successfully-updated ids only — shipped on the bulk broadcast so clients
    // can slice-refetch just these rows. Skipped/failed ids must NOT be
    // included (the client merge evicts requested-but-absent ids).
    const updatedIds: number[] = [];

    for (const userId of targetUserIds) {
        try {
            // Skip rather than throw so an unknown id in the array doesn't
            // abort the whole batch.
            const { data: user } = await supabase
                .from('users')
                .select('clearance_level_id')
                .eq('id', userId)
                .single();
            if (!user) {
                log.warn('bulkUpdateUserClearances skipping unknown user', { userId });
                continue;
            }
            const oldLevelId = user.clearance_level_id;

            // 1. Level update (skip when undefined; null = clear)
            let newLevelForHistory: number | null = oldLevelId;
            if (levelId !== undefined) {
                const { error: userError } = await supabase
                    .from('users')
                    .update({ clearance_level_id: levelId || null })
                    .eq('id', userId);
                if (userError) {
                    log.error('bulkUpdateUserClearances level update failed', { userId, err: userError });
                    continue;
                }
                newLevelForHistory = levelId ?? null;
            }

            // 2. Marker write (branched by mode)
            if (markerMode === 'replace') {
                const { error: delError } = await supabase
                    .from('user_limiting_markers')
                    .delete()
                    .eq('user_id', userId);
                if (delError) {
                    log.error('bulkUpdateUserClearances marker clear failed', { userId, err: delError });
                    continue;
                }
                if (markerIds.length > 0) {
                    const { error: insError } = await supabase
                        .from('user_limiting_markers')
                        .insert(markerIds.map(mid => ({ user_id: userId, marker_id: mid })));
                    if (insError) {
                        log.error('bulkUpdateUserClearances marker insert failed', { userId, err: insError });
                        continue;
                    }
                }
            } else if (markerIds.length > 0) {
                // 'add' mode — upsert with conflict-do-nothing so re-adding
                // an existing marker is a no-op. (user_id, marker_id) is the PK.
                const { error: upsertError } = await supabase
                    .from('user_limiting_markers')
                    .upsert(
                        markerIds.map(mid => ({ user_id: userId, marker_id: mid })),
                        { onConflict: 'user_id,marker_id', ignoreDuplicates: true }
                    );
                if (upsertError) {
                    log.error('bulkUpdateUserClearances marker upsert failed', { userId, err: upsertError });
                    continue;
                }
            }

            // 3. Audit row — one per user, same shape as single-user path so
            // getClearanceHistory(userId) returns identical rendering.
            const levelChanged = levelId !== undefined && levelId !== oldLevelId;
            const description = `${levelChanged ? 'Updated Clearance Level. ' : ''}Markers ${markerMode === 'replace' ? 'set to' : 'added'}: [${markerIds.join(', ')}] (bulk).`;
            await supabase.from('clearance_history').insert({
                user_id: userId,
                admin_id: adminId,
                old_level_id: oldLevelId,
                new_level_id: newLevelForHistory,
                changes_description: description,
            });

            updated++;
            updatedIds.push(userId);
        } catch (err) {
            log.error('bulkUpdateUserClearances unexpected error', { userId, err });
        }
    }

    // Single broadcast for the whole batch. userIds lets clients refetch only
    // the affected roster rows (users_slice) instead of the whole main subset;
    // bounded by BULK_ACTION_MAX so the payload stays small.
    await broadcastToOrg('user_update', { bulk: true, count: updated, userIds: updatedIds });

    return { updated, total: targetUserIds.length };
}

/**
 * Demote each of `targetUserIds` to the org's Client role. Per-user errors are
 * caught and counted as `skipped` rather than aborting the batch — the UI
 * surfaces the partial-success counts to the admin.
 *
 * Tier hierarchy guard: the per-user updateUser invokes assertCanAssignRole,
 * which permits demoting downward (Client is tier 1) by any actor at or above
 * tier 2 (Member) and blocks Admins demoting other Admins.
 */
// Defensive upper bound on a single bulk call. Clients chunk at 25; 100 is
// headroom for direct API consumers and a circuit breaker against accidental
// 10k-target requests slamming the DB.
const BULK_ACTION_MAX = 100;

function assertBulkSize(targetUserIds: number[], fnName: string): void {
    if (!Array.isArray(targetUserIds) || targetUserIds.length === 0) return;
    if (targetUserIds.length > BULK_ACTION_MAX) {
        throw new Error(`${fnName}: bulk action capped at ${BULK_ACTION_MAX} users per call (got ${targetUserIds.length}).`);
    }
}

export async function bulkDemoteUsersToClient(
    targetUserIds: number[],
    actor: Partial<User>,
): Promise<{ updated: number; total: number; skipped: number }> {
    assertBulkSize(targetUserIds, 'bulkDemoteUsersToClient');
    if (!Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return { updated: 0, total: 0, skipped: 0 };
    }

    const systemRoles = await getSystemRoles();
    if (!systemRoles.client) {
        throw new Error('bulkDemoteUsersToClient: no Client system role configured for this org');
    }
    const clientRoleId = systemRoles.client.id;

    // Hoisted role-assignment check — tier hierarchy and permission gate
    // are constant across the batch since the target role is fixed.
    await assertCanAssignRole(actor, clientRoleId);

    let updated = 0;
    let skipped = 0;
    const updatedIds: number[] = [];

    for (const userId of targetUserIds) {
        try {
            const { data: user } = await supabase
                .from('users')
                .select('role_id')
                .eq('id', userId)
                
                .maybeSingle();
            if (!user) {
                log.warn('bulkDemoteUsersToClient skipping user not in org', { userId });
                skipped++;
                continue;
            }
            if (user.role_id === clientRoleId) {
                skipped++;
                continue;
            }
            const { error } = await supabase
                .from('users')
                .update({ role_id: clientRoleId })
                .eq('id', userId)
                ;
            if (error) {
                log.warn('bulkDemoteUsersToClient update failed', { userId, message: error.message });
                skipped++;
                continue;
            }
            updated++;
            updatedIds.push(userId);
        } catch (err) {
            log.warn('bulkDemoteUsersToClient skipped user', { userId, message: err instanceof Error ? err.message : String(err) });
            skipped++;
        }
    }

    if (updated > 0) {
        try { /* single-org: no member count recalculation */; } catch (e) { log.error('bulkDemoteUsersToClient updateOrgMemberCount failed', { err: e }); }
    }
    await broadcastToOrg('user_update', { bulk: true, count: updated, userIds: updatedIds });

    return { updated, total: targetUserIds.length, skipped };
}

/**
 * Promote N selected Client/lower-tier users to the org's Member role.
 */
export async function bulkPromoteUsersToMember(
    targetUserIds: number[],
    actor: Partial<User>,
): Promise<{ updated: number; total: number; skipped: number }> {
    assertBulkSize(targetUserIds, 'bulkPromoteUsersToMember');
    if (!Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return { updated: 0, total: 0, skipped: 0 };
    }

    const systemRoles = await getSystemRoles();
    if (!systemRoles.member) {
        throw new Error('bulkPromoteUsersToMember: no Member system role configured for this org');
    }
    const memberRoleId = systemRoles.member.id;

    await assertCanAssignRole(actor, memberRoleId);

    // Single-org: no member cap on bulk promotion.
    let updated = 0;
    let skipped = 0;
    const updatedIds: number[] = [];

    for (const userId of targetUserIds) {
        try {
            const { data: user } = await supabase
                .from('users')
                .select('role_id')
                .eq('id', userId)
                
                .maybeSingle();
            if (!user) { skipped++; continue; }
            if (user.role_id === memberRoleId) { skipped++; continue; }
            const { error } = await supabase
                .from('users')
                .update({ role_id: memberRoleId })
                .eq('id', userId)
                ;
            if (error) {
                log.warn('bulkPromoteUsersToMember update failed', { userId, message: error.message });
                skipped++;
                continue;
            }
            updated++;
            updatedIds.push(userId);
        } catch (err) {
            log.warn('bulkPromoteUsersToMember skipped user', { userId, message: err instanceof Error ? err.message : String(err) });
            skipped++;
        }
    }

    if (updated > 0) {
        try { /* single-org: no member count recalculation */; } catch (e) { log.error('bulkPromoteUsersToMember updateOrgMemberCount failed', { err: e }); }
    }
    await broadcastToOrg('user_update', { bulk: true, count: updated, userIds: updatedIds });

    return { updated, total: targetUserIds.length, skipped };
}

/**
 * Set the is_affiliate or is_vip flag to a fixed value on a batch of users.
 * An explicit setter (rather than a bulk toggle) avoids inconsistent outcomes on
 * a mixed-state selection. Per-user guards: target must exist; Client-tier-only
 * (matches the single-user toggle); skip no-op writes (already at value).
 */
async function bulkSetUsersClientFlag(
    targetUserIds: number[],
    flag: 'is_affiliate' | 'is_vip',
    value: boolean,
): Promise<{ updated: number; total: number; skipped: number }> {
    assertBulkSize(targetUserIds, 'bulkSetUsersClientFlag');
    if (!Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return { updated: 0, total: 0, skipped: 0 };
    }

    const systemRoles = await getSystemRoles();
    const clientRoleId = systemRoles.client?.id;
    if (!clientRoleId) {
        throw new Error('bulkSetUsersClientFlag: no Client system role configured for this org');
    }

    let updated = 0;
    let skipped = 0;
    const updatedIds: number[] = [];

    for (const userId of targetUserIds) {
        try {
            const { data: user } = await supabase
                .from('users')
                .select(`role_id, ${flag}`)
                .eq('id', userId)
                
                .maybeSingle();
            if (!user) { skipped++; continue; }
            const userRow = user as { role_id: number | null; is_affiliate?: boolean | null; is_vip?: boolean | null };
            if (userRow.role_id !== clientRoleId) { skipped++; continue; }   // Client-only
            if (userRow[flag] === value) { skipped++; continue; }              // no-op
            const { error } = await supabase
                .from('users')
                .update({ [flag]: value })
                .eq('id', userId)
                ;
            if (error) { skipped++; continue; }
            updated++;
            updatedIds.push(userId);
        } catch (err) {
            log.warn('bulkSetUsersClientFlag skipped user', { userId, message: err instanceof Error ? err.message : String(err) });
            skipped++;
        }
    }

    await broadcastToOrg('user_update', { bulk: true, count: updated, userIds: updatedIds });
    return { updated, total: targetUserIds.length, skipped };
}

export async function bulkSetUsersAffiliate(targetUserIds: number[], value: boolean) {
    return bulkSetUsersClientFlag(targetUserIds, 'is_affiliate', value);
}

export async function bulkSetUsersVip(targetUserIds: number[], value: boolean) {
    return bulkSetUsersClientFlag(targetUserIds, 'is_vip', value);
}

/**
 * Internal helper for assign-unit/rank/position bulk actions. Validates the
 * assigned id exists once at the top, then loops a direct UPDATE per user — so a
 * 100-user batch is one validation query and 100 small writes.
 */
async function bulkAssignUsersScalar(
    targetUserIds: number[],
    column: 'unit_id' | 'rank_id' | 'position_id',
    valueId: number | null,
    validateTable: 'units' | 'ranks' | 'personnel_positions' | null,
    fnName: string,
): Promise<{ updated: number; total: number; skipped: number }> {
    assertBulkSize(targetUserIds, fnName);
    if (!Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return { updated: 0, total: 0, skipped: 0 };
    }

    // Validate the assigned id exists (or is null = clear).
    if (valueId != null && validateTable) {
        const { data: ref } = await supabase
            .from(validateTable)
            .select('id')
            .eq('id', valueId)
            .maybeSingle();
        if (!ref) throw new Error(`${fnName}: target ${validateTable} id not found`);
    }

    let updated = 0;
    let skipped = 0;
    const updatedIds: number[] = [];

    for (const userId of targetUserIds) {
        try {
            const { data: user } = await supabase
                .from('users')
                .select(column)
                .eq('id', userId)
                .maybeSingle();
            if (!user) { skipped++; continue; }
            const oldVal = (user as Record<typeof column, number | null>)[column];
            if (oldVal === valueId) { skipped++; continue; }    // no-op
            const { error } = await supabase
                .from('users')
                .update({ [column]: valueId })
                .eq('id', userId)
                ;
            if (error) { skipped++; continue; }
            // Log HR position changes so the unified service-record timeline
            // sees bulk reassignments, not just AdminUserDetailView saves.
            if (column === 'position_id') {
                await logHrPositionChange(userId, oldVal, valueId);
            }
            updated++;
            updatedIds.push(userId);
        } catch (err) {
            log.warn('bulkAssignUsersScalar skipped user', { fnName, userId, message: err instanceof Error ? err.message : String(err) });
            skipped++;
        }
    }

    await broadcastToOrg('user_update', { bulk: true, count: updated, userIds: updatedIds });
    return { updated, total: targetUserIds.length, skipped };
}

export async function bulkAssignUsersUnit(targetUserIds: number[], unitId: number | null) {
    return bulkAssignUsersScalar(targetUserIds, 'unit_id', unitId, 'units', 'bulkAssignUsersUnit');
}

export async function bulkAssignUsersRank(targetUserIds: number[], rankId: number | null) {
    return bulkAssignUsersScalar(targetUserIds, 'rank_id', rankId, 'ranks', 'bulkAssignUsersRank');
}

export async function bulkAssignUsersPosition(targetUserIds: number[], positionId: number | null) {
    return bulkAssignUsersScalar(targetUserIds, 'position_id', positionId, 'personnel_positions', 'bulkAssignUsersPosition');
}

export async function getClearanceHistory(userId: number): Promise<ClearanceHistoryEntry[]> {
    const { data } = await supabase.from('clearance_history')
        .select('*, admin:users!clearance_history_admin_id_fkey(name), oldLevel:security_clearances!clearance_history_old_level_id_fkey(name), newLevel:security_clearances!clearance_history_new_level_id_fkey(name)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    type NameEmbed = { name?: string | null } | { name?: string | null }[] | null | undefined;
    type ClearanceHistoryRow = Tables<'clearance_history'> & {
        admin?: NameEmbed;
        oldLevel?: NameEmbed;
        newLevel?: NameEmbed;
    };
    const embedName = (e: NameEmbed): string | undefined =>
        (Array.isArray(e) ? e[0]?.name : e?.name) ?? undefined;
    return ((data || []) as ClearanceHistoryRow[]).map((entry) => ({
        id: entry.id,
        userId: entry.user_id as number,
        adminId: entry.admin_id as number,
        adminName: embedName(entry.admin) || 'Unknown',
        oldLevelId: entry.old_level_id ?? undefined,
        newLevelId: entry.new_level_id ?? undefined,
        oldLevelName: embedName(entry.oldLevel),
        newLevelName: embedName(entry.newLevel),
        changesDescription: entry.changes_description as string,
        createdAt: entry.created_at
    }));
}

export async function deleteUser(userId: number) {
    // Verify target exists before anonymising.
    const { data: userData } = await supabase.from('users').select('id').eq('id', userId).maybeSingle();
    if (!userData) throw new Error('User not found');

    // Anonymise display identity but retain discord_id and rsi_handle for abuse
    // prevention (reputation integrity, ban-evasion detection).
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
        deleted_at: now,
        name: 'Deleted User',
        avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png',
        voice_channel_name: null,
        is_duty: false,
        // Invalidate the removed user's live sessions immediately — getUserById
        // already filters deleted_at, but stamping the watermark is belt-and-braces
        // (and covers any path that resolves the user without that filter).
        tokens_valid_from: now,
    };
    let { error } = await supabase.from('users').update(updates).eq('id', userId);
    // Soft-fail if tokens_valid_from predates the schema redeploy.
    const code = (error as { code?: string } | null)?.code;
    if (error && (code === '42703' || code === 'PGRST204')) {
        delete updates.tokens_valid_from;
        ({ error } = await supabase.from('users').update(updates).eq('id', userId));
    }
    handleSupabaseError({ error, message: 'Failed to delete user' });

    await broadcastUserUpdate(userId);
}

/**
 * Revoke a single user's live sessions by advancing their tokens_valid_from
 * watermark to now — every HMAC token issued before this is then 401'd
 * (force_logout) by the dispatcher. For a compromised/leaked token of a member
 * who should stay active (unlike deleteUser, which also removes them).
 */
export async function revokeUserSessions(targetUserId: number): Promise<void> {
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) throw new Error('Invalid user id.');
    const { data: target } = await supabase.from('users').select('id').eq('id', targetUserId).maybeSingle();
    if (!target) throw new Error('User not found.');
    const { error } = await supabase.from('users')
        .update({ tokens_valid_from: new Date().toISOString() }).eq('id', targetUserId);
    handleSupabaseError({ error, message: 'Failed to revoke user sessions' });
    await broadcastUserUpdate(targetUserId);
}

/**
 * Slim presence subset returned for realtime duty-flip refreshes. The result is
 * patched into existing allUsers client-side rather than replacing it. Two
 * parallel one-column queries instead of getMainState's 44-column-per-user
 * fan-out.
 */
export async function getUsersPresenceState(): Promise<{ usersPresence: Array<{ userId: number; isDuty: boolean; lastActiveAt: string | null }> }> {

    const [usersRes, presenceRes] = await Promise.all([
        supabase
            .from('users')
            .select('id, is_duty')
            
            .is('deleted_at', null),
        supabase
            .from('user_presence')
            .select('user_id, last_active_at')
            ,
    ]);

    if (usersRes.error) {
        log.warn('users presence query failed', { err: usersRes.error });
        return { usersPresence: [] };
    }

    const presenceMap = new Map<number, string | null>();
    for (const row of (presenceRes.data || []) as Array<Pick<Tables<'user_presence'>, 'user_id' | 'last_active_at'>>) {
        presenceMap.set(row.user_id, row.last_active_at ?? null);
    }

    const usersPresence = ((usersRes.data || []) as Array<Pick<Tables<'users'>, 'id' | 'is_duty'>>).map((u) => ({
        userId: u.id,
        isDuty: !!u.is_duty,
        lastActiveAt: presenceMap.get(u.id) ?? null,
    }));

    return { usersPresence };
}

// Visual flags for Client users only (affiliate / VIP). Both columns share the
// same toggle contract via _toggleClientFlag — the helper enforces the
// Client-role check, so direct API callers can't flag staff or other roles.
// See migrations/add-user-affiliate-vip.sql.
export async function toggleUserAffiliateStatus(userId: number) {
    return _toggleClientFlag('is_affiliate', userId);
}
export async function toggleUserVipStatus(userId: number) {
    return _toggleClientFlag('is_vip', userId);
}

async function _toggleClientFlag(column: 'is_affiliate' | 'is_vip', userId: number) {

    const { data: user } = await supabase
        .from('users')
        .select(`id, role_id, ${column}`)
        .eq('id', userId)
        
        .maybeSingle();
    if (!user) {
        const err: Error & { code?: string } = new Error('User not found in organization.');
        err.code = 'USER_NOT_FOUND';
        throw err;
    }
    const userRow = user as { id: number; role_id: number | null; is_affiliate?: boolean | null; is_vip?: boolean | null };

    // Client-only enforcement: target must hold the org's Client system role.
    const systemRoles = await getSystemRoles();
    if (!systemRoles.client || userRow.role_id !== systemRoles.client.id) {
        const err: Error & { code?: string } = new Error('Affiliate / VIP flags can only be set on Client users.');
        err.code = 'NOT_A_CLIENT';
        throw err;
    }

    const next = !userRow[column];
    const { error } = await supabase.from('users').update({ [column]: next })
        .eq('id', userId)
        ;
    handleSupabaseError({ error, message: `Failed to toggle ${column}` });

    broadcastToOrg('user_update', { userId });
    return column === 'is_affiliate' ? { isAffiliate: next } : { isVip: next };
}

export async function toggleUserDutyStatus(userId: number) {
    const { data } = await supabase.from('users').select('is_duty')
        .eq('id', userId)
        
        .maybeSingle();
    if (!data) return; // silent no-op if not found

    const newStatus = !data.is_duty;

    const { error } = await supabase.from('users').update({ is_duty: newStatus })
        .eq('id', userId)
        ;
    handleSupabaseError({ error, message: 'Failed to toggle duty status' });

    // last_active_at lives on user_presence (not on users) to keep heartbeat-
    // style writes off the supabase_realtime publication. We refresh it when
    // the user goes ON duty so the duty cleanup sweep doesn't immediately
    // clear them.
    if (newStatus) {
        await supabase.from('user_presence')
            .upsert(
                { user_id: userId, last_active_at: new Date().toISOString() },
                { onConflict: 'user_id' }
            );
    }

    // Broadcast update to bypass RLS latency/restrictions
    broadcastToOrg('duty_update', { userId, status: newStatus });
}

export async function updateUserHeartbeat(userId: number) {
    // Heartbeat writes go to user_presence, NOT users. user_presence is
    // intentionally excluded from the supabase_realtime publication so this
    // write does not fan out to every connected client. See
    // migrations/add-user-presence.sql for context.
    const { error } = await supabase.from('user_presence')
        .update({ last_active_at: new Date().toISOString() })
        .eq('user_id', userId);
    if (error) log.warn('heartbeat update failed', { err: error });

    // Fire-and-forget lazy avatar refresh. Rate-limited to once per 24h per user
    // so this doesn't hammer Discord's bot API under normal heartbeat frequency.
    refreshAvatarIfStale(userId).catch((err) => {
        log.warn('avatar lazy refresh failed', { userId, err });
    });

    // Single-org: force-logout lives in the `settings` table under the
    // 'platformSettings' JSONB blob (lib/db/platform.ts), NOT a separate
    // platform_settings table (that multi-tenant table was dropped).
    const { data: settingRow } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'platformSettings')
        .maybeSingle();
    const platform = settingRow?.value as { force_logout_timestamp?: string } | null;
    return { force_logout_timestamp: platform?.force_logout_timestamp || null };
}

// Persist a freshly-resolved avatar URL for a user. Used by the OAuth callback
// when a user logs in and their current Discord avatar hash differs from what
// we have cached. avatar_url stays on users (legitimate fanout when it
// actually changes); avatar_refreshed_at lives on user_presence.
export async function refreshUserAvatar(userId: number, avatarUrl: string): Promise<void> {
    const { error } = await supabase.from('users')
        .update({ avatar_url: avatarUrl })
        .eq('id', userId);
    if (error) throw error;
    await supabase.from('user_presence')
        .update({ avatar_refreshed_at: new Date().toISOString() })
        .eq('user_id', userId);
}

const AVATAR_REFRESH_STALE_MS = 24 * 60 * 60 * 1000;

// Pulls the user's current global Discord avatar via the org's bot token and
// updates the cached URL if it has drifted. Silently no-ops when:
//   - the cache is fresh (< 24h since last refresh),
//   - the user has no discord_id,
//   - no org bot token is configured,
//   - Discord returns 404 (bot no longer shares a guild with the user), or
//   - the resolved URL matches what we already have.
// The global avatarFallback handler in lib/avatarFallback.ts covers the UI in
// the meantime, so refresh failures never surface as broken images.
async function refreshAvatarIfStale(userId: number): Promise<void> {
    const { data: row, error } = await supabase.from('users')
        .select('id, discord_id, avatar_url')
        .eq('id', userId)
        .maybeSingle();
    if (error || !row || !row.discord_id) return;

    const { data: presenceRow } = await supabase.from('user_presence')
        .select('avatar_refreshed_at')
        .eq('user_id', userId)
        .maybeSingle();
    const refreshedAt = presenceRow?.avatar_refreshed_at as string | null | undefined;
    if (refreshedAt) {
        const last = new Date(refreshedAt).getTime();
        if (Number.isFinite(last) && Date.now() - last < AVATAR_REFRESH_STALE_MS) return;
    }

    let discordUser: { id?: string; avatar?: string | null; discriminator?: string | null } | undefined;
    try {
        discordUser = await getDiscordUserById(row.discord_id);
    } catch {
        // Bot token not configured, or bot no longer shares a guild with the user.
        // Stamp the timestamp so we don't retry every heartbeat — next attempt in 24h.
        await supabase.from('user_presence')
            .update({ avatar_refreshed_at: new Date().toISOString() })
            .eq('user_id', userId);
        return;
    }
    if (!discordUser?.id) return;

    const freshUrl = buildGlobalAvatarUrl(discordUser as { id: string; avatar?: string | null; discriminator?: string | null });
    if (freshUrl && freshUrl !== row.avatar_url) {
        await supabase.from('users').update({ avatar_url: freshUrl }).eq('id', userId);
    }
    await supabase.from('user_presence')
        .update({ avatar_refreshed_at: new Date().toISOString() })
        .eq('user_id', userId);
}

export async function cleanupInactiveDutyUsers() {
    // Single-org: one global pass over all on-duty users.
    const allCleaned: Array<Pick<Tables<'users'>, 'id' | 'name'>> = [];

    try {
        const { brandingConfig } = await getAllSettings({ decryptSecrets: false });
        const timeoutMins = brandingConfig.dutyTimeoutMinutes || 30;
        const cutoff = new Date(Date.now() - timeoutMins * 60 * 1000).toISOString();

        // last_active_at moved to user_presence — pre-resolve the set of
        // user IDs whose presence timestamp is older than the cutoff and
        // then clear is_duty on the matching users in a second query.
        const { data: stalePresence, error: presenceErr } = await supabase
            .from('user_presence')
            .select('user_id')
            .lt('last_active_at', cutoff);
        if (presenceErr) {
            log.error('reading stale presence failed', { err: presenceErr });
            return allCleaned;
        }
        const staleIds = ((stalePresence || []) as Array<Pick<Tables<'user_presence'>, 'user_id'>>).map((p) => p.user_id);
        if (staleIds.length === 0) return allCleaned;

        const { data, error } = await supabase
            .from('users')
            .update({ is_duty: false })
            .eq('is_duty', true)
            .in('id', staleIds)
            .select('id, name');

        if (error) log.error('duty user cleanup failed', { err: error });
        if (data && data.length > 0) {
            allCleaned.push(...data);
            broadcastToOrg('duty_update', { cleanup: true });
        }
    } catch (err) {
        log.error('duty cleanup processing failed', { err });
    }
    return allCleaned;
}

export async function initiateRsiHandleUpdate(userId: number, newHandle: string) {
    const { brandingConfig } = await getAllSettings({ decryptSecrets: false });
    // Whitelabel prefix based on org name
    const prefix = brandingConfig.name ? brandingConfig.name.substring(0, 6).toUpperCase().replace(/[^A-Z]/g, '') : 'ORG';
    const code = `${prefix}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    const { error } = await supabase.from('users').update({
        rsi_handle_pending: newHandle,
        rsi_verification_code: code
    }).eq('id', userId);
    handleSupabaseError({ error, message: 'Failed to initiate RSI handle update' });
    return { code };
}

export async function verifyRsiUpdate(userId: number) {
    const { data: user, error: fetchError } = await supabase.from('users').select('rsi_handle_pending, rsi_verification_code').eq('id', userId).single();

    if (fetchError) {
        handleSupabaseError({ error: fetchError, message: 'Failed to fetch user verification data' });
        return;
    }

    if (!user || !user.rsi_handle_pending || !user.rsi_verification_code) {
        throw new Error("No pending verification found.");
    }

    const { error: updateError } = await supabase.from('users').update({
        rsi_handle: user.rsi_handle_pending,
        rsi_handle_pending: null,
        rsi_verification_code: null,
        rsi_verified: true
    }).eq('id', userId);

    if (!updateError) {
        // Link any past requests that match the new handle
        await supabase.from('service_requests')
            .update({ client_id: userId })
            .ilike('unregistered_client_rsi_handle', escapeLikePattern(user.rsi_handle_pending))
            .is('client_id', null);
    }

    if (updateError) {
        handleSupabaseError({ error: updateError, message: 'Failed to update RSI handle' });
    }
}

export async function cancelRsiUpdate(userId: number) {
    const { error } = await supabase.from('users').update({
        rsi_handle_pending: null,
        rsi_verification_code: null
    }).eq('id', userId);
    handleSupabaseError({ error, message: 'Failed to cancel RSI update' });
}

/**
 * Set or clear the user's custom display name. `null` / empty string = clear
 * (the app then falls back to the Discord-sourced name via the toUser() mapper).
 * This column is user-owned and intentionally NOT touched by syncUserRoles.
 */
export async function updateUserDisplayName(userId: number, displayName: string | null | undefined) {
    const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
    if (trimmed.length > 32) throw new Error('Display name must be 32 characters or fewer.');
    const { error } = await supabase.from('users')
        .update({ display_name: trimmed || null })
        .eq('id', userId);
    handleSupabaseError({ error, message: 'Failed to update display name' });
}

/**
 * Set the user's timezone and/or date format preset. Either may be `null` to
 * clear the override (the client then falls back to the browser's zone and
 * the `compact_12h` preset). Validates strictly — invalid values are rejected
 * rather than silently coerced.
 *
 * `preferences` is an explicit subset: only the keys present are written, so
 * the timezone and date_format columns can be updated independently.
 */
export async function updateUserPreferences(
    userId: number,
    preferences: { timezone?: string | null; dateFormat?: string | null },
) {
    const update: Record<string, string | null> = {};

    if (Object.prototype.hasOwnProperty.call(preferences, 'timezone')) {
        const tz = preferences.timezone;
        if (tz === null || tz === '' || typeof tz === 'undefined') {
            update.timezone = null;
        } else if (typeof tz === 'string' && isValidTimezone(tz)) {
            update.timezone = tz;
        } else {
            throw new Error('Invalid timezone. Provide a valid IANA name (e.g. Europe/London) or null to reset.');
        }
    }

    if (Object.prototype.hasOwnProperty.call(preferences, 'dateFormat')) {
        const fmt = preferences.dateFormat;
        if (fmt === null || fmt === '' || typeof fmt === 'undefined') {
            update.date_format = null;
        } else if (isValidDateFormat(fmt)) {
            update.date_format = fmt;
        } else {
            throw new Error('Invalid date format. Use compact_12h, iso_24h, us_12h, or null to reset.');
        }
    }

    if (Object.keys(update).length === 0) return;

    const { error } = await supabase.from('users').update(update).eq('id', userId);
    handleSupabaseError({ error, message: 'Failed to update preferences' });
}

export async function updateUserSpecializations(userId: number, specializationIds: number[]) {
    const { error: deleteError } = await supabase.from('user_specializations').delete().eq('user_id', userId);
    handleSupabaseError({ error: deleteError, message: 'Failed to clear specializations' });
    if (specializationIds.length > 0) {
        const { error: insertError } = await supabase.from('user_specializations').insert(
            specializationIds.map(id => ({ user_id: userId, specialization_id: id }))
        );
        handleSupabaseError({ error: insertError, message: 'Failed to add specializations' });
    }
}

export async function adminAdjustUserReputation(userId: number, newReputation: number, adminId: number, reason: string) {
    // Verify the user exists before adjusting.
    const { data: user } = await supabase.from('users').select('id').eq('id', userId).maybeSingle();
    if (!user) throw new Error('User not found in this organization');

    const { error } = await supabase.rpc('admin_adjust_reputation', {
        user_id_in: userId,
        new_reputation_in: newReputation,
        admin_id_in: adminId,
        reason_in: reason
    });
    handleSupabaseError({ error, message: 'Failed to adjust reputation' });
}

export async function getReputationHistoryForUser(userId: number) {
    const { data, error } = await supabase.from('reputation_history')
        .select('*, adminUser:users!reputation_history_admin_user_id_fkey(id, name, avatar_url)')
        .eq('user_id', userId)
        .order('change_date', { ascending: false });
    handleSupabaseError({ error, message: 'Failed to get reputation history' });
    return (data || []).map(toReputationHistoryEntry);
}

export async function getRatingHistoryForUser(userId: number) {
    const { data: participation, error: partError } = await supabase.from('request_responders').select('request_id').eq('user_id', userId);
    if (partError) throw new Error(partError.message);
    const requestIds = (participation as Array<Pick<Tables<'request_responders'>, 'request_id'>>).map((p) => p.request_id);
    if (requestIds.length === 0) return [];
    const { data: ratings, error: ratingsError } = await supabase.from('service_requests')
        .select('id, service_type, client_rating, updated_at, client:users!service_requests_client_id_fkey(rsi_handle)')
        .in('id', requestIds)
        .eq('rated', true)
        .not('client_rating', 'is', null)
        .order('updated_at', { ascending: false });
    handleSupabaseError({ error: ratingsError, message: 'Failed to get rating history' });
    return (ratings || []).map(r => toRatingHistoryEntry(r as unknown as Parameters<typeof toRatingHistoryEntry>[0]));
}

export async function promoteUserToMember(userId: number) {
    // Verify target exists and fetch current role.
    const { data: userData } = await supabase.from('users').select('role_id').eq('id', userId).maybeSingle();
    if (!userData) throw new Error('User not found in this organization');
    const oldRoleId: number | null = userData.role_id || null;

    // Single-org: no member cap before promoting.

    // Look up the Member role via system role helper
    const sysRoles = await getSystemRoles();
    if (!sysRoles.member) throw new Error('Cannot promote user: Member role not found');
    const memberRoleId = sysRoles.member.id;

    const { error } = await supabase.from('users').update({ role_id: memberRoleId })
        .eq('id', userId)
        ;
    handleSupabaseError({ error, message: 'Failed to promote user' });

    // Bi-directional Discord sync
    if (oldRoleId !== memberRoleId) {
        pushDiscordRolesForUser(userId, {
            oldRoleId,
            newRoleId: memberRoleId,
        }).catch(err => log.error('discord background push failed', { userId, err }));
    }
}

// Cooldown duration for user-initiated sync (1 hour)
const SYNC_COOLDOWN_MS = 60 * 60 * 1000;

export async function syncUserRoles(userId: number, options?: { bypassCooldown?: boolean }) {
    const { data: user, error: fetchError } = await supabase.from('users').select('discord_id, role_id, discord_synced_at').eq('id', userId).single();
    handleSupabaseError({ error: fetchError, message: 'Failed to fetch user for sync' });
    if (!user) throw new Error("User not found");

    // Server-side cooldown enforcement (unless bypassed by admin)
    if (!options?.bypassCooldown && user.discord_synced_at) {
        const elapsed = Date.now() - new Date(user.discord_synced_at).getTime();
        if (elapsed < SYNC_COOLDOWN_MS) {
            const remainingMin = Math.ceil((SYNC_COOLDOWN_MS - elapsed) / 60000);
            return `SYNC_COOLDOWN:${remainingMin}`;
        }
    }

    const discordMember = await getDiscordMember(user.discord_id);
    if (!discordMember) return "User not in Discord server";

    const mappingQuery = supabase.from('rank_mappings').select('*');
    const { data: mappings, error: mappingError } = await mappingQuery;
    handleSupabaseError({ error: mappingError, message: 'Failed to fetch rank mappings' });

    const rankMappingDict: Record<string, number> = {};
    const roleMappingDict: Record<string, number> = {};
    (mappings || []).forEach((curr: Tables<'rank_mappings'>) => {
        if (curr.rank_id) rankMappingDict[curr.discord_role_id] = curr.rank_id;
        if (curr.role_id) roleMappingDict[curr.discord_role_id] = curr.role_id;
    });

    let foundRankId = null;
    let foundRoleId = null;
    // Check if roles property exists (it should, but safeguard)
    if (discordMember.roles && Array.isArray(discordMember.roles)) {
        for (const roleId of discordMember.roles) {
            if (!foundRankId && rankMappingDict[roleId]) {
                foundRankId = rankMappingDict[roleId];
            }
            if (!foundRoleId && roleMappingDict[roleId]) {
                foundRoleId = roleMappingDict[roleId];
            }
            if (foundRankId && foundRoleId) break;
        }
    }

    // DB update payload (snake_case Row columns).
    const updates: Partial<Tables<'users'>> = {};
    if (foundRankId) {
        updates.rank_id = foundRankId;
    }

    // Apply mapped platform role if found.
    //
    // DO NOT DOWNGRADE. Discord sync is allowed to promote a user up the
    // Client → Member → Dispatcher → Admin ladder, but it must never move
    // someone DOWN. Previously an Admin whose Discord roles happened to map
    // only to "Member" would be silently downgraded to Member on bulk sync —
    // that's how an org once ended up with zero admins.
    //
    // Tier map: Client=1, Member=2, Dispatcher=3, Admin=4. Non-system /
    // custom roles default to tier 2 (Member-equivalent) for comparison —
    // conservative enough to stop accidental downgrades against unfamiliar
    // roles, permissive enough to still let sync promote a custom-roled user
    // to Dispatcher or Admin if their Discord roles warrant it.
    if (foundRoleId) {
        if (user.role_id) {
            const sysRoles = await getSystemRoles();
            const tierOf = (roleId: number | null | undefined): number => {
                if (!roleId) return 0;
                if (sysRoles.admin?.id === roleId) return 4;
                if (sysRoles.dispatcher?.id === roleId) return 3;
                if (sysRoles.member?.id === roleId) return 2;
                if (sysRoles.client?.id === roleId) return 1;
                return 2; // custom / unknown role — treat as Member-tier
            };
            const currentTier = tierOf(user.role_id);
            const mappedTier = tierOf(foundRoleId);
            const isClientRole = sysRoles.client && user.role_id === sysRoles.client.id;

            if (isClientRole) {
                // Single-org: no member cap — promote off Client unconditionally.
                updates.role_id = foundRoleId;
                log.info('sync setting platform role via discord mapping', { userId, roleId: foundRoleId });
            } else if (mappedTier > currentTier) {
                // Strict upgrade for Member+ users.
                updates.role_id = foundRoleId;
                log.info('sync promoting user tier', { userId, fromTier: currentTier, toTier: mappedTier, roleId: foundRoleId });
            } else {
                // Mapped tier ≤ current tier — preserve the higher role.
                log.info('sync preserving role, skipping discord override', { userId, currentTier, mappedTier });
            }
        }
    } else if (foundRankId && !foundRoleId) {
        // Legacy behavior: auto-promote Client to Member when rank is mapped but no role mapping exists
        if (user.role_id) {
            const sysRoles = await getSystemRoles();
            const isClientRole = sysRoles.client && user.role_id === sysRoles.client.id;

            if (isClientRole && sysRoles.member) {
                // Single-org: no member cap — auto-promote Client→Member.
                updates.role_id = sysRoles.member.id;
                log.info('sync auto-promoting user from client to member', { userId, roleId: sysRoles.member.id });
            }
        }
    }

    // Avatar and Name Update Logic
    if (discordMember.user) {
        // Use Nickname if set, otherwise Global Name, otherwise Username
        updates.name = discordMember.nick || discordMember.user.global_name || discordMember.user.username;

        // Always use the user's *global* Discord avatar — never the guild-specific
        // per-server avatar. Guild avatars disappear when a user leaves the guild
        // or edits their per-server profile, leaving our cached URL pointing at a
        // 404. The global avatar URL is stable for the lifetime of the avatar hash.
        updates.avatar_url = buildGlobalAvatarUrl(discordMember.user);
    }

    // Stamp sync timestamp
    updates.discord_synced_at = new Date().toISOString();

    const { error: updateError } = await supabase.from('users').update(updates).eq('id', userId);
    handleSupabaseError({ error: updateError, message: 'Failed to update synced user' });

    // avatar_refreshed_at lives on user_presence — written separately so it
    // does not end up on the realtime-published users row.
    if (discordMember.user) {
        await supabase.from('user_presence')
            .update({ avatar_refreshed_at: new Date().toISOString() })
            .eq('user_id', userId);
    }

    return "Identity & Roles Synced";
}

// In-memory cooldown for admin bulk sync per org (15 min)
const BULK_SYNC_COOLDOWN_MS = 15 * 60 * 1000;
const bulkSyncTimestamps = new Map<string, number>();

export async function syncAllMemberRoles() {
    // Enforce a single-org cooldown for bulk sync.
    {
        const lastRun = bulkSyncTimestamps.get('all');
        if (lastRun) {
            const elapsed = Date.now() - lastRun;
            if (elapsed < BULK_SYNC_COOLDOWN_MS) {
                const remainingMin = Math.ceil((BULK_SYNC_COOLDOWN_MS - elapsed) / 60000);
                throw new Error(`BULK_SYNC_COOLDOWN:${remainingMin}`);
            }
        }
        bulkSyncTimestamps.set('all', Date.now());
    }

    const query = supabase.from('users').select('id').is('deleted_at', null);

    const { data: users, error: fetchError } = await query;
    if (fetchError) {
        log.error('fetch users for sync failed', { err: fetchError });
        return;
    }
    if (users) {
        for (const u of users) {
            try {
                await syncUserRoles(u.id, { bypassCooldown: true });
            } catch (err) {
                log.error('sync user failed', { userId: u.id, err });
            }
        }
    }
}

export async function savePushSubscription(
    userId: number,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
) {
    // The endpoint is fully client-controlled and the service-role server later
    // POSTs to it. Reject anything that isn't an https URL on a known Web-Push
    // vendor host BEFORE it is stored — otherwise it is a stored blind-SSRF
    // target. Validate keys are present too.
    if (!isAllowedPushEndpoint(subscription?.endpoint)) {
        throw new Error('Invalid push subscription endpoint.');
    }
    if (!subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        throw new Error('Invalid push subscription keys.');
    }

    // Delete existing sub for this endpoint to prevent duplicates/stale
    await supabase.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);

    // Cap subscriptions per user (fan-out amplifier bound). When at/over the cap,
    // evict the oldest before inserting the new one.
    const { data: existing } = await supabase.from('push_subscriptions')
        .select('id, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });
    if (existing && existing.length >= MAX_PUSH_SUBSCRIPTIONS_PER_USER) {
        const evictCount = existing.length - MAX_PUSH_SUBSCRIPTIONS_PER_USER + 1;
        const evictIds = existing.slice(0, evictCount).map((s) => s.id);
        await supabase.from('push_subscriptions').delete().in('id', evictIds);
    }

    const { error } = await supabase.from('push_subscriptions').insert({
        user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        subscription: subscription // Store full object for easy reuse with web-push lib
    });
    handleSupabaseError({ error, message: 'Failed to save push subscription' });
}
