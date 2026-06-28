import { User } from '../../types.js';

export interface RequesterContext {
    id: number;
    role: string;
    permissions: string[];
}

const hasPerm = (perms: string[] | undefined, name: string) => !!perms && perms.includes(name);

// Viewers holding any of these actually need other members' permissions/clearance
// in the UI: HR pickers (filter members by hr:* perms), clearance management (shows
// member clearance), warrant rap sheets (show the subject's clearance), dispatch
// member selection, and roster admin. Everyone else — clients and ordinary members
// — never reads another member's permissions or clearance on screen, so we strip
// those for them: it's just "who's an admin / who can see classified" recon with no
// use to the rank and file.
const ROSTER_CAPABILITY_PERMS = [
    'admin:view:roster', 'admin:user:update', 'admin:user:manage_clearance',
    'hr:recruiter', 'hr:admin', 'hr:manager',
    'warrant:view', 'warrant:create', 'warrant:manage',
    'request:dispatch', 'request:manage_responders', 'request:set_lead',
    'operations:manage',
];

// Viewers who legitimately see other members' personnel metadata (probation, tenure,
// job title, RSI-verified) — recruiter-grade HR + roster admins. Deliberately EXCLUDES
// the base 'hr:view' perm: the seeded Member role holds hr:view, and the bulk roster
// (`main` subset) is auth-only, so including it would leak this PII to every member.
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
// Why this matters: `requester.role` is the *inferred* UserRole tier from toUser
// (lib/db/mappers.ts), which currently collapses ANY role holding `admin:access`
// to UserRole.Admin. `admin:access` is only an admin-dashboard gate perm (the
// seeded Dispatcher carries it too), so a scoped custom role granted `admin:access`
// arrives here with `role === 'Admin'` yet none of the real management perms.
// Trusting the tier alone would hand every member's adminNotes / personnelNotes /
// conductRecord / clearanceLevel / limitingMarkers / discordId to that non-Admin
// admin-console role. We therefore withhold the full bypass when the Admin tier is
// derived *solely* from `admin:access` (no apex perm backing) and fall through to
// the granular ladder instead, so such a role only sees fields its explicit perms
// grant. A real Admin — and any caller passing the Admin tier without the
// forgeable `admin:access` signal — keeps the byte-for-byte legacy view.
// (The deeper fix — stop inferring UserRole.Admin from admin:access in toUser, and
// likewise in clearance.ts canViewAllClassifications — is out of this cluster's
// scope; this gate closes the strip-boundary leak regardless of the mapper.)
const APEX_ADMIN_PERMS = [
    'admin:user:update',
    'user:manage:personnel_notes',
    'user:manage:conduct_record',
    'admin:user:manage_clearance',
    'admin:view:roster',
];

/**
 * Strip sensitive fields from a User record before sending to a client,
 * based on the requester's role and permissions.
 *
 * Field rules (non-admin requester):
 *   adminNotes        → only with `admin:user:update` (admin-only by UX intent;
 *                       not visible to self unless the user has the perm)
 *   personnelNotes    → self OR `user:manage:personnel_notes`
 *   conductRecord     → self OR `user:manage:conduct_record`
 *   limitingMarkers   → self OR `admin:user:manage_clearance`
 *
 * The genuine apex Admin (tier Admin AND holding the full APEX_ADMIN_PERMS set —
 * not merely an `admin:access`-derived Admin tier) bypasses all checks. A scoped
 * custom role with `admin:access` only falls through to the granular ladder.
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
    const base: User = isSelf
        ? { ...user }
        : { ...user, rsiVerificationCode: undefined, rsiHandlePending: undefined };

    if (!requester) {
        // Unauthenticated / unresolved viewer: strip everything sensitive.
        return {
            ...base,
            adminNotes: undefined,
            personnelNotes: undefined,
            conductRecord: [],
            limitingMarkers: [],
            discordId: '',
            permissions: [],
            clearanceLevel: undefined,
        };
    }

    const perms = requester.permissions;

    // Full-record bypass for the Admin tier — but NOT when that tier is forged from
    // `admin:access` alone. A scoped role whose only admin signal is `admin:access`
    // yet lacks the real apex perm backing is treated as non-Admin here and falls
    // through to the granular ladder (see APEX_ADMIN_PERMS note). A genuine Admin
    // holds the full apex set, so it still returns the unstripped record.
    if (requester.role === 'Admin') {
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
    // Rebuilding from scratch means any field not listed here is private by default, so
    // it can't silently leak the way the old denylist let probationStart/End,
    // tenureStartDate, jobTitle, rsiVerified, voiceChannelName, tokensValidFrom and
    // auth_user_id through to every authenticated viewer.
    const out: User = {
        id: user.id,
        discordId: '',
        name: user.name,
        displayName: user.displayName,
        discordName: user.discordName,
        avatarUrl: user.avatarUrl,
        rsiHandle: user.rsiHandle,
        role: user.role,
        roleId: user.roleId,
        rank: user.rank,
        unit: user.unit,
        position: user.position,
        secondaryPosition: user.secondaryPosition,
        reputation: user.reputation,
        isDuty: user.isDuty,
        isAffiliate: user.isAffiliate,
        isVip: user.isVip,
        permissions: [],
        createdAt: user.createdAt,
        specializations: user.specializations,
        certifications: user.certifications,
        commendations: user.commendations,
        averageRating: user.averageRating,
        // Capability / PII fields default to empty and are restored below only for a
        // viewer who holds the matching permission (same rules as before).
        conductRecord: [],
        limitingMarkers: [],
    } as User;

    if (hasPerm(perms, 'admin:user:update')) out.adminNotes = user.adminNotes;
    if (hasPerm(perms, 'user:manage:personnel_notes')) out.personnelNotes = user.personnelNotes;
    if (hasPerm(perms, 'user:manage:conduct_record')) out.conductRecord = user.conductRecord ?? [];
    if (hasPerm(perms, 'admin:user:manage_clearance')) out.limitingMarkers = user.limitingMarkers ?? [];
    // A member's Discord snowflake is PII (enables account targeting). Only roster /
    // Discord administrators get it for other members.
    if (hasPerm(perms, 'admin:view:roster') || hasPerm(perms, 'admin:config:discord')) out.discordId = user.discordId;
    // Permissions + clearance are recon value for the rank-and-file; keep them only
    // for viewers who actually use them (HR / clearance / warrant / dispatch / roster).
    if (ROSTER_CAPABILITY_PERMS.some((p) => hasPerm(perms, p))) {
        out.permissions = user.permissions;
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
