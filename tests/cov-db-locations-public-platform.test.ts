import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/platform.ts — the org-wide operational levers (maintenance mode + the
// force-logout watermark). Both are enforced on every authenticated call, so the
// behaviour pinned here is security-relevant:
//   - a read failure must never silently disarm force-logout (last-known-good fallback);
//   - the read-merge-write must refuse to write when its read fails (otherwise the
//     merge resets every key outside the patch, including force_logout_timestamp);
//   - a successful write invalidates the memo, refreshes the fallback, and emits an
//     ids-only broadcast (Security rule 4: no settings content on the wire).
// `lastKnownGood` is module state, so every test loads a fresh copy of the module.

const h = vi.hoisted(() => {
    type Call = { m: string; a: unknown[] };
    type Q = { table: string; calls: Call[] };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
    const state = {
        queries: [] as Q[],
        readResult: { data: null, error: null } as { data: unknown; error: unknown },
        readThrows: null as Error | null,
        upsertResult: { error: null } as { error: unknown },
        broadcasts: [] as Array<{ event: string; payload: unknown }>,
    };
    function from(table: string) {
        const q: Q = { table, calls: [] };
        state.queries.push(q);
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'upsert']) {
            b[m] = (...a: unknown[]) => { q.calls.push({ m, a }); return b; };
        }
        b.maybeSingle = () => {
            q.calls.push({ m: 'maybeSingle', a: [] });
            if (state.readThrows) return Promise.reject(state.readThrows);
            return Promise.resolve(state.readResult);
        };
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(state.upsertResult).then(res, rej);
        return b;
    }
    return { state, logger, from };
});

vi.mock('../lib/db/common', () => ({
    supabase: { from: h.from },
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
        if (error) throw new Error(message);
    },
    broadcastToOrg: (event: string, payload: unknown) => { h.state.broadcasts.push({ event, payload }); return Promise.resolve(); },
}));
vi.mock('../lib/log', () => ({ log: h.logger }));

type PlatformMod = typeof import('../lib/db/platform');
type CacheMod = typeof import('../lib/cache');
let mod: PlatformMod;
let cacheMod: CacheMod;

const STORED = {
    maintenance_mode: true,
    maintenance_message: 'Back soon',
    force_logout_timestamp: '2026-10-01T00:00:00.000Z',
    custom_flag: 'kept',
};

beforeEach(async () => {
    vi.resetModules();
    mod = await import('../lib/db/platform');
    cacheMod = await import('../lib/cache');
    cacheMod.cache.invalidate('platform_settings');
    h.state.queries = [];
    h.state.readResult = { data: null, error: null };
    h.state.readThrows = null;
    h.state.upsertResult = { error: null };
    h.state.broadcasts = [];
    h.logger.error.mockClear();
});

const upserts = () => h.state.queries.filter((q) => q.calls.some((c) => c.m === 'upsert'));

// ---------------------------------------------------------------------------
describe('getPlatformSettings', () => {
    it('reads only the value column of the platformSettings key and merges over the defaults', async () => {
        h.state.readResult = { data: { value: STORED }, error: null };
        const s = await mod.getPlatformSettings();
        expect(h.state.queries).toEqual([{
            table: 'settings',
            calls: [
                { m: 'select', a: ['value'] },
                { m: 'eq', a: ['key', 'platformSettings'] },
                { m: 'maybeSingle', a: [] },
            ],
        }]);
        expect(s).toEqual({ support_discord_url: '', ...STORED });
    });

    it('a missing row yields exactly the defaults (maintenance off, no force-logout)', async () => {
        const s = await mod.getPlatformSettings();
        expect(s).toEqual({ maintenance_mode: false, maintenance_message: '', support_discord_url: '' });
        expect(s.force_logout_timestamp).toBeUndefined();
    });

    it('serves the second read from the memo without touching the database', async () => {
        h.state.readResult = { data: { value: STORED }, error: null };
        const a = await mod.getPlatformSettings();
        const b = await mod.getPlatformSettings();
        expect(b).toBe(a);
        expect(h.state.queries).toHaveLength(1);
    });

    it('a read error with no prior good read falls back to the defaults and logs', async () => {
        h.state.readResult = { data: null, error: { message: 'db down' } };
        const s = await mod.getPlatformSettings();
        expect(s).toEqual({ maintenance_mode: false, maintenance_message: '', support_discord_url: '' });
        expect(h.logger.error).toHaveBeenCalledWith('fetch platform settings failed', { err: { message: 'db down' } });
        // The failure is NOT memoised — the next call retries the database.
        h.state.readResult = { data: { value: STORED }, error: null };
        expect((await mod.getPlatformSettings()).force_logout_timestamp).toBe(STORED.force_logout_timestamp);
    });

    it('a rejected read after a good one keeps the force-logout watermark alive', async () => {
        h.state.readResult = { data: { value: STORED }, error: null };
        await mod.getPlatformSettings();
        cacheMod.cache.invalidate('platform_settings');
        h.state.readThrows = new Error('socket hang up');
        const s = await mod.getPlatformSettings();
        expect(s.force_logout_timestamp).toBe(STORED.force_logout_timestamp);
        expect(s.maintenance_mode).toBe(true);
        expect(h.logger.error).toHaveBeenCalledWith('fetch platform settings failed', { err: h.state.readThrows });
    });
});

