import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/secrets.ts getOrgSecret — the single resolver for admin-entered credentials.
// Pins: the settings read is column-scoped (no wildcard) and key-scoped; every
// supported key maps to its own field (and only that field); env vars win over the
// DB; encrypted values are decrypted; a decrypt failure or a DB fault yields null —
// never the ciphertext, and never a throw out of the resolver.

const h = vi.hoisted(() => ({
    rows: [] as Array<{ key: string; value: unknown }> | null,
    throwOnQuery: false,
    calls: [] as Array<{ method: string; args: unknown[] }>,
    logged: [] as Array<{ level: string; msg: string; fields?: Record<string, unknown> }>,
}));

vi.mock('../lib/db', () => ({
    supabase: {
        from: (...args: unknown[]) => {
            h.calls.push({ method: 'from', args });
            return {
                select: (...sArgs: unknown[]) => {
                    h.calls.push({ method: 'select', args: sArgs });
                    return {
                        in: async (...iArgs: unknown[]) => {
                            h.calls.push({ method: 'in', args: iArgs });
                            if (h.throwOnQuery) throw new Error('connection reset');
                            return { data: h.rows };
                        },
                    };
                },
            };
        },
    },
}));

vi.mock('../lib/log', () => {
    const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => { h.logged.push({ level, msg, fields }); };
    const child = { error: rec('error'), warn: rec('warn'), info: rec('info'), debug: rec('debug') };
    return { log: { ...child, child: () => child } };
});

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgSecret, ORG_SECRET_NAMES, type OrgSecretName } from '../lib/secrets';
import { encryptSecret } from '../lib/crypto';

/** Call getOrgSecret the way the type forbids: a cast, an `any`, a computed name. */
const getUntyped = (key: unknown) => getOrgSecret(key as OrgSecretName);

const ENV_KEYS = [
    'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID',
    'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_URL', 'GEMINI_API_KEY',
    'SECRETS_ENCRYPTION_KEY', 'SECRETS_ENCRYPTION_KEY_PREVIOUS',
] as const;

const KEY_A = 'k'.repeat(40);
let saved: Record<string, string | undefined>;

beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.SECRETS_ENCRYPTION_KEY = KEY_A;
    h.rows = [];
    h.throwOnQuery = false;
    h.calls = [];
    h.logged = [];
});

afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('getOrgSecret query scoping', () => {
    it('reads only key,value from settings, only for the four credential rows', async () => {
        await getOrgSecret('DISCORD_CLIENT_ID');
        expect(h.calls).toEqual([
            { method: 'from', args: ['settings'] },
            { method: 'select', args: ['key, value'] },
            { method: 'in', args: ['key', ['discordConfig', 'radioConfig', 'aiConfig', 'geminiKey']] },
        ]);
    });
});

describe('getOrgSecret field mapping from the DB', () => {
    beforeEach(() => {
        h.rows = [
            { key: 'discordConfig', value: { clientId: 'cid', clientSecret: encryptSecret('csecret'), botToken: encryptSecret('btoken'), guildId: 'gid' } },
            { key: 'radioConfig', value: { apiKey: encryptSecret('lk-key'), apiSecret: encryptSecret('lk-secret'), url: 'wss://lk.example' } },
        ];
    });

    it.each<[OrgSecretName, string]>([
        ['DISCORD_CLIENT_ID', 'cid'],
        ['DISCORD_CLIENT_SECRET', 'csecret'],
        ['DISCORD_BOT_TOKEN', 'btoken'],
        ['DISCORD_GUILD_ID', 'gid'],
        ['LIVEKIT_API_KEY', 'lk-key'],
        ['LIVEKIT_API_SECRET', 'lk-secret'],
        ['LIVEKIT_URL', 'wss://lk.example'],
    ])('%s resolves to its own (decrypted) field', async (key, expected) => {
        const v = await getOrgSecret(key);
        expect(v).toBe(expected);
        expect(v).not.toMatch(/^enc:/);
    });

    it('returns null for an unsupported key rather than some other DB credential', async () => {
        delete process.env.COV_LIBS_NOT_A_SECRET_NAME;
        expect(await getUntyped('COV_LIBS_NOT_A_SECRET_NAME')).toBeNull();
        expect(await getUntyped('')).toBeNull();
    });

    it('returns null when the field is simply absent', async () => {
        h.rows = [{ key: 'discordConfig', value: { clientId: 'cid' } }];
        expect(await getOrgSecret('DISCORD_BOT_TOKEN')).toBeNull();
        expect(await getOrgSecret('LIVEKIT_URL')).toBeNull();
    });

    it('returns null when the settings read returns no data at all', async () => {
        h.rows = null;
        expect(await getOrgSecret('DISCORD_CLIENT_SECRET')).toBeNull();
    });
});

