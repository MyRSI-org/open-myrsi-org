import { User } from '../../types.js';

export interface RequesterContext {
    id: number;
    /**
     * DISPLAY tier only (name-derived in lib/db/mappers.ts). Retained because
     * callers already build it; it is deliberately NOT read by any gate in this
     * module — see the full-record bypass below.
     */
    role: string;
    /** Server-resolved role IDENTITY (lib/db/adminIdentity.ts). */
    isSystemAdmin?: boolean;
    permissions: string[];
}

const hasPerm = (perms: string[] | undefined, name: string) => !!perms && perms.includes(name);

// NO PERMISSION BUYS ANOTHER MEMBER'S permissions[]. It is self-only (the isSelf
// short-circuit below) plus the genuine apex Admin's full-record bypass. There used
// to be a ROSTER_CAPABILITY_PERMS list that restored it, and it contained
// 'warrant:view' — a MEMBER_DEFAULT_PERMS entry (lib/roleDefaultPermissions.ts) — so
// EVERY seeded member received every other member's complete permission array off the
// `main` subset: a ready-made escalation-target map. (`main` is STAFF-gated as of
// Phase 3 item 3 — getMainState withholds the roster from a non-staff caller — but it
// is still auth-only for every STAFF tier, which is the population this exclusion was
// written for, so it is still required.) The two screens that
// justified the restore (the HR interviewer and case-officer pickers) now read
// role-level eligibility from hr:get_eligible_interviewers / hr:get_eligible_officers
// (lib/db/hr.ts), which return { id, name, avatarUrl } and never a permission string.
// Do NOT re-add a restore here.
//
// clearanceLevel is a different field with a real cross-member consumer, so it keeps a
// gate — but a Member-DISJOINT one. It is a compartmentalisation map (who is cleared to
// what), and it goes back ONLY for the surfaces that render another member's level:
//   admin:user:manage_clearance — components/modals/BulkAssignClearanceModal (the L-badge)
//   request:dispatch            — the dispatch rap sheet, subject resolved off allUsers
//   admin:user:update / admin:view:roster / hr:recruiter|manager|admin
//                               — AdminUserDetailView, UnifiedCaseFileView and
//                                 SecurityVettingModal render clearance off
//                                 `user_detail`, which runs THIS SAME strip
//                                 (api/query.ts). These are permanently load-bearing
//                                 for those screens, not a loading-state fallback.
//
// ENUMERATED, NOT DERIVED from HR_METADATA_PERMS: the two sets answer different
// questions, and deriving one from the other means a future HR widening silently
// widens the clearance gate too. Pinned disjoint from MEMBER_DEFAULT_PERMS /
// CLIENT_DEFAULT_PERMS by tests/rosterCapabilityMinimization.test.ts — never add a
// Member default (hr:view, intel:view, operations:view, warrant:view) to this list.
//
// Net effect on the seeded roles: Admin unchanged (bypass); Dispatcher keeps
// clearanceLevel and loses permissions[]; Member loses both — INCLUDING the Security
// Clearance card on another member's service record, which is the intended change.
export const CLEARANCE_VISIBLE_PERMS = [
    'admin:user:manage_clearance', 'admin:user:update', 'admin:view:roster',
    'hr:recruiter', 'hr:manager', 'hr:admin',
    'request:dispatch',
];

// Viewers who legitimately see other members' personnel metadata (probation, tenure,
// job title, RSI-verified) — recruiter-grade HR + roster admins. Deliberately EXCLUDES
// the base 'hr:view' perm: the seeded Member role holds hr:view, and the bulk roster
// (`main` subset) is STAFF-gated as of Phase 3 item 3 but still auth-only for every
// STAFF tier — which is precisely the population this exclusion was written for — so
// including hr:view would still leak this PII to every ordinary member.
// This matches the recruiter boundary the case-file internals use (isHrRecruiter).
const HR_METADATA_PERMS = [
    'admin:view:roster', 'admin:user:update',
    'hr:recruiter', 'hr:manager', 'hr:admin',
];

// Backing perms for the genuine apex Admin. The real Admin role is seeded with
// EVERY permission (seeder.ts assigns `permissions.map(p => p.name)` to 'Admin'),
// so it holds all of these — they are exactly the granular sensitive-field perms
// the allow-list ladder restores one by one. They let the full-record bypass below
// tell a real Admin from a *forged* Admin tier.
//
// Why this still matters after the role-name sweep: the bypass below now keys on
// role IDENTITY (`isSystemAdmin`), so the NAME channel is closed — but toUser
// DELIBERATELY still infers UserRole.Admin from `admin:access` for display and
// audience matching, and `admin:access` is an admin-dashboard gate perm the seeded
// Dispatcher carries too. So a hand-pruned Admin role — the real role id, with its
// apex perms revoked — must not read every member's adminNotes / personnelNotes /
// conductRecord / clearanceLevel / limitingMarkers / discordId. Identity answers
// "is this the Admin role"; this set answers "does it still carry apex authority".
// DO NOT delete this defusal as redundant: it is the only condition in the strip
// boundary whose removal would WIDEN.
const APEX_ADMIN_PERMS = [
    'admin:user:update',
    'user:manage:personnel_notes',
    'user:manage:conduct_record',
    'admin:user:manage_clearance',
    'admin:view:roster',
];

