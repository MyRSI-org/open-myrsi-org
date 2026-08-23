// Full-organization data importer (single-org self-hosted fork).
//
// Consumes the NDJSON export produced by the hosted app's customer-portal
// "Export Organization Data" feature (my-rsi-rg/lib/db/exporter.ts). The export
// is FK-dependency ordered (parents before children) and carries:
//   - original integer/UUID ids (preserved verbatim on import)
//   - catalog external keys (platform_ships / permissions / quartermaster_catalog)
//     so this fork can remap catalog FKs against its OWN freshly-synced catalogs
//   - organization_id stripped, secrets/hashes excluded
//
// SAFETY: import is REFUSED unless the DB is empty of org data (see
// assertDatabaseEmpty). It is a one-shot bootstrap, NOT a merge. Admin-gated at
// the action layer.
//
// All `any` is confined to this module via the untyped `sb` view, mirroring the
// exporter's Queryable pattern. The fork's supabase client is created WITHOUT a
// <Database> generic, so generic table-name-driven writes are already loose —
// `sb` just makes that explicit and contained.

import { randomBytes } from 'node:crypto';
import { supabase } from './common.js';
import { log as baseLog } from '../log.js';
import { sanitizeImageUrl } from '../imageUrl.js';
import { sanitizePublicLinkUrl } from '../linkUrl.js';
import { stripHtml } from '../textSanitize.js';
import { sanitizeTiptapJson, tryParseTiptapJson } from '../tiptapValidate.js';
import { sanitizeRichHtml } from '../htmlSanitize.js';

const log = baseLog.child({ module: 'db.importer' });

// Must match exporter.EXPORT_FORMAT_VERSION.
export const IMPORT_FORMAT_VERSION = 1;

// PostgREST insert batch cap — keep well under the 1000-row response limit and
// the statement size budget.
const INSERT_BATCH = 200;

