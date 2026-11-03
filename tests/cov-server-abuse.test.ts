// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The per-IP abuse tracker's housekeeping in server.ts: the once-a-minute sweep (which also drives
// every other limiter's prune) and the hard cap on tracked IPs. Its own file because both mutate
// module-level state the rest of the server suite relies on staying small and predictable.

interface LogRecord { level: string; msg: string; fields: Record<string, unknown> | undefined }

const h = vi.hoisted(() => {
    vi.stubEnv('TRUST_CF_PROXY', '1');
    return {
        logs: [] as LogRecord[],
        prunes: {
            pruneAuthRateLimitBuckets: vi.fn(),
            pruneOrgUploadBuckets: vi.fn(),
            pruneAiRateLimitBuckets: vi.fn(),
            pruneSubmissionRateLimitBuckets: vi.fn(),
            pruneRadioRateLimitBuckets: vi.fn(),
            pruneUserRateLimitBuckets: vi.fn(),
        },
    };
});

vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => { h.logs.push({ level, msg, fields }); };
    const logger = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), child: () => logger };
    return { ...actual, log: logger };
});
vi.mock('../lib/authRateLimit', async (o) => ({ ...(await o<typeof import('../lib/authRateLimit')>()), pruneAuthRateLimitBuckets: h.prunes.pruneAuthRateLimitBuckets }));
vi.mock('../api/orgUpload', async (o) => ({ ...(await o<typeof import('../api/orgUpload')>()), pruneOrgUploadBuckets: h.prunes.pruneOrgUploadBuckets }));
vi.mock('../lib/aiRateLimit', async (o) => ({ ...(await o<typeof import('../lib/aiRateLimit')>()), pruneAiRateLimitBuckets: h.prunes.pruneAiRateLimitBuckets }));
vi.mock('../lib/submissionRateLimit', async (o) => ({ ...(await o<typeof import('../lib/submissionRateLimit')>()), pruneSubmissionRateLimitBuckets: h.prunes.pruneSubmissionRateLimitBuckets }));
vi.mock('../lib/radio', async (o) => ({ ...(await o<typeof import('../lib/radio')>()), pruneRadioRateLimitBuckets: h.prunes.pruneRadioRateLimitBuckets }));
vi.mock('../lib/userRateLimit', async (o) => ({ ...(await o<typeof import('../lib/userRateLimit')>()), pruneUserRateLimitBuckets: h.prunes.pruneUserRateLimitBuckets }));

let server: http.Server;
let port = 0;
let sweep: () => void = () => { throw new Error('sweep not captured'); };
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

beforeAll(async () => {
    // Capture the sweep server.ts registers at module load, so it can be run on demand instead of
    // waiting a real minute. Identified by what it calls, not by registration order.
    const spy = vi.spyOn(globalThis, 'setInterval');
    try {
        const mod = await import('../server.ts');
        const found = spy.mock.calls.find(([fn, ms]) => ms === 60_000 && String(fn).includes('pruneAuthRateLimitBuckets'));
        if (!found) throw new Error('server.ts sweep interval not found');
        sweep = found[0] as () => void;
        server = mod.app.listen(0, '127.0.0.1');
    } finally {
        spy.mockRestore();
    }
    await new Promise<void>((r) => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    vi.unstubAllEnvs();
});

beforeEach(() => {
    h.logs = [];
    for (const fn of Object.values(h.prunes)) fn.mockReset();
});

function get(path: string, ip: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', agent, headers: { 'cf-connecting-ip': ip } }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
    });
}
const probe = (ip: string) => get('/wp-login.php', ip);
async function probes(ip: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) await probe(ip);
}

describe('the once-a-minute sweep', () => {
    it('runs every limiter prune with one shared timestamp', () => {
        const now = 1_900_000_000_000;
        const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
            sweep();
        } finally {
            spy.mockRestore();
        }
        for (const [name, fn] of Object.entries(h.prunes)) {
            expect(fn, name).toHaveBeenCalledTimes(1);
            expect(fn, name).toHaveBeenCalledWith(now);
        }
    });

    it('never lifts an ACTIVE block, even on a tracker whose window opened more than five minutes ago', async () => {
        const realNow = Date.now.bind(Date);
        let offset = 0;
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
        const ip = '10.250.0.1';
        try {
            await probes(ip, 19);                 // window opens at T
            offset = 50_000;
            await probe(ip);                      // 20th inside the window → blocked until T+50s+300s
            expect(h.logs.filter((l) => l.msg === 'ip blackholed')).toHaveLength(1);

            offset = 330_000;                     // window is >300s old, block still has ~20s to run
            sweep();
            expect(await get('/healthz', ip)).toBe(404);

            offset = 360_000;                     // and once the block itself expires, the caller is admitted
            expect(await get('/healthz', ip)).toBe(200);
        } finally {
            spy.mockRestore();
        }
    });
});

