import { describe, it, expect, beforeEach, vi } from 'vitest';

// The role-defaults backfill marker (lib/db/roleDefaults.ts
// ROLE_DEFAULT_BACKFILL_MARKER_KEY = 'role_permission_backfills') is a `settings` ROW
// recording which one-shot role-grant passes THIS install has already run. Two things
// follow from it living in the settings table:
//
//   1. getAllSettings reduces EVERY settings row into one blob, and that blob is the
//      browser-bound `main` / `initial-state` payload — so without an explicit delete
//      in stripSecrets the marker ships to every authenticated member. It is repair
//      bookkeeping with no client consumer (same story as intelSharingConfig).
//   2. The org importer replaces settings wholesale from an export. An imported
//      marker would falsely satisfy THIS install's bookkeeping: the next Repair sees
//      the one-shot already applied, declines it, and the roles keep whatever grants
//      the source install happened to have.
//
// Both halves are pinned here because "a settings key nobody thought about" is
// exactly the shape of the leaks stripSecrets and the denylist exist to prevent.

const h = vi.hoisted(() => ({
    inserts: [] as { table: string; rows: Record<string, unknown>[] }[],
    deletes: [] as { table: string; method: string; arg: unknown }[],
}));

vi.mock('../lib/db/common', () => {
    const make = (table: string) => {
        const b: Record<string, unknown> = {
            select: () => b,
            insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
                h.inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
                return Promise.resolve({ error: null });
            },
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
            delete: () => ({
                neq: (c: string) => { h.deletes.push({ table, method: 'neq', arg: c }); return Promise.resolve({ error: null }); },
                eq: (_c: string, v: unknown) => { h.deletes.push({ table, method: 'eq', arg: v }); return Promise.resolve({ error: null }); },
                in: (_c: string, v: unknown) => { h.deletes.push({ table, method: 'in', arg: v }); return Promise.resolve({ error: null }); },
            }),
            eq: () => Promise.resolve({ data: [], error: null }),
            in: () => b,
            range: () => Promise.resolve({ data: [], error: null }),
            then: (r: (v: unknown) => unknown) => Promise.resolve({ count: 0, error: null, data: [] }).then(r),
        };
        return b;
    };
    return { supabase: { from: (t: string) => make(t), rpc: () => Promise.resolve({ error: null }) }, handleSupabaseError: () => {} };
});

import { importOrgData } from '../lib/db/importer';
import { ROLE_DEFAULT_BACKFILL_MARKER_KEY } from '../lib/db/roleDefaults';
import { stripSecrets } from '../api/query';

beforeEach(() => {
    h.inserts = [];
    h.deletes = [];
});

const ndjson = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');

describe('the importer never imports the role-defaults backfill marker', () => {
    it('drops the marker row as deployment config and leaves the local one untouched', async () => {
        const result = await importOrgData(ndjson([
            { kind: 'header', version: 1, sourceOrg: { name: 'Acme' }, tableOrder: ['settings'], manifest: { settings: 2 } },
            { kind: 'row', t: 'settings', r: { key: ROLE_DEFAULT_BACKFILL_MARKER_KEY, value: { applied: ['optional-module-defaults@1'] } } },
            { kind: 'row', t: 'settings', r: { key: 'brandingConfig', value: { name: 'Acme' } } },
        ]));

        // Counted as a deployment-settings skip, not silently swallowed.
        expect(result.skipBreakdown.deploymentSettings).toBe(1);

        // Never inserted…
        const settingsRows = h.inserts.filter((i) => i.table === 'settings').flatMap((i) => i.rows);
        expect(settingsRows.map((r) => r.key)).not.toContain(ROLE_DEFAULT_BACKFILL_MARKER_KEY);

        // …and never pre-CLEARED either: the local marker has to survive the import, or
        // a one-shot the operator already passed would re-arm and re-grant.
        const settingsDeletes = h.deletes.filter((d) => d.table === 'settings');
        expect(settingsDeletes).toHaveLength(1);
        expect(settingsDeletes[0].arg).toEqual(['brandingConfig']);
    });

    it('the key on the denylist is the one lib/db/roleDefaults actually writes', () => {
        // Guards the string-literal coupling between the denylist and the module that
        // owns the marker — a rename on either side must break here, not in prod.
        expect(ROLE_DEFAULT_BACKFILL_MARKER_KEY).toBe('role_permission_backfills');
    });
});

describe('stripSecrets drops the backfill marker from the browser-bound blob', () => {
    it('deletes role_permission_backfills and keeps benign settings', () => {
        const out = stripSecrets({
            [ROLE_DEFAULT_BACKFILL_MARKER_KEY]: { applied: ['optional-module-defaults@1'] },
            dutyTimeoutMinutes: 30,
        });
        expect(out[ROLE_DEFAULT_BACKFILL_MARKER_KEY]).toBeUndefined();
        expect(out.dutyTimeoutMinutes).toBe(30);
    });

    // The generic backstop below the per-key deletes matches KEY NAMES
    // (_api_key|_secret|_password|_webhook|_token) and drops only string/number
    // values — 'role_permission_backfills' matches none of it and the value is an
    // object, so nothing but the explicit delete removes this one.
    it('the secret-name backstop does not cover it — the explicit delete is load-bearing', () => {
        expect(/(_api_key|_secret|_password|_webhook|_token)/i.test(ROLE_DEFAULT_BACKFILL_MARKER_KEY)).toBe(false);
    });
});
