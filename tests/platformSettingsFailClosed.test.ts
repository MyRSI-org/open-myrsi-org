import { describe, it, expect, vi, beforeEach } from 'vitest';

// A transient DB error in getPlatformSettings must not silently drop the
// force_logout_timestamp (which would turn force-logout off during the outage). It
// returns the last good settings instead of bare defaults.

const h = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'throw' }));

vi.mock('../lib/db/common', () => ({
    supabase: {
        from: () => ({
            select: () => ({
                eq: () => ({
                    maybeSingle: async () => h.mode === 'throw'
                        ? { data: null, error: { message: 'db down' } }
                        : { data: { value: { force_logout_timestamp: '2026-06-21T00:00:00.000Z', maintenance_mode: true, maintenance_message: 'soon' } }, error: null },
                }),
            }),
        }),
    },
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
    broadcastToOrg: () => {},
}));

import { getPlatformSettings } from '../lib/db/platform';
import { cache } from '../lib/cache';

beforeEach(() => { h.mode = 'ok'; cache.invalidate('platform_settings'); });

describe('getPlatformSettings fail-closed fallback', () => {
    it('preserves force_logout_timestamp + maintenance on a transient DB error after a prior successful read', async () => {
        const first = await getPlatformSettings();
        expect(first.force_logout_timestamp).toBe('2026-06-21T00:00:00.000Z');
        expect(first.maintenance_mode).toBe(true);

        // Cache expires, then the DB blips on the next read.
        cache.invalidate('platform_settings');
        h.mode = 'throw';
        const second = await getPlatformSettings();
        // NOT reverted to bare defaults — the security-relevant lever survives.
        expect(second.force_logout_timestamp).toBe('2026-06-21T00:00:00.000Z');
        expect(second.maintenance_mode).toBe(true);
    });
});
