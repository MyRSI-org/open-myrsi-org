import { describe, it, expect, beforeEach, vi } from 'vitest';

// Two importer-resilience behaviors against a real hosted-SaaS export:
//   1. CROSS-TABLE forward FK (units.leader_id → users, while users.unit_id → units):
//      units is exported before users, so leader_id is NULLed on insert and restored
//      after the full import.
//   2. SCHEMA DIVERGENCE: the single-org fork drops columns the SaaS export still
//      carries (e.g. users.last_active_at); the insert strips the unknown column and
//      retries instead of failing the whole import.

const h = vi.hoisted(() => ({
    inserts: [] as { table: string; rows: any[] }[],
    updates: [] as { table: string; patch: any; id: unknown }[],
    deletes: [] as { table: string; col: string; vals: unknown[] }[],
    unknownCols: {} as Record<string, string[]>,
    failRow: null as null | { table: string; col: string; value: unknown },
}));

vi.mock('../lib/db/common', () => {
    const make = (table: string) => {
        let pendingPatch: any = null;
        const b: any = {
            select: () => b,
            insert: (rows: any) => {
                const arr = Array.isArray(rows) ? rows : [rows];
                h.inserts.push({ table, rows: arr });
                for (const c of (h.unknownCols[table] || [])) {
                    if (arr.some((r) => c in r)) {
                        return Promise.resolve({ error: { code: 'PGRST204', message: `Could not find the '${c}' column of '${table}' in the schema cache` } });
                    }
                }
                const fr = h.failRow;
                if (fr && table === fr.table && arr.some((r) => r[fr.col] === fr.value)) {
                    return Promise.resolve({ error: { code: '23503', message: `insert or update on table "${table}" violates foreign key constraint "${table}_fk"` } });
                }
                return Promise.resolve({ error: null });
            },
            update: (patch: any) => { pendingPatch = patch; return { eq: (_c: string, v: unknown) => { h.updates.push({ table, patch: pendingPatch, id: v }); return Promise.resolve({ error: null }); } }; },
            delete: () => ({ neq: () => Promise.resolve({ error: null }), eq: () => Promise.resolve({ error: null }), in: (col: string, vals: unknown[]) => { h.deletes.push({ table, col, vals }); return Promise.resolve({ error: null }); } }),
            eq: () => Promise.resolve({ data: [], error: null }),
            order: () => b, // the importer orders every paged read; .range() without it is undefined across pages
            range: () => Promise.resolve({ data: [], error: null }), // empty catalog index
            then: (r: any) => Promise.resolve({ count: 0, error: null, data: [] }).then(r),
        };
        return b;
    };
    return { supabase: { from: (t: string) => make(t), rpc: () => Promise.resolve({ error: null }) }, handleSupabaseError: () => {} };
});

import { importOrgData, type ImportProgressEvent } from '../lib/db/importer';

beforeEach(() => { h.inserts = []; h.updates = []; h.deletes = []; h.unknownCols = {}; h.failRow = null; });

