import { describe, it, expect, vi, beforeEach } from 'vitest';

// READ-MERGE-WRITE MUST FAIL CLOSED.
//
// updatePlatformSettings and updateOrgFeatures both re-read the stored JSONB blob, merge
// the caller's patch over it, and write the result back. The merge is the ONLY thing
// preserving the keys the caller did not name — so if the read faults and the code treats
// the empty result as "there was nothing there", the write does not fail. It SUCCEEDS, and
// silently deletes every setting outside the patch.
//
// Both used to discard the read error (`const { data } = await ...`, no `error` binding).
// The consequences were not symmetric bookkeeping bugs:
//
//   platform settings — the blob holds `maintenance_mode` AND `force_logout_timestamp`,
//     the product's only two emergency levers. An admin flipping maintenance mode during a
//     DB hiccup would write a row with maintenance set and force_logout GONE, silently
//     revoking a force-logout at the exact moment someone was using it on an incident.
//
//   org features — modules are default-OFF (`!!enabled`), so losing a module's key reads
//     as "switched off". One toggle during a blip could take warehouse, quartermaster,
//     finances and academy offline org-wide, behind a success toast.
//
// These tests assert the REFUSAL, not merely the throw: `h.upserts` must stay EMPTY. A fix
// that logged the error and wrote anyway would still throw somewhere and still destroy the
// data, so "it threw" is not the property worth pinning.

const h = vi.hoisted(() => ({
    rows: {} as Record<string, unknown>,
    readError: null as { message: string; code?: string } | null,
    writeError: null as { message: string } | null,
    upserts: [] as Array<{ key: string; value: unknown }>,
}));

function makeBuilder() {
    let key = '';
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string, val: string) => { if (col === 'key') key = val; return b; };
    b.order = () => b;
    b.limit = () => b;
    b.maybeSingle = async () => (h.readError
        ? { data: null, error: h.readError }
        : { data: key in h.rows ? { value: h.rows[key] } : null, error: null });
    b.upsert = async (row: { key: string; value: unknown }) => {
        if (h.writeError) return { data: null, error: h.writeError };
        h.upserts.push({ key: row.key, value: row.value });
        h.rows[row.key] = row.value;
        return { data: null, error: null };
    };
    return b;
}

vi.mock('../lib/db/common.js', () => ({
    supabase: { from: () => makeBuilder() },
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
        if (error) throw new Error(message);
    },
    safeFetch: async (query: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
        const { data, error } = await query; return error ? fallback : (data ?? fallback);
    },
    broadcastToOrg: () => Promise.resolve(),
    broadcastToChannel: () => Promise.resolve(),
    getSystemRoles: async () => ({}),
}));

// Deterministic: no TTL cache sitting in front of the reads under test.
vi.mock('../lib/cache.js', () => ({
    cache: { get: () => null, set: () => undefined, invalidate: () => undefined },
    TTL: { PLATFORM_SETTINGS: 1000 },
}));

import { updatePlatformSettings } from '../lib/db/platform';
import { updateOrgFeatures, getOrgFeatures, isFeatureEnabled } from '../lib/db/system';

beforeEach(() => { h.rows = {}; h.readError = null; h.writeError = null; h.upserts = []; });

