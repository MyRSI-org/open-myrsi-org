import { hasAnyStaffViewPerm } from './staffPerms.js';

/**
 * Roster/taxonomy authority perms that are NOT in STAFF_VIEW_PERMS.
 *
 * These are roles whose ONLY job is roster / HR administration. Without this
 * third disjunct an `admin:view:roster`-only role receives NO roster, while
 * lib/db/userFilters.ts one layer down hands that same role another member's
 * clearanceLevel (CLEARANCE_VISIBLE_PERMS) and personnel metadata
 * (HR_METADATA_PERMS) — the build would assert both "this caller may read
 * another member's record" and "this caller is an external customer with no
 * roster to read" at once.
 *
 * MIRRORS, and must stay a superset of, `CLEARANCE_VISIBLE_PERMS`
 * (lib/db/userFilters.ts) minus whatever STAFF_VIEW_PERMS already admits —
 * pinned by tests/rosterGate.test.ts. It is NOT re-exported from there because
 * eslint.config.js forbids client code from importing anything under lib/db/**,
 * and contexts/DataCoreContext.tsx consults this same predicate.
 *
 * DELIBERATELY NOT ADDED TO STAFF_VIEW_PERMS: that array also mints LiveKit
 * join tokens for the staff voice nets (lib/radio.ts) and delivers the EAM body
 * (api/actions/system.ts). Widening it is effectively one-way and trips
 * tests/permissionImplicationSites.test.ts. This list widens the ROSTER gate
 * only.
 *
 * Bare `includes`, not permissionSatisfied: none of these six is a rung on the
 * lib/permissionImplications.ts ladder, and lib/db/userFilters.ts checks the
 * same strings with a bare includes — matching it keeps the two from drifting.
 */
export const ROSTER_AUTHORITY_PERMS: readonly string[] = [
    'admin:view:roster', 'admin:user:update', 'admin:user:manage_clearance',
    'hr:recruiter', 'hr:manager', 'hr:admin',
] as const;

/** Server-resolved facts only. `isSystemAdmin` is the role IDENTITY stamped by
 *  lib/db/adminIdentity.ts on the session actor (getUserById / findUserByDiscordId),
 *  never the name-derived tier; `permissions` is the array off the user row,
 *  never a client-supplied value. */
export interface RosterGateViewer {
    isSystemAdmin?: boolean;
    permissions?: string[] | null;
}

/**
 * PHASE 3 ROSTER GATE — the single predicate deciding whether a caller receives
 * the member roster, the rank/unit/role tables and the classification taxonomy.
 * Three named disjuncts (owner decision D4), all fail-closed:
 *
 *   1. role IDENTITY — the org's genuine system Admin.
 *   2. hasAnyStaffViewPerm — "is this org personnel, or one of the org's
 *      external customers?" A PERMISSION test, not a role-tier test:
 *      inferUserRoleTier (lib/db/mappers.ts) falls THROUGH to UserRole.Client
 *      for any custom role holding no tier-marking permission, so a tier test
 *      would deny real staff on customised roles their own org's directory.
 *   3. ROSTER_AUTHORITY_PERMS — roster/HR administration roles that hold none
 *      of STAFF_VIEW_PERMS.
 *
 * ONE HOME ON PURPOSE. lib/db.ts (the `main` bundle), api/query.ts (users_slice,
 * cross-user user_detail and the users_presence census) and
 * contexts/DataCoreContext.tsx / contexts/SessionContext.tsx (realtime handler
 * attachment and promotion rehydration) all call THIS FUNCTION. If the bundle
 * gate and the slice gate ever disagree, a staff viewer holding a populated
 * roster receives a denied users_slice and mergeUsersSlice evicts the requested
 * ids (lib/sliceMerge.ts). Do not inline a second copy anywhere.
 *
 * Dependency-light on purpose so it compiles under BOTH tsconfigs: server callers
 * import it with a `.js` specifier (Node16), client callers without one (bundler)
 * — the same trick as lib/sliceMerge.ts and lib/permissionImplications.ts. It must
 * never import anything under lib/db/**.
 *
 * WHAT THIS DOES NOT CLOSE: the `authenticated` PostgREST grant
 * (schema.sql private.rt_client_tables()) still lets a hand-written request read
 * roles / security_clearances / security_limiting_markers directly. That remaining
 * hole is Phase 3 item 7. (The `system:get_clearances` / `system:get_markers` RPCs
 * that also served the taxonomy at `user:manage:self` were DELETED by item 5 in
 * wave 3 — do not re-add them.)
 * Do not describe this predicate as closing the taxonomy question.
 */
export function mayReceiveRoster(viewer: RosterGateViewer | null | undefined): boolean {
    if (!viewer) return false;
    if (viewer.isSystemAdmin === true) return true;
    const perms = viewer.permissions;
    if (!Array.isArray(perms) || perms.length === 0) return false;
    if (hasAnyStaffViewPerm(perms)) return true;
    return ROSTER_AUTHORITY_PERMS.some((p) => perms.includes(p));
}
