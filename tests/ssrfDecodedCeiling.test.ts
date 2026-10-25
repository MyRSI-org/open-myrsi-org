// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

// undici's maxResponseSize counts WIRE bytes, before fetch decodes Content-Encoding, and the
// server picks the encoding whatever we ask for. So 65 KB of gzip inflated to 64 MB straight past
// a 1 MB maxResponseSize (verified against undici 8.12.3), and every caller then res.json()'d it.
// ssrfSafeFetch now caps the DECODED body itself. These run the production path for real (the
// pinning Agent, the IP pin, undici's fetch and its decoders) against a loopback server. Only DNS
// and the private-IP predicate are stubbed, so the vetted pin can be 127.0.0.1.

vi.mock('node:dns/promises', () => {
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    return { lookup, default: { lookup } };
});
vi.mock('../lib/linkUrl', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/linkUrl')>()),
    isPrivateIpv4: () => false,
    isPrivateIpv6Address: () => false,
}));

import { ssrfSafeFetch, MAX_OUTBOUND_RESPONSE_BYTES } from '../lib/ssrf';

const OVER = MAX_OUTBOUND_RESPONSE_BYTES + 1024 * 1024;

let server: Server | NetServer | undefined;
const rawSockets = new Set<Socket>();
// Resolves when the server sees the latest response's connection close.
let responseClosed: Promise<void> = Promise.resolve();
afterEach(async () => {
    if (!server) return;
    if ('closeAllConnections' in server) server.closeAllConnections();
    for (const s of rawSockets) s.destroy();
    rawSockets.clear();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
});

/** Serves every request with `handler`; resolves to a URL whose host is pinned to 127.0.0.1. */
async function serve(handler: (res: ServerResponse) => void): Promise<string> {
    server = createServer((_req, res) => {
        res.on('error', () => undefined); // the client cancelling mid-body is expected here
        responseClosed = new Promise((r) => res.on('close', () => r()));
        handler(res);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return `http://peer.example:${(server.address() as AddressInfo).port}/api/alliance/profile`;
}

/** Answers every request with `raw` bytes verbatim, for status lines node:http won't write. */
async function serveRaw(raw: Buffer): Promise<string> {
    const s = createNetServer((sock) => {
        rawSockets.add(sock);
        sock.on('error', () => undefined);
        sock.once('data', () => sock.end(raw));
    });
    server = s;
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return `http://peer.example:${(s.address() as AddressInfo).port}/api/alliance/profile`;
}

/** The refused body must be cancelled, not merely left unread: without the cancel the socket and
 *  the per-call Agent stay open for as long as the peer keeps sending. */
async function expectConnectionClosedSoon(): Promise<void> {
    const timedOut = Symbol('timed out');
    const winner = await Promise.race([
        responseClosed.then(() => 'closed'),
        new Promise((r) => setTimeout(() => r(timedOut), 2000)),
    ]);
    expect(winner, 'server-side connection still open 2s after the refusal').toBe('closed');
}

/** An endless stream of zeros, piped through `encoder` when one is given. */
function endless(res: ServerResponse, encoder?: zlib.Gzip) {
    const zeros = new Readable({ read() { this.push(Buffer.alloc(64 * 1024)); } });
    res.on('close', () => { zeros.destroy(); encoder?.destroy(); });
    if (!encoder) { zeros.pipe(res); return; }
    encoder.on('error', () => undefined);
    zeros.pipe(encoder).pipe(res);
}

describe('ssrfSafeFetch caps the DECODED response body', () => {
    it('refuses a gzip bomb that is far under the ceiling on the wire', async () => {
        const wire = zlib.gzipSync(Buffer.alloc(OVER));
        expect(wire.length).toBeLessThan(MAX_OUTBOUND_RESPONSE_BYTES / 100); // tiny on the wire
        const url = await serve((res) => {
            res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': wire.length });
            res.end(wire);
        });
        await expect(ssrfSafeFetch(url)).rejects.toThrow(/once decoded/);
    });

    it('refuses a brotli bomb the same way', async () => {
        const wire = zlib.brotliCompressSync(Buffer.alloc(OVER));
        const url = await serve((res) => {
            res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' });
            res.end(wire);
        });
        await expect(ssrfSafeFetch(url)).rejects.toThrow(/once decoded/);
    });

    it('stops reading an endless compressed stream and closes the connection', async () => {
        // Never ends: unless the read is cut off at the ceiling, this hangs (or exhausts memory).
        const url = await serve((res) => {
            res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
            endless(res, zlib.createGzip());
        });
        await expect(ssrfSafeFetch(url)).rejects.toThrow(/once decoded/);
        await expectConnectionClosedSoon();
    }, 10_000);

    it('refuses an uncompressed body over the ceiling', async () => {
        const url = await serve((res) => {
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            res.end(Buffer.alloc(OVER));
        });
        await expect(ssrfSafeFetch(url)).rejects.toThrow();
    });

    it('hands back a decoded, in-memory body with truthful headers for a normal compressed reply', async () => {
        const payload = { name: 'Peer Org', members: Array.from({ length: 50 }, (_, i) => `m${i}`) };
        const decoded = Buffer.from(JSON.stringify(payload));
        const wire = zlib.gzipSync(decoded);
        const url = await serve((res) => {
            res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': wire.length });
            res.end(wire);
        });
        const res = await ssrfSafeFetch(url);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-encoding')).toBeNull();
        expect(res.headers.get('content-length')).toBe(String(decoded.length));
        expect(res.headers.get('content-type')).toBe('application/json');
        await expect(res.json()).resolves.toEqual(payload);
    });

    it('passes a body-less 204 through', async () => {
        const url = await serve((res) => { res.writeHead(204); res.end(); });
        const res = await ssrfSafeFetch(url);
        expect(res.status).toBe(204);
        expect(res.body).toBeNull();
    });

    it('keeps refusing redirects', async () => {
        const url = await serve((res) => { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); });
        await expect(ssrfSafeFetch(url)).rejects.toThrow(/redirect/i);
    });

    it('cancels the body of a refused redirect instead of leaving the connection open', async () => {
        const url = await serve((res) => {
            res.writeHead(302, { location: 'http://169.254.169.254/', 'content-type': 'text/plain' });
            endless(res);
        });
        await expect(ssrfSafeFetch(url)).rejects.toThrow(/redirect/i);
        await expectConnectionClosedSoon();
    }, 10_000);

    // undici decodes the reason phrase as UTF-8, so a raw Latin-1 byte becomes U+FFFD, which the
    // Response constructor rejects. Such a reply must still come through as the HTTP status it is
    // (intel feed sync backs a peer off on a transport failure, not on a 404).
    it.each([[404, 'nope'], [200, 'ok']])('passes a %i with a Latin-1 reason phrase through', async (status, text) => {
        const url = await serveRaw(Buffer.concat([
            Buffer.from(`HTTP/1.1 ${status} Non trouv`), Buffer.from([0xe9]),
            Buffer.from(`\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\nConnection: close\r\n\r\n${text}`),
        ]));
        const res = await ssrfSafeFetch(url);
        expect(res.status).toBe(status);
        expect(res.statusText).toBe('Non trouv');
        await expect(res.text()).resolves.toBe(text);
    });

    it('refuses a status a Response cannot carry with a clear error', async () => {
        const url = await serveRaw(Buffer.from('HTTP/1.1 600 Weird\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
        await expect(ssrfSafeFetch(url)).rejects.toThrow(/invalid HTTP status \(600\)/);
    });
});
