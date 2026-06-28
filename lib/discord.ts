
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiscordRole } from '../types.js';
import { supabase, handleSupabaseError } from './db/common.js';
import { cache } from './cache.js';

import { getOrgSecret } from './secrets.js';
import { stripHtmlSingleLine } from './textSanitize.js';
import { log as baseLog } from './log.js';

const log = baseLog.child({ module: 'lib.discord' });

const API_ENDPOINT = 'https://discord.com/api/v10';

// Build the canonical global Discord avatar URL for a user.
// - Always uses the global user avatar (cdn.discordapp.com/avatars/{id}/{hash}),
//   never guild-specific (cdn.discordapp.com/guilds/.../users/.../avatars),
//   because guild avatars disappear when a user leaves or edits their per-server
//   profile and produce broken images in our cached URLs.
// - Falls back to Discord's index-derived default avatar (`embed/avatars/{n}.png`)
//   when the user has no avatar set; these URLs are permanent and never 404.
export function buildGlobalAvatarUrl(discordUser: { id: string; avatar?: string | null; discriminator?: string | null }): string {
    const { id, avatar, discriminator } = discordUser;
    if (avatar) {
        const ext = avatar.startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/avatars/${id}/${avatar}.${ext}`;
    }
    // No avatar — use Discord's default. Post-username-migration (discriminator === '0'
    // or absent) Discord keys defaults by (snowflake >> 22) % 6; legacy accounts use
    // `parseInt(discriminator) % 5`.
    try {
        if (!discriminator || discriminator === '0') {
            const idx = Number((BigInt(id) >> 22n) % 6n);
            return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
        }
        const idx = parseInt(discriminator, 10) % 5;
        return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
    } catch {
        return 'https://cdn.discordapp.com/embed/avatars/0.png';
    }
}

// Cache the event banner image as base64 data URI (loaded once at startup)
let eventBannerDataUri: string | null = null;
function getEventBannerDataUri(): string | null {
    if (eventBannerDataUri) return eventBannerDataUri;
    try {
        const imagePath = join(process.cwd(), 'dist', 'media', 'discord-event-banner.jpg');
        const imageBuffer = readFileSync(imagePath);
        eventBannerDataUri = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
        return eventBannerDataUri;
    } catch {
        // Fallback: try from public dir (dev mode)
        try {
            const imagePath = join(process.cwd(), 'public', 'media', 'discord-event-banner.jpg');
            const imageBuffer = readFileSync(imagePath);
            eventBannerDataUri = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
            return eventBannerDataUri;
        } catch {
            log.warn('event banner image not found');
            return null;
        }
    }
}

// Rate-limited queue for Discord API calls (respects 10 role changes per 10 seconds per guild)
const guildRoleQueues = new Map<string, Promise<void>>();
const ROLE_CHANGE_DELAY_MS = 1100; // ~1 second between role changes to stay under rate limits

async function enqueueGuildRoleChange(guildId: string, fn: () => Promise<void>): Promise<void> {
    const prev = guildRoleQueues.get(guildId) || Promise.resolve();
    const next = prev.then(async () => {
        await fn();
        await new Promise(resolve => setTimeout(resolve, ROLE_CHANGE_DELAY_MS));
    }).catch(err => {
        log.error('queued role change failed', { guildId, err });
    });
    guildRoleQueues.set(guildId, next);
    return next;
}

// Per-channel queue for message + reaction calls. Discord enforces 5 msgs / 5s
// per channel; chaining a post with three reaction PUTs through the same queue
// guarantees we stay under that ceiling even when multiple ops are created
// back-to-back. Returns the awaited result of `fn` so callers can read e.g.
// the new message ID.
const channelPostQueues = new Map<string, Promise<unknown>>();
const CHANNEL_POST_DELAY_MS = 250;

async function enqueueChannelPost<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    const prev = channelPostQueues.get(channelId) || Promise.resolve();
    const run = prev.then(async () => {
        const result = await fn();
        await new Promise(resolve => setTimeout(resolve, CHANNEL_POST_DELAY_MS));
        return result;
    });
    // Track the chain without the result type — failures propagate to the
    // current caller via `await run`, but the chain itself just needs a
    // resolved promise to continue from.
    channelPostQueues.set(channelId, run.catch(() => undefined));
    return run;
}

export async function exchangeCodeForToken(code: string, redirectUri: string) {
    const clientId = await getOrgSecret('DISCORD_CLIENT_ID');
    const clientSecret = await getOrgSecret('DISCORD_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
        log.error('oauth credentials missing', { hasClientId: !!clientId, hasClientSecret: !!clientSecret });
        throw new Error("Server configuration error for Discord authentication.");
    }

    const trimmedClientId = clientId.trim();
    const trimmedClientSecret = clientSecret.trim();

    const body = new URLSearchParams({
        client_id: trimmedClientId,
        client_secret: trimmedClientSecret,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
    }).toString();

    const response = await fetch(`${API_ENDPOINT}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    if (!response.ok) {
        const error = await response.json();
        log.error('token exchange failed', { clientIdPrefix: `${trimmedClientId.slice(0, 6)}...`, error: error.error, errorDescription: error.error_description || 'No description', redirectUri });
        const detail = error.error_description || error.error || 'Unknown Discord error';
        throw new Error(`Discord OAuth failed: ${detail}`);
    }
    return response.json();
}

export async function getDiscordUser(accessToken: string) {
    const response = await fetch(`${API_ENDPOINT}/users/@me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
        throw new Error('Failed to fetch Discord user');
    }
    return response.json();
}

export async function getDiscordMember(discordUserId: string) {
    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');
    const guildId = await getOrgSecret('DISCORD_GUILD_ID');

    if (!botToken || !guildId) {
        throw new Error("Discord Bot Token or Guild ID not configured for member lookup.");
    }

    const response = await fetch(`${API_ENDPOINT}/guilds/${guildId}/members/${discordUserId}`, {
        headers: { Authorization: `Bot ${botToken}` },
    });

    if (!response.ok) {
        // If user is not in the guild, Discord API returns 404. This is not an error in our flow.
        if (response.status === 404) {
            log.warn('discord user not found in guild', { discordUserId, guildId });
            return null;
        }
        const error = await response.json();
        log.error('failed to fetch discord member', { error });
        throw new Error('Failed to fetch Discord member');
    }

    return response.json();
}

export async function getDiscordUserById(discordUserId: string) {
    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');

    if (!botToken) {
        throw new Error("Discord Bot Token not configured for user lookup.");
    }

    const response = await fetch(`${API_ENDPOINT}/users/${discordUserId}`, {
        headers: { Authorization: `Bot ${botToken}` },
    });

    if (!response.ok) {
        const error = await response.json();
        log.error('failed to fetch discord user', { discordUserId, error });
        throw new Error('Failed to fetch Discord user by ID');
    }

    return response.json();
}


export async function getDiscordRoles(): Promise<DiscordRole[]> {
    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');
    const guildId = await getOrgSecret('DISCORD_GUILD_ID');

    if (!botToken && !guildId) {
        throw new Error('Discord is not configured. Add a Bot Token and Guild ID in your `.env` (DISCORD_BOT_TOKEN / DISCORD_GUILD_ID) or Admin → Discord settings.');
    }
    if (!botToken) {
        throw new Error('Discord Bot Token is missing. Add it in your `.env` (DISCORD_BOT_TOKEN / DISCORD_GUILD_ID) or Admin → Discord settings.');
    }
    if (!guildId) {
        throw new Error('Discord Guild ID is missing. Add your Discord server ID in your `.env` (DISCORD_BOT_TOKEN / DISCORD_GUILD_ID) or Admin → Discord settings.');
    }

    let response: Response;
    try {
        response = await fetch(`${API_ENDPOINT}/guilds/${guildId}/roles`, {
            headers: { Authorization: `Bot ${botToken}` },
        });
    } catch (e: any) {
        throw new Error(`Could not reach Discord (${e?.message || 'network error'}). Try again shortly.`, { cause: e });
    }

    if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        let discordMsg = '';
        try {
            const parsed = JSON.parse(bodyText);
            discordMsg = parsed?.message || '';
        } catch { /* non-JSON body (e.g. Cloudflare HTML) */ }
        log.error('get guild roles failed', { guildId, status: response.status, body: bodyText.slice(0, 500) });

        if (response.status === 401) {
            throw new Error('Discord rejected the Bot Token (401 Unauthorized). Reset the token in the Discord Developer Portal and re-save it in your `.env` or Admin → Discord settings.');
        }
        if (response.status === 403) {
            throw new Error('Discord rejected the request (403 Forbidden). Make sure the bot has been added to your server.');
        }
        if (response.status === 404) {
            throw new Error(`Discord could not find guild ${guildId} (404 Unknown Guild). Verify the Guild ID and that the bot is a member of that server.`);
        }
        if (response.status === 429) {
            throw new Error('Discord rate-limited the request (429). Try again in a moment.');
        }
        if (response.status >= 500) {
            throw new Error(`Discord is having issues (${response.status}${discordMsg ? `: ${discordMsg}` : ''}). Try again shortly.`);
        }
        throw new Error(`Failed to fetch Discord roles (${response.status}${discordMsg ? `: ${discordMsg}` : ''}).`);
    }

    let roles: any;
    try {
        roles = await response.json();
    } catch (e: any) {
        throw new Error(`Discord returned an unexpected response (${e?.message || 'invalid JSON'}). This often indicates a Cloudflare/edge error — try again shortly.`, { cause: e });
    }
    return roles
        .filter((role: any) => !role.managed && role.name !== '@everyone')
        .map((role: any) => ({
            id: role.id,
            name: role.name,
            color: `#${role.color.toString(16).padStart(6, '0')}`,
        }));
}

