// What makes a JWT_SECRET unsafe, and which problems are bad enough to refuse to boot.
//
// One pure, dependency-free classifier shared by the boot guard (lib/auth.ts) and the admin
// Database Tools health check (lib/db/system.ts runDatabaseHealthCheck), so the two can never
// disagree about the same secret. It reports NAMES only, never a value: its output reaches logs
// and an admin screen, and neither may become the leak.
//
// WHY TWO TIERS. Every Discord user who signs in receives a token signed with this key from the
// public auth:discord_callback, so the key is effectively under offline attack. But only some
// problems are actually exploitable, and refusing to boot forces a rotation that signs every
// member out — so the hard refusal is kept for the cases where a forged Admin session is a real
// prospect, and everything else is a loud, persistent warning:
//
//   REFUSE (production will not start):
//     - missing;
//     - shorter than JWT_SECRET_REFUSE_BELOW (16) — the range a human types ("myorgsecret");
//       a secret that short may be crackable offline from that free HMAC sample;
//     - identical to a PUBLISHED key. SUPABASE_ANON_KEY goes to every anonymous visitor
//       (target=config and every initial-state branch) and VAPID_PUBLIC_KEY to anyone calling the
//       public system:get_push_config, so a JWT_SECRET copied from either is not merely leakable
//       but already public: anyone with no account could sign a session for the Admin.
//
//   WARN (starts; boot logs an error and the health check reports a WARNING until fixed):
//     - 16-31 characters: below the documented 32 (`openssl rand -hex 32` gives 64) but, if it is
//       random, not crackable — refusing would force a rotation for no exploitable reason;
//     - identical to a PRIVATE key (SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET,
//       SECRETS_ENCRYPTION_KEY). HMAC does not reveal its key, so this is key separation — one
//       leak of the env would hand over both — not a live hole.
//
// Raw length, no trim, to stay aligned with the SECRETS_ENCRYPTION_KEY floor (server.ts) and the
// preflight's isStrongSecret (lib/db/system.ts).

export const JWT_SECRET_REFUSE_BELOW = 16;
export const JWT_SECRET_RECOMMENDED_LENGTH = 32;

export const JWT_SECRET_PUBLISHED_KEYS = ['SUPABASE_ANON_KEY', 'VAPID_PUBLIC_KEY'] as const;
export const JWT_SECRET_PRIVATE_KEYS = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET', 'SECRETS_ENCRYPTION_KEY'] as const;

export interface SessionSecretAssessment {
    /** Problems that make production refuse to start. Empty when the secret may be used. */
    refuse: string[];
    /** Problems that are logged loudly and shown in the health check, but do not block boot. */
    warn: string[];
}

type Env = Record<string, string | undefined>;

export function assessSessionSecret(env: Env): SessionSecretAssessment {
    const secret = env.JWT_SECRET;
    const refuse: string[] = [];
    const warn: string[] = [];

    if (typeof secret !== 'string' || secret.length === 0) {
        refuse.push('not configured');
        return { refuse, warn };
    }

    if (secret.length < JWT_SECRET_REFUSE_BELOW) {
        refuse.push(`shorter than ${JWT_SECRET_REFUSE_BELOW} characters`);
    } else if (secret.length < JWT_SECRET_RECOMMENDED_LENGTH) {
        warn.push(`shorter than the recommended ${JWT_SECRET_RECOMMENDED_LENGTH} characters`);
    }

    const sameAs = (names: readonly string[]) => names.filter((name) => {
        const other = env[name];
        return typeof other === 'string' && other.length > 0 && other === secret;
    });
    const published = sameAs(JWT_SECRET_PUBLISHED_KEYS);
    if (published.length > 0) refuse.push(`identical to the published ${published.join(', ')}`);
    const privateReuse = sameAs(JWT_SECRET_PRIVATE_KEYS);
    if (privateReuse.length > 0) warn.push(`identical to ${privateReuse.join(', ')}`);

    return { refuse, warn };
}

export const SESSION_SECRET_FIX_HINT =
    'Generate a dedicated value with `openssl rand -hex 32` and use it for nothing else. Changing it signs everyone out; set PUBLIC_SALT to the OLD value first so opaque public ids stay stable (DEPLOYMENT_GUIDE.md: Rotating the session secret).';