// ---------------------------------------------------------------------------
// Structural view of the untyped query builder (no `any` escapes the module).
// ---------------------------------------------------------------------------
// PostgREST hands back the parsed error body as a PLAIN object (not a
// PostgrestError instance) on the `{ data, error }` path this module uses, so
// `details`/`hint` are present and must be typed to be logged — see insertRows.
interface PostgrestErrorShape { message: string; code?: string; details?: string | null; hint?: string | null }
interface WriteResult { data: Record<string, unknown>[] | null; error: PostgrestErrorShape | null; }
interface SelectResult { data: Record<string, unknown>[] | null; error: PostgrestErrorShape | null; count?: number | null; }
interface Insertable extends PromiseLike<WriteResult> {
    insert: (rows: Record<string, unknown>[] | Record<string, unknown>) => Insertable;
    update: (patch: Record<string, unknown>) => Insertable & { eq: (c: string, v: unknown) => PromiseLike<WriteResult> };
    delete: () => { neq: (c: string, v: unknown) => PromiseLike<WriteResult>; eq: (c: string, v: unknown) => PromiseLike<WriteResult>; in: (c: string, v: unknown[]) => PromiseLike<WriteResult> };
    select: (sel: string, opts?: { count?: 'exact'; head?: boolean }) => Insertable & {
        eq: (c: string, v: unknown) => Insertable;
        in: (c: string, v: unknown[]) => Insertable;
        range: (a: number, b: number) => PromiseLike<SelectResult>;
    };
    eq: (c: string, v: unknown) => Insertable;
}
const sb = supabase as unknown as {
    from: (t: string) => Insertable;
    rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

// ---------------------------------------------------------------------------
// Parsed export shape (matches OrgExportHeader in types.ts + NDJSON row lines).
// ---------------------------------------------------------------------------
export interface ImportHeader {
    kind: 'header';
    version: number;
    exportedAt?: string;
    sourceApp?: string;
    /** `features` is the source org's optional-module on/off state. It rides the
     *  HEADER rather than a settings row because `organizations` (where the hosted
     *  app keeps it) is never exported — see applyImportedFeatureToggles. Typed as
     *  `unknown` values, not booleans: this is attacker-controlled input and is
     *  allowlisted + coerced, never trusted by shape. */
    sourceOrg?: { name?: string; slug?: string; features?: Record<string, unknown> };
    tableOrder: string[];
    manifest: Record<string, number>;
}

export interface ParsedExport {
    header: ImportHeader;
    /** rows grouped by table, in first-seen (export) order within each table. */
    rowsByTable: Map<string, Record<string, unknown>[]>;
    totalRows: number;
}

/** Why a row did not make it in. `rowsSkipped` is the SUM of these — it was
 *  previously reported to the operator as "rows from unrecognized tables", which
 *  is only ONE of the five causes and hid the one that actually cost data
 *  (`catalogMiss`: a ship whose model this instance's catalog lacks). Every
 *  `rowsSkipped` increment must land in exactly one bucket. */
export interface ImportSkipBreakdown {
    /** Table present in the export but not in IMPORTABLE_TABLES (older fork). */
    unknownTable: number;
    /** Table deliberately never imported (deployment-local federation state). */
    excludedTable: number;
    /** A required catalog FK (ship / permission / QM item) did not resolve here. */
    catalogMiss: number;
    /** The row itself was rejected by the database (FK orphan, CHECK, enum, unique). */
    constraintViolation: number;
    /** A `settings` key on SETTINGS_IMPORT_DENYLIST — deployment config stays local. */
    deploymentSettings: number;
}

export interface ImportResult {
    tablesProcessed: number;
    rowsInserted: number;
    rowsSkipped: number;
    /** Per-cause split of `rowsSkipped` (they sum to it). */
    skipBreakdown: ImportSkipBreakdown;
    sequencesReset: string[];
    warnings: string[];
    /** Optional modules switched ON from the export header's `sourceOrg.features`,
     *  by display label, so the operator can see what the import enabled. */
    modulesEnabled: string[];
    /** When a first-run/admin MERGE re-anchored the acting admin onto an imported
     *  identity, the admin's resulting users.id + role_id — the caller re-issues a
     *  session token for it. Absent when no merge occurred. */
    reanchoredAdminUserId?: number;
    reanchoredAdminRoleId?: number;
}

/** Admin↔imported-user merge (id-reanchor). The acting admin "maps to" an imported
 *  user; their Discord login + Admin role are re-anchored onto that imported row,
 *  which keeps the imported identity + every historical FK intact. */
export interface ImportMergeOptions {
    /** The export users.id the acting admin identified as themselves. */
    importedUserId: number;
    /** The acting admin's current users.id (server-supplied; never client-trusted). */
    adminUserId: number;
}

// Explicit users column list (NO select('*') — pinned by the wildcard ratchet) for
// capturing the seeded admin row before a merge, so it can be restored on failure.
const USERS_COLUMNS = 'id, auth_user_id, created_at, discord_id, name, avatar_url, rsi_handle, reputation, role_id, rank_id, unit_id, clearance_level_id, position_id, secondary_position_id, job_title, is_duty, admin_notes, personnel_notes, voice_channel_name, deleted_at, rsi_handle_pending, rsi_verification_code, rsi_verified, discord_synced_at, probation_start, probation_end, display_name, timezone, date_format, is_affiliate, is_vip, tenure_start_date';

// ---------------------------------------------------------------------------
// Per-table import policy. Anything not listed uses defaults (no self-ref,
// no catalog remap). The set of importable tables is the header.tableOrder ∩
// IMPORTABLE_TABLES — any unknown table in the export is skipped with a warning
// so a newer export can't silently write to tables this fork doesn't model.
// ---------------------------------------------------------------------------

/** Self-referential FK columns to NULL on first pass and restore on second pass. */
const SELF_REF_FKS: Record<string, string[]> = {
    units: ['parent_unit_id'],
    locations: ['parent_id'],
    quartermaster_locations: ['parent_id'],
    fleet_groups: ['parent_id'],
    operation_command_nodes: ['parent_id'],
    wiki_pages: ['parent_page_id'],
    government_elections: ['parent_election_id'],
    government_legislation: ['parent_legislation_id', 'repealed_by_legislation_id'],
    treasury_ledger_entries: ['related_entry_id'],
};

// Cross-table FK columns that reference a table imported LATER (a circular dependency
// the exporter can't order around). NULLed on insert and restored after the FULL
// import, once the referenced rows exist. The only one today: units.leader_id → users,
// while users.unit_id → units (units is exported before users). Restore is tolerant —
// a referenced row missing from the export leaves the (nullable) FK null.
const DEFERRED_FKS: Record<string, string[]> = {
    units: ['leader_id'],
};

// FK columns NULLed on import because they reference a table whose ids don't carry
// over from the hosted SaaS. Today: the intel-sharing FEDERATION link — intel_reports/
// warrants.source_feed_id pointed at the source org's feed; the fork references
// alliance_peers, empty on a fresh self-hosted instance. The column is nullable, so the
// report/warrant imports WITHOUT the (now-meaningless) federated source link rather than
// orphaning on the FK.
const NULL_FKS: Record<string, string[]> = {
    intel_reports: ['source_feed_id'],
    warrants: ['source_feed_id'],
};

// FK columns pointing at a row that THIS import may have dropped on a required
// catalog remap (see prepareRow step 1a). The droppable parents are the tables with a
// `required: true` CATALOG_REMAPS entry — user_ships (an unsynced ship model) and
// quartermaster_inventory (an unsynced platform item). Without an entry here their
// dependants FK-fail one at a time in the row-by-row fallback and are reported as a
// generic "rejected by the database", which hides the fact that ONE unsynced catalog
// caused all of it. `nullable` mirrors the local schema exactly.
// (role_permissions is the third required remap but nothing references a grant.)
// Every parent listed here MUST be inserted earlier in the export's tableOrder, which
// the exporter guarantees. Completeness is pinned by
// tests/importTableSetInvariants.test.ts against schema.sql, not by this comment.
export const DROPPED_PARENT_FKS: Record<string, { col: string; parent: string; nullable: boolean }[]> = {
    // user_ships.ship_id is NOT NULL → an unsynced ship model drops the hangar row.
    fleet_group_ships: [{ col: 'user_ship_id', parent: 'user_ships', nullable: false }],
    operation_participants: [{ col: 'user_ship_id', parent: 'user_ships', nullable: true }],
    // quartermaster_inventory rows for PLATFORM catalog items drop when the item
    // catalog is unsynced. Both dependants' inventory_id is NOT NULL (ON DELETE
    // RESTRICT), so they cannot survive their parent — but they can at least be
    // counted and explained instead of failing opaquely.
    quartermaster_issuances: [{ col: 'inventory_id', parent: 'quartermaster_inventory', nullable: false }],
    quartermaster_inventory_movements: [{ col: 'inventory_id', parent: 'quartermaster_inventory', nullable: false }],
};

// Secret / transient per-install columns that must NEVER carry over from a source
// export, on ANY table (table-agnostic + future-proof). A hand-crafted or
// pre-hardening NDJSON could otherwise import a verification token, pending
// rename, or hashed credential verbatim. Dropped (not nulled) in prepareRow so a
// column the fork schema lacks is simply absent rather than a stray null insert.
const SECRET_DROP_COLUMNS = new Set<string>([
    'rsi_verification_code', 'rsi_handle_pending', 'key_hash', 'password_hash', 'webhook_secret',
]);

/**
 * Catalog FK remap config. The exporter embedded the remote catalog row's stable
 * external key under an alias equal to the catalog table name. We resolve the
 * fork's matching catalog id by external key and rewrite the FK column.
 */
interface CatalogRemap {
    /** FK column on the row being imported. */
    fkColumn: string;
    /** Alias under which the exporter embedded the external key object (== catalog table name). */
    embedAlias: string;
    /**
     * EVERY lookup key form this object supports, most precise FIRST. Used for both
     * sides of the match: `buildCatalogIndex` indexes a fork catalog row under ALL of
     * them, and `prepareRow` probes an export embed's forms in this order and takes
     * the first hit.
     *
     * It is deliberately a LIST, not a single key. The old single-key form chose one
     * form per row by preference, which meant the two sides could pick DIFFERENT
     * branches for the same ship and miss — see PLATFORM_SHIP_REMAP for the concrete
     * failure. Prefixing each form (`a:` / `u:` / `n:`) keeps the forms in one map
     * without collision.
     */
    keysOf: (obj: Record<string, unknown>) => string[];
    /** Fork catalog table to index. */
    catalogTable: string;
    /** Columns to select from the fork catalog for keying. */
    catalogSelect: string;
    /** Predicate: only remap rows for which this returns true (else leave FK as-is). */
    shouldRemap?: (embed: Record<string, unknown>) => boolean;
    /** When the catalog id can't be resolved: if true the ROW is dropped (the FK is
     *  NOT NULL / CHECK-constrained — a grant/ship for a catalog this fork lacks is
     *  meaningless and can't be nulled); if false the FK is set NULL. */
    required?: boolean;
    /** Where the operator syncs THIS catalog, for the "row skipped" warning. Omitted
     *  when there is nothing to sync (permissions are code-owned and seeded on boot). */
    syncHint?: string;
}

/**
 * Ship catalog key forms, most precise first: api id → uuid → name+manufacturer.
 *
 * WHY THE ORDER, AND WHY ALL THREE. `platform_ships` rows can carry either external
 * id, both, or neither, and the two installs populate them differently:
 *   - a self-hosted catalog is api-id-ONLY (syncShipCatalog upserts on
 *     external_api_id and never writes external_uuid — lib/db/fleet.ts),
 *   - a hosted row created before its shipmatrix pivot carries BOTH (that migration
 *     stamped the api id onto legacy rows rather than replacing the uuid),
 *   - a hosted legacy paint variant shipmatrix does not enumerate carries NEITHER.
 * The old code stored exactly one key per catalog row and computed exactly one key
 * per embed, both uuid-first — so a both-keys embed produced `u:` while an api-id-only
 * catalog produced `a:`, a guaranteed miss on EVERY ship. (`fleet_groups` has no
 * catalog FK, which is why the symptom was an intact group tree containing nothing.)
 * Indexing every form makes the match succeed whichever columns each side happens to
 * hold, and probing in precision order means a name collision can never outrank a
 * real external id.
 *
 * The name+manufacturer form is the LAST resort and exists only for the rows with no
 * external id at all. It is sound because both catalogs derive their names from the
 * same upstream feed and the fork's own sync already claims legacy rows by exactly
 * this pair (lib/db/fleet.ts). Lower-cased + trimmed, exact otherwise — no fuzzy
 * matching, ever.
 */
function shipCatalogKeys(o: Record<string, unknown>): string[] {
    const keys: string[] = [];
    if (o.external_api_id != null) keys.push(`a:${String(o.external_api_id)}`);
    if (o.external_uuid != null) keys.push(`u:${String(o.external_uuid)}`);
    const name = typeof o.name === 'string' ? o.name.trim().toLowerCase() : '';
    const manufacturer = typeof o.manufacturer === 'string' ? o.manufacturer.trim().toLowerCase() : '';
    if (name && manufacturer) keys.push(`n:${name}|${manufacturer}`);
    return keys;
}

// Shared by every FK that points at platform_ships. One definition so the two
// consumers can never key the same catalog differently (buildCatalogIndex caches
// one index per catalogTable — see importOrgData).
const PLATFORM_SHIP_REMAP = {
    embedAlias: 'platform_ships',
    catalogTable: 'platform_ships',
    // name/manufacturer are part of the key set (see shipCatalogKeys), so they must
    // be selected. Explicit column list — never a wildcard (security rule 1).
    catalogSelect: 'id, external_uuid, external_api_id, name, manufacturer',
    keysOf: shipCatalogKeys,
    syncHint: 'Admin → Catalogs → Ship Catalog (Sync from Wiki)',
} as const;

export const CATALOG_REMAPS: Record<string, CatalogRemap> = {
    user_ships: {
        ...PLATFORM_SHIP_REMAP,
        fkColumn: 'ship_id',
        required: true, // user_ships.ship_id is NOT NULL — drop ships whose platform model isn't synced
    },
    // operation_participants.ship_id is nullable (ON DELETE SET NULL) and the exporter
    // nullifies it + embeds the same key object, so an unresolvable model costs the
    // ship attribution on that participant, never the participation record itself.
    operation_participants: {
        ...PLATFORM_SHIP_REMAP,
        fkColumn: 'ship_id',
        required: false,
    },
    role_permissions: {
        fkColumn: 'permission_id',
        embedAlias: 'permissions',
        catalogTable: 'permissions',
        catalogSelect: 'id, name',
        required: true, // permission_id is NOT NULL — drop grants for perms this fork doesn't have
        // No syncHint: `permissions` is a CODE-OWNED catalog seeded on first boot, not
        // something the operator can sync. A miss means the source org held a permission
        // this fork does not define; ensureAdminRoleHasAllPermissions covers the reverse.
        keysOf: (o) => (o.name != null ? [`n:${String(o.name)}`] : []),
    },
    quartermaster_inventory: {
        fkColumn: 'catalog_id',
        embedAlias: 'quartermaster_catalog',
        catalogTable: 'quartermaster_catalog',
        catalogSelect: 'id, external_uuid, external_id, source',
        required: true, // catalog_id has a NOT-NULL-or-custom_name CHECK; platform rows have no custom_name
        syncHint: 'Admin → Catalogs → Item Catalog',
        // Only platform catalog rows need remap; custom rows were imported with
        // their original ids preserved, so their catalog_id already resolves.
        shouldRemap: (e) => e.source === 'platform',
        keysOf: (o) => {
            if (o.source !== 'platform') return [];
            const keys: string[] = [];
            if (o.external_uuid != null) keys.push(`u:${String(o.external_uuid)}`);
            if (o.external_id != null) keys.push(`e:${String(o.external_id)}`);
            return keys;
        },
    },
    // Category taxonomies are seeded per install, so the raw integer category_id is
    // meaningless here — the exporter NULLs it and embeds the stable slug instead.
    // required:false is load-bearing: an unmatched slug must leave the listing
    // UNCATEGORISED, never drop it (category_id is nullable on both sides).
    marketplace_listings: {
        fkColumn: 'category_id',
        embedAlias: 'marketplace_categories',
        catalogTable: 'marketplace_categories',
        catalogSelect: 'id, slug',
        required: false,
        keysOf: (o) => (o.slug != null ? [`s:${String(o.slug)}`] : []),
    },
};

// All embed-alias keys that must be stripped from any row before insert (they are
// joined objects, never real columns — an un-stripped embed fails the whole row).
// Pinned as a superset of every CATALOG_REMAPS embedAlias by
// tests/importTableSetInvariants.test.ts, so a new remap cannot forget its entry.
export const STRIP_ALWAYS = new Set<string>([
    'platform_ships', 'permissions', 'quartermaster_catalog', 'marketplace_categories',
]);

// ---------------------------------------------------------------------------
// Emptiness guard. Refuse to import on top of an existing org. We check a small
// set of high-signal user/content tables that a fresh seed never populates
// (roles/settings ARE seeded on boot, so they are deliberately excluded here).
// Any non-zero row count aborts.
// ---------------------------------------------------------------------------
const EMPTINESS_GUARD_TABLES = [
    'users', 'service_requests', 'operations', 'wiki_pages',
    'intel_reports', 'warrants', 'announcements', 'treasury_ledger_entries',
];

/**
 * A REFUSAL, as distinct from a failure: the import was declined before a single
 * row was written, so the instance is exactly as it was.
 *
 * The distinction is load-bearing in the UI, not cosmetic. The first-run wizard's
 * import-failed panel tells the operator that the instance "may now hold partial
 * data", that it is not safe to continue or skip, and to reset the database and
 * start over — correct for a failure halfway through 40k rows, and actively harmful
 * for a refusal, where the honest advice is "fix the one named thing and try again".
 * Since the empty-ship-catalog refusal fires on the ORDINARY fresh-install path,
 * routing it through the destructive panel would have been the common case.
 */
export class ImportRefusedError extends Error {
    readonly refused = true;
    constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = 'ImportRefusedError'; }
}

