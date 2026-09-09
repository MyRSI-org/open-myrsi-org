// The Client system role is CODE-OWNED, not operator-owned. Its permission set is
// CLIENT_DEFAULT_PERMS (lib/clientRolePermissions.ts) and repairDatabase reconverges
// it destructively. Every server path that could write the role — the Roles UI RPC,
// a Discord role mapping, an org import — funnels through the predicates here so
// there is ONE definition of "is this the Client role" and no drift.
//
// The two assert* predicates fail CLOSED on an unresolvable system role.
// getSystemRoles() (lib/db/common.ts) swallows its read errors and returns {} on a
// DB fault, so the `if (sysRoles.client && …)` shape the handler used before this
// module existed silently LIFTED the lock on exactly that fault.
//
// enforceClientRolePermissionLock deliberately takes the role id as an ARGUMENT
// rather than resolving it here: its two callers are repairDatabase (which has just
// stamped is_system and dropped the memo, so getSystemRoles is authoritative there)
// and the org importer (which has just deleted and re-inserted the whole roles
// table, so the 5-minute getSystemRoles memo is stale by construction and a
// mis-resolve would DELETE another role's grants).

import { supabase, getSystemRoles } from './common.js';
import { CLIENT_DEFAULT_PERMS } from '../clientRolePermissions.js';
import { hasAnyStaffViewPerm } from '../staffPerms.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'db.clientRoleLock' });

const UNRESOLVED = 'Role configuration unavailable — the system roles could not be resolved. '
    + 'Run Admin → Database Tools → Repair Database and retry.';

/** Reject a role id that is not a usable positive integer. Both predicates coerce
 *  rather than trusting their caller: `roleId` arrives off a JSON body typed as
 *  `number`, and `1 === '1'` is false — an uncoerced compare skips the lock. */
