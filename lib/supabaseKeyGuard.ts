// Is this Supabase key safe to hand to a browser?
//
// SUPABASE_ANON_KEY is PUBLISHED: target=config and every target=initial-state response ship it
// to whoever asks, logged in or not. Nothing used to check what it actually was, so an operator
// who pasted the service-role key into the wrong box handed every visitor a key that bypasses
// RLS entirely — the one control that keeps a leaked browser key reading nothing. Presence was
// the only thing ever validated (lib/supabaseServer.ts), and presence is not the question.
//
// ALLOW-LIST, NOT DENY-LIST. A key is browser-safe only when it positively identifies itself as
// a public key: a new-style `sb_publishable_` key, or a legacy JWT whose `role` claim is `anon`.
// Anything else — an `sb_secret_` key, a service_role JWT, the service-role value itself, an
// unrecognised format, an empty string — is refused. A future key format we have never seen
// fails closed until someone teaches this file about it, which is the right way round: the cost
// of a false refusal is that realtime stays off; the cost of a false accept is the database.
// That allow-list is what the PER-REQUEST egress uses (api/query.ts isBrowserSafeSupabaseKey):
// every non-publishable value is withheld from every response, recognised or not.
//
// BOOT IS TIERED SEPARATELY (isSecretSupabaseKeyProblem below). Refusing to start is reserved for
// a value that positively IS a secret key — the service-role value, an `sb_secret_` key, a JWT
// with a non-anon role — because that is the paste-into-the-wrong-box mistake worth an outage.
// An unrecognised value (the .env.example placeholder, a typo) is not exploitable — the egress
// above never sends it — so boot logs an error, Database Tools shows a warning, and the server
// starts with live updates off. The two questions are deliberately different functions: never
// use the boot predicate to decide what may reach a browser.
//
// DEPENDENCY-FREE ON PURPOSE (no node:buffer, no app imports), so it compiles under both
// tsconfigs and unit-tests without mocking. `atob` is a global in Node and in browsers.

export type SupabaseKeyProblem =
    | 'missing'
    | 'same as SUPABASE_SERVICE_ROLE_KEY'
    | 'is a secret key (sb_secret_)'
    | 'is a JWT whose role claim is not "anon"'
    | 'is not a recognised publishable key format';

/** The `role` claim of a three-part JWT, or null when the value is not a decodable JWT. Never
 *  verifies the signature: the value comes from the operator's own environment, and the
 *  question is which KIND of key they configured, not whether Supabase would accept it. */
function jwtRoleClaim(token: string): string | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload: unknown = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
        const role = (payload as { role?: unknown }).role;
        return typeof role === 'string' ? role : null;
    } catch {
        return null;
    }
}

/**
 * Why this key must not reach a browser, or null when it may. Fixed strings only — the key, or
 * any part of it, is never echoed, so the result is safe to log.
 */
export function supabaseKeyProblem(anonKey: string | null | undefined, serviceRoleKey: string | null | undefined): SupabaseKeyProblem | null {
    const key = typeof anonKey === 'string' ? anonKey.trim() : '';
    if (!key) return 'missing';
    // Before any format rule: whatever the service-role key looks like, its own value is never
    // publishable, including a format this file does not yet recognise.
    const service = typeof serviceRoleKey === 'string' ? serviceRoleKey.trim() : '';
    if (service && key === service) return 'same as SUPABASE_SERVICE_ROLE_KEY';
    if (key.startsWith('sb_secret_')) return 'is a secret key (sb_secret_)';
    if (key.startsWith('sb_publishable_')) return null;
    const role = jwtRoleClaim(key);
    if (role === 'anon') return null;
    return role !== null ? 'is a JWT whose role claim is not "anon"' : 'is not a recognised publishable key format';
}

/** True only for an `sb_publishable_` key or a JWT with role `anon` that is not the service-role
 *  key. Everything else — empty, garbage, `sb_secret_`, a service_role JWT — is false. */
export function isBrowserSafeSupabaseKey(anonKey: string | null | undefined, serviceRoleKey: string | null | undefined): boolean {
    return supabaseKeyProblem(anonKey, serviceRoleKey) === null;
}

// Which problems mean the configured value IS a secret Supabase key. A Record over the union, so
// adding a new SupabaseKeyProblem is a compile error until someone decides which side it is on.
const SECRET_KEY_PROBLEMS: Readonly<Record<SupabaseKeyProblem, boolean>> = {
    'missing': false,
    'same as SUPABASE_SERVICE_ROLE_KEY': true,
    'is a secret key (sb_secret_)': true,
    'is a JWT whose role claim is not "anon"': true,
    'is not a recognised publishable key format': false,
};

/**
 * True only when the problem says the value is a SECRET key (the service-role value, an
 * `sb_secret_` key, or a JWT whose role is not `anon`) — the cases production refuses to boot on
 * and Database Tools reports as an ERROR. False for null, 'missing' and an unrecognised format.
 * BOOT TIERING ONLY: what may reach a browser is isBrowserSafeSupabaseKey, which refuses all five.
 */
export function isSecretSupabaseKeyProblem(problem: SupabaseKeyProblem | null | undefined): boolean {
    return problem != null && SECRET_KEY_PROBLEMS[problem] === true;
}
