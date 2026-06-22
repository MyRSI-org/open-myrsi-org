
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { log as baseLog } from './log.js';

const log = baseLog.child({ module: 'lib.crypto' });

const ALGORITHM = 'aes-256-gcm';
const ENCRYPTED_PREFIX = 'enc:';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 32-byte key from the env secret using scrypt.
 * Cached per process to avoid repeated key derivation.
 */
let derivedKey: Buffer | null = null;
function getKey(): Buffer | null {
    if (derivedKey) return derivedKey;
    const raw = process.env.SECRETS_ENCRYPTION_KEY;
    if (!raw) return null;
    // Use a fixed salt derived from the key itself (deterministic, no extra storage)
    derivedKey = scryptSync(raw, 'myrsi-org-secrets', 32);
    return derivedKey;
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

    const key = getKey();
    if (!key) {
        log.warn('encrypted value found but SECRETS_ENCRYPTION_KEY is not set, returning raw value');
        return value;
    }

    try {
        const payload = value.slice(ENCRYPTED_PREFIX.length);
        const [ivB64, tagB64, dataB64] = payload.split(':');
        const iv = Buffer.from(ivB64, 'base64');
        const authTag = Buffer.from(tagB64, 'base64');
        const encrypted = Buffer.from(dataB64, 'base64');

        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return decrypted.toString('utf8');
    } catch (e: any) {
        // Throw rather than returning ciphertext — silent fallback would hand the
        // encrypted blob to downstream callers (Discord API, LiveKit, etc.) where it
        // fails in a confusing way far from the root cause. Most common cause: a
        // SECRETS_ENCRYPTION_KEY mismatch against the value written at encrypt time.
        log.error('decryption failed', { err: e });
        throw new Error('Failed to decrypt stored secret (key mismatch or corrupted ciphertext).');
    }
}

// maskSecret / maskConfigSecrets were removed — they had no callers. Settings sent
// to the browser are never decrypted and masked; stripSecrets (api/query.ts) sends
// presence flags only. Don't add a decrypt-then-mask path that would pull live
// credentials into a response.

/** List of sensitive field names within config JSONB objects */
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
