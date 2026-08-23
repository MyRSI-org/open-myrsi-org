import { describe, it, expect, beforeEach, vi } from 'vitest';

// Module on/off state lives on the hosted `organizations.features` column, and
// `organizations` is the one table its exporter never sends — so before this, every
// migrated org came up with Marketplace, Academy, Warehouse, Quartermaster and
// Finances switched OFF and nothing said about it, which reads to an owner exactly
// like the data having failed to import.
//
// The header field is attacker-controlled input in the same sense the settings row is,
// so this channel is deliberately narrow, and these tests pin the narrowness:
//   * a fixed allowlist of the FIVE keys this fork gates on (hosted also sends
//     starcomms/blueprints, which do not exist here),
//   * strict `=== true` coercion (no truthy object/string can enable anything),
//   * rebuilt into this fork's `{ enabled }` shape — a bare boolean reads as OFF
//     through isFeatureEnabled, so a pass-through would silently do nothing,
//   * the DEFAULT-ON keys (leaderboard, externalTools) are never written, because the
//     header does not carry them and writing `false` would switch them off,
//   * and SETTINGS_IMPORT_DENYLIST still blocks an imported orgFeatures settings ROW.

const h = vi.hoisted(() => ({
    inserts: [] as { table: string; rows: Record<string, unknown>[] }[],
    updates: [] as { table: string; patch: Record<string, unknown>; col: string; val: unknown }[],
    deletes: [] as { table: string; method: string; arg: unknown }[],
    /** Existing settings rows returned by `.select('value').eq('key', …)`. */
    settingsRow: null as Record<string, unknown> | null,
    settingsReadError: null as { message: string; code?: string } | null,
    counts: {} as Record<string, number>,
}));

vi.mock('../lib/db/common', () => {
    const make = (table: string) => {
        let patch: Record<string, unknown> | null = null;
        const b: Record<string, unknown> = {
            select: () => b,
            insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
                h.inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
                return Promise.resolve({ error: null });
            },
            update: (p: Record<string, unknown>) => { patch = p; return { eq: (c: string, v: unknown) => { h.updates.push({ table, patch: patch!, col: c, val: v }); return Promise.resolve({ error: null }); } }; },
            delete: () => ({
                neq: (c: string) => { h.deletes.push({ table, method: 'neq', arg: c }); return Promise.resolve({ error: null }); },
                eq: (_c: string, v: unknown) => { h.deletes.push({ table, method: 'eq', arg: v }); return Promise.resolve({ error: null }); },
                in: (_c: string, v: unknown) => { h.deletes.push({ table, method: 'in', arg: v }); return Promise.resolve({ error: null }); },
            }),
            eq: (_c: string, v: unknown) => {
                if (table === 'settings' && v === 'orgFeatures') {
                    return Promise.resolve({ data: h.settingsRow ? [h.settingsRow] : [], error: h.settingsReadError });
                }
                return Promise.resolve({ data: [], error: null });
            },
            in: () => b,
            range: () => Promise.resolve({ data: [], error: null }),
            then: (r: (v: unknown) => unknown) => Promise.resolve({ count: h.counts[table] ?? 0, error: null, data: [] }).then(r),
        };
        return b;
    };
    return { supabase: { from: (t: string) => make(t), rpc: () => Promise.resolve({ error: null }) }, handleSupabaseError: () => {} };
});

import { importOrgData } from '../lib/db/importer';

beforeEach(() => { h.inserts = []; h.updates = []; h.deletes = []; h.settingsRow = null; h.settingsReadError = null; h.counts = {}; });

const ALL_SEVEN = {
    marketplace: false, warehouse: true, academy: true,
    starcomms: false, finances: true, quartermaster: true, blueprints: false,
};

function exportWith(features: unknown, extraRows: string[] = []): string {
    const sourceOrg = features === undefined ? { name: 'Acme' } : { name: 'Acme', features };
    return [
        JSON.stringify({ kind: 'header', version: 1, sourceOrg, tableOrder: ['roles'], manifest: { roles: 1 } }),
        JSON.stringify({ kind: 'row', t: 'roles', r: { id: 1, name: 'Admin' } }),
        ...extraRows,
    ].join('\n');
}

/** The orgFeatures blob the import wrote, from whichever write path it took. */
function writtenFeatures(): Record<string, unknown> | null {
    const inserted = h.inserts.filter((i) => i.table === 'settings').flatMap((i) => i.rows).find((r) => r.key === 'orgFeatures');
    if (inserted) return inserted.value as Record<string, unknown>;
    const updated = h.updates.find((u) => u.table === 'settings' && u.val === 'orgFeatures');
    return updated ? (updated.patch.value as Record<string, unknown>) : null;
}

