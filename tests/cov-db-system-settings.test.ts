import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// lib/db/system.ts — settings readers/writers, first-run state, preflight, and the
// optional-feature gate. Every writer is held to the same contract: the exact settings
// row it upserts, the sanitised/allow-listed value, encryption of secret fields at rest,
// refusal (no write, no broadcast) on a failed read or write, and an EMPTY id-only
// `settings_update` broadcast (Security rule 4) on success.

vi.mock('../lib/db/common.js', async () => (await import('./cov-db-system-harness')).commonModule());
vi.mock('../lib/cache.js', async () => (await import('./cov-db-system-harness')).cacheModule());
vi.mock('../lib/push.js', async () => (await import('./cov-db-system-harness')).pushModule());
vi.mock('../lib/db/opReminders.js', async () => (await import('./cov-db-system-harness')).opRemindersModule());
vi.mock('../lib/db/bans.js', async () => (await import('./cov-db-system-harness')).bansModule());
vi.mock('../lib/db/roleDefaults.js', async () => (await import('./cov-db-system-harness')).roleDefaultsModule());
vi.mock('../lib/db/clientRoleLock.js', async () => (await import('./cov-db-system-harness')).clientRoleLockModule());
vi.mock('../lib/crypto.js', async () => (await import('./cov-db-system-harness')).cryptoModule());
vi.mock('../lib/db/secretsRotation.js', async () => (await import('./cov-db-system-harness')).secretsRotationModule());
vi.mock('../lib/db/securityEvents.js', async () => (await import('./cov-db-system-harness')).securityEventsModule());
vi.mock('../lib/db/seeder.js', async () => (await import('./cov-db-system-harness')).seederModule());
vi.mock('../lib/db/public.js', async () => (await import('./cov-db-system-harness')).publicModule());
vi.mock('../lib/discord.js', async () => (await import('./cov-db-system-harness')).discordModule());
vi.mock('../lib/log.js', async () => (await import('./cov-db-system-harness')).logModule());

import { db, mocks, resetHarness, has, arg0, args } from './cov-db-system-harness';
import {
    getAllSettings, getPublicSettings, isSetupCompleted, setSetupCompleted, getPreflightStatus,
    updateDiscordSettings, updateHeroCardConfig, updateBrandingConfig, updateThemeConfig,
    updateOpenGraphConfig, updateRadioConfig, updateWikiHomeConfig, updatePublicPageConfig,
    updateAIConfig, updateHRConfig, updateGovernmentsConfig, getOrgFeatures, updateOrgFeatures,
    isFeatureEnabled, isGovernmentEnabled, isOptionalFeatureEnabled, updateIntelSharingConfig,
    getIntelSharingConfig,
} from '../lib/db/system';

const settingsUpserts = () => db.q('settings').filter((q) => has(q, 'upsert'));
const upsertRow = (i = 0) => arg0(settingsUpserts()[i], 'upsert') as { key: string; value: Record<string, unknown> };
const expectSettingsBroadcast = () => expect(mocks.broadcastToOrg).toHaveBeenCalledWith('settings_update', {});
const keyRead = (key: string) => (q: { ops: Array<[string, unknown[]]> }) => q.ops.some(([m, a]) => m === 'eq' && a[0] === 'key' && a[1] === key);

beforeEach(() => resetHarness());

// ─────────────────────────────────────────────────────────────────────────────
describe('getAllSettings', () => {
    it('reads key/value with an explicit column list and overlays the rows on the seeded defaults', async () => {
        db.on('settings', { data: [{ key: 'hrConfig', value: { probationDays: 14 } }, { key: 'admin_setup_code', value: { code: 'SETUP-AAAA' } }] });
        const s = await getAllSettings();
        const [q] = db.q('settings');
        expect(arg0(q, 'select')).toBe('key, value');
        expect(q.ops.map(([m]) => m)).toEqual(['select']);
        expect(s.hrConfig).toEqual({ probationDays: 14 });
        expect(s.admin_setup_code).toEqual({ code: 'SETUP-AAAA' });
        expect(s.brandingConfig).toEqual({ name: 'OPERATIONS', iconUrl: '/media/cross-swords.png' });
        expect(s.systemConfig).toEqual({ appUrl: '' });
        expect(s.publicPageConfig.enabled).toBe(false);
    });

    it('returns the hard-coded fallback (and decrypts nothing) when the settings table does not exist', async () => {
        db.on('settings', { data: null, error: { code: '42P01', message: 'relation missing' } });
        const s = await getAllSettings();
        expect(s).toEqual(expect.objectContaining({
            brandingConfig: { name: 'OPERATIONS', iconUrl: '/media/cross-swords.png' },
            discordConfig: {}, aiConfig: { enabled: false }, governmentsConfig: { enabled: false },
        }));
        expect(mocks.decryptConfigSecrets).not.toHaveBeenCalled();
    });

    it('throws the opaque message on any other read error', async () => {
        db.on('settings', { data: null, error: { code: '08006', message: 'connection reset' } });
        await expect(getAllSettings()).rejects.toThrow('Failed to get settings');
    });

    it('a null data payload yields the defaults', async () => {
        db.on('settings', { data: null });
        const s = await getAllSettings({ decryptSecrets: false });
        expect(s.discordConfig).toEqual({});
        expect(s.aiConfig).toEqual({ enabled: false });
    });

    it('decrypts discord/radio secrets and merges the separately-stored Gemini key by default', async () => {
        db.on('settings', { data: [
            { key: 'discordConfig', value: { botToken: 'enc:bot', clientSecret: 'enc:cs', newRequestChannelId: '1' } },
            { key: 'radioConfig', value: { apiKey: 'enc:lk', apiSecret: 'enc:ls', url: 'wss://lk' } },
            { key: 'aiConfig', value: { enabled: true } },
            { key: 'geminiKey', value: 'enc:gem' },
        ] });
        const s = await getAllSettings();
        expect(s.discordConfig).toEqual({ botToken: 'bot', clientSecret: 'cs', newRequestChannelId: '1' });
        expect(s.radioConfig).toEqual({ apiKey: 'lk', apiSecret: 'ls', url: 'wss://lk' });
        expect(s.aiConfig).toEqual({ enabled: true, apiKey: 'gem' });
        expect(mocks.decryptSecret).toHaveBeenCalledWith('enc:gem');
    });

    it('a non-string geminiKey is merged as-is without a decrypt attempt', async () => {
        const legacy = { raw: 'value' };
        db.on('settings', { data: [{ key: 'geminiKey', value: legacy }] });
        const s = await getAllSettings();
        expect(s.aiConfig).toEqual({ enabled: false, apiKey: legacy });
        expect(mocks.decryptSecret).not.toHaveBeenCalled();
    });

    it('{ decryptSecrets: false } never pulls plaintext credentials into memory', async () => {
        db.on('settings', { data: [
            { key: 'discordConfig', value: { botToken: 'enc:bot' } },
            { key: 'geminiKey', value: 'enc:gem' },
        ] });
        const s = await getAllSettings({ decryptSecrets: false });
        expect(s.discordConfig).toEqual({ botToken: 'enc:bot' });
        expect(s.aiConfig).toEqual({ enabled: false });
        expect(mocks.decryptConfigSecrets).not.toHaveBeenCalled();
        expect(mocks.decryptSecret).not.toHaveBeenCalled();
    });
});

