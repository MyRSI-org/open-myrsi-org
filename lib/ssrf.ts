// Server-side SSRF guard for OUTBOUND fetches to operator/peer-supplied URLs
// (alliance federation, intel feeds). sanitizePublicLinkUrl() blocks LITERAL
// private IPs and local hostnames, but a hostname like `internal.evil.example`
// can still RESOLVE to 10.0.0.1 (or ::1). Before fetching a peer URL — a request
// that carries our outbound API key — resolve the host and reject any private /
// reserved address.
//
// Use ssrfSafeFetch() below for EVERY outbound request to an operator/peer-
// influenced URL. It is the single place that:
//   - refuses redirects — undici's default follows up to 20 hops WITHOUT
//     re-running this guard, so a paired-but-hostile peer could 302 our
//     credentialed request to 169.254.169.254 / 10.x and exfiltrate the key;
//   - pins the vetted DNS answer into the connection — a TTL-0 rebind between
//     the check and the connect cannot re-route us. TLS SNI + cert validation
//     still run against the original hostname;
//   - caps the response body AFTER Content-Encoding is decoded, so a small
//     gzip/br/zstd bomb cannot inflate past the ceiling.
// Do NOT call bare fetch() against peer/feed URLs — that re-opens all three holes.

import { lookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { isPrivateIpv4, isPrivateIpv6Address } from './linkUrl.js';

// Cap the response body centrally so every outbound peer/feed fetch inherits the
// ceiling — consumers do an unbounded res.json()/res.text() afterwards and a
// hostile peer streaming GBs would OOM us (several of these run unattended on
// cron). Enforced twice: on the wire by the pinning Agent's maxResponseSize, and
// on the DECODED body by readCappedBody(). The second is the one that holds:
// undici counts maxResponseSize against wire bytes before fetch decodes
// Content-Encoding, and a server picks the encoding whatever we ask for, so
// 65 KB of gzip inflated to 64 MB straight past a 1 MB maxResponseSize (verified
// against undici 8.12.3). Generous so no legitimate peer payload is truncated.
export const MAX_OUTBOUND_RESPONSE_BYTES = 16 * 1024 * 1024;

// Statuses whose Response must carry a null body (the constructor throws otherwise).
const NULL_BODY_STATUSES = new Set([204, 205]);

/**
 * Reads `res`'s DECODED body, counting bytes as they arrive, and throws once the
 * count passes `limit`, cancelling the stream so the rest is never read or
 * inflated. Null when the response has no body.
 */
async function readCappedBody(res: Response, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`Peer response exceeds ${limit} bytes once decoded — refused (SSRF guard)`);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
    return out;
}

/** Dev-only escape hatch matching validatePeerBaseUrl()'s loopback bypass. */
function devLoopbackAllowed(): boolean {
    return process.env.NODE_ENV !== 'production' && process.env.ALLIANCE_DEV_ALLOW_LOOPBACK === '1';
}

export interface ResolvedAddress { address: string; family: number }

/**
 * Throws if `urlOrOrigin`'s hostname resolves to a private/reserved address.
 * Returns the vetted addresses so callers (ssrfSafeFetch) can PIN the
 * connection to them. Returns [] when the dev loopback bypass is enabled
 * (local two-instance testing — no pinning).
 */
export async function assertResolvesToPublicHost(urlOrOrigin: string): Promise<ResolvedAddress[]> {
    if (devLoopbackAllowed()) return [];

    let host: string;
    try {
        host = new URL(urlOrOrigin).hostname;
    } catch {
        throw new Error('Invalid peer URL');
    }
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

    let results: Array<{ address: string; family: number }>;
    try {
        results = await lookup(bare, { all: true });
    } catch {
        throw new Error('Peer host did not resolve');
    }
    if (results.length === 0) throw new Error('Peer host did not resolve');

    for (const r of results) {
        if (r.family === 4 && isPrivateIpv4(r.address)) {
            throw new Error('Peer host resolves to a private/reserved address');
        }
        if (r.family === 6 && isPrivateIpv6Address(r.address)) {
            throw new Error('Peer host resolves to a private/reserved address');
        }
    }
    return results;
}

export interface SsrfSafeFetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}

