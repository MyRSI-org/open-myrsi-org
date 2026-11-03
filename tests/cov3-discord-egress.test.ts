import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

// lib/discord.ts — the egress half: channel messages, reactions, the operation
// announcement / starting-soon embeds and their per-channel queue, the guild
// channel picker (cache + forced-refresh floor), and Guild Scheduled Events.
//
// Everything here leaves the deployment for a Discord channel or a guild-wide
// event, so the assertions are over the exact bytes sent: URL, method, headers
// (the `Bot <token>` shape), and the parsed JSON body. An afterEach sweeps every
// log line for the bot token.

const BOT_TOKEN = 'MTIz.bot-SECRET-token.value-xyz';
const GUILD_ID = '998877665544332211';
const CHANNEL = '123456789012345678';
const CHANNEL_2 = '234567890123456789';
const MESSAGE = '876543210987654321';
const EVENT = '765432109876543210';
const PING_ROLE = '223344556677889900';
const API = 'https://discord.com/api/v10';
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const NOW_ISO = '2026-01-02T03:04:05.000Z';
const DIST_BANNER = join(process.cwd(), 'dist', 'media', 'discord-event-banner.jpg');
const PUBLIC_BANNER = join(process.cwd(), 'public', 'media', 'discord-event-banner.jpg');

const h = vi.hoisted(() => ({
    secrets: {} as Record<string, string | null>,
    secretReads: [] as string[],
    secretThrowOnce: null as Error | null,
    logs: [] as Array<{ level: string; msg: string; fields?: Record<string, unknown> }>,
    bannerFiles: {} as Record<string, Buffer>,
    bannerReads: [] as string[],
}));

vi.mock('../lib/secrets', () => ({
    getOrgSecret: async (key: string) => {
        h.secretReads.push(key);
        if (h.secretThrowOnce) {
            const e = h.secretThrowOnce;
            h.secretThrowOnce = null;
            throw e;
        }
        return h.secrets[key] ?? null;
    },
}));

vi.mock('../lib/log', () => {
    const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => { h.logs.push({ level, msg, fields }); };
    const child = { error: rec('error'), warn: rec('warn'), info: rec('info'), debug: rec('debug') };
    return { log: { ...child, child: () => child } };
});

vi.mock('../lib/db/common', () => ({
    supabase: { from: () => { throw new Error('egress paths must not touch the database'); } },
    handleSupabaseError: () => undefined,
}));

// Only the banner path is faked; every other readFileSync is the real one.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const readFileSync = ((p: unknown, ...rest: unknown[]) => {
        const path = String(p);
        if (path.endsWith('discord-event-banner.jpg')) {
            h.bannerReads.push(path);
            const buf = h.bannerFiles[path];
            if (!buf) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
            return buf;
        }
        return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.readFileSync;
    return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

type FakeRes = { ok: boolean; status: number; json: () => Promise<unknown> };
function res(status: number, body?: unknown): FakeRes {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
            if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
            return body;
        },
    };
}

const fetchMock = vi.fn<(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FakeRes>>();
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({
    url,
    method: init?.method ?? 'GET',
    headers: init?.headers,
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
}));

function serialise(v: unknown): string {
    return JSON.stringify(v, (_k, val) => (val instanceof Error ? { message: val.message, stack: val.stack, cause: val.cause } : val));
}

const BOT_JSON_HEADERS = { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' };
const BOT_HEADERS = { Authorization: `Bot ${BOT_TOKEN}` };

let d: typeof import('../lib/discord');

beforeEach(async () => {
    h.secrets = { DISCORD_BOT_TOKEN: BOT_TOKEN, DISCORD_GUILD_ID: GUILD_ID };
    h.secretReads = []; h.secretThrowOnce = null; h.logs = []; h.bannerFiles = {}; h.bannerReads = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => res(200, { id: MESSAGE }));
    vi.stubGlobal('fetch', fetchMock);
    // Fresh module per test: the banner cache, the per-channel queue and the
    // forced-refresh floor are module state, and lib/cache is a real singleton.
    vi.resetModules();
    d = await import('../lib/discord');
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});

