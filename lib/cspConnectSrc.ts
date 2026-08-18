// Pure builder for the CSP `connect-src` allow-list.
//
// Extracted from server.ts so the rule can be tested directly instead of by
// grepping the source — the same reasoning as lib/oauthState.ts: a refactor of
// the header middleware must not be able to quietly widen this list.
//
// Why it matters: `connect-src` is what stops an injected script from shipping
// the session token somewhere. A bare `https:` allows every origin on the web. A
// platform wildcard such as `https://*.supabase.co` is narrower but still wrong —
// it matches EVERY project on that platform, and anyone can register a free one,
// so an attacker-controlled `<their-project>.supabase.co` remains a valid
// exfiltration target. Pin the exact configured host whenever it is known.

/**
 * The https + wss forms of a configured host.
 * Returns [] when the value is absent or unparseable, so the caller decides the
 * fallback rather than silently emitting a broken directive.
 */
export function originVariants(rawUrl: string | undefined | null): string[] {
    if (!rawUrl) return [];
    try {
        const { host } = new URL(rawUrl);
        return host ? [`https://${host}`, `wss://${host}`] : [];
    } catch {
        return [];
    }
}

export interface ConnectSrcInput {
    /** SUPABASE_URL — required for the server to boot, so this is effectively always set. */
    supabaseUrl?: string | undefined;
    /**
     * LIVEKIT_URL — may instead live in the admin-console settings row, which the
     * module-level header cannot read. Unset here means the wildcard fallback is
     * genuinely in play.
     */
    livekitUrl?: string | undefined;
}

/** Platform fallbacks, used ONLY when the exact origin is unknown. */
export const SUPABASE_WILDCARD = ['https://*.supabase.co', 'wss://*.supabase.co'];
export const LIVEKIT_WILDCARD = ['https://*.livekit.cloud', 'wss://*.livekit.cloud'];

export function buildConnectSrc({ supabaseUrl, livekitUrl }: ConnectSrcInput): string {
    const supabase = originVariants(supabaseUrl);
    const livekit = originVariants(livekitUrl);
    return [
        "'self'",
        ...(supabase.length ? supabase : SUPABASE_WILDCARD),
        ...(livekit.length ? livekit : LIVEKIT_WILDCARD),
        'https://cloudflareinsights.com',
    ].filter(Boolean).join(' ');
}
