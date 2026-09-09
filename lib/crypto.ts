
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { log as baseLog } from './log.js';

const log = baseLog.child({ module: 'lib.crypto' });

const ALGORITHM = 'aes-256-gcm';
const ENCRYPTED_PREFIX = 'enc:';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/** BAKED INTO EVERY EXISTING CIPHERTEXT. Changing it makes every stored secret on every
 *  existing deployment permanently unreadable. Never change it. */
const SCRYPT_SALT = 'myrsi-org-secrets';

/**
 * Derive a 32-byte key from a raw env secret using scrypt.
 * Cached per RAW STRING (not a single slot) so the current and previous keys can coexist
 * during a rotation, and so a test that mutates the env var is not served a stale key.
 */
const keyCache = new Map<string, Buffer>();
function deriveKey(raw: string): Buffer {
    const hit = keyCache.get(raw);
    if (hit) return hit;
    const k = scryptSync(raw, SCRYPT_SALT, 32);
    keyCache.set(raw, k);
    return k;
}

/**
 * The ENCRYPT key. Reads SECRETS_ENCRYPTION_KEY directly and is deliberately NOT "the first
 * entry of the decrypt ring": if it were, then with only SECRETS_ENCRYPTION_KEY_PREVIOUS set
 * the retired key would silently become the encrypt key. A decrypt-only key must never become
 * an encrypt key — that is what keeps encryptSecret fail-closed.
 */
function getKey(): Buffer | null {
    const raw = process.env.SECRETS_ENCRYPTION_KEY;
    return raw ? deriveKey(raw) : null;
}

/** Is a previous (decrypt-only) key configured? Single source of truth — callers outside this
 *  module must not read the env var themselves, or the ring and the health report can disagree
 *  (notably on the empty-string value a copied .env.example produces). */
export function hasPreviousKey(): boolean {
    return !!process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
}

/**
 * The DECRYPT ring, current key first, each entry tagged with whether it is the current one.
 * Tagged rather than positional so `underCurrentKey` cannot silently mean "index 0" in a state
 * where index 0 is the previous key.
 *
 * Trial decryption is unambiguous here: AES-GCM's auth tag makes a wrong key fail `final()`
 * with probability 1 - 2^-128, so no key identifier is needed in the envelope — which is why
 * rotation requires no ciphertext format change and stays readable by an older build.
 */
function getKeyring(): Array<{ key: Buffer; isCurrent: boolean }> {
    const cur = process.env.SECRETS_ENCRYPTION_KEY;
    const prev = process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
    const ring: Array<{ key: Buffer; isCurrent: boolean }> = [];
    if (cur) ring.push({ key: deriveKey(cur), isCurrent: true });
    // Identical values are ONE key, not two — an operator who sets both to the same string
    // should not get a ring that reports rotation as pending forever.
    if (prev && prev !== cur) ring.push({ key: deriveKey(prev), isCurrent: false });
    return ring;
}

export type DecryptProbe =
    | { ok: true; plaintext: string; underCurrentKey: boolean }
    | { ok: false; reason: 'no_key' | 'undecryptable' };

/**
 * Decrypt against every configured key. NEVER throws — including on a non-string input, which
 * the rotation pass can hand it because it walks raw jsonb values rather than pre-guarded
 * strings. Returns the plaintext, so it is reachable only from the rotation pass; anything that
 * only needs to know WHICH key a value is under must use probeSecretKeyState instead.
 */
export function tryDecryptSecret(value: string): DecryptProbe {
    if (typeof value !== 'string' || !value) return { ok: true, plaintext: value, underCurrentKey: true };
    if (!value.startsWith(ENCRYPTED_PREFIX)) return { ok: true, plaintext: value, underCurrentKey: true };
    const ring = getKeyring();
    if (ring.length === 0) return { ok: false, reason: 'no_key' };
    const payload = value.slice(ENCRYPTED_PREFIX.length);
    const [ivB64, tagB64, dataB64] = payload.split(':');
    for (const entry of ring) {
        try {
            const decipher = createDecipheriv(ALGORITHM, entry.key, Buffer.from(ivB64, 'base64'), { authTagLength: AUTH_TAG_LENGTH });
            decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
            const out = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
            return { ok: true, plaintext: out.toString('utf8'), underCurrentKey: entry.isCurrent };
        } catch { /* wrong key — the auth tag says so; try the next one */ }
    }
    return { ok: false, reason: 'undecryptable' };
}

export type SecretKeyState = 'plaintext' | 'current' | 'previous' | 'undecryptable' | 'no_key';

/**
 * Which key is a stored value under? Discards the decrypted bytes immediately and returns only
 * the discriminator, so the health check can report rotation progress without ever
 * materialising a live credential — a read path that has never pulled secrets into memory and
 * must not start.
 */