describe('getPublicSettings', () => {
    it('selects ONLY the two public-intent keys and never decrypts', async () => {
        db.on('settings', { data: [{ key: 'brandingConfig', value: { name: 'ACME', iconUrl: '/media/a.png' } }] });
        const s = await getPublicSettings();
        const [q] = db.q('settings');
        expect(arg0(q, 'select')).toBe('key, value');
        expect(has(q, 'in', 'key', ['publicPageConfig', 'brandingConfig'])).toBe(true);
        expect(s.brandingConfig).toEqual({ name: 'ACME', iconUrl: '/media/a.png' });
        expect(s.publicPageConfig.enabled).toBe(false);
        expect(mocks.decryptConfigSecrets).not.toHaveBeenCalled();
        expect(mocks.decryptSecret).not.toHaveBeenCalled();
    });

    it('falls back when the table is missing, and on a null payload', async () => {
        db.once('settings', { data: null, error: { code: '42P01' } });
        expect((await getPublicSettings()).brandingConfig.name).toBe('OPERATIONS');
        db.once('settings', { data: null });
        expect((await getPublicSettings()).brandingConfig.name).toBe('OPERATIONS');
    });

    it('throws the opaque message on any other read error', async () => {
        db.on('settings', { data: null, error: { code: '57014', message: 'timeout' } });
        await expect(getPublicSettings()).rejects.toThrow('Failed to get public settings');
    });
});