/**
 * The ONLY fields of another member's User a non-self, non-apex viewer may see.
 * Allow-list, not denylist: anything not named here is private by default.
 *
 * SHARED with lib/db/mappers.ts blankSensitiveUserFields (the embedded-card minifier)
 * so the roster boundary and the embed boundary cannot drift apart. The minifier used
 * to be a denylist of ten keys, which left rsiVerified / jobTitle / voiceChannelName /
 * timezone / dateFormat / probationStart / probationEnd / tenureStartDate /
 * tokensValidFrom unblanked — safe only because no embed happened to select those
 * columns. Sharing the builder makes the omission structural instead of incidental.
 *
 * Deliberately EXCLUDES jobTitle, voiceChannelName, timezone, dateFormat, probation*,
 * tenureStartDate, tokensValidFrom, rsiVerified, adminNotes, personnelNotes, discordId,
 * permissions, clearanceLevel, limitingMarkers, conductRecord, rsiVerificationCode,
 * rsiHandlePending, isSystemAdmin, deletedAt and auth_user_id — each is re-added by
 * stripSensitiveUserFields below only under its own permission gate, or never.
 *
 * NOT ported from the hosted build's same-named constant, which additionally hands
 * jobTitle / voiceChannelName / timezone / dateFormat / probation* / tenureStartDate to
 * EVERY viewer. This build gates those behind HR_METADATA_PERMS; keep it that way.
 */
export const ROSTER_SAFE_FIELDS: readonly (keyof User)[] = [
    'id', 'name', 'displayName', 'discordName', 'avatarUrl', 'rsiHandle',
    'role', 'roleId', 'rank', 'unit', 'position', 'secondaryPosition',
    'reputation', 'isDuty', 'isAffiliate', 'isVip', 'createdAt',
    'specializations', 'certifications', 'commendations', 'averageRating',
] as const;

/**
 * Allow-list rebuild + the four keys the `User` type requires to be present.
 * Rebuilding from scratch means a column a future SELECT adds is private by default
 * instead of riding a spread to the browser.
 *
 * KEEP THIS MODULE A LEAF: it imports only ../../types.js. mappers.ts imports it (a
 * one-way edge, no cycle), and mappers.ts is imported by nearly every db module — an
 * import of anything under lib/db/ from here would create one.
 */
export function buildRosterSafeUser(user: User): User {
    const out = {} as User;
    const src = user as unknown as Record<string, unknown>;
    const dst = out as unknown as Record<string, unknown>;
    for (const f of ROSTER_SAFE_FIELDS) dst[f] = src[f];
    // Non-optional on the User type — must be present-and-empty, never absent.
    out.discordId = '';
    out.permissions = [];
    out.conductRecord = [];
    out.limitingMarkers = [];
    return out;
}

/**
 * Strip sensitive fields from a User record before sending to a client, based on
 * the requester's role IDENTITY and permissions (never the role NAME).
 *
 * Field rules (non-admin requester):
 *   adminNotes        → only with `admin:user:update` (admin-only by UX intent;
 *                       not visible to self unless the user has the perm)
 *   personnelNotes    → self OR `user:manage:personnel_notes`
 *   conductRecord     → self OR `user:manage:conduct_record`
 *   limitingMarkers   → self OR `admin:user:manage_clearance`
 *   permissions       → SELF ONLY. No permission buys another member's array.
 *   clearanceLevel    → self OR one of CLEARANCE_VISIBLE_PERMS (Member-disjoint)
 *
 * The genuine apex Admin (the stamped system Admin role AND holding the full
 * APEX_ADMIN_PERMS set) bypasses all checks. A hand-pruned Admin role, and any
 * scoped custom role, fall through to the granular ladder.
 *
 * If `requester` is null (unauthenticated path or no resolved user), all
 * sensitive fields are stripped — defense-in-depth.
 */
