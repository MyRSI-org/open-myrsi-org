import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/crypto.ts — AES-256-GCM encryption-at-rest for admin-entered credentials
// (Discord client secret / bot token, LiveKit key + secret). Pins:
//   * round trip under the current key, fresh IV per encryption;
//   * any tampering with IV, auth tag or ciphertext, a wrong key, or a malformed
//     envelope is REFUSED (throws) — never handed back as if it were plaintext;
//   * encrypt is fail-closed without SECRETS_ENCRYPTION_KEY, and a decrypt-only
//     PREVIOUS key never becomes an encrypt key;
//   * the config helpers touch only the listed sensitive fields and never mutate input.

const h = vi.hoisted(() => ({ logged: [] as Array<{ level: string; msg: string; fields?: unknown }> }));

vi.mock('../lib/log', () => {
    const rec = (level: string) => (msg: string, fields?: unknown) => { h.logged.push({ level, msg, fields }); };
    const child = { error: rec('error'), warn: rec('warn'), info: rec('info'), debug: rec('debug') };
    return { log: { ...child, child: () => child } };
});

import {
    encryptSecret, decryptSecret, tryDecryptSecret, probeSecretKeyState, hasPreviousKey,
    encryptConfigSecrets, decryptConfigSecrets, SENSITIVE_FIELDS,
} from '../lib/crypto';

const KEY_A = 'a'.repeat(32) + '-current-key-material';
const KEY_B = 'b'.repeat(32) + '-retired-key-material';

let savedCur: string | undefined;
let savedPrev: string | undefined;