export async function assertDatabaseEmpty(): Promise<void> {
    for (const table of EMPTINESS_GUARD_TABLES) {
        const { count, error } = await sb.from(table).select('id', { count: 'exact', head: true }) as unknown as SelectResult;
        if (error) {
            // Missing table (migration not run) is fine — treat as empty.
            if (error.code === '42P01' || error.code === 'PGRST205') continue;
            throw new Error(`Pre-import emptiness check failed on ${table}: ${error.message}`);
        }
        if ((count || 0) > 0) {
            throw new ImportRefusedError(
                `Import refused: this instance already contains data (${table} has ${count} rows). ` +
                `Org import is a one-time bootstrap into an empty instance.`,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// NDJSON parsing. Accepts the full export text. Tolerant of blank lines and
// the two line shapes: {kind:'header',...} and {kind:'row', t, r}. Rows are
// grouped by table preserving order. Header MUST be the first non-blank line.
// ---------------------------------------------------------------------------
export function parseExport(ndjson: string): ParsedExport {
    const lines = ndjson.split(/\r?\n/);
    let header: ImportHeader | null = null;
    const rowsByTable = new Map<string, Record<string, unknown>[]>();
    let totalRows = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(line); }
        catch (e) { throw new Error(`Invalid JSON on line ${i + 1}: ${(e as Error).message}`, { cause: e }); }

        if (obj.kind === 'header') {
            if (header) throw new Error('Multiple header lines in export.');
            header = obj as unknown as ImportHeader;
        } else if (obj.kind === 'row') {
            if (!header) throw new Error('Encountered a row line before the header line.');
            const t = String(obj.t);
            const r = obj.r as Record<string, unknown>;
            if (!t || typeof r !== 'object' || r === null) throw new Error(`Malformed row line ${i + 1}.`);
            let bucket = rowsByTable.get(t);
            if (!bucket) { bucket = []; rowsByTable.set(t, bucket); }
            bucket.push(r);
            totalRows++;
        } else {
            throw new Error(`Unknown line kind "${String(obj.kind)}" on line ${i + 1}.`);
        }
    }

    if (!header) throw new Error('Export is missing its header line.');
    if (header.version !== IMPORT_FORMAT_VERSION) {
        throw new Error(`Unsupported export version ${header.version}. This instance imports version ${IMPORT_FORMAT_VERSION}.`);
    }
    if (!Array.isArray(header.tableOrder)) throw new Error('Export header is missing tableOrder.');

    return { header, rowsByTable, totalRows };
}

// ---------------------------------------------------------------------------
// Catalog index builders: load the fork's freshly-synced catalogs keyed by the
// same external key the exporter embedded.
// ---------------------------------------------------------------------------
async function buildCatalogIndex(remap: CatalogRemap): Promise<Map<string, number>> {
    const index = new Map<string, number>();
    // Paginate defensively for large catalogs (platform_ships ~hundreds,
    // quartermaster_catalog can be thousands).
    const PAGE = 1000;
    let from = 0;
    for (;;) {
        const q = sb.from(remap.catalogTable).select(remap.catalogSelect);
        const { data, error } = await q.range(from, from + PAGE - 1);
        if (error) {
            if (error.code === '42P01' || error.code === 'PGRST205') break; // table missing → empty index
            throw new Error(`Failed to index catalog ${remap.catalogTable}: ${error.message}`);
        }
        const rows = data || [];
        for (const row of rows) {
            if (row.id == null) continue;
            // EVERY key form this catalog row supports, so a lookup succeeds whichever
            // form the export embed happens to carry. FIRST-WRITE-WINS: catalog rows
            // arrive in id order, and the imprecise `n:` (name+manufacturer) form can
            // legitimately repeat across rows — letting a later duplicate overwrite
            // would make the winner depend on page boundaries. The external-id forms
            // are backed by UNIQUE columns and cannot collide at all.
            for (const key of remap.keysOf(row)) {
                if (!index.has(key)) index.set(key, row.id as number);
            }
        }
        if (rows.length < PAGE) break;
        from += PAGE;
    }
    return index;
}

/** Why a prepared row lost (or could not resolve) its catalog FK. Returned rather
 *  than pushed as a warning so the per-table caller can COLLAPSE hundreds of these
 *  into one line — see the note on `summariseRemapMisses`. */
interface RemapMiss {
    /** true → the whole row was dropped (required FK); false → the FK was set NULL. */
    dropped: boolean;
    /** The un-prefixed external key that failed to resolve, for the operator. */
    ref: string;
}

// ---------------------------------------------------------------------------
// Row preparation: strip embed aliases, apply catalog remap, null self-ref FKs.
// Returns { row, selfRef } where selfRef holds the original self-ref values
// keyed under __id for the second pass.
// ---------------------------------------------------------------------------
function prepareRow(
    table: string,
    raw: Record<string, unknown>,
    catalogIndex: Map<string, Map<string, number>>,
    droppedIds: Map<string, Set<string>>,
): { row: Record<string, unknown>; selfRef: Record<string, unknown> | null; drop: boolean; remapMiss: RemapMiss | null; orphanedBy: string | null } {
    const row: Record<string, unknown> = { ...raw };
    let drop = false;
    let remapMiss: RemapMiss | null = null;

    // 1. Catalog remap (read embed BEFORE stripping). Probe the embed's key forms in
    // PRECISION order (api id → uuid → name+manufacturer) and take the first hit, so
    // an imprecise form can never outrank an exact external-id match.
    const remap = CATALOG_REMAPS[table];
    if (remap) {
        const embed = row[remap.embedAlias] as Record<string, unknown> | null | undefined;
        if (!embed && !remap.required && row[remap.fkColumn] != null) {
            // A NULLABLE catalog FK arrived with a raw value and NO key to resolve it
            // by. That id belongs to the SOURCE deployment's independently-numbered
            // catalog, so inserting it verbatim does not fail — it silently points at
            // whatever unrelated row happens to hold that integer here. (Reachable
            // because the format version is deliberately not bumped, so an export
            // predating the exporter's nullify+embed still imports.) Null is a visible
            // gap; a wrong ship or category is silent corruption.
            //
            // Only for `required: false`. A required remap's absent embed is
            // meaningful: quartermaster_inventory's CUSTOM rows carry no embed and
            // their catalog_id was imported with its id preserved, so it resolves.
            row[remap.fkColumn] = null;
            // Reported, not silent — it is still a link the org had and no longer has.
            remapMiss = { dropped: false, ref: '(no catalog key in export)' };
        }
        if (embed && (!remap.shouldRemap || remap.shouldRemap(embed))) {
            const keys = remap.keysOf(embed);
            const index = catalogIndex.get(remap.catalogTable);
            let forkId: number | undefined;
            for (const key of keys) {
                forkId = index?.get(key);
                if (forkId != null) break;
            }
            if (forkId != null) {
                row[remap.fkColumn] = forkId;
            } else {
                // `ref` is the MOST PRECISE form the export carried, un-prefixed — the
                // string an operator can actually search their catalog for.
                const ref = keys.length > 0 ? keys[0].replace(/^[a-z]:/, '') : '(unknown)';
                if (remap.required) {
                    // FK is NOT NULL / CHECK-constrained and the catalog row isn't in this
                    // instance (a permission/ship this fork lacks, or an unsynced platform
                    // catalog) → DROP the row rather than insert NULL and fail the import.
                    drop = true;
                    if (row.id != null) {
                        let set = droppedIds.get(table);
                        if (!set) { set = new Set<string>(); droppedIds.set(table, set); }
                        set.add(String(row.id));
                    }
                } else {
                    // Nullable FK → null it rather than fail the import.
                    row[remap.fkColumn] = null;
                }
                remapMiss = { dropped: drop, ref };
            }
        }
    }

    // 1a. Cascade from a parent this import already DROPPED. Without this a dropped
    // user_ships row silently takes its dependants with it: the exporter nullifies
    // operation_participants.ship_id but NOT user_ship_id, so the participant row
    // FK-fails and the whole record — attendance, RSVP, payout share — is discarded
    // by the row-by-row fallback with no operator-visible warning. Nullable columns
    // are nulled (keep the row, lose the ship link); NOT NULL ones drop the row, but
    // now as an accounted, reported `catalogMiss` rather than an opaque constraint
    // violation. Safe by construction: every parent here is inserted earlier in the
    // manifest, so `droppedIds` is complete before its dependants are prepared.
    let orphanedBy: string | null = null;
    for (const fk of DROPPED_PARENT_FKS[table] || []) {
        const val = row[fk.col];
        if (val == null) continue;
        if (!droppedIds.get(fk.parent)?.has(String(val))) continue;
        orphanedBy = fk.parent;
        if (fk.nullable) row[fk.col] = null; else drop = true;
    }

    // 1b. Null FKs that reference a table whose ids don't carry over from the SaaS
    // (the intel-sharing feed link — see NULL_FKS).
    const nullCols = NULL_FKS[table];
    if (nullCols) for (const c of nullCols) if (row[c] != null) row[c] = null;

    // 2. Strip embed aliases (joined objects, never columns).
    for (const k of STRIP_ALWAYS) if (k in row) delete row[k];

    // 2b. Drop secret / transient per-install columns on every table.
    for (const k of SECRET_DROP_COLUMNS) if (k in row) delete row[k];

    // 3. Defensive: drop organization_id if a stray slipped through.
    if ('organization_id' in row) delete row.organization_id;

    // 4. Self-ref FK two-pass: capture + null.
    let selfRef: Record<string, unknown> | null = null;
    const cols = SELF_REF_FKS[table];
    if (cols) {
        for (const c of cols) {
            if (row[c] != null) {
                if (!selfRef) selfRef = { __id: row.id };
                selfRef[c] = row[c];
                row[c] = null;
            }
        }
    }
    return { row, selfRef, drop, remapMiss, orphanedBy };
}

// Cap on how many distinct external keys a collapsed catalog-miss warning names.
// Enough to identify the pattern ("it's all Drake hulls"), short enough that the
// line stays readable and the `warnings` array stays a small payload.
const WARNING_EXAMPLE_LIMIT = 5;

/**
 * Collapse one table's per-row catalog misses into at most two lines.
 *
 * WHY: `user_ships` emits one miss per ship and sits early in the manifest, so on a
 * fleet-loss import it used to produce thousands of near-identical warnings — which
 * (a) crowded every later table's warning out of the client's summary list, and
 * (b) shipped the whole array to the browser inside the `done` event. One counted
 * line with a handful of examples says strictly more, in one line.
 */
function summariseRemapMisses(table: string, misses: RemapMiss[], remap: CatalogRemap | undefined): string[] {
    if (misses.length === 0 || !remap) return [];
    const out: string[] = [];
    const sync = remap.syncHint ? ` Sync it in ${remap.syncHint} and re-run the import to keep these.` : '';
    for (const dropped of [true, false]) {
        const group = misses.filter((m) => m.dropped === dropped);
        if (group.length === 0) continue;
        const refs = [...new Set(group.map((m) => m.ref))];
        const shown = refs.slice(0, WARNING_EXAMPLE_LIMIT).map((r) => `"${r}"`).join(', ');
        const more = refs.length > WARNING_EXAMPLE_LIMIT ? `, +${refs.length - WARNING_EXAMPLE_LIMIT} more` : '';
        out.push(dropped
            ? `${table}: ${group.length} row(s) SKIPPED — not in this instance's ${remap.catalogTable} catalog (${shown}${more}).${sync}`
            : `${table}: ${group.length} row(s) imported with ${remap.fkColumn} left empty — no match in this instance's ${remap.catalogTable} (${shown}${more}).${sync}`);
    }
    return out;
}

// Parse a PostgREST "unknown column" error → the offending column name, or null.
// The single-org fork DROPS columns the hosted SaaS export still carries (retired
// audit columns, multi-tenant remnants), so an insert can fail with PGRST204
// "Could not find the 'X' column of 'Y' in the schema cache". We strip + retry
// rather than fail the whole import.
function unknownColumnFromError(error: { message?: string; code?: string } | null): string | null {
    if (!error) return null;
    const m = /Could not find the '([^']+)' column/.exec(error.message || '');
    return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Insert one table's rows in batches. Columns the export has but THIS instance's
// schema lacks are stripped (and reported) instead of aborting the import.
// ---------------------------------------------------------------------------
async function insertRows(table: string, rows: Record<string, unknown>[]): Promise<{ inserted: number; strippedColumns: string[]; skipped: number }> {
    let inserted = 0;
    let skipped = 0;
    const stripped = new Set<string>();
    const drop = (r: Record<string, unknown>, col: string) => { const c = { ...r }; delete c[col]; return c; };
    const applyStripped = (batch: Record<string, unknown>[]) =>
        stripped.size ? batch.map((r) => { let c = r; for (const k of stripped) if (k in c) c = drop(c, k); return c; }) : batch;

    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        let batch = applyStripped(rows.slice(i, i + INSERT_BATCH));
        // Fast path: insert the whole batch, stripping unknown columns + retrying.
        let ok = false;
        for (;;) {
            const { error } = await sb.from(table).insert(batch);
            if (!error) { ok = true; break; }
            const col = unknownColumnFromError(error);
            if (col && !stripped.has(col)) { stripped.add(col); batch = batch.map((r) => drop(r, col)); continue; }
            break; // a row in the batch violates a constraint → fall back to row-by-row
        }
        if (ok) { inserted += batch.length; continue; }
        // Resilient path: a single row breaks the batch (FK orphan from a dropped
        // catalog row, a CHECK/enum mismatch). Insert row-by-row so one bad row is
        // skipped (logged) instead of aborting the whole import.
        for (const r of batch) {
            let single = r;
            let rowOk = false;
            for (;;) {
                const { error } = await sb.from(table).insert(single);
                if (!error) { rowOk = true; break; }
                const col = unknownColumnFromError(error);
                if (col) { stripped.add(col); single = drop(single, col); continue; }
                // Log the FULL PostgREST error, not just `message`. The SQLSTATE in
                // `code` is the entire difference between an FK orphan (23503), an
                // enum/CHECK mismatch (23514/22P02) and a unique violation (23505),
                // and `details`/`hint` name the offending column and value — without
                // them a skipped row is undiagnosable after the fact. `details` can
                // quote the failing row, so it is length-capped; it never leaves the
                // server (this is the only record of the row, by design) and the
                // secret columns are already dropped in prepareRow. The row's own id
                // is logged so the operator can find it in the export.
                log.warn('import: row skipped (constraint violation)', {
                    table,
                    rowId: single.id ?? null,
                    code: error.code || '',
                    errMessage: error.message,
                    details: String(error.details ?? '').slice(0, 500),
                    hint: error.hint || '',
                });
                break;
            }
            if (rowOk) inserted++; else skipped++;
        }
    }
    return { inserted, strippedColumns: [...stripped], skipped };
}

