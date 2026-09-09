/**
 * Default permissions granted to the Member and Dispatcher system roles on a
 * FRESH install (lib/db/seeder.ts) — and, for the optional-module subset only,
 * back-filled ONCE onto an already-seeded install (lib/db/roleDefaults.ts).
 *
 * Hoisted out of seedInstall's body so the seeder and the backfill read ONE list
 * instead of two literals that drift apart. Same single-source-of-truth reasoning
 * as CLIENT_DEFAULT_PERMS; dependency-free for the same reason, so a test can
 * import it with no mocks.
 *
 * A DEFAULT, NOT A DEFINITION. The Admin role is DEFINED as "every permission" and
 * is re-converged on every Repair; the Client role is CLAMPED to
 * CLIENT_DEFAULT_PERMS and has its excess stripped (both in repairDatabase,
 * lib/db/system.ts). These two lists are a STARTING POINT — an org that revokes one
 * has made a choice, and nothing may quietly put it back. That is why the seeder's
 * Member/Dispatcher legs are fresh-only and why the backfill is marker-gated.
 *
 * Three surfaces now describe a permission: schema.sql §7 (the catalog),
 * GLOBAL_PERMISSIONS (the repair backstop) and these lists. A misspelt string here
 * is SILENTLY DROPPED by the seeder's `if (pId)` guard, so
 * tests/seederRoleDefaults.test.ts pins every entry against §7.
 *
 * `*:admin` buckets (finance / qm / warehouse / marketplace) configure a module and
 * stay with the operator on the Admin role. `finance:manage` is withheld from
 * Dispatcher as well: it covers reverse_entry, record_adjustment,
 * create/update/archive_account and reconcile.
 *
 * ACADEMY IS DELIBERATELY ABSENT FROM BOTH LISTS. In this build `academy:view` gates
 * the STAFF bundle — api/query.ts maps subset `academy` to it, and that subset is
 * db.getAcademyStaffState(), every course including unpublished drafts. The
 * member-facing surface is `academy_my`, which has no permission gate at all, and the
 * nav entry is feature-flag-only (components/layout/Sidebar.tsx), so a member holding
 * zero academy:* strings already has a complete My Academy. Do not "restore parity"
 * with a build where academy:view means the member baseline — that would hand every
 * member the unpublished-course staff bundle.
 */
export const MEMBER_DEFAULT_PERMS: readonly string[] = [
    'alliance:view', 'user:receive:eam', 'fleet:view', 'fleet:manage_own', 'hr:view',
    'intel:view', 'intel:view:clearance', 'intel:create', 'warrant:view', 'operations:view',
    'request:create', 'request:create_adhoc', 'request:accept', 'request:start', 'request:complete',
    'request:cancel', 'request:rate', 'user:toggle_duty', 'user:view:roster', 'user:manage:self',
    'wiki:view', 'gov:view', 'gov:participate',
    'marketplace:view', 'marketplace:list', 'marketplace:contract',
    // Optional modules — read and participate only. All three are DEFAULT-OFF and the
    // dispatcher's feature gate runs BEFORE the permission gate, so these are inert
    // until an operator enables the module. The `:request` / `:deposit` rungs are
    // unusable without the matching `:view` (nav entry and view are both view-gated),
    // which is why each namespace grants its view string too.
    'finance:view', 'finance:deposit', 'finance:withdraw_request',
    'qm:view', 'qm:request',
    'warehouse:view', 'warehouse:request',
    // Blueprints: the member tier is the whole two-sided flow except moderation.
    // A member registers their own blueprints, offers to craft, asks for a craft
    // and takes someone else's ask — none of which touches anyone else's rows.
    'blueprint:view', 'blueprint:register', 'blueprint:request', 'blueprint:craft',
] as const;

