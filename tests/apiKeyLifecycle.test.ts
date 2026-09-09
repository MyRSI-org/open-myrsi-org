import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyHasScope, isKeyExpired, normalizeScopes, API_KEY_SCOPES } from '../lib/apiKeyScopes';

// API keys had no expiry, no scopes and no revocation RECORD: revoking meant deleting the row,
// which destroyed the audit trail an operator needs after a leak. And the scope column is only
// worth having if the two key-authenticated surfaces actually READ it — the plan's own warning
// was that the column gets added and nothing checks it.

describe('keyHasScope', () => {
    it('grants a declared scope and refuses an undeclared one', () => {
        expect(keyHasScope(['feed'], 'feed')).toBe(true);
        expect(keyHasScope(['feed'], 'alliance')).toBe(false);
        expect(keyHasScope(['alliance'], 'alliance')).toBe(true);
        expect(keyHasScope(['feed', 'alliance'], 'alliance')).toBe(true);
    });

    // Bounded fail-open, and the alternative is worse in both directions: refusing NULL breaks
    // every live federation pairing the instant the operator deploys, while treating the column
    // as advisory forever makes it decorative.
    it('grandfathers a key issued before scopes existed', () => {
        expect(keyHasScope(null, 'feed')).toBe(true);
        expect(keyHasScope(undefined, 'alliance')).toBe(true);
    });

    // A scope check satisfiable by a SUBSTRING is not a scope check. `scopes` arrives from the
    // database as unknown, and a bare `.includes()` on a string would be a substring test.
    it('fails CLOSED on a malformed value rather than substring-matching it', () => {
        expect(keyHasScope('alliance', 'alliance')).toBe(false);
        expect(keyHasScope('feed-only', 'feed')).toBe(false);
        expect(keyHasScope(42, 'feed')).toBe(false);
        expect(keyHasScope({}, 'feed')).toBe(false);
    });

    it('treats an explicitly empty scope list as no access, NOT as grandfathered', () => {
        expect(keyHasScope([], 'feed')).toBe(false);
        expect(keyHasScope([], 'alliance')).toBe(false);
    });
});

describe('normalizeScopes', () => {
    it('keeps known scopes, drops unknown ones, and de-duplicates', () => {
        expect(normalizeScopes(['feed', 'feed', 'alliance'])).toEqual(['feed', 'alliance']);
        // A typo must not create a scope nothing will ever check.
        expect(normalizeScopes(['feeed', 'admin', 42, null])).toEqual([]);
        expect(normalizeScopes('feed')).toEqual([]);
        expect(normalizeScopes(undefined)).toEqual([]);
    });

    it('covers every declared scope', () => {
        expect(normalizeScopes([...API_KEY_SCOPES])).toEqual([...API_KEY_SCOPES]);
    });
});

describe('isKeyExpired', () => {
    const NOW = Date.UTC(2026, 0, 10);
    it('never expires without an expiry', () => {
        expect(isKeyExpired(null, NOW)).toBe(false);
        expect(isKeyExpired(undefined, NOW)).toBe(false);
        expect(isKeyExpired('', NOW)).toBe(false);
    });

    it('expires at or after the stamp', () => {
        expect(isKeyExpired(new Date(NOW + 1000).toISOString(), NOW)).toBe(false);
        expect(isKeyExpired(new Date(NOW - 1000).toISOString(), NOW)).toBe(true);
        expect(isKeyExpired(new Date(NOW).toISOString(), NOW)).toBe(true);
    });

    // A date we cannot read is not a date we should honour.
    it('treats an unreadable expiry as EXPIRED', () => {
        expect(isKeyExpired('not-a-date', NOW)).toBe(true);
        expect(isKeyExpired(12345, NOW)).toBe(true);
        expect(isKeyExpired({}, NOW)).toBe(true);
    });
});

describe('scope enforcement is wired at BOTH key-authenticated surfaces', () => {
    // The whole point of the item. A column nothing reads is decorative, and the two surfaces
    // were previously separated only incidentally — the feed by a label prefix, federation by
    // which table happened to reference the key.
    it('the intel feed requires the feed scope', () => {
        const src = readFileSync(join(process.cwd(), 'api', 'query.ts'), 'utf8');
        expect(src).toContain("keyHasScope((keyData as { scopes?: unknown }).scopes, 'feed')");
    });

    it('alliance federation requires the alliance scope', () => {
        const src = readFileSync(join(process.cwd(), 'lib', 'db', 'alliances.ts'), 'utf8');
        expect(src).toContain("keyHasScope((verified as { scopes?: unknown }).scopes, 'alliance')");
    });

    // Alliance credentials are minted by the pairing handshake, NOT through createApiKey.
    // Scoping only createApiKey would leave every newly paired ally on a grandfathered key
    // forever — on the higher-privilege surface, where it matters most.
    it('the alliance handshake mints its key already scoped', () => {
        const src = readFileSync(join(process.cwd(), 'lib', 'db', 'alliances.ts'), 'utf8');
        expect(src).toMatch(/insert\(\{ label: `alliance:\$\{peerId\}`, key_hash: hash, scopes: \['alliance'\] \}\)/);
    });
});