// ---------------------------------------------------------------------------
// Second pass: restore self-ref FKs by id.
// ---------------------------------------------------------------------------
// TOLERANT, like the deferred cross-table FK restore below it. This used to THROW,
// which aborted an otherwise-complete import at whatever table it happened to reach:
// nothing is transactional, so the seeded defaults were already gone, every earlier
// table was already committed, and the run skipped resetSequences (leaving every
// identity table on a stale sequence), the merge re-anchor and the permission
// reconcile. The self-ref columns are all nullable — they were just nulled on insert
// — so a failed restore costs one parent link, not the migration.
async function restoreSelfRefs(table: string, deferred: Record<string, unknown>[]): Promise<string[]> {
    const cols = SELF_REF_FKS[table];
    if (!cols) return [];
    const warnings: string[] = [];
    for (const d of deferred) {
        const patch: Record<string, unknown> = {};
        for (const c of cols) if (c in d) patch[c] = d[c];
        if (Object.keys(patch).length === 0) continue;
        const { error } = await sb.from(table).update(patch).eq('id', d.__id);
        if (error) warnings.push(`Could not restore ${table}#${String(d.__id)}'s parent link (${cols.join(', ')}): ${error.message}; left empty.`);
    }
    return warnings;
}

// Integer-id (sequence-backed) tables — generated from the database id-type
// audit. Tables not here are UUID/composite-PK and own no sequence.
export const SEQUENCE_BACKED = new Set<string>([
    'roles', 'ranks', 'security_clearances', 'security_limiting_markers',
    'personnel_positions', 'specialization_tags', 'certifications', 'commendations',
    'service_types', 'locations', 'units', 'users', 'user_commendations',
    'user_hr_position_history', 'fleet_groups', 'user_ships', 'fleet_group_ships',
    'status_history', 'operation_templates', 'operation_phases', 'operation_tasks',
    'operation_schedule_entries', 'operation_board_elements', 'operation_command_nodes',
    'operation_log_entries', 'operation_logistics', 'operation_aar_entries',
    'warrant_notes', 'hr_interview_templates', 'hr_interview_questions',
    'hr_interview_panel', 'hr_interview_responses', 'government_branches',
    'government_positions', 'government_elections', 'government_election_candidates',
    'government_election_voter_registry', 'government_position_holders',
    'government_legislation', 'government_legislation_comments',
    'government_legislation_votes', 'government_motions', 'government_motion_votes',
    'quartermaster_locations', 'quartermaster_catalog', 'quartermaster_inventory',
    'quartermaster_issuances', 'treasury_accounts', 'warehouse_catalog',
    'warehouse_stock', 'external_tools', 'conduct_records', 'clearance_history',
    'reputation_history',
    // Academy: the SEVEN bigint-identity tables only. academy_courses,
    // academy_sessions and academy_enrollments are uuid PKs and own no sequence.
    // Omitting these would not fail the import — it would leave every sequence at 0,
    // so the FIRST module/lesson/outcome/progress row created AFTER the import
    // collides on the primary key, days later and far from the cause.
    // tests/importTableSetInvariants.test.ts makes this mechanical, not a memo.
    'academy_course_instructors', 'academy_modules', 'academy_lessons', 'academy_outcomes',
    'academy_session_instructors', 'academy_lesson_progress', 'academy_outcome_results',
]);

// Tables we recognise and will import. Anything in the export's tableOrder that
// is NOT here is skipped with a warning (forward-compat guard). Mirrors the
// exporter's EXPORT_TABLES manifest.
export const IMPORTABLE_TABLES = new Set<string>([
    'roles', 'ranks', 'security_clearances', 'security_limiting_markers',
    'personnel_positions', 'specialization_tags', 'certifications', 'commendations',
    'service_types', 'locations', 'units', 'role_permissions', 'users',
    'user_certifications', 'user_commendations', 'user_specializations',
    'user_limiting_markers', 'user_hr_position_history', 'unit_posts', 'fleet_groups',
    'user_ships', 'fleet_group_ships', 'service_requests', 'request_responders',
    'status_history', 'operation_templates', 'operations', 'operation_phases',
    'operation_tasks', 'operation_schedule_entries', 'operation_participants',
    'operation_board_elements', 'operation_command_nodes', 'operation_log_entries',
    'operation_logistics', 'operation_aar_entries', 'operation_reminders',
    'operation_limiting_markers', 'operation_locations',
    'intel_reports', 'intel_report_limiting_markers', 'intel_bulletins',
    'intel_bulletin_limiting_markers', 'warrants', 'warrant_notes',
    'hr_interview_templates', 'hr_interview_questions', 'hr_applications',
    'hr_interviews', 'hr_interview_panel', 'hr_interview_responses', 'hr_job_postings',
    'hr_job_applications', 'hr_transfer_requests', 'hr_application_logs',
    'government_configs', 'government_branches', 'government_positions',
    'government_elections', 'government_election_candidates', 'government_election_votes',
    'government_election_voter_registry', 'government_position_holders',
    'government_legislation', 'government_legislation_comments',
    'government_legislation_votes', 'government_motions', 'government_motion_votes',
    'government_orders', 'quartermaster_locations', 'quartermaster_catalog',
    'quartermaster_inventory', 'quartermaster_issuances',
    'quartermaster_inventory_movements', 'warehouse_catalog', 'warehouse_stock',
    'warehouse_movements', 'warehouse_requests', 'treasury_accounts',
    'treasury_ledger_entries', 'wiki_pages', 'wiki_page_limiting_markers',
    'announcements', 'external_tools', 'radio_channels', 'synced_discord_roles',
    'rank_mappings', 'dossier_summaries', 'conduct_records', 'clearance_history',
    'reputation_history', 'settings',
    // Marketplace: LISTINGS ONLY. Contracts / milestones / ratings / considerations
    // are bilateral (seller_org_id + buyer_org_id, both NOT NULL) so a row names a
    // second tenant, and reports are platform moderation — the exporter sends none of
    // them, and this fork must not invent them. marketplace_categories is seeded
    // locally (lib/db/seeder.ts) and is the re-map TARGET, never imported.
    'marketplace_listings',
    // Academy (training / LMS). Column parity with the hosted schema is exact once
    // organization_id is stripped — no drop, null, re-map or self-ref needed; the
    // only outward FKs are users and certifications.id, both imported earlier with
    // their ids preserved. Order below mirrors the exporter's manifest order, which
    // IS the insert order (courses → children → sessions → enrolments → per-enrolment).
    'academy_courses', 'academy_course_instructors', 'academy_modules', 'academy_lessons',
    'academy_outcomes', 'academy_sessions', 'academy_session_instructors',
    'academy_enrollments', 'academy_lesson_progress', 'academy_outcome_results',
]);

