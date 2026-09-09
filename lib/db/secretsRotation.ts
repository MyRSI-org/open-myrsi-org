// Zero-downtime rotation of SECRETS_ENCRYPTION_KEY.
//
// THE PROBLEM. Every admin-entered credential (Discord client secret and bot token, LiveKit
// key and secret, the Gemini key, alliance pairing material) is stored AES-256-GCM encrypted
// under a key derived from SECRETS_ENCRYPTION_KEY. Until now there was no way to change that
// key: the moment an operator changed it, every stored secret became undecryptable, with the
// deployment guide's only advice being "do not change once set". That is not a rotation story,
// it is a prohibition — and it means a key an operator believes is compromised cannot be
// retired without re-entering every credential by hand.
//
// THE SHAPE OF THE FIX. Two halves, because either alone is insufficient:
//   1. lib/crypto.ts keeps a decrypt RING (current key, then SECRETS_ENCRYPTION_KEY_PREVIOUS)
//      while encrypting only under the current key. That alone restores a deployment whose
//      operator has ALREADY changed the key: add one env var, restart, everything reads again.
//      But nothing rewrites the old rows, so they stay under the retired key forever.
//   2. This module: one explicit, idempotent, re-runnable pass that re-encrypts every at-rest
//      secret under the current key, so the previous key can actually be removed.
//
// No ciphertext format change, and deliberately no key identifier in the envelope: AES-GCM's
// auth tag makes trial decryption unambiguous (a wrong key fails with p = 1 - 2^-128), and a
// format change would be unreadable by an older build on rollback.
//
// FAIL-CLOSED RULES, both load-bearing:
//   * A value that decrypts under NEITHER key is COUNTED and SKIPPED. It is never written
//     back, never blanked, never nulled. The whole point of a rotation tool is to not be the
//     thing that destroys the credentials it was pointed at.
//   * Only values already carrying the `enc:` prefix are touched. Plaintext is left alone
//     rather than opportunistically encrypted — see the SENSITIVE_FIELDS caution in
//     lib/crypto.ts about aiConfig, where "helpfully" encrypting would start handing a raw
//     `enc:` blob to the Gemini API.

import { supabase, broadcastToOrg } from './common.js';
import { tryDecryptSecret, probeSecretKeyState, encryptSecret, SENSITIVE_FIELDS, type SecretKeyState } from '../crypto.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'lib.db.secretsRotation' });

const ENC_PREFIX = 'enc:';

/** Settings rows that carry an OBJECT whose sensitive fields are listed in SENSITIVE_FIELDS.
 *  `aiConfig` is deliberately absent: nothing writes it encrypted (see lib/crypto.ts). */
const OBJECT_SETTING_KEYS = ['discordConfig', 'radioConfig'] as const;
/** Settings rows whose `value` is the ciphertext STRING itself, not an object. */
const SCALAR_SETTING_KEYS = ['geminiKey'] as const;
/** Settings rows carrying a named ciphertext field inside an object. */
const FIELD_SETTING_KEYS: Array<{ key: string; field: string }> = [
    { key: 'allianceLocalPairingCode', field: 'codeEnc' },
];
/** alliance_peers columns holding ciphertext. */
const PEER_SECRET_COLUMNS = ['outbound_key_enc', 'entered_peer_code_enc'] as const;

const ALL_SETTING_KEYS = [
    ...OBJECT_SETTING_KEYS,
    ...SCALAR_SETTING_KEYS,
    ...FIELD_SETTING_KEYS.map(f => f.key),
];

/** Page size for alliance_peers. Bounded read: this runs on an admin button, not a request. */
const PEER_PAGE = 500;

const isCipher = (v: unknown): v is string => typeof v === 'string' && v.startsWith(ENC_PREFIX);

/**
 * Walk every at-rest ciphertext and hand each one to `visit`. The single enumeration both
 * public functions share, so the inventory and the rotation can never disagree about which
 * values exist — the drift that would make the health check say "all current" while the pass
 * silently skipped a site.
 *
 * Every read enumerates its columns explicitly (no wildcard selects).
 */