describe('verifyApiKey — lifecycle and the fail-closed schema guard', () => {
    const src = readFileSync(join(process.cwd(), 'lib', 'db', 'system.ts'), 'utf8');

    it('refuses a revoked or expired key', () => {
        expect(src).toContain("auditKeyDenial('authz.api_key.revoked'");
        expect(src).toContain("auditKeyDenial('authz.api_key.expired'");
    });

    // It previously bound no error at all, so a missing column produced data === undefined ->
    // return null -> every federation route and feed pull 403'd with NO log line anywhere. A
    // silent total outage is worse than a noisy one.
    it('binds the read error rather than letting a fault read as "no such key"', () => {
        const fn = src.slice(src.indexOf('export async function verifyApiKey'));
        expect(fn.slice(0, 2000)).toContain('const { data, error } = await supabase.from(\'api_keys\')');
        expect(fn.slice(0, 2000)).toContain("if (code === '42703')");
    });

    // Only a key that actually authenticated should look freshly used, or a revoked credential
    // being replayed keeps updating its own last-used stamp in the admin list.
    it('stamps last_used_at only after the lifecycle checks pass', () => {
        const fn = src.slice(src.indexOf('export async function verifyApiKey'));
        const revokedIdx = fn.indexOf('if (row.revoked_at)');
        const stampIdx = fn.indexOf('last_used_at: new Date().toISOString()');
        expect(revokedIdx).toBeGreaterThan(-1);
        expect(stampIdx).toBeGreaterThan(revokedIdx);
    });
});

describe('the admin list can actually tell one key from another', () => {
    const src = readFileSync(join(process.cwd(), 'lib', 'db', 'system.ts'), 'utf8');

    // listApiKeys returned `{ ...k }` over snake_case rows while the UI read camelCase, so
    // Created rendered a literal em-dash and Last Used read "Never" on EVERY row — including a
    // key used a second ago. TypeScript never caught it because the spread widened the type.
    // An operator deciding which key to revoke had three columns of no information.
    it('maps rows to camelCase instead of spreading them', () => {
        const fn = src.slice(src.indexOf('export async function listApiKeys'));
        expect(fn.slice(0, 1600)).toContain('createdAt: k.created_at');
        expect(fn.slice(0, 1600)).toContain('lastUsedAt: k.last_used_at');
        expect(fn.slice(0, 1600)).not.toContain('...k,');
    });

    it('never selects key_hash', () => {
        const fn = src.slice(src.indexOf('export async function listApiKeys'), src.indexOf('export async function listApiKeys') + 1600);
        expect(fn).not.toContain('key_hash');
    });
});

describe('createApiKey', () => {
    const src = readFileSync(join(process.cwd(), 'lib', 'db', 'system.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function createApiKey'), src.indexOf('export type ApiKeyListRow'));

    // The error was previously unbound, so an insert failure returned `{ ...null, rawKey }` and
    // the console DISPLAYED that raw key as a successfully-created credential. The operator
    // wrote it down, handed it to an ally, and it never authenticated — silently.
    it('cannot report a phantom success', () => {
        expect(fn).toContain('const { data, error } = await supabase');
        expect(fn).toContain("handleSupabaseError({ error, message: 'Failed to create API key' })");
        expect(fn).toContain('if (!data) throw new Error');
    });

    it('refuses the reserved alliance label prefix', () => {
        expect(fn).toContain('cleanLabel.startsWith(ALLIANCE_KEY_LABEL_PREFIX)');
    });

    it('sanitises and caps the label', () => {
        expect(fn).toContain('sharedStripHtml(label, 120)');
    });

    // A hand-made key has no business reaching federation: those credentials are minted by the
    // pairing handshake, never by an operator typing a label.
    it('defaults a manually created key to the feed surface only', () => {
        expect(fn).toContain("wanted.length > 0 ? wanted : ['feed']");
    });
});
