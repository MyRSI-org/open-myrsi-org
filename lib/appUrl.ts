// Resolves THIS deployment's own public origin — a pure predicate, extracted so
// the precedence decision it encodes can be tested directly (the lib/oauthState.ts
// / lib/selfHost.ts pattern).
//
// WHY IT EXISTS: the origin had two independent sources that disagreed. The DB row
// `settings.systemConfig.appUrl` used to WIN over `process.env.APP_URL`, so an org
// migrated to a new host (pg_dump/restore, or a new Supabase project) kept emitting
// Discord announcement deep links and an alliance pairing origin pointing at the OLD
// deployment, no matter what the operator put in `.env`. The only fix was hand-written
// SQL against the settings table.
//
// PRECEDENCE IS NOW ENV-FIRST, matching the rest of the project (lib/secrets.ts
// getOrgSecret is `process.env[key] || storedValue`, and .env.example says "ENV WINS"
// for the Discord / Gemini / LiveKit credentials). APP_URL is HOST-scoped config that
// travels with the deployment; the settings row is ORG data that survives a database
// restore onto a different host. When they disagree, the host is right.
//
// Candidates are validated INDEPENDENTLY and a bad one is SKIPPED, never returned —
// so a malformed `APP_URL` falls through to the stored value instead of poisoning
// every deep link. `.env.example` used to ship `APP_URL=https://yourdomain.com`
// populated, so a copied-but-unedited env file is a real population: placeholder and
// RFC 2606 reserved hostnames are rejected by HOSTNAME (not string equality), which
// also catches the half-edited near-misses (`http://yourdomain.com`,
// `https://www.yourdomain.com`, a trailing slash).
//
// Pure and dependency-free on purpose: callers pass the env value in, so the tests
// need no module mocking and no process.env juggling. Callers that need the stricter
// federation guarantees (public https only, SSRF-checked, dev loopback hatch) run the
// result through lib/db/alliances.ts validatePeerBaseUrl afterwards rather than having
// this module re-implement it.

/** Which candidate produced the resolved URL. */
export type AppUrlSource = 'env' | 'stored' | 'fallback';

/** Why a candidate was skipped. Surfaced at boot so a bad value is diagnosable. */
export type AppUrlRejection = 'unparseable' | 'not-http' | 'userinfo' | 'placeholder' | 'not-a-base';

export interface RejectedAppUrlCandidate {
    source: 'env' | 'stored';
    /**
     * The offending value, for the boot log. REDACTED for the `userinfo` rejection —
     * that reason fires precisely because the string contains a password, and the boot
     * diagnostic is written to stderr and shipped to log aggregators. Rule 5: don't
     * make the one rejection that means "this contains a secret" print the secret.
     * log.ts is no help here — it redacts by KEY, and value-scans only Errors and
     * stringified objects, never a plain string field.
     */
    value: string;
    reason: AppUrlRejection;
}

export interface ResolvedAppUrl {
    /** Base URL for building deep links. Trailing slashes stripped; path preserved. */
    url: string;
    source: AppUrlSource;
    /** Candidates that were present but skipped. Empty when everything was clean. */
    rejected: RejectedAppUrlCandidate[];
    /**
     * Both candidates were valid and disagree (after normalisation) — the migration
     * smell this whole module exists for. Reported at boot so the operator sees the
     * stale stored value instead of having to go looking for it in psql.
     */
    drift?: { env: string; stored: string };
}

/** Last resort when neither candidate is usable. Deliberately obvious in a log line. */
export const APP_URL_FALLBACK = 'http://localhost:3000';

// Hostnames that mean "nobody edited this". `yourdomain.com` is the placeholder
// .env.example and DEPLOYMENT_GUIDE.md ship; the rest are the RFC 2606 / RFC 6761
// reserved names, which can never be a real deployment.
const PLACEHOLDER_HOSTS = new Set([
    'yourdomain.com',
    'example.com',
    'example.net',
    'example.org',
]);
const PLACEHOLDER_TLDS = ['.example', '.invalid', '.test'];