describe('first-run setup state', () => {
    it('isSetupCompleted is true only for a literal boolean true', async () => {
        db.once('settings', { data: { value: true } });
        expect(await isSetupCompleted()).toBe(true);
        db.once('settings', { data: { value: 'true' } });
        expect(await isSetupCompleted()).toBe(false);
        db.once('settings', { data: null });
        expect(await isSetupCompleted()).toBe(false);
        const [q] = db.q('settings');
        expect(arg0(q, 'select')).toBe('value');
        expect(has(q, 'eq', 'key', 'setup_completed')).toBe(true);
        expect(has(q, 'maybeSingle')).toBe(true);
    });

    it('setSetupCompleted upserts the flag idempotently on key and reports success', async () => {
        expect(await setSetupCompleted()).toEqual({ success: true });
        const [q] = db.q('settings');
        expect(args(q, 'upsert')[0]).toEqual([{ key: 'setup_completed', value: true }, { onConflict: 'key' }]);
    });

    it('setSetupCompleted surfaces a write failure', async () => {
        db.on('settings', { error: { message: 'boom' } });
        await expect(setSetupCompleted()).rejects.toThrow('Failed to mark setup complete');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getPreflightStatus — fail-closed probes', () => {
    const ENV = ['SUPABASE_JWT_SECRET', 'SECRETS_ENCRYPTION_KEY', 'JWT_SECRET', 'DISCORD_CLIENT_ID'];
    let saved: Record<string, string | undefined>;
    beforeEach(() => { saved = {}; for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
    afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

    it('a settings read ERROR reports the DB as unreachable and never probes for an admin', async () => {
        db.on('settings', { data: null, error: { message: 'down' } });
        const s = await getPreflightStatus();
        expect(s.dbConnected).toBe(false);
        expect(s.adminExists).toBe(false);
        expect(s.setupCompleted).toBe(false);
        expect(db.q('users')).toHaveLength(0);
    });

    it('a THROWN settings read is contained the same way', async () => {
        db.on('settings', () => { throw new Error('socket hang up'); });
        const s = await getPreflightStatus();
        expect(s.dbConnected).toBe(false);
        expect(s.discordConfigured).toBe(false);
    });

    it('reads exactly the three posture keys; a null payload is connected but empty', async () => {
        db.on('settings', { data: null });
        db.on('users', { count: null });
        const s = await getPreflightStatus();
        const [q] = db.q('settings');
        expect(has(q, 'in', 'key', ['setup_completed', 'admin_setup_code', 'discordConfig'])).toBe(true);
        expect(s.dbConnected).toBe(true);
        expect(s.setupCodeExists).toBe(false);
        expect(s.adminExists).toBe(false); // count null ⇒ 0
    });

    it('counts only live users on the resolved Admin role', async () => {
        db.on('settings', { data: [] });
        db.on('users', { count: 2 });
        const s = await getPreflightStatus();
        const [uq] = db.q('users');
        expect(arg0(uq, 'select')).toBe('id');
        expect(args(uq, 'select')[0][1]).toEqual({ count: 'exact', head: true });
        expect(has(uq, 'eq', 'role_id', 4)).toBe(true);
        expect(has(uq, 'is', 'deleted_at', null)).toBe(true);
        expect(s.adminExists).toBe(true);
    });

    it('no resolvable Admin role, or a roles lookup that throws, reports no admin', async () => {
        db.on('settings', { data: [] });
        mocks.getSystemRoles.mockResolvedValueOnce({});
        expect((await getPreflightStatus()).adminExists).toBe(false);
        expect(db.q('users')).toHaveLength(0);
        mocks.getSystemRoles.mockRejectedValueOnce(new Error('roles unreadable'));
        expect((await getPreflightStatus()).adminExists).toBe(false);
    });

    it('a stored discordConfig without a clientId is NOT configured; the env var wins when set', async () => {
        db.on('settings', { data: [{ key: 'discordConfig', value: { guildId: 'g' } }] });
        expect((await getPreflightStatus()).discordConfigured).toBe(false);
        process.env.DISCORD_CLIENT_ID = 'from-env';
        expect((await getPreflightStatus()).discordConfigured).toBe(true);
    });

    it('the 32-character entropy floor is exact: 31 fails, 32 passes', async () => {
        db.on('settings', { data: [] });
        process.env.SUPABASE_JWT_SECRET = 'a'.repeat(31);
        process.env.SECRETS_ENCRYPTION_KEY = 'b'.repeat(32);
        process.env.JWT_SECRET = 'c'.repeat(31);
        const s = await getPreflightStatus();
        expect(s.realtimeEnabled).toBe(false);
        expect(s.secretsEncrypted).toBe(true);
        expect(s.sessionSecretStrong).toBe(false);
    });

    it('once setup is complete it stops being a posture oracle (fixed all-true answer, no admin probe)', async () => {
        db.on('settings', { data: [{ key: 'setup_completed', value: true }, { key: 'admin_setup_code', value: { code: 'X' } }] });
        const s = await getPreflightStatus();
        expect(s).toEqual({
            dbConnected: true, adminExists: true, discordConfigured: true, realtimeEnabled: true,
            secretsEncrypted: true, sessionSecretStrong: true, setupCompleted: true, setupCodeExists: false,
        });
        expect(db.q('users')).toHaveLength(0);
        expect(mocks.getSystemRoles).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('updateDiscordSettings — allow-listed merge', () => {
    const SNOW_A = '123456789012345678';
    const SNOW_B = '223456789012345678';

    it('drops credential keys from the payload, keeps stored credentials, re-encrypts them, and broadcasts', async () => {
        db.on('settings', { data: { value: {
            botToken: 'enc:real-bot', clientSecret: 'enc:real-cs', guildId: 'g-1',
            newRequestChannelId: 'legacy-junk', eamPingRoleId: SNOW_B,
        } } }, keyRead('discordConfig'));
        await updateDiscordSettings({
            botToken: 'attacker-bot', clientSecret: 'attacker-cs', guildId: 'evil-guild', arbitrary: 'x',
            newRequestChannelId: 'legacy-junk', // unchanged legacy junk passes through untouched
            intelChannelId: ` ${SNOW_A} `,        // changed → normalised
            eamPingRoleId: '',                     // changed → cleared to null
        });
        const [read] = db.q('settings');
        expect(arg0(read, 'select')).toBe('value');
        expect(has(read, 'eq', 'key', 'discordConfig')).toBe(true);
        const row = upsertRow();
        expect(row.key).toBe('discordConfig');
        expect(row.value).toEqual({
            botToken: 'enc:real-bot', clientSecret: 'enc:real-cs', guildId: 'g-1',
            newRequestChannelId: 'legacy-junk', intelChannelId: SNOW_A, eamPingRoleId: null,
        });
        expect(args(settingsUpserts()[0], 'upsert')[0][1]).toEqual({ onConflict: 'key' });
        expectSettingsBroadcast();
    });

    it('refuses a CHANGED id that is not a snowflake (no write, no broadcast)', async () => {
        db.on('settings', { data: { value: { intelChannelId: SNOW_A } } }, keyRead('discordConfig'));
        await expect(updateDiscordSettings({ intelChannelId: '../guilds/1/prune?x=' })).rejects.toThrow(/Invalid Discord ID for intelChannelId/);
        expect(settingsUpserts()).toHaveLength(0);
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('with no stored row the base is empty', async () => {
        await updateDiscordSettings({ eamChannelId: SNOW_A });
        expect(upsertRow().value).toEqual({ eamChannelId: SNOW_A });
        expect(mocks.decryptConfigSecrets).toHaveBeenCalledWith('discordConfig', {});
    });

    it('a null for a stored id counts as a change and clears it', async () => {
        db.on('settings', { data: { value: { eamChannelId: SNOW_A } } }, keyRead('discordConfig'));
        await updateDiscordSettings({ eamChannelId: null });
        expect(upsertRow().value).toEqual({ eamChannelId: null });
    });

    it('a write failure throws and does not broadcast', async () => {
        db.on('settings', { error: { message: 'rls' } }, (q) => has(q, 'upsert'));
        await expect(updateDiscordSettings({ eamChannelId: SNOW_A })).rejects.toThrow('Failed to update Discord settings');
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });
});

describe('updateHeroCardConfig', () => {
    it('keeps safe links, silently clears an unsafe background image, preserves other keys', async () => {
        await updateHeroCardConfig({
            title: 'Welcome', backgroundImageUrl: 'javascript:alert(1)',
            discordUrl: 'https://discord.gg/abc', organizationUrl: '',
        });
        expect(upsertRow()).toEqual({ key: 'heroCardConfig', value: {
            title: 'Welcome', backgroundImageUrl: '', discordUrl: 'https://discord.gg/abc', organizationUrl: '',
        } });
        expectSettingsBroadcast();
    });

    it('a null payload persists only the three cleared url fields', async () => {
        await updateHeroCardConfig(null as unknown as Record<string, unknown>);
        expect(upsertRow().value).toEqual({ backgroundImageUrl: '', discordUrl: '', organizationUrl: '' });
    });

    it('REJECTS a private-host link rather than blanking it (stored value untouched)', async () => {
        await expect(updateHeroCardConfig({ discordUrl: 'https://192.168.0.1/x' })).rejects.toThrow('Invalid discordUrl: must be a public https:// URL.');
        await expect(updateHeroCardConfig({ organizationUrl: 'http://example.com' })).rejects.toThrow('Invalid organizationUrl');
        expect(settingsUpserts()).toHaveLength(0);
    });

    it('a write failure throws', async () => {
        db.on('settings', { error: { message: 'x' } });
        await expect(updateHeroCardConfig({})).rejects.toThrow('Failed to update hero card config');
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });
});

describe('updateBrandingConfig', () => {
    it('sanitises icon, terms, theme colour and every sound URL on write', async () => {
        await updateBrandingConfig({
            name: 'ACME', iconUrl: '/media/acme.png',
            termsOfService: '<p>ok</p><script>alert(1)</script><img src=x onerror=alert(1)>',
            themeColor: '  #ABCDEF  ',
            bootSoundUrl: 'https://cdn.example.com/boot.mp3', eamSoundUrl: '',
        });
        const v = upsertRow().value;
        expect(upsertRow().key).toBe('brandingConfig');
        expect(v.name).toBe('ACME');
        expect(v.iconUrl).toBe('/media/acme.png');
        expect(String(v.termsOfService)).toContain('<p>ok</p>');
        expect(String(v.termsOfService)).not.toMatch(/<script|onerror/i);
        expect(v.themeColor).toBe('#ABCDEF');
        expect(v.bootSoundUrl).toBe('https://cdn.example.com/boot.mp3');
        expect(v.eamSoundUrl).toBe('');
        expectSettingsBroadcast();
    });

    it('a crafted non-string termsOfService is coerced to safe output, never spread verbatim', async () => {
        await updateBrandingConfig({ termsOfService: ['<img src=x onerror=alert(1)>'] });
        expect(upsertRow().value.termsOfService).toBe('');
    });

    it('drops an invalid or non-string themeColor instead of persisting it', async () => {
        await updateBrandingConfig({ themeColor: 'red' });
        expect('themeColor' in upsertRow(0).value).toBe(false);
        await updateBrandingConfig({ themeColor: 0xffffff });
        expect('themeColor' in upsertRow(1).value).toBe(false);
    });

    it('a null payload upserts an empty value', async () => {
        await updateBrandingConfig(null as unknown as Record<string, unknown>);
        expect(upsertRow().value).toEqual({});
    });

    it('REJECTS an off-allow-list icon or sound URL (no write)', async () => {
        await expect(updateBrandingConfig({ iconUrl: 'https://evil.example/track.php' })).rejects.toThrow(/^Invalid iconUrl: must be an https image URL/);
        await expect(updateBrandingConfig({ radioSquelchUrl: 'http://10.0.0.5/s.mp3' })).rejects.toThrow('Invalid radioSquelchUrl: must be a public https:// URL.');
        expect(settingsUpserts()).toHaveLength(0);
    });

    it('a write failure throws', async () => {
        db.on('settings', { error: { message: 'x' } });
        await expect(updateBrandingConfig({ name: 'x' })).rejects.toThrow('Failed to update branding config');
    });
});

describe('updateThemeConfig — allow-list rebuild', () => {
    it('rejects a non-object payload', async () => {
        await expect(updateThemeConfig(null as unknown as Record<string, unknown>)).rejects.toThrow('Invalid theme config payload');
        await expect(updateThemeConfig('x' as unknown as Record<string, unknown>)).rejects.toThrow('Invalid theme config payload');
        expect(settingsUpserts()).toHaveLength(0);
    });

    it('persists ONLY {enabled, accent}, with accent canonicalised', async () => {
        await updateThemeConfig({ enabled: true, accent: '#AbC', css: 'body{}', __proto__x: 1 });
        expect(upsertRow()).toEqual({ key: 'themeConfig', value: { enabled: true, accent: '#aabbcc' } });
        expect(args(settingsUpserts()[0], 'upsert')[0][1]).toEqual({ onConflict: 'key' });
        expectSettingsBroadcast();
    });

    it('a truthy-but-not-true enabled is false and an invalid accent is dropped', async () => {
        await updateThemeConfig({ enabled: 'yes', accent: 'url(javascript:x)' });
        expect(upsertRow().value).toEqual({ enabled: false });
    });

    it('a write failure throws', async () => {
        db.on('settings', { error: { message: 'x' } });
        await expect(updateThemeConfig({ enabled: true })).rejects.toThrow('Failed to update theme config');
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });
});

describe('updateOpenGraphConfig', () => {
    it('silently clears unsafe image fields, keeps safe ones, drops an invalid colour', async () => {
        await updateOpenGraphConfig({
            title: 'T', imageUrl: 'https://cdn.example.com/og.png', faviconUrl: 'http://x/f.png',
            pwaIconUrl: 'https://cdn.example.com/icon.txt', themeColor: 'rgb(1,2,3)',
        });
        expect(upsertRow()).toEqual({ key: 'openGraphConfig', value: {
            title: 'T', imageUrl: 'https://cdn.example.com/og.png', faviconUrl: '', pwaIconUrl: '',
        } });
        expectSettingsBroadcast();
    });

    it('keeps a valid colour and a valid pwa icon; a null payload stores {}', async () => {
        await updateOpenGraphConfig({ themeColor: '#11223344', pwaIconUrl: 'https://cdn.example.com/p.webp', imageUrl: 'data:image/png;base64,AAAA' });
        expect(upsertRow(0).value).toEqual({ themeColor: '#11223344', pwaIconUrl: 'https://cdn.example.com/p.webp', imageUrl: '' });
        await updateOpenGraphConfig(null as unknown as Record<string, unknown>);
        expect(upsertRow(1).value).toEqual({});
    });

    it('a write failure throws', async () => {
        db.on('settings', { error: { message: 'x' } });
        await expect(updateOpenGraphConfig({})).rejects.toThrow('Failed to update OpenGraph config');
    });
});

describe('updateRadioConfig — merge preserves LiveKit credentials', () => {
    it('merges over the decrypted stored row and re-encrypts the secrets', async () => {
        db.on('settings', { data: { value: { apiKey: 'enc:key', apiSecret: 'enc:secret', url: 'wss://old' } } }, keyRead('radioConfig'));
        await updateRadioConfig({ url: 'wss://new' });
        const [read] = db.q('settings');
        expect(arg0(read, 'select')).toBe('value');
        expect(has(read, 'eq', 'key', 'radioConfig')).toBe(true);
        expect(upsertRow()).toEqual({ key: 'radioConfig', value: { apiKey: 'enc:key', apiSecret: 'enc:secret', url: 'wss://new' } });
        expectSettingsBroadcast();
    });

    it('a new secret in the payload is stored encrypted, never plaintext', async () => {
        await updateRadioConfig({ apiSecret: 'fresh-secret' });
        expect(upsertRow().value).toEqual({ apiSecret: 'enc:fresh-secret' });
        expect(mocks.decryptConfigSecrets).toHaveBeenCalledWith('radioConfig', {});
    });

    it('a write failure throws and does not broadcast', async () => {
        db.on('settings', { error: { message: 'x' } }, (q) => has(q, 'upsert'));
        await expect(updateRadioConfig({ url: 'wss://x' })).rejects.toThrow('Failed to update radio config');
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });
});

describe('updateWikiHomeConfig', () => {
    it('rejects a non-object payload and unknown fields before any read', async () => {
        await expect(updateWikiHomeConfig(null as never)).rejects.toThrow('Invalid wiki home config payload');
        await expect(updateWikiHomeConfig({ evil: 1 } as never)).rejects.toThrow('Unknown wiki home config field: evil');
        expect(db.queries).toHaveLength(0);
    });

    it('fails CLOSED on a read fault: no write', async () => {
        db.on('settings', { error: { message: 'blip' } }, (q) => has(q, 'maybeSingle'));
        await expect(updateWikiHomeConfig({ hideRecentlyUpdated: true })).rejects.toThrow('Failed to read wiki home config');
        expect(settingsUpserts()).toHaveLength(0);
    });

    it('merges over the stored row through the allow-list (a stray stored key is dropped)', async () => {
        db.on('settings', { data: { value: { featuredPageIds: ['a'], hideRecentlyUpdated: false, legacyJunk: 1 } } }, keyRead('wikiHomeConfig'));
        await updateWikiHomeConfig({ hideRecentlyUpdated: 1 as unknown as boolean });
        expect(upsertRow()).toEqual({ key: 'wikiHomeConfig', value: { featuredPageIds: ['a'], hideRecentlyUpdated: true } });
        expectSettingsBroadcast();
    });

    it('featuredPageIds: a non-array becomes [], non-strings are filtered and the list is capped at 50', async () => {
        await updateWikiHomeConfig({ featuredPageIds: 'p1' as unknown as string[] }, { merge: false });
        expect(upsertRow(0).value).toEqual({ featuredPageIds: [] });
        const many = Array.from({ length: 60 }, (_, i) => `p${i}`);
        await updateWikiHomeConfig({ featuredPageIds: [1, null, ...many] as unknown as string[] }, { merge: false });
        expect(upsertRow(1).value.featuredPageIds).toEqual(many.slice(0, 50));
        // merge:false never reads the stored row (the importer path).
        expect(db.q('settings').filter((q) => has(q, 'maybeSingle'))).toHaveLength(0);
    });

    it('merge with no stored row starts from an empty base', async () => {
        await updateWikiHomeConfig({ hideRecentlyUpdated: false });
        expect(upsertRow().value).toEqual({ hideRecentlyUpdated: false });
    });

    it('a welcome document handed back UNCHANGED re-stores the stored value without re-sanitising it', async () => {
        // A legacy stored node the current sanitiser would drop proves the sanitiser did not run.
        const stored = { type: 'doc', content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Legacy' }] },
            { type: 'iframe', attrs: { src: 'https://legacy-host.example/embed' } },
        ] };
        db.on('settings', { data: { value: { welcomeContent: stored, hideRecentlyUpdated: false } } }, keyRead('wikiHomeConfig'));
        await updateWikiHomeConfig({ welcomeContent: structuredClone(stored) as never, hideRecentlyUpdated: true });
        expect(upsertRow().value).toEqual({ welcomeContent: stored, hideRecentlyUpdated: true });
    });

    it('an EDITED welcome document (stored one present) takes the sanitise path', async () => {
        const stored = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old' }] }] };
        const edited = { type: 'doc', content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'New' }] },
            { type: 'iframe', attrs: { src: 'https://legacy-host.example/embed' } },
        ] };
        db.on('settings', { data: { value: { welcomeContent: stored } } }, keyRead('wikiHomeConfig'));
        await updateWikiHomeConfig({ welcomeContent: edited as never });
        const out = JSON.stringify(upsertRow().value.welcomeContent);
        expect(out).toContain('New');
        expect(out).not.toContain('legacy-host');
    });

    it('a posted document that cannot be serialised fails the equality check SAFE (sanitised, not passed through)', async () => {
        const stored = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Same' }] }] };
        const posted = { type: 'doc', content: [{ type: 'paragraph', attrs: { weird: BigInt(1) }, content: [{ type: 'text', text: 'Same' }] }] };
        db.on('settings', { data: { value: { welcomeContent: stored } } }, keyRead('wikiHomeConfig'));
        await updateWikiHomeConfig({ welcomeContent: posted as never });
        const value = upsertRow().value.welcomeContent as { content: Array<{ attrs?: Record<string, unknown> }> };
        expect(value.content[0].attrs?.weird).toBeUndefined();
        expect(JSON.stringify(value)).toContain('Same');
    });

    it('an explicitly cleared welcome document is stored as null', async () => {
        await updateWikiHomeConfig({ welcomeContent: '' as never }, { merge: false });
        expect(upsertRow().value).toEqual({ welcomeContent: null });
    });

    it('a posted welcome document is sanitised (disallowed iframe host dropped) before storage', async () => {
        const doc = { type: 'doc', content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
            { type: 'iframe', attrs: { src: 'https://evil.example/frame' } },
        ] };
        await updateWikiHomeConfig({ welcomeContent: doc as never }, { merge: false });
        const stored = JSON.stringify(upsertRow().value.welcomeContent);
        expect(stored).toContain('Hello');
        expect(stored).not.toContain('evil.example');
    });

    it('a write failure throws', async () => {
        db.on('settings', { error: { message: 'x' } }, (q) => has(q, 'upsert'));
        await expect(updateWikiHomeConfig({ hideRecentlyUpdated: true }, { merge: false })).rejects.toThrow('Failed to update wiki home config');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('updatePublicPageConfig — write-boundary validation', () => {
    const okLink = { id: 'l1', label: 'Site', url: 'https://example.com' };

    it('rejects a non-object payload and unknown keys', async () => {
        await expect(updatePublicPageConfig(null as unknown as Record<string, unknown>)).rejects.toThrow('Invalid public page config payload');
        await expect(updatePublicPageConfig({ enabled: true, script: 'x' })).rejects.toThrow('Unknown public page config field: script');
        expect(settingsUpserts()).toHaveLength(0);
    });

    it('rebuilds the value from scratch: stripped motto, coerced modules, validated images', async () => {
        await updatePublicPageConfig({
            enabled: 1, motto: '<b>Fly</b> safe', blurb: 'plain <i>text</i>',
            heroImageUrl: 'https://cdn.example.com/hero.jpg', profileImageUrl: '',
            modules: { stats: 1, testimonials: 0, services: 'y', links: null, extra: true },
            links: [okLink], featuredTestimonialIds: [],
        });
        expect(upsertRow()).toEqual({ key: 'publicPageConfig', value: {
            enabled: true, motto: 'Fly safe', blurb: 'plain text',
            heroImageUrl: 'https://cdn.example.com/hero.jpg', profileImageUrl: '',
            modules: { stats: true, testimonials: false, services: true, links: false },
            // The URL is the sanitiser's canonical form, not the raw input.
            links: [{ ...okLink, url: 'https://example.com/' }], featuredTestimonialIds: [],
        } });
        expect(args(settingsUpserts()[0], 'upsert')[0][1]).toEqual({ onConflict: 'key' });
        expect(mocks.verifyFeaturedTestimonialIdsBelongToOrg).not.toHaveBeenCalled();
        expectSettingsBroadcast();
    });

    it('non-object modules and a missing links array collapse to the all-off / empty defaults', async () => {
        await updatePublicPageConfig({ modules: 'all', links: 'x', featuredTestimonialIds: 'y' });
        const v = upsertRow().value;
        expect(v.modules).toEqual({ stats: false, testimonials: false, services: false, links: false });
        expect(v.links).toEqual([]);
        expect(v.featuredTestimonialIds).toEqual([]);
        expect(v.blurb).toBe('');
    });

    it('a Tiptap blurb is sanitised in minimal mode (javascript: link dropped) and re-serialised', async () => {
        const blurb = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [
            { type: 'text', text: 'Join', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
            { type: 'image', attrs: { src: 'https://x/y.png' } },
        ] }] });
        await updatePublicPageConfig({ blurb });
        const stored = String(upsertRow().value.blurb);
        expect(JSON.parse(stored).type).toBe('doc');
        expect(stored).toContain('Join');
        expect(stored).not.toContain('javascript:');
        expect(stored).not.toContain('"image"');
    });

    it('caps a serialised Tiptap blurb at 8000 characters', async () => {
        const blurb = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(9000) }] }] });
        await updatePublicPageConfig({ blurb });
        expect(String(upsertRow().value.blurb)).toHaveLength(8000);
    });

    it('image fields: non-string and non-https are refused with field-named errors', async () => {
        await expect(updatePublicPageConfig({ heroImageUrl: 42 })).rejects.toThrow('heroImageUrl must be a string');
        await expect(updatePublicPageConfig({ profileImageUrl: 'http://cdn.example.com/p.png' })).rejects.toThrow(/^profileImageUrl must be an https URL/);
        expect(settingsUpserts()).toHaveLength(0);
    });

    it('links: cap of 10, entry shape, URL policy, label requirement', async () => {
        await expect(updatePublicPageConfig({ links: Array.from({ length: 11 }, () => okLink) })).rejects.toThrow('At most 10 external links are allowed');
        await expect(updatePublicPageConfig({ links: [null] })).rejects.toThrow('Invalid link entry');
        await expect(updatePublicPageConfig({ links: [{ label: 'x', url: 'https://127.0.0.1/' }] })).rejects.toThrow(/^Link URL must be a public https:\/\/ URL/);
        await expect(updatePublicPageConfig({ links: [{ label: '<b></b>', url: 'https://example.com' }] })).rejects.toThrow('Each link requires a label and a URL');
        expect(settingsUpserts()).toHaveLength(0);
    });

    it('links: backfills a missing id, caps a long id, strips tags from the icon, omits an empty icon', async () => {
        await updatePublicPageConfig({ links: [
            { label: 'Discord', url: 'discord://invite/abc', icon: '<svg>discord</svg>' },
            { id: 'i'.repeat(80), label: 'Site', url: 'https://example.com', icon: '' },
            { id: '', label: 'Other', url: 'https://example.org', icon: 7 },
        ] });
        const links = upsertRow().value.links as Array<Record<string, unknown>>;
        expect(links[0]).toEqual({ id: expect.stringMatching(/^lnk_[A-Za-z0-9_-]{8}$/), label: 'Discord', url: 'discord://invite/abc', icon: 'discord' });
        expect(links[1]).toEqual({ id: 'i'.repeat(64), label: 'Site', url: 'https://example.com/' });
        expect(links[2].id).toMatch(/^lnk_/);
        expect('icon' in links[2]).toBe(false);
    });

    it('featured testimonials: cap of 6, string ids, uniqueness', async () => {
        await expect(updatePublicPageConfig({ featuredTestimonialIds: ['1', '2', '3', '4', '5', '6', '7'] })).rejects.toThrow('At most 6 featured testimonials are allowed');
        await expect(updatePublicPageConfig({ featuredTestimonialIds: [5] })).rejects.toThrow('Invalid testimonial id');
        await expect(updatePublicPageConfig({ featuredTestimonialIds: [''] })).rejects.toThrow('Invalid testimonial id');
        await expect(updatePublicPageConfig({ featuredTestimonialIds: ['a', 'a'] })).rejects.toThrow('Featured testimonials must be unique');
        expect(mocks.verifyFeaturedTestimonialIdsBelongToOrg).not.toHaveBeenCalled();
    });

    it('featured testimonials are verified server-side; an injected id is refused with the offending ids named', async () => {
        mocks.verifyFeaturedTestimonialIdsBelongToOrg.mockResolvedValueOnce({ ok: false, invalidIds: ['b', 'c'] });
        await expect(updatePublicPageConfig({ featuredTestimonialIds: ['a', 'b', 'c'] }))
            .rejects.toThrow('Featured testimonial ids do not belong to your organization or are not rated with feedback: b, c');
        expect(mocks.verifyFeaturedTestimonialIdsBelongToOrg).toHaveBeenCalledWith(['a', 'b', 'c']);
        expect(settingsUpserts()).toHaveLength(0);
    });

    it('verified testimonials are persisted in order', async () => {
        await updatePublicPageConfig({ featuredTestimonialIds: ['t2', 't1'] });
        expect(upsertRow().value.featuredTestimonialIds).toEqual(['t2', 't1']);
    });

    it('a write failure throws and does not broadcast', async () => {
        db.on('settings', { error: { message: 'x' } });
        await expect(updatePublicPageConfig({ enabled: true })).rejects.toThrow('Failed to update public page config');
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });
});