/**
 * The one true outbound fetch for operator/peer-supplied URLs (see header).
 * Callers own scheme/shape validation of the URL (validatePeerBaseUrl /
 * sanitizePublicLinkUrl) and the abort signal / timeout; this helper owns
 * resolve-validate-pin, the no-redirect policy and the body ceiling. 3xx
 * responses are a hard error — federation peers and feeds are our own software
 * and never redirect legitimately.
 *
 * The body is read here, decoded and capped, before this resolves: callers get
 * an in-memory Response (no Content-Encoding, a truthful Content-Length), and
 * their abort signal bounds the whole body read, not just the headers.
 */
export async function ssrfSafeFetch(url: string, init?: SsrfSafeFetchInit): Promise<Response> {
    const vetted = await assertResolvesToPublicHost(url);

    // Pin the first vetted address. Empty list = dev loopback bypass — no
    // pinning, but the no-redirect policy below still applies.
    let dispatcher: Agent | undefined;
    if (vetted.length > 0) {
        const pin = vetted[0];
        dispatcher = new Agent({
            // One Agent per call (the pin differs per peer) — close idle
            // sockets quickly instead of hoarding keep-alive connections.
            keepAliveTimeout: 1000,
            keepAliveMaxTimeout: 1000,
            // undici 8 flips allowH2 to true by default; keep this guard on
            // HTTP/1.1 only. A hostile peer must not be able to ALPN-negotiate
            // HTTP/2 on our credentialed outbound request — the IP-pin and
            // redirect refusal below are written and tested against h1.
            allowH2: false,
            // Wire-level ceiling: undici aborts + errors once the still-encoded
            // body exceeds this. It counts bytes BEFORE decoding, so it is only
            // the early stop; readCappedBody() below caps the decoded body.
            maxResponseSize: MAX_OUTBOUND_RESPONSE_BYTES,
            connect: {
                // net/tls call lookup with either (err, addresses[]) [all:true,
                // modern Node] or (err, address, family) — handle both shapes.
                lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
                    if (options && options.all) callback(null, [pin]);
                    else callback(null, pin.address, pin.family);
                }) as unknown as import('node:net').LookupFunction,
            },
        });
    }

    try {
        // undici's OWN fetch, not Node's global fetch: the pinning `dispatcher`
        // Agent is from the node_modules undici (v8), and passing it to Node's
        // built-in fetch (a different internal undici) throws `invalid
        // onRequestStart method`. fetch + Agent must be the same undici copy.
        const res = await undiciFetch(url, {
            method: init?.method || 'GET',
            headers: init?.headers,
            body: init?.body,
            signal: init?.signal,
            redirect: 'manual',
            // undici extension — routes the request through the pinning Agent.
            ...(dispatcher ? { dispatcher } : {}),
        } as any) as unknown as Response;

        // Every refusal before the body is read cancels it first. An unread body keeps
        // the socket and the per-call Agent alive for as long as the peer cares to
        // keep sending: undici suspends bodyTimeout while the stream is paused, and
        // dispatcher.close() waits for the in-flight request.
        if (res.status >= 300 && res.status < 400) {
            await res.body?.cancel().catch(() => undefined);
            throw new Error(`Peer responded with a redirect (${res.status}) — refused (SSRF guard)`);
        }
        // undici passes through any 3-digit status, but a Response can only be
        // rebuilt with 200-599. Refuse anything else with a clear error rather than
        // let the constructor's RangeError surface instead.
        if (res.status < 200 || res.status > 599) {
            await res.body?.cancel().catch(() => undefined);
            throw new Error(`Peer responded with an invalid HTTP status (${res.status}) — refused`);
        }
        const body = await readCappedBody(res, MAX_OUTBOUND_RESPONSE_BYTES);
        const headers = new Headers(res.headers);
        // The body is already decoded: drop the wire encoding, and make the length
        // describe these bytes, not the compressed ones a caller might pre-check.
        headers.delete('content-encoding');
        if (body) headers.set('content-length', String(body.byteLength));
        else headers.delete('content-length');
        return new Response(NULL_BODY_STATUSES.has(res.status) ? null : body, {
            status: res.status,
            // undici decodes the reason phrase as UTF-8, so a raw Latin-1 byte arrives
            // as U+FFFD, which the Response constructor rejects. Keep only the
            // characters a reason phrase may hold (HTAB, SP, VCHAR, obs-text).
            statusText: (res.statusText || '').replace(/[^\t\x20-\x7e\x80-\xff]/g, ''),
            headers,
        });
    } finally {
        // Release the per-call pinning Agent's sockets promptly (it is unique to
        // this request's vetted IP and never reused). Best-effort.
        void dispatcher?.close().catch(() => undefined);
    }
}
