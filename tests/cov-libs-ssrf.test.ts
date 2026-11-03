// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/ssrf.ts — the one sanctioned outbound fetch for operator/peer-supplied URLs.
// DNS and undici are doubled so every branch is driven deterministically; the
// private-address predicates (lib/linkUrl) are REAL, so the reject tables below
// exercise the production classification. Pins:
//   * resolve-then-validate: unparseable URL, no answer, and ANY private answer refuse
//     before a request is made (v4, v6, v4-mapped in both dotted and hex form, NAT64,
//     6to4, bracketed literals);
//   * the dev loopback hatch is dev-only and needs the exact flag value;
//   * the pinning Agent is HTTP/1.1-only with the wire ceiling, and pins the vetted IP;
//   * 3xx and out-of-range statuses are refused and their body cancelled — even when the
//     cancel itself rejects;
//   * the DECODED body ceiling cancels the stream (even when cancel rejects);
//   * the rebuilt Response drops Content-Encoding, carries a truthful Content-Length,
//     a null body for 204/205, and a sanitised reason phrase;
//   * the per-call Agent is always closed, and a rejecting close() is swallowed.

const h = vi.hoisted(() => ({
    lookupResult: [] as Array<{ address: string; family: number }>,
    lookupThrows: false,
    lookupCalls: [] as Array<{ host: string; opts: unknown }>,
    fetchCalls: [] as Array<{ url: string; init: Record<string, unknown> }>,
    fetchImpl: null as null | ((url: string, init: Record<string, unknown>) => Promise<unknown>),
    agents: [] as Array<{ opts: Record<string, unknown>; closeCalls: number }>,
    closeRejects: false,
}));

vi.mock('node:dns/promises', () => {
    const lookup = async (host: string, opts: unknown) => {
        h.lookupCalls.push({ host, opts });
        if (h.lookupThrows) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
        return h.lookupResult;
    };
    return { lookup, default: { lookup } };
});

vi.mock('undici', () => ({
    Agent: class {
        rec: { opts: Record<string, unknown>; closeCalls: number };
        constructor(opts: Record<string, unknown>) {
            this.rec = { opts, closeCalls: 0 };
            h.agents.push(this.rec);
        }
        get opts() { return this.rec.opts; }
        close() {
            this.rec.closeCalls += 1;
            return h.closeRejects ? Promise.reject(new Error('close failed')) : Promise.resolve();
        }
    },
    fetch: async (url: string, init: Record<string, unknown>) => {
        h.fetchCalls.push({ url, init });
        if (!h.fetchImpl) throw new Error('fetchImpl not set');
        return h.fetchImpl(url, init);
    },
}));

import { ssrfSafeFetch, assertResolvesToPublicHost, MAX_OUTBOUND_RESPONSE_BYTES } from '../lib/ssrf';

/** A body double whose cancel() may reject, recording calls. */
function fakeBody(opts: { chunks?: Uint8Array[]; repeatChunk?: Uint8Array; cancelRejects?: boolean } = {}) {
    const state = { reads: 0, readerCancels: 0, bodyCancels: 0 };
    const queue = [...(opts.chunks ?? [])];
    const body = {
        getReader: () => ({
            read: async () => {
                state.reads += 1;
                if (opts.repeatChunk) return { done: false, value: opts.repeatChunk };
                const next = queue.shift();
                return next ? { done: false, value: next } : { done: true, value: undefined };
            },
            cancel: () => {
                state.readerCancels += 1;
                return opts.cancelRejects ? Promise.reject(new Error('reader cancel failed')) : Promise.resolve();
            },
        }),
        cancel: () => {
            state.bodyCancels += 1;
            return opts.cancelRejects ? Promise.reject(new Error('body cancel failed')) : Promise.resolve();
        },
    };
    return { body, state };
}