async function forEachSecretValue(visit: (cipher: string) => void): Promise<void> {
    const settingsQ = await supabase.from('settings').select('key, value').in('key', ALL_SETTING_KEYS);
    if (settingsQ.error) throw settingsQ.error;
    for (const row of (settingsQ.data || []) as Array<{ key: string; value: unknown }>) {
        for (const cipher of ciphersInSettingRow(row.key, row.value)) visit(cipher);
    }

    for (let from = 0; ; from += PEER_PAGE) {
        const peersQ = await supabase.from('alliance_peers')
            .select('id, outbound_key_enc, entered_peer_code_enc')
            .order('id', { ascending: true }).range(from, from + PEER_PAGE - 1);
        if (peersQ.error) throw peersQ.error;
        const rows = (peersQ.data || []) as Array<Record<string, unknown>>;
        for (const row of rows) {
            for (const col of PEER_SECRET_COLUMNS) {
                const v = row[col];
                if (isCipher(v)) visit(v);
            }
        }
        if (rows.length < PEER_PAGE) break;
    }
}

/** Every ciphertext inside one settings row, whatever shape that row uses. */
function ciphersInSettingRow(key: string, value: unknown): string[] {
    const out: string[] = [];
    if ((SCALAR_SETTING_KEYS as readonly string[]).includes(key)) {
        if (isCipher(value)) out.push(value);
        return out;
    }
    if (!value || typeof value !== 'object') return out;
    const obj = value as Record<string, unknown>;
    if ((OBJECT_SETTING_KEYS as readonly string[]).includes(key)) {
        // Read defensively: a test double may mock lib/crypto without SENSITIVE_FIELDS.
        for (const field of (SENSITIVE_FIELDS?.[key] ?? [])) {
            if (isCipher(obj[field])) out.push(obj[field] as string);
        }
        return out;
    }
    const named = FIELD_SETTING_KEYS.find(f => f.key === key);
    if (named && isCipher(obj[named.field])) out.push(obj[named.field] as string);
    return out;
}

export interface SecretsKeyState {
    total: number;
    underCurrent: number;
    underPrevious: number;
    undecryptable: number;
    /** No key configured at all — a different problem with a different remedy. */
    noKey: number;
}

/**
 * Count which key each stored secret is under. Uses the DISCRIMINATOR-ONLY probe, so no live
 * credential is ever materialised: this runs from the admin health check, a read path that has
 * never pulled secrets into memory and must not start.
 */
export async function inventorySecretCiphertexts(): Promise<SecretsKeyState> {
    const state: SecretsKeyState = { total: 0, underCurrent: 0, underPrevious: 0, undecryptable: 0, noKey: 0 };
    await forEachSecretValue((cipher) => {
        state.total++;
        const s: SecretKeyState = probeSecretKeyState(cipher);
        if (s === 'current') state.underCurrent++;
        else if (s === 'previous') state.underPrevious++;
        else if (s === 'no_key') state.noKey++;
        else if (s === 'undecryptable') state.undecryptable++;
    });
    return state;
}

export interface RotationResult {
    rotated: number;
    alreadyCurrent: number;
    /** Decrypted under NEITHER key. Left untouched on purpose. */
    failed: number;
    /** Rows whose write itself errored. The pass is re-runnable; these are not lost. */
    writeErrors: number;
}

/** Re-encrypt one value if it is under the previous key. Returns the new ciphertext, or null
 *  to mean "leave this value exactly as it is". */
function rotateValue(cipher: string, result: RotationResult): string | null {
    const probe = tryDecryptSecret(cipher);
    if (!probe.ok) {
        // NEVER write. Not '', not null, not the ciphertext. A value we cannot read is a value
        // we must not replace — that is the difference between a rotation tool and a shredder.
        result.failed++;
        return null;
    }
    if (probe.underCurrentKey) { result.alreadyCurrent++; return null; }
    const next = encryptSecret(probe.plaintext);
    result.rotated++;
    return next;
}