function setKeys(cur: string | undefined, prev?: string | undefined) {
    if (cur === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = cur;
    if (prev === undefined) delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS; else process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = prev;
}

/** Flip one byte of a base64 segment, keeping it valid base64 of the same length. */
function flipB64(seg: string): string {
    const buf = Buffer.from(seg, 'base64');
    buf[0] ^= 0x01;
    return buf.toString('base64');
}

beforeEach(() => {
    savedCur = process.env.SECRETS_ENCRYPTION_KEY;
    savedPrev = process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
    setKeys(KEY_A);
    h.logged = [];
});

afterEach(() => {
    setKeys(savedCur, savedPrev);
});

describe('encryptSecret / decryptSecret round trip', () => {
    it('produces an enc:<iv>:<tag>:<ct> envelope that decrypts back to the plaintext', () => {
        const ct = encryptSecret('discord-bot-token-123');
        expect(ct.startsWith('enc:')).toBe(true);
        const [iv, tag, data] = ct.slice(4).split(':');
        expect(Buffer.from(iv, 'base64')).toHaveLength(16);
        expect(Buffer.from(tag, 'base64')).toHaveLength(16);
        expect(data.length).toBeGreaterThan(0);
        expect(ct).not.toContain('discord-bot-token-123');
        expect(decryptSecret(ct)).toBe('discord-bot-token-123');
    });

    it('uses a fresh random IV every time, so equal plaintexts never produce equal ciphertexts', () => {
        const a = encryptSecret('same');
        const b = encryptSecret('same');
        expect(a).not.toBe(b);
        expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
        expect(decryptSecret(a)).toBe('same');
        expect(decryptSecret(b)).toBe('same');
    });

    it('round-trips multi-byte UTF-8', () => {
        const pt = 'clé-secrète-🔑-ключ';
        expect(decryptSecret(encryptSecret(pt))).toBe(pt);
    });

    it('passes the empty string through both directions without touching the key', () => {
        setKeys(undefined);
        expect(encryptSecret('')).toBe('');
        expect(decryptSecret('')).toBe('');
    });

    it('passes a legacy plaintext (no enc: prefix) through decrypt unchanged', () => {
        expect(decryptSecret('legacy-plain-value')).toBe('legacy-plain-value');
        expect(h.logged).toHaveLength(0);
    });
});

describe('encryptSecret is fail-closed', () => {
    it('throws instead of storing cleartext when SECRETS_ENCRYPTION_KEY is unset', () => {
        setKeys(undefined);
        expect(() => encryptSecret('live-credential')).toThrow(/SECRETS_ENCRYPTION_KEY is not configured/);
    });

    it('treats an empty SECRETS_ENCRYPTION_KEY (copied .env.example) as unset', () => {
        setKeys('');
        expect(() => encryptSecret('live-credential')).toThrow(/SECRETS_ENCRYPTION_KEY is not configured/);
    });

    it('never promotes the decrypt-only PREVIOUS key to an encrypt key', () => {
        setKeys(undefined, KEY_B);
        expect(() => encryptSecret('live-credential')).toThrow(/SECRETS_ENCRYPTION_KEY is not configured/);
    });
});

describe('decryptSecret refuses anything it cannot authenticate', () => {
    const errRe = /Failed to decrypt stored secret/;

    it('rejects a tampered ciphertext byte', () => {
        const [iv, tag, data] = encryptSecret('secret-value').slice(4).split(':');
        expect(() => decryptSecret(`enc:${iv}:${tag}:${flipB64(data)}`)).toThrow(errRe);
    });

    it('rejects a tampered auth tag', () => {
        const [iv, tag, data] = encryptSecret('secret-value').slice(4).split(':');
        expect(() => decryptSecret(`enc:${iv}:${flipB64(tag)}:${data}`)).toThrow(errRe);
    });

    it('rejects a tampered IV', () => {
        const [iv, tag, data] = encryptSecret('secret-value').slice(4).split(':');
        expect(() => decryptSecret(`enc:${flipB64(iv)}:${tag}:${data}`)).toThrow(errRe);
    });

    it('rejects a truncated auth tag rather than accepting a short-tag forgery', () => {
        const [iv, tag, data] = encryptSecret('secret-value').slice(4).split(':');
        const short = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64');
        expect(() => decryptSecret(`enc:${iv}:${short}:${data}`)).toThrow(errRe);
    });

    it('rejects a value encrypted under a different key', () => {
        setKeys(KEY_B);
        const ct = encryptSecret('secret-value');
        setKeys(KEY_A);
        expect(() => decryptSecret(ct)).toThrow(errRe);
    });

    it('rejects a malformed envelope (missing segments) without throwing a raw TypeError', () => {
        expect(() => decryptSecret('enc:not-an-envelope')).toThrow(errRe);
        expect(() => decryptSecret('enc:')).toThrow(errRe);
    });

    it('logs the failure at error level without the ciphertext or plaintext', () => {
        const ct = encryptSecret('secret-value');
        setKeys(KEY_B);
        expect(() => decryptSecret(ct)).toThrow(errRe);
        const errors = h.logged.filter((l) => l.level === 'error');
        expect(errors).toHaveLength(1);
        expect(errors[0].msg).toMatch(/decryption failed/);
        expect(JSON.stringify(errors[0])).not.toContain(ct.slice(4));
        expect(JSON.stringify(errors[0])).not.toContain('secret-value');
    });

    it('with NO key configured returns the opaque envelope unchanged and warns (never a plaintext)', () => {
        const ct = encryptSecret('secret-value');
        setKeys(undefined);
        expect(decryptSecret(ct)).toBe(ct);
        expect(h.logged.some((l) => l.level === 'warn' && /SECRETS_ENCRYPTION_KEY is not set/.test(l.msg))).toBe(true);
    });
});

describe('key rotation ring', () => {
    it('decrypts a value under the PREVIOUS key and reports it as not-current', () => {
        setKeys(KEY_B);
        const ct = encryptSecret('rotating');
        setKeys(KEY_A, KEY_B);
        expect(decryptSecret(ct)).toBe('rotating');
        expect(tryDecryptSecret(ct)).toEqual({ ok: true, plaintext: 'rotating', underCurrentKey: false });
    });

    it('decrypts a value under the CURRENT key and reports it as current', () => {
        setKeys(KEY_A, KEY_B);
        const ct = encryptSecret('fresh');
        expect(tryDecryptSecret(ct)).toEqual({ ok: true, plaintext: 'fresh', underCurrentKey: true });
    });

    it('treats PREVIOUS === CURRENT as one key, not a pending rotation', () => {
        setKeys(KEY_A, KEY_A);
        const ct = encryptSecret('same-key');
        expect(probeSecretKeyState(ct)).toBe('current');
    });

    it('decrypts with only the PREVIOUS key configured (read-only recovery)', () => {
        setKeys(KEY_B);
        const ct = encryptSecret('recover');
        setKeys(undefined, KEY_B);
        expect(tryDecryptSecret(ct)).toEqual({ ok: true, plaintext: 'recover', underCurrentKey: false });
    });

    it('tryDecryptSecret never throws: non-string, empty and plaintext pass through as current', () => {
        expect(tryDecryptSecret(42 as unknown as string)).toEqual({ ok: true, plaintext: 42, underCurrentKey: true });
        expect(tryDecryptSecret(null as unknown as string)).toEqual({ ok: true, plaintext: null, underCurrentKey: true });
        expect(tryDecryptSecret('')).toEqual({ ok: true, plaintext: '', underCurrentKey: true });
        expect(tryDecryptSecret('plain')).toEqual({ ok: true, plaintext: 'plain', underCurrentKey: true });
    });

    it('tryDecryptSecret reports no_key and undecryptable without the plaintext', () => {
        const ct = encryptSecret('x');
        setKeys(undefined);
        expect(tryDecryptSecret(ct)).toEqual({ ok: false, reason: 'no_key' });
        setKeys(KEY_B);
        expect(tryDecryptSecret(ct)).toEqual({ ok: false, reason: 'undecryptable' });
    });

    it('hasPreviousKey is false for unset AND for the empty string', () => {
        setKeys(KEY_A);
        expect(hasPreviousKey()).toBe(false);
        setKeys(KEY_A, '');
        expect(hasPreviousKey()).toBe(false);
        setKeys(KEY_A, KEY_B);
        expect(hasPreviousKey()).toBe(true);
    });
});

describe('probeSecretKeyState returns only a discriminator', () => {
    it('classifies every state', () => {
        setKeys(KEY_B);
        const underB = encryptSecret('b');
        setKeys(KEY_A);
        const underA = encryptSecret('a');

        expect(probeSecretKeyState(undefined)).toBe('plaintext');
        expect(probeSecretKeyState(123)).toBe('plaintext');
        expect(probeSecretKeyState('')).toBe('plaintext');
        expect(probeSecretKeyState('not-encrypted')).toBe('plaintext');
        expect(probeSecretKeyState(underA)).toBe('current');
        expect(probeSecretKeyState(underB)).toBe('undecryptable');

        setKeys(KEY_A, KEY_B);
        expect(probeSecretKeyState(underB)).toBe('previous');

        setKeys(undefined);
        expect(probeSecretKeyState(underA)).toBe('no_key');
    });
});

describe('encryptConfigSecrets / decryptConfigSecrets', () => {
    it('declares the sensitive fields per config key', () => {
        expect(SENSITIVE_FIELDS.discordConfig).toEqual(['clientSecret', 'botToken']);
        expect(SENSITIVE_FIELDS.radioConfig).toEqual(['apiKey', 'apiSecret']);
    });

    it('encrypts ONLY the listed string fields and leaves the rest byte-for-byte', () => {
        const input = { clientId: 'public-id', clientSecret: 'cs', botToken: 'bt', guildId: 'g', extra: { nested: 1 } };
        const out = encryptConfigSecrets('discordConfig', input);
        expect(out.clientId).toBe('public-id');
        expect(out.guildId).toBe('g');
        expect(out.extra).toBe(input.extra);
        expect(out.clientSecret).toMatch(/^enc:/);
        expect(out.botToken).toMatch(/^enc:/);
        // input is not mutated
        expect(input.clientSecret).toBe('cs');
        expect(input.botToken).toBe('bt');
        // and it round-trips
        expect(decryptConfigSecrets('discordConfig', out)).toEqual(input);
    });

    it('skips empty and non-string sensitive values', () => {
        const input = { apiKey: '', apiSecret: 12345, url: 'wss://x' };
        const out = encryptConfigSecrets('radioConfig', input);
        expect(out).toEqual(input);
        expect(out).not.toBe(input);
        expect(decryptConfigSecrets('radioConfig', input)).toEqual(input);
    });

    it('returns null, primitives and unknown config keys untouched (same reference)', () => {
        const unknown = { secret: 'not-listed' };
        expect(encryptConfigSecrets('discordConfig', null)).toBeNull();
        expect(encryptConfigSecrets('discordConfig', 'str')).toBe('str');
        expect(encryptConfigSecrets('brandingConfig', unknown)).toBe(unknown);
        expect(decryptConfigSecrets('discordConfig', undefined)).toBeUndefined();
        expect(decryptConfigSecrets('discordConfig', 7)).toBe(7);
        expect(decryptConfigSecrets('brandingConfig', unknown)).toBe(unknown);
    });

    it('fails closed: encrypting a config without a key throws instead of writing cleartext', () => {
        setKeys(undefined);
        expect(() => encryptConfigSecrets('radioConfig', { apiKey: 'k', apiSecret: 's' })).toThrow(/not configured/);
    });

    it('propagates an undecryptable field as a throw rather than returning the ciphertext', () => {
        const enc = encryptConfigSecrets('radioConfig', { apiKey: 'k', apiSecret: 's' });
        setKeys(KEY_B);
        expect(() => decryptConfigSecrets('radioConfig', enc)).toThrow(/Failed to decrypt/);
    });

    it('decrypts a mix of encrypted and legacy plaintext fields', () => {
        const mixed = { clientSecret: encryptSecret('cs'), botToken: 'legacy-plain' };
        expect(decryptConfigSecrets('discordConfig', mixed)).toEqual({ clientSecret: 'cs', botToken: 'legacy-plain' });
    });
});
