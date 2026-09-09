import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Rotation of SECRETS_ENCRYPTION_KEY. Two properties carry the whole feature:
//   * A decrypt-only key must NEVER become an encrypt key. If it could, an operator who set
//     only SECRETS_ENCRYPTION_KEY_PREVIOUS would silently write new secrets under the key they
//     were retiring, and the health check would report everything as current.
//   * A value that decrypts under NEITHER key must NEVER be written back. A rotation tool that
//     can blank a credential it could not read is a shredder.

const h = vi.hoisted(() => ({
    settings: [] as Array<{ key: string; value: unknown }>,
    peers: [] as Array<Record<string, unknown>>,
    settingsWrites: [] as Array<{ key: string; value: unknown }>,
    peerWrites: [] as Array<{ id: unknown; patch: Record<string, unknown> }>,
    broadcasts: [] as string[],
    settingsError: null as unknown,
    writeError: null as unknown,
}));

vi.mock('../lib/db/common.js', () => ({
    supabase: {
        from: (table: string) => {
            if (table === 'settings') {
                return {
                    select: () => ({
                        in: async () => ({ data: h.settingsError ? null : h.settings, error: h.settingsError }),
                    }),
                    upsert: async (row: { key: string; value: unknown }) => {
                        h.settingsWrites.push(row);
                        return { error: h.writeError };
                    },
                };
            }
            return {
                // `order` is part of the chain because `.range()` paging without an ORDER BY
                // is undefined across pages. The double must model it or the test passes
                // against a shape the production code no longer has.
                select: () => {
                    const chain: Record<string, unknown> = {
                        range: async (from: number) => ({ data: from === 0 ? h.peers : [], error: null }),
                    };
                    chain.order = () => chain;
                    return chain;
                },
                update: (patch: Record<string, unknown>) => ({
                    eq: async (_col: string, id: unknown) => {
                        h.peerWrites.push({ id, patch });
                        return { error: h.writeError };
                    },
                }),
            };
        },
    },
    broadcastToOrg: async (event: string) => { h.broadcasts.push(event); },
    handleSupabaseError: () => {},
}));

import { encryptSecret, decryptSecret, tryDecryptSecret, probeSecretKeyState, hasPreviousKey } from '../lib/crypto';
import { inventorySecretCiphertexts, rotateSecretsEncryption } from '../lib/db/secretsRotation';

const KEY_A = 'a'.repeat(64); // "old" key
const KEY_B = 'b'.repeat(64); // "new" key