afterEach(() => {
    expect(serialise(h.logs), 'the bot token reached a log line').not.toContain(BOT_TOKEN);
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('sendDiscordChannelMessage', () => {
    it('POSTs JSON to the channel with the bot token, mention-suppressed, and returns the message id as a string', async () => {
        fetchMock.mockResolvedValueOnce(res(200, { id: 876543210987654 }));
        const out = await d.sendDiscordChannelMessage(CHANNEL, { embeds: [{ title: 't' }] });
        expect(out).toEqual({ messageId: '876543210987654' });
        expect(calls()).toEqual([{
            url: `${API}/channels/${CHANNEL}/messages`,
            method: 'POST',
            headers: BOT_JSON_HEADERS,
            body: { embeds: [{ title: 't' }], allowed_mentions: { parse: [] } },
        }]);
    });

    it('FAILS CLOSED without a bot token', async () => {
        h.secrets.DISCORD_BOT_TOKEN = null;
        expect(await d.sendDiscordChannelMessage(CHANNEL, { content: 'x' })).toEqual({ error: 'Discord bot token is not configured.' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(h.logs).toEqual([{ level: 'warn', msg: 'cannot send message: no bot token found', fields: undefined }]);
    });

    it('logs and refuses a non-snowflake channel before reading the token', async () => {
        expect(await d.sendDiscordChannelMessage('general', { content: 'x' })).toEqual({ error: 'Invalid Discord channel ID.' });
        expect(h.secretReads).toEqual([]);
        expect(h.logs).toEqual([{ level: 'warn', msg: 'refusing to send: channel id is not a snowflake', fields: { channelId: 'general' } }]);
    });

    it('a 2xx without an id, or with an unreadable body, yields no message id', async () => {
        fetchMock.mockResolvedValueOnce(res(200, {}));
        expect(await d.sendDiscordChannelMessage(CHANNEL, { content: 'x' })).toEqual({ messageId: undefined });
        fetchMock.mockResolvedValueOnce(res(204));
        expect(await d.sendDiscordChannelMessage(CHANNEL, { content: 'x' })).toEqual({ messageId: undefined });
    });

    it('surfaces the Discord message on a non-2xx and logs the body', async () => {
        fetchMock.mockResolvedValueOnce(res(403, { message: 'Missing Permissions', code: 50013 }));
        expect(await d.sendDiscordChannelMessage(CHANNEL, { content: 'x' })).toEqual({ error: 'Missing Permissions' });
        expect(h.logs).toEqual([{ level: 'error', msg: 'failed to send message to channel', fields: { channelId: CHANNEL, error: { message: 'Missing Permissions', code: 50013 } } }]);
    });

    it('falls back to the HTTP status when the error body is unreadable', async () => {
        fetchMock.mockResolvedValueOnce(res(502));
        expect(await d.sendDiscordChannelMessage(CHANNEL, { content: 'x' })).toEqual({ error: 'Discord API returned HTTP 502.' });
    });

    it('maps a network failure to a fixed message', async () => {
        const boom = new TypeError('fetch failed');
        fetchMock.mockRejectedValueOnce(boom);
        expect(await d.sendDiscordChannelMessage(CHANNEL, { content: 'x' })).toEqual({ error: 'Could not reach the Discord API.' });
        expect(h.logs).toEqual([{ level: 'error', msg: 'network error sending message to channel', fields: { channelId: CHANNEL, err: boom } }]);
    });
});

describe('editDiscordChannelMessage', () => {
    it('PATCHes the message with the bot token and the mention-suppression default', async () => {
        expect(await d.editDiscordChannelMessage(CHANNEL, MESSAGE, { embeds: [{ title: 'e' }] })).toEqual({ ok: true });
        expect(calls()).toEqual([{
            url: `${API}/channels/${CHANNEL}/messages/${MESSAGE}`,
            method: 'PATCH',
            headers: BOT_JSON_HEADERS,
            body: { embeds: [{ title: 'e' }], allowed_mentions: { parse: [] } },
        }]);
    });

    it('FAILS CLOSED without a bot token', async () => {
        h.secrets.DISCORD_BOT_TOKEN = null;
        expect(await d.editDiscordChannelMessage(CHANNEL, MESSAGE, {})).toEqual({ ok: false, error: 'Discord bot token is not configured.' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('logs the refused ids', async () => {
        await d.editDiscordChannelMessage(CHANNEL, 'nope', {});
        expect(h.logs).toEqual([{ level: 'warn', msg: 'refusing to edit: channel or message id is not a snowflake', fields: { channelId: CHANNEL, messageId: 'nope' } }]);
    });

    it('a 404 reports the message gone (so the caller may re-post) without an error log', async () => {
        fetchMock.mockResolvedValueOnce(res(404, { message: 'Unknown Message', code: 10008 }));
        expect(await d.editDiscordChannelMessage(CHANNEL, MESSAGE, {})).toEqual({ ok: false, gone: true, error: 'Discord message no longer exists.' });
        expect(h.logs).toEqual([]);
    });

    it('other failures surface the Discord message, else the status', async () => {
        fetchMock.mockResolvedValueOnce(res(400, { message: 'Invalid Form Body' }));
        expect(await d.editDiscordChannelMessage(CHANNEL, MESSAGE, {})).toEqual({ ok: false, error: 'Invalid Form Body' });
        expect(h.logs).toEqual([{ level: 'error', msg: 'failed to edit message in channel', fields: { messageId: MESSAGE, channelId: CHANNEL, error: { message: 'Invalid Form Body' } } }]);
        fetchMock.mockResolvedValueOnce(res(500));
        expect(await d.editDiscordChannelMessage(CHANNEL, MESSAGE, {})).toEqual({ ok: false, error: 'Discord API returned HTTP 500.' });
    });

    it('maps a network failure to a fixed message', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
        expect(await d.editDiscordChannelMessage(CHANNEL, MESSAGE, {})).toEqual({ ok: false, error: 'Could not reach the Discord API.' });
        expect(h.logs.map(l => l.msg)).toEqual(['network error editing message in channel']);
    });
});

describe('deleteDiscordChannelMessage', () => {
    it('DELETEs the message with only the bot Authorization header', async () => {
        fetchMock.mockResolvedValueOnce(res(204));
        await d.deleteDiscordChannelMessage(CHANNEL, MESSAGE);
        expect(calls()).toEqual([{ url: `${API}/channels/${CHANNEL}/messages/${MESSAGE}`, method: 'DELETE', headers: BOT_HEADERS, body: undefined }]);
        expect(h.logs).toEqual([]);
    });

    it('issues nothing without a bot token', async () => {
        h.secrets.DISCORD_BOT_TOKEN = null;
        await d.deleteDiscordChannelMessage(CHANNEL, MESSAGE);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats 404 as already-deleted, and warns on any other failure', async () => {
        fetchMock.mockResolvedValueOnce(res(404, { message: 'Unknown Message' }));
        await d.deleteDiscordChannelMessage(CHANNEL, MESSAGE);
        expect(h.logs).toEqual([]);
        fetchMock.mockResolvedValueOnce(res(403));
        await d.deleteDiscordChannelMessage(CHANNEL, MESSAGE);
        expect(h.logs).toEqual([{ level: 'warn', msg: 'failed to delete message in channel', fields: { messageId: MESSAGE, channelId: CHANNEL, error: {} } }]);
    });

    it('swallows a network failure with a warning (best-effort)', async () => {
        const boom = new TypeError('fetch failed');
        fetchMock.mockRejectedValueOnce(boom);
        await expect(d.deleteDiscordChannelMessage(CHANNEL, MESSAGE)).resolves.toBeUndefined();
        expect(h.logs).toEqual([{ level: 'warn', msg: 'network error deleting message in channel', fields: { messageId: MESSAGE, channelId: CHANNEL, err: boom } }]);
    });

    it('logs the refused ids', async () => {
        await d.deleteDiscordChannelMessage('x', MESSAGE);
        expect(h.logs).toEqual([{ level: 'warn', msg: 'refusing to delete: channel or message id is not a snowflake', fields: { channelId: 'x', messageId: MESSAGE } }]);
    });
});

describe('addMessageReactions', () => {
    it('PUTs one URL-encoded reaction per emoji, in order, as the bot', async () => {
        fetchMock.mockImplementation(async () => res(204));
        await d.addMessageReactions(CHANNEL, MESSAGE, ['✅', '❌']);
        expect(calls()).toEqual([
            { url: `${API}/channels/${CHANNEL}/messages/${MESSAGE}/reactions/%E2%9C%85/@me`, method: 'PUT', headers: BOT_HEADERS, body: undefined },
            { url: `${API}/channels/${CHANNEL}/messages/${MESSAGE}/reactions/%E2%9D%8C/@me`, method: 'PUT', headers: BOT_HEADERS, body: undefined },
        ]);
    });

    it('a failed or thrown reaction is logged and the rest still go out', async () => {
        const boom = new TypeError('fetch failed');
        fetchMock
            .mockResolvedValueOnce(res(400, { message: 'Unknown Emoji' }))
            .mockRejectedValueOnce(boom)
            .mockResolvedValueOnce(res(204));
        await d.addMessageReactions(CHANNEL, MESSAGE, ['a', 'b', 'c']);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(h.logs).toEqual([
            { level: 'warn', msg: 'failed to add reaction to message', fields: { emoji: 'a', messageId: MESSAGE, error: { message: 'Unknown Emoji' } } },
            { level: 'warn', msg: 'network error adding reaction to message', fields: { emoji: 'b', messageId: MESSAGE, err: boom } },
        ]);
    });

    it('an unreadable failure body logs {}', async () => {
        fetchMock.mockResolvedValueOnce(res(500));
        await d.addMessageReactions(CHANNEL, MESSAGE, ['a']);
        expect(h.logs[0].fields).toEqual({ emoji: 'a', messageId: MESSAGE, error: {} });
    });

    it('issues nothing without a bot token, and logs refused ids', async () => {
        h.secrets.DISCORD_BOT_TOKEN = null;
        await d.addMessageReactions(CHANNEL, MESSAGE, ['a']);
        await d.addMessageReactions(CHANNEL, '../x', ['a']);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(h.logs).toEqual([{ level: 'warn', msg: 'refusing to react: channel or message id is not a snowflake', fields: { channelId: CHANNEL, messageId: '../x' } }]);
    });
});

describe('buildOperationAnnouncementEmbed', () => {
    const full = {
        name: 'Operation Nightfall',
        description: 'Escort the convoy.',
        type: 'Escort',
        scheduledStart: '2026-03-01T20:00:00.000Z',
        scheduledEnd: '2026-03-01T22:30:00.000Z',
        clearanceLabel: 'Secret',
        unitName: 'Ghost Squadron',
        locationLabel: 'Port Olisar',
        operationDeepLink: 'https://org.example/?op=op-1',
        branding: { name: 'Acme Corp', iconUrl: 'https://org.example/icon.png' },
    };

    it('renders every field in order with a Discord start->end timestamp range', () => {
        expect(d.buildOperationAnnouncementEmbed(full)).toEqual({
            title: '🛰️ OPERATION: Operation Nightfall',
            description: 'Escort the convoy.',
            color: 0x6366f1,
            fields: [
                { name: 'Type', value: 'Escort', inline: true },
                { name: 'Clearance', value: 'Secret', inline: true },
                { name: 'Unit', value: 'Ghost Squadron', inline: true },
                { name: 'Scheduled', value: '<t:1772395200:F> → <t:1772404200:t>', inline: false },
                { name: 'Location', value: 'Port Olisar', inline: false },
                { name: 'Details', value: '[Open in myRSI](https://org.example/?op=op-1)', inline: false },
            ],
            timestamp: NOW_ISO,
            footer: { text: 'Acme Corp Operations', icon_url: 'https://org.example/icon.png' },
        });
    });

    it('a start with no end renders absolute + relative time', () => {
        const e = d.buildOperationAnnouncementEmbed({ name: 'Op', scheduledStart: '2026-03-01T20:00:00.000Z' });
        expect(e.fields).toEqual([{ name: 'Scheduled', value: '<t:1772395200:F> (<t:1772395200:R>)', inline: false }]);
    });

    it('an unparseable or non-positive start is shown verbatim rather than as a bogus timestamp', () => {
        expect(d.buildOperationAnnouncementEmbed({ name: 'Op', scheduledStart: 'next tuesday' }).fields)
            .toEqual([{ name: 'Scheduled', value: 'next tuesday', inline: false }]);
        expect(d.buildOperationAnnouncementEmbed({ name: 'Op', scheduledStart: '1970-01-01T00:00:00.000Z' }).fields)
            .toEqual([{ name: 'Scheduled', value: '1970-01-01T00:00:00.000Z', inline: false }]);
    });

    it('truncates to Discord limits with an ellipsis (title 256, description 4000, inline 256, location 1024)', () => {
        const e = d.buildOperationAnnouncementEmbed({
            name: 'N'.repeat(300),
            description: 'D'.repeat(5000),
            type: 'T'.repeat(300),
            locationLabel: 'L'.repeat(2000),
        });
        expect(e.title).toBe(`🛰️ OPERATION: ${'N'.repeat(253)}...`);
        expect(e.description).toBe(`${'D'.repeat(3997)}...`);
        expect(e.description).toHaveLength(4000);
        expect(e.fields).toEqual([
            { name: 'Type', value: `${'T'.repeat(253)}...`, inline: true },
            { name: 'Location', value: `${'L'.repeat(1021)}...`, inline: false },
        ]);
        // Exactly at the limit is untouched.
        expect(d.buildOperationAnnouncementEmbed({ name: 'N'.repeat(256) }).title).toBe(`🛰️ OPERATION: ${'N'.repeat(256)}`);
    });

    it('blank name/description fall back, and absent optionals add no fields', () => {
        const e = d.buildOperationAnnouncementEmbed({ name: '   ', description: '  \n ' });
        expect(e.title).toBe('🛰️ OPERATION: Untitled Operation');
        expect(e.description).toBe('No briefing provided.');
        expect(e.fields).toEqual([]);
        expect(d.buildOperationAnnouncementEmbed({ name: 'Op', description: null }).description).toBe('No briefing provided.');
    });

    it('footer defaults the org name and only carries an http(s) icon', () => {
        expect(d.buildOperationAnnouncementEmbed({ name: 'Op' }).footer).toEqual({ text: 'Organization Operations' });
        expect(d.buildOperationAnnouncementEmbed({ name: 'Op', branding: { name: 'Acme', iconUrl: 'javascript:alert(1)' } }).footer)
            .toEqual({ text: 'Acme Operations' });
        expect(d.buildOperationAnnouncementEmbed({ name: 'Op', branding: { iconUrl: '/media/logo.png' } }).footer)
            .toEqual({ text: 'Organization Operations' });
    });

    it('EGRESS GATE: a restricted op collapses to name + deep link only', () => {
        const e = d.buildOperationAnnouncementEmbed({ ...full, restricted: true });
        expect(e).toEqual({
            title: '🛰️ RESTRICTED OPERATION: Operation Nightfall',
            description: 'A restricted operation was posted. Open the dashboard to view.',
            color: 0x64748b,
            fields: [{ name: 'Details', value: '[Open in myRSI](https://org.example/?op=op-1)', inline: false }],
            timestamp: NOW_ISO,
            footer: { text: 'Acme Corp Operations', icon_url: 'https://org.example/icon.png' },
        });
        const bytes = JSON.stringify(e);
        for (const leaked of ['Escort', 'Secret', 'Ghost Squadron', 'Port Olisar', '1772395200']) {
            expect(bytes, `${leaked} reached a restricted embed`).not.toContain(leaked);
        }
    });

    it('a restricted op without a deep link has no fields, a default footer, and truncates its name', () => {
        const e = d.buildOperationAnnouncementEmbed({ name: 'R'.repeat(300), restricted: true, variant: 'starting', branding: { iconUrl: 'ftp://x' } });
        expect(e.fields).toEqual([]);
        expect(e.title).toBe(`⏱️ RESTRICTED OPERATION STARTING SOON: ${'R'.repeat(253)}...`);
        expect(e.footer).toEqual({ text: 'Organization Operations' });
    });
});

describe('postOperationAnnouncementEmbed', () => {
    it('posts the embed with the configured role ping, then chains ✅ ❌ ❓ onto the new message', async () => {
        fetchMock.mockImplementation(async (_url, init) => (init?.method === 'POST' ? res(200, { id: MESSAGE }) : res(204)));
        // Rendered before the queue's tail delay moves the fake clock.
        const expectedEmbed = d.buildOperationAnnouncementEmbed({ name: 'Op', description: 'Brief' });
        const p = d.postOperationAnnouncementEmbed(CHANNEL, { name: 'Op', description: 'Brief' }, { pingRoleId: PING_ROLE });
        await vi.runAllTimersAsync();
        expect(await p).toEqual({ messageId: MESSAGE });

        const c = calls();
        expect(c.map(x => `${x.method} ${x.url}`)).toEqual([
            `POST ${API}/channels/${CHANNEL}/messages`,
            `PUT ${API}/channels/${CHANNEL}/messages/${MESSAGE}/reactions/%E2%9C%85/@me`,
            `PUT ${API}/channels/${CHANNEL}/messages/${MESSAGE}/reactions/%E2%9D%8C/@me`,
            `PUT ${API}/channels/${CHANNEL}/messages/${MESSAGE}/reactions/%E2%9D%93/@me`,
        ]);
        expect(c[0].body).toEqual({
            content: `<@&${PING_ROLE}>`,
            allowed_mentions: { parse: [], roles: [PING_ROLE] },
            embeds: [expectedEmbed],
        });
    });

    it('without a (valid) ping role the post carries no content and pings nobody', async () => {
        fetchMock.mockImplementation(async (_url, init) => (init?.method === 'POST' ? res(200, { id: MESSAGE }) : res(204)));
        const p1 = d.postOperationAnnouncementEmbed(CHANNEL, { name: 'Op' });
        await vi.runAllTimersAsync();
        await p1;
        const p2 = d.postOperationAnnouncementEmbed(CHANNEL, { name: 'Op' }, { pingRoleId: '@everyone' });
        await vi.runAllTimersAsync();
        await p2;
        const posts = calls().filter(x => x.method === 'POST');
        expect(posts).toHaveLength(2);
        for (const post of posts) {
            expect(post.body.content).toBeUndefined();
            expect(post.body.allowed_mentions).toEqual({ parse: [] });
        }
    });

    it('a failed post returns its error and adds no reactions', async () => {
        fetchMock.mockResolvedValueOnce(res(403, { message: 'Missing Access' }));
        const p = d.postOperationAnnouncementEmbed(CHANNEL, { name: 'Op' });
        await vi.runAllTimersAsync();
        expect(await p).toEqual({ error: 'Missing Access' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a restricted op posts the bare notice', async () => {
        const p = d.postOperationAnnouncementEmbed(CHANNEL, { name: 'Op', description: 'TOP SECRET PLAN', restricted: true });
        await vi.runAllTimersAsync();
        await p;
        expect(JSON.stringify(calls()[0].body)).not.toContain('TOP SECRET PLAN');
        expect(calls()[0].body.embeds[0].title).toBe('🛰️ RESTRICTED OPERATION: Op');
    });
});

describe('postOperationStartingEmbed / editOperationAnnouncementEmbed', () => {
    it('the starting notice is one pingless post with the starting-soon title and no reactions', async () => {
        const expectedEmbed = d.buildOperationAnnouncementEmbed({ name: 'Op', description: 'Brief', variant: 'starting' });
        const p = d.postOperationStartingEmbed(CHANNEL, { name: 'Op', description: 'Brief' });
        await vi.runAllTimersAsync();
        expect(await p).toEqual({ messageId: MESSAGE });
        expect(calls()).toEqual([{
            url: `${API}/channels/${CHANNEL}/messages`,
            method: 'POST',
            headers: BOT_JSON_HEADERS,
            body: { embeds: [expectedEmbed], allowed_mentions: { parse: [] } },
        }]);
        expect(calls()[0].body.embeds[0].title).toBe('⏱️ STARTING SOON: Op');
    });

    it('the edit PATCHes the re-rendered embed with no content (no re-ping) and passes `gone` through', async () => {
        expect(await d.editOperationAnnouncementEmbed(CHANNEL, MESSAGE, { name: 'Op v2' })).toEqual({ ok: true });
        expect(calls()[0]).toEqual({
            url: `${API}/channels/${CHANNEL}/messages/${MESSAGE}`,
            method: 'PATCH',
            headers: BOT_JSON_HEADERS,
            body: { embeds: [d.buildOperationAnnouncementEmbed({ name: 'Op v2' })], allowed_mentions: { parse: [] } },
        });
        fetchMock.mockResolvedValueOnce(res(404, {}));
        expect(await d.editOperationAnnouncementEmbed(CHANNEL, MESSAGE, { name: 'Op' })).toEqual({ ok: false, gone: true, error: 'Discord message no longer exists.' });
    });
});

describe('per-channel post queue', () => {
    it('RATE LIMIT: posts to one channel are spaced 250ms apart', async () => {
        const a = d.postOperationStartingEmbed(CHANNEL, { name: 'A' });
        const b = d.postOperationStartingEmbed(CHANNEL, { name: 'B' });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(249);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(calls().map(c => c.body.embeds[0].title)).toEqual(['⏱️ STARTING SOON: A', '⏱️ STARTING SOON: B']);
        await vi.advanceTimersByTimeAsync(250);
        await expect(Promise.all([a, b])).resolves.toEqual([{ messageId: MESSAGE }, { messageId: MESSAGE }]);
    });

    it('different channels do not wait on each other', async () => {
        const a = d.postOperationStartingEmbed(CHANNEL, { name: 'A' });
        const b = d.postOperationStartingEmbed(CHANNEL_2, { name: 'B' });
        await vi.advanceTimersByTimeAsync(0);
        expect(calls().map(c => c.url)).toEqual([`${API}/channels/${CHANNEL}/messages`, `${API}/channels/${CHANNEL_2}/messages`]);
        await vi.runAllTimersAsync();
        await Promise.all([a, b]);
    });

    it('a throwing post rejects ITS caller but does not wedge the channel', async () => {
        const boom = new Error('secret store unavailable');
        h.secretThrowOnce = boom;
        const a = d.postOperationStartingEmbed(CHANNEL, { name: 'A' });
        const settledA = a.then(() => 'resolved', (e: unknown) => e);
        const b = d.postOperationStartingEmbed(CHANNEL, { name: 'B' });
        await vi.runAllTimersAsync();
        expect(await settledA).toBe(boom);
        expect(await b).toEqual({ messageId: MESSAGE });
        expect(calls().map(c => c.body.embeds[0].title)).toEqual(['⏱️ STARTING SOON: B']);
    });
});

describe('listGuildChannels', () => {
    it('GETs the guild channels and projects text/voice/announcement/stage only, sorted by position then name', async () => {
        fetchMock.mockResolvedValueOnce(res(200, [
            { id: '300000000000000001', name: 'ops', type: 0, parent_id: '400000000000000001', position: 2, topic: 'secret topic', permission_overwrites: [{ id: 'x', deny: '1024' }], nsfw: false },
            { id: '300000000000000002', name: 'Category', type: 4, position: 0 },
            { id: '300000000000000003', name: 'briefing', type: 2, parent_id: null, position: 1 },
            { id: '300000000000000004', name: 'thread', type: 11, position: 0 },
            { id: '300000000000000005', name: 'announcements', type: 5, position: 2 },
            { id: 777, type: 13 },
            { id: '300000000000000007', name: 'forum', type: 15, position: 0 },
        ]));
        expect(await d.listGuildChannels()).toEqual({
            channels: [
                { id: '777', name: '', type: 13, parentId: null, position: 0 },
                { id: '300000000000000003', name: 'briefing', type: 2, parentId: null, position: 1 },
                { id: '300000000000000005', name: 'announcements', type: 5, parentId: null, position: 2 },
                { id: '300000000000000001', name: 'ops', type: 0, parentId: '400000000000000001', position: 2 },
            ],
            error: null,
            guildId: GUILD_ID,
        });
        expect(calls()).toEqual([{ url: `${API}/guilds/${GUILD_ID}/channels`, method: 'GET', headers: BOT_HEADERS, body: undefined }]);
    });

    it('a non-array body yields no channels', async () => {
        fetchMock.mockResolvedValueOnce(res(200, { message: 'weird' }));
        expect(await d.listGuildChannels()).toEqual({ channels: [], error: null, guildId: GUILD_ID });
    });

    it('caches a success for 60s, then refetches', async () => {
        fetchMock.mockResolvedValue(res(200, []));
        await d.listGuildChannels();
        vi.advanceTimersByTime(60_000);
        await d.listGuildChannels();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        await d.listGuildChannels();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID'])('FAILS CLOSED (and caches) when %s is unset', async (key) => {
        h.secrets[key] = null;
        const out = await d.listGuildChannels();
        expect(out).toEqual({ channels: [], error: 'Discord bot is not configured for this organization.', guildId: null });
        expect(fetchMock).not.toHaveBeenCalled();
        h.secretReads = [];
        expect(await d.listGuildChannels()).toEqual(out);
        expect(h.secretReads).toEqual([]);
    });

    it.each([
        [401, { message: '401: Unauthorized' }, 'Discord bot token is invalid or has expired.'],
        [403, { message: 'Missing Access' }, 'Discord bot lacks the View Channels permission.'],
        [404, { message: 'Unknown Guild' }, 'Unknown Guild'],
    ])('a permanent %i is mapped and cached', async (status, body, message) => {
        fetchMock.mockResolvedValueOnce(res(status, body));
        expect(await d.listGuildChannels()).toEqual({ channels: [], error: message, guildId: GUILD_ID });
        expect(h.logs).toEqual([{ level: 'warn', msg: 'listGuildChannels failed', fields: { message } }]);
        await d.listGuildChannels();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a transient 5xx is reported but NOT cached', async () => {
        fetchMock.mockResolvedValueOnce(res(503));
        expect(await d.listGuildChannels()).toEqual({ channels: [], error: 'Discord API returned HTTP 503.', guildId: GUILD_ID });
        fetchMock.mockResolvedValueOnce(res(200, []));
        expect(await d.listGuildChannels()).toEqual({ channels: [], error: null, guildId: GUILD_ID });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a network error is reported but NOT cached', async () => {
        const boom = new TypeError('fetch failed');
        fetchMock.mockRejectedValueOnce(boom);
        expect(await d.listGuildChannels()).toEqual({ channels: [], error: 'Could not reach the Discord API. Try again in a moment.', guildId: GUILD_ID });
        expect(h.logs).toEqual([{ level: 'error', msg: 'listGuildChannels network error', fields: { err: boom } }]);
        await d.listGuildChannels();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('RATE-LIMIT FLOOR: forceRefresh bypasses the cache at most once per 10s', async () => {
        fetchMock.mockResolvedValue(res(200, []));
        await d.listGuildChannels();
        await d.listGuildChannels({ forceRefresh: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(9_999);
        await d.listGuildChannels({ forceRefresh: true });
        await d.listGuildChannels({ forceRefresh: true });
        expect(fetchMock, 'a forced refresh inside the floor reached Discord').toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(1);
        await d.listGuildChannels({ forceRefresh: true });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('inside the floor a force with nothing cached still fetches (the floor only routes through the cache)', async () => {
        fetchMock.mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200, []));
        await d.listGuildChannels({ forceRefresh: true });
        vi.advanceTimersByTime(1_000);
        expect(await d.listGuildChannels({ forceRefresh: true })).toEqual({ channels: [], error: null, guildId: GUILD_ID });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('createGuildScheduledEvent', () => {
    const opts = {
        name: 'Operation Nightfall',
        description: 'Escort the convoy.',
        scheduledStart: '2026-03-01T20:00:00.000Z',
        scheduledEnd: '2026-03-01T22:30:00.000Z',
        locationUrl: 'https://org.example/?op=op-1',
    };

    it('POSTs a GUILD_ONLY EXTERNAL event with the banner, and returns the new id', async () => {
        h.bannerFiles[DIST_BANNER] = Buffer.from('JPEGBYTES');
        fetchMock.mockResolvedValueOnce(res(200, { id: EVENT }));
        expect(await d.createGuildScheduledEvent(opts)).toEqual({ eventId: EVENT });
        expect(calls()).toEqual([{
            url: `${API}/guilds/${GUILD_ID}/scheduled-events`,
            method: 'POST',
            headers: BOT_JSON_HEADERS,
            body: {
                name: 'Operation Nightfall',
                privacy_level: 2,
                scheduled_start_time: '2026-03-01T20:00:00.000Z',
                scheduled_end_time: '2026-03-01T22:30:00.000Z',
                entity_type: 3,
                entity_metadata: { location: 'https://org.example/?op=op-1' },
                description: 'Escort the convoy.',
                image: `data:image/jpeg;base64,${Buffer.from('JPEGBYTES').toString('base64')}`,
            },
        }]);
        expect(h.bannerReads).toEqual([DIST_BANNER]);
        expect(h.logs).toEqual([{ level: 'info', msg: 'created scheduled event', fields: { eventId: EVENT } }]);
    });

    it('caches the banner after the first successful read', async () => {
        h.bannerFiles[DIST_BANNER] = Buffer.from('A');
        fetchMock.mockImplementation(async () => res(200, { id: EVENT }));
        await d.createGuildScheduledEvent(opts);
        await d.createGuildScheduledEvent(opts);
        expect(h.bannerReads).toEqual([DIST_BANNER]);
        expect(calls()[1].body.image).toBe(`data:image/jpeg;base64,${Buffer.from('A').toString('base64')}`);
    });

    it('falls back to the public/ banner (dev mode)', async () => {
        h.bannerFiles[PUBLIC_BANNER] = Buffer.from('DEV');
        fetchMock.mockResolvedValueOnce(res(200, { id: EVENT }));
        await d.createGuildScheduledEvent(opts);
        expect(h.bannerReads).toEqual([DIST_BANNER, PUBLIC_BANNER]);
        expect(calls()[0].body.image).toBe(`data:image/jpeg;base64,${Buffer.from('DEV').toString('base64')}`);
    });

    it('omits the image (and warns) when no banner exists, and omits an absent description', async () => {
        fetchMock.mockResolvedValueOnce(res(200, { id: EVENT }));
        await d.createGuildScheduledEvent({ ...opts, description: undefined });
        const body = calls()[0].body;
        expect(Object.keys(body).sort()).toEqual(['entity_metadata', 'entity_type', 'name', 'privacy_level', 'scheduled_end_time', 'scheduled_start_time']);
        expect(h.logs[0]).toEqual({ level: 'warn', msg: 'event banner image not found', fields: undefined });
    });

    it('caps the description at 1000 chars', async () => {
        fetchMock.mockImplementation(async () => res(200, { id: EVENT }));
        await d.createGuildScheduledEvent({ ...opts, description: 'x'.repeat(1500) });
        await d.createGuildScheduledEvent({ ...opts, description: 'y'.repeat(1000) });
        expect(calls()[0].body.description).toBe(`${'x'.repeat(997)}...`);
        expect(calls()[1].body.description).toBe('y'.repeat(1000));
    });

    it.each(['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID'])('FAILS CLOSED when %s is unset', async (key) => {
        h.secrets[key] = null;
        expect(await d.createGuildScheduledEvent(opts)).toEqual({ error: 'Discord bot token or guild ID is not configured. Check your Discord integration settings.' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(h.logs).toEqual([{ level: 'warn', msg: 'cannot create event: bot token or guild id missing', fields: undefined }]);
    });

    it.each([
        ['a 403', 403, { message: 'Missing Permissions' }, 'The Discord bot lacks permission to create events. Ensure it has the "Manage Events" permission in your Discord server.'],
        ['code 50013', 400, { message: 'Missing Permissions', code: 50013 }, 'The Discord bot lacks permission to create events. Ensure it has the "Manage Events" permission in your Discord server.'],
        ['a 401', 401, { message: '401: Unauthorized' }, 'The Discord bot token is invalid or has expired. Re-configure your bot token in Discord settings.'],
        ['a plain error', 400, { message: 'Bad Request' }, 'Bad Request'],
        ['an unreadable error', 500, undefined, 'Discord API returned an error (HTTP 500). Check your bot configuration.'],
    ])('maps %s to an operator-actionable message', async (_l, status, body, error) => {
        fetchMock.mockResolvedValueOnce(res(status, body));
        expect(await d.createGuildScheduledEvent(opts)).toEqual({ error });
        expect(h.logs.filter(l => l.level === 'error')).toEqual([{ level: 'error', msg: 'failed to create scheduled event', fields: { error: body ?? {} } }]);
    });

    it('flattens a 50035 Invalid Form Body tree into "<field>: <reason>" details', async () => {
        fetchMock.mockResolvedValueOnce(res(400, {
            code: 50035,
            message: 'Invalid Form Body',
            errors: {
                _errors: [{ code: 'X', message: 'Top-level problem.' }],
                name: { _errors: [{ code: 'BASE_TYPE_BAD_LENGTH', message: 'Must be between 1 and 100 in length.' }] },
                scheduled_start_time: { _errors: [{ code: 'GUILD_SCHEDULED_EVENT_SCHEDULE_PAST', message: 'Cannot schedule event in the past.' }, { message: '   ' }, { message: 42 }, null] },
                entity_metadata: { location: { _errors: [{ message: 'Too long.' }] } },
                ignored: 'not-an-object',
            },
        }));
        expect(await d.createGuildScheduledEvent(opts)).toEqual({
            error: 'Discord rejected the event: Top-level problem. name: Must be between 1 and 100 in length. scheduled_start_time: Cannot schedule event in the past. entity_metadata.location: Too long.',
        });
    });

    it('a form-error tree with no usable leaf falls back to the top-level message', async () => {
        fetchMock.mockResolvedValueOnce(res(400, { message: 'Invalid Form Body', errors: { name: { _errors: [{ message: '' }] } } }));
        expect(await d.createGuildScheduledEvent(opts)).toEqual({ error: 'Invalid Form Body' });
    });

    it('maps a network failure to a fixed message', async () => {
        const boom = new TypeError('fetch failed');
        fetchMock.mockRejectedValueOnce(boom);
        expect(await d.createGuildScheduledEvent(opts)).toEqual({ error: 'Could not reach the Discord API. Check your server\'s network connectivity.' });
        expect(h.logs.filter(l => l.level === 'error')).toEqual([{ level: 'error', msg: 'network error creating scheduled event', fields: { err: boom } }]);
    });
});

describe('updateGuildScheduledEvent', () => {
    it('PATCHes only the fields that were set', async () => {
        expect(await d.updateGuildScheduledEvent(EVENT, { name: 'Renamed' })).toEqual({ ok: true });
        expect(calls()).toEqual([{ url: `${API}/guilds/${GUILD_ID}/scheduled-events/${EVENT}`, method: 'PATCH', headers: BOT_JSON_HEADERS, body: { name: 'Renamed' } }]);
        expect(h.logs).toEqual([{ level: 'info', msg: 'updated scheduled event', fields: { eventId: EVENT } }]);
    });

    it('maps every option onto its Discord field, capping the description', async () => {
        await d.updateGuildScheduledEvent(EVENT, {
            name: 'N',
            description: 'z'.repeat(1200),
            scheduledStart: '2026-03-01T20:00:00.000Z',
            scheduledEnd: '2026-03-01T22:30:00.000Z',
            locationUrl: 'https://org.example/?op=2',
        });
        expect(calls()[0].body).toEqual({
            name: 'N',
            scheduled_start_time: '2026-03-01T20:00:00.000Z',
            scheduled_end_time: '2026-03-01T22:30:00.000Z',
            description: `${'z'.repeat(997)}...`,
            entity_metadata: { location: 'https://org.example/?op=2' },
        });
    });

    it('EGRESS GATE: a null/empty description is sent as "" so the published briefing is CLEARED, not left in place', async () => {
        await d.updateGuildScheduledEvent(EVENT, { description: null });
        await d.updateGuildScheduledEvent(EVENT, { description: '' });
        await d.updateGuildScheduledEvent(EVENT, { description: 'short' });
        expect(calls().map(c => c.body)).toEqual([{ description: '' }, { description: '' }, { description: 'short' }]);
    });

    it('an empty update is a successful no-op with no request', async () => {
        expect(await d.updateGuildScheduledEvent(EVENT, {})).toEqual({ ok: true });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID'])('FAILS CLOSED when %s is unset', async (key) => {
        h.secrets[key] = null;
        expect(await d.updateGuildScheduledEvent(EVENT, { name: 'x' })).toEqual({ ok: false, error: 'Discord bot token or guild ID is not configured.' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(h.logs).toEqual([{ level: 'warn', msg: 'cannot update event: bot token or guild id missing', fields: undefined }]);
    });

    it.each([
        [404, { message: 'Unknown Guild Scheduled Event' }, 'The linked Discord event no longer exists.'],
        [403, { message: 'Missing Permissions' }, 'The Discord bot lacks permission to edit events.'],
        [400, { message: 'Missing Permissions', code: 50013 }, 'The Discord bot lacks permission to edit events.'],
        [401, { message: '401: Unauthorized' }, 'The Discord bot token is invalid or has expired.'],
        [400, { message: 'Invalid Form Body' }, 'Invalid Form Body'],
        [502, undefined, 'Discord API returned HTTP 502.'],
    ])('maps HTTP %i to its message', async (status, body, error) => {
        fetchMock.mockResolvedValueOnce(res(status, body));
        expect(await d.updateGuildScheduledEvent(EVENT, { name: 'x' })).toEqual({ ok: false, error });
        expect(h.logs).toEqual([{ level: 'error', msg: 'failed to update scheduled event', fields: { eventId: EVENT, error: body ?? {} } }]);
    });

    it('maps a network failure to a fixed message', async () => {
        const boom = new TypeError('fetch failed');
        fetchMock.mockRejectedValueOnce(boom);
        expect(await d.updateGuildScheduledEvent(EVENT, { name: 'x' })).toEqual({ ok: false, error: 'Could not reach the Discord API.' });
        expect(h.logs).toEqual([{ level: 'error', msg: 'network error updating scheduled event', fields: { err: boom } }]);
    });
});

describe('deleteGuildScheduledEvent', () => {
    it('DELETEs the event with only the bot Authorization header', async () => {
        fetchMock.mockResolvedValueOnce(res(204));
        await d.deleteGuildScheduledEvent(EVENT);
        expect(calls()).toEqual([{ url: `${API}/guilds/${GUILD_ID}/scheduled-events/${EVENT}`, method: 'DELETE', headers: BOT_HEADERS, body: undefined }]);
        expect(h.logs).toEqual([]);
    });

    it.each(['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID'])('issues nothing when %s is unset', async (key) => {
        h.secrets[key] = null;
        await d.deleteGuildScheduledEvent(EVENT);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats 404 as already gone, logs any other failure', async () => {
        fetchMock.mockResolvedValueOnce(res(404, { message: 'Unknown' }));
        await d.deleteGuildScheduledEvent(EVENT);
        expect(h.logs).toEqual([]);
        fetchMock.mockResolvedValueOnce(res(500));
        await d.deleteGuildScheduledEvent(EVENT);
        expect(h.logs).toEqual([{ level: 'error', msg: 'failed to delete scheduled event', fields: { eventId: EVENT, error: {} } }]);
    });

    it('swallows a network failure with an error log', async () => {
        const boom = new TypeError('fetch failed');
        fetchMock.mockRejectedValueOnce(boom);
        await expect(d.deleteGuildScheduledEvent(EVENT)).resolves.toBeUndefined();
        expect(h.logs).toEqual([{ level: 'error', msg: 'network error deleting scheduled event', fields: { err: boom } }]);
    });
});

// ROUTE-ID GUARD for the scheduled-event paths. eventId is the persisted
// operations.discord_event_id column; a `../` value walks out of
// /scheduled-events/ to any bot-authenticated route on the same method.
describe('ROUTE-ID GUARD: scheduled-event ids must be snowflakes', () => {
    const TRAVERSAL = `../../../channels/${CHANNEL}?x=`;

    it('the traversal is real: an event PATCH/DELETE becomes a channel PATCH/DELETE', () => {
        expect(new URL(`${API}/guilds/${GUILD_ID}/scheduled-events/${TRAVERSAL}`).pathname).toBe(`/api/v10/channels/${CHANNEL}`);
    });

    it('updateGuildScheduledEvent refuses without reading credentials or issuing a request', async () => {
        expect(await d.updateGuildScheduledEvent(TRAVERSAL, { name: 'x' })).toEqual({ ok: false, error: 'Invalid Discord event ID.' });
        expect(h.secretReads).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(h.logs).toEqual([{ level: 'warn', msg: 'refusing to update event: event id is not a snowflake', fields: { eventId: TRAVERSAL } }]);
    });

    it('deleteGuildScheduledEvent refuses without reading credentials or issuing a request', async () => {
        await d.deleteGuildScheduledEvent(TRAVERSAL);
        await d.deleteGuildScheduledEvent('');
        expect(h.secretReads).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(h.logs.map(l => l.msg)).toEqual([
            'refusing to delete event: event id is not a snowflake',
            'refusing to delete event: event id is not a snowflake',
        ]);
    });
});