describe('updatePlatformSettings — refuses to merge over a failed read', () => {
    it('a healthy read merges: patching one key preserves the others', async () => {
        h.rows.platformSettings = {
            maintenance_mode: false,
            force_logout_timestamp: '2026-09-06T10:00:00.000Z',
            support_discord_url: 'https://discord.gg/example',
        };
        const next = await updatePlatformSettings({ maintenance_mode: true });
        expect(next.maintenance_mode).toBe(true);
        expect(next.force_logout_timestamp).toBe('2026-09-06T10:00:00.000Z');
        expect(next.support_discord_url).toBe('https://discord.gg/example');
    });

    it('THE REGRESSION: a read fault during a maintenance toggle does not write at all', async () => {
        // Force-logout is armed, then the settings read faults mid-incident.
        h.rows.platformSettings = {
            maintenance_mode: false,
            force_logout_timestamp: '2026-09-06T10:00:00.000Z',
        };
        h.readError = { message: 'connection reset', code: '08006' };

        await expect(updatePlatformSettings({ maintenance_mode: true })).rejects.toThrow(/read platform settings/i);

        // The REFUSAL is the property under test — not that it threw.
        expect(h.upserts).toEqual([]);
        // And the armed force-logout is still exactly where it was.
        expect(h.rows.platformSettings).toEqual({
            maintenance_mode: false,
            force_logout_timestamp: '2026-09-06T10:00:00.000Z',
        });
    });

    it('refuses even when arming force-logout itself, so no half-armed state can exist', async () => {
        h.rows.platformSettings = { maintenance_mode: true, maintenance_message: 'back soon' };
        h.readError = { message: 'statement timeout', code: '57014' };
        await expect(
            updatePlatformSettings({ force_logout_timestamp: '2026-09-06T12:00:00.000Z' }),
        ).rejects.toThrow();
        expect(h.upserts).toEqual([]);
        expect(h.rows.platformSettings).toEqual({ maintenance_mode: true, maintenance_message: 'back soon' });
    });

    it('a write-side error still surfaces (that binding was never the broken half)', async () => {
        h.rows.platformSettings = { maintenance_mode: false };
        h.writeError = { message: 'disk full' };
        await expect(updatePlatformSettings({ maintenance_mode: true })).rejects.toThrow(/update platform settings/i);
    });
});

describe('updateOrgFeatures — refuses to merge over a failed read', () => {
    it('a healthy read merges: toggling one module preserves its siblings', async () => {
        h.rows.orgFeatures = {
            warehouse: { enabled: true },
            quartermaster: { enabled: true },
            finances: { enabled: true },
        };
        const next = await updateOrgFeatures({ academy: { enabled: true } });
        expect(next.warehouse).toEqual({ enabled: true });
        expect(next.quartermaster).toEqual({ enabled: true });
        expect(next.finances).toEqual({ enabled: true });
        expect(next.academy).toEqual({ enabled: true });
    });

    it('THE REGRESSION: a read fault does not silently switch every other module off', async () => {
        h.rows.orgFeatures = {
            warehouse: { enabled: true },
            quartermaster: { enabled: true },
            finances: { enabled: true },
            academy: { enabled: true },
        };
        h.readError = { message: 'connection reset', code: '08006' };

        await expect(updateOrgFeatures({ marketplace: { enabled: true } })).rejects.toThrow(/read optional features/i);

        expect(h.upserts).toEqual([]);
        expect(h.rows.orgFeatures).toEqual({
            warehouse: { enabled: true },
            quartermaster: { enabled: true },
            finances: { enabled: true },
            academy: { enabled: true },
        });
    });

    it('the one-level deep merge still preserves nested per-module settings', async () => {
        h.rows.orgFeatures = { warehouse: { enabled: true, defaultLocationId: 7 } };
        const next = await updateOrgFeatures({ warehouse: { enabled: false } });
        expect(next.warehouse).toEqual({ enabled: false, defaultLocationId: 7 });
    });
});

describe('getOrgFeatures — loud on a read fault, still fail-closed at the gate', () => {
    it('returns an empty blob when the row is simply absent (not an error)', async () => {
        await expect(getOrgFeatures()).resolves.toEqual({});
    });

    it('THROWS on a returned read error rather than reporting "no modules enabled" as fact', async () => {
        h.readError = { message: 'connection reset' };
        await expect(getOrgFeatures()).rejects.toThrow(/read optional features/i);
    });

    it('isFeatureEnabled still resolves false on that throw — now via its documented catch, not by accident', async () => {
        h.rows.orgFeatures = { marketplace: { enabled: true } };
        h.readError = { message: 'connection reset' };
        expect(await isFeatureEnabled('marketplace')).toBe(false);
    });
});