/** Produce a ciphertext under `key`, whatever the ambient env is. */
function encryptUnder(key: string, plaintext: string): string {
    const prevCur = process.env.SECRETS_ENCRYPTION_KEY;
    const prevOld = process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
    process.env.SECRETS_ENCRYPTION_KEY = key;
    delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
    try {
        return encryptSecret(plaintext);
    } finally {
        if (prevCur === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = prevCur;
        if (prevOld === undefined) delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS; else process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = prevOld;
    }
}

const envBackup: Record<string, string | undefined> = {};
beforeEach(() => {
    envBackup.cur = process.env.SECRETS_ENCRYPTION_KEY;
    envBackup.prev = process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
    h.settings = [];
    h.peers = [];
    h.settingsWrites = [];
    h.peerWrites = [];
    h.broadcasts = [];
    h.settingsError = null;
    h.writeError = null;
});
afterEach(() => {
    if (envBackup.cur === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = envBackup.cur;
    if (envBackup.prev === undefined) delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS; else process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = envBackup.prev;
});

describe('crypto keyring — the decrypt ring never becomes an encrypt ring', () => {
    it('reads a value written under the PREVIOUS key once that key is carried across', () => {
        const cipher = encryptUnder(KEY_A, 'bot-token');
        process.env.SECRETS_ENCRYPTION_KEY = KEY_B;
        process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = KEY_A;
        expect(decryptSecret(cipher)).toBe('bot-token');
    });

    // THE FAIL-CLOSED PIN. With only the previous key present, encryptSecret must still refuse.
    // The obvious implementation — "the encrypt key is ring[0]" — passes every other test in
    // this file and fails this one, because in that state ring[0] IS the retired key.
    it('REFUSES to encrypt when only the previous key is set', () => {
        delete process.env.SECRETS_ENCRYPTION_KEY;
        process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = KEY_A;
        expect(() => encryptSecret('new-secret')).toThrow(/SECRETS_ENCRYPTION_KEY is not configured/);
    });

    it('does not report a previous-key value as current when the current key is absent', () => {
        const cipher = encryptUnder(KEY_A, 'x');
        delete process.env.SECRETS_ENCRYPTION_KEY;
        process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = KEY_A;
        // Readable, but NOT under a current key — reporting 'current' here would tell the
        // operator rotation is finished when nothing is encrypted under a current key at all.
        expect(probeSecretKeyState(cipher)).not.toBe('current');
    });

    it('treats current and previous set to the SAME value as one key', () => {
        const cipher = encryptUnder(KEY_A, 'x');
        process.env.SECRETS_ENCRYPTION_KEY = KEY_A;
        process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = KEY_A;
        expect(probeSecretKeyState(cipher)).toBe('current');
    });

    it('classifies every state', () => {
        const underA = encryptUnder(KEY_A, 'x');
        process.env.SECRETS_ENCRYPTION_KEY = KEY_B;
        process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = KEY_A;
        expect(probeSecretKeyState(underA)).toBe('previous');
        expect(probeSecretKeyState(encryptUnder(KEY_B, 'x'))).toBe('current');
        expect(probeSecretKeyState('not-encrypted')).toBe('plaintext');
        expect(probeSecretKeyState('enc:AAAA:BBBB:CCCC')).toBe('undecryptable');
        delete process.env.SECRETS_ENCRYPTION_KEY;
        delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
        expect(probeSecretKeyState(underA)).toBe('no_key');
    });

    // The rotation pass walks raw jsonb values, so it can hand this a number or an object.
    it('tryDecryptSecret never throws on a non-string', () => {
        process.env.SECRETS_ENCRYPTION_KEY = KEY_B;
        expect(() => tryDecryptSecret(undefined as unknown as string)).not.toThrow();
        expect(() => tryDecryptSecret(42 as unknown as string)).not.toThrow();
        expect(() => tryDecryptSecret({} as unknown as string)).not.toThrow();
    });

    it('hasPreviousKey is the single source of truth for "a rotation is in flight"', () => {
        delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
        expect(hasPreviousKey()).toBe(false);
        process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = KEY_A;
        expect(hasPreviousKey()).toBe(true);
        // An empty string (what a copied .env.example produces) is NOT a configured key.
        process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = '';
        expect(hasPreviousKey()).toBe(false);
    });
});

describe('rotateSecretsEncryption', () => {
    beforeEach(() => {
        process.env.SECRETS_ENCRYPTION_KEY = KEY_B;
        process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = KEY_A;
    });

    it('re-encrypts a previous-key value and leaves a current-key one alone', async () => {
        h.settings = [
            { key: 'geminiKey', value: encryptUnder(KEY_A, 'gemini-secret') },
            { key: 'radioConfig', value: { apiKey: encryptUnder(KEY_B, 'live-key'), apiSecret: encryptUnder(KEY_A, 'live-secret') } },
        ];
        const r = await rotateSecretsEncryption();
        expect(r.rotated).toBe(2);
        expect(r.alreadyCurrent).toBe(1);
        expect(r.failed).toBe(0);
        // Everything written is now readable under the CURRENT key alone.
        delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
        const gemini = h.settingsWrites.find(w => w.key === 'geminiKey');
        expect(decryptSecret(gemini!.value as string)).toBe('gemini-secret');
        const radio = h.settingsWrites.find(w => w.key === 'radioConfig')!.value as Record<string, string>;
        expect(decryptSecret(radio.apiSecret)).toBe('live-secret');
        expect(decryptSecret(radio.apiKey)).toBe('live-key');
    });

    // THE DESTRUCTION PIN. A value readable under neither key is counted and skipped. It must
    // never be blanked, nulled, or replaced — that would destroy a credential the operator
    // could still recover by supplying the right key.
    it('NEVER writes back a value it cannot decrypt', async () => {
        h.settings = [{ key: 'geminiKey', value: 'enc:AAAA:BBBB:CCCC' }];
        const r = await rotateSecretsEncryption();
        expect(r.failed).toBe(1);
        expect(r.rotated).toBe(0);
        expect(h.settingsWrites).toEqual([]);
    });

    // settings.value is upserted WHOLE. Rebuilding it from the sensitive fields alone would
    // silently wipe clientId, guildId and every stored channel id.
    it('preserves every non-sensitive field when rewriting a config object', async () => {
        h.settings = [{
            key: 'discordConfig',
            value: {
                clientId: '123456',
                guildId: '789',
                announceChannelId: 'chan-1',
                clientSecret: encryptUnder(KEY_A, 'the-secret'),
                botToken: encryptUnder(KEY_A, 'the-token'),
            },
        }];
        await rotateSecretsEncryption();
        const written = h.settingsWrites[0].value as Record<string, unknown>;
        expect(written.clientId).toBe('123456');
        expect(written.guildId).toBe('789');
        expect(written.announceChannelId).toBe('chan-1');
        delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
        expect(decryptSecret(written.clientSecret as string)).toBe('the-secret');
        expect(decryptSecret(written.botToken as string)).toBe('the-token');
    });

    // aiConfig is declared in SENSITIVE_FIELDS but nothing writes it encrypted, and
    // lib/secrets.ts reads it WITHOUT decrypting. Encrypting it here would start handing a raw
    // `enc:` blob to the Gemini API.
    it('never touches a plaintext value, and never encrypts aiConfig', async () => {
        h.settings = [
            { key: 'geminiKey', value: 'plain-text-key' },
            { key: 'radioConfig', value: { apiKey: 'plain', apiSecret: 'plain-too' } },
        ];
        const r = await rotateSecretsEncryption();
        expect(r.rotated).toBe(0);
        expect(h.settingsWrites).toEqual([]);
    });

    it('rotates alliance peer columns', async () => {
        h.peers = [{ id: 'peer-1', outbound_key_enc: encryptUnder(KEY_A, 'peer-key'), entered_peer_code_enc: null }];
        const r = await rotateSecretsEncryption();
        expect(r.rotated).toBe(1);
        expect(h.peerWrites).toHaveLength(1);
        expect(h.peerWrites[0].id).toBe('peer-1');
        expect(h.peerWrites[0].patch).not.toHaveProperty('entered_peer_code_enc');
    });

    it('refuses to run at all with no current key, rather than reporting zeros', async () => {
        delete process.env.SECRETS_ENCRYPTION_KEY;
        await expect(rotateSecretsEncryption()).rejects.toThrow(/SECRETS_ENCRYPTION_KEY is not configured/);
    });

    it('counts a write failure instead of aborting the pass', async () => {
        h.settings = [{ key: 'geminiKey', value: encryptUnder(KEY_A, 'x') }];
        h.writeError = { message: 'db down' };
        const r = await rotateSecretsEncryption();
        expect(r.writeErrors).toBe(1);
        expect(r.rotated).toBe(1); // re-encrypted in memory; the pass is re-runnable
    });

    it('broadcasts once, with an empty payload, and only when something changed', async () => {
        h.settings = [{ key: 'geminiKey', value: encryptUnder(KEY_B, 'already-current') }];
        await rotateSecretsEncryption();
        expect(h.broadcasts).toEqual([]);
        h.settings = [{ key: 'geminiKey', value: encryptUnder(KEY_A, 'needs-rotating') }];
        await rotateSecretsEncryption();
        expect(h.broadcasts).toEqual(['settings_update']);
    });

    // Rule 5: the result crosses the API boundary to an admin screen. Counts only.
    it('returns counts only — no plaintext, ciphertext or key material', async () => {
        h.settings = [{ key: 'geminiKey', value: encryptUnder(KEY_A, 'super-secret-value') }];
        const r = await rotateSecretsEncryption();
        const json = JSON.stringify(r);
        expect(json).not.toContain('super-secret-value');
        expect(json).not.toContain('enc:');
        expect(json).not.toContain(KEY_A);
        expect(json).not.toContain(KEY_B);
        expect(Object.keys(r).sort()).toEqual(['alreadyCurrent', 'failed', 'rotated', 'writeErrors']);
    });
});

describe('inventorySecretCiphertexts', () => {
    it('buckets every value by which key it is under', async () => {
        process.env.SECRETS_ENCRYPTION_KEY = KEY_B;
        process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = KEY_A;
        h.settings = [
            { key: 'geminiKey', value: encryptUnder(KEY_B, 'a') },
            { key: 'radioConfig', value: { apiKey: encryptUnder(KEY_A, 'b'), apiSecret: 'plaintext-never-encrypted' } },
            { key: 'allianceLocalPairingCode', value: { codeEnc: 'enc:XX:YY:ZZ', expiresAt: 'later' } },
        ];
        h.peers = [{ id: 'p1', outbound_key_enc: encryptUnder(KEY_A, 'c'), entered_peer_code_enc: null }];
        const inv = await inventorySecretCiphertexts();
        expect(inv.underCurrent).toBe(1);
        expect(inv.underPrevious).toBe(2);
        expect(inv.undecryptable).toBe(1);
        expect(inv.noKey).toBe(0);
        expect(inv.total).toBe(4); // the plaintext apiSecret is not a ciphertext
    });

    it('reports noKey separately — the remedy differs from undecryptable', async () => {
        const cipher = encryptUnder(KEY_A, 'x');
        delete process.env.SECRETS_ENCRYPTION_KEY;
        delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS;
        h.settings = [{ key: 'geminiKey', value: cipher }];
        const inv = await inventorySecretCiphertexts();
        expect(inv.noKey).toBe(1);
        expect(inv.undecryptable).toBe(0);
    });

    it('propagates a read error rather than reporting a clean zero', async () => {
        process.env.SECRETS_ENCRYPTION_KEY = KEY_B;
        h.settingsError = { message: 'boom' };
        await expect(inventorySecretCiphertexts()).rejects.toBeTruthy();
    });
});
