// Cross-site request forgery check for the cookie-authenticated surfaces.
//
// A cookie is attached by the browser to every request to this origin, whoever caused it — that
// is the whole CSRF surface, and it is one the Authorization-header scheme did not have.
// `SameSite=Lax` is a partial control only: it still permits top-level GET navigation, and this
// app's reads are GETs on /api/query. So the cookie path also demands positive evidence that the
// request came from our own origin.
//
// Pure predicate, no imports, so it unit-tests without any mocking and compiles under both
// tsconfigs. The WIRING (which paths it guards) is pinned separately by a source-text assertion,
// because a predicate nothing calls is not a control.

export interface OriginCheckInput {
    method: string;
    /** The `Origin` request header, if any. */
    origin: string | null | undefined;
    /** The `Sec-Fetch-Site` request header, if any. */
    secFetchSite: string | null | undefined;
    /** This deployment's own origin(s), e.g. ['https://org.example']. */
    allowedOrigins: readonly string[];
}

export type OriginVerdict = 'allow' | 'deny';

/**
 * Sec-Fetch-Site values that mean "this request was caused by our own page".
 *   same-origin — a fetch from our page.
 *   none        — the user typed the URL, used a bookmark, or opened it directly.
 * `cross-site` and `same-site` are both refused: this is a single-hostname deployment, so a
 * same-site-but-different-host request has no legitimate source.
 */
const SAFE_FETCH_SITES = new Set(['same-origin', 'none']);

/**
 * May this request proceed on a cookie credential?
 *
 * The header evidence is checked in order of reliability. `Sec-Fetch-Site` is set by the browser
 * and cannot be forged by page script, so it is the strongest signal available; `Origin` is the
 * fallback for browsers that do not send it.
 *
 * WHEN BOTH ARE ABSENT the answer depends on the method, and the asymmetry is deliberate:
 *   - A state-changing request (POST/PUT/PATCH/DELETE) is DENIED. Modern browsers always send
 *     `Origin` on those, so an absent one is not a browser doing something ordinary.
 *   - A GET/HEAD is ALLOWED. `Sec-Fetch-Site` is the only signal on a GET, and requiring it
 *     would lock out Safari below 16.4 entirely — every read in the app would 403 for those
 *     users, with no way for them to tell why. A forged cross-site GET still cannot read the
 *     response (the same-origin policy stops that); the risk it leaves is a state change hidden
 *     behind a GET, and this API has none — every mutation goes through POST /api/services.
 */
export function checkRequestOrigin(input: OriginCheckInput): OriginVerdict {
    const method = (input.method || 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';

    const site = typeof input.secFetchSite === 'string' ? input.secFetchSite.toLowerCase() : null;
    if (site) return SAFE_FETCH_SITES.has(site) ? 'allow' : 'deny';

    const origin = typeof input.origin === 'string' && input.origin ? input.origin : null;
    if (origin) {
        // 'null' is what a sandboxed iframe or a privacy-stripped request sends. It is not one
        // of ours, and treating it as absent would let it fall through to the read fail-open.
        if (origin === 'null') return 'deny';
        return input.allowedOrigins.includes(origin) ? 'allow' : 'deny';
    }

    return isRead ? 'allow' : 'deny';
}

/**
 * The origins that count as ours.
 *
 * Derived from the request's own Host and scheme rather than configured, so an operator has
 * nothing to set and cannot get it wrong — and so a deployment reachable on more than one
 * hostname keeps working. The configured public origin is included when present, which covers a
 * proxy that rewrites Host.
 */
export function allowedOriginsFor(host: string | null | undefined, secure: boolean, appUrl?: string | null): string[] {
    const out: string[] = [];
    if (typeof host === 'string' && host) {
        out.push(`${secure ? 'https' : 'http'}://${host}`);
        // A proxy may terminate TLS and forward the same Host over plain HTTP, or vice versa;
        // accept both schemes for our own hostname rather than 403 an entire deployment over a
        // header the operator does not control.
        out.push(`${secure ? 'http' : 'https'}://${host}`);
    }
    if (typeof appUrl === 'string' && appUrl) {
        try { out.push(new URL(appUrl).origin); } catch { /* unparseable configured origin */ }
    }
    return out;
}
