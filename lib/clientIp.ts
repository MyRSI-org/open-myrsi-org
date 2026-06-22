import type { Request } from 'express';

/**
 * Resolve the originating client IP for IP-keyed security controls (abuse
 * blackhole, scanner counter, auth/action rate limiters).
 *
 * These controls are only as strong as the IP resolution. Blindly trusting
 * `CF-Connecting-IP` / first-hop `X-Forwarded-For` from any caller would let a
 * client reaching the origin directly spoof a fresh IP per request (a new 60s
 * rate-limit bucket each, defeating the 10/min auth shield) or frame a victim IP
 * into the blackhole (collateral DoS).
 *
 * Trust model (explicit, opt-in via env):
 *  - `TRUST_CF_PROXY=1` — the operator asserts the origin is reachable ONLY
 *    through Cloudflare (tunnel / origin allow-list): honor CF-Connecting-IP,
 *    which Cloudflare always sets/overwrites at its edge. Do NOT set this if
 *    the origin is directly reachable — a direct caller could then spoof it.
 *  - otherwise — CF-Connecting-IP is IGNORED and we use Express's `req.ip`,
 *    which resolves X-Forwarded-For against `trust proxy` (TRUST_PROXY_HOPS).
 *    SECURE DEFAULT: 0 = trust no forwarded header and use the real TCP socket
 *    peer (unspoofable), which is correct for a directly-exposed Node. Operators
 *    behind a reverse proxy set TRUST_PROXY_HOPS to the number of proxies in
 *    front (1 for a single TLS terminator, 2+ for CDN→LB→app) so req.ip becomes
 *    the real client rather than the proxy.
 *
 * Never hand-parse X-Forwarded-For here: taking the FIRST (leftmost) hop
 * trusts a client-controlled value; rightmost-trusted resolution is exactly
 * what `trust proxy` implements.
 *
 * Returns 'unknown' when nothing identifies the caller — IP-keyed limiters
 * treat that as a missing signal (such callers collapse into one shared
 * bucket; the auth limiter deliberately fails open on it).
 *
 * Shared between the top-of-stack abuse blackhole + express-rate-limit
 * keyGenerators (server.ts) and the services dispatcher's per-action rate
 * limits (api/services.ts) so every control agrees on the IP key for a given
 * request — one resolver, one trust decision.
 */
export function getClientIp(req: Request): string {
    if (process.env.TRUST_CF_PROXY === '1') {
        const cf = req.headers['cf-connecting-ip'];
        if (typeof cf === 'string' && cf) return cf;
    }
    return req.ip || 'unknown';
}
