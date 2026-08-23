import { describe, it, expect, beforeEach, vi } from 'vitest';

// The fleet half of the hosted→self-hosted migration contract.
//
// THE BUG THIS PINS. The importer resolves user_ships.ship_id against THIS instance's
// platform_ships by external key, and the FK is NOT NULL — a miss drops the row. The
// old code stored exactly ONE key per catalog row and computed exactly ONE key per
// export embed, both uuid-first. A self-hosted catalog is api-id-only (syncShipCatalog
// upserts on external_api_id and never writes a uuid), while hosted rows predating its
// shipmatrix pivot carry BOTH — so the embed keyed on the uuid, the index held only api
// ids, and every ship in the org was dropped. fleet_groups has no catalog FK, so the
// symptom was an intact group tree containing nothing.
//
// Indexing and probing EVERY key form fixes it from either side, and the probe order
// (api id → uuid → name+manufacturer) is what stops the loose name fallback from
// outranking an exact match.

const h = vi.hoisted(() => ({
    inserts: [] as { table: string; rows: Record<string, unknown>[] }[],
    updates: [] as { table: string; patch: Record<string, unknown>; col: string; val: unknown }[],
    deletes: [] as { table: string; method: string; arg: unknown }[],
    /** Rows returned by `.range()` (catalog pages) and by a bare await. */
    rows: {} as Record<string, Record<string, unknown>[]>,
    /** `select(..., {count}).head` results, keyed by table. */
    counts: {} as Record<string, number>,
    /** Rows returned by a `.select(...).eq(col, val)` on this table. */
    eqRows: {} as Record<string, Record<string, unknown>[]>,
    /** Forces the head-count/bare-await path to return an error. */
    selectError: null as null | { message: string; code?: string },
    /** Makes an insert into this table throw (not return an error) — a genuine failure. */
    throwOnInsertInto: null as null | string,
}));

vi.mock('../lib/db/common', () => {
    const make = (table: string) => {
        let patch: Record<string, unknown> | null = null;
        const b: Record<string, unknown> = {
            select: () => b,
            insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
                h.inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
                if (h.throwOnInsertInto === table) throw new Error('boom: the database went away mid-import');
                return Promise.resolve({ error: null });
            },
            update: (p: Record<string, unknown>) => { patch = p; return { eq: (c: string, v: unknown) => { h.updates.push({ table, patch: patch!, col: c, val: v }); return Promise.resolve({ error: null }); } }; },
            delete: () => ({
                neq: (c: string) => { h.deletes.push({ table, method: 'neq', arg: c }); return Promise.resolve({ error: null }); },
                eq: (_c: string, v: unknown) => { h.deletes.push({ table, method: 'eq', arg: v }); return Promise.resolve({ error: null }); },
                in: (_c: string, v: unknown) => { h.deletes.push({ table, method: 'in', arg: v }); return Promise.resolve({ error: null }); },
            }),
            eq: () => Promise.resolve({ data: h.eqRows[table] || [], error: null }),
            in: () => b,
            range: () => Promise.resolve({ data: h.rows[table] || [], error: null }),
            then: (r: (v: unknown) => unknown) => Promise.resolve({ count: h.counts[table] ?? 0, error: table === 'platform_ships' ? h.selectError : null, data: h.rows[table] || [] }).then(r),
        };
        return b;
    };
    return { supabase: { from: (t: string) => make(t), rpc: () => Promise.resolve({ error: null }) }, handleSupabaseError: () => {} };
});

import { importOrgData, ImportRefusedError } from '../lib/db/importer';

beforeEach(() => { h.inserts = []; h.updates = []; h.deletes = []; h.rows = {}; h.counts = {}; h.eqRows = {}; h.selectError = null; h.throwOnInsertInto = null; });

/** A catalog with at least one ship, so the empty-catalog pre-flight does not fire. */
function catalog(...ships: Record<string, unknown>[]) {
    h.rows.platform_ships = ships;
    h.counts.platform_ships = ships.length;
}

