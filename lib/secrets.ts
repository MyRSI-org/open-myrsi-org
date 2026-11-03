
import { supabase } from './db.js';
import { decryptConfigSecrets, decryptSecret } from './crypto.js';
import { log as baseLog } from './log.js';

const log = baseLog.child({ module: 'lib.secrets' });

/**
 * The only names getOrgSecret resolves. The env var of the same name wins over the
 * stored value, so an open-ended `key` would make this a read of ANY environment
 * variable (SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, SECRETS_ENCRYPTION_KEY, …).
 */
export const ORG_SECRET_NAMES = [
    'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID',
    'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_URL',
    'GEMINI_API_KEY',
] as const;

export type OrgSecretName = typeof ORG_SECRET_NAMES[number];

const SUPPORTED_NAMES: ReadonlySet<string> = new Set(ORG_SECRET_NAMES);

export async function getOrgSecret(key: OrgSecretName): Promise<string | null> {
    // The type keeps callers to the allowlist at compile time; this holds it at
    // runtime too (a cast, an `any`, a computed name). Refuse before any read and
    // log the requested NAME only, capped, never a value.
    if (typeof key !== 'string' || !SUPPORTED_NAMES.has(key)) {
        log.warn('unsupported secret name refused', { key: typeof key === 'string' ? key.slice(0, 64) : `<${typeof key}>` });
        return null;
    }
    try {
        // Read the single org's (admin-entered, encrypted) config from settings.
        const { data } = await supabase.from('settings')
            .select('key, value')
            .in('key', ['discordConfig', 'radioConfig', 'aiConfig', 'geminiKey']);

        const configs: Record<string, any> = {};
        data?.forEach((item: any) => {
            configs[item.key] = item.value;
        });

        // Decrypt sensitive fields after reading from DB
        const discord = decryptConfigSecrets('discordConfig', configs['discordConfig'] || {});
        const radio = decryptConfigSecrets('radioConfig', configs['radioConfig'] || {});
        const ai = configs['aiConfig'] || {};

        let secretValue: string | null = null;

        // Discord
        if (key === 'DISCORD_CLIENT_ID') secretValue = discord.clientId;
        else if (key === 'DISCORD_CLIENT_SECRET') secretValue = discord.clientSecret;
        else if (key === 'DISCORD_BOT_TOKEN') secretValue = discord.botToken;
        else if (key === 'DISCORD_GUILD_ID') secretValue = discord.guildId;

        // LiveKit (Radio)
        else if (key === 'LIVEKIT_API_KEY') secretValue = radio.apiKey;
        else if (key === 'LIVEKIT_API_SECRET') secretValue = radio.apiSecret;
        else if (key === 'LIVEKIT_URL') secretValue = radio.url;

        // AI (Gemini) - Check dedicated geminiKey first, then aiConfig.apiKey
        // geminiKey may be stored as a raw string or encrypted — decrypt transparently
        else if (key === 'GEMINI_API_KEY') {
            const rawKey = configs['geminiKey'];
            const decryptedKey = typeof rawKey === 'string' ? decryptSecret(rawKey) : rawKey?.apiKey || rawKey?.key || null;
            secretValue = decryptedKey || ai.apiKey;
        }

        // Env vars win; the DB/admin-console value is only a fallback.
        return process.env[key] || secretValue || null;

    } catch (e) {
        log.error('secret fetch failed', { key, err: e });
        return null;
    }
}
