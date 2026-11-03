import { describe, it, expect, vi, afterEach } from 'vitest';
import { hardReload } from '../lib/hardReload';

// lib/hardReload.ts — the stale-deploy recovery used by both ErrorBoundary components and
// the BuildUpdateWatcher "Reload now" action. A plain reload can be served by the service
// worker from its own cache, so the sequence is: unregister every SW → delete every Cache
// Storage entry → location.replace(href). Pinned: the order, that every step is best-effort
// (a failure never prevents the reload), that `replace` (not `reload`) is used so the broken
// page leaves history, and the reload() fallback when replace throws.
// jsdom has no serviceWorker / caches, and location is stubbed via vi.stubGlobal; all are
// restored after each test.

const HREF = 'https://org.example.test/dashboard?view=ops';

function stubLocation(log: string[], opts: { replaceThrows?: boolean } = {}) {
    const loc = {
        href: HREF,
        replace: vi.fn((url: string) => {
            log.push(`replace:${url}`);
            if (opts.replaceThrows) throw new Error('SecurityError');
        }),
        reload: vi.fn(() => { log.push('reload'); }),
    };
    vi.stubGlobal('location', loc);
    return loc;
}

function stubServiceWorker(log: string[], opts: { getFails?: boolean; unregisterFails?: boolean } = {}) {
    const regs = ['sw-a', 'sw-b'].map(name => ({
        unregister: vi.fn(async () => {
            log.push(`unregister:${name}`);
            if (opts.unregisterFails) throw new Error('unregister failed');
            return true;
        }),
    }));
    const sw = {
        getRegistrations: vi.fn(async () => {
            log.push('getRegistrations');
            if (opts.getFails) throw new Error('SecurityError');
            return regs;
        }),
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw });
    return { sw, regs };
}

function stubCaches(log: string[], opts: { keysFail?: boolean; deleteFails?: boolean } = {}) {
    const c = {
        keys: vi.fn(async () => {
            log.push('keys');
            if (opts.keysFail) throw new Error('blocked');
            return ['workbox-precache', 'runtime'];
        }),
        delete: vi.fn(async (name: string) => {
            log.push(`delete:${name}`);
            if (opts.deleteFails) throw new Error('delete failed');
            return true;
        }),
    };
    vi.stubGlobal('caches', c);
    return c;
}

afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    vi.unstubAllGlobals();
});

describe('hardReload', () => {
    it('unregisters every SW, then deletes every cache, then replaces the location', async () => {
        const log: string[] = [];
        const { regs } = stubServiceWorker(log);
        const c = stubCaches(log);
        const loc = stubLocation(log);
        await hardReload();
        expect(log).toEqual([
            'getRegistrations', 'unregister:sw-a', 'unregister:sw-b',
            'keys', 'delete:workbox-precache', 'delete:runtime',
            `replace:${HREF}`,
        ]);
        for (const r of regs) expect(r.unregister).toHaveBeenCalledTimes(1);
        expect(c.delete).toHaveBeenCalledTimes(2);
        expect(loc.replace).toHaveBeenCalledWith(HREF);
        expect(loc.reload).not.toHaveBeenCalled();
    });

    it('still clears caches and reloads when the SW registry is unavailable', async () => {
        const log: string[] = [];
        stubServiceWorker(log, { getFails: true });
        stubCaches(log);
        const loc = stubLocation(log);
        await hardReload();
        expect(log).toEqual(['getRegistrations', 'keys', 'delete:workbox-precache', 'delete:runtime', `replace:${HREF}`]);
        expect(loc.replace).toHaveBeenCalledTimes(1);
    });

    it('still clears caches and reloads when an unregister rejects', async () => {
        const log: string[] = [];
        stubServiceWorker(log, { unregisterFails: true });
        const c = stubCaches(log);
        const loc = stubLocation(log);
        await hardReload();
        expect(c.keys).toHaveBeenCalledTimes(1);
        expect(c.delete).toHaveBeenCalledTimes(2);
        expect(loc.replace).toHaveBeenCalledWith(HREF);
    });

    it('still reloads when Cache Storage is blocked or a delete rejects', async () => {
        for (const opts of [{ keysFail: true }, { deleteFails: true }]) {
            const log: string[] = [];
            stubServiceWorker(log);
            stubCaches(log, opts);
            const loc = stubLocation(log);
            await hardReload();
            expect(loc.replace, JSON.stringify(opts)).toHaveBeenCalledWith(HREF);
            expect(log[log.length - 1]).toBe(`replace:${HREF}`);
        }
    });

    it('goes straight to the reload when neither SW nor Cache Storage exists', async () => {
        const log: string[] = [];
        // jsdom: navigator.serviceWorker and caches are both absent.
        expect((navigator as unknown as Record<string, unknown>).serviceWorker).toBeUndefined();
        expect(typeof (globalThis as Record<string, unknown>).caches).toBe('undefined');
        const loc = stubLocation(log);
        await hardReload();
        expect(log).toEqual([`replace:${HREF}`]);
        expect(loc.reload).not.toHaveBeenCalled();
    });

    it('falls back to location.reload() when replace throws', async () => {
        const log: string[] = [];
        stubCaches(log);
        const loc = stubLocation(log, { replaceThrows: true });
        await hardReload();
        expect(loc.replace).toHaveBeenCalledWith(HREF);
        expect(loc.reload).toHaveBeenCalledTimes(1);
        expect(log.slice(-2)).toEqual([`replace:${HREF}`, 'reload']);
    });

    it('does not reload before the clean-up has finished', async () => {
        const log: string[] = [];
        let releaseKeys!: (v: string[]) => void;
        vi.stubGlobal('caches', {
            keys: vi.fn(() => new Promise<string[]>(r => { releaseKeys = r; })),
            delete: vi.fn(async (n: string) => { log.push(`delete:${n}`); return true; }),
        });
        const loc = stubLocation(log);
        const p = hardReload();
        await Promise.resolve();
        await Promise.resolve();
        expect(loc.replace).not.toHaveBeenCalled();
        releaseKeys(['old']);
        await p;
        expect(log).toEqual(['delete:old', `replace:${HREF}`]);
    });
});
