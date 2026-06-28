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
//     still run against the original hostname.
// Do NOT call bare fetch() against peer/feed URLs — that re-opens both holes.

import { lookup } from 'node:dns/promises';
import { Agent } from 'undici';
import { isPrivateIpv4, isPrivateIpv6Address } from './linkUrl.js';

// Cap the response body centrally on the pinning dispatcher so every outbound
// peer/feed fetch inherits the ceiling — consumers do an unbounded res.json()/
// res.text() afterwards and a hostile peer streaming GBs would OOM us (several
// of these run unattended on cron). undici aborts + errors once the body exceeds
// maxResponseSize. Generous so no legitimate peer payload is truncated.
export const MAX_OUTBOUND_RESPONSE_BYTES = 16 * 1024 * 1024;

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
 * resolve-validate-pin and the no-redirect policy. 3xx responses are a hard
 * error — federation peers and feeds are our own software and never redirect
 * legitimately.
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
            // Central response-byte ceiling: undici aborts + errors once the
            // body exceeds this, so callers' downstream res.json()/res.text()
            // can never buffer a hostile peer's giant body.
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
        const res = await fetch(url, {
            method: init?.method || 'GET',
            headers: init?.headers,
            body: init?.body,
            signal: init?.signal,
            redirect: 'manual',
            // undici extension — routes the request through the pinning Agent.
            ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);

        if (res.status >= 300 && res.status < 400) {
            throw new Error(`Peer responded with a redirect (${res.status}) — refused (SSRF guard)`);
        }
        return res;
    } finally {
        // Release the per-call pinning Agent's sockets promptly (it is unique to
        // this request's vetted IP and never reused). Best-effort.
        void dispatcher?.close().catch(() => undefined);
    }
}