/**
 * Re-encrypt every at-rest secret under the CURRENT key. Idempotent and re-runnable: a partial
 * success followed by another run is the intended recovery, so one row's failure never blocks
 * the rest.
 */
export async function rotateSecretsEncryption(): Promise<RotationResult> {
    const result: RotationResult = { rotated: 0, alreadyCurrent: 0, failed: 0, writeErrors: 0 };

    // Refuse outright rather than reporting a row of zeros: with no current key encryptSecret
    // throws on every value anyway, and "0 rotated" would read as success.
    if (!process.env.SECRETS_ENCRYPTION_KEY) {
        throw new Error('Cannot rotate: SECRETS_ENCRYPTION_KEY is not configured.');
    }

    const settingsQ = await supabase.from('settings').select('key, value').in('key', ALL_SETTING_KEYS);
    if (settingsQ.error) throw settingsQ.error;

    for (const row of (settingsQ.data || []) as Array<{ key: string; value: unknown }>) {
        let nextValue: unknown = null;

        if ((SCALAR_SETTING_KEYS as readonly string[]).includes(row.key)) {
            if (isCipher(row.value)) {
                const next = rotateValue(row.value, result);
                if (next) nextValue = next;
            }
        } else if (row.value && typeof row.value === 'object') {
            const obj = row.value as Record<string, unknown>;
            // Copy the WHOLE object and replace only the sensitive fields. Assembling a new
            // value from the sensitive fields alone would silently wipe clientId, guildId and
            // every stored channel id — this is a data-destruction path, not a style point.
            const copy: Record<string, unknown> = { ...obj };
            let changed = false;
            const fields = (OBJECT_SETTING_KEYS as readonly string[]).includes(row.key)
                ? (SENSITIVE_FIELDS?.[row.key] ?? [])
                : FIELD_SETTING_KEYS.filter(f => f.key === row.key).map(f => f.field);
            for (const field of fields) {
                const v = obj[field];
                if (!isCipher(v)) continue;
                const next = rotateValue(v, result);
                if (next) { copy[field] = next; changed = true; }
            }
            if (changed) nextValue = copy;
        }

        if (nextValue === null) continue;
        const { error } = await supabase.from('settings').upsert({ key: row.key, value: nextValue }, { onConflict: 'key' });
        if (error) {
            result.writeErrors++;
            log.warn('secrets rotation write failed', { err: error, settingKey: row.key });
        }
    }

    for (let from = 0; ; from += PEER_PAGE) {
        const peersQ = await supabase.from('alliance_peers')
            .select('id, outbound_key_enc, entered_peer_code_enc')
            .order('id', { ascending: true }).range(from, from + PEER_PAGE - 1);
        if (peersQ.error) throw peersQ.error;
        const rows = (peersQ.data || []) as Array<Record<string, unknown>>;
        for (const row of rows) {
            const patch: Record<string, string> = {};
            for (const col of PEER_SECRET_COLUMNS) {
                const v = row[col];
                if (!isCipher(v)) continue;
                const next = rotateValue(v, result);
                if (next) patch[col] = next;
            }
            if (Object.keys(patch).length === 0) continue;
            const { error } = await supabase.from('alliance_peers').update(patch).eq('id', row.id as string);
            if (error) {
                result.writeErrors++;
                log.warn('secrets rotation peer write failed', { err: error, peerId: row.id });
            }
        }
        if (rows.length < PEER_PAGE) break;
    }

    // Counts only — never a plaintext, a ciphertext, or any fragment of a key.
    log.info('secrets rotation complete', { ...result });
    // One ping, empty payload (ids/discriminators only on the wire). Neither `settings` nor
    // `alliance_peers` is a published realtime table, so this is belt to an existing brace.
    if (result.rotated > 0) await broadcastToOrg('settings_update', {});
    return result;
}