describe('getOrgSecret env precedence', () => {
    it('an env var wins over the DB value', async () => {
        h.rows = [{ key: 'discordConfig', value: { botToken: encryptSecret('db-token') } }];
        process.env.DISCORD_BOT_TOKEN = 'env-token';
        expect(await getOrgSecret('DISCORD_BOT_TOKEN')).toBe('env-token');
    });

    it('an EMPTY env var does not shadow the DB value', async () => {
        h.rows = [{ key: 'radioConfig', value: { apiSecret: encryptSecret('db-secret') } }];
        process.env.LIVEKIT_API_SECRET = '';
        expect(await getOrgSecret('LIVEKIT_API_SECRET')).toBe('db-secret');
    });

    it('an env var is returned even when the DB has nothing', async () => {
        process.env.LIVEKIT_URL = 'wss://env.example';
        expect(await getOrgSecret('LIVEKIT_URL')).toBe('wss://env.example');
    });
});

describe('getOrgSecret GEMINI_API_KEY resolution', () => {
    it('decrypts an encrypted geminiKey string', async () => {
        h.rows = [{ key: 'geminiKey', value: encryptSecret('gem-enc') }];
        expect(await getOrgSecret('GEMINI_API_KEY')).toBe('gem-enc');
    });

    it('accepts a legacy plaintext geminiKey string', async () => {
        h.rows = [{ key: 'geminiKey', value: 'gem-plain' }];
        expect(await getOrgSecret('GEMINI_API_KEY')).toBe('gem-plain');
    });

    it('reads apiKey, then key, from an object-shaped geminiKey', async () => {
        h.rows = [{ key: 'geminiKey', value: { apiKey: 'gem-obj-apikey', key: 'ignored' } }];
        expect(await getOrgSecret('GEMINI_API_KEY')).toBe('gem-obj-apikey');
        h.rows = [{ key: 'geminiKey', value: { key: 'gem-obj-key' } }];
        expect(await getOrgSecret('GEMINI_API_KEY')).toBe('gem-obj-key');
    });

    it('falls back to aiConfig.apiKey when geminiKey is absent or empty', async () => {
        h.rows = [{ key: 'aiConfig', value: { apiKey: 'ai-config-key' } }];
        expect(await getOrgSecret('GEMINI_API_KEY')).toBe('ai-config-key');
        h.rows = [{ key: 'geminiKey', value: {} }, { key: 'aiConfig', value: { apiKey: 'ai-config-key-2' } }];
        expect(await getOrgSecret('GEMINI_API_KEY')).toBe('ai-config-key-2');
    });

    it('is null when no Gemini key is stored anywhere', async () => {
        expect(await getOrgSecret('GEMINI_API_KEY')).toBeNull();
    });
});

describe('getOrgSecret fails closed', () => {
    it('a credential that will not decrypt yields null — never the ciphertext — and logs the key name only', async () => {
        const ct = encryptSecret('live-bot-token');
        h.rows = [{ key: 'discordConfig', value: { botToken: ct } }];
        process.env.SECRETS_ENCRYPTION_KEY = 'z'.repeat(40); // key changed without carrying the old one
        const v = await getOrgSecret('DISCORD_BOT_TOKEN');
        expect(v).toBeNull();
        const err = h.logged.find((l) => l.level === 'error' && l.msg === 'secret fetch failed');
        expect(err).toBeDefined();
        expect(err!.fields!.key).toBe('DISCORD_BOT_TOKEN');
        expect(JSON.stringify(err!.fields)).not.toContain('live-bot-token');
    });

    it('an undecryptable geminiKey yields null rather than the blob', async () => {
        const ct = encryptSecret('gem');
        h.rows = [{ key: 'geminiKey', value: ct }];
        process.env.SECRETS_ENCRYPTION_KEY = 'y'.repeat(40);
        expect(await getOrgSecret('GEMINI_API_KEY')).toBeNull();
    });

    it('a settings-read fault yields null instead of throwing out of the resolver', async () => {
        h.throwOnQuery = true;
        await expect(getOrgSecret('DISCORD_CLIENT_SECRET')).resolves.toBeNull();
        expect(h.logged.some((l) => l.level === 'error' && l.fields?.key === 'DISCORD_CLIENT_SECRET')).toBe(true);
    });
});

