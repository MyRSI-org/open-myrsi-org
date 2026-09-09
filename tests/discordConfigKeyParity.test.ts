import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/discordConfigKeys.ts is the ONE registry two disconnected sites derive from:
// the write allowlist (updateDiscordSettings) and the read-back rebuild
// (stripSecrets). Before it existed the two had already drifted —
// defaultOperationAnnounceChannelId saved fine and was then dropped on read-back,
// which silently disabled the org-wide announce-channel default in
// CreateOperationWizard.tsx and OpAdministerTab.tsx — and the write path was a raw
// spread of the client blob, so an admin:config:discord holder could POST
// botToken/clientSecret/guildId and have them stored as live credentials.
//
// Deliberately BEHAVIOURAL, not a source scan: a scan would pass on a file that
// imports the constants and then ignores them.

const h = vi.hoisted(() => ({
    existing: {} as Record<string, unknown>,
    upserts: [] as Array<{ key: string; value: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(_table: string) {
        const b: any = {};
        b.select = () => b;
        b.eq = () => b; b.in = () => b; b.is = () => b; b.order = () => b; b.limit = () => b;
        b.upsert = (row: { key: string; value: Record<string, unknown> }) => {
            h.upserts.push(row);
            return b;
        };
        const settle = () => Promise.resolve({ data: { value: h.existing }, error: null });
        b.maybeSingle = () => settle();
        b.single = () => settle();
        b.then = (resolve: any, reject: any) => Promise.resolve({ data: null, error: null }).then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => ({}), safeFetch: async () => [],
    };
});
// Identity crypto so the assertions read the plaintext blob that was merged.
vi.mock('../lib/crypto', () => ({
    encryptConfigSecrets: (_k: string, v: unknown) => v,
    decryptConfigSecrets: (_k: string, v: unknown) => v,
    encryptSecret: (v: string) => v,
    decryptSecret: (v: string) => v,
}));
vi.mock('../lib/cache', () => ({ cache: { get: () => undefined, set: () => {}, invalidate: () => {}, invalidatePrefix: () => {} }, TTL: {} }));
vi.mock('../lib/push', () => ({ sendPushToAll: () => {}, sendPushToStaff: () => {}, sendPushToPermission: () => {} }));
vi.mock('../lib/db/seeder', () => ({ seedNewOrganization: async () => {} }));

import {
    ADMIN_WRITABLE_DISCORD_KEYS,
    CLIENT_SAFE_DISCORD_KEYS,
    DISCORD_SNOWFLAKE_RE,
    normaliseDiscordSnowflake,
} from '../lib/discordConfigKeys';
import { stripSecrets } from '../api/query';
import { updateDiscordSettings } from '../lib/db/system';

const SNOWFLAKE = '123456789012345678';

beforeEach(() => {
    h.existing = {};
    h.upserts = [];
});

const lastUpsert = () => h.upserts[h.upserts.length - 1]!.value;

describe('the registry itself', () => {
    it('is non-empty and strictly narrower than the client-readable set', () => {
        // Guards against a vacuous suite: an empty list would satisfy every
        // derived assertion below.
        expect(ADMIN_WRITABLE_DISCORD_KEYS.length).toBeGreaterThan(0);
        expect(CLIENT_SAFE_DISCORD_KEYS.length).toBeGreaterThan(ADMIN_WRITABLE_DISCORD_KEYS.length);
    });

    it('pins the exact admin-writable key set', () => {
        // A snapshot ON PURPOSE — every other assertion derives from the constant,
        // so this is the only one that can catch a REMOVAL, and it forces a later
        // ping-role item to declare its keys deliberately, in this one place.
        expect([...ADMIN_WRITABLE_DISCORD_KEYS].sort()).toEqual([
            'craftingRequestChannelId',
            'defaultOperationAnnounceChannelId',
            'eamChannelId',
            'eamPingRoleId',
            'intelChannelId',
            'newRequestChannelId',
            'operationAnnouncePingRoleId',
        ]);
    });

    it('every writable key is also readable back — a write-only key IS the read-back bug', () => {
        for (const key of ADMIN_WRITABLE_DISCORD_KEYS) {
            expect(CLIENT_SAFE_DISCORD_KEYS).toContain(key);
        }
    });

    it('never exposes a credential-shaped key to a client', () => {
        for (const key of CLIENT_SAFE_DISCORD_KEYS) {
            expect(key).not.toMatch(/secret|token|password|credential/i);
        }
        expect(CLIENT_SAFE_DISCORD_KEYS).not.toContain('botToken');
        expect(CLIENT_SAFE_DISCORD_KEYS).not.toContain('clientSecret');
        expect(CLIENT_SAFE_DISCORD_KEYS).not.toContain('guildId');
    });

    it('does not let the admin RPC write the OAuth identity', () => {
        expect(ADMIN_WRITABLE_DISCORD_KEYS).not.toContain('clientId');
        expect(ADMIN_WRITABLE_DISCORD_KEYS).not.toContain('guildId');
    });
});

describe('read path — stripSecrets rebuilds discordConfig from the registry', () => {
    it('returns defaultOperationAnnounceChannelId (the regression)', () => {
        // It saved correctly and was then dropped by the hard-coded 4-key literal,
        // blanking the admin console field and leaving both consumers inert:
        // CreateOperationWizard.tsx (defaultAnnounceChannelId) and
        // OpAdministerTab.tsx (existingPickerChannelId fallback).
        const out = stripSecrets({ discordConfig: { defaultOperationAnnounceChannelId: SNOWFLAKE } });
        expect(out.discordConfig.defaultOperationAnnounceChannelId).toBe(SNOWFLAKE);
    });

    it('passes every client-safe key through with its own value', () => {
        // Distinct value per key so a mixed-up mapping is visible, not masked.
        const src: Record<string, string> = {};
        CLIENT_SAFE_DISCORD_KEYS.forEach((key, i) => { src[key] = `10000000000000000${i}`; });
        const out = stripSecrets({ discordConfig: { ...src } });
        for (const key of CLIENT_SAFE_DISCORD_KEYS) {
            expect(out.discordConfig[key]).toBe(src[key]);
        }
    });

    it('drops everything not on the registry, by default', () => {
        const out = stripSecrets({
            discordConfig: {
                clientId: 'cid',
                intelChannelId: SNOWFLAKE,
                botToken: 'secret-bot',
                clientSecret: 'secret-cs',
                guildId: 'g',
                enabled: true,
                somethingNew: 'future-secret',
            },
        });
        const present = Object.keys(out.discordConfig)
            .filter(k => out.discordConfig[k] !== undefined)
            .sort();
        expect(present).toEqual(['clientId', 'intelChannelId']);
        expect(out.discordConfig.botToken).toBeUndefined();
        expect(out.discordConfig.somethingNew).toBeUndefined();
    });
});

describe('write path — updateDiscordSettings bounds the write to the registry', () => {
    it('ignores credential/identity keys an admin RPC tries to inject', async () => {
        await updateDiscordSettings({
            intelChannelId: SNOWFLAKE,
            botToken: 'attacker-token',
            clientSecret: 'x',
            guildId: 'g',
            clientId: 'hijack',
        });
        const stored = lastUpsert();
        expect(stored.intelChannelId).toBe(SNOWFLAKE);
        expect(stored.botToken).toBeUndefined();
        expect(stored.clientSecret).toBeUndefined();
        expect(stored.guildId).toBeUndefined();
        expect(stored.clientId).toBeUndefined();
    });

    it('BOUNDS the write without deleting existing keys', async () => {
        // A self-host that configured its credentials into settings.discordConfig
        // (a supported path — lib/secrets.ts serves them) must not lose them on the
        // admin's next channel save.
        h.existing = { botToken: 'enc-bot', enabled: false };
        await updateDiscordSettings({ intelChannelId: SNOWFLAKE });
        const stored = lastUpsert();
        expect(stored.botToken).toBe('enc-bot');
        expect(stored.enabled).toBe(false);
        expect(stored.intelChannelId).toBe(SNOWFLAKE);
    });

    it('refuses a junk id at the boundary, naming the field', async () => {
        await expect(updateDiscordSettings({ intelChannelId: '#general' })).rejects.toThrow(/intelChannelId/);
        expect(h.upserts).toHaveLength(0);
    });

    it('lets an UNCHANGED legacy value through so it cannot block saving a different field', async () => {
        // The settings tab posts all four fields on every save, so validating
        // unconditionally would let one pre-validation junk value permanently lock
        // the deployment out of saving any Discord setting.
        h.existing = { newRequestChannelId: 'legacy-junk' };
        await expect(updateDiscordSettings({
            newRequestChannelId: 'legacy-junk',
            intelChannelId: SNOWFLAKE,
        })).resolves.toBeUndefined();
        const stored = lastUpsert();
        expect(stored.newRequestChannelId).toBe('legacy-junk');
        expect(stored.intelChannelId).toBe(SNOWFLAKE);
    });

    it("treats '' as an explicit clear", async () => {
        h.existing = { eamChannelId: SNOWFLAKE };
        await updateDiscordSettings({ eamChannelId: '' });
        expect(lastUpsert().eamChannelId).toBeFalsy();
    });
});

describe('normaliseDiscordSnowflake', () => {
    it('accepts 17-19 digit ids and trims', () => {
        expect(normaliseDiscordSnowflake('12345678901234567', 'f')).toBe('12345678901234567');
        expect(normaliseDiscordSnowflake('1234567890123456789', 'f')).toBe('1234567890123456789');
        expect(normaliseDiscordSnowflake(`  ${SNOWFLAKE}  `, 'f')).toBe(SNOWFLAKE);
    });

    it('reads empty/absent as a clear, not an error', () => {
        expect(normaliseDiscordSnowflake('', 'f')).toBeNull();
        expect(normaliseDiscordSnowflake('   ', 'f')).toBeNull();
        expect(normaliseDiscordSnowflake(null, 'f')).toBeNull();
        expect(normaliseDiscordSnowflake(undefined, 'f')).toBeNull();
    });

    it('throws on anything that is not a snowflake, naming the field', () => {
        for (const bad of ['general', '#general', '123', '12345678901234567890', 'abc123def456ghi789', '123456789012345678x']) {
            expect(() => normaliseDiscordSnowflake(bad, 'eamChannelId')).toThrow(/eamChannelId/);
        }
    });

    it('exposes the same regex the mention builder validates role ids with', () => {
        expect(DISCORD_SNOWFLAKE_RE.test(SNOWFLAKE)).toBe(true);
        expect(DISCORD_SNOWFLAKE_RE.test('nope')).toBe(false);
    });
});
