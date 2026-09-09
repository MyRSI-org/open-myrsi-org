/**
 * Permission implications — "holding X also satisfies a requirement for Y".
 *
 * Most permissions are flat: a gate asks for one string and the caller either holds
 * it or does not. Two families are LADDERS, and each was hand-inlined at every gate
 * that cared — which is how the copies drifted apart:
 *
 *   - `intel:view:clearance` is a strictly STRONGER intel read than `intel:view`, so
 *     a holder must pass an `intel:view` gate. That rule lived as three separate
 *     inline compares (api/query.ts, api/services.ts, lib/db.ts getState) with the
 *     client gate implementing none of them, so an intel:view:clearance-only role was
 *     served the intel subset by the server and shown no Intel nav by the browser.
 *   - The Academy is a ladder:
 *       academy:view      read the staff surfaces (the 'academy' bundle: every course
 *                         INCLUDING unpublished drafts, every session)
 *       academy:instruct  the above, plus authoring courses and running sessions
 *       academy:manage    the above, plus approving, gating and certifying
 *     Every gate was a single-string includes(), so an Instructor could CREATE a
 *     course and then be refused the bundle that contains it, and a Learning Manager
 *     granted only academy:manage was shown the Course Builder by AcademyHubView
 *     (pinned by tests/academyMenuGating.test.tsx) and 403'd on every write.
 *     lib/db/academy.ts already treats manage as a superset — assertCanEditCourse
 *     takes `canManage` and skips the instructor-ownership check — so this table
 *     brings the gates in line with the data layer, not the reverse.
 *
 * NOTE the open build's `academy:view` means STAFF surfaces (schema.sql §7: "View
 * Academy (staff surfaces)"), NOT a member baseline. Members get My Academy through
 * the self-scoped 'academy_my' subset with no academy perm at all. Do not grant
 * academy:view to the Member role to "fix" anything — it is the staff read.
 *
 * DIRECTION: keys are the REQUIRED permission; values are the other permissions that
 * also satisfy it. Implications are applied ONE LEVEL DEEP and are PRE-EXPANDED here
 * — `academy:view` lists `academy:manage` explicitly rather than relying on a
 * transitive walk through `academy:instruct` — so the lookup is flat, cheap and
 * cannot cycle. Ladders only ever CLIMB: academy:view never satisfies
 * academy:instruct, and intel:view never satisfies intel:view:clearance.
 *
 * This is a CONVENIENCE FOR GATES, NEVER A GRANT: nothing here writes to
 * role_permissions, so the Roles UI and the roster keep showing exactly what the org
 * actually granted, and un-ticking a permission takes effect on the next request
 * (the server re-resolves permissions from the DB on every /api/services and
 * /api/query call). Expanding at GRANT time would be unrevokable — role_permissions
 * is (role_id, permission_id) with no provenance column, so an expanded row is
 * byte-identical to an operator-granted one.
 *
 * Widening an entry widens every gate at once — treat an edit here as a security
 * change. tests/permissionImplications.test.ts pins the exact key set, both
 * directions of every rung, and that the gates consult this table instead of
 * re-implementing it.
 *
 * Zero imports on purpose: this compiles under BOTH tsconfigs, so server callers
 * import it with a `.js` extension (Node16) and client callers without one
 * (bundler) — same trick as lib/sliceMerge.ts and lib/staffPerms.ts.
 */
export const PERMISSION_SATISFIED_BY: Readonly<Record<string, readonly string[]>> = {
    // Intel: clearance-scoped reading is a superset of plain reading. This is a READ
    // GATE string only — it grants no clearance. Actual classification/limiting-marker
    // enforcement is the viewer's security_clearances row in lib/clearance.ts, whose
    // bypass lists are literals like ['intel:manage'] and never consult this table.
    'intel:view': ['intel:view:clearance'],
    // Academy ladder (pre-expanded, highest rungs last).
    'academy:view': ['academy:instruct', 'academy:manage'],
    'academy:instruct': ['academy:manage'],
};

/**
 * True when `held` satisfies `required`, directly or by implication.
 *
 * `held` is always the server-resolved permission array off the user row (or the
 * session copy of it on the client) — never a client-supplied value. Fails CLOSED on
 * an empty/missing requirement and on anything that is not a non-empty array: a
 * truthy non-array would otherwise reach String.prototype.includes, where substring
 * matching makes 'intel:view:clearance'.includes('intel:view') true for the wrong
 * reason.
 *
 * The table lookup is own-property-guarded for the same reason api/services.ts guards
 * its action dispatch: a prototype-inherited name ('constructor', 'toString') would
 * otherwise resolve to a truthy non-array and turn a denial into a 500.
 */
export function permissionSatisfied(held: readonly string[] | undefined | null, required: string): boolean {
    if (!required) return false;
    if (!Array.isArray(held) || held.length === 0) return false;
    if (held.includes(required)) return true;
    if (!Object.prototype.hasOwnProperty.call(PERMISSION_SATISFIED_BY, required)) return false;
    const alternatives = PERMISSION_SATISFIED_BY[required];
    return Array.isArray(alternatives) && alternatives.some(alt => held.includes(alt));
}