function respond(status: number, extra: { body?: unknown; headers?: Record<string, string>; statusText?: string } = {}) {
    h.fetchImpl = async () => ({
        status,
        statusText: extra.statusText,
        headers: new Headers(extra.headers ?? {}),
        body: extra.body ?? null,
    });
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
const savedEnv = { NODE_ENV: process.env.NODE_ENV, FLAG: process.env.ALLIANCE_DEV_ALLOW_LOOPBACK };

beforeEach(() => {
    h.lookupResult = [{ address: '93.184.216.34', family: 4 }];
    h.lookupThrows = false;
    h.lookupCalls = [];
    h.fetchCalls = [];
    h.fetchImpl = null;
    h.agents = [];
    h.closeRejects = false;
    delete process.env.ALLIANCE_DEV_ALLOW_LOOPBACK;
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    process.env.NODE_ENV = savedEnv.NODE_ENV;
    if (savedEnv.FLAG === undefined) delete process.env.ALLIANCE_DEV_ALLOW_LOOPBACK;
    else process.env.ALLIANCE_DEV_ALLOW_LOOPBACK = savedEnv.FLAG;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('assertResolvesToPublicHost', () => {
    it('refuses an unparseable URL before any DNS lookup', async () => {
        await expect(assertResolvesToPublicHost('not a url')).rejects.toThrow('Invalid peer URL');
        expect(h.lookupCalls).toHaveLength(0);
    });

    it('refuses when DNS fails or returns no answers', async () => {
        h.lookupThrows = true;
        await expect(assertResolvesToPublicHost('https://nx.example/')).rejects.toThrow('Peer host did not resolve');
        h.lookupThrows = false;
        h.lookupResult = [];
        await expect(assertResolvesToPublicHost('https://empty.example/')).rejects.toThrow('Peer host did not resolve');
    });

    it('resolves every address family (all:true) for the bare hostname', async () => {
        await assertResolvesToPublicHost('https://peer.example:8443/api/x?y=1');
        expect(h.lookupCalls).toEqual([{ host: 'peer.example', opts: { all: true } }]);
    });

    it('strips the brackets from an IPv6 literal before resolving', async () => {
        h.lookupResult = [{ address: '2606:4700:4700::1111', family: 6 }];
        const out = await assertResolvesToPublicHost('https://[2606:4700:4700::1111]/x');
        expect(h.lookupCalls[0].host).toBe('2606:4700:4700::1111');
        expect(out).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]);
    });

    it.each([
        ['loopback', '127.0.0.1'],
        ['RFC1918 10/8', '10.1.2.3'],
        ['RFC1918 172.16/12', '172.20.0.1'],
        ['RFC1918 192.168/16', '192.168.1.1'],
        ['cloud metadata', '169.254.169.254'],
        ['this-network', '0.0.0.0'],
        ['CGNAT', '100.64.0.1'],
        ['multicast', '224.0.0.1'],
        ['broadcast', '255.255.255.255'],
    ])('refuses an IPv4 %s answer (%s)', async (_label, address) => {
        h.lookupResult = [{ address, family: 4 }];
        await expect(assertResolvesToPublicHost('https://rebind.example/')).rejects.toThrow(/private\/reserved/);
    });

    it.each([
        ['loopback', '::1'],
        ['unspecified', '::'],
        ['link-local', 'fe80::1'],
        ['unique-local', 'fd12:3456::1'],
        ['v4-mapped dotted loopback', '::ffff:127.0.0.1'],
        ['v4-mapped dotted metadata', '::ffff:169.254.169.254'],
        ['NAT64 metadata', '64:ff9b::a9fe:a9fe'],
        ['6to4 of 10/8', '2002:a00:1::1'],
        // The canonical forms dns.lookup returns once a zero group compresses away;
        // the old text patterns for 6to4/NAT64 missed all three.
        ['6to4 of 10.0.0.0, second group compressed', '2002:a00::'],
        ['6to4 of 192.168.0.0, second group compressed', '2002:c0a8::1'],
        ['NAT64 of 0.0.0.1, high group compressed', '64:ff9b::1'],
    ])('refuses an IPv6 %s answer (%s)', async (_label, address) => {
        h.lookupResult = [{ address, family: 6 }];
        await expect(assertResolvesToPublicHost('https://rebind.example/')).rejects.toThrow(/private\/reserved/);
    });

    it.each([
        ['loopback', 'https://[::ffff:127.0.0.1]/x', '::ffff:7f00:1'],
        ['RFC1918', 'https://[::ffff:10.0.0.1]/x', '::ffff:a00:1'],
        ['cloud metadata', 'https://[::ffff:169.254.169.254]/x', '::ffff:a9fe:a9fe'],
    ])('refuses a v4-mapped %s literal, which URL serialises in HEX and dns.lookup echoes verbatim', async (_label, url, hexForm) => {
        // The WHATWG serialisation is the reason this case exists: the dotted spelling the
        // author typed is NOT what reaches the guard.
        expect(new URL(url).hostname).toBe(`[${hexForm}]`);
        h.lookupResult = [{ address: hexForm, family: 6 }];
        await expect(assertResolvesToPublicHost(url)).rejects.toThrow(/private\/reserved/);
    });

    it('still accepts a PUBLIC v4-mapped literal (hex form)', async () => {
        // 93.184.216.34 = 0x5db8:0xd822
        h.lookupResult = [{ address: '::ffff:5db8:d822', family: 6 }];
        await expect(assertResolvesToPublicHost('https://[::ffff:93.184.216.34]/')).resolves.toEqual(h.lookupResult);
    });

    it('still accepts 6to4 and NAT64 answers that embed a PUBLIC v4', async () => {
        h.lookupResult = [
            { address: '2002:808:800::', family: 6 }, // 6to4 of 8.8.8.0, compressed
            { address: '64:ff9b::808:808', family: 6 }, // NAT64 of 8.8.8.8
        ];
        await expect(assertResolvesToPublicHost('https://peer.example/')).resolves.toEqual(h.lookupResult);
    });

    it('checks EVERY answer, not just the first (a mixed public/private answer is refused)', async () => {
        h.lookupResult = [
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.7', family: 4 },
        ];
        await expect(assertResolvesToPublicHost('https://mixed.example/')).rejects.toThrow(/private\/reserved/);
        h.lookupResult = [
            { address: '2606:4700::1', family: 6 },
            { address: 'fd00::1', family: 6 },
        ];
        await expect(assertResolvesToPublicHost('https://mixed6.example/')).rejects.toThrow(/private\/reserved/);
    });

    it('returns all vetted answers when every one is public', async () => {
        h.lookupResult = [
            { address: '93.184.216.34', family: 4 },
            { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
        ];
        await expect(assertResolvesToPublicHost('https://peer.example/')).resolves.toEqual(h.lookupResult);
    });
});

describe('dev loopback hatch', () => {
    it('skips resolution only outside production with the exact flag "1"', async () => {
        process.env.NODE_ENV = 'development';
        process.env.ALLIANCE_DEV_ALLOW_LOOPBACK = '1';
        h.lookupResult = [{ address: '127.0.0.1', family: 4 }];
        await expect(assertResolvesToPublicHost('http://localhost:3001')).resolves.toEqual([]);
        expect(h.lookupCalls).toHaveLength(0);
    });

    it('is ignored in production even with the flag set', async () => {
        process.env.NODE_ENV = 'production';
        process.env.ALLIANCE_DEV_ALLOW_LOOPBACK = '1';
        h.lookupResult = [{ address: '127.0.0.1', family: 4 }];
        await expect(assertResolvesToPublicHost('http://localhost:3001')).rejects.toThrow(/private\/reserved/);
        expect(h.lookupCalls).toHaveLength(1);
    });

    it('is ignored for any flag value other than "1"', async () => {
        process.env.NODE_ENV = 'development';
        process.env.ALLIANCE_DEV_ALLOW_LOOPBACK = 'true';
        h.lookupResult = [{ address: '127.0.0.1', family: 4 }];
        await expect(assertResolvesToPublicHost('http://localhost:3001')).rejects.toThrow(/private\/reserved/);
    });

    it('ssrfSafeFetch under the hatch makes an UNPINNED request that still refuses redirects', async () => {
        process.env.NODE_ENV = 'development';
        process.env.ALLIANCE_DEV_ALLOW_LOOPBACK = '1';
        respond(200, { body: fakeBody({ chunks: [new TextEncoder().encode('{}')] }).body });
        await ssrfSafeFetch('http://localhost:3001/api/alliance/profile');
        expect(h.agents).toHaveLength(0);
        expect('dispatcher' in h.fetchCalls[0].init).toBe(false);
        expect(h.fetchCalls[0].init.redirect).toBe('manual');

        respond(302, { headers: { location: 'http://169.254.169.254/' } });
        await expect(ssrfSafeFetch('http://localhost:3001/x')).rejects.toThrow(/redirect \(302\)/);
    });
});

describe('ssrfSafeFetch request shape', () => {
    it('never fetches when the host resolves privately', async () => {
        h.lookupResult = [{ address: '10.0.0.1', family: 4 }];
        respond(200);
        await expect(ssrfSafeFetch('https://internal.example/')).rejects.toThrow(/private\/reserved/);
        expect(h.fetchCalls).toHaveLength(0);
        expect(h.agents).toHaveLength(0);
    });

    it('defaults to GET with no init, and passes method/headers/body/signal through verbatim', async () => {
        respond(200);
        await ssrfSafeFetch('https://peer.example/a');
        expect(h.fetchCalls[0].init.method).toBe('GET');
        expect(h.fetchCalls[0].init.headers).toBeUndefined();

        const ac = new AbortController();
        await ssrfSafeFetch('https://peer.example/b', {
            method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/json' }, body: '{"a":1}', signal: ac.signal,
        });
        const init = h.fetchCalls[1].init;
        expect(h.fetchCalls[1].url).toBe('https://peer.example/b');
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ 'x-api-key': 'k', 'content-type': 'application/json' });
        expect(init.body).toBe('{"a":1}');
        expect(init.signal).toBe(ac.signal);
        expect(init.redirect).toBe('manual');
    });

    it('builds an HTTP/1.1-only pinning Agent with the wire ceiling and short keep-alive', async () => {
        respond(200);
        await ssrfSafeFetch('https://peer.example/a');
        expect(h.agents).toHaveLength(1);
        const opts = h.agents[0].opts;
        expect(opts.allowH2).toBe(false);
        expect(opts.maxResponseSize).toBe(MAX_OUTBOUND_RESPONSE_BYTES);
        expect(opts.keepAliveTimeout).toBe(1000);
        expect(opts.keepAliveMaxTimeout).toBe(1000);
        expect(h.fetchCalls[0].init.dispatcher).toBeDefined();
    });

    it('pins the FIRST vetted answer for both lookup callback shapes', async () => {
        h.lookupResult = [
            { address: '2606:4700::6810:84e5', family: 6 },
            { address: '104.16.132.229', family: 4 },
        ];
        respond(200);
        await ssrfSafeFetch('https://peer.example/a');
        const lookup = (h.agents[0].opts.connect as { lookup: (...a: unknown[]) => void }).lookup;
        const all = vi.fn();
        lookup('attacker-rebound.example', { all: true }, all);
        expect(all).toHaveBeenCalledWith(null, [{ address: '2606:4700::6810:84e5', family: 6 }]);
        const legacy = vi.fn();
        lookup('attacker-rebound.example', undefined, legacy);
        expect(legacy).toHaveBeenCalledWith(null, '2606:4700::6810:84e5', 6);
    });
});