export async function syncDiscordRoles() {
    const roles = await getDiscordRoles();

    // Clear existing synced roles before re-inserting the current set
    const { error: deleteError } = await supabase.from('synced_discord_roles')
        .delete()
        ;

    handleSupabaseError({ error: deleteError, message: 'Failed to clear old discord roles' });

    if (roles.length > 0) {
        // Discord role names are external strings — strip markup + cap before
        // persisting.
        const mappedRoles = roles.map(r => ({
            id: r.id,
            name: stripHtmlSingleLine(r.name, 100) || r.id,
            color: r.color
        }));

        const { error: insertError } = await supabase.from('synced_discord_roles').insert(mappedRoles);
        handleSupabaseError({ error: insertError, message: 'Failed to insert new discord roles' });
    }
}

export async function addMemberRole(discordUserId: string, discordRoleId: string): Promise<boolean> {
    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');
    const guildId = await getOrgSecret('DISCORD_GUILD_ID');
    if (!botToken || !guildId) return false;

    let success = false;
    await enqueueGuildRoleChange(guildId, async () => {
        const response = await fetch(`${API_ENDPOINT}/guilds/${guildId}/members/${discordUserId}/roles/${discordRoleId}`, {
            method: 'PUT',
            headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        });
        if (!response.ok && response.status !== 204) {
            const error = await response.json().catch(() => ({}));
            log.error('failed to add role to user', { discordRoleId, discordUserId, error });
        } else {
            success = true;
        }
    });
    return success;
}