// First-boot SEEDER defaults (lib/db/seeder.ts) cleared before import so the org's
// real versions don't collide on a PK / unique key (ranks_name_key, security_clearances
// .level, service_types.name, roles.name, the 'dispatch' radio channel, …). The seeder
// populates 12 tables; the old list cleared only roles/role_permissions/settings, leaving
// the other 9 to collide. Full-table delete, UNCONDITIONAL (the export is the source of
// truth — a table the export has 0 rows for should end up empty, not stuck on the seeded
// defaults). Ordered CHILD-FIRST so role_permissions clears before roles (FK). Each
// (col, val) is a never-matching filter so `.delete().neq(col, val)` clears the whole
// table — id-keyed except role_permissions(role_id) / radio_channels(text id). `settings`
// is handled separately (key-scoped) so fork-only keys like setup_completed survive a
// re-import. (permissions is a GLOBAL catalog and is NOT imported — only role_permissions grants.)
const SEEDED_PRECLEAR: { table: string; col: string; val: unknown }[] = [
    { table: 'role_permissions', col: 'role_id', val: -1 },
    { table: 'roles', col: 'id', val: -1 },
    { table: 'ranks', col: 'id', val: -1 },
    { table: 'units', col: 'id', val: -1 },
    { table: 'locations', col: 'id', val: -1 },
    { table: 'security_clearances', col: 'id', val: -1 },
    { table: 'service_types', col: 'id', val: -1 },
    { table: 'specialization_tags', col: 'id', val: -1 },
    { table: 'certifications', col: 'id', val: -1 },
    { table: 'commendations', col: 'id', val: -1 },
    { table: 'radio_channels', col: 'id', val: '__never__' },
];

// Settings keys that are DEPLOYMENT / integration config — they carry THIS
// install's identity + credentials (Discord OAuth app, LiveKit, Gemini), NOT
// portable org data. They are NEVER imported: an org export from another
// deployment would otherwise overwrite the operator's local config, and because a
// DB settings value WINS over process.env (api/query.ts), it would silently
// shadow .env — e.g. importing the source org's discordConfig.clientId breaks
// OAuth ("invalid redirect_uri") on the destination install. These are configured
// per-install via .env / the admin console, so they are excluded from BOTH the
// settings pre-clear and the insert, leaving the operator's local values intact.
const SETTINGS_IMPORT_DENYLIST = new Set<string>([
    // Secret-bearing config (the encrypted-at-rest set in lib/secrets.ts) — Discord
    // OAuth app, LiveKit, Gemini. geminiKey is a SEPARATE row from aiConfig.
    'discordConfig', 'radioConfig', 'aiConfig', 'geminiKey',
    // Deployment bootstrap / runtime state — never portable. Importing these would
    // shadow or falsely satisfy THIS install's first-boot + schema state (e.g. an
    // imported admin_setup_code lets an export holder claim Admin; an imported
    // setup_completed skips first-boot; schema_version is owned by schema.sql).
    'admin_setup_code', 'setup_completed', 'schema_version',
    // Operational / runtime state — importing a doctored export must not be able to
    // bootstrap a fresh instance into maintenance mode / a force-logout loop
    // (platformSettings), flip module toggles (orgFeatures), surface a stale
    // emergency broadcast (active_eam), or seed a federation pairing secret
    // (allianceLocalPairingCode).
    'platformSettings', 'orgFeatures', 'active_eam', 'allianceLocalPairingCode',
]);

// ---------------------------------------------------------------------------
// Write-boundary sanitizers for imported config settings.
//
// The admin-console config writers (lib/db/system.ts) run operator-supplied
// config strings through the app's write-boundary sanitizers before persisting:
// brandingConfig.termsOfService through sanitizeRichHtml, publicPageConfig.blurb
// through sanitizeTiptapJson('minimal'), motto through stripHtml, image URLs
// through sanitizeImageUrl, openGraph themeColor through a strict hex check, and
// public links through sanitizePublicLinkUrl. The importer used to write `settings`
// rows VERBATIM (only the denylist + secret-drop filters), so a crafted export
// could seed raw HTML / event-handler attrs / javascript: URLs / tracking image
// hosts that the normal write path would have stripped. Re-apply the SAME
// sanitizers here so an imported value matches what the admin write path would have
// stored. Resilient: invalid values are cleared/dropped (never thrown) so one bad
// value can't abort the whole bootstrap import.
// ---------------------------------------------------------------------------

// Mirror of system.ts THEME_COLOR_RE / sanitizeThemeColor (local + not exported
// there): #rgb / #rrggbb / #rrggbbaa only; anything else is dropped.
const IMPORT_THEME_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function sanitizeThemeColorValue(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    return IMPORT_THEME_COLOR_RE.test(trimmed) ? trimmed : undefined;
}

// validateImageUrl in updatePublicPageConfig THROWS on an invalid URL; the import
// path must stay resilient, so it follows the heroCard/openGraph silent-clear
// contract instead (invalid → '').
function importImageUrl(val: unknown): string {
    if (val == null || val === '') return '';
    return sanitizeImageUrl(val) || '';
}

const IMPORT_HTML_TAG_RE = /<[^>]*>/g;

// Mirrors updateBrandingConfig: termsOfService is rich HTML rendered with
// dangerouslySetInnerHTML → sanitizeRichHtml.
function sanitizeBrandingConfigValue(cfg: Record<string, unknown>): Record<string, unknown> {
    return typeof cfg.termsOfService === 'string'
        ? { ...cfg, termsOfService: sanitizeRichHtml(cfg.termsOfService) }
        : cfg;
}

// Mirrors updateHeroCardConfig: backgroundImageUrl → sanitizeImageUrl || ''.
function sanitizeHeroCardConfigValue(cfg: Record<string, unknown>): Record<string, unknown> {
    return 'backgroundImageUrl' in cfg
        ? { ...cfg, backgroundImageUrl: importImageUrl(cfg.backgroundImageUrl) }
        : cfg;
}

// Mirrors updateOpenGraphConfig: image fields → sanitizeImageUrl || ''; themeColor
// → strict hex or dropped (feeds SSR <meta og:image>/<link icon>/<meta theme-color>).
function sanitizeOpenGraphConfigValue(cfg: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = { ...cfg };
    if ('imageUrl' in safe) safe.imageUrl = importImageUrl(safe.imageUrl);
    if ('faviconUrl' in safe) safe.faviconUrl = importImageUrl(safe.faviconUrl);
    if ('pwaIconUrl' in safe) safe.pwaIconUrl = importImageUrl(safe.pwaIconUrl);
    if ('themeColor' in safe) {
        const color = sanitizeThemeColorValue(safe.themeColor);
        if (color) safe.themeColor = color; else delete safe.themeColor;
    }
    return safe;
}

// Mirrors updatePublicPageConfig's field sanitizers (resilient variant — clears /
// drops invalid input instead of throwing so the import never aborts).
function sanitizePublicPageConfigValue(cfg: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = { ...cfg };
    if (typeof safe.motto === 'string') safe.motto = stripHtml(safe.motto, 120);
    if (typeof safe.blurb === 'string') {
        const parsed = tryParseTiptapJson(safe.blurb);
        if (parsed) {
            const serialized = JSON.stringify(sanitizeTiptapJson(parsed, 'minimal'));
            safe.blurb = serialized.length > 8000 ? serialized.slice(0, 8000) : serialized;
        } else {
            safe.blurb = stripHtml(safe.blurb, 4000);
        }
    }
    if ('heroImageUrl' in safe) safe.heroImageUrl = importImageUrl(safe.heroImageUrl);
    if ('profileImageUrl' in safe) safe.profileImageUrl = importImageUrl(safe.profileImageUrl);
    if (Array.isArray(safe.links)) {
        const cleaned: Array<Record<string, unknown>> = [];
        for (const rawLink of safe.links) {
            if (!rawLink || typeof rawLink !== 'object') continue;
            const l = rawLink as Record<string, unknown>;
            const url = sanitizePublicLinkUrl(l.url);
            if (!url) continue; // drop javascript:/private-host/non-https links outright
            const label = stripHtml(l.label, 40);
            if (!label) continue;
            const id = typeof l.id === 'string' && l.id ? l.id.slice(0, 64) : `lnk_${randomBytes(6).toString('base64url')}`;
            const icon = typeof l.icon === 'string' ? l.icon.replace(IMPORT_HTML_TAG_RE, '').slice(0, 40) : undefined;
            cleaned.push(icon ? { id, label, url, icon } : { id, label, url });
        }
        safe.links = cleaned.slice(0, 10);
    }
    return safe;
}

// systemConfig.appUrl is THIS deployment's own public origin, not portable org data.
// The rest of the row (welcomeMessage, …) is ordinary org config and is kept, so the
// key is stripped surgically here rather than denylisting the whole row. Importing it
// would overwrite the destination's origin with the SOURCE's — and that origin is what
// alliance pairing advertises and verifies (lib/db/alliances.ts getOurOrigin,
// lib/db.ts getOrgTenantUrl), so a stale value silently breaks federation. OMITTING
// the key (rather than writing '') is deliberate: both readers guard on truthiness and
// fall back to process.env.APP_URL, i.e. "unset — the operator configures it here".
function sanitizeSystemConfigValue(cfg: Record<string, unknown>): Record<string, unknown> {
    if (!('appUrl' in cfg)) return cfg;
    const safe = { ...cfg };
    delete safe.appUrl;
    return safe;
}

/** Re-apply the admin-console write-boundary sanitizers to ONE imported settings
 *  row's `value`, keyed by the settings key. Keys with no sanitizing write path
 *  (and non-object values) pass through unchanged. */
function sanitizeImportedSettingRow(row: Record<string, unknown>): Record<string, unknown> {
    const value = row.value;
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return row;
    const cfg = value as Record<string, unknown>;
    switch (row.key) {
        case 'brandingConfig': return { ...row, value: sanitizeBrandingConfigValue(cfg) };
        case 'publicPageConfig': return { ...row, value: sanitizePublicPageConfigValue(cfg) };
        case 'openGraphConfig': return { ...row, value: sanitizeOpenGraphConfigValue(cfg) };
        case 'heroCardConfig': return { ...row, value: sanitizeHeroCardConfigValue(cfg) };
        case 'systemConfig': return { ...row, value: sanitizeSystemConfigValue(cfg) };
        default: return row;
    }
}

