// @vitest-environment node
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';

// The isMainModule bootstrap of server.ts — what runs once the port is bound (boot banner,
// first-boot install, preflights, app-origin report), the seven in-process cron jobs, the
// slowloris timeouts, the graceful shutdown and the process-level handlers. Extracted into
// exported functions so it can be driven here with an injected scheduler, server and process;
// nothing below calls the real process.exit or registers a real process listener.

interface LogRecord { level: string; msg: string; fields: Record<string, unknown> | undefined }

const h = vi.hoisted(() => ({
    logs: [] as LogRecord[],
    /** When false, the lease is "held by another worker": withCronLease never runs the job. */
    leaseGranted: true,
    jobs: {
        cleanupInactiveDutyUsers: vi.fn(),
        cleanupExpiredBulletins: vi.fn(),
        allianceSyncTick: vi.fn(),
        sendDueOperationReminders: vi.fn(),
        sendDueOperationStartNotices: vi.fn(),
        pruneOldNotifications: vi.fn(),
        pruneSecurityEvents: vi.fn(),
        runOrgMediaGc: vi.fn(),
    },
    boot: {
        runFirstBootCheck: vi.fn(),
        validatePermissionMap: vi.fn(),
        findMissingApiKeyColumns: vi.fn(),
        resolveOrgAppUrl: vi.fn(),
    },
    withCronLease: vi.fn(),
}));

vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => { h.logs.push({ level, msg, fields }); };
    const logger = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), child: () => logger };
    return { ...actual, log: logger };
});
vi.mock('../lib/cronLock', () => ({ withCronLease: h.withCronLease }));
vi.mock('../lib/db/users', async (o) => ({ ...(await o<typeof import('../lib/db/users')>()), cleanupInactiveDutyUsers: h.jobs.cleanupInactiveDutyUsers }));
vi.mock('../lib/db/intel', async (o) => ({ ...(await o<typeof import('../lib/db/intel')>()), cleanupExpiredBulletins: h.jobs.cleanupExpiredBulletins }));
vi.mock('../lib/db/allianceSync', async (o) => ({ ...(await o<typeof import('../lib/db/allianceSync')>()), allianceSyncTick: h.jobs.allianceSyncTick }));
vi.mock('../lib/db/opReminders', async (o) => ({ ...(await o<typeof import('../lib/db/opReminders')>()), sendDueOperationReminders: h.jobs.sendDueOperationReminders }));
vi.mock('../lib/db/opStartNotices', async (o) => ({ ...(await o<typeof import('../lib/db/opStartNotices')>()), sendDueOperationStartNotices: h.jobs.sendDueOperationStartNotices }));
vi.mock('../lib/db/notifications', async (o) => ({ ...(await o<typeof import('../lib/db/notifications')>()), pruneOldNotifications: h.jobs.pruneOldNotifications }));
vi.mock('../lib/db/securityEvents', async (o) => ({ ...(await o<typeof import('../lib/db/securityEvents')>()), pruneSecurityEvents: h.jobs.pruneSecurityEvents }));
vi.mock('../lib/orgMediaGc', async (o) => ({ ...(await o<typeof import('../lib/orgMediaGc')>()), runOrgMediaGc: h.jobs.runOrgMediaGc }));
vi.mock('../lib/firstBoot', async (o) => ({ ...(await o<typeof import('../lib/firstBoot')>()), runFirstBootCheck: h.boot.runFirstBootCheck }));
vi.mock('../lib/db/system', async (o) => ({ ...(await o<typeof import('../lib/db/system')>()), findMissingApiKeyColumns: h.boot.findMissingApiKeyColumns }));
vi.mock('../lib/db', async (o) => ({ ...(await o<typeof import('../lib/db')>()), resolveOrgAppUrl: h.boot.resolveOrgAppUrl }));
vi.mock('../api/services', async (o) => ({ ...(await o<typeof import('../api/services')>()), validatePermissionMap: h.boot.validatePermissionMap }));

type ServerModule = typeof import('../server');
let mod: ServerModule;
const realListenerCounts: Record<string, number> = {};
const PROCESS_EVENTS = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'] as const;

beforeAll(async () => {
    for (const e of PROCESS_EVENTS) realListenerCounts[e] = process.listenerCount(e);
    mod = await import('../server');
}, 60_000);