const header = (tables: Record<string, number>) =>
    `{"kind":"header","version":1,"tableOrder":${JSON.stringify(Object.keys(tables))},"manifest":${JSON.stringify(tables)}}`;

const row = (t: string, r: Record<string, unknown>) => JSON.stringify({ kind: 'row', t, r });

const insertedInto = (table: string) => h.inserts.filter((i) => i.table === table).flatMap((i) => i.rows);

describe('ship catalog dual-key remap', () => {
    it('matches an api-id-only embed against a catalog row that carries BOTH keys (the regression the hosted fix would otherwise cause)', async () => {
        // Destination catalog seeded from a hosted dump and then synced → both keys.
        catalog({ id: 77, external_uuid: 'uuid-cutlass', external_api_id: 42, name: 'Cutlass Black', manufacturer: 'Drake' });
        // Hosted now nulls the uuid whenever the api id is present.
        const ndjson = [
            header({ user_ships: 1 }),
            row('user_ships', { id: 1, user_id: 5, ship_id: 900, platform_ships: { external_uuid: null, external_api_id: 42, name: 'Cutlass Black', manufacturer: 'Drake' } }),
        ].join('\n');

        const result = await importOrgData(ndjson);
        expect(result.rowsInserted).toBe(1);
        expect(result.skipBreakdown.catalogMiss).toBe(0);
        expect(insertedInto('user_ships')[0].ship_id).toBe(77);   // remapped to the LOCAL id
        expect(insertedInto('user_ships')[0].platform_ships).toBeUndefined(); // embed stripped
    });

    it('matches a both-keys embed against an api-id-only catalog (the default self-hosted path)', async () => {
        catalog({ id: 12, external_uuid: null, external_api_id: 42, name: 'Cutlass Black', manufacturer: 'Drake' });
        const ndjson = [
            header({ user_ships: 1 }),
            row('user_ships', { id: 1, user_id: 5, ship_id: 900, platform_ships: { external_uuid: 'uuid-cutlass', external_api_id: 42, name: 'Cutlass Black', manufacturer: 'Drake' } }),
        ].join('\n');
        const result = await importOrgData(ndjson);
        expect(result.rowsInserted).toBe(1);
        expect(insertedInto('user_ships')[0].ship_id).toBe(12);
    });

    it('matches on uuid when neither side has an api id', async () => {
        catalog({ id: 3, external_uuid: 'uuid-only', external_api_id: null, name: 'Herald', manufacturer: 'Drake' });
        const ndjson = [
            header({ user_ships: 1 }),
            row('user_ships', { id: 1, user_id: 5, ship_id: 900, platform_ships: { external_uuid: 'uuid-only', external_api_id: null, name: 'Herald', manufacturer: 'Drake' } }),
        ].join('\n');
        expect((await importOrgData(ndjson)).rowsInserted).toBe(1);
        expect(insertedInto('user_ships')[0].ship_id).toBe(3);
    });

    it('falls back to an exact lower-cased name+manufacturer when the row has NO external id (legacy paint variants)', async () => {
        catalog({ id: 9, external_uuid: null, external_api_id: 7, name: 'Cutlass Black', manufacturer: 'Drake Interplanetary' });
        const ndjson = [
            header({ user_ships: 1 }),
            // Hosted legacy variant: no external id at all, only the display pair.
            row('user_ships', { id: 1, user_id: 5, ship_id: 900, platform_ships: { external_uuid: null, external_api_id: null, name: 'CUTLASS BLACK', manufacturer: 'drake interplanetary' } }),
        ].join('\n');
        expect((await importOrgData(ndjson)).rowsInserted).toBe(1);
        expect(insertedInto('user_ships')[0].ship_id).toBe(9);
    });

    it('never lets the name fallback outrank an exact external-id match', async () => {
        // Two catalog rows share a name; only one carries the api id the embed names.
        catalog(
            { id: 1, external_uuid: null, external_api_id: 111, name: 'Freelancer', manufacturer: 'MISC' },
            { id: 2, external_uuid: null, external_api_id: 222, name: 'Freelancer', manufacturer: 'MISC' },
        );
        const ndjson = [
            header({ user_ships: 1 }),
            row('user_ships', { id: 1, user_id: 5, ship_id: 900, platform_ships: { external_uuid: null, external_api_id: 222, name: 'Freelancer', manufacturer: 'MISC' } }),
        ].join('\n');
        await importOrgData(ndjson);
        expect(insertedInto('user_ships')[0].ship_id).toBe(2);   // the api id wins, not the first name match
    });

    it('is first-write-wins on a duplicated name key, so the winner does not depend on page order', async () => {
        catalog(
            { id: 10, external_uuid: null, external_api_id: 1, name: 'Aurora', manufacturer: 'RSI' },
            { id: 20, external_uuid: null, external_api_id: 2, name: 'Aurora', manufacturer: 'RSI' },
        );
        const ndjson = [
            header({ user_ships: 1 }),
            row('user_ships', { id: 1, user_id: 5, ship_id: 900, platform_ships: { external_uuid: null, external_api_id: null, name: 'Aurora', manufacturer: 'RSI' } }),
        ].join('\n');
        await importOrgData(ndjson);
        expect(insertedInto('user_ships')[0].ship_id).toBe(10);
    });

    it('drops an unresolvable ship, counts it as a catalog miss, and reports it in ONE collapsed warning naming the model', async () => {
        catalog({ id: 1, external_uuid: null, external_api_id: 1, name: 'Aurora', manufacturer: 'RSI' });
        const lines = [header({ user_ships: 3 })];
        for (let i = 1; i <= 3; i++) {
            lines.push(row('user_ships', { id: i, user_id: 5, ship_id: 900, platform_ships: { external_uuid: null, external_api_id: 999, name: 'Idris-P', manufacturer: 'Aegis' } }));
        }
        const result = await importOrgData(lines.join('\n'));

        expect(insertedInto('user_ships')).toHaveLength(0);
        expect(result.rowsSkipped).toBe(3);
        expect(result.skipBreakdown.catalogMiss).toBe(3);
        // ONE line, not three — and it still names the key an operator can search for
        // and where to go to fix it.
        const shipWarnings = result.warnings.filter((w) => w.startsWith('user_ships:'));
        expect(shipWarnings).toHaveLength(1);
        expect(shipWarnings[0]).toContain('3 row(s) SKIPPED');
        expect(shipWarnings[0]).toContain('999');
        expect(shipWarnings[0]).toContain('Ship Catalog');
        expect(shipWarnings[0]).not.toContain('Database Tools');
    });

    it('keeps an operation participant whose ship cannot be resolved, nulling only the ship link', async () => {
        catalog({ id: 1, external_uuid: null, external_api_id: 1, name: 'Aurora', manufacturer: 'RSI' });
        const ndjson = [
            header({ operation_participants: 1 }),
            row('operation_participants', {
                operation_id: 'op-1', user_id: 5, ship_id: null, ship_utilized: 'Idris-P',
                attendance_status: 'Attended', payout_share_percent: 25,
                platform_ships: { external_uuid: null, external_api_id: 999, name: 'Idris-P', manufacturer: 'Aegis' },
            }),
        ].join('\n');
        const result = await importOrgData(ndjson);

        const p = insertedInto('operation_participants')[0];
        expect(result.rowsInserted).toBe(1);           // the participation record survives…
        expect(p.ship_id).toBeNull();                  // …without the catalog link
        expect(p.ship_utilized).toBe('Idris-P');       // the human-readable name is kept
        expect(p.payout_share_percent).toBe(25);
        expect(result.skipBreakdown.catalogMiss).toBe(0);
        expect(result.warnings.some((w) => w.includes('operation_participants') && w.includes('left empty'))).toBe(true);
    });

    it('does not let a dropped ship silently take its dependent rows with it', async () => {
        // user_ships #1 is dropped (unknown model). Its dependants reference it by
        // user_ship_id, which the exporter does NOT nullify — previously they FK-failed
        // and vanished with no operator-visible warning, taking payout/attendance too.
        catalog({ id: 5, external_uuid: null, external_api_id: 5, name: 'Aurora', manufacturer: 'RSI' });
        const ndjson = [
            header({ user_ships: 2, fleet_group_ships: 2, operation_participants: 1 }),
            row('user_ships', { id: 1, user_id: 5, ship_id: 900, platform_ships: { external_uuid: null, external_api_id: 999, name: 'Idris-P', manufacturer: 'Aegis' } }),
            row('user_ships', { id: 2, user_id: 5, ship_id: 900, platform_ships: { external_uuid: null, external_api_id: 5, name: 'Aurora', manufacturer: 'RSI' } }),
            row('fleet_group_ships', { id: 1, fleet_group_id: 1, user_ship_id: 1 }),   // orphan → must drop
            row('fleet_group_ships', { id: 2, fleet_group_id: 1, user_ship_id: 2 }),   // fine
            row('operation_participants', { operation_id: 'op-1', user_id: 5, user_ship_id: 1, ship_utilized: 'Idris-P', payout_share_percent: 40 }),
        ].join('\n');
        const result = await importOrgData(ndjson);

        expect(insertedInto('user_ships').map((r) => r.id)).toEqual([2]);
        // The NOT NULL dependant is dropped — but as an accounted, reported catalog miss.
        expect(insertedInto('fleet_group_ships').map((r) => r.id)).toEqual([2]);
        expect(result.warnings.some((w) => w.startsWith('fleet_group_ships:') && w.includes('user_ships'))).toBe(true);
        // The NULLABLE dependant keeps its record and loses only the link.
        const p = insertedInto('operation_participants')[0];
        expect(p).toBeTruthy();
        expect(p.user_ship_id).toBeNull();
        expect(p.payout_share_percent).toBe(40);
        expect(result.warnings.some((w) => w.startsWith('operation_participants:') && w.includes('user_ships link'))).toBe(true);
    });
});