describe("the sweep's memory hygiene", () => {
    it('forgets trackers whose block lapsed over five minutes ago, and keeps recent ones (including their log dedupe)', async () => {
        const realNow = Date.now.bind(Date);
        let offset = 0;
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
        const stale = '10.250.0.3';
        const recent = '10.250.0.4';
        try {
            await probe(stale);
            const staleProbeAt = Date.now();
            offset = 400_000;
            await probe(recent);
            // The sweep empties two maps, keyed by the same IP: the abuse tracker (values are
            // { count, firstSeen, blockedUntil } objects) and the scanner-log dedupe (values are the
            // epoch-ms of the last logged probe). Neither eviction is visible over HTTP, because a
            // lapsed window restarts the count and a lapsed dedupe re-logs anyway. So record which map
            // each deletion hit, and what it held, to pin BOTH evictions separately.
            const realDelete = Map.prototype.delete;
            const removed: { map: Map<unknown, unknown>; key: unknown; value: unknown }[] = [];
            const del = vi.spyOn(Map.prototype, 'delete').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
                removed.push({ map: this, key, value: this.get(key) });
                return realDelete.call(this, key);
            });
            try {
                sweep();
            } finally {
                del.mockRestore();
            }
            const staleRemovals = removed.filter((r) => r.key === stale);
            expect(staleRemovals).toHaveLength(2);
            expect(new Set(staleRemovals.map((r) => r.map)).size).toBe(2);
            // One from the tracker: the single unblocked probe's record.
            const trackerRemoval = staleRemovals.find((r) => typeof r.value === 'object');
            expect(trackerRemoval?.value).toEqual({ count: 1, firstSeen: expect.any(Number), blockedUntil: 0 });
            const trackerValue = trackerRemoval?.value as { firstSeen: number };
            expect(trackerValue.firstSeen).toBeLessThanOrEqual(staleProbeAt);
            expect(staleProbeAt - trackerValue.firstSeen).toBeLessThan(60_000);
            // One from the log dedupe: the timestamp of that same probe.
            const logRemoval = staleRemovals.find((r) => typeof r.value === 'number');
            expect(logRemoval).toBeDefined();
            expect(logRemoval?.value as number).toBeLessThanOrEqual(staleProbeAt);
            expect(staleProbeAt - (logRemoval?.value as number)).toBeLessThan(60_000);
            // Nothing recent is evicted from either map.
            expect(removed.filter((r) => r.key === recent)).toHaveLength(0);
            // The recent IP's dedupe entry survived the sweep: its next probe inside the minute is
            // still not re-logged.
            h.logs = [];
            await probe(recent);
            expect(h.logs.filter((l) => l.msg === 'scanner probe')).toHaveLength(0);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('the counting window', () => {
    it("restarts an IP's count when its 60s window lapses, so a slow drip is not treated as a spray", async () => {
        const realNow = Date.now.bind(Date);
        let offset = 0;
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
        const ip = '10.250.0.2';
        try {
            await probes(ip, 19);
            offset = 61_000;                      // window lapsed: the 20th bad request starts a new count
            await probe(ip);
            expect(await get('/healthz', ip)).toBe(200);
            await probes(ip, 18);                 // 19 in the new window
            expect(await get('/healthz', ip)).toBe(200);
            await probe(ip);                      // 20th in the new window
            expect(await get('/healthz', ip)).toBe(404);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('the tracked-IP cap', () => {
    it('a tracker full of 5000 sprayed IPs still blackholes a NEW offender, by evicting the oldest unblocked entry', async () => {
        const first = '10.1.0.0';
        await probe(first);
        const rest: string[] = [];
        for (let i = 1; i < 5000; i++) rest.push(`10.1.${i >> 8}.${i & 255}`);
        for (let i = 0; i < rest.length; i += 100) await Promise.all(rest.slice(i, i + 100).map(probe));

        const offender = '10.9.9.9';
        await probes(offender, 20);
        expect(h.logs.filter((l) => l.msg === 'ip blackholed').map((l) => l.fields?.ip)).toEqual([offender]);
        expect(await get('/healthz', offender)).toBe(404);

        // The earliest unblocked tracker was the one evicted: its one old probe is forgotten, so 19
        // more do not reach the threshold (they would have, at 1 + 19 = 20, had it been kept).
        await probes(first, 19);
        expect(await get('/healthz', first)).toBe(200);
    }, 60_000);
});