// ---------------------------------------------------------------------------
// Optional-module toggles from the export HEADER (`sourceOrg.features`).
//
// The hosted app keeps module on/off state on its `organizations.features` column,
// and `organizations` is the one table its exporter never sends — so before this,
// every import came up with Marketplace, Academy, Warehouse, Quartermaster and
// Finances switched OFF and nothing said about it, which reads to an owner exactly
// like the data having failed to import. (Government is unaffected: its flag rides
// inside settings.governmentsConfig, which IS exported.)
//
// WHY THIS IS NOT A HOLE IN SETTINGS_IMPORT_DENYLIST. That denylist blocks an
// imported `orgFeatures` settings ROW, and it still does — a doctored export cannot
// write an arbitrary blob into this key. THIS channel is deliberately narrower in
// every dimension: a fixed allowlist of the five keys this fork actually gates on,
// each value coerced through `=== true` (so no object, string or truthy value can
// smuggle anything through), rebuilt into the fork's own `{ enabled }` shape rather
// than passed through. Unknown hosted keys (starcomms, blueprints) are ignored, and
// the two DEFAULT-ON keys (leaderboard, externalTools) are never named here — the
// header does not carry them, and writing `false` for an absent key would switch OFF
// modules the source org never disabled.
//
// Blast radius of a wrongly-enabled module: a nav entry plus RPCs that still have to
// pass the permission gate (the feature gate is additive to RBAC, never a substitute
// — api/services.ts). Academy's member self-service surface is permission-LESS by
// design, so enabling it exposes the published course catalogue to every member;
// that is the honest worst case, and it is exactly what the source org had.
const IMPORTABLE_FEATURE_MODULES: Readonly<Record<string, string>> = {
    marketplace: 'Marketplace',
    warehouse: 'Warehouse',
    academy: 'Academy',
    finances: 'Finances',
    quartermaster: 'Quartermaster',
};

/**
 * Write the allowlisted module toggles into the `orgFeatures` settings row.
 * Returns the display labels of the modules switched ON, for the import summary.
 *
 * Read-merge-write rather than a blind overwrite, mirroring db.updateOrgFeatures'
 * one-level deep merge, so sibling keys and any nested per-module settings survive.
 * Implemented inline (not by importing lib/db/system) to keep this module's write
 * surface self-contained and to avoid a mid-import settings broadcast — the import
 * is a bootstrap and the UI does a full reload afterwards.
 */
async function applyImportedFeatureToggles(features: Record<string, unknown> | undefined): Promise<{ enabled: string[]; warnings: string[] }> {
    if (!features || typeof features !== 'object' || Array.isArray(features)) return { enabled: [], warnings: [] };
    const patch: Record<string, { enabled: boolean }> = {};
    const enabled: string[] = [];
    for (const [key, label] of Object.entries(IMPORTABLE_FEATURE_MODULES)) {
        if (!(key in features)) continue;              // absent → leave this fork's default
        const on = features[key] === true;             // strict: only a real `true` enables
        patch[key] = { enabled: on };
        if (on) enabled.push(label);
    }
    if (Object.keys(patch).length === 0) return { enabled: [], warnings: [] };

    const { data, error: readErr } = await sb.from('settings').select('value').eq('key', 'orgFeatures') as unknown as SelectResult;
    if (readErr && readErr.code !== '42P01' && readErr.code !== 'PGRST205') {
        return { enabled: [], warnings: [`Could not read this instance's module toggles (${readErr.message}); modules left at their defaults — set them in Admin → Optional Features.`] };
    }
    const existingRow = (data || [])[0];
    const current = (existingRow?.value && typeof existingRow.value === 'object' && !Array.isArray(existingRow.value))
        ? existingRow.value as Record<string, unknown>
        : null;
    const next: Record<string, unknown> = { ...(current || {}), ...patch };

    // No `upsert` here on purpose: the module's structural query-builder view models
    // only what it uses, and an update-or-insert keeps that surface unchanged.
    const { error: writeErr } = current
        ? await sb.from('settings').update({ value: next }).eq('key', 'orgFeatures')
        : await sb.from('settings').insert([{ key: 'orgFeatures', value: next }]);
    if (writeErr) {
        return { enabled: [], warnings: [`Could not apply the source org's module toggles (${writeErr.message}); switch them on in Admin → Optional Features.`] };
    }
    return { enabled, warnings: [] };
}

// Tables NEVER imported even though the export carries them: deployment-LOCAL
// federation state. alliance_peers holds this install's crypto material
// (outbound_key_enc, inbound_key_id → api_keys [not imported], entered_peer_code_enc,
// handshake_*) and trust relationships — importing the SOURCE deployment's peer
// credentials breaks federation auth and leaves dangling api_keys FKs. Federation is
// re-established per-install via the handshake flow, so peer rows are not portable.
const IMPORT_EXCLUDED_TABLES = new Set<string>(['alliance_peers']);

// ---------------------------------------------------------------------------
// Reset every sequence-backed table's id sequence to MAX(id) via the
// import_reset_sequence(text) Postgres function (added by migration). Only
// integer-id tables that were actually imported are reset. Returns the list.
// ---------------------------------------------------------------------------
async function resetSequences(importedTables: string[]): Promise<{ reset: string[]; warnings: string[] }> {
    const reset: string[] = [];
    const warnings: string[] = [];
    for (const table of importedTables) {
        if (!SEQUENCE_BACKED.has(table)) continue;
        const { error } = await sb.rpc('import_reset_sequence', { p_table: table });
        if (error) {
            warnings.push(`Sequence reset for ${table} failed: ${error.message}. Run SELECT import_reset_sequence('${table}') manually.`);
        } else {
            reset.push(table);
        }
    }
    return { reset, warnings };
}

// ---------------------------------------------------------------------------
// MERGE (id-reanchor) helpers. The acting admin maps to an imported user; we
// overlay the admin's account anchors (Discord login + Admin role) onto that
// imported row, keeping the imported identity + every historical FK intact —
// no per-column FK remap. The pre-flight (capture + delete the seeded admin) and
// this re-anchor bracket the otherwise-unchanged empty-DB import in importOrgData.
// ---------------------------------------------------------------------------
async function reanchorAdminOntoImportedUser(
    importedUserId: number,
    captured: Record<string, unknown>,
): Promise<{ userId: number; roleId: number }> {
    // Confirm the target user actually imported. With the row-by-row insert fallback a
    // user row can be SKIPPED (it hit a constraint), which would leave the admin deleted
    // (locked out). Throwing here triggers the caller's restore of the captured admin.
    const { data: tgt } = await sb.from('users').select('id').eq('id', importedUserId) as unknown as SelectResult;
    if (!tgt || tgt.length === 0) {
        throw new Error(`Merge re-anchor: target user #${importedUserId} did not import (it may have been skipped on a constraint) — admin restored, reset and retry.`);
    }
    // PRE_CLEAR replaced the seeded roles with the export's, so resolve the imported
    // Admin role by name — the merged account MUST stay admin-capable regardless of
    // what role the imported "me" held in the source org.
    const { data: roleRows, error: roleErr } = await sb.from('roles').select('id, name').eq('name', 'Admin') as unknown as SelectResult;
    if (roleErr) throw new Error(`Merge re-anchor failed resolving the Admin role: ${roleErr.message}`);
    const adminRoleId = (roleRows || [])[0]?.id as number | undefined;
    if (adminRoleId == null) throw new Error('Merge re-anchor: no "Admin" role found in the imported roles.');

    // Overlay ONLY the account anchors onto the imported identity. The imported row
    // keeps its handle/rank/unit/clearance/reputation/dates; auth_user_id + discord_id
    // become the admin's (so their Discord login resolves here), role_id becomes Admin.
    const patch: Record<string, unknown> = {
        auth_user_id: captured.auth_user_id ?? null,
        discord_id: captured.discord_id,
        role_id: adminRoleId,
    };
    const { error: upErr } = await sb.from('users').update(patch).eq('id', importedUserId);
    if (upErr) throw new Error(`Merge re-anchor failed binding admin onto user #${importedUserId}: ${upErr.message}`);
    return { userId: importedUserId, roleId: adminRoleId };
}

/**
 * Post-import permission reconciliation. role_permissions is precleared and
 * replaced by the EXPORT's grants (remapped by permission NAME), but the
 * `permissions` table is the fork's CODE-OWNED catalog and is deliberately NOT
 * imported (see SEEDED_PRECLEAR note). So any permission this fork gates on that
 * the source org never had — e.g. `admin:config:catalog` (the Ship/Item/
 * Commodity/Location catalogs) — ends up granted to NO role, 403-ing the Admin.
 * The server's permission gate is a pure `permissions.includes(perm)` with no
 * super-admin bypass (api/services.ts) — the Admin "bypasses" only by holding
 * EVERY permission, exactly as the first-boot seeder grants it
 * (`adminPerms = permissions.map(p => p.name)`). Re-assert that invariant after
 * every import: grant the full local catalog to the Admin role. Idempotent —
 * only the missing grants are inserted, so no PK conflict on existing ones.
 * Returns how many grants were added.
 */
async function ensureAdminRoleHasAllPermissions(): Promise<number> {
    const { data: roleRows } = await sb.from('roles').select('id').eq('name', 'Admin') as unknown as SelectResult;
    const adminRoleId = (roleRows || [])[0]?.id as number | undefined;
    if (adminRoleId == null) return 0;
    const { data: permRows } = await sb.from('permissions').select('id') as unknown as SelectResult;
    const allPermIds = (permRows || []).map((r) => r.id as number);
    if (allPermIds.length === 0) return 0;
    const { data: existing } = await sb.from('role_permissions').select('permission_id').eq('role_id', adminRoleId) as unknown as SelectResult;
    const have = new Set((existing || []).map((r) => r.permission_id as number));
    const missing = allPermIds.filter((id) => !have.has(id));
    if (missing.length === 0) return 0;
    const { error } = await sb.from('role_permissions').insert(missing.map((pid) => ({ role_id: adminRoleId, permission_id: pid })));
    if (error) { log.error('post-import admin permission reconcile failed', { error: error.message }); return 0; }
    log.info('post-import admin permission reconcile', { added: missing.length });
    return missing.length;
}

/** Best-effort restore of the admin row freed for a merge, used when the import
 *  fails partway. If PRE_CLEAR already removed the captured role, re-point to any
 *  Admin role so the NOT NULL FK row re-inserts and the admin is never locked out. */
async function restoreAdminRow(captured: Record<string, unknown>): Promise<void> {
    try {
        let row = captured;
        const { data: roleExists } = await sb.from('roles').select('id').eq('id', captured.role_id) as unknown as SelectResult;
        if (!roleExists || roleExists.length === 0) {
            const { data: anyAdmin } = await sb.from('roles').select('id').eq('name', 'Admin') as unknown as SelectResult;
            const fallback = (anyAdmin || [])[0]?.id;
            if (fallback != null) row = { ...captured, role_id: fallback };
        }
        const { error } = await sb.from('users').insert([row]);
        if (error) log.error('merge restore: admin row re-insert failed', { error: error.message });
    } catch (e) {
        log.error('merge restore threw', { err: e });
    }
}

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT.
// ---------------------------------------------------------------------------