describe('empty ship-catalog pre-flight', () => {
    it('REFUSES an export carrying ships when platform_ships is empty, before writing anything', async () => {
        h.counts.platform_ships = 0;
        const ndjson = [
            header({ roles: 1, user_ships: 1 }),
            row('roles', { id: 1, name: 'Admin' }),
            row('user_ships', { id: 1, user_id: 5, ship_id: 900, platform_ships: { external_api_id: 42 } }),
        ].join('\n');

        await expect(importOrgData(ndjson)).rejects.toThrow(/ship catalog is empty/i);
        // Nothing written — not even the pre-clear-then-insert of the first table.
        expect(h.inserts).toHaveLength(0);
    });

    it('names the sync destination and the skip-and-import-later escape hatch', async () => {
        h.counts.platform_ships = 0;
        const ndjson = [header({ user_ships: 1 }), row('user_ships', { id: 1, user_id: 5, ship_id: 900, platform_ships: { external_api_id: 42 } })].join('\n');
        await expect(importOrgData(ndjson)).rejects.toThrow(/Ship Catalog/);
        await expect(importOrgData(ndjson)).rejects.toThrow(/Import Organization/);
    });

    it('does not fire when the export carries no ships', async () => {
        h.counts.platform_ships = 0;
        const ndjson = [header({ roles: 1 }), row('roles', { id: 1, name: 'Admin' })].join('\n');
        const result = await importOrgData(ndjson);
        expect(result.rowsInserted).toBe(1);
    });

    it('refuses BEFORE the merge pre-flight frees the acting admin', async () => {
        // This is the ordinary first-run path: the wizard always takes the merge branch
        // when the export has users, and a fresh install ALWAYS has an empty catalog.
        // Refusing after the admin row is deleted would make the best-effort
        // restoreAdminRow the routine path — and it re-inserts only a projection.
        h.counts.platform_ships = 0;
        h.eqRows.users = [{ id: 1, discord_id: 'd1', auth_user_id: 'a1', role_id: 9 }];
        const ndjson = [
            header({ users: 1, user_ships: 1 }),
            row('users', { id: 10, name: 'Me', discord_id: 'd1' }),
            row('user_ships', { id: 1, user_id: 10, ship_id: 900, platform_ships: { external_api_id: 42 } }),
        ].join('\n');

        await expect(importOrgData(ndjson, undefined, { importedUserId: 10, adminUserId: 1 })).rejects.toThrow(/ship catalog is empty/i);
        expect(h.deletes.filter((d) => d.table === 'users'), 'the admin row must never be freed for an import we decline').toEqual([]);
        expect(h.inserts).toHaveLength(0);
    });

    it('tags a pre-write refusal as ImportRefusedError so the UI can say "nothing was changed"', async () => {
        h.counts.platform_ships = 0;
        const ndjson = [header({ user_ships: 1 }), row('user_ships', { id: 1, user_id: 5, ship_id: 900, platform_ships: { external_api_id: 42 } })].join('\n');
        await expect(importOrgData(ndjson)).rejects.toBeInstanceOf(ImportRefusedError);

        // …and so is the already-has-data refusal, which is equally non-destructive.
        h.counts.platform_ships = 1;
        h.counts.users = 3;
        await expect(importOrgData([header({ roles: 1 }), row('roles', { id: 1, name: 'Admin' })].join('\n')))
            .rejects.toBeInstanceOf(ImportRefusedError);
    });
});

