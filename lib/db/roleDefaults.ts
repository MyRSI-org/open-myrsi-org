import { supabase } from './common.js';
import { OPTIONAL_MODULE_ROLE_DEFAULTS, type OptionalModuleRoleDefault } from '../roleDefaultPermissions.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'db.roleDefaults' });

/** settings row recording which one-shot role-grant backfills this install has passed. */
export const ROLE_DEFAULT_BACKFILL_MARKER_KEY = 'role_permission_backfills';

/**
 * Id of the ORIGINAL one-shot (finances / quartermaster / warehouse). The marker
 * value is `{ applied: [...] }` — an ARRAY, so a later backfill adds its own id
 * rather than a second settings row. Never bump an id to re-run the same grant: that
 * is exactly the re-grant this module exists to make impossible.
 *
 * The ids now live PER GROUP on OPTIONAL_MODULE_ROLE_DEFAULTS. This export remains
 * because it names the id every pre-existing install already carries.
 */
export const OPTIONAL_MODULE_BACKFILL_ID = 'optional-module-defaults@1';

/** Every one-shot id this build knows about, in table order, de-duplicated. */
export const ALL_BACKFILL_IDS: readonly string[] =
    [...new Set(OPTIONAL_MODULE_ROLE_DEFAULTS.map(g => g.backfillId))];

export type RoleDefaultsBackfillStatus =
    /** Rows were written (or there was nothing left to write) and the marker is stamped. */
    | 'granted'
    /** The marker already recorded this backfill — nothing was read or written. */
    | 'already-applied'
    /** Every namespace was already configured by the operator; their choice wins. */
    | 'skipped-configured'
    /** The Member/Dispatcher system roles could not be identified — declined, nothing written. */
    | 'skipped-roles'
    /** A fault aborted the pass. No marker was written, so Repair can be run again. */
    | 'failed';

export interface RoleDefaultsBackfillResult {
    status: RoleDefaultsBackfillStatus;
    granted: number;
    /** `Role:namespace` entries left alone because the role already holds something there. */
    skipped: string[];
}

type RoleSlot = { id: number; name: string } | undefined;

/**
 * Read the applied-backfill ids. Returns null on a read FAULT — never `[]`, because a
 * read error must not read as "never ran" and quietly re-grant.
 */
async function readAppliedBackfills(): Promise<string[] | null> {
    const { data, error } = await supabase.from('settings')
        .select('value').eq('key', ROLE_DEFAULT_BACKFILL_MARKER_KEY).maybeSingle();
    if (error) {
        log.error('role-defaults marker read failed; treating install as already back-filled', { code: error.code, message: error.message });
        return null;
    }
    const value = (data as { value?: unknown } | null)?.value as { applied?: unknown } | null | undefined;
    return Array.isArray(value?.applied) ? value.applied.filter((v): v is string => typeof v === 'string') : [];
}

/** Union `ids` into the recorded set. A no-op when they are all already there. */
async function writeAppliedBackfill(applied: string[], ids: readonly string[]): Promise<boolean> {
    const missing = ids.filter(id => !applied.includes(id));
    if (missing.length === 0) return true;
    const { error } = await supabase.from('settings')
        .upsert({ key: ROLE_DEFAULT_BACKFILL_MARKER_KEY, value: { applied: [...applied, ...missing] } }, { onConflict: 'key' });
    if (error) {
        log.error('role-defaults marker write failed (backfill stays re-armable)', { code: error.code, message: error.message });
        return false;
    }
    return true;
}

/**
 * Stamp the marker without granting anything — called by the seeder after a FRESH
 * install has already received the optional-module defaults in full.
 *
 * A fresh install is born correct, so the backfill must never fire on it: without
 * this stamp, the first Repair after an operator revoked (say) finance:view from
 * Member would silently hand it straight back, and Repair is step 3 of every upgrade
 * in DEPLOYMENT_GUIDE.md.
 */