beforeEach(() => {
    h.logs = [];
    h.leaseGranted = true;
    for (const fn of [...Object.values(h.jobs), ...Object.values(h.boot)]) fn.mockReset();
    h.withCronLease.mockReset();
    h.withCronLease.mockImplementation(async (_name: string, _hold: number, fn: () => Promise<void>) => { if (h.leaseGranted) await fn(); });
    h.boot.runFirstBootCheck.mockResolvedValue(undefined);
    h.boot.validatePermissionMap.mockReturnValue({ missing: [], stale: [] });
    h.boot.findMissingApiKeyColumns.mockResolvedValue([]);
    h.boot.resolveOrgAppUrl.mockResolvedValue({ url: 'https://org.example', source: 'env', rejected: [], drift: null });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

const logsOf = (msg: string) => h.logs.filter((l) => l.msg === msg);

type Scheduled = () => Promise<void>;
/** A fake node-cron: records (expression, callback) and never starts a timer. */
function fakeScheduler() {
    const schedule = vi.fn((_expr: string, _fn: Scheduled) => ({ stop: vi.fn() }));
    return { schedule, scheduler: { schedule } as unknown as Parameters<ServerModule['registerCronJobs']>[0] };
}
function registered() {
    const { schedule, scheduler } = fakeScheduler();
    mod.registerCronJobs(scheduler);
    return schedule.mock.calls.map(([expr, fn]) => ({ expr, fn }));
}

describe('importing server.ts', () => {
    it('installs no process-level handler (only the entrypoint does)', () => {
        for (const e of PROCESS_EVENTS) expect(process.listenerCount(e), e).toBe(realListenerCounts[e]);
    });
});

describe('registerCronJobs', () => {
    const JOBS: Array<{ i: number; expr: string; lease: string; hold: number; opts?: { failClosed: true } }> = [
        { i: 0, expr: '* * * * *', lease: 'duty_cleanup', hold: 50 },
        { i: 1, expr: '*/5 * * * *', lease: 'bulletin_cleanup', hold: 270 },
        { i: 2, expr: '* * * * *', lease: 'op_reminders', hold: 50 },
        { i: 3, expr: '* * * * *', lease: 'alliance_sync', hold: 50, opts: { failClosed: true } },
        { i: 4, expr: '30 3 * * *', lease: 'prune_notifications', hold: 600 },
        { i: 5, expr: '45 3 * * *', lease: 'prune_security_events', hold: 600 },
        { i: 6, expr: '30 4 * * *', lease: 'org_media_gc', hold: 1800 },
    ];

    it('schedules exactly seven jobs, in order, with their exact expressions, and logs once when done', () => {
        const jobs = registered();
        expect(jobs.map((j) => j.expr)).toEqual(JOBS.map((j) => j.expr));
        expect(logsOf('cron jobs initialized')).toHaveLength(1);
        // Registration alone runs nothing.
        expect(h.withCronLease).not.toHaveBeenCalled();
        for (const fn of Object.values(h.jobs)) expect(fn).not.toHaveBeenCalled();
    });

    it.each(JOBS)('job $i runs under lease "$lease" (hold $hold s)', async ({ i, lease, hold, opts }) => {
        const jobs = registered();
        await jobs[i].fn();
        expect(h.withCronLease).toHaveBeenCalledTimes(1);
        const args = h.withCronLease.mock.calls[0];
        expect(args[0]).toBe(lease);
        expect(args[1]).toBe(hold);
        expect(typeof args[2]).toBe('function');
        if (opts) expect(args[3]).toEqual(opts);
        else expect(args).toHaveLength(3);
    });

    it('only alliance_sync opts into the fail-closed lease (the others must run through a lease outage)', async () => {
        const jobs = registered();
        for (const j of jobs) await j.fn();
        const failClosed = h.withCronLease.mock.calls.filter((c) => (c[3] as { failClosed?: boolean } | undefined)?.failClosed === true).map((c) => c[0]);
        expect(failClosed).toEqual(['alliance_sync']);
    });

    it('a job never runs when another worker holds its lease', async () => {
        h.leaseGranted = false;
        for (const j of registered()) await j.fn();
        expect(h.withCronLease).toHaveBeenCalledTimes(7);
        for (const fn of Object.values(h.jobs)) expect(fn).not.toHaveBeenCalled();
    });

    it('duty cleanup reports how many users went off duty (0 when the job returns nothing)', async () => {
        const jobs = registered();
        h.jobs.cleanupInactiveDutyUsers.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
        await jobs[0].fn();
        h.jobs.cleanupInactiveDutyUsers.mockResolvedValueOnce(null);
        await jobs[0].fn();
        expect(logsOf('cron duty-cleanup').map((l) => l.fields?.usersOffDuty)).toEqual([2, 0]);
        expect(typeof logsOf('cron duty-cleanup')[0].fields?.durationMs).toBe('number');
    });

    it('bulletin cleanup, alliance sync and media GC log completion', async () => {
        const jobs = registered();
        h.jobs.cleanupExpiredBulletins.mockResolvedValue(undefined);
        h.jobs.allianceSyncTick.mockResolvedValue(undefined);
        h.jobs.runOrgMediaGc.mockResolvedValue(undefined);
        await jobs[1].fn();
        await jobs[3].fn();
        await jobs[6].fn();
        expect(h.jobs.cleanupExpiredBulletins).toHaveBeenCalledTimes(1);
        expect(h.jobs.allianceSyncTick).toHaveBeenCalledTimes(1);
        expect(h.jobs.runOrgMediaGc).toHaveBeenCalledTimes(1);
        expect(logsOf('cron bulletin-cleanup done')).toHaveLength(1);
        expect(logsOf('cron alliance-sync done')).toHaveLength(1);
        expect(logsOf('cron media-gc done')).toHaveLength(1);
    });

    it('op reminders and start notices log only when something was sent', async () => {
        const jobs = registered();
        h.jobs.sendDueOperationReminders.mockResolvedValueOnce(3);
        h.jobs.sendDueOperationStartNotices.mockResolvedValueOnce(2);
        await jobs[2].fn();
        expect(logsOf('cron op-reminders')[0].fields).toMatchObject({ sent: 3 });
        expect(logsOf('cron op-start-notices')[0].fields).toMatchObject({ notices: 2 });
        h.logs = [];
        h.jobs.sendDueOperationReminders.mockResolvedValueOnce(0);
        h.jobs.sendDueOperationStartNotices.mockResolvedValueOnce(0);
        await jobs[2].fn();
        expect(logsOf('cron op-reminders')).toHaveLength(0);
        expect(logsOf('cron op-start-notices')).toHaveLength(0);
    });

    it('a reminder failure does not stop the start notices that share its tick and lease', async () => {
        const jobs = registered();
        h.jobs.sendDueOperationReminders.mockRejectedValueOnce(new Error('push outage'));
        h.jobs.sendDueOperationStartNotices.mockResolvedValueOnce(1);
        await expect(jobs[2].fn()).resolves.toBeUndefined();
        expect(logsOf('cron op reminders failed')).toHaveLength(1);
        expect(h.jobs.sendDueOperationStartNotices).toHaveBeenCalledTimes(1);
        expect(logsOf('cron op-start-notices')).toHaveLength(1);
        expect(h.withCronLease).toHaveBeenCalledTimes(1);
    });

    it('notification retention prunes at 90 days', async () => {
        const jobs = registered();
        h.jobs.pruneOldNotifications.mockResolvedValue(5);
        await jobs[4].fn();
        expect(h.jobs.pruneOldNotifications).toHaveBeenCalledWith(90);
        expect(logsOf('cron notification-prune done')[0].fields).toMatchObject({ deleted: 5 });
    });

    it('security-event retention defaults to 365 days, honours SECURITY_EVENT_RETENTION_DAYS, and ignores junk', async () => {
        const jobs = registered();
        h.jobs.pruneSecurityEvents.mockResolvedValue(4);
        await jobs[5].fn();
        vi.stubEnv('SECURITY_EVENT_RETENTION_DAYS', '30');
        await jobs[5].fn();
        vi.stubEnv('SECURITY_EVENT_RETENTION_DAYS', 'forever');
        await jobs[5].fn();
        expect(h.jobs.pruneSecurityEvents.mock.calls).toEqual([[365], [30], [365]]);
        expect(logsOf('cron security-event-prune done').map((l) => l.fields?.days)).toEqual([365, 30, 365]);
        expect(logsOf('cron security-event-prune done')[0].fields).toMatchObject({ deleted: 4 });
    });

    const FAILURES: Array<[number, keyof typeof h.jobs, string]> = [
        [0, 'cleanupInactiveDutyUsers', 'cron duty cleanup failed'],
        [1, 'cleanupExpiredBulletins', 'cron bulletin cleanup failed'],
        [2, 'sendDueOperationStartNotices', 'cron op start notices failed'],
        [3, 'allianceSyncTick', 'cron alliance sync failed'],
        [4, 'pruneOldNotifications', 'cron notification prune failed'],
        [5, 'pruneSecurityEvents', 'cron security event prune failed'],
        [6, 'runOrgMediaGc', 'cron media gc failed'],
    ];

    it.each(FAILURES)('job %i: a thrown %s is logged with the error and swallowed — the tick resolves', async (i, jobName, msg) => {
        const jobs = registered();
        h.jobs.sendDueOperationReminders.mockResolvedValue(0);
        const boom = new Error(`${jobName} exploded`);
        h.jobs[jobName].mockRejectedValueOnce(boom);
        await expect(jobs[i].fn()).resolves.toBeUndefined();
        expect(logsOf(msg)).toEqual([{ level: 'error', msg, fields: { err: boom } }]);
    });
});

describe('onServerListening', () => {
    function listen() {
        const { schedule, scheduler } = fakeScheduler();
        mod.onServerListening(scheduler);
        return schedule;
    }

    it('logs the boot banner, runs the first-boot check, and registers the cron jobs on the given scheduler', async () => {
        const schedule = listen();
        expect(h.logs.slice(0, 3).map((l) => l.msg)).toEqual(['server running', 'deployment timestamp', 'serving static files']);
        expect(h.logs[0].fields).toHaveProperty('port');
        expect(String(h.logs[1].fields?.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(String(h.logs[2].fields?.distPath)).toMatch(/dist$/);
        expect(h.boot.runFirstBootCheck).toHaveBeenCalledTimes(1);
        expect(schedule).toHaveBeenCalledTimes(7);
        expect(logsOf('cron jobs initialized')).toHaveLength(1);
        await vi.waitFor(() => expect(logsOf('app origin resolved')).toHaveLength(1));
    });

    it('a rejected first-boot check is logged, never thrown', async () => {
        h.boot.runFirstBootCheck.mockRejectedValue(new Error('seed failed'));
        expect(() => listen()).not.toThrow();
        await vi.waitFor(() => expect(logsOf('first-boot check threw (unhandled)')).toHaveLength(1));
    });

    it('reports permission-map drift: missing as an error, stale as a warning, and "ok" only when clean', () => {
        h.boot.validatePermissionMap.mockReturnValue({ missing: ['fleet:scrap'], stale: [] });
        listen();
        expect(logsOf('protected actions missing from permission map (will silently 403)')[0]).toMatchObject({ level: 'error', fields: { count: 1, actions: ['fleet:scrap'] } });
        expect(logsOf('permission map ok')).toHaveLength(0);

        h.logs = [];
        h.boot.validatePermissionMap.mockReturnValue({ missing: [], stale: ['old:action', 'older:action'] });
        listen();
        expect(logsOf('stale permission map entries (no matching action)')[0]).toMatchObject({ level: 'warn', fields: { count: 2, entries: ['old:action', 'older:action'] } });
        expect(logsOf('permission map ok')).toHaveLength(0);

        h.logs = [];
        h.boot.validatePermissionMap.mockReturnValue({ missing: [], stale: [] });
        listen();
        expect(logsOf('permission map ok')).toHaveLength(1);
        expect(logsOf('protected actions missing from permission map (will silently 403)')).toHaveLength(0);
    });

    it('a missing api_keys column is a loud error naming the columns; none is silent; a failed check is a warning', async () => {
        h.boot.findMissingApiKeyColumns.mockResolvedValueOnce(['revoked_at', 'expires_at']);
        listen();
        const msg = 'DATABASE UPDATE REQUIRED — api_keys is missing columns; API key authentication is REFUSED until schema.sql is re-run';
        await vi.waitFor(() => expect(logsOf(msg)).toHaveLength(1));
        expect(logsOf(msg)[0]).toMatchObject({ level: 'error', fields: { missing: ['revoked_at', 'expires_at'] } });

        h.logs = [];
        h.boot.findMissingApiKeyColumns.mockResolvedValueOnce([]);
        listen();
        await vi.waitFor(() => expect(logsOf('app origin resolved')).toHaveLength(1));
        expect(logsOf(msg)).toHaveLength(0);

        h.logs = [];
        h.boot.findMissingApiKeyColumns.mockRejectedValueOnce(new Error('pg down'));
        listen();
        await vi.waitFor(() => expect(logsOf('could not preflight api_keys columns')).toHaveLength(1));
        expect(logsOf('could not preflight api_keys columns')[0].level).toBe('warn');
    });

    it('reports the effective app origin, each ignored candidate, and drift', async () => {
        h.boot.resolveOrgAppUrl.mockResolvedValueOnce({
            url: 'https://org.example', source: 'env',
            rejected: [{ source: 'stored', value: 'http://localhost:3000', reason: 'loopback' }, { source: 'request', value: 'ftp://x', reason: 'scheme' }],
            drift: { appUrl: 'https://org.example', stored: 'https://old.example' },
        });
        listen();
        await vi.waitFor(() => expect(logsOf('app origin resolved')).toHaveLength(1));
        expect(logsOf('app origin resolved')[0].fields).toEqual({ effective: 'https://org.example', source: 'env' });
        expect(logsOf('app origin candidate ignored').map((l) => l.fields)).toEqual([
            { source: 'stored', value: 'http://localhost:3000', reason: 'loopback' },
            { source: 'request', value: 'ftp://x', reason: 'scheme' },
        ]);
        expect(logsOf('APP_URL and the stored systemConfig.appUrl disagree — APP_URL wins')[0]).toMatchObject({ level: 'warn', fields: { stored: 'https://old.example' } });
        expect(logsOf('no usable APP_URL — Discord deep links and alliance pairing will use the localhost fallback')).toHaveLength(0);
    });

    it('a localhost fallback origin is an error in production only', async () => {
        const FALLBACK_MSG = 'no usable APP_URL — Discord deep links and alliance pairing will use the localhost fallback';
        h.boot.resolveOrgAppUrl.mockResolvedValue({ url: 'http://localhost:3000', source: 'fallback', rejected: [], drift: null });
        listen();
        await vi.waitFor(() => expect(logsOf('app origin resolved')).toHaveLength(1));
        expect(logsOf(FALLBACK_MSG)).toHaveLength(0);

        h.logs = [];
        vi.stubEnv('NODE_ENV', 'production');
        listen();
        await vi.waitFor(() => expect(logsOf(FALLBACK_MSG)).toHaveLength(1));
        expect(logsOf(FALLBACK_MSG)[0]).toMatchObject({ level: 'error', fields: { effective: 'http://localhost:3000' } });
    });

    it('a failed origin resolution is a non-fatal warning', async () => {
        h.boot.resolveOrgAppUrl.mockRejectedValueOnce(new Error('settings unreachable'));
        expect(() => listen()).not.toThrow();
        await vi.waitFor(() => expect(logsOf('app origin resolution failed at boot (non-fatal)')).toHaveLength(1));
    });
});

describe('createTtlCache (the /sw.js render memo) — edges tests/serviceWorkerCache.test.ts does not reach', () => {
    it('a producer that settles never clears ANOTHER key\'s in-flight slot', async () => {
        const cache = mod.createTtlCache<string>(10_000);
        let resolveA: (v: string) => void = () => {};
        let resolveB: (v: string) => void = () => {};
        const produceA = vi.fn(() => new Promise<string>((r) => { resolveA = r; }));
        const produceB = vi.fn(() => new Promise<string>((r) => { resolveB = r; }));
        const a = cache.get('a', produceA);
        const b = cache.get('b', produceB);     // b now owns the in-flight slot
        resolveA('A');
        expect(await a).toBe('A');              // a settles while b is still running
        const b2 = cache.get('b', produceB);    // must still collapse onto b's in-flight render
        resolveB('B');
        expect(await b).toBe('B');
        expect(await b2).toBe('B');
        expect(produceB).toHaveBeenCalledTimes(1);
    });

    it('peek exposes only the cached key and its expiry, never the cached value', async () => {
        let clock = 5_000;
        const cache = mod.createTtlCache<{ secret: string }>(10_000, () => clock);
        expect(cache.peek()).toBeNull();
        await cache.get('sw', async () => ({ secret: 'rendered-body' }));
        clock = 6_000;
        expect(cache.peek()).toEqual({ key: 'sw', expiresAt: 15_000 });
        expect(JSON.stringify(cache.peek())).not.toContain('rendered-body');
    });

    it('a rejected render is not cached: the next call renders again', async () => {
        const cache = mod.createTtlCache<string>(10_000);
        const produce = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce('ok');
        await expect(cache.get('sw', produce)).rejects.toThrow('db down');
        expect(cache.peek()).toBeNull();
        expect(await cache.get('sw', produce)).toBe('ok');
        expect(produce).toHaveBeenCalledTimes(2);
    });
});

describe('applyServerTimeouts (slowloris)', () => {
    it('caps the whole request at 60s and the headers at 20s', () => {
        const srv = http.createServer();
        mod.applyServerTimeouts(srv);
        expect(srv.requestTimeout).toBe(60_000);
        expect(srv.headersTimeout).toBe(20_000);
    });
});

describe('createGracefulShutdown', () => {
    function fakes() {
        let onClosed: (() => void) | undefined;
        const server = { close: vi.fn((cb?: () => void) => { onClosed = cb; return server; }) };
        const proc = { exit: vi.fn() };
        return { server, proc, drain: () => onClosed?.() };
    }

    it('closes the server and exits 0 once connections drain', () => {
        vi.useFakeTimers();
        const { server, proc, drain } = fakes();
        mod.createGracefulShutdown(server as unknown as http.Server, proc as unknown as NodeJS.Process)('SIGTERM');
        expect(logsOf('signal received, starting graceful shutdown')[0].fields).toEqual({ signal: 'SIGTERM' });
        expect(server.close).toHaveBeenCalledTimes(1);
        expect(proc.exit).not.toHaveBeenCalled();
        drain();
        expect(logsOf('all connections drained, server closed cleanly')).toHaveLength(1);
        expect(proc.exit).toHaveBeenCalledWith(0);
    });

    it('forces exit 1 after 30s when connections never drain — and not a moment before', () => {
        vi.useFakeTimers();
        const { server, proc } = fakes();
        mod.createGracefulShutdown(server as unknown as http.Server, proc as unknown as NodeJS.Process)('SIGINT');
        vi.advanceTimersByTime(29_999);
        expect(proc.exit).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(logsOf('forced shutdown after 30s timeout')[0].level).toBe('error');
        expect(proc.exit).toHaveBeenCalledWith(1);
    });
});

describe('installProcessHandlers', () => {
    it('registers exactly the four handlers: signals shut down, a rejection is logged but NOT fatal, an exception is logged AND shuts down', () => {
        const proc = new EventEmitter();
        const shutdown = vi.fn();
        mod.installProcessHandlers(proc as unknown as NodeJS.Process, shutdown);
        expect(proc.eventNames().sort()).toEqual([...PROCESS_EVENTS].sort());

        proc.emit('SIGTERM');
        proc.emit('SIGINT');
        expect(shutdown.mock.calls).toEqual([['SIGTERM'], ['SIGINT']]);

        const reason = new Error('stray background rejection');
        proc.emit('unhandledRejection', reason, Promise.resolve());
        expect(logsOf('unhandled promise rejection')).toEqual([{ level: 'error', msg: 'unhandled promise rejection', fields: { err: reason } }]);
        expect(shutdown).toHaveBeenCalledTimes(2);

        const err = new Error('state unknown');
        proc.emit('uncaughtException', err);
        expect(logsOf('uncaught exception')).toEqual([{ level: 'error', msg: 'uncaught exception', fields: { err } }]);
        expect(shutdown).toHaveBeenLastCalledWith('uncaughtException');
    });

    it('wired to the real shutdown, an uncaught exception drains the server and exits 0', () => {
        vi.useFakeTimers();
        const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
        let onClosed: (() => void) | undefined;
        const server = { close: vi.fn((cb?: () => void) => { onClosed = cb; }) };
        mod.installProcessHandlers(proc as unknown as NodeJS.Process, mod.createGracefulShutdown(server as unknown as http.Server, proc as unknown as NodeJS.Process));
        proc.emit('uncaughtException', new Error('boom'));
        expect(server.close).toHaveBeenCalledTimes(1);
        onClosed?.();
        expect(proc.exit).toHaveBeenCalledWith(0);
        // The real process was never touched.
        for (const e of PROCESS_EVENTS) expect(process.listenerCount(e), e).toBe(realListenerCounts[e]);
    });
});
