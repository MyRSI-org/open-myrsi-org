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
function markerKey(m: unknown): string {
    if (m && typeof m === 'object') {
        const o = m as Record<string, unknown>;
        if (o.id !== undefined && o.id !== null) return `id:${String(o.id)}`;
        if (o.code !== undefined && o.code !== null) return `code:${String(o.code)}`;
        if (o.name !== undefined && o.name !== null) return `name:${String(o.name)}`;
    }
    return `v:${String(m)}`;
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
        const held = new Set<string>((user?.limitingMarkers || []).map(markerKey));
        for (const m of itemMarkers) {
            if (!held.has(markerKey(m))) return false;
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

/** Held limiting-marker id set for the user (markers project to {id,...}). */
function heldMarkerIds(user?: ClearanceUser | null): Set<string> {
    const ids = new Set<string>();
    for (const m of (user?.limitingMarkers || [])) {
        if (m && typeof m === 'object') {
            const o = m as Record<string, unknown>;
            if (o.id !== undefined && o.id !== null) { ids.add(String(o.id)); continue; }
            if (o.code !== undefined && o.code !== null) { ids.add(String(o.code)); continue; }
            if (o.name !== undefined && o.name !== null) { ids.add(String(o.name)); continue; }
        } else if (m !== undefined && m !== null) {
            ids.add(String(m));
        }
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