describe('refusal is classified by whether anything was written, not by throw site', () => {
    // "Nothing was changed" drives whether the first-run wizard tells the operator to
    // wipe their database, so it must be derived from what happened rather than from
    // remembering to pick an Error subclass at every throw site. These pin the
    // structural rule in both directions.

    it.each([
        ['a malformed line', 'not json at all'],
        ['a missing header', '{"kind":"row","t":"roles","r":{"id":1}}'],
        ['an unsupported version', '{"kind":"header","version":99,"tableOrder":[],"manifest":{}}'],
        ['a header with no tableOrder', '{"kind":"header","version":1,"manifest":{}}'],
        ['an unknown line kind', '{"kind":"header","version":1,"tableOrder":[],"manifest":{}}\n{"kind":"banana"}'],
    ])('reports %s as a refusal — parseExport cannot have written anything', async (_label, ndjson) => {
        await expect(importOrgData(ndjson)).rejects.toBeInstanceOf(ImportRefusedError);
        expect(h.inserts).toHaveLength(0);
        expect(h.deletes).toHaveLength(0);
    });

    it('reports a failed pre-flight READ as a refusal, not as possible data loss', async () => {
        // A transient database blip while counting ships must not tell the operator
        // their half-imported instance needs wiping — nothing was written.
        h.counts.platform_ships = 0;
        h.selectError = { message: 'connection reset', code: '08006' };
        const ndjson = [header({ user_ships: 1 }), row('user_ships', { id: 1, user_id: 5, ship_id: 1, platform_ships: { external_api_id: 42 } })].join('\n');
        await expect(importOrgData(ndjson)).rejects.toBeInstanceOf(ImportRefusedError);
        expect(h.inserts).toHaveLength(0);
    });

    it('does NOT report a failure after the first write as a refusal', async () => {
        // Once the pre-clear has run, the seeded defaults are gone and the instance is
        // no longer as it was — "nothing was changed" would be a false assurance, and
        // the operator genuinely does need the reset-and-retry path.
        h.throwOnInsertInto = 'roles';
        const ndjson = [header({ roles: 1 }), row('roles', { id: 1, name: 'Admin' })].join('\n');
        const err = await importOrgData(ndjson).then(() => null, (e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(ImportRefusedError);
        expect(h.deletes.length, 'the pre-clear ran, so the instance was modified').toBeGreaterThan(0);
    });
});

describe('a nullable catalog FK that arrives with no key to resolve it', () => {
    it('is NULLED rather than trusted, so an old-format export cannot attribute the wrong hull', async () => {
        // The format version is deliberately never bumped, so an export produced before
        // the exporter started nullifying + embedding still imports. Its raw ship_id
        // belongs to the SOURCE catalog's numbering: inserting it verbatim does not
        // fail, it silently points at whatever unrelated ship holds that id here.
        catalog({ id: 187, external_uuid: null, external_api_id: 5, name: 'Aurora', manufacturer: 'RSI' });
        const ndjson = [
            header({ operation_participants: 1 }),
            row('operation_participants', { operation_id: 'op-1', user_id: 5, ship_id: 187, ship_utilized: 'Idris-P' }),
        ].join('\n');

        const result = await importOrgData(ndjson);
        const p = insertedInto('operation_participants')[0];
        expect(result.rowsInserted).toBe(1);
        expect(p.ship_id).toBeNull();               // NOT 187 → not the local Aurora
        expect(p.ship_utilized).toBe('Idris-P');
    });

    it('cascades a dropped quartermaster inventory row to its NOT NULL dependants, with an explanation', async () => {
        // The item catalog has no pre-flight (unlike ships), so this is the realistic
        // failure: one unsynced catalog drops the inventory, and without the cascade
        // every issuance and movement would then FK-fail one at a time and be reported
        // as a generic "rejected by the database" — hiding the single actual cause.
        h.rows.quartermaster_catalog = [];
        const ndjson = [
            header({ quartermaster_inventory: 1, quartermaster_issuances: 1, quartermaster_inventory_movements: 1 }),
            row('quartermaster_inventory', { id: 1, catalog_id: 5, location_id: 1, quantity: 3, quartermaster_catalog: { source: 'platform', external_id: 'ITEM-9' } }),
            row('quartermaster_issuances', { id: 1, inventory_id: 1, issued_to_user_id: 5, quantity: 1 }),
            row('quartermaster_inventory_movements', { id: 'm-1', inventory_id: 1, delta: 1, reason: 'initial', actor_user_id: 5 }),
        ].join('\n');

        const result = await importOrgData(ndjson);
        expect(insertedInto('quartermaster_inventory')).toHaveLength(0);
        expect(insertedInto('quartermaster_issuances')).toHaveLength(0);
        expect(insertedInto('quartermaster_inventory_movements')).toHaveLength(0);
        // All three land in catalogMiss — one cause, honestly counted — rather than one
        // catalogMiss plus two opaque constraint violations.
        expect(result.skipBreakdown.catalogMiss).toBe(3);
        expect(result.skipBreakdown.constraintViolation).toBe(0);
        const issuanceWarning = result.warnings.find((w) => w.startsWith('quartermaster_issuances:'));
        expect(issuanceWarning).toBeTruthy();
        // The cascade noun is derived from the PARENT, never hard-coded — an issuance
        // has no ship, and telling its owner otherwise points them at the wrong catalog.
        expect(issuanceWarning).toContain('quartermaster_inventory');
        expect(issuanceWarning).not.toMatch(/ship/i);
        expect(result.warnings.some((w) => w.startsWith('quartermaster_inventory:') && w.includes('Item Catalog'))).toBe(true);
    });

    it('leaves a REQUIRED remap alone when its embed is absent (quartermaster custom rows keep their preserved ids)', async () => {
        // quartermaster_inventory rows for CUSTOM items carry no embed, and their
        // catalog_id was imported earlier with its id preserved — nulling it would
        // break the very rows the shouldRemap guard exists to protect.
        h.rows.quartermaster_catalog = [];
        const ndjson = [
            header({ quartermaster_inventory: 1 }),
            row('quartermaster_inventory', { id: 1, catalog_id: 77, location_id: 1, quantity: 3 }),
        ].join('\n');
        const result = await importOrgData(ndjson);
        expect(result.rowsInserted).toBe(1);
        expect(insertedInto('quartermaster_inventory')[0].catalog_id).toBe(77);
    });
});
