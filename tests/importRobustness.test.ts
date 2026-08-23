import { describe, it, expect, beforeEach, vi } from 'vitest';

// The failure-visibility half of the importer. None of this changes WHAT imports —
// it changes whether a migration that lost data says so. The reported hosted→
// self-hosted fleet loss went undiagnosed for as long as it did because every one of
// these was silent:
//   * a row rejected by the database was logged as a bare message, with no SQLSTATE,
//     no detail and no row id — so nobody could tell an FK orphan from an enum drift;
//   * the summary reported every skipped row as coming "from unrecognized tables",
//     which is one of five causes and not the one that cost the ships;
//   * one unrestorable self-reference aborted an otherwise complete 40k-row import,
//     with no rollback and no sequence reset;
//   * and systemConfig.appUrl overwrote this deployment's own public origin — the one
//     alliance pairing advertises — with the source deployment's.

const h = vi.hoisted(() => ({
    inserts: [] as { table: string; rows: Record<string, unknown>[] }[],
    updates: [] as { table: string; patch: Record<string, unknown>; val: unknown }[],
    warns: [] as { msg: string; fields: Record<string, unknown> }[],
    /** Reject a specific row on insert with a full PostgREST error body. */
    failRow: null as null | { table: string; col: string; value: unknown },
    /** Reject the self-ref restore update for a table. */
    failUpdate: null as null | string,
    counts: {} as Record<string, number>,
}));

vi.mock('../lib/log', () => {
    const child = () => ({
        info: () => {}, error: () => {}, debug: () => {},
        warn: (msg: string, fields: Record<string, unknown>) => { h.warns.push({ msg, fields }); },
        child,
    });
    return { log: { child, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } };
});

vi.mock('../lib/db/common', () => {
    const make = (table: string) => {
        let patch: Record<string, unknown> | null = null;
        const b: Record<string, unknown> = {
            select: () => b,
            insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
                const arr = Array.isArray(rows) ? rows : [rows];
                h.inserts.push({ table, rows: arr });
                const fr = h.failRow;
                if (fr && table === fr.table && arr.some((r) => r[fr.col] === fr.value)) {
                    return Promise.resolve({
                        error: {
                            code: '23503',
                            message: `insert or update on table "${table}" violates foreign key constraint "${table}_fk"`,
                            details: `Key (${fr.col})=(${String(fr.value)}) is not present in table "user_ships".`,
                            hint: null,
                        },
                    });
                }
                return Promise.resolve({ error: null });
            },
            update: (p: Record<string, unknown>) => {
                patch = p;
                return { eq: (_c: string, v: unknown) => {
                    h.updates.push({ table, patch: patch!, val: v });
                    return Promise.resolve({ error: h.failUpdate === table ? { message: 'parent row is gone', code: '23503' } : null });
                } };
            },
            delete: () => ({ neq: () => Promise.resolve({ error: null }), eq: () => Promise.resolve({ error: null }), in: () => Promise.resolve({ error: null }) }),
            eq: () => Promise.resolve({ data: [], error: null }),
            in: () => b,
            range: () => Promise.resolve({ data: [], error: null }),
            then: (r: (v: unknown) => unknown) => Promise.resolve({ count: h.counts[table] ?? 0, error: null, data: [] }).then(r),
        };
        return b;
    };
    return { supabase: { from: (t: string) => make(t), rpc: () => Promise.resolve({ error: null }) }, handleSupabaseError: () => {} };
});

import { importOrgData } from '../lib/db/importer';

beforeEach(() => { h.inserts = []; h.updates = []; h.warns = []; h.failRow = null; h.failUpdate = null; h.counts = {}; });

const insertedInto = (table: string) => h.inserts.filter((i) => i.table === table).flatMap((i) => i.rows);
const header = (tables: Record<string, number>) =>
    `{"kind":"header","version":1,"tableOrder":${JSON.stringify(Object.keys(tables))},"manifest":${JSON.stringify(tables)}}`;
const row = (t: string, r: Record<string, unknown>) => JSON.stringify({ kind: 'row', t, r });

describe('rejected-row diagnostics', () => {
    it('logs the SQLSTATE, the detail and the row id — not just the message', async () => {
        h.failRow = { table: 'fleet_group_ships', col: 'user_ship_id', value: 999 };
        await importOrgData([
            header({ fleet_group_ships: 2 }),
            row('fleet_group_ships', { id: 1, fleet_group_id: 1, user_ship_id: 5 }),
            row('fleet_group_ships', { id: 2, fleet_group_id: 1, user_ship_id: 999 }),
        ].join('\n'));

        const skip = h.warns.find((w) => w.msg.includes('row skipped'));
        expect(skip).toBeTruthy();
        expect(skip!.fields.table).toBe('fleet_group_ships');
        expect(skip!.fields.rowId).toBe(2);                       // WHICH row was discarded
        expect(skip!.fields.code).toBe('23503');                  // FK orphan, not an enum drift
        expect(String(skip!.fields.details)).toContain('user_ships');
    });

    it('caps the detail so a rejected wide row cannot flood the log', async () => {
        h.failRow = { table: 'roles', col: 'id', value: 2 };
        await importOrgData([header({ roles: 1 }), row('roles', { id: 2, name: 'X' })].join('\n'));
        const skip = h.warns.find((w) => w.msg.includes('row skipped'))!;
        expect(String(skip.fields.details).length).toBeLessThanOrEqual(500);
    });
});

