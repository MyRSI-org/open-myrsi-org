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
interface WriteResult { data: Record<string, unknown>[] | null; error: { message: string; code?: string } | null; }
interface SelectResult { data: Record<string, unknown>[] | null; error: { message: string; code?: string } | null; count?: number | null; }
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
    sourceOrg?: { name?: string; slug?: string };
    tableOrder: string[];
    manifest: Record<string, number>;
}

export interface ParsedExport {
    header: ImportHeader;
    /** rows grouped by table, in first-seen (export) order within each table. */
    rowsByTable: Map<string, Record<string, unknown>[]>;
    totalRows: number;
}

export interface ImportResult {
    tablesProcessed: number;
    rowsInserted: number;
    rowsSkipped: number;
    sequencesReset: string[];
    warnings: string[];
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
    /** Build a lookup key from an embed object (or row), for both export embed and fork catalog. */
    keyOf: (obj: Record<string, unknown>) => string | null;
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
}

const CATALOG_REMAPS: Record<string, CatalogRemap> = {
    user_ships: {
        fkColumn: 'ship_id',
        embedAlias: 'platform_ships',
        catalogTable: 'platform_ships',
        catalogSelect: 'id, external_uuid, external_api_id',
        required: true, // user_ships.ship_id is NOT NULL — drop ships whose platform model isn't synced
        keyOf: (o) => (o.external_uuid != null ? `u:${String(o.external_uuid)}` : (o.external_api_id != null ? `a:${String(o.external_api_id)}` : null)),
    },
    role_permissions: {
        fkColumn: 'permission_id',
        embedAlias: 'permissions',
        catalogTable: 'permissions',
        catalogSelect: 'id, name',
        required: true, // permission_id is NOT NULL — drop grants for perms this fork doesn't have
        keyOf: (o) => (o.name != null ? `n:${String(o.name)}` : null),
    },
    quartermaster_inventory: {
        fkColumn: 'catalog_id',
        embedAlias: 'quartermaster_catalog',
        catalogTable: 'quartermaster_catalog',
        catalogSelect: 'id, external_uuid, external_id, source',
        required: true, // catalog_id has a NOT-NULL-or-custom_name CHECK; platform rows have no custom_name
        // Only platform catalog rows need remap; custom rows were imported with
        // their original ids preserved, so their catalog_id already resolves.
        shouldRemap: (e) => e.source === 'platform',
        keyOf: (o) => {
            if (o.source !== 'platform') return null;
            if (o.external_uuid != null) return `u:${String(o.external_uuid)}`;
            if (o.external_id != null) return `e:${String(o.external_id)}`;
            return null;
        },
    },
};