/** Progress events emitted during a streamed import (id-less, log-safe). */
export type ImportProgressEvent =
    | { type: 'start'; totalTables: number; totalRows: number }
    | { type: 'phase'; phase: 'validate' | 'preclear' | 'sequences' | 'permissions' }
    | { type: 'table'; table: string; inserted: number; tablesDone: number; totalTables: number; rowsInserted: number; totalRows: number }
    | { type: 'warning'; message: string }
    | { type: 'done'; result: ImportResult };

export type ImportProgressFn = (evt: ImportProgressEvent) => void | Promise<void>;

/**
 * Pre-flight: refuse an import that would drop the org's whole fleet.
 *
 * `platform_ships` is a synced catalog, not org data — this fork never imports it and
 * nothing seeds it (the only writer is the admin-triggered `catalog:sync_ships`). An
 * import run before that sync resolves no ship at all, and because user_ships.ship_id
 * is NOT NULL every one of those rows is dropped.
 *
 * Read-only, and called BEFORE the merge pre-flight — which captures and DELETES the
 * acting admin's row outside the try. On a fresh install the catalog is always empty
 * and the wizard always takes the merge path, so this refusal is the ordinary
 * first-run outcome; routing it through the delete would make the best-effort
 * restoreAdminRow the routine path for something we can decline without touching a
 * single row.
 */
async function assertShipCatalogReadyFor(parsed: ParsedExport): Promise<void> {
    // Count the actual parsed rows, not header.manifest — the manifest is a claim the
    // export makes about itself and this decides whether to refuse.
    const shipRows = parsed.rowsByTable.get('user_ships')?.length || 0;
    if (shipRows === 0) return;
    const { count, error } = await sb.from('platform_ships').select('id', { count: 'exact', head: true }) as unknown as SelectResult;
    // A missing table means the schema predates the catalog; there is nothing to sync
    // and nothing to protect, so don't block on it.
    if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') return;
        throw new Error(`Pre-import ship-catalog check failed: ${error.message}`);
    }
    if ((count || 0) > 0) return;
    throw new ImportRefusedError(
        `Import refused: this instance's ship catalog is empty, and the export contains ${shipRows} member ship(s). ` +
        `Every one of them would be discarded, leaving your fleet groups intact but empty. ` +
        `Sync the catalog first (Admin → Catalogs → Ship Catalog → "Sync from Wiki"), then run this import again — ` +
        `if you are still in first-run setup, skip this step and import afterwards from Admin → Import Organization.`,
    );
}

/** Flips at the FIRST mutating call of an import run. See importOrgData. */
interface WriteState { wrote: boolean }

/**
 * Import an organization export.
 *
 * The wrapper exists to make "was anything written?" STRUCTURAL. Whether a failure is
 * a refusal (instance untouched — retry after fixing the named thing) or a genuine
 * failure (possibly-partial data — reset and start over) drives destructive advice in
 * the first-run wizard, so deriving it from "did we reach a write?" is the only
 * version that cannot drift: a new pre-flight, a new validation error, or a transient
 * read failure is classified correctly without anyone remembering to pick the right
 * Error subclass. `ImportRefusedError` is still thrown directly at the deliberate
 * decline points, for the message; this backstops everything else — including
 * parseExport, which is a pure function over the input and therefore always a refusal.
 */
export async function importOrgData(ndjson: string, onProgress?: ImportProgressFn, merge?: ImportMergeOptions): Promise<ImportResult> {
    const writeState: WriteState = { wrote: false };
    try {
        return await runImport(ndjson, writeState, onProgress, merge);
    } catch (err) {
        if (!writeState.wrote && err instanceof Error && !(err instanceof ImportRefusedError)) {
            throw new ImportRefusedError(err.message, { cause: err });
        }
        throw err;
    }
}