export const DISPATCHER_DEFAULT_PERMS: readonly string[] = [
    'alliance:view', 'radio:manage', 'admin:broadcast:eam', 'user:receive:eam', 'fleet:view',
    'fleet:manage_own', 'fleet:manage', 'hr:view', 'hr:recruiter', 'hr:manager', 'hr:admin',
    'hr:manage:positions', 'admin:manage:documents', 'intel:view', 'intel:view:clearance',
    'intel:create', 'intel:manage', 'warrant:view', 'warrant:create', 'warrant:manage',
    'operations:view', 'operations:create', 'operations:manage', 'unit:manage:own',
    'request:create', 'request:create_adhoc', 'request:triage', 'request:dispatch', 'request:accept',
    'request:start', 'request:complete', 'request:cancel', 'request:delete',
    'request:manage_responders', 'request:set_lead', 'request:update', 'request:rate',
    'request:view:feedback', 'admin:access', 'admin:config:notices', 'admin:view:roster',
    'admin:view:clients', 'user:manage:conduct_record', 'user:toggle_duty',
    'admin:award:certification', 'admin:award:commendation', 'user:view:roster', 'user:manage:self',
    'wiki:view', 'wiki:add_page', 'wiki:edit_page', 'wiki:delete_page',
    'gov:view', 'gov:participate', 'gov:electoral_officer', 'gov:manage',
    'marketplace:view', 'marketplace:list', 'marketplace:contract',
    // Optional modules — the operational tier. Finances stops at `approve`: the
    // Dispatcher triages money, it does not restructure it. `finance:manage` (reversals,
    // adjustments, account create/archive, reconcile) stays with the Admin role, and so
    // does every `*:admin` module-config bucket. The CSV export the Dispatcher needs is
    // the ACTION 'finance:export_csv' / 'qm:export_csv' / 'warehouse:export_csv', each
    // gated on its namespace's `:view` PERMISSION (api/services.ts) — there is no
    // `finance:export_csv` permission to grant.
    'finance:view', 'finance:approve',
    'qm:view', 'qm:request', 'qm:manage',
    'warehouse:view', 'warehouse:request', 'warehouse:manage',
    'blueprint:view', 'blueprint:register', 'blueprint:request', 'blueprint:craft', 'blueprint:manage',
] as const;

export interface OptionalModuleRoleDefault {
    /** Permission-name prefix, e.g. 'qm:' — the unit the backfill's guard reasons about. */
    namespace: string;
    /**
     * Which ONE-SHOT this group belongs to.
     *
     * Per-group, not per-file, because a module added later must still reach an
     * install that already passed the earlier one-shot. A single file-wide id makes
     * every future group DECORATIVE on every existing deployment: the marker already
     * names it, so the whole pass short-circuits and the new namespace is never
     * granted. Never reuse an id for a changed group — that re-runs the old grant.
     */
    backfillId: string;
    member: readonly string[];
    dispatcher: readonly string[];
}

/**
 * The optional-module subset of the two lists above, grouped by namespace, for the
 * one-shot repair backfill (lib/db/roleDefaults.ts).
 *
 * ONLY these namespaces are ever back-filled. The core grants (intel, ops, hr,
 * requests, wiki, gov, marketplace, alliance, fleet) are not: an install that has them
 * is already correct, and an install that has had one revoked did it on purpose. This
 * table exists so the backfill's blast radius is a closed, reviewable list rather than
 * "the whole default set", and so the guard can skip a namespace WHOLE rather than
 * per-string.
 *
 * Every string here must also appear in the matching list above — pinned by
 * tests/seederRoleDefaults.test.ts.
 */
export const OPTIONAL_MODULE_ROLE_DEFAULTS: readonly OptionalModuleRoleDefault[] = [
    {
        namespace: 'finance:',
        backfillId: 'optional-module-defaults@1',
        member: ['finance:view', 'finance:deposit', 'finance:withdraw_request'],
        dispatcher: ['finance:view', 'finance:approve'],
    },
    {
        namespace: 'qm:',
        backfillId: 'optional-module-defaults@1',
        member: ['qm:view', 'qm:request'],
        dispatcher: ['qm:view', 'qm:request', 'qm:manage'],
    },
    {
        namespace: 'warehouse:',
        backfillId: 'optional-module-defaults@1',
        member: ['warehouse:view', 'warehouse:request'],
        dispatcher: ['warehouse:view', 'warehouse:request', 'warehouse:manage'],
    },
    {
        namespace: 'blueprint:',
        backfillId: 'blueprint-defaults@1',
        member: ['blueprint:view', 'blueprint:register', 'blueprint:request', 'blueprint:craft'],
        dispatcher: ['blueprint:view', 'blueprint:register', 'blueprint:request', 'blueprint:craft', 'blueprint:manage'],
    },
] as const;