export async function removeMemberRole(discordUserId: string, discordRoleId: string): Promise<boolean> {
    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');
    const guildId = await getOrgSecret('DISCORD_GUILD_ID');
    if (!botToken || !guildId) return false;

    let success = false;
    await enqueueGuildRoleChange(guildId, async () => {
        const response = await fetch(`${API_ENDPOINT}/guilds/${guildId}/members/${discordUserId}/roles/${discordRoleId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bot ${botToken}` },
        });
        if (!response.ok && response.status !== 204) {
            const error = await response.json().catch(() => ({}));
            log.error('failed to remove role from user', { discordRoleId, discordUserId, error });
        } else {
            success = true;
        }
    });
    return success;
}

/**
 * Push platform role/rank changes to Discord.
 * Looks up the reverse mapping (platform rank/role → Discord role) and assigns/removes accordingly.
 * Only called when an admin explicitly changes a user's rank or role on the platform.
 */
export async function pushDiscordRolesForUser(
    userId: number,
    changes: { oldRankId?: number | null; newRankId?: number | null; oldRoleId?: number | null; newRoleId?: number | null }
): Promise<void> {
    try {
        // Get user's discord ID
        const { data: user } = await supabase.from('users').select('discord_id').eq('id', userId).single();
        if (!user?.discord_id) return;

        // Get all mappings for this org
        const { data: mappings } = await supabase.from('rank_mappings')
            .select('discord_role_id, rank_id, role_id')
            ;
        if (!mappings || mappings.length === 0) return;

        const rolesToAdd: string[] = [];
        const rolesToRemove: string[] = [];

        for (const mapping of mappings) {
            // Check rank changes
            if (changes.newRankId !== undefined && mapping.rank_id) {
                if (mapping.rank_id === changes.newRankId && mapping.rank_id !== changes.oldRankId) {
                    rolesToAdd.push(mapping.discord_role_id);
                } else if (mapping.rank_id === changes.oldRankId && mapping.rank_id !== changes.newRankId) {
                    rolesToRemove.push(mapping.discord_role_id);
                }
            }

            // Check platform role changes
            if (changes.newRoleId !== undefined && mapping.role_id) {
                if (mapping.role_id === changes.newRoleId && mapping.role_id !== changes.oldRoleId) {
                    // Only add if not already being added by rank mapping
                    if (!rolesToAdd.includes(mapping.discord_role_id)) {
                        rolesToAdd.push(mapping.discord_role_id);
                    }
                } else if (mapping.role_id === changes.oldRoleId && mapping.role_id !== changes.newRoleId) {
                    // Only remove if not being added by another mapping
                    if (!rolesToAdd.includes(mapping.discord_role_id) && !rolesToRemove.includes(mapping.discord_role_id)) {
                        rolesToRemove.push(mapping.discord_role_id);
                    }
                }
            }
        }

        // Don't remove a role that we're also adding (conflict resolution: add wins)
        const finalRemoves = rolesToRemove.filter(r => !rolesToAdd.includes(r));

        for (const discordRoleId of finalRemoves) {
            await removeMemberRole(user.discord_id, discordRoleId);
        }
        for (const discordRoleId of rolesToAdd) {
            await addMemberRole(user.discord_id, discordRoleId);
        }

        if (rolesToAdd.length > 0 || finalRemoves.length > 0) {
            log.info('pushed role changes for user', { userId, added: rolesToAdd, removed: finalRemoves });
        }
    } catch (err) {
        log.error('failed to push roles for user', { userId, err });
    }
}

