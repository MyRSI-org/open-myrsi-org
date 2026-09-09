/**
 * The single source of truth for which `discordConfig` keys the admin console may
 * WRITE and which are safe to hand a client.
 *
 * WHY THIS FILE EXISTS. A discordConfig key has to be declared in two places that
 * had no connection to each other, and missing either fails SILENTLY:
 *   1. `updateDiscordSettings` (lib/db/system.ts) — the write allowlist. Missing =>
 *      the save is silently discarded and the field never persists.
 *   2. `stripSecrets` (api/query.ts) — the read-back rebuild. Missing => the value
 *      saves correctly but never reaches the client, so the admin console field
 *      reverts to blank and it looks like the save failed. That is exactly what
 *      shipped for `defaultOperationAnnounceChannelId`, which also silently
 *      disabled the org-wide announce-channel default in the create-operation
 *      wizard and the op Administer tab.
 *
 * `tests/discordConfigKeyParity.test.ts` pins both sites to these constants.
 *
 * ADDING A KEY: add it here and to the `DiscordConfig` type in types.ts. Nothing
 * else. A key that is a SECRET (a token, a client secret) does NOT belong here —
 * those live in `SENSITIVE_FIELDS` (lib/crypto.ts), are encrypted at rest, and in
 * this self-hosted build come from the environment (DISCORD_CLIENT_SECRET /
 * DISCORD_BOT_TOKEN, see lib/secrets.ts), never from an RPC payload.
 *
 * Deliberately import-free so it compiles under BOTH tsconfigs and a client
 * component may import it (it is not on eslint.config.js's server-only list).
 */

/**
 * Channel/role ids the admin console's Discord settings tab may write.
 *
 * Deliberately excludes `clientId`, `guildId`, `botToken` and `clientSecret`:
 * those are the deployment's Discord identity/credentials, sourced from `.env`
 * (env wins in getOrgSecret), and letting an admin RPC write them would repoint
 * or hijack the whole integration on any deployment that leaves those env vars
 * unset.
 *
 * Ping-role ids get added HERE and nowhere else. Both of the ones below are read
 * SERVER-SIDE at send time and never taken from a request payload: configuring who
 * gets pinged is an admin:config:discord decision, while triggering the send is a
 * different, wider permission (operations:create, admin:broadcast:eam). Keeping the
 * role id out of every payload is what keeps those two apart.
 */
export const ADMIN_WRITABLE_DISCORD_KEYS = [
    'newRequestChannelId',
    'intelChannelId',
    'eamChannelId',
    'defaultOperationAnnounceChannelId',
    'craftingRequestChannelId',
    'eamPingRoleId',
    'operationAnnouncePingRoleId',
] as const;

export type AdminWritableDiscordKey = typeof ADMIN_WRITABLE_DISCORD_KEYS[number];

/**
 * What may be returned to an authed client.
 *
 * `clientId` is the public OAuth application id — non-secret by construction (it
 * is in the OAuth URL every user visits) and needed by the login button, but NOT
 * admin-writable. Everything else is a channel/role id: non-secret, but only
 * meaningful to someone already inside the org.
 */
export const CLIENT_SAFE_DISCORD_KEYS = [
    'clientId',
    ...ADMIN_WRITABLE_DISCORD_KEYS,
] as const;

export type ClientSafeDiscordKey = typeof CLIENT_SAFE_DISCORD_KEYS[number];

/** A Discord snowflake: 17-19 digits. Same shape api/actions/admin.ts already
 *  validates the per-comms-plan channel override with. */
export const DISCORD_SNOWFLAKE_RE = /^\d{17,19}$/;

/**
 * Normalise one admin-supplied channel/role id.
 *
 * Returns `null` for empty (an explicit "clear this setting"), the trimmed string
 * when it is a valid snowflake, and THROWS otherwise — because these values are
 * interpolated straight into Discord API paths (`/channels/${id}/messages`) and
 * into mention markup, and a silently-stored junk value surfaces later as "the
 * bot doesn't post" with nothing in the logs.
 *
 * Note the cleared-value asymmetry, which is deliberate and harmless: this
 * returns `null`, while updateDiscordSettings' unchanged-value passthrough stores
 * whatever was already there (typically `''`). Both are falsy and every consumer
 * reads them as `|| ''`.
 */
export function normaliseDiscordSnowflake(value: unknown, fieldName: string): string | null {
    if (value == null) return null;
    const str = String(value).trim();
    if (str === '') return null;
    if (!DISCORD_SNOWFLAKE_RE.test(str)) {
        throw new Error(`Invalid Discord ID for ${fieldName}. Must be a 17-19 digit numeric ID (or empty to clear).`);
    }
    return str;
}
