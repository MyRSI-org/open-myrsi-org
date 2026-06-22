// Table-based cron lease. Makes the in-process node-cron
// jobs in server.ts safe under multi-instance deploys: only the worker that
// holds an unexpired lease runs a given job on a given tick. pg_advisory_lock is
// unusable over PostgREST (each rpc() is a fresh connection, so the lock would
// release immediately), so this uses a lease row + expiry — see
// migrations/add-cron-locks.sql — mirroring the processed_stripe_events pattern.
//
// FAIL-OPEN (default): if the lease RPC itself errors (e.g. the migration hasn't
// been applied yet, or a transient DB blip), the job RUNS anyway, so the guard can
// never make a job worse than a single instance running everything unconditionally,
// and the code can deploy before the migration lands.
//
// FAIL-CLOSED (opt in with { failClosed: true }): for jobs that call out to other
// peers (alliance_sync), a lease error should skip the tick instead. Several
// instances running at once during a DB hiccup could together exceed an ally's
// rate limit, and skipping one tick is harmless — the next one retries.

import os from 'os';
import { supabase } from './db/common.js';
import { log as baseLog } from './log.js';

const log = baseLog.child({ module: 'cronLock' });

const WORKER_ID = `${os.hostname()}:${process.pid}`;

/**
 * Run `fn` only if this worker can acquire the lease for `jobName`, held for
 * `holdSeconds` (set this a little under the job's interval so a crashed holder
 * can't lock the job out for long). Releases the lease when `fn` settles.
 */
export async function withCronLease(jobName: string, holdSeconds: number, fn: () => Promise<void>, opts?: { failClosed?: boolean }): Promise<void> {
    let acquired = false;
    try {
        const { data, error } = await supabase.rpc('try_acquire_cron_lock', {
            p_job_name: jobName,
            p_worker_id: WORKER_ID,
            p_hold_seconds: holdSeconds,
        });
        if (error) throw error;
        acquired = data === true;
    } catch (e) {
        if (opts?.failClosed) {
            // Job that calls out to other peers (e.g. alliance_sync): skip this tick
            // rather than risk every instance hitting an ally's rate limit. Safe to miss.
            log.warn('cron lease check failed, SKIPPING tick (fail-closed)', { jobName, err: e });
            return;
        }
        // Fail-open: never silently skip an idempotent local job because the lock
        // layer is unavailable. Run unguarded.
        log.warn('cron lease check failed, running unguarded (fail-open)', { jobName, err: e });
        await fn();
        return;
    }

    if (!acquired) {
        log.info('cron lease held by another worker, skipping', { jobName, workerId: WORKER_ID });
        return;
    }

    try {
        await fn();
    } finally {
        try {
            await supabase.rpc('release_cron_lock', { p_job_name: jobName, p_worker_id: WORKER_ID });
        } catch (e) {
            // Non-fatal: the lease expires on its own at locked_until.
            log.warn('cron lease release failed (will expire on its own)', { jobName, err: e });
        }
    }
}
