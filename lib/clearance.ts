// Generic clearance + limiting-marker visibility filter (single-org).
//
// Classified resources (intel reports/bulletins, wiki pages, operations) carry a
// numeric `classificationLevel` (0 = unclassified) and a set of `limitingMarkers`
// (compartment tags). This helper enforces visibility server-side, deny-by-default
// (client-side filters are cosmetic):
//   - the item's classification must be at/below the viewer's clearance level, AND
//   - the viewer must hold EVERY limiting marker attached to the item.
// The org's system Admin (by role IDENTITY — see ClearanceUser.isSystemAdmin) and
// any caller holding one of `bypassPermissions` see everything.
//
// Marker values are compared as strings on both sides (the mappers project both
// the user's and the item's limiting markers to the same `marker` scalar).

export interface ClearanceItem {
    classificationLevel?: number | null;
    limitingMarkers?: unknown[];
}

export interface ClearanceUser {
    clearanceLevel?: { level?: number } | null;
    limitingMarkers?: unknown[];
    /**
     * Server-resolved role IDENTITY (lib/db/adminIdentity.ts), stamped on the
     * session actor by getUserById. `role` is deliberately ABSENT from this
     * interface: it is an inferred, NAME-derived display tier, so a permissionless
     * custom role called "Commander" — or literally "admin" in lowercase — cleared
     * this bypass. It must never re-enter a clearance decision.
     */
    isSystemAdmin?: boolean;
    permissions?: string[];
}

// The Admin half of this bypass is load-bearing and stays: ten wiki call sites pass
// an EMPTY bypass list (there is no wiki:manage permission), and a freshly seeded
// Admin is clearance level 0 because users.clearance_level_id is nullable with no
// default. Only the SOURCE of the admin fact changes — from a forgeable name to an
// unforgeable role identity. Unstamped ⇒ false ⇒ bypass withheld (fail closed).
export function canViewAllClassifications(user?: ClearanceUser | null, bypassPermissions: string[] = []): boolean {
    if (!user) return false;
    if (user.isSystemAdmin === true) return true;
    return Array.isArray(user.permissions) && bypassPermissions.some((p) => user.permissions!.includes(p));
}

// A limiting marker is, at runtime, the embedded security_limiting_markers ROW
// object ({ id, code, name, ... }) on BOTH the user side (mappers.toUser) and the
// item side (intel/wiki/op mappers) — the `marker:security_limiting_markers(*)`
// PostgREST alias. A previous version compared with String(m), which collapsed
// every object to '[object Object]' and defeated compartmentation (any one marker
// passed all checks). Derive a stable scalar key, preferring id, then code/name;
// strings (e.g. tests) pass through. Both sides use the same projection, so the
// same marker yields the same key.
//
// A marker that cannot be identified — null/undefined, or an object with no id,
// code or name — has NO key (null). It used to become 'v:[object Object]' (or
// 'v:null'), so two malformed markers, one on the item and one on the viewer,
// matched each other and passed. An unidentifiable ITEM marker now denies (fail
// closed); an unidentifiable VIEWER marker is dropped and satisfies nothing.
//
// The same holds one level down: a key part (id, code, name, or a scalar marker
// itself) counts only when it is a string or a finite number. Anything else
// stringifies to text unrelated values share or can forge — { id: {} } keyed as
// 'id:[object Object]', so two such markers matched; { id: [5] } and an object
// whose toString() returns '5' keyed as 'id:5' and matched a real marker 5; NaN,
// Infinity and booleans collide the same way. Such a part is skipped (the next of
// id → code → name is tried), and a marker with no usable part is unidentifiable.
// The read side (markerKey) and the write side (heldMarkerIds) share this rule.

/** A marker key part as text, or null when it is not a string or a finite number. */
function keyPart(v: unknown): string | null {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return null;
}