function normaliseRoleId(roleId: number | string): number {
    const id = Number(roleId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid role id.');
    return id;
}

/**
 * Refuse a permission write against the Client role.
 *
 * The message is deliberate client-visible copy (lib/errors.ts's business-error
 * idiom) and is pinned byte-exact by tests/clientRoleWriteLock.test.ts against the
 * real handler — tests/errors.test.ts only feeds the literal to the classifier and
 * would not notice a reword.
 */
export async function assertRoleIsNotClient(roleId: number | string): Promise<void> {
    const id = normaliseRoleId(roleId);
    const sysRoles = await getSystemRoles();
    if (!sysRoles.client) throw new Error(UNRESOLVED);
    if (sysRoles.client.id === id) {
        throw new Error('The Client role is locked. Its permissions cannot be modified.');
    }
}

/**
 * Refuse a Discord-role → platform-role MAPPING against Client or Admin.
 *
 * A mapping is a STANDING grant, not a point-in-time assignment: every account that
 * ever holds that Discord role is written to this platform role on the next sync,
 * with no myRSI-side approval and no record of who was escalated. Admin is refused
 * because Discord role membership is administered outside this app, so the mapping
 * is a self-escalation primitive for anyone who can later obtain the Discord role —
 * and assertCanAssignRole only blocks that for NON-Admin actors. Client is refused
 * because syncUserRoles takes the FIRST matching mapping, so a Client mapping
 * shadows every other mapping on that account and disables the rank-based
 * Client→Member auto-promote; it cannot demote (the anti-downgrade stops that) but
 * it silently pins its holders off the ladder.
 *
 * Matches the Role Mapping dropdown (components/views/admin/DiscordSettingsTab.tsx),
 * which has never offered either role. syncUserRoles ignores such rows on the READ
 * side too, so mappings that predate this guard or arrive through an org import are
 * inert rather than grandfathered-live.
 */
export async function assertRoleIsMappable(roleId: number | string): Promise<void> {
    const id = normaliseRoleId(roleId);
    const sysRoles = await getSystemRoles();
    if (!sysRoles.client || !sysRoles.admin) throw new Error(UNRESOLVED);
    if (sysRoles.client.id === id) {
        throw new Error('The Client role cannot be mapped from a Discord role.');
    }
    if (sysRoles.admin.id === id) {
        throw new Error('The Admin role cannot be mapped from a Discord role. Assign Admin per user.');
    }
}

/**
 * Reconverge the Client role onto CLIENT_DEFAULT_PERMS by deleting every excess
 * grant. Extracted from repairDatabase so the SAME strip runs after an org import,
 * which preclears role_permissions and replaces it with the export's grants — a
 * source org whose Client role held admin:access would otherwise import verbatim
 * and escalate every Client until someone clicked Repair.
 *
 * `clientRoleId` is the caller's problem on purpose (see the module header).
 * Returns how many grants were removed. Idempotent. THROWS on a read or delete
 * fault: a caller must not report a lock it did not verify. Both call sites contain
 * that throw locally — repairDatabase must still run its zero-admin recovery, and a
 * fully-written import must not be reported as a failure.
 */
export async function enforceClientRolePermissionLock(clientRoleId: number): Promise<{ stripped: number }> {
    const id = normaliseRoleId(clientRoleId);

    const { data: grants, error } = await supabase.from('role_permissions')
        .select('permission_id, permissions!inner(name)')
        .eq('role_id', id);
    if (error) throw new Error(`Client role permissions could not be read: ${error.message}`);

    const excess = ((grants ?? []) as unknown as Array<{ permission_id: number; permissions: { name: string } }>)
        .filter((rp) => !CLIENT_DEFAULT_PERMS.includes(rp.permissions?.name))
        .map((rp) => rp.permission_id);
    if (excess.length === 0) return { stripped: 0 };

    log.info('stripping excess permissions from client role', { roleId: id, count: excess.length });
    const { error: delErr } = await supabase.from('role_permissions')
        .delete()
        .eq('role_id', id)
        .in('permission_id', excess);
    if (delErr) throw new Error(`Failed to strip excess Client role permissions: ${delErr.message}`);
    return { stripped: excess.length };
}

/**
 * Is this caller one of the org's EXTERNAL CUSTOMERS?
 *
 * ROLE-SLOT, not permission set — deliberately the OPPOSITE instrument from
 * hasAnyStaffViewPerm (lib/staffPerms.ts) and mayReceiveRoster (lib/rosterGate.ts),
 * which answer the opposite question:
 *
 *  - "May this caller reach a positive STAFF capability?" (a LiveKit token on the base
 *    nets, the EAM body, the member roster) -> the permission predicates. A
 *    permissionless custom role must be DENIED there, and "is not on the Client role"
 *    would wrongly admit it.
 *  - "Is this caller an external CUSTOMER?" (this predicate) -> the role slot. A
 *    permission test is wrong here in BOTH directions:
 *      · it fails BROKEN for a legitimate low-permission internal role — an org's
 *        "Recruit"/"Probationary" role whose entire reason to exist is the induction
 *        course would be refused the Academy;
 *      · it fails OPEN for a Client that drifted into a staff grant. assertRoleIsNotClient
 *        above stops the Roles UI writing one, but the seeder, repairDatabase, the org
 *        importer and hand-run SQL are four writers it does not cover.
 *    lib/staffPerms.ts also excludes academy:view, marketplace:view and units:view_all
 *    from STAFF_VIEW_PERMS precisely BECAUSE they are grantable to customers, so the two
 *    sets were never meant to be each other's complement.
 *
 * Every non-admin account is created on this slot (lib/db/users.ts createUser, which
 * itself throws if the slot does not resolve), so the slot is where the org's customers
 * actually are, and RESERVED_ROLE_NAMES + is_system + updateRole's rename refusal make
 * it unforgeable. DO NOT add an isSystemAdmin bypass: a real Admin is on the Admin slot
 * by construction, and a bypass would be a fail-OPEN path through a fail-closed gate.
 *
 * FAILS CLOSED AT EVERY UNKNOWN — and that is NOT the same as "never fails open". The
 * one case that fails OPEN, named rather than papered over: getSystemRoles (./common.js)
 * is a 5-minute IN-PROCESS memo, and lib/db/importer.ts deletes and re-inserts the whole
 * roles table. On a SECOND instance, whose memo the importer's in-process invalidations
 * never reached, sysRoles.client.id points at a deleted id, the real Client's new id
 * compares false, and this returns false — a Client is admitted to the denied namespaces
 * for up to TTL.SYSTEM_ROLES. That is the SAME window assertRoleIsNotClient (a stronger
 * control: a permission WRITE lock) already accepts, so it is accepted here rather than
 * paying a `roles` query on every academy call. getSystemRolesUncached (./common.js,
 * whose own docblock documents this hazard) is the one-line upgrade if it ever stops
 * being acceptable. Pinned by tests/clientNamespaceDenial.test.ts.
 */
export async function isClientCaller(
    user: { roleId?: number | string | null; permissions?: string[] | null } | null | undefined,
): Promise<boolean> {
    // Every consumer authenticates first, so this is unreachable in practice — it is
    // here so the predicate can never answer "staff" for an absent identity.
    if (!user) return true;
    // The answer for every state in which the slot comparison is unavailable. This is
    // the POSITIVE-capability predicate INVERTED: it denies a permissionless caller and
    // admits real staff, i.e. the fail-closed direction on both sides.
    const staffFallback = !hasAnyStaffViewPerm(user.permissions ?? null);
    const rid = Number(user.roleId);
    // toUser maps a missing role_id to 0 (lib/db/mappers.ts). users.role_id is NOT NULL
    // (schema.sql) and the session query inner-joins roles, so a live session cannot
    // reach this — but 0 compares false against every real role id and would read as
    // "not a customer", so route it to the fallback rather than to allow.
    if (!Number.isInteger(rid) || rid <= 0) return staffFallback;
    const sysRoles = await getSystemRoles();
    if (!sysRoles.client) return staffFallback;
    return sysRoles.client.id === rid;
}

/**
 * The system Client role id, or THROW with the same operator-actionable message the two
 * assert* predicates use. For WRITE-side target validation, where "I could not determine
 * whether this target is a customer" must BLOCK the write rather than wave it through —
 * the read-side permission fallback above is not available to a caller that is about to
 * create a row or award a certification.
 */
export async function requireClientRoleId(): Promise<number> {
    const sysRoles = await getSystemRoles();
    if (!sysRoles.client) throw new Error(UNRESOLVED);
    return sysRoles.client.id;
}