describe('updateAIConfig — the API key never rides the aiConfig row', () => {
    it('stores the config without apiKey, then the key ENCRYPTED in its own row', async () => {
        await updateAIConfig({ enabled: true, model: 'gemini', apiKey: 'AIza-secret' });
        expect(upsertRow(0)).toEqual({ key: 'aiConfig', value: { enabled: true, model: 'gemini' } });
        expect(upsertRow(1)).toEqual({ key: 'geminiKey', value: 'enc:AIza-secret' });
        expect(JSON.stringify(upsertRow(0))).not.toContain('AIza-secret');
        expectSettingsBroadcast();
    });

    it('without an apiKey only the config row is written', async () => {
        await updateAIConfig({ enabled: false });
        expect(settingsUpserts()).toHaveLength(1);
        expect(mocks.encryptSecret).not.toHaveBeenCalled();
    });

    it('a config write failure stops before the key write', async () => {
        db.once('settings', { error: { message: 'x' } });
        await expect(updateAIConfig({ enabled: true, apiKey: 'k' })).rejects.toThrow('Failed to update AI config');
        expect(settingsUpserts()).toHaveLength(1);
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('a key write failure throws and does not broadcast', async () => {
        db.on('settings', { error: { message: 'x' } }, (q) => (arg0(q, 'upsert') as { key: string }).key === 'geminiKey');
        await expect(updateAIConfig({ enabled: true, apiKey: 'k' })).rejects.toThrow('Failed to update Gemini API Key');
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });
});

describe('single-row config writers', () => {
    it.each([
        ['hrConfig', () => updateHRConfig({ probationDays: 30 }), { probationDays: 30 }, 'Failed to update HR config'],
        ['governmentsConfig', () => updateGovernmentsConfig({ enabled: true } as never), { enabled: true }, 'Failed to update governments config'],
        ['intelSharingConfig', () => updateIntelSharingConfig({ maxShareableClearance: 2 }), { maxShareableClearance: 2 }, 'Failed to update intel sharing config'],
    ])('%s: upserts on key, broadcasts, and surfaces a write error', async (key, run, value, msg) => {
        await run();
        expect(args(settingsUpserts()[0], 'upsert')[0]).toEqual([{ key, value }, { onConflict: 'key' }]);
        expectSettingsBroadcast();
        resetHarness();
        db.on('settings', { error: { message: 'x' } });
        await expect(run()).rejects.toThrow(msg);
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('getIntelSharingConfig returns the stored value, else a share-nothing default', async () => {
        db.once('settings', { data: { value: { maxShareableClearance: 3 } } });
        expect(await getIntelSharingConfig()).toEqual({ maxShareableClearance: 3 });
        expect(await getIntelSharingConfig()).toEqual({ maxShareableClearance: 0 });
        expect(has(db.q('settings')[0], 'eq', 'key', 'intelSharingConfig')).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('optional features', () => {
    it('getOrgFeatures reads the orgFeatures row and THROWS on a read fault', async () => {
        db.once('settings', { data: { value: { warehouse: { enabled: true } } } });
        expect(await getOrgFeatures()).toEqual({ warehouse: { enabled: true } });
        expect(has(db.q('settings')[0], 'eq', 'key', 'orgFeatures')).toBe(true);
        expect(await getOrgFeatures()).toEqual({});
        db.once('settings', { error: { message: 'x' } });
        await expect(getOrgFeatures()).rejects.toThrow('Failed to read optional features');
    });

    it('updateOrgFeatures one-level deep-merges objects and replaces scalars/arrays', async () => {
        db.on('settings', { data: { value: { warehouse: { enabled: true, location: 'HQ' }, finances: { enabled: true }, tags: ['a'] } } }, (q) => has(q, 'maybeSingle'));
        const next = await updateOrgFeatures({ warehouse: { enabled: false }, academy: { enabled: true }, tags: ['b'], finances: null });
        expect(next).toEqual({ warehouse: { enabled: false, location: 'HQ' }, finances: null, tags: ['b'], academy: { enabled: true } });
        expect(upsertRow()).toEqual({ key: 'orgFeatures', value: next });
        expectSettingsBroadcast();
    });

    it('updateOrgFeatures with no stored row writes just the patch', async () => {
        expect(await updateOrgFeatures({ warehouse: { enabled: true } })).toEqual({ warehouse: { enabled: true } });
    });

    it('updateOrgFeatures refuses on a read fault (no write) and surfaces a write fault', async () => {
        db.once('settings', { error: { message: 'x' } });
        await expect(updateOrgFeatures({ warehouse: { enabled: true } })).rejects.toThrow('Failed to read optional features — no change was made');
        expect(settingsUpserts()).toHaveLength(0);
        db.on('settings', { error: { message: 'x' } }, (q) => has(q, 'upsert'));
        await expect(updateOrgFeatures({ warehouse: { enabled: true } })).rejects.toThrow('Failed to update optional features');
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('isFeatureEnabled: strict truthiness of .enabled; read fault fails closed', async () => {
        db.once('settings', { data: { value: { warehouse: { enabled: true }, finances: { enabled: 0 } } } });
        expect(await isFeatureEnabled('warehouse')).toBe(true);
        db.once('settings', { data: { value: { finances: { enabled: 0 } } } });
        expect(await isFeatureEnabled('finances')).toBe(false);
        db.once('settings', { error: { message: 'down' } });
        expect(await isFeatureEnabled('warehouse')).toBe(false);
    });

    it('isGovernmentEnabled reads its OWN row; null or a throw is OFF', async () => {
        db.once('settings', { data: { value: { enabled: true } } });
        expect(await isGovernmentEnabled()).toBe(true);
        expect(has(db.q('settings')[0], 'eq', 'key', 'governmentsConfig')).toBe(true);
        expect(await isGovernmentEnabled()).toBe(false);
        db.once('settings', () => { throw new Error('socket'); });
        expect(await isGovernmentEnabled()).toBe(false);
    });

    it('isOptionalFeatureEnabled routes government to governmentsConfig and the rest to orgFeatures', async () => {
        db.on('settings', { data: { value: { enabled: true } } }, keyRead('governmentsConfig'));
        db.on('settings', { data: { value: { marketplace: { enabled: true } } } }, keyRead('orgFeatures'));
        expect(await isOptionalFeatureEnabled('government')).toBe(true);
        expect(await isOptionalFeatureEnabled('marketplace')).toBe(true);
        expect(await isOptionalFeatureEnabled('academy')).toBe(false);
        expect(db.where('settings', 'eq', 'key', 'governmentsConfig')).toHaveLength(1);
        expect(db.where('settings', 'eq', 'key', 'orgFeatures')).toHaveLength(2);
    });
});
