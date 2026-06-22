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
 * Admin role bypasses all checks (matches services.ts dispatcher behavior).
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

    if (requester.role === 'Admin') return base;

    const perms = requester.permissions;
    const out: User = { ...base };

    if (!hasPerm(perms, 'admin:user:update')) {
        out.adminNotes = undefined;
    }
    if (!isSelf && !hasPerm(perms, 'user:manage:personnel_notes')) {
        out.personnelNotes = undefined;
    }
    if (!isSelf && !hasPerm(perms, 'user:manage:conduct_record')) {
        out.conductRecord = [];
    }
    if (!isSelf && !hasPerm(perms, 'admin:user:manage_clearance')) {
        out.limitingMarkers = [];
    }
    // A member's Discord snowflake is PII (enables account targeting). Only self
    // and roster/Discord administrators need it; strip it from the bulk roster for
    // rank-and-file members.
    if (!isSelf && !hasPerm(perms, 'admin:view:roster') && !hasPerm(perms, 'admin:config:discord')) {
        out.discordId = '';
    }
    // Keep a member's own permissions/clearance, and keep them for viewers who
    // actually use them (HR/clearance/warrant/dispatch/roster screens). Strip them
    // for everyone else — recon value with no other UI use.
    if (!isSelf && !ROSTER_CAPABILITY_PERMS.some((p) => hasPerm(perms, p))) {
        out.permissions = [];
        out.clearanceLevel = undefined;
    }

    return out;
}

export function stripSensitiveUserFieldsBulk(users: User[], requester: RequesterContext | null): User[] {
    return users.map(u => stripSensitiveUserFields(u, requester));
}