// All embed-alias keys that must be stripped from any row before insert
// (they are joined objects, never real columns).
const STRIP_ALWAYS = new Set<string>([
    'platform_ships', 'permissions', 'quartermaster_catalog',
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

export async function assertDatabaseEmpty(): Promise<void> {
    for (const table of EMPTINESS_GUARD_TABLES) {
        const { count, error } = await sb.from(table).select('id', { count: 'exact', head: true }) as unknown as SelectResult;
        if (error) {
            // Missing table (migration not run) is fine — treat as empty.
            if (error.code === '42P01' || error.code === 'PGRST205') continue;
            throw new Error(`Pre-import emptiness check failed on ${table}: ${error.message}`);
        }
        if ((count || 0) > 0) {
            throw new Error(
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
            const key = remap.keyOf(row);
            if (key != null && row.id != null) index.set(key, row.id as number);
        }
        if (rows.length < PAGE) break;
        from += PAGE;
    }
    return index;
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
    warnings: string[],
): { row: Record<string, unknown>; selfRef: Record<string, unknown> | null; drop: boolean } {
    const row: Record<string, unknown> = { ...raw };
    let drop = false;

    // 1. Catalog remap (read embed BEFORE stripping).
    const remap = CATALOG_REMAPS[table];
    if (remap) {
        const embed = row[remap.embedAlias] as Record<string, unknown> | null | undefined;
        if (embed && (!remap.shouldRemap || remap.shouldRemap(embed))) {
            const key = remap.keyOf(embed);
            const forkId = key != null ? catalogIndex.get(remap.catalogTable)?.get(key) : undefined;
            if (forkId != null) {
                row[remap.fkColumn] = forkId;
            } else if (remap.required) {
                // FK is NOT NULL / CHECK-constrained and the catalog row isn't in this
                // instance (a permission/ship this fork lacks, or an unsynced platform
                // catalog) → DROP the row rather than insert NULL and fail the import.
                drop = true;
                const ref = key ? key.replace(/^[a-z]:/, '') : '(unknown)';
                warnings.push(`${table}: "${ref}" is not in this instance's ${remap.catalogTable} catalog — row skipped. (Sync catalogs in Admin → Database Tools before importing to keep these.)`);
            } else {
                // Nullable FK → null it rather than fail the import. Surface a warning.
                row[remap.fkColumn] = null;
                warnings.push(`${table}#${String(row.id)}: ${remap.catalogTable} external key not found in synced catalog; FK ${remap.fkColumn} set NULL.`);
            }
        }
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
    return { row, selfRef, drop };
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
                log.warn('import: row skipped (constraint violation)', { table, error: error.message });
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
async function restoreSelfRefs(table: string, deferred: Record<string, unknown>[]): Promise<void> {
    const cols = SELF_REF_FKS[table];
    if (!cols) return;
    for (const d of deferred) {
        const patch: Record<string, unknown> = {};
        for (const c of cols) if (c in d) patch[c] = d[c];
        if (Object.keys(patch).length === 0) continue;
        const { error } = await sb.from(table).update(patch).eq('id', d.__id);
        if (error) throw new Error(`Restoring self-ref on ${table}#${String(d.__id)} failed: ${error.message}`);
    }
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
        default: return row;
    }
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

export async function importOrgData(ndjson: string, onProgress?: ImportProgressFn, merge?: ImportMergeOptions): Promise<ImportResult> {
    const emit = async (evt: ImportProgressEvent) => { if (onProgress) await onProgress(evt); };

    const parsed = parseExport(ndjson);
    await emit({ type: 'phase', phase: 'validate' });

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
            throw new Error(`Merge target user #${merge.importedUserId} is not present in this export.`);
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
                throw new Error(
                    `Import refused: this instance already contains data (${guardTable} has ${count} rows). ` +
                    `A merge import is a one-time bootstrap into a fresh admin instance.`,
                );
            }
        }
        const { data: adminRows, error: capErr } = await sb.from('users').select(USERS_COLUMNS).eq('id', merge.adminUserId) as unknown as SelectResult;
        if (capErr) throw new Error(`Merge pre-flight failed reading admin #${merge.adminUserId}: ${capErr.message}`);
        captured = (adminRows || [])[0] || null;
        if (!captured) throw new Error(`Merge pre-flight: admin user #${merge.adminUserId} not found.`);
        const { error: delErr } = await sb.from('users').delete().eq('id', merge.adminUserId);
        if (delErr) throw new Error(`Merge pre-flight failed freeing admin #${merge.adminUserId}: ${delErr.message}`);
    }

    try {
        await assertDatabaseEmpty();

        const warnings: string[] = [];

        // Build catalog indexes once (only for tables present in the export).
        const catalogIndex = new Map<string, Map<string, number>>();
        for (const [table, remap] of Object.entries(CATALOG_REMAPS)) {
            if (parsed.rowsByTable.has(table)) {
                catalogIndex.set(remap.catalogTable, await buildCatalogIndex(remap));
            }
        }

        // Plan totals for the progress bar: importable, non-empty tables in order.
        const plannedTables = parsed.header.tableOrder.filter((t) => {
            const rows = parsed.rowsByTable.get(t);
            return !!rows && rows.length > 0 && IMPORTABLE_TABLES.has(t);
        });
        const totalTables = plannedTables.length;
        const totalRows = plannedTables.reduce((n, t) => n + (parsed.rowsByTable.get(t)?.length || 0), 0);
        await emit({ type: 'start', totalTables, totalRows });

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
        let rowsSkipped = 0;
        let tablesDone = 0;
        const importedTables: string[] = [];
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
                rowsSkipped += rawRows.length;
                const msg = `${table}: deployment-local federation data (${rawRows.length} rows) — never imported; re-establish alliances via the handshake flow on this install.`;
                warnings.push(msg);
                await emit({ type: 'warning', message: msg });
                continue;
            }

            if (!IMPORTABLE_TABLES.has(table)) {
                rowsSkipped += rawRows.length;
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
                    rowsSkipped += dropped;
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

            const warnStart = warnings.length;
            const prepared: Record<string, unknown>[] = [];
            const deferred: Record<string, unknown>[] = [];
            const deferredCols = DEFERRED_FKS[table];
            for (const raw of rawRows) {
                const { row, selfRef, drop } = prepareRow(table, raw, catalogIndex, warnings);
                if (drop) { rowsSkipped++; continue; } // unresolved required catalog FK → skip the row
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
            // Surface any per-row prepare warnings (catalog-remap nulls) live.
            for (let i = warnStart; i < warnings.length; i++) await emit({ type: 'warning', message: warnings[i] });

            const { inserted, strippedColumns, skipped } = await insertRows(table, prepared);
            rowsInserted += inserted;
            rowsSkipped += skipped;
            for (const col of strippedColumns) {
                const msg = `${table}: column "${col}" is in the export but not in this instance's schema — dropped from import.`;
                warnings.push(msg);
                await emit({ type: 'warning', message: msg });
            }
            if (skipped > 0) {
                const msg = `${table}: ${skipped} row(s) skipped — they reference data not present in this instance (e.g. an unsynced catalog). See server logs.`;
                warnings.push(msg);
                await emit({ type: 'warning', message: msg });
            }
            if (deferred.length > 0) await restoreSelfRefs(table, deferred);
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

        const result: ImportResult = {
            tablesProcessed: importedTables.length,
            rowsInserted,
            rowsSkipped,
            sequencesReset: reset,
            warnings,
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