describe('importer cross-table FK + schema-divergence resilience', () => {
    it('defers units.leader_id (→ users) on insert and restores it after users import', async () => {
        const ndjson = [
            '{"kind":"header","version":1,"tableOrder":["units","users"],"manifest":{"units":1,"users":1}}',
            '{"kind":"row","t":"units","r":{"id":7,"name":"HQ","parent_unit_id":null,"leader_id":5}}',
            '{"kind":"row","t":"users","r":{"id":5,"name":"Boss","discord_id":"d5"}}',
        ].join('\n');
        await importOrgData(ndjson);
        // units inserted with leader_id NULLed (the forward FK deferred).
        const unitsInsert = h.inserts.find((i) => i.table === 'units');
        expect(unitsInsert).toBeTruthy();
        expect(unitsInsert!.rows[0].leader_id).toBeNull();
        // leader_id restored after the import, pointing at the now-imported user.
        const restore = h.updates.find((u) => u.table === 'units' && u.id === 7);
        expect(restore).toBeTruthy();
        expect(restore!.patch.leader_id).toBe(5);
    });

    it('strips a column the export has but this instance lacks, then succeeds with a warning', async () => {
        h.unknownCols = { users: ['last_active_at'] };
        const ndjson = [
            '{"kind":"header","version":1,"tableOrder":["users"],"manifest":{"users":1}}',
            '{"kind":"row","t":"users","r":{"id":1,"name":"A","discord_id":"d1","last_active_at":"2026-01-01"}}',
        ].join('\n');
        const events: ImportProgressEvent[] = [];
        const result = await importOrgData(ndjson, (e) => { events.push(e); });
        // The final (retried) users insert no longer carries the dropped column.
        const lastUsersInsert = [...h.inserts].reverse().find((i) => i.table === 'users');
        expect(lastUsersInsert!.rows[0]).not.toHaveProperty('last_active_at');
        // A warning surfaced the drop, and the import still completed.
        expect(result.warnings.some((w) => w.includes('last_active_at'))).toBe(true);
        expect(events[events.length - 1].type).toBe('done');
    });

    it('drops role_permissions grants whose permission is not in this instance (NOT NULL FK), not inserting NULL', async () => {
        // Empty permissions catalog in the mock → every grant is unresolved.
        const ndjson = [
            '{"kind":"header","version":1,"tableOrder":["role_permissions"],"manifest":{"role_permissions":2}}',
            '{"kind":"row","t":"role_permissions","r":{"role_id":4,"permission_id":99,"permissions":{"name":"platform:billing"}}}',
            '{"kind":"row","t":"role_permissions","r":{"role_id":4,"permission_id":7,"permissions":{"name":"intel:view"}}}',
        ].join('\n');
        const result = await importOrgData(ndjson);
        const insertedRows = h.inserts.filter((i) => i.table === 'role_permissions').flatMap((i) => i.rows);
        expect(insertedRows).toHaveLength(0);       // dropped, NOT inserted with a null permission_id
        expect(result.rowsSkipped).toBe(2);
        expect(result.warnings.some((w) => w.includes('platform:billing'))).toBe(true);
    });

    it('skips a single FK-orphan row via row-by-row fallback instead of failing the whole batch', async () => {
        // e.g. a fleet_group_ships row pointing at a user_ship that was dropped (unsynced catalog).
        h.failRow = { table: 'fleet_group_ships', col: 'user_ship_id', value: 999 };
        const ndjson = [
            '{"kind":"header","version":1,"tableOrder":["fleet_group_ships"],"manifest":{"fleet_group_ships":2}}',
            '{"kind":"row","t":"fleet_group_ships","r":{"id":1,"fleet_group_id":1,"user_ship_id":5}}',
            '{"kind":"row","t":"fleet_group_ships","r":{"id":2,"fleet_group_id":1,"user_ship_id":999}}',
        ].join('\n');
        const result = await importOrgData(ndjson);
        expect(result.rowsInserted).toBe(1); // the valid row
        expect(result.rowsSkipped).toBe(1);  // the orphan, skipped not fatal
    });

    it('never imports deployment/integration/secret settings; portable settings still import', async () => {
        const ndjson = [
            '{"kind":"header","version":1,"tableOrder":["settings"],"manifest":{"settings":7}}',
            '{"kind":"row","t":"settings","r":{"key":"brandingConfig","value":{"name":"Acme Org"}}}',
            '{"kind":"row","t":"settings","r":{"key":"discordConfig","value":{"clientId":"1495641123316568144"}}}',
            '{"kind":"row","t":"settings","r":{"key":"radioConfig","value":{"url":"wss://x.livekit.cloud"}}}',
            '{"kind":"row","t":"settings","r":{"key":"aiConfig","value":{"apiKey":"AIzaLEAKED"}}}',
            '{"kind":"row","t":"settings","r":{"key":"geminiKey","value":"AIzaSEPARATEROW"}}',
            '{"kind":"row","t":"settings","r":{"key":"admin_setup_code","value":{"code":"SETUP-PWN"}}}',
            '{"kind":"row","t":"settings","r":{"key":"setup_completed","value":true}}',
        ].join('\n');
        const result = await importOrgData(ndjson);

        const insertedSettings = h.inserts.filter((i) => i.table === 'settings').flatMap((i) => i.rows);
        const insertedKeys = insertedSettings.map((r) => r.key);
        expect(insertedKeys).toContain('brandingConfig');             // portable org data imports
        for (const denied of ['discordConfig', 'radioConfig', 'aiConfig', 'geminiKey', 'admin_setup_code', 'setup_completed']) {
            expect(insertedKeys).not.toContain(denied);               // deployment identity / secrets / bootstrap excluded
        }
        // No source secret/identity reaches the DB.
        const blob = JSON.stringify(insertedSettings);
        for (const secret of ['1495641123316568144', 'AIzaLEAKED', 'AIzaSEPARATEROW', 'SETUP-PWN']) {
            expect(blob).not.toContain(secret);
        }

        // Pre-clear must NOT delete the local deployment-config keys (so locally-set
        // discordConfig / admin_setup_code survive the import untouched).
        const settingsPreclear = h.deletes.find((d) => d.table === 'settings' && d.col === 'key');
        expect(settingsPreclear).toBeTruthy();
        expect(settingsPreclear!.vals).toContain('brandingConfig');
        for (const denied of ['discordConfig', 'geminiKey', 'admin_setup_code', 'setup_completed']) {
            expect(settingsPreclear!.vals).not.toContain(denied);
        }

        expect(result.warnings.some((w) => w.includes('deployment-config'))).toBe(true);
    });

    it('never imports alliance_peers (deployment-local federation crypto), avoiding credential bleed + dangling api_keys FKs', async () => {
        const ndjson = [
            '{"kind":"header","version":1,"tableOrder":["alliance_peers"],"manifest":{"alliance_peers":1}}',
            '{"kind":"row","t":"alliance_peers","r":{"id":"p1","label":"Ally","outbound_key_enc":"ENCKEYBLEED","inbound_key_id":"00000000-0000-0000-0000-000000000000","entered_peer_code_enc":"CODEBLEED","pairing_state":"active"}}',
        ].join('\n');
        const result = await importOrgData(ndjson);
        expect(h.inserts.find((i) => i.table === 'alliance_peers')).toBeUndefined();   // not imported at all
        expect(JSON.stringify(h.inserts)).not.toContain('ENCKEYBLEED');
        expect(JSON.stringify(h.inserts)).not.toContain('CODEBLEED');
        expect(result.rowsSkipped).toBe(1);
        expect(result.warnings.some((w) => /federation/i.test(w))).toBe(true);
    });

    it('nulls users.rsi_verification_code (transient per-install token) on import', async () => {
        const ndjson = [
            '{"kind":"header","version":1,"tableOrder":["users"],"manifest":{"users":1}}',
            '{"kind":"row","t":"users","r":{"id":1,"name":"A","discord_id":"d1","rsi_verification_code":"RSI-STALE-123","auth_user_id":"auth-x"}}',
        ].join('\n');
        await importOrgData(ndjson);
        const ins = h.inserts.find((i) => i.table === 'users');
        expect(ins!.rows[0].rsi_verification_code).toBeNull();
        expect(ins!.rows[0].auth_user_id).toBeNull();
    });

    it('nulls intel_reports.source_feed_id so federated intel imports without the (dead) feed link', async () => {
        const ndjson = [
            '{"kind":"header","version":1,"tableOrder":["intel_reports"],"manifest":{"intel_reports":1}}',
            '{"kind":"row","t":"intel_reports","r":{"id":1,"title":"Shared","source_feed_id":"old-saas-feed-uuid","external_id":"e1"}}',
        ].join('\n');
        await importOrgData(ndjson);
        const ins = h.inserts.find((i) => i.table === 'intel_reports');
        expect(ins).toBeTruthy();
        expect(ins!.rows[0].source_feed_id).toBeNull(); // dropped link, report still imports
    });
});