describe('module toggles carried on the export header', () => {
    it('writes the fork\'s five keys in the NESTED { enabled } shape the predicate reads', async () => {
        const result = await importOrgData(exportWith(ALL_SEVEN));
        expect(writtenFeatures()).toEqual({
            marketplace: { enabled: false },
            warehouse: { enabled: true },
            academy: { enabled: true },
            finances: { enabled: true },
            quartermaster: { enabled: true },
        });
        expect(result.modulesEnabled.sort()).toEqual(['Academy', 'Finances', 'Quartermaster', 'Warehouse']);
    });

    it('ignores hosted-only module keys that do not exist in this fork', async () => {
        await importOrgData(exportWith(ALL_SEVEN));
        const written = writtenFeatures()!;
        expect(written).not.toHaveProperty('starcomms');
        expect(written).not.toHaveProperty('blueprints');
        // government is toggled by its own settings row (governmentsConfig), which the
        // export already carries — it must never appear in this blob.
        expect(written).not.toHaveProperty('government');
    });

    it('never writes the DEFAULT-ON keys, which the header does not carry', async () => {
        await importOrgData(exportWith(ALL_SEVEN));
        const written = writtenFeatures()!;
        // Writing `false` for these would switch off Leaderboard / External Tools, which
        // the source org never disabled — they read `enabled !== false`.
        expect(written).not.toHaveProperty('leaderboard');
        expect(written).not.toHaveProperty('externalTools');
    });

    it('coerces strictly: only a real `true` enables a module', async () => {
        await importOrgData(exportWith({
            marketplace: 'true', warehouse: 1, academy: { enabled: true }, finances: [], quartermaster: true,
        }));
        expect(writtenFeatures()).toEqual({
            marketplace: { enabled: false },
            warehouse: { enabled: false },
            academy: { enabled: false },
            finances: { enabled: false },
            quartermaster: { enabled: true },
        });
    });

    it('merges into an existing blob instead of clobbering it', async () => {
        h.settingsRow = { value: { leaderboard: { enabled: false }, academy: { enabled: false, extra: 'kept-by-caller' } } };
        await importOrgData(exportWith({ academy: true }));
        expect(h.updates.some((u) => u.table === 'settings' && u.val === 'orgFeatures')).toBe(true);
        expect(writtenFeatures()).toEqual({
            leaderboard: { enabled: false },     // untouched sibling survives
            academy: { enabled: true },
        });
    });

    it('writes nothing at all when the header carries no features (older export)', async () => {
        const result = await importOrgData(exportWith(undefined));
        expect(writtenFeatures()).toBeNull();
        expect(result.modulesEnabled).toEqual([]);
        // and no extra settings delete, which would break the pre-clear contract
        expect(h.deletes.filter((d) => d.table === 'settings')).toHaveLength(0);
    });

    it('writes nothing when the header field carries no key this fork knows', async () => {
        const result = await importOrgData(exportWith({ starcomms: true, blueprints: true }));
        expect(writtenFeatures()).toBeNull();
        expect(result.modulesEnabled).toEqual([]);
    });

    it('ignores a features field that is not an object', async () => {
        for (const bogus of ['marketplace', 42, ['academy'], null]) {
            h.inserts = []; h.updates = [];
            const result = await importOrgData(exportWith(bogus));
            expect(writtenFeatures(), `features=${JSON.stringify(bogus)}`).toBeNull();
            expect(result.modulesEnabled).toEqual([]);
        }
    });

    it('reports rather than throws when the toggles cannot be written', async () => {
        h.settingsReadError = { message: 'connection reset', code: '08006' };
        const result = await importOrgData(exportWith(ALL_SEVEN));
        expect(result.rowsInserted).toBe(1);                       // the import still succeeds
        expect(result.modulesEnabled).toEqual([]);
        expect(result.warnings.some((w) => w.includes('Optional Features'))).toBe(true);
    });

    it('still refuses an imported orgFeatures settings ROW — the denylist is unchanged', async () => {
        const result = await importOrgData([
            JSON.stringify({ kind: 'header', version: 1, sourceOrg: { name: 'Acme', features: { academy: true } }, tableOrder: ['settings'], manifest: { settings: 2 } }),
            JSON.stringify({ kind: 'row', t: 'settings', r: { key: 'orgFeatures', value: { marketplace: { enabled: true }, leaderboard: { enabled: false } } } }),
            JSON.stringify({ kind: 'row', t: 'settings', r: { key: 'brandingConfig', value: { name: 'Acme' } } }),
        ].join('\n'));

        // The row is skipped as deployment config…
        expect(result.skipBreakdown.deploymentSettings).toBe(1);
        // …and what lands is the ALLOWLISTED header shape, not the row's arbitrary blob.
        expect(writtenFeatures()).toEqual({ academy: { enabled: true } });
        // The settings pre-clear must not have been widened to include the denied key.
        const settingsDeletes = h.deletes.filter((d) => d.table === 'settings');
        expect(settingsDeletes).toHaveLength(1);
        expect(settingsDeletes[0].arg).toEqual(['brandingConfig']);
    });
});