describe('ssrfSafeFetch status refusal', () => {
    it.each([300, 301, 302, 303, 307, 308, 399])('refuses a %s redirect and cancels its body', async (status) => {
        const { body, state } = fakeBody();
        respond(status, { body, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
        await expect(ssrfSafeFetch('https://peer.example/x')).rejects.toThrow(`Peer responded with a redirect (${status})`);
        expect(state.bodyCancels).toBe(1);
        expect(state.reads).toBe(0);
    });

    it('still refuses the redirect when cancelling its body rejects', async () => {
        const { body, state } = fakeBody({ cancelRejects: true });
        respond(302, { body });
        await expect(ssrfSafeFetch('https://peer.example/x')).rejects.toThrow(/redirect \(302\)/);
        expect(state.bodyCancels).toBe(1);
        await flush();
        expect(unhandled).toEqual([]);
    });

    it('refuses a redirect with no body at all', async () => {
        respond(301);
        await expect(ssrfSafeFetch('https://peer.example/x')).rejects.toThrow(/redirect \(301\)/);
    });

    it.each([101, 103, 199, 600, 999])('refuses an out-of-range status %s with a clear error, cancelling the body', async (status) => {
        const { body, state } = fakeBody({ cancelRejects: status === 600 });
        respond(status, { body });
        await expect(ssrfSafeFetch('https://peer.example/x')).rejects.toThrow(`Peer responded with an invalid HTTP status (${status}) — refused`);
        expect(state.bodyCancels).toBe(1);
        await flush();
        expect(unhandled).toEqual([]);
    });

    it('refuses an out-of-range status with no body', async () => {
        respond(150);
        await expect(ssrfSafeFetch('https://peer.example/x')).rejects.toThrow(/invalid HTTP status \(150\)/);
    });
});

describe('ssrfSafeFetch decoded body ceiling', () => {
    const CHUNK = new Uint8Array(4 * 1024 * 1024);

    it('cancels the stream and throws once the DECODED bytes pass the ceiling', async () => {
        const { body, state } = fakeBody({ repeatChunk: CHUNK });
        respond(200, { body });
        await expect(ssrfSafeFetch('https://peer.example/bomb')).rejects.toThrow(
            `Peer response exceeds ${MAX_OUTBOUND_RESPONSE_BYTES} bytes once decoded — refused (SSRF guard)`,
        );
        // 16 MiB / 4 MiB = 4 chunks fit exactly; the 5th crosses and stops the read.
        expect(state.reads).toBe(5);
        expect(state.readerCancels).toBe(1);
    });

    it('still throws the ceiling error when the reader cancel rejects', async () => {
        const { body, state } = fakeBody({ repeatChunk: CHUNK, cancelRejects: true });
        respond(200, { body });
        await expect(ssrfSafeFetch('https://peer.example/bomb')).rejects.toThrow(/exceeds .* bytes once decoded/);
        expect(state.readerCancels).toBe(1);
        await flush();
        expect(unhandled).toEqual([]);
    });

    it('accepts a body of exactly the ceiling', async () => {
        const { body } = fakeBody({ chunks: [CHUNK, CHUNK, CHUNK, CHUNK] });
        respond(200, { body });
        const res = await ssrfSafeFetch('https://peer.example/big');
        expect(res.headers.get('content-length')).toBe(String(MAX_OUTBOUND_RESPONSE_BYTES));
        expect((await res.arrayBuffer()).byteLength).toBe(MAX_OUTBOUND_RESPONSE_BYTES);
    });
});

describe('ssrfSafeFetch rebuilt Response', () => {
    it('reassembles chunks in order, drops Content-Encoding and sets a truthful Content-Length', async () => {
        const enc = new TextEncoder();
        const { body } = fakeBody({ chunks: [enc.encode('{"hel'), enc.encode('lo":'), enc.encode('"wörld"}')] });
        respond(200, {
            body,
            statusText: 'OK',
            headers: { 'content-encoding': 'gzip', 'content-length': '12', 'content-type': 'application/json', 'x-peer': 'p1' },
        });
        const res = await ssrfSafeFetch('https://peer.example/j');
        expect(res.status).toBe(200);
        expect(res.statusText).toBe('OK');
        expect(res.headers.get('content-encoding')).toBeNull();
        expect(res.headers.get('content-type')).toBe('application/json');
        expect(res.headers.get('x-peer')).toBe('p1');
        const expected = enc.encode('{"hello":"wörld"}');
        expect(res.headers.get('content-length')).toBe(String(expected.byteLength));
        expect(await res.json()).toEqual({ hello: 'wörld' });
    });

    it('drops a stale Content-Length when the response has no body', async () => {
        respond(200, { headers: { 'content-length': '999' } });
        const res = await ssrfSafeFetch('https://peer.example/empty');
        expect(res.headers.get('content-length')).toBeNull();
        expect(res.body).toBeNull();
    });

    it.each([204, 205])('rebuilds a %s with a null body even if the peer sent bytes', async (status) => {
        const { body } = fakeBody({ chunks: [new TextEncoder().encode('junk')] });
        respond(status, { body });
        const res = await ssrfSafeFetch('https://peer.example/nc');
        expect(res.status).toBe(status);
        expect(res.body).toBeNull();
    });

    it('passes 4xx/5xx through (callers own error semantics) with their body', async () => {
        const { body } = fakeBody({ chunks: [new TextEncoder().encode('nope')] });
        respond(503, { body, statusText: 'Service Unavailable' });
        const res = await ssrfSafeFetch('https://peer.example/x');
        expect(res.status).toBe(503);
        expect(res.statusText).toBe('Service Unavailable');
        expect(await res.text()).toBe('nope');
    });

    it('strips characters a reason phrase may not hold instead of throwing', async () => {
        respond(200, { statusText: 'OK�\u0000  fine\tok' });
        const res = await ssrfSafeFetch('https://peer.example/x');
        expect(res.statusText).toBe('OK fine\tok');
    });

    it('defaults a missing reason phrase to empty', async () => {
        respond(200);
        const res = await ssrfSafeFetch('https://peer.example/x');
        expect(res.statusText).toBe('');
    });
});

describe('ssrfSafeFetch releases the per-call Agent', () => {
    it('closes the Agent after a successful fetch', async () => {
        respond(200);
        await ssrfSafeFetch('https://peer.example/x');
        expect(h.agents[0].closeCalls).toBe(1);
    });

    it('closes the Agent when the fetch itself throws, and propagates the error', async () => {
        h.fetchImpl = async () => { throw new TypeError('fetch failed'); };
        await expect(ssrfSafeFetch('https://peer.example/x')).rejects.toThrow('fetch failed');
        expect(h.agents[0].closeCalls).toBe(1);
    });

    it('closes the Agent on a refused redirect', async () => {
        respond(302);
        await expect(ssrfSafeFetch('https://peer.example/x')).rejects.toThrow(/redirect/);
        expect(h.agents[0].closeCalls).toBe(1);
    });

    it('swallows a rejecting close() — the response still resolves and nothing goes unhandled', async () => {
        h.closeRejects = true;
        respond(200, { body: fakeBody({ chunks: [new TextEncoder().encode('ok')] }).body });
        const res = await ssrfSafeFetch('https://peer.example/x');
        expect(await res.text()).toBe('ok');
        expect(h.agents[0].closeCalls).toBe(1);
        await flush();
        expect(unhandled).toEqual([]);
    });
});
