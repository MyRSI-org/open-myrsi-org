// "Is this actor on the org's system Admin role?" — resolved by role IDENTITY,
// never by the role's NAME.
//
// `User.role` is not a privilege fact: toUser (lib/db/mappers.ts) derives a tier
// from the role row's free-text name before any permission is consulted, and
// roles.name carries only a CASE-SENSITIVE unique constraint — so a role called
// "Commander", or literally "admin" in lowercase, resolved to UserRole.Admin with
// zero permissions and cleared every `role === 'Admin'` gate in the tree. Role ids
// and the is_system flag cannot be forged that way: addRole never writes is_system,
// updateRole refuses to rename an is_system role, and roles_name_key makes a second
// literal 'Admin' impossible — so a custom role can be NAMED admin or BE is_system,
// never both.
//
// Deliberately NOT roleTier() >= 4: roleTier awards tier 4 to any custom role
// holding admin:access, and admin:access is seeded to the non-Admin Dispatcher — a
// tier test would WIDEN every apex gate this flag protects.
//
// FAILS CLOSED in every direction: no roleId, an unresolved Admin slot, or a failed
// read all yield false. `false` is the deny answer at every consumer — permissive
// bypasses (clearance, the user-strip full record, the maintenance escape, the
// role-config escape) are withheld, and deny-unless ceilings (danger zone, apex
// government seats, "only Admins assign the Admin role") hold.

import { supabase, getSystemRoles, getSystemRolesUncached } from './common.js';

/** The subset of a `roles` row this module trusts. */
export interface AdminIdentityRole {
    id?: number | null;
    name?: string | null;
    is_system?: boolean | null;
}

const isRoleId = (roleId: unknown): roleId is number =>
    typeof roleId === 'number' && Number.isInteger(roleId) && roleId > 0;

/**
 * Corroborating local signal: the role row PostgREST already embedded on the user.
 * `is_system AND name === 'admin'` is unforgeable (see the module header) and needs
 * no second read, so a getSystemRoles fault cannot strip a real Admin of their
 * bypasses. Trimmed + case-folded to match the reserved-name guard's normalisation
 * in lib/db/system.ts — the guard blocks a superset of what this accepts.
 */
export function isSystemAdminRole(role: AdminIdentityRole | null | undefined): boolean {
    if (!role || role.is_system !== true) return false;
    return String(role.name ?? '').trim().toLowerCase() === 'admin';
}

/**
 * Resolve the fact for a role id, optionally corroborated by the embedded role row.
 * Reads the 5-minute getSystemRoles memo; use {@link resolveIsSystemAdminFresh} for
 * anything that gates a recovery control.
 */
export async function resolveIsSystemAdmin(roleId: number | null | undefined, role?: AdminIdentityRole | null): Promise<boolean> {
    if (isSystemAdminRole(role)) return true;
    if (!isRoleId(roleId)) return false;
    const sys = await getSystemRoles();
    return !!sys.admin && sys.admin.id === roleId;
}

/**
 * Cache-free re-resolution, for gates whose whole job is to recover a broken
 * install: admin:db:check/repair/prune, the maintenance toggle, force-logout-all
 * and the maintenance deny path. lib/db/importer.ts full-table-deletes and rebuilds
 * `roles`, so a cached slot can name a row that no longer exists — and repair is the
 * tool that re-stamps is_system. Gating repair on the memo it repairs is the
 * circularity that manufactures a lockout.
 *
 * NEVER throws: a read fault reads as "not Admin", which is the deny direction at
 * every caller.
 */
export async function resolveIsSystemAdminFresh(roleId: number | null | undefined): Promise<boolean> {
    if (!isRoleId(roleId)) return false;
    try {
        const sys = await getSystemRolesUncached();
        if (!!sys.admin && sys.admin.id === roleId) return true;
        // Last resort: read the actor's own role row. Covers the window where the
        // is_system stamp is intact but the name resolution above is ambiguous.
        const { data } = await supabase.from('roles').select('id, name, is_system').eq('id', roleId).maybeSingle();
        return isSystemAdminRole(data);
    } catch {
        return false;
    }
}

/**
 * Stamp the resolved fact onto a freshly mapped session actor. Call sites are
 * deliberately few (getUserById + findUserByDiscordId) — any actor that did NOT
 * come through a stamping path reads `undefined` and is treated as not-Admin.
 */
export async function stampSystemAdmin<T extends { roleId?: number } | null | undefined>(user: T, role?: AdminIdentityRole | null): Promise<T> {
    if (!user) return user;
    (user as { isSystemAdmin?: boolean }).isSystemAdmin = await resolveIsSystemAdmin(user.roleId, role);
    return user;
}