// Posts a message to a Discord channel. Returns the new message ID on success
// so callers can chain reactions / edits / deletes; returns `error` on failure
// (callers that ignore the return — intel & service requests today — see no
// behavioral change).
export async function sendDiscordChannelMessage(
    channelId: string,
    content: any,
): Promise<{ messageId?: string; error?: string }> {
    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');
    if (!botToken) {
        log.warn('cannot send message: no bot token found');
        return { error: 'Discord bot token is not configured.' };
    }

    try {
        const response = await fetch(`${API_ENDPOINT}/channels/${channelId}/messages`, {
            method: 'POST',
            headers: {
                Authorization: `Bot ${botToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(content),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            log.error('failed to send message to channel', { channelId, error });
            return { error: error?.message || `Discord API returned HTTP ${response.status}.` };
        }
        const message = await response.json().catch(() => ({}));
        return { messageId: message?.id ? String(message.id) : undefined };
    } catch (error: any) {
        log.error('network error sending message to channel', { channelId, err: error });
        return { error: 'Could not reach the Discord API.' };
    }
}

// Edit an existing channel message in place. Used to keep the operation
// announcement embed in sync with the operation row when it's edited —
// preserves Discord-side reactions, unlike a delete+repost.
export async function editDiscordChannelMessage(
    channelId: string,
    messageId: string,
    content: any,
): Promise<{ ok: boolean; error?: string; gone?: boolean }> {
    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');
    if (!botToken) return { ok: false, error: 'Discord bot token is not configured.' };

    try {
        const response = await fetch(`${API_ENDPOINT}/channels/${channelId}/messages/${messageId}`, {
            method: 'PATCH',
            headers: {
                Authorization: `Bot ${botToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(content),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            // 404 = the message was deleted in Discord. Surface as `gone` so
            // callers can decide whether to re-post.
            if (response.status === 404) return { ok: false, gone: true, error: 'Discord message no longer exists.' };
            log.error('failed to edit message in channel', { messageId, channelId, error });
            return { ok: false, error: error?.message || `Discord API returned HTTP ${response.status}.` };
        }
        return { ok: true };
    } catch (error: any) {
        log.error('network error editing message in channel', { messageId, channelId, err: error });
        return { ok: false, error: 'Could not reach the Discord API.' };
    }
}

// Best-effort delete. 404 is treated as success (already gone).
export async function deleteDiscordChannelMessage(
    channelId: string,
    messageId: string,
): Promise<void> {
    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');
    if (!botToken) return;
    try {
        const response = await fetch(`${API_ENDPOINT}/channels/${channelId}/messages/${messageId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bot ${botToken}` },
        });
        if (!response.ok && response.status !== 404) {
            const error = await response.json().catch(() => ({}));
            log.warn('failed to delete message in channel', { messageId, channelId, error });
        }
    } catch (error: any) {
        log.warn('network error deleting message in channel', { messageId, channelId, err: error });
    }
}

// Add reactions to a message as the bot user. Each emoji is one HTTP request;
// failures are logged but don't abort the rest. Emojis must be URL-encoded for
// the path — the caller passes the raw character.
export async function addMessageReactions(
    channelId: string,
    messageId: string,
    emojis: string[],
): Promise<void> {
    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');
    if (!botToken) return;
    for (const emoji of emojis) {
        try {
            const response = await fetch(
                `${API_ENDPOINT}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
                {
                    method: 'PUT',
                    headers: { Authorization: `Bot ${botToken}` },
                },
            );
            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                log.warn('failed to add reaction to message', { emoji, messageId, error });
            }
        } catch (error: any) {
            log.warn('network error adding reaction to message', { emoji, messageId, err: error });
        }
    }
}

// --- Operation Announcement Embed ---

export interface OperationAnnouncementEmbedInput {
    name: string;
    description?: string | null;
    type?: string | null;
    scheduledStart?: string | null;
    scheduledEnd?: string | null;
    clearanceLabel?: string | null;
    unitName?: string | null;
    locationLabel?: string | null;
    operationDeepLink?: string | null;
    branding?: { name?: string; iconUrl?: string };
}

const OPERATION_ANNOUNCEMENT_REACTIONS = ['✅', '❌', '❓'];

function buildOperationAnnouncementEmbed(input: OperationAnnouncementEmbedInput) {
    const safe = (val: any, fallback = 'N/A', maxLength = 1024) => {
        if (val === null || val === undefined) return fallback;
        const str = String(val).trim();
        if (str.length === 0) return fallback;
        return str.length > maxLength ? str.substring(0, maxLength - 3) + '...' : str;
    };

    const fields: any[] = [];
    if (input.type) fields.push({ name: 'Type', value: safe(input.type, 'N/A', 256), inline: true });
    if (input.clearanceLabel) fields.push({ name: 'Clearance', value: safe(input.clearanceLabel, 'N/A', 256), inline: true });
    if (input.unitName) fields.push({ name: 'Unit', value: safe(input.unitName, 'N/A', 256), inline: true });
    if (input.scheduledStart) {
        // Use Discord's <t:UNIX:F> timestamp formatting so each viewer sees their local time.
        const unix = Math.floor(new Date(input.scheduledStart).getTime() / 1000);
        const value = !Number.isFinite(unix) || unix <= 0
            ? input.scheduledStart
            : input.scheduledEnd
                ? `<t:${unix}:F> → <t:${Math.floor(new Date(input.scheduledEnd).getTime() / 1000)}:t>`
                : `<t:${unix}:F> (<t:${unix}:R>)`;
        fields.push({ name: 'Scheduled', value, inline: false });
    }
    if (input.locationLabel) fields.push({ name: 'Location', value: safe(input.locationLabel, 'N/A', 1024), inline: false });
    if (input.operationDeepLink) {
        fields.push({ name: 'Details', value: `[Open in myRSI](${input.operationDeepLink})`, inline: false });
    }

    const branding = input.branding || {};
    return {
        title: `🛰️ OPERATION: ${safe(input.name, 'Untitled Operation', 256)}`,
        description: safe(input.description, 'No briefing provided.', 4000),
        color: 0x6366f1, // indigo-500 — matches the Operations Center accent
        fields,
        timestamp: new Date().toISOString(),
        footer: {
            text: `${branding.name || 'Organization'} Operations`,
            ...(branding.iconUrl && branding.iconUrl.startsWith('http') ? { icon_url: branding.iconUrl } : {}),
        },
    };
}

// Posts the operation announcement embed and chains the standard ✅ ❌ ❓
// reactions through the per-channel queue. Returns the new message ID on
// success. Best-effort: reactions failing individually do not invalidate the
// post; only a failed post propagates `error`.
export async function postOperationAnnouncementEmbed(
    channelId: string,
    input: OperationAnnouncementEmbedInput,
): Promise<{ messageId?: string; error?: string }> {
    const embed = buildOperationAnnouncementEmbed(input);
    return enqueueChannelPost(channelId, async () => {
        const sendResult = await sendDiscordChannelMessage(channelId, { embeds: [embed] });
        if (!sendResult.messageId) return sendResult;
        // Reactions are appended sequentially under the same enqueue tick — no
        // extra spacing needed since `addMessageReactions` awaits each one and
        // the queue's tail delay covers the next post.
        await addMessageReactions(channelId, sendResult.messageId, OPERATION_ANNOUNCEMENT_REACTIONS);
        return sendResult;
    });
}

// Edits the embed of an existing operation announcement message in place.
// Preserves Discord-side reactions, which a delete+repost would lose.
export async function editOperationAnnouncementEmbed(
    channelId: string,
    messageId: string,
    input: OperationAnnouncementEmbedInput,
): Promise<{ ok: boolean; error?: string; gone?: boolean }> {
    const embed = buildOperationAnnouncementEmbed(input);
    return editDiscordChannelMessage(channelId, messageId, { embeds: [embed] });
}

// --- Guild Channels (read-only) ---
// Used by the per-operation Comms Plan editor to populate a dropdown of
// available Discord channels. Read-only — we never create, update, or delete
// channels. Cached server-side for 60s per-org to keep the Discord API quiet
// when users repeatedly open the editor.

export interface GuildChannelSummary {
    id: string;
    name: string;
    /** Discord channel type: 0=text, 2=voice, 5=announcement, 13=stage. */
    type: number;
    parentId: string | null;
    position: number;
}

export interface ListGuildChannelsResult {
    channels: GuildChannelSummary[];
    error: string | null;
    /** Returned when the bot is configured. Used by the client to build
     *  `discord://channels/{guildId}/{channelId}` deep links. */
    guildId: string | null;
}

const GUILD_CHANNELS_TTL_MS = 60_000;

export async function listGuildChannels(opts: { forceRefresh?: boolean } = {}): Promise<ListGuildChannelsResult> {
    const cacheKey = 'discord_guild_channels';
    if (!opts.forceRefresh) {
        const cached = cache.get<ListGuildChannelsResult>(cacheKey);
        if (cached) return cached;
    }

    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');
    const guildId = await getOrgSecret('DISCORD_GUILD_ID');
    if (!botToken || !guildId) {
        const result: ListGuildChannelsResult = { channels: [], error: 'Discord bot is not configured for this organization.', guildId: null };
        cache.set(cacheKey, result, GUILD_CHANNELS_TTL_MS);
        return result;
    }

    try {
        const response = await fetch(`${API_ENDPOINT}/guilds/${guildId}/channels`, {
            headers: { Authorization: `Bot ${botToken}` },
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            let message = err?.message || `Discord API returned HTTP ${response.status}.`;
            if (response.status === 401) message = 'Discord bot token is invalid or has expired.';
            else if (response.status === 403) message = 'Discord bot lacks the View Channels permission.';
            log.warn('listGuildChannels failed', { message });
            const result: ListGuildChannelsResult = { channels: [], error: message, guildId };
            // Only cache config-permanent failures (401 invalid token, 403
            // missing permission, 404 unknown guild). 5xx is a transient
            // Discord-side outage — caching it would lock out the channel
            // picker for the full TTL after Discord recovers.
            const isPermanent = response.status === 401 || response.status === 403 || response.status === 404;
            if (isPermanent) {
                cache.set(cacheKey, result, GUILD_CHANNELS_TTL_MS);
            }
            return result;
        }
        const raw = await response.json();
        // Discord returns a flat list of channels. We keep text (0), voice (2),
        // announcement (5, treated as text), and stage (13). Categories (4) and
        // threads/forums are dropped for the comms-plan use case.
        const KEEP = new Set([0, 2, 5, 13]);
        const channels: GuildChannelSummary[] = (Array.isArray(raw) ? raw : [])
            .filter((c: any) => KEEP.has(c.type))
            .map((c: any) => ({
                id: String(c.id),
                name: String(c.name || ''),
                type: Number(c.type),
                parentId: c.parent_id ? String(c.parent_id) : null,
                position: Number(c.position ?? 0),
            }))
            .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
        const result: ListGuildChannelsResult = { channels, error: null, guildId };
        cache.set(cacheKey, result, GUILD_CHANNELS_TTL_MS);
        return result;
    } catch (err: any) {
        log.error('listGuildChannels network error', { err });
        // Don't cache transient network errors — the next call should retry.
        return { channels: [], error: 'Could not reach the Discord API. Try again in a moment.', guildId };
    }
}

// --- Guild Scheduled Events ---

// Discord 50035 ("Invalid Form Body") responses bury the actual reason under a
// nested `errors` tree keyed by field path; the top-level `message` is just the
// generic phrase. Walk the tree and produce a "<field>: <reason>" string per
// leaf so callers can surface specifics instead of "Invalid Form Body".
function flattenDiscordFormErrors(errors: any, path: string[] = []): string[] {
    if (!errors || typeof errors !== 'object') return [];
    const out: string[] = [];
    if (Array.isArray(errors._errors)) {
        for (const entry of errors._errors) {
            const message = entry?.message;
            if (typeof message === 'string' && message.trim()) {
                out.push(path.length > 0 ? `${path.join('.')}: ${message}` : message);
            }
        }
    }
    for (const key of Object.keys(errors)) {
        if (key === '_errors') continue;
        out.push(...flattenDiscordFormErrors(errors[key], [...path, key]));
    }
    return out;
}

export interface CreateGuildEventOptions {
    name: string;
    description?: string;
    scheduledStart: string; // ISO 8601
    scheduledEnd: string;   // ISO 8601
    locationUrl: string;    // External event location (tenant dashboard URL)
}

/**
 * Create a Discord Guild Scheduled Event (type: EXTERNAL).
 * Returns the event ID on success, or null on failure.
 */
export async function createGuildScheduledEvent(options: CreateGuildEventOptions): Promise<{ eventId?: string; error?: string }> {
    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');
    const guildId = await getOrgSecret('DISCORD_GUILD_ID');
    if (!botToken || !guildId) {
        log.warn('cannot create event: bot token or guild id missing');
        return { error: 'Discord bot token or guild ID is not configured. Check your Discord integration settings.' };
    }

    const body: any = {
        name: options.name,
        privacy_level: 2, // GUILD_ONLY
        scheduled_start_time: options.scheduledStart,
        scheduled_end_time: options.scheduledEnd,
        entity_type: 3, // EXTERNAL
        entity_metadata: {
            location: options.locationUrl,
        },
    };

    if (options.description) {
        // Discord limits event description to 1000 chars
        body.description = options.description.length > 1000
            ? options.description.substring(0, 997) + '...'
            : options.description;
    }

    // Attach banner image if available
    const banner = getEventBannerDataUri();
    if (banner) {
        body.image = banner;
    }

    try {
        const response = await fetch(`${API_ENDPOINT}/guilds/${guildId}/scheduled-events`, {
            method: 'POST',
            headers: {
                Authorization: `Bot ${botToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            log.error('failed to create scheduled event', { error });
            if (response.status === 403 || error?.code === 50013) {
                return { error: 'The Discord bot lacks permission to create events. Ensure it has the "Manage Events" permission in your Discord server.' };
            }
            if (response.status === 401) {
                return { error: 'The Discord bot token is invalid or has expired. Re-configure your bot token in Discord settings.' };
            }
            const details = flattenDiscordFormErrors(error?.errors);
            if (details.length > 0) {
                return { error: `Discord rejected the event: ${details.join(' ')}` };
            }
            return { error: error?.message || `Discord API returned an error (HTTP ${response.status}). Check your bot configuration.` };
        }

        const event = await response.json();
        log.info('created scheduled event', { eventId: event.id });
        return { eventId: event.id };
    } catch (error) {
        log.error('network error creating scheduled event', { err: error });
        return { error: 'Could not reach the Discord API. Check your server\'s network connectivity.' };
    }
}

export interface UpdateGuildEventOptions {
    name?: string;
    description?: string | null;
    scheduledStart?: string;   // ISO 8601
    scheduledEnd?: string;     // ISO 8601
    locationUrl?: string;
}

/**
 * PATCH a Discord Guild Scheduled Event. Only fields explicitly set on `options`
 * are sent to Discord — undefined = leave as-is. Returns the same shape as
 * create so callers can bubble a user-visible error when sync fails.
 */
export async function updateGuildScheduledEvent(
    eventId: string,
    options: UpdateGuildEventOptions,
): Promise<{ ok: boolean; error?: string }> {
    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');
    const guildId = await getOrgSecret('DISCORD_GUILD_ID');
    if (!botToken || !guildId) {
        log.warn('cannot update event: bot token or guild id missing');
        return { ok: false, error: 'Discord bot token or guild ID is not configured.' };
    }

    const body: Record<string, any> = {};
    if (options.name !== undefined) body.name = options.name;
    if (options.scheduledStart !== undefined) body.scheduled_start_time = options.scheduledStart;
    if (options.scheduledEnd !== undefined) body.scheduled_end_time = options.scheduledEnd;
    if (options.description !== undefined) {
        body.description = options.description
            ? (options.description.length > 1000 ? options.description.substring(0, 997) + '...' : options.description)
            : '';
    }
    if (options.locationUrl !== undefined) {
        body.entity_metadata = { location: options.locationUrl };
    }

    if (Object.keys(body).length === 0) return { ok: true };

    try {
        const response = await fetch(`${API_ENDPOINT}/guilds/${guildId}/scheduled-events/${eventId}`, {
            method: 'PATCH',
            headers: {
                Authorization: `Bot ${botToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            log.error('failed to update scheduled event', { eventId, error });
            if (response.status === 404) {
                return { ok: false, error: 'The linked Discord event no longer exists.' };
            }
            if (response.status === 403 || error?.code === 50013) {
                return { ok: false, error: 'The Discord bot lacks permission to edit events.' };
            }
            if (response.status === 401) {
                return { ok: false, error: 'The Discord bot token is invalid or has expired.' };
            }
            return { ok: false, error: error?.message || `Discord API returned HTTP ${response.status}.` };
        }

        log.info('updated scheduled event', { eventId });
        return { ok: true };
    } catch (error) {
        log.error('network error updating scheduled event', { err: error });
        return { ok: false, error: 'Could not reach the Discord API.' };
    }
}

/**
 * Delete a Discord Guild Scheduled Event.
 */
export async function deleteGuildScheduledEvent(eventId: string): Promise<void> {
    const botToken = await getOrgSecret('DISCORD_BOT_TOKEN');
    const guildId = await getOrgSecret('DISCORD_GUILD_ID');
    if (!botToken || !guildId) return;

    try {
        const response = await fetch(`${API_ENDPOINT}/guilds/${guildId}/scheduled-events/${eventId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bot ${botToken}` },
        });

        if (!response.ok && response.status !== 404) {
            const error = await response.json().catch(() => ({}));
            log.error('failed to delete scheduled event', { eventId, error });
        }
    } catch (error) {
        log.error('network error deleting scheduled event', { err: error });
    }
}