// ---------------------------------------------------------------------------
describe('updatePlatformSettings', () => {
    it('merges patch over stored over defaults, upserts on key, invalidates the memo and broadcasts ids-only', async () => {
        h.state.readResult = { data: { value: STORED }, error: null };
        // Prime the memo so the invalidation is observable.
        await mod.getPlatformSettings();
        h.state.queries = [];

        const next = await mod.updatePlatformSettings({ maintenance_mode: false });

        const expected = {
            maintenance_mode: false,
            maintenance_message: 'Back soon',
            support_discord_url: '',
            force_logout_timestamp: STORED.force_logout_timestamp, // NOT dropped by the merge
            custom_flag: 'kept',
        };
        expect(next).toEqual(expected);
        expect(h.state.queries[0].calls).toEqual([
            { m: 'select', a: ['value'] },
            { m: 'eq', a: ['key', 'platformSettings'] },
            { m: 'maybeSingle', a: [] },
        ]);
        expect(upserts()).toHaveLength(1);
        expect(upserts()[0]).toEqual({
            table: 'settings',
            calls: [{ m: 'upsert', a: [{ key: 'platformSettings', value: expected }, { onConflict: 'key' }] }],
        });
        expect(cacheMod.cache.get('platform_settings')).toBeUndefined();
        expect(h.state.broadcasts).toEqual([{ event: 'settings_update', payload: {} }]);
    });

    it('with no stored row, the write is defaults + patch', async () => {
        const next = await mod.updatePlatformSettings({ force_logout_timestamp: '2026-11-02T00:00:00.000Z' });
        expect(next).toEqual({
            maintenance_mode: false, maintenance_message: '', support_discord_url: '',
            force_logout_timestamp: '2026-11-02T00:00:00.000Z',
        });
    });

    it('FAILS CLOSED on a read error: throws, writes nothing, broadcasts nothing', async () => {
        h.state.readResult = { data: null, error: { message: 'timeout' } };
        await expect(mod.updatePlatformSettings({ maintenance_mode: true }))
            .rejects.toThrow('Failed to read platform settings — no change was made');
        expect(upserts()).toEqual([]);
        expect(h.state.broadcasts).toEqual([]);
    });

    it('an upsert error throws, keeps the memo, and broadcasts nothing', async () => {
        h.state.readResult = { data: { value: STORED }, error: null };
        const before = await mod.getPlatformSettings();
        h.state.upsertResult = { error: { message: 'constraint' } };
        await expect(mod.updatePlatformSettings({ maintenance_mode: false }))
            .rejects.toThrow('Failed to update platform settings');
        expect(cacheMod.cache.get('platform_settings')).toBe(before);
        expect(h.state.broadcasts).toEqual([]);
    });

    it('a successful write becomes the last-known-good fallback for a later failed read', async () => {
        h.state.readResult = { data: { value: {} }, error: null };
        await mod.updatePlatformSettings({ force_logout_timestamp: '2026-11-02T12:00:00.000Z', maintenance_mode: true });
        // The memo was invalidated; the next read fails outright.
        h.state.readThrows = new Error('db gone');
        const s = await mod.getPlatformSettings();
        expect(s.force_logout_timestamp).toBe('2026-11-02T12:00:00.000Z');
        expect(s.maintenance_mode).toBe(true);
    });
});