export function stripSensitiveUserFields(user: User, requester: RequesterContext | null): User {
    if (!user) return user;

    const isSelf = !!requester && requester.id === user.id;

    // rsiVerificationCode + rsiHandlePending are a one-time proof-of-ownership for
    // an in-progress RSI handle change. Only the user themselves should see them —
    // blank for every other viewer, including Admins, BEFORE the Admin bypass.
    // isSystemAdmin is a SERVER-INTERNAL fact stamped on the session actor
    // (lib/db/adminIdentity.ts). It rides `...user` when the record being stripped
    // IS the actor (the self path at login / user_detail), so clear it on both
    // branches — the browser must never see or gate on it.
    const base: User = isSelf
        ? { ...user, isSystemAdmin: undefined }
        : { ...user, isSystemAdmin: undefined, rsiVerificationCode: undefined, rsiHandlePending: undefined };

    if (!requester) {
        // Unauthenticated / unresolved viewer: the SAME allow-list as a non-self
        // member, with no restores. This was a denylist over `...base`, which let
        // jobTitle / probation* / tenureStartDate / voiceChannelName / timezone /
        // dateFormat / tokensValidFrom and any ad-hoc key through — the LEAST trusted
        // viewer class had the WIDEST projection.
        return buildRosterSafeUser(base);
    }

    const perms = requester.permissions;

    // Full-record bypass for the org's system Admin, by role IDENTITY — NOT the
    // name-derived tier. `requester.role` collapsed a permissionless custom role
    // called "Commander" to 'Admin', and the admin:access defusal below could not
    // see it (no perms at all), so that account read every member's adminNotes /
    // personnelNotes / conductRecord / clearance / markers / discordId off the
    // `main` subset — which is STAFF-gated as of Phase 3 item 3, but a forged "Admin"
    // tier clears that gate too (isSystemAdmin is stamped by role identity), so this
    // defusal is unaffected and still required.
    // The defusal is RETAINED for a hand-pruned Admin role:
    // identity answers "is this the Admin role", the apex set answers "does it still
    // carry apex authority". Unstamped ⇒ false ⇒ the granular ladder (a restriction).
    if (requester.isSystemAdmin === true) {
        const adminTierForgedFromAccess =
            hasPerm(perms, 'admin:access') && !APEX_ADMIN_PERMS.every((p) => hasPerm(perms, p));
        if (!adminTierForgedFromAccess) return base;
    }

    if (isSelf) {
        // Self sees their own record. adminNotes stay admin-only by UX intent, so they
        // are blanked unless the user also holds admin:user:update.
        const out: User = { ...base };
        if (!hasPerm(perms, 'admin:user:update')) out.adminNotes = undefined;
        return out;
    }

    // Non-self, non-admin viewer: build an allow-list of the roster/profile fields a
    // member may see about another member, rather than deleting known-sensitive keys.
    // Rebuilding from scratch means any field not listed there is private by default, so
    // it can't silently leak the way the old denylist let probationStart/End,
    // tenureStartDate, jobTitle, rsiVerified, voiceChannelName, tokensValidFrom and
    // auth_user_id through to every authenticated viewer. Capability / PII fields start
    // empty and are restored below only for a viewer holding the matching permission.
    const out: User = buildRosterSafeUser(user);

    if (hasPerm(perms, 'admin:user:update')) out.adminNotes = user.adminNotes;
    if (hasPerm(perms, 'user:manage:personnel_notes')) out.personnelNotes = user.personnelNotes;
    if (hasPerm(perms, 'user:manage:conduct_record')) out.conductRecord = user.conductRecord ?? [];
    if (hasPerm(perms, 'admin:user:manage_clearance')) out.limitingMarkers = user.limitingMarkers ?? [];
    // A member's Discord snowflake is PII (enables account targeting). Only roster /
    // Discord administrators get it for other members.
    if (hasPerm(perms, 'admin:view:roster') || hasPerm(perms, 'admin:config:discord')) out.discordId = user.discordId;
    // clearanceLevel ONLY, and only for the Member-disjoint set above. `permissions`
    // stays [] from the rebuild for every non-self, non-apex viewer — see the
    // CLEARANCE_VISIBLE_PERMS header. Do not add `out.permissions = user.permissions`
    // back here; the HR pickers that used to need it now call the role-level
    // eligibility RPCs instead.
    if (CLEARANCE_VISIBLE_PERMS.some((p) => hasPerm(perms, p))) {
        out.clearanceLevel = user.clearanceLevel;
    }
    // HR/roster-capability viewers also need the personnel metadata the HR tooling
    // renders across the whole roster — the bulk `main` subset feeds the Probation tab
    // and the member tenure display. Without restoring these the allow-list would blank
    // probation/tenure for every non-Admin HR role (e.g. Dispatcher), killing those
    // features. Still withheld from rank-and-file members (no HR/roster perm).
    if (HR_METADATA_PERMS.some((p) => hasPerm(perms, p))) {
        out.probationStart = user.probationStart;
        out.probationEnd = user.probationEnd;
        out.tenureStartDate = user.tenureStartDate;
        out.jobTitle = user.jobTitle;
        out.rsiVerified = user.rsiVerified;
    }

    return out;
}

export function stripSensitiveUserFieldsBulk(users: User[], requester: RequesterContext | null): User[] {
    return users.map(u => stripSensitiveUserFields(u, requester));
}