function isPlaceholderHost(rawHostname: string): boolean {
    // A trailing dot is the fully-qualified form of the same name, so
    // `yourdomain.com.` must not slip past as if it were a different host.
    const hostname = rawHostname.toLowerCase().replace(/\.$/, '');
    if (PLACEHOLDER_HOSTS.has(hostname)) return true;
    // Sub-domains of the placeholder — `www.yourdomain.com`, `app.example.com`.
    for (const h of PLACEHOLDER_HOSTS) {
        if (hostname.endsWith(`.${h}`)) return true;
    }
    return PLACEHOLDER_TLDS.some(tld => hostname.endsWith(tld));
}

/**
 * Validate one candidate. Returns the normalised URL, or the reason it was skipped.
 * `null`/empty/whitespace is "not configured" rather than a rejection — it is the
 * ordinary case for an install that manages the origin from only one of the two
 * sources, and must not show up as a warning in the boot log.
 */
function checkCandidate(raw: unknown): { url: string } | { reason: AppUrlRejection; value: string } | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    let u: URL;
    try {
        u = new URL(trimmed);
    } catch {
        return { reason: 'unparseable', value: trimmed };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { reason: 'not-http', value: trimmed };
    // Credentials in the origin would be replayed into every Discord embed and
    // advertised to federation peers. Report a redacted form — see
    // RejectedAppUrlCandidate.value.
    if (u.username || u.password) return { reason: 'userinfo', value: `${u.protocol}//[redacted]@${u.host}${u.pathname}` };
    if (isPlaceholderHost(u.hostname)) return { reason: 'placeholder', value: trimmed };
    // A query or fragment can never be a valid BASE: every consumer concatenates onto
    // it (`${url}/operations/${id}`), so `https://host?x=1` would yield
    // `https://host?x=1/operations/42` — the path swallowed by the query string.
    if (u.search || u.hash) return { reason: 'not-a-base', value: trimmed };

    // Build the result from the PARSE, never from the operator's raw text. `new URL()`
    // is far more forgiving than string concatenation: `https:/host` (single-slash
    // typo) and `https:\\host` both parse, and returning them verbatim produced
    // `https:/host/operations/42` in a Discord embed — not a link to the host at all.
    // Going through u.origin also folds away the differences that made drift detection
    // fire on values that are in fact the same origin (scheme/host case, an explicit
    // :443 or :80). Trailing slashes are stripped here rather than at the call sites,
    // which used to each do their own ad-hoc `.replace(/\/$/, '')` (lib/db/system.ts on
    // write, api/actions/operations.ts on read, nothing at all on process.env).
    return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

/**
 * Resolve this deployment's public base URL.
 *
 * @param envValue     process.env.APP_URL
 * @param storedValue  settings.systemConfig.appUrl
 *
 * Always returns a usable string so no caller has to handle an empty origin — the
 * `source` field is what tells you whether the result is real configuration or the
 * localhost last resort.
 */
export function resolveAppUrl(envValue: unknown, storedValue: unknown): ResolvedAppUrl {
    const rejected: RejectedAppUrlCandidate[] = [];
    const accepted: Partial<Record<'env' | 'stored', string>> = {};

    // Check BOTH candidates before picking, so a valid-but-losing stored value is still
    // available for the drift report. Precedence is applied afterwards.
    for (const [source, raw] of [['env', envValue], ['stored', storedValue]] as const) {
        const checked = checkCandidate(raw);
        if (!checked) continue;
        if ('url' in checked) accepted[source] = checked.url;
        else rejected.push({ source, value: checked.value, reason: checked.reason });
    }

    const drift = accepted.env && accepted.stored && accepted.env !== accepted.stored
        ? { env: accepted.env, stored: accepted.stored }
        : undefined;

    // ENV FIRST — the whole point of this module.
    if (accepted.env) return { url: accepted.env, source: 'env', rejected, drift };
    if (accepted.stored) return { url: accepted.stored, source: 'stored', rejected, drift };
    return { url: APP_URL_FALLBACK, source: 'fallback', rejected, drift };
}