export async function markOptionalModuleDefaultsApplied(): Promise<boolean> {
    const applied = await readAppliedBackfills();
    if (applied === null) return false;
    // EVERY id, so a fresh install stays born-marked for later groups too — otherwise
    // the first Repair after an operator revoked a newer namespace hands it back.
    return writeAppliedBackfill(applied, ALL_BACKFILL_IDS);
}

/**
 * ONE-SHOT grant of the optional-module defaults (finances / quartermaster /
 * warehouse) onto the Member and Dispatcher SYSTEM roles.
 *
 * WHY IT LIVES HERE AND NOT IN schema.sql. That script is a re-runnable CONVERGENCE
 * script; a grants backfill is one-time STATE, and putting it there would restore a
 * revoked permission on every upgrade. Same reasoning as drainStaleOperationReminders
 * (lib/db/opReminders.ts) — but NOT the same idempotence: draining twice drains
 * nothing, granting twice re-grants what was revoked in between.
 *
 * WHY repairDatabase IS STILL NOT SAFE ON ITS OWN. role_permissions is
 * (role_id, permission_id) with no tombstone, updateRolePermissions is
 * delete-all-then-insert, and there is no audit table — so "never granted" and
 * "deliberately revoked" are INDISTINGUISHABLE from stored state, and Repair is an
 * unbounded admin click. Three guards, all required:
 *
 *   1. MARKER. A settings row records that this backfill ran; a second Repair is a
 *      no-op even if the operator has since revoked everything it granted. Fresh
 *      installs are born marked (markOptionalModuleDefaultsApplied, called from the
 *      seeder), so it can only ever fire on an install seeded by the OLD code.
 *   2. ROLE IDENTITY. getSystemRoles() resolves positionally and falls back to
 *      `roles[1]`/`roles[2]` on a pre-is_system install, so "member" can be a custom
 *      role nobody chose. Names are re-checked here and an ambiguous install is
 *      declined outright.
 *   3. NAMESPACE GUARD. Even on the single run, a namespace the role already holds
 *      ANY permission in is skipped whole — the operator configured it and their
 *      configuration wins over the default.
 *
 * FAILS CLOSED IN BOTH DIRECTIONS. A marker READ fault is treated as "already
 * applied", so a DB blip can never cause an unintended grant. Any other fault — an
 * incomplete permission catalog included, since repair's own catalog top-up is
 * best-effort — leaves the marker UNWRITTEN so the backfill stays re-armable rather
 * than turning a transient fault into a permanent one. Never throws: Repair must not
 * become fatal.
 *
 * A pass in which the namespace guard skips EVERYTHING still stamps the marker. That
 * is the "at most once, ever" property: an install whose namespaces are all already
 * configured has made its choices, and a later Repair must not revisit them.
 *
 * Not gated on the module being enabled — the grants are inert while a feature is off
 * (the dispatcher checks the feature BEFORE the permission) and must be in place
 * before the operator flips the switch, not after.
 *
 * AFTER AN ORG IMPORT the module defaults come from the export, not from here: the
 * importer clears role_permissions and re-inserts the export's grants.
 */