async function runImport(ndjson: string, writeState: WriteState, onProgress?: ImportProgressFn, merge?: ImportMergeOptions): Promise<ImportResult> {
    const emit = async (evt: ImportProgressEvent) => { if (onProgress) await onProgress(evt); };

    const parsed = parseExport(ndjson);
    await emit({ type: 'phase', phase: 'validate' });

    // REFUSE before the first destructive write — and, critically, before the merge
    // pre-flight below FREES the acting admin's row — if the ship catalog is empty and
    // the export carries ships. Nothing seeds platform_ships (its only writer is the
    // admin-triggered sync) and user_ships.ship_id is NOT NULL, so importing against
    // an empty catalog silently discards EVERY member ship while the fleet-group tree
    // imports intact and empty. That was the reported bug, and the only recovery is a
    // full DB wipe and re-import, so declining here — at the cost of one catalog sync
    // and nothing else — is strictly better than succeeding-but-empty.
    await assertShipCatalogReadyFor(parsed);

    // MERGE pre-flight (id-reanchor): the acting admin already exists (created at
    // first-run setup), so the DB is NOT empty. After non-destructive validation,
    // CAPTURE then FREE the admin row here, so the strict empty-DB import path below
    // runs UNCHANGED — the admin's imported identity lands as a normal user and is
    // re-anchored afterwards. A mid-import failure restores the captured admin (see
    // the catch) so a merge can never lock the admin out.
    let captured: Record<string, unknown> | null = null;
    if (merge) {
        const usersRows = parsed.rowsByTable.get('users') || [];
        if (!usersRows.some((r) => Number(r.id) === merge.importedUserId)) {
            throw new ImportRefusedError(`Merge target user #${merge.importedUserId} is not present in this export.`);
        }
        // Refuse BEFORE freeing the admin if the instance already holds org content,
        // so we never CASCADE-delete the admin's child rows and then abort. Mirrors
        // assertDatabaseEmpty but tolerates exactly the one acting-admin user row.
        for (const guardTable of EMPTINESS_GUARD_TABLES) {
            const allowed = guardTable === 'users' ? 1 : 0;
            const { count, error: gErr } = await sb.from(guardTable).select('id', { count: 'exact', head: true }) as unknown as SelectResult;
            if (gErr) {
                if (gErr.code === '42P01' || gErr.code === 'PGRST205') continue;
                throw new Error(`Merge pre-check failed on ${guardTable}: ${gErr.message}`);
            }
            if ((count || 0) > allowed) {
                throw new ImportRefusedError(
                    `Import refused: this instance already contains data (${guardTable} has ${count} rows). ` +
                    `A merge import is a one-time bootstrap into a fresh admin instance.`,
                );
            }
        }
        const { data: adminRows, error: capErr } = await sb.from('users').select(USERS_COLUMNS).eq('id', merge.adminUserId) as unknown as SelectResult;
        if (capErr) throw new Error(`Merge pre-flight failed reading admin #${merge.adminUserId}: ${capErr.message}`);
        captured = (adminRows || [])[0] || null;
        if (!captured) throw new Error(`Merge pre-flight: admin user #${merge.adminUserId} not found.`);
        // FIRST WRITE of the merge path. Everything above is a pure read, so a failure
        // up to this point leaves the instance untouched; from here it does not, even
        // though restoreAdminRow tries (best-effort, and it cannot undo the CASCADE).
        writeState.wrote = true;
        const { error: delErr } = await sb.from('users').delete().eq('id', merge.adminUserId);
        if (delErr) throw new Error(`Merge pre-flight failed freeing admin #${merge.adminUserId}: ${delErr.message}`);
    }

    try {
        await assertDatabaseEmpty();

        const warnings: string[] = [];

        // Build catalog indexes once PER CATALOG TABLE (only for tables present in the
        // export). Two remaps can share a catalog — user_ships and
        // operation_participants both key platform_ships — and they are guaranteed to
        // key it identically because they share PLATFORM_SHIP_REMAP.
        const catalogIndex = new Map<string, Map<string, number>>();
        for (const [table, remap] of Object.entries(CATALOG_REMAPS)) {
            if (parsed.rowsByTable.has(table) && !catalogIndex.has(remap.catalogTable)) {
                catalogIndex.set(remap.catalogTable, await buildCatalogIndex(remap));
            }
        }
        // The category taxonomy is seeded on first boot, never imported. An instance
        // whose Admin predates the marketplace seeder has none at all, in which case
        // every listing lands uncategorised — say so up front rather than letting it
        // read as an import failure. (Recoverable afterwards: Marketplace admin →
        // seed categories.)
        if ((parsed.rowsByTable.get('marketplace_listings')?.length || 0) > 0
            && (catalogIndex.get('marketplace_categories')?.size || 0) === 0) {
            warnings.push('marketplace_listings: this instance has no marketplace categories seeded, so every listing will import uncategorised. Seed the categories from the Marketplace admin tools, then re-file the listings.');
        }

        // Plan totals for the progress bar: importable, non-empty tables in order.
        const plannedTables = parsed.header.tableOrder.filter((t) => {
            const rows = parsed.rowsByTable.get(t);
            return !!rows && rows.length > 0 && IMPORTABLE_TABLES.has(t);
        });
        const totalTables = plannedTables.length;
        const totalRows = plannedTables.reduce((n, t) => n + (parsed.rowsByTable.get(t)?.length || 0), 0);
        await emit({ type: 'start', totalTables, totalRows });

        // FIRST WRITE of the non-merge path: the pre-clear below deletes the seeded
        // defaults, after which the instance is no longer in its original state.
        writeState.wrote = true;

        // Clear first-boot seeded defaults that would collide with imported ids/keys.
        await emit({ type: 'phase', phase: 'preclear' });
        // settings: clear ONLY the keys the import re-inserts, so fork-only keys
        // (setup_completed, admin_setup_code) survive a re-import (admin-console path).
        const importedSettingsKeys = (parsed.rowsByTable.get('settings') || [])
            .map((r) => r.key).filter((k): k is string => typeof k === 'string')
            .filter((k) => !SETTINGS_IMPORT_DENYLIST.has(k));   // never touch local deployment/integration config
        if (importedSettingsKeys.length > 0) {
            const { error } = await sb.from('settings').delete().in('key', importedSettingsKeys);
            if (error && error.code !== '42P01') {
                const msg = `Pre-clear of settings failed: ${error.message}`;
                warnings.push(msg);
                await emit({ type: 'warning', message: msg });
            }
        }
        for (const { table, col, val } of SEEDED_PRECLEAR) {
            const { error } = await sb.from(table).delete().neq(col, val);
            if (error && error.code !== '42P01') {
                const msg = `Pre-clear of ${table} failed: ${error.message}`;
                warnings.push(msg);
                await emit({ type: 'warning', message: msg });
            }
        }

        let rowsInserted = 0;
        let tablesDone = 0;
        // Every skipped row lands in exactly one bucket; rowsSkipped is their sum.
        // Kept as a breakdown because the single number used to be reported to the
        // operator as "rows from unrecognized tables", which described one bucket and
        // hid the one that cost data.
        const skipBreakdown: ImportSkipBreakdown = {
            unknownTable: 0, excludedTable: 0, catalogMiss: 0, constraintViolation: 0, deploymentSettings: 0,
        };
        const importedTables: string[] = [];
        // ids dropped by a required catalog remap, so a later table's FK to one of them
        // can be nulled (or the row dropped and REPORTED) instead of failing opaquely.
        const droppedIds = new Map<string, Set<string>>();
        // Captured deferred cross-table FKs (e.g. units.leader_id) to restore after
        // every table — including the referenced one — has been inserted.
        const deferredFkRestores: { table: string; id: unknown; col: string; value: unknown }[] = [];

        // Insert in header.tableOrder.
        for (const table of parsed.header.tableOrder) {
            let rawRows = parsed.rowsByTable.get(table);
            if (!rawRows || rawRows.length === 0) continue;

            // Deployment-local federation tables are never imported (peer crypto +
            // dangling api_keys FKs would break federation auth). Re-pair on this install.
            if (IMPORT_EXCLUDED_TABLES.has(table)) {
                skipBreakdown.excludedTable += rawRows.length;
                const msg = `${table}: deployment-local federation data (${rawRows.length} rows) — never imported; re-establish alliances via the handshake flow on this install.`;
                warnings.push(msg);
                await emit({ type: 'warning', message: msg });
                continue;
            }

            if (!IMPORTABLE_TABLES.has(table)) {
                skipBreakdown.unknownTable += rawRows.length;
                const msg = `Unknown table "${table}" in export (${rawRows.length} rows) — skipped.`;
                warnings.push(msg);
                await emit({ type: 'warning', message: msg });
                continue;
            }

            // Deployment/integration settings (Discord OAuth app, LiveKit, Gemini)
            // are never imported — they belong to THIS install (.env / local admin),
            // and a DB value would shadow .env (api/query.ts). Drop them with a warning
            // so the operator knows to configure them locally.
            if (table === 'settings') {
                const before = rawRows.length;
                rawRows = rawRows.filter((r) => !SETTINGS_IMPORT_DENYLIST.has(String(r.key)));
                const dropped = before - rawRows.length;
                if (dropped > 0) {
                    skipBreakdown.deploymentSettings += dropped;
                    const msg = `settings: skipped ${dropped} deployment-config key(s) (${[...SETTINGS_IMPORT_DENYLIST].join(', ')}) — these stay local to this install; configure them via .env / the admin console.`;
                    warnings.push(msg);
                    await emit({ type: 'warning', message: msg });
                }
                if (rawRows.length === 0) continue;
                // Re-apply the admin-console write-boundary sanitizers (sanitizeRichHtml /
                // sanitizeTiptapJson / sanitizeImageUrl / sanitizePublicLinkUrl / stripHtml
                // / theme-colour) the config writers run, so an imported config value can't
                // seed raw HTML / javascript: URLs / tracking hosts the normal write path
                // would have stripped. See the sanitizeImportedSettingRow note above.
                rawRows = rawRows.map(sanitizeImportedSettingRow);
            }

            const prepared: Record<string, unknown>[] = [];
            const deferred: Record<string, unknown>[] = [];
            const misses: RemapMiss[] = [];
            let orphanDropped = 0;
            let orphanNulled = 0;
            const deferredCols = DEFERRED_FKS[table];
            for (const raw of rawRows) {
                const { row, selfRef, drop, remapMiss, orphanedBy } = prepareRow(table, raw, catalogIndex, droppedIds);
                if (remapMiss) misses.push(remapMiss);
                if (orphanedBy) { if (drop) orphanDropped++; else orphanNulled++; }
                if (drop) { skipBreakdown.catalogMiss++; continue; } // unresolved required catalog FK → skip the row
                if (table === 'users') {
                    row.auth_user_id = null;            // re-link on first login
                    row.rsi_verification_code = null;   // transient per-install RSI token — never carry over
                }
                // Defer cross-table FKs that point to a not-yet-imported table; restore
                // after the full import (e.g. units.leader_id → users).
                if (deferredCols) {
                    for (const c of deferredCols) {
                        if (row[c] != null) {
                            deferredFkRestores.push({ table, id: row.id, col: c, value: row[c] });
                            row[c] = null;
                        }
                    }
                }
                prepared.push(row);
                if (selfRef) deferred.push(selfRef);
            }
            // COLLAPSED per-table catalog-miss report — one counted line per outcome
            // instead of one line per row, so a fleet-loss import can no longer crowd
            // every later table's warning out of the summary (or bloat the `done`
            // payload with thousands of near-identical strings).
            const tableWarnings = summariseRemapMisses(table, misses, CATALOG_REMAPS[table]);
            // Name the PARENT, never a hard-coded noun: this same path serves both
            // user_ships and quartermaster_inventory, and "member ship" on a dropped
            // issuance would send the operator to sync the wrong catalog.
            const orphanParent = DROPPED_PARENT_FKS[table]?.[0]?.parent ?? 'parent';
            if (orphanDropped > 0) tableWarnings.push(`${table}: ${orphanDropped} row(s) skipped because the ${orphanParent} row they reference was itself skipped (see the ${orphanParent} warning above).`);
            if (orphanNulled > 0) tableWarnings.push(`${table}: ${orphanNulled} row(s) imported without their ${orphanParent} link, because that row was skipped. Any name recorded on the row itself is kept.`);
            for (const msg of tableWarnings) { warnings.push(msg); await emit({ type: 'warning', message: msg }); }

            const { inserted, strippedColumns, skipped } = await insertRows(table, prepared);
            rowsInserted += inserted;
            skipBreakdown.constraintViolation += skipped;
            for (const col of strippedColumns) {
                const msg = `${table}: column "${col}" is in the export but not in this instance's schema — dropped from import.`;
                warnings.push(msg);
                await emit({ type: 'warning', message: msg });
            }
            if (skipped > 0) {
                const msg = `${table}: ${skipped} row(s) were rejected by this instance's database (a missing reference, or a value this version doesn't allow) — the reason for each is in the server log.`;
                warnings.push(msg);
                await emit({ type: 'warning', message: msg });
            }
            if (deferred.length > 0) {
                for (const msg of await restoreSelfRefs(table, deferred)) {
                    warnings.push(msg);
                    await emit({ type: 'warning', message: msg });
                }
            }
            importedTables.push(table);
            tablesDone++;
            log.info('imported table', { table, inserted, skipped });
            await emit({ type: 'table', table, inserted, tablesDone, totalTables, rowsInserted, totalRows });
        }

        // Restore deferred cross-table FKs (e.g. units.leader_id → users) now that the
        // referenced tables have been inserted. Tolerant: a referenced row missing from
        // the export leaves the FK null (these columns are nullable / ON DELETE SET NULL).
        for (const d of deferredFkRestores) {
            const { error } = await sb.from(d.table).update({ [d.col]: d.value }).eq('id', d.id);
            if (error) {
                const msg = `Could not restore ${d.table}.${d.col} on #${String(d.id)}: ${error.message}; left null.`;
                warnings.push(msg);
                await emit({ type: 'warning', message: msg });
            }
        }

        // Reset sequences for integer-id tables that were imported.
        await emit({ type: 'phase', phase: 'sequences' });
        const { reset, warnings: seqWarnings } = await resetSequences(importedTables);
        warnings.push(...seqWarnings);
        for (const w of seqWarnings) await emit({ type: 'warning', message: w });

        // MERGE re-anchor: bind the admin's Discord login + Admin role onto the
        // imported "me" row so the admin keeps signing in but adopts the imported
        // identity + records. Returns the resulting admin id/role for token re-issue.
        let reanchoredAdminUserId: number | undefined;
        let reanchoredAdminRoleId: number | undefined;
        if (merge && captured) {
            const anchor = await reanchorAdminOntoImportedUser(merge.importedUserId, captured);
            reanchoredAdminUserId = anchor.userId;
            reanchoredAdminRoleId = anchor.roleId;
        }

        // Re-assert "Admin holds every permission" — the import replaced the
        // role_permissions grants with the source org's, which can't reference
        // fork-only permissions (e.g. admin:config:catalog). Runs for every
        // import, merge or not, so whichever Admin role survives is complete.
        await emit({ type: 'phase', phase: 'permissions' });
        const grantsAdded = await ensureAdminRoleHasAllPermissions();
        if (grantsAdded > 0) {
            const msg = `Granted ${grantsAdded} permission(s) to the Admin role that the imported org lacked (e.g. catalog management).`;
            warnings.push(msg);
            await emit({ type: 'warning', message: msg });
        }

        // Turn on the optional modules the source org was running, from the export
        // header. Without this the org's Marketplace/Academy/Warehouse/Quartermaster/
        // Finances data all imports correctly and then sits behind a switched-off
        // module, which reads as the import having failed. Reported, never silent.
        const { enabled: modulesEnabled, warnings: featureWarnings } = await applyImportedFeatureToggles(parsed.header.sourceOrg?.features);
        for (const msg of featureWarnings) { warnings.push(msg); await emit({ type: 'warning', message: msg }); }
        if (modulesEnabled.length > 0) {
            const msg = `Enabled ${modulesEnabled.length} module(s) the source org had switched on: ${modulesEnabled.join(', ')}. Change these any time in Admin → Optional Features.`;
            warnings.push(msg);
            await emit({ type: 'warning', message: msg });
        }

        const result: ImportResult = {
            tablesProcessed: importedTables.length,
            rowsInserted,
            rowsSkipped: skipBreakdown.unknownTable + skipBreakdown.excludedTable
                + skipBreakdown.catalogMiss + skipBreakdown.constraintViolation
                + skipBreakdown.deploymentSettings,
            skipBreakdown,
            sequencesReset: reset,
            warnings,
            modulesEnabled,
            reanchoredAdminUserId,
            reanchoredAdminRoleId,
        };
        await emit({ type: 'done', result });
        return result;
    } catch (err) {
        // Restore the admin we freed so a mid-import failure can't lock them out.
        if (captured) await restoreAdminRow(captured);
        throw err;
    }
}
