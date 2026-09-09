// What a key-authenticated caller is allowed to reach.
//
// There are exactly two key-authenticated surfaces, and until now the separation between them
// was incidental rather than declared: the intel feed refused a key whose LABEL began
// `alliance:`, and federation accepted a key only if some peer row's inbound_key_id pointed at
// it AND that peer was Active. Two one-directional gates, in two files, neither aware of the
// other. This replaces them with one declared capability that any future third surface has to
// name explicitly rather than inherit by omission.
//
// Dependency-free (no imports), so it compiles under both tsconfigs and the admin UI can import
// the scope list directly instead of round-tripping it through an RPC.

/** 'feed' — the read-only intel feed (GET /api/query?target=feed).
 *  'alliance' — server-to-server federation (/api/alliance/*), the higher-privilege surface. */
export const API_KEY_SCOPES = ['feed', 'alliance'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
    feed: 'Intel feed (read-only)',
    alliance: 'Alliance federation',
};

/**
 * May a key with these stored scopes reach `want`?
 *
 * NULL / absent is GRANDFATHERED to every surface. That is a deliberate, bounded fail-open and
 * the alternative is worse in both directions: refusing NULL breaks every live federation
 * pairing the instant the operator deploys, and treating the column as advisory forever makes
 * it decorative. Repair Database converts existing NULLs to explicit arrays, after which this
 * branch only serves a row written by an older build.
 *
 * The Array.isArray guard is load-bearing, not defensive noise. `scopes` arrives from the
 * database as `unknown`; if a row ever held the STRING 'alliance', a bare `.includes('feed')`
 * would be a substring test — and 'alliance' does not contain 'feed', but 'feed-only' would
 * contain 'feed'. A scope check that can be satisfied by a substring is not a scope check.
 */
export function keyHasScope(scopes: unknown, want: ApiKeyScope): boolean {
    if (scopes === null || scopes === undefined) return true; // pre-scopes key
    if (!Array.isArray(scopes)) return false;                 // malformed → fail closed
    if (scopes.length === 0) return false;                    // explicitly scoped to nothing
    return scopes.includes(want);
}

/** Normalise operator input to the known set. Unknown values are dropped rather than stored, so
 *  a typo cannot create a scope that nothing will ever check. Empty result = no surfaces. */
export function normalizeScopes(input: unknown): ApiKeyScope[] {
    if (!Array.isArray(input)) return [];
    const out: ApiKeyScope[] = [];
    for (const v of input) {
        if (typeof v !== 'string') continue;
        const match = API_KEY_SCOPES.find(s => s === v);
        if (match && !out.includes(match)) out.push(match);
    }
    return out;
}

/** Is a key past its expiry? NULL expiry = never expires. An unparseable value is treated as
 *  EXPIRED: a date we cannot read is not a date we should honour. */
export function isKeyExpired(expiresAt: unknown, now: number = Date.now()): boolean {
    if (expiresAt === null || expiresAt === undefined || expiresAt === '') return false;
    if (typeof expiresAt !== 'string') return true;
    const t = new Date(expiresAt).getTime();
    if (!Number.isFinite(t)) return true;
    return t <= now;
}