describe('skip accounting', () => {
    it('splits rowsSkipped by CAUSE, so a dropped ship is never reported as an unknown table', async () => {
        h.failRow = { table: 'fleet_group_ships', col: 'user_ship_id', value: 999 };
        const result = await importOrgData([
            header({ some_future_table: 2, alliance_peers: 1, fleet_group_ships: 1, settings: 2 }),
            row('some_future_table', { id: 1 }),
            row('some_future_table', { id: 2 }),
            row('alliance_peers', { id: 'p1', outbound_key_enc: 'x' }),
            row('fleet_group_ships', { id: 1, fleet_group_id: 1, user_ship_id: 999 }),
            row('settings', { key: 'discordConfig', value: { clientId: 'x' } }),
            row('settings', { key: 'brandingConfig', value: { name: 'Acme' } }),
        ].join('\n'));

        expect(result.skipBreakdown).toEqual({
            unknownTable: 2,
            excludedTable: 1,
            catalogMiss: 0,
            constraintViolation: 1,
            deploymentSettings: 1,
        });
        // The headline number is exactly the sum of the causes.
        const bd = result.skipBreakdown;
        expect(result.rowsSkipped).toBe(bd.unknownTable + bd.excludedTable + bd.catalogMiss + bd.constraintViolation + bd.deploymentSettings);
        expect(result.rowsSkipped).toBe(5);
    });

    it('reports zero skips as an all-zero breakdown, not an absent one', async () => {
        const result = await importOrgData([header({ roles: 1 }), row('roles', { id: 1, name: 'Admin' })].join('\n'));
        expect(result.rowsSkipped).toBe(0);
        expect(result.skipBreakdown).toEqual({ unknownTable: 0, excludedTable: 0, catalogMiss: 0, constraintViolation: 0, deploymentSettings: 0 });
    });
});

describe('self-reference restore', () => {
    it('warns and continues instead of aborting the whole import', async () => {
        h.failUpdate = 'units';
        const result = await importOrgData([
            header({ units: 2, roles: 1 }),
            row('units', { id: 1, name: 'HQ', parent_unit_id: null }),
            row('units', { id: 2, name: 'Alpha', parent_unit_id: 1 }),
            row('roles', { id: 1, name: 'Admin' }),
        ].join('\n'));

        // Everything after the failing restore still ran…
        expect(insertedInto('roles')).toHaveLength(1);
        expect(result.tablesProcessed).toBe(2);
        expect(result.sequencesReset).toContain('units');   // …including the sequence reset
        expect(result.warnings.some((w) => w.includes('parent link'))).toBe(true);
    });

    it('still restores the self-reference on the happy path', async () => {
        await importOrgData([
            header({ units: 2 }),
            row('units', { id: 1, name: 'HQ', parent_unit_id: null }),
            row('units', { id: 2, name: 'Alpha', parent_unit_id: 1 }),
        ].join('\n'));
        // Nulled on insert…
        expect(insertedInto('units').map((r) => r.parent_unit_id)).toEqual([null, null]);
        // …restored on the second pass.
        expect(h.updates).toContainEqual({ table: 'units', patch: { parent_unit_id: 1 }, val: 2 });
    });
});

describe('deployment-local settings', () => {
    it('strips systemConfig.appUrl so an import cannot overwrite this instance\'s own origin', async () => {
        const result = await importOrgData([
            header({ settings: 1 }),
            row('settings', { key: 'systemConfig', value: { appUrl: 'https://hosted.example.org', welcomeMessage: 'Hello crew.' } }),
        ].join('\n'));

        const systemConfig = insertedInto('settings').find((r) => r.key === 'systemConfig');
        expect(systemConfig).toBeTruthy();
        // Omitted, not blanked: both readers guard on truthiness and fall back to
        // process.env.APP_URL, i.e. "unset — configure it on this install".
        expect(systemConfig!.value).toEqual({ welcomeMessage: 'Hello crew.' });
        // The rest of the row is ordinary org config and is NOT collateral damage.
        expect(result.skipBreakdown.deploymentSettings).toBe(0);
    });

    it('leaves a systemConfig row that carries no appUrl untouched', async () => {
        await importOrgData([
            header({ settings: 1 }),
            row('settings', { key: 'systemConfig', value: { welcomeMessage: 'Hi' } }),
        ].join('\n'));
        expect(insertedInto('settings')[0].value).toEqual({ welcomeMessage: 'Hi' });
    });

    it('still imports governmentsConfig, which is how the Government module round-trips', async () => {
        await importOrgData([
            header({ settings: 1 }),
            row('settings', { key: 'governmentsConfig', value: { enabled: true, model: 'senate' } }),
        ].join('\n'));
        expect(insertedInto('settings')[0].value).toEqual({ enabled: true, model: 'senate' });
    });
});