/** [kind, value] identifying a marker, or null when it cannot be identified. */
function markerIdentity(m: unknown): [kind: string, value: string] | null {
    if (m !== null && typeof m === 'object') {
        const o = m as Record<string, unknown>;
        for (const kind of ['id', 'code', 'name']) {
            const value = keyPart(o[kind]);
            if (value !== null) return [kind, value];
        }
        return null;
    }
    const value = keyPart(m);
    return value === null ? null : ['v', value];
}

function markerKey(m: unknown): string | null {
    const identity = markerIdentity(m);
    return identity ? `${identity[0]}:${identity[1]}` : null;
}

export function passesClearance(
    user: ClearanceUser | null | undefined,
    classificationLevel?: number | null,
    itemMarkers?: unknown[],
    bypassPermissions: string[] = [],
): boolean {
    if (canViewAllClassifications(user, bypassPermissions)) return true;
    const level = user?.clearanceLevel?.level ?? 0;
    if ((classificationLevel ?? 0) > level) return false;
    if (itemMarkers && itemMarkers.length > 0) {
        const held = new Set<string>();
        for (const k of (user?.limitingMarkers || []).map(markerKey)) {
            if (k !== null) held.add(k);
        }
        for (const m of itemMarkers) {
            const k = markerKey(m);
            if (k === null || !held.has(k)) return false;
        }
    }
    return true;
}

export function filterByClearance<T extends ClearanceItem>(
    items: T[],
    user?: ClearanceUser | null,
    bypassPermissions: string[] = [],
): T[] {
    if (canViewAllClassifications(user, bypassPermissions)) return items;
    return items.filter((it) => passesClearance(user, it.classificationLevel, it.limitingMarkers, bypassPermissions));
}

// ---------------------------------------------------------------------------
// WRITE-side clearance integrity
//
// passesClearance/filterByClearance are READ-side. Authoring paths (intel
// reports, wiki pages, operations) must not accept a client-supplied
// classification level + marker ids verbatim, or a low-clearance author could
// mislabel content UP to a level they cannot read, or apply a compartment marker
// they do not hold. Mirrored from the read side: the population that may VIEW all
// classifications in a domain (the system Admin by role identity, or the domain's
// `*:manage` bypass) is exactly the population that may CLASSIFY at any level /
// with any marker.
// Everyone else is bounded by their own clearance level and held markers.
//
// This guards the NEW label. Preventing a *downgrade* of an existing classified
// resource the caller cannot currently see is a separate current-visibility check
// the caller must apply at the relabel site (see updateWikiPage) —
// assertCanClassify alone does not block setting level to 0.

/**
 * Held limiting-marker id set for the user (markers project to {id,...}): each
 * marker's identifying value, id → code → name, under the same key-part rule as
 * the read side. An unidentifiable held marker adds nothing.
 */
function heldMarkerIds(user?: ClearanceUser | null): Set<string> {
    const ids = new Set<string>();
    for (const m of (user?.limitingMarkers || [])) {
        const identity = markerIdentity(m);
        if (identity) ids.add(identity[1]);
    }
    return ids;
}

/**
 * Throws if `user` may not author content at `classificationLevel` with
 * `markerIds`. The system Admin (role identity) / `bypassPermissions` holders may
 * classify anything.
 * Everyone else: the level must be at/below their clearance, and they must
 * hold every applied marker. Fails closed (no user → clearance 0, no markers).
 */
export function assertCanClassify(
    user: ClearanceUser | null | undefined,
    classificationLevel?: number | null,
    markerIds?: Array<number | string> | null,
    bypassPermissions: string[] = [],
): void {
    if (canViewAllClassifications(user, bypassPermissions)) return;

    const level = user?.clearanceLevel?.level ?? 0;
    if ((classificationLevel ?? 0) > level) {
        throw new Error('You cannot classify content above your own clearance level.');
    }
    if (markerIds && markerIds.length > 0) {
        const held = heldMarkerIds(user);
        for (const mid of markerIds) {
            if (mid === undefined || mid === null) continue;
            if (!held.has(String(mid))) {
                throw new Error('You cannot apply a limiting marker you do not hold.');
            }
        }
    }
}
