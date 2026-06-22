import { describe, it, expect, vi, beforeEach } from 'vitest';

// withCronLease defaults to fail-open (run unguarded if the lease check errors) for
// local jobs, but { failClosed: true } skips the tick instead — used by alliance_sync
// so a DB hiccup can't make every instance hit allies' rate limits at once.

const h = vi.hoisted(() => ({
    rpc: vi.fn(),
}));

vi.mock('../lib/db/common', () => ({
    supabase: { rpc: (...args: unknown[]) => h.rpc(...args) },
}));

import { withCronLease } from '../lib/cronLock';

beforeEach(() => { h.rpc.mockReset(); });

describe('withCronLease fail-open vs fail-closed', () => {
    it('fail-open (default): runs the job unguarded when the lease RPC errors', async () => {
        h.rpc.mockResolvedValue({ data: null, error: new Error('db down') });
        const fn = vi.fn(async () => undefined);
        await withCronLease('duty_cleanup', 50, fn);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('fail-closed: SKIPS the job when the lease RPC errors', async () => {
        h.rpc.mockResolvedValue({ data: null, error: new Error('db down') });
        const fn = vi.fn(async () => undefined);
        await withCronLease('alliance_sync', 50, fn, { failClosed: true });
        expect(fn).not.toHaveBeenCalled();
    });

    it('runs the job when the lease is acquired (data === true), then releases', async () => {
        h.rpc.mockImplementation(async (name: string) => name === 'try_acquire_cron_lock' ? { data: true, error: null } : { data: null, error: null });
        const fn = vi.fn(async () => undefined);
        await withCronLease('alliance_sync', 50, fn, { failClosed: true });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(h.rpc).toHaveBeenCalledWith('release_cron_lock', expect.anything());
    });

    it('skips the job when another worker holds the lease (data === false)', async () => {
        h.rpc.mockResolvedValue({ data: false, error: null });
        const fn = vi.fn(async () => undefined);
        await withCronLease('alliance_sync', 50, fn, { failClosed: true });
        expect(fn).not.toHaveBeenCalled();
    });
});
