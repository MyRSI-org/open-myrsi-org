/**
 * Canonical list of permissions the "Client" system role is allowed to have.
 *
 * Single source of truth — previously duplicated across seeder, system-role repair,
 * admin audit endpoints, and the Roles Audit UI. When a new feature grants default
 * client access (e.g., marketplace), add the permission here and it propagates
 * everywhere. Anything beyond this list on a Client role is flagged as excess by
 * the integrity checker and stripped by the repair tool.
 */
export const CLIENT_DEFAULT_PERMS: readonly string[] = [
    'request:create',
    'request:cancel',
    'request:rate',
] as const;

/**
 * Everything the org may grant to an EXTERNAL CUSTOMER — CLIENT_DEFAULT_PERMS (what the
 * seeded Client role holds) PLUS the three permissions lib/staffPerms.ts documents as
 * customer-grantable and deliberately excludes from STAFF_VIEW_PERMS. A customer on a
 * CUSTOM role can hold any of these six and nothing else.
 *
 * This is the set private.rt_is_staff() (schema.sql §4.9) complements: holding ONLY perms
 * from this list means "external customer", so it must be a SUPERSET of CLIENT_DEFAULT_PERMS
 * and every entry must be non-staff by hasAnyStaffViewPerm. Pinned both ways by
 * tests/rtIsStaffParity.test.ts — which also scrapes the lib/staffPerms.ts docstring, so a
 * FOURTH documented customer-grantable permission fails CI until it is added here.
 */
export const CUSTOMER_GRANTABLE_PERMS: readonly string[] = [
    ...CLIENT_DEFAULT_PERMS,
    'units:view_all',
    'academy:view',
    'marketplace:view',
    // The pseudo-permission. api/services.ts short-circuits user:manage:self to mean
    // "any authenticated user", so holding it says nothing about being staff — but it
    // IS a real, tickable catalog row ("Manage Own Profile", User Management) and a
    // Member/Dispatcher default. Ticking it on a bespoke customer role reads as
    // harmless and, if it were missing here, would classify that account STAFF in
    // private.rt_is_staff() while TypeScript still called it a customer — handing back
    // the whole PostgREST read the boundary exists to close.
    'user:manage:self',
    // Marketplace TRADING, not just browsing. Letting clients buy and sell in the org
    // marketplace is an OPT-IN feature: an admin running a marketplace may permit
    // non-members to participate. So an external customer can legitimately hold these,
    // and if they were treated as staff-only a client the org deliberately opted in
    // would be reclassified STAFF by private.rt_is_staff() and handed the roster
    // taxonomy — turning a product feature into a data leak. marketplace:admin is NOT
    // here: moderation is staff work.
    'marketplace:list',
    'marketplace:contract',
];
