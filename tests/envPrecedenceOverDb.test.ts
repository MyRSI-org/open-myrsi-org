import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In the self-hosted fork, a .env value wins over the DB settings value; the DB
// value is only a fallback for when the env var is unset. getOrgSecret is the
// single resolver every secret use-site (discord.ts, radio.ts, ai.ts) goes through.

const db = vi.hoisted(() => ({ rows: [] as Array<{ key: string; value: unknown }> }));

vi.mock('../lib/db', () => ({
    supabase: {
        from: () => ({
            select: () => ({
                in: async () => ({ data: db.rows }),
            }),
        }),
    },
}));

import { getOrgSecret } from '../lib/secrets';

const ENV_KEYS = [
    'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID',
    'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_URL', 'GEMINI_API_KEY',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    // A populated DB config — these are the values that should lose to env.
    // (clientSecret/botToken pass through decrypt untouched as they aren't encrypted.)
    db.rows = [
        { key: 'discordConfig', value: { clientId: 'DB-CLIENT-ID', clientSecret: 'DB-SECRET', botToken: 'DB-BOT', guildId: 'DB-GUILD' } },
        { key: 'radioConfig', value: { apiKey: 'DB-LK-KEY', apiSecret: 'DB-LK-SECRET', url: 'wss://db.livekit' } },
        { key: 'geminiKey', value: 'DB-GEMINI' },
    ];
});

afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('getOrgSecret env-precedence', () => {
    it('returns the ENV value over a different DB value (public client id)', async () => {
        process.env.DISCORD_CLIENT_ID = 'ENV-CLIENT-ID';
        expect(await getOrgSecret('DISCORD_CLIENT_ID')).toBe('ENV-CLIENT-ID');
    });

    it('returns the ENV value over a stale DB SECRET (clientSecret / bot token / LiveKit / Gemini)', async () => {
        process.env.DISCORD_CLIENT_SECRET = 'ENV-SECRET';
        process.env.DISCORD_BOT_TOKEN = 'ENV-BOT';
        process.env.LIVEKIT_API_SECRET = 'ENV-LK-SECRET';
        process.env.GEMINI_API_KEY = 'ENV-GEMINI';
        expect(await getOrgSecret('DISCORD_CLIENT_SECRET')).toBe('ENV-SECRET');
        expect(await getOrgSecret('DISCORD_BOT_TOKEN')).toBe('ENV-BOT');
        expect(await getOrgSecret('LIVEKIT_API_SECRET')).toBe('ENV-LK-SECRET');
        expect(await getOrgSecret('GEMINI_API_KEY')).toBe('ENV-GEMINI');
    });

    it('falls back to the DB value when the env var is UNSET (admin-console config still works)', async () => {
        expect(await getOrgSecret('DISCORD_CLIENT_ID')).toBe('DB-CLIENT-ID');
        expect(await getOrgSecret('DISCORD_CLIENT_SECRET')).toBe('DB-SECRET');
        expect(await getOrgSecret('LIVEKIT_API_KEY')).toBe('DB-LK-KEY');
        expect(await getOrgSecret('GEMINI_API_KEY')).toBe('DB-GEMINI');
    });

    it('returns null when neither env nor DB provides the value', async () => {
        db.rows = [];
        expect(await getOrgSecret('DISCORD_BOT_TOKEN')).toBeNull();
    });
});
