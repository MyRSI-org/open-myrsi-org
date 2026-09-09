import { permissionSatisfied } from './permissionImplications.js';

/**
 * "Holds at least one staff capability" — i.e. is org PERSONNEL rather than one of
 * the org's external customers (the Client role, which only ever raises service
 * requests).
 *
 * Deliberately a PERMISSION set and NOT a role-tier test. `inferUserRoleTier`
 * (lib/db/mappers.ts:137-159) resolves the tier from the role's NAME before any
 * permission is consulted — 'commander'/'director' map to Admin, 'officer'/'member'
 * to staff tiers — and `addRole` has no reserved-name check, so a permissionless
 * custom role called "Commander" would clear a role-tier gate. A permission set
 * answers the question that actually matters ("can this caller work here at all?")
 * and cannot be spoofed with a name.
 *
 * Kept deliberately GENEROUS on the read perms: over-narrowing silently denies real
 * staff on customised roles (an ops lead who dropped user:view:roster but kept
 * operations:view) their own org's base radio channels.
 *
 * DO NOT WIDEN CASUALLY. Everything on this list — AND anything that implies an
 * entry through lib/permissionImplications.ts — can mint a LiveKit join token for
 * the org's staff voice nets (lib/radio.ts base-channel branch), enumerate the base
 * room list (lib/radio.ts visibleRadioRoomNames) and receive the EAM body
 * (api/actions/system.ts broadcast:get_active_eam). So the set that must stay
 * disjoint from CLIENT_DEFAULT_PERMS (lib/clientRolePermissions.ts) is the EFFECTIVE
 * one, list ∪ implications-of-list — a widening can now come from an edit to the
 * implication table with this array untouched. Pinned both ways by
 * tests/radioRoomAuthz.test.ts (string-set) and tests/permissionImplications.test.ts
 * (implication-aware). `units:view_all`, `academy:view` and `marketplace:view` are
 * excluded on purpose: they are grantable to customers, and the ladder only ever
 * climbs, so academy:view still does not reach the academy:instruct entry below.
 */
export const STAFF_VIEW_PERMS: readonly string[] = [
    // Domain read perms — any one of these means the caller renders staff surfaces.
    'operations:view', 'intel:view', 'intel:view:clearance', 'intel:create', 'warrant:view',
    'hr:view', 'fleet:view', 'wiki:view', 'gov:view', 'alliance:view',
    'finance:view', 'qm:view', 'warehouse:view', 'academy:instruct',
    // Staff capabilities that are not domain reads but still mark internal personnel.
    'user:view:roster',   // Member default; the roster/org-chart reader
    'user:toggle_duty',   // Member default; only personnel go on duty
    'radio:manage',       // Dispatcher default
    'admin:access',       // Admin console
    // Request HANDLING — NOT request:create/cancel/rate, which are the Client's own
    // entitlements. These are exactly the perms inferUserRoleTier uses to reach the
    // Dispatcher/Member tiers, so a caller who is "not a Client" there but fails this
    // list would be staff by one definition and a customer by the other.
    'request:dispatch', 'request:triage', 'request:accept',
    'request:manage_responders', 'request:set_lead',
] as const;

/**
 * True when the caller holds ANY staff capability. `permissions` is the
 * server-resolved array off the user row — never a client-supplied value.
 */
export function hasAnyStaffViewPerm(permissions: string[] | undefined | null): boolean {
    if (!permissions || permissions.length === 0) return false;
    // permissionSatisfied, not a bare includes(): 'academy:instruct' below is a LADDER
    // rung, so a Learning Manager holding only academy:manage is staff too. The ladder
    // only climbs — academy:view (deliberately absent from the list because it is
    // grantable to customers) still does NOT satisfy academy:instruct.
    return STAFF_VIEW_PERMS.some((p) => permissionSatisfied(permissions, p));
}