export function probeSecretKeyState(value: unknown): SecretKeyState {
    if (typeof value !== 'string' || !value || !value.startsWith(ENCRYPTED_PREFIX)) return 'plaintext';
    const probe = tryDecryptSecret(value);
    if (!probe.ok) return probe.reason === 'no_key' ? 'no_key' : 'undecryptable';
    return probe.underCurrentKey ? 'current' : 'previous';
}

/**
 * Encrypt a plaintext string. Returns prefixed ciphertext string.
 * If no encryption key is configured, returns the plaintext unchanged.
 */
export function encryptSecret(plaintext: string): string {
    if (!plaintext) return plaintext;
    const key = getKey();
    // Fail closed: refuse to "encrypt" without a key rather than storing the
    // admin-entered secret (Discord bot token, LiveKit/Gemini keys) in cleartext.
    // The server requires SECRETS_ENCRYPTION_KEY at boot in production
    // (server.ts), so this only trips on a misconfigured/dev instance.
    if (!key) {
        throw new Error('Cannot store secret: SECRETS_ENCRYPTION_KEY is not configured (encryption-at-rest is required).');
    }

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: enc:<iv>:<authTag>:<ciphertext> (all base64)
    return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt an encrypted string. Handles both encrypted (prefixed) and plaintext values.
 * If no encryption key is configured, returns the value unchanged.
 */
export function decryptSecret(value: string): string {
    if (!value) return value;
    if (!value.startsWith(ENCRYPTED_PREFIX)) return value; // Plaintext passthrough

    const probe = tryDecryptSecret(value);
    if (probe.ok) return probe.plaintext;

    if (probe.reason === 'no_key') {
        log.warn('encrypted value found but SECRETS_ENCRYPTION_KEY is not set, returning raw value');
        return value;
    }

    // Throw rather than returning ciphertext — silent fallback would hand the encrypted blob
    // to downstream callers (Discord API, LiveKit, etc.) where it fails in a confusing way far
    // from the root cause. It is also what stops a read-decrypt-merge-encrypt write path
    // persisting an empty string over a live credential. Most common cause: the key was
    // changed without carrying the old one across.
    log.error('decryption failed under every configured key');
    throw new Error('Failed to decrypt stored secret (key mismatch or corrupted ciphertext). If you changed SECRETS_ENCRYPTION_KEY, set SECRETS_ENCRYPTION_KEY_PREVIOUS to the old value and restart.');
}

// maskSecret / maskConfigSecrets were removed — they had no callers. Settings sent
// to the browser are never decrypted and masked; stripSecrets (api/query.ts) sends
// presence flags only. Don't add a decrypt-then-mask path that would pull live
// credentials into a response.

/** List of sensitive field names within config JSONB objects.
 *
 *  CAUTION for anything that iterates this table generically (e.g. the rotation pass):
 *  `aiConfig` is DECLARED BUT DEAD. encryptConfigSecrets/decryptConfigSecrets are only ever
 *  called with 'discordConfig' and 'radioConfig'; updateAIConfig stores the Gemini key in its
 *  own row instead, and lib/secrets.ts reads aiConfig.apiKey WITHOUT decrypting. So nothing
 *  writes it encrypted, and anything that "helpfully" encrypts it would start handing a raw
 *  `enc:…` blob to the Gemini API. Never opportunistically encrypt a value found here —
 *  re-encrypt only what already carries the `enc:` prefix. */
export const SENSITIVE_FIELDS: Record<string, string[]> = {
    discordConfig: ['clientSecret', 'botToken'],
    radioConfig: ['apiKey', 'apiSecret'],
    aiConfig: ['apiKey'],
};

/**
 * Encrypt sensitive fields within a config object before writing to DB.
 * Non-sensitive fields are left as-is.
 */
export function encryptConfigSecrets(key: string, config: any): any {
    if (!config || typeof config !== 'object') return config;
    const fields = SENSITIVE_FIELDS[key];
    if (!fields) return config;

    const result = { ...config };
    for (const field of fields) {
        if (result[field] && typeof result[field] === 'string') {
            result[field] = encryptSecret(result[field]);
        }
    }
    return result;
}

/**
 * Decrypt sensitive fields within a config object after reading from DB.
 * Handles both encrypted and plaintext values transparently.
 */
export function decryptConfigSecrets(key: string, config: any): any {
    if (!config || typeof config !== 'object') return config;
    const fields = SENSITIVE_FIELDS[key];
    if (!fields) return config;

    const result = { ...config };
    for (const field of fields) {
        if (result[field] && typeof result[field] === 'string') {
            result[field] = decryptSecret(result[field]);
        }
    }
    return result;
}
