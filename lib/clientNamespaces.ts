/**
 * The CLIENT-TIER DENIAL registry: the parts of the product an org's EXTERNAL
 * CUSTOMERS (accounts on the seeded system Client role — they only ever raise service
 * requests) may not enter, in EITHER direction.
 *
 * Deliberately NOT a permission gate. `academy:view` in this build is the STAFF read
 * (schema.sql §7 "View Academy (staff surfaces)", unpublished drafts included) and the
 * member surface `academy_my` is intentionally permission-LESS —
 * lib/roleDefaultPermissions.ts is emphatic that academy:view must never become a
 * member baseline, and tests/seederRoleDefaults.test.ts pins academy_my's ABSENCE from
 * SUBSET_REQUIRED_PERMISSION. There is therefore no permission to gate the member
 * surface on that would not first have to be granted to every existing member, and
 * schema.sql is a re-runnable convergence script, not a migration. The boundary
 * actually wanted is member-vs-customer, which is a ROLE-SLOT fact: db.isClientCaller
 * (lib/db/clientRoleLock.ts).
 *
 * TWO server consumers today — the dispatcher (api/services.ts) and the read path
 * (api/query.ts). Neither may import the other to reach the list, which is why this is
 * its own dependency-free module. (api/orgUpload.ts is a PROSPECTIVE third: Phase 3
 * item 6 deliberately declined to port a client denial onto that endpoint, because a
 * Client holds none of the upload feature permissions and the gate would have no
 * reachable caller. Do not add it speculatively — machinery with no consumer rots.)
 *
 * SCOPE — READ THIS BEFORE WIDENING. The denial is keyed on the SEEDED Client role, so
 * an org whose real customers sit on a CUSTOM role ("Guest", "Prospect", "Contractor")
 * holding only request:create is NOT denied here: the roster and the classification
 * taxonomy still close for them (lib/rosterGate.ts gates on permissions), but the
 * Academy does not. That residual is ACCEPTED knowingly. The operator guidance is the
 * boundary itself: THE SEEDED `Client` ROLE IS THE CUSTOMER TIER — put external
 * customers on it, and assertRoleIsNotClient will keep staff grants off it. A
 * permission test would fail the other way and worse: an org's permissionless
 * "Recruit"/"Probationary" role, whose entire reason to exist is the induction course,
 * would be refused the Academy.
 *
 * The two halves are pinned against each other by tests/clientNamespaceDenial.test.ts:
 * every denied read subset NAMES the denied write namespace its data belongs to, and no
 * denied namespace may cover an action a Client is ENTITLED to (CLIENT_DEFAULT_PERMS).
 */
export const CLIENT_DENIED_NAMESPACES: readonly string[] = ['academy:'] as const;

/**
 * Denied read subset → the write namespace its data belongs to.
 *
 * An EXPLICIT pairing, not a derivation. Deriving the namespace from the subset name
 * (`subset.split('_')[0] + ':'`) happens to work for 'academy_my' → 'academy:' by
 * accident of naming: the phase's other client-denial candidates are the roster
 * subsets, and 'users_presence'.split('_')[0] is 'users' while the action prefix is
 * 'user:' — which this registry must NEVER deny wholesale, because a Client's own
 * user:apply_job / user:submit_application is how a customer becomes a member.
 */
export const CLIENT_DENIED_SUBSET_NAMESPACE: Readonly<Record<string, string>> = {
    // Staff bundle. Already denied by SUBSET_REQUIRED_PERMISSION['academy'] =
    // 'academy:view'; listed anyway so the parity invariant is expressible and the
    // denial still holds if a future edit ever loosens that permission entry.
    academy: 'academy:',
    // The member self-service bundle: the published catalogue plus the caller's own
    // enrolments. This is the one with no permission gate, and it never gets one.
    academy_my: 'academy:',
};

/** The denied read subsets. Derived from the pairing above so there is ONE literal. */
export const CLIENT_DENIED_SUBSETS: readonly string[] = Object.keys(CLIENT_DENIED_SUBSET_NAMESPACE);

/** One message for both surfaces so a client sees one consistent refusal. */
export const CLIENT_DENIED_MESSAGE = 'This area is not available to client accounts.';
