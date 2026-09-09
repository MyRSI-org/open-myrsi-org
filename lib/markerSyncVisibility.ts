/**
 * "Did the server withhold `syncRestricted` from this viewer?"
 *
 * Owner decision D10 (Phase 3) made the sync-restricted flag admin-only: the
 * `limitingMarkers` projection in lib/db.ts emits `syncRestricted` only for
 * `isSystemAdmin` or an `admin:access` holder, and **omits the key entirely**
 * for every tier below — it never sends `false`, because a fabricated `false`
 * would assert "this compartment IS federatable", the one thing the field must
 * never say by accident.
 *
 * The UI surfaces that render the flag (CreateOperationWizard's marker picker
 * and review step, BulkAssignClearanceModal's marker buttons) therefore go
 * quiet for an ops planner or a clearance manager. Quiet is fine; SILENT is
 * not — without a word, the picker reads as "none of these markers block
 * federation" when the truth is "you are not shown which ones do". This
 * predicate is what those surfaces use to say so.
 *
 * KEYED ON THE DATA, NOT ON A PERMISSION, on purpose. The obvious alternative
 * — `hasPermission('admin:access')` in the component — is a second copy of the
 * server's gate that can drift from it, and the client's `hasPermission`
 * unconditionally returns true for `role === 'Admin'`, so it would disagree
 * with the server for a non-system Admin-named role. Absence of the key is
 * exactly what the server decided, carried in the payload itself, so the two
 * cannot diverge.
 *
 * `=== undefined`, NEVER `!m.syncRestricted`: a marker the viewer CAN see that
 * simply is not restricted carries `false`. Treating falsy as "withheld" would
 * fire the notice on every org whose compartments are all federatable.
 *
 * Dependency-free by design (the lib/sliceMerge.ts pattern): it is imported by
 * client components, and eslint.config.js forbids those from reaching into
 * lib/db/**, while tsconfig.server.json still typechecks this file.
 */

/** Structural, not the `LimitingMarker` domain type — keeps this module free of
 *  a types.ts import so it compiles unchanged under both tsconfig targets. */
export interface SyncFlagBearer {
    syncRestricted?: boolean;
}

/**
 * True when the caller was served markers but the sync-restricted flag was
 * stripped from all of them.
 *
 * Returns false for an empty or absent list: there is nothing to label, and a
 * notice on an org with no limiting markers configured would be noise.
 */
export function isSyncRestrictedWithheld(
    markers: readonly SyncFlagBearer[] | null | undefined,
): boolean {
    if (!markers || markers.length === 0) return false;
    return markers.every(m => m.syncRestricted === undefined);
}