export async function backfillOptionalModuleRoleDefaults(roles: {
    member?: RoleSlot;
    dispatcher?: RoleSlot;
}): Promise<RoleDefaultsBackfillResult> {
    // --- guard 1: the marker, PER GROUP --------------------------------------
    // Filtering groups rather than short-circuiting the whole pass is what lets a
    // module added after an install passed the first one-shot still reach it. A group
    // whose id is already recorded is untouchable, exactly as before.
    const applied = await readAppliedBackfills();
    if (applied === null) return { status: 'already-applied', granted: 0, skipped: [] };
    const pending = OPTIONAL_MODULE_ROLE_DEFAULTS.filter(g => !applied.includes(g.backfillId));
    if (pending.length === 0) return { status: 'already-applied', granted: 0, skipped: [] };
    const pendingIds = [...new Set(pending.map(g => g.backfillId))];

    // --- guard 2: role identity ----------------------------------------------
    // Both slots must resolve AND still carry the canonical names. getSystemRoles'
    // positional fallback can put a custom role in either slot on a renamed,
    // pre-is_system install; a backfill that declines is the fail-closed outcome, a
    // backfill that grants finance:view to "Contractors" is not.
    const member = roles.member;
    const dispatcher = roles.dispatcher;
    if (!member?.id || !dispatcher?.id || !/^member$/i.test(member.name?.trim() ?? '') || !/^dispatcher$/i.test(dispatcher.name?.trim() ?? '')) {
        log.warn('role-defaults backfill: system roles not identifiable; skipping', { member: member?.name, dispatcher: dispatcher?.name });
        return { status: 'skipped-roles', granted: 0, skipped: [] };
    }

    // --- resolve permission ids ----------------------------------------------
    const wanted = [...new Set(pending.flatMap(g => [...g.member, ...g.dispatcher]))];
    const { data: permRows, error: permErr } = await supabase
        .from('permissions').select('id, name').in('name', wanted);
    if (permErr) {
        log.error('role-defaults backfill: permission lookup failed', { code: permErr.code, message: permErr.message });
        return { status: 'failed', granted: 0, skipped: [] };
    }
    const idByName = new Map((permRows as Array<{ id: number; name: string }> | null || []).map(p => [p.name, p.id]));
    // Repair's catalog top-up only LOGS on failure, so a name can legitimately be
    // missing here. Granting a subset and then stamping the marker would make the
    // remainder unreachable forever — refuse the whole pass instead.
    const unresolved = wanted.filter(n => !idByName.has(n));
    if (unresolved.length > 0) {
        log.error('role-defaults backfill: permission catalog incomplete; leaving backfill re-armable', { missing: unresolved });
        return { status: 'failed', granted: 0, skipped: [] };
    }

    const rows: Array<{ role_id: number; permission_id: number }> = [];
    const skipped: string[] = [];

    const targets: Array<{ label: string; id: number; pick: (g: OptionalModuleRoleDefault) => readonly string[] }> = [
        { label: 'Member', id: member.id, pick: g => g.member },
        { label: 'Dispatcher', id: dispatcher.id, pick: g => g.dispatcher },
    ];

    for (const target of targets) {
        const { data: held, error: heldErr } = await supabase
            .from('role_permissions')
            .select('permission_id, permissions!inner(name)')
            .eq('role_id', target.id);
        if (heldErr) {
            log.error('role-defaults backfill: grant read failed', { role: target.label, code: heldErr.code, message: heldErr.message });
            return { status: 'failed', granted: 0, skipped: [] };
        }
        // The generated types model the to-one `permissions` embed as an array; PostgREST
        // returns an object. Same assertion as the Client-role strip in lib/db/system.ts.
        const heldNames = ((held ?? []) as unknown as Array<{ permission_id: number; permissions: { name: string } }>).map(r => r.permissions.name);

        // --- guard 3: namespace already configured → the operator's choice wins
        for (const group of pending) {
            if (heldNames.some(n => n.startsWith(group.namespace))) {
                skipped.push(`${target.label}:${group.namespace}`);
                continue;
            }
            for (const name of target.pick(group)) {
                rows.push({ role_id: target.id, permission_id: idByName.get(name) as number });
            }
        }
    }

    if (rows.length > 0) {
        const { error: upErr } = await supabase.from('role_permissions').upsert(rows, { ignoreDuplicates: true });
        if (upErr) {
            log.error('role-defaults backfill: grant write failed', { code: upErr.code, message: upErr.message });
            return { status: 'failed', granted: 0, skipped };
        }
    }

    // Marker LAST: only a pass that reached this line burns the shot, and it burns
    // ONLY the ids that actually ran.
    await writeAppliedBackfill(applied, pendingIds);

    if (rows.length === 0) {
        log.info('role-defaults backfill: every namespace already configured', { skipped });
        return { status: 'skipped-configured', granted: 0, skipped };
    }
    log.info('role-defaults backfill granted optional-module defaults', { count: rows.length, skipped });
    return { status: 'granted', granted: rows.length, skipped };
}