// The env var of the requested name wins over the stored value, so an open-ended
// name made getOrgSecret a read of ANY environment variable:
// getOrgSecret('SUPABASE_SERVICE_ROLE_KEY') returned the service-role key.
describe('getOrgSecret allowlist — it is not a general environment reader', () => {
    const REFUSED = 'unsupported secret name refused';
    const FOREIGN = { SUPABASE_SERVICE_ROLE_KEY: 'sentinel-service-role', JWT_SECRET: 'sentinel-jwt' } as const;
    let savedForeign: Record<string, string | undefined>;

    beforeEach(() => {
        savedForeign = {};
        for (const [k, v] of Object.entries(FOREIGN)) { savedForeign[k] = process.env[k]; process.env[k] = v; }
        // A stored credential exists too, so a refusal cannot be mistaken for "nothing stored".
        h.rows = [{ key: 'discordConfig', value: { botToken: encryptSecret('db-token') } }];
    });

    afterEach(() => {
        for (const k of Object.keys(FOREIGN)) {
            if (savedForeign[k] === undefined) delete process.env[k]; else process.env[k] = savedForeign[k];
        }
    });

    const refusals = () => h.logged.filter((l) => l.level === 'warn' && l.msg === REFUSED);

    it('the supported names are exactly the eight credentials the callers use', () => {
        expect([...ORG_SECRET_NAMES]).toEqual([
            'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID',
            'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_URL',
            'GEMINI_API_KEY',
        ]);
    });

    it('every call site passes a supported literal, and every supported name has a call site', () => {
        const root = join(__dirname, '..');
        const used = new Set<string>();
        for (const dir of ['lib', 'api']) {
            for (const rel of readdirSync(join(root, dir), { recursive: true }) as string[]) {
                if (!rel.endsWith('.ts')) continue;
                const src = readFileSync(join(root, dir, rel), 'utf8');
                for (const m of src.matchAll(/(function\s+)?getOrgSecret\(([^)]*)\)/g)) {
                    if (m[1]) continue; // the definition itself
                    const lit = /^\s*'([A-Z0-9_]+)'\s*$/.exec(m[2]);
                    expect(lit, `${dir}/${rel}: getOrgSecret(${m[2]}) must pass a string literal`).not.toBeNull();
                    expect(ORG_SECRET_NAMES as readonly string[], `${dir}/${rel}: ${m[2]}`).toContain(lit![1]);
                    used.add(lit![1]);
                }
            }
        }
        expect([...used].sort()).toEqual([...ORG_SECRET_NAMES].sort());
    });

    it.each(Object.keys(FOREIGN))('refuses %s even though that env var is set — before any settings read', async (name) => {
        expect(await getUntyped(name)).toBeNull();
        expect(h.calls).toEqual([]);
        expect(refusals()).toEqual([{ level: 'warn', msg: REFUSED, fields: { key: name } }]);
        expect(JSON.stringify(h.logged)).not.toContain(FOREIGN[name as keyof typeof FOREIGN]);
    });

    it('refuses the encryption key itself', async () => {
        expect(process.env.SECRETS_ENCRYPTION_KEY).toBe(KEY_A);
        expect(await getUntyped('SECRETS_ENCRYPTION_KEY')).toBeNull();
        expect(JSON.stringify(h.logged)).not.toContain(KEY_A);
    });

    it.each([
        ['lower case', 'discord_bot_token'],
        ['a leading space', ' DISCORD_BOT_TOKEN'],
        ['a trailing space', 'DISCORD_BOT_TOKEN '],
        ['a prefix', 'XDISCORD_BOT_TOKEN'],
    ])('matches names exactly: %s is refused even though DISCORD_BOT_TOKEN is set', async (_label, name) => {
        // Windows env lookup is case-insensitive, so a lower-cased name would otherwise read the real var.
        process.env.DISCORD_BOT_TOKEN = 'env-token';
        expect(await getUntyped(name)).toBeNull();
        expect(refusals()).toHaveLength(1);
    });

    it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])('refuses the inherited property name %s', async (name) => {
        expect(await getUntyped(name)).toBeNull();
        expect(refusals()).toEqual([{ level: 'warn', msg: REFUSED, fields: { key: name } }]);
    });

    it.each([
        ['undefined', undefined, '<undefined>'],
        ['null', null, '<object>'],
        ['a number', 42, '<number>'],
        ['an object', {}, '<object>'],
        ['an array holding a supported name', ['DISCORD_BOT_TOKEN'], '<object>'],
    ])('refuses a non-string name (%s) and logs only its type', async (_label, name, logged) => {
        // ['DISCORD_BOT_TOKEN'] would coerce to the real name in an env lookup.
        process.env.DISCORD_BOT_TOKEN = 'env-token';
        expect(await getUntyped(name)).toBeNull();
        expect(h.calls).toEqual([]);
        expect(refusals()).toEqual([{ level: 'warn', msg: REFUSED, fields: { key: logged } }]);
    });

    it('caps the logged name at 64 characters', async () => {
        const name = 'N'.repeat(200);
        expect(await getUntyped(name)).toBeNull();
        expect(refusals()[0].fields!.key).toBe('N'.repeat(64));
    });

    it.each([...ORG_SECRET_NAMES])('still resolves the supported name %s from its env var, without a refusal', async (name) => {
        process.env[name] = `env-${name}`;
        expect(await getOrgSecret(name)).toBe(`env-${name}`);
        expect(refusals()).toEqual([]);
    });
});