describe('importer secret / operational-key hardening (s8-a / importer-3)', () => {
    it('drops secret/transient columns from any imported row (SECRET_DROP_COLUMNS)', async () => {
        const ndjson = [
            '{"kind":"header","version":1,"tableOrder":["users"],"manifest":{"users":1}}',
            '{"kind":"row","t":"users","r":{"id":1,"name":"A","discord_id":"d1","rsi_handle_pending":"PendingName","rsi_verification_code":"VERIFY-9","key_hash":"kh","password_hash":"ph","webhook_secret":"ws"}}',
        ].join('\n');
        await importOrgData(ndjson);
        const ins = h.inserts.find((i) => i.table === 'users');
        expect(ins).toBeTruthy();
        const row = ins!.rows[0];
        // SECRET_DROP_COLUMNS are deleted entirely…
        for (const c of ['rsi_handle_pending', 'key_hash', 'password_hash', 'webhook_secret']) {
            expect(row[c], `${c} must not be imported`).toBeUndefined();
        }
        // …and the users handler additionally nulls rsi_verification_code (belt-and-braces).
        expect(row.rsi_verification_code ?? null).toBeNull();
    });

    it('does NOT import operational/runtime settings keys (platformSettings / orgFeatures)', async () => {
        const ndjson = [
            '{"kind":"header","version":1,"tableOrder":["settings"],"manifest":{"settings":2}}',
            '{"kind":"row","t":"settings","r":{"key":"platformSettings","value":{"maintenance_mode":true}}}',
            '{"kind":"row","t":"settings","r":{"key":"orgFeatures","value":{"warehouse":false}}}',
        ].join('\n');
        await importOrgData(ndjson);
        const settingsInserts = h.inserts.filter((i) => i.table === 'settings').flatMap((i) => i.rows);
        expect(settingsInserts.some((r) => r.key === 'platformSettings')).toBe(false);
        expect(settingsInserts.some((r) => r.key === 'orgFeatures')).toBe(false);
    });
});
