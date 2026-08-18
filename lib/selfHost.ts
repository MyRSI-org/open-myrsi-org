// "Is this feed URL pointing at THIS instance?" — a pure predicate, extracted so
// the trust decision it gates can be tested directly (the lib/oauthState.ts
// pattern).
//
// Why it exists: the intel feed sync can resolve a feed that lives on this very
// deployment through a direct DB read instead of an HTTP round-trip, because
// loopback HTTP is unreliable in containerised deployments. That shortcut is a
// TRUST BOUNDARY — taking it means skipping ssrfSafeFetch and substituting a
// privileged local read whose result is then ingested as if the remote peer had
// served it.
//
// The previous test was a substring match over the WHOLE constructed URL:
//     url.toLowerCase().includes('.myrsi.org') || ...includes('localhost')
// which matches the path, query, fragment, userinfo, or an unrelated registrable
// domain — so `https://evil.example/feed?x=.myrsi.org` and
// `https://notmyrsi.org.evil.com/feed` both read as "local". It is also wrong in
// the benign direction: a SIBLING `*.myrsi.org` deployment is a different
// database entirely and must be fetched over HTTP, but matched the suffix.
//
// So: compare the parsed HOSTNAME against this instance's own host, never a
// platform suffix. Unparseable input is not local (fail closed — the caller then
// takes the ordinary, SSRF-guarded HTTP path).

/** Hosts that always mean "this machine". */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostOf(rawUrl: string | null | undefined): string | null {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    try {
        const h = new URL(rawUrl).hostname.toLowerCase();
        return h || null;
    } catch {
        return null;
    }
}

/**
 * True when `feedUrl` resolves to this deployment.
 *
 * @param feedUrl  the fully constructed feed URL
 * @param selfUrl  this instance's own base URL (APP_URL / the configured appUrl).
 *                 When unset, only loopback hosts count as local — the safe
 *                 default, since the alternative is trusting a guess.
 */
export function isSelfHostedUrl(feedUrl: string | null | undefined, selfUrl: string | null | undefined): boolean {
    const feedHost = hostOf(feedUrl);
    if (!feedHost) return false;
    if (LOOPBACK_HOSTS.has(feedHost)) return true;
    const selfHost = hostOf(selfUrl);
    if (!selfHost) return false;
    return feedHost === selfHost;
}
