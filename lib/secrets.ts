
import { supabase } from './db.js';
import { decryptConfigSecrets, decryptSecret } from './crypto.js';
import { log as baseLog } from './log.js';

const log = baseLog.child({ module: 'lib.secrets' });

export async function getOrgSecret(key: string): Promise<string | null> {
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
