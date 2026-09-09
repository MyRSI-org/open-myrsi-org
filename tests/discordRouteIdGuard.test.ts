import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// DISCORD ROUTE-ID GUARD.
//
// Every Discord REST call this build makes interpolates ids straight into the path
// and sends `Authorization: Bot <token>`. An id therefore does not parameterise the
// request — it CHOOSES THE ENDPOINT. `fetch` normalises the URL before sending, so a
// value carrying `../` walks out of the intended route and a `?` truncates whatever
// the template appends after it:
//
//     '../guilds/<id>/prune?x='  ->  POST /api/v10/guilds/<id>/prune
//
// which is an arbitrary bot-authenticated write: Begin-Guild-Prune (a mass kick),
// role creation, a post into any channel the bot can see.
//
// The gap this pins was real. `operation:repost_announcement` shape-checked its
// caller-supplied channel and carried a comment reading "both halves are needed;
// either alone leaves a door open" — while `operation:create`, which names the SAME
// destination under the weaker `operations:create` permission, passed
// `String(...).trim()` straight through. The value was also PERSISTED and re-fired
// later by the start-notice cron.
//
// So the check lives at the SINK, where every path is built, and the call sites keep
// their own validation on top: the sink stops the class, the call-site check stops a
// junk value being stored in the first place.

const h = vi.hoisted(() => ({
    calls: [] as Array<{ url: string; method: string }>,
}));

vi.mock('../lib/db/common.js', () => ({
    supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) },
    handleSupabaseError: () => {},
}));
vi.mock('../lib/secrets.js', () => ({ getOrgSecret: async () => 'bot-token' }));
vi.mock('../lib/cache.js', () => ({ cache: { get: () => undefined, set: () => {}, invalidate: () => {} } }));

import {
    sendDiscordChannelMessage,
    editDiscordChannelMessage,
    deleteDiscordChannelMessage,
    addMessageReactions,
} from '../lib/discord';

const GOOD_CHANNEL = '123456789012345678';
const GOOD_MESSAGE = '876543210987654321';

// The exact shape that turns a channel id into an endpoint choice.
const TRAVERSAL = '../guilds/999888777666555444/prune?x=';

beforeEach(() => {
    h.calls.length = 0;
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
        h.calls.push({ url: String(url), method: init?.method || 'GET' });
        return { ok: true, status: 200, json: async () => ({ id: GOOD_MESSAGE }) };
    });
});

describe('the traversal this guard exists to stop is real', () => {
    it('a ../ channel id relocates the endpoint and the ? eats the /messages suffix', () => {
        // Reproduced against the same WHATWG URL parser fetch uses, so the threat is
        // demonstrated rather than asserted.
        const built = new URL(`https://discord.com/api/v10/channels/${TRAVERSAL}/messages`).href;
        expect(built).toBe('https://discord.com/api/v10/guilds/999888777666555444/prune?x=/messages');
        expect(built).not.toContain('/channels/');
    });
});

describe('every Discord sink refuses a non-snowflake before building a URL', () => {
    it('sendDiscordChannelMessage refuses and issues no request', async () => {
        const r = await sendDiscordChannelMessage(TRAVERSAL, { content: 'x' });
        expect(r.error).toMatch(/Invalid Discord channel ID/);
        expect(h.calls, 'a request was issued with an attacker-chosen endpoint').toEqual([]);
    });

    it('editDiscordChannelMessage refuses on either id', async () => {
        expect((await editDiscordChannelMessage(TRAVERSAL, GOOD_MESSAGE, {})).ok).toBe(false);
        expect((await editDiscordChannelMessage(GOOD_CHANNEL, TRAVERSAL, {})).ok).toBe(false);
        expect(h.calls).toEqual([]);
    });

    it('deleteDiscordChannelMessage refuses on either id', async () => {
        await deleteDiscordChannelMessage(TRAVERSAL, GOOD_MESSAGE);
        await deleteDiscordChannelMessage(GOOD_CHANNEL, TRAVERSAL);
        expect(h.calls).toEqual([]);
    });

    it('addMessageReactions refuses on either id', async () => {
        await addMessageReactions(TRAVERSAL, GOOD_MESSAGE, ['👍']);
        await addMessageReactions(GOOD_CHANNEL, TRAVERSAL, ['👍']);
        expect(h.calls).toEqual([]);
    });

    it('refuses the empty string and a near-miss, not just the traversal', async () => {
        // The regex is 17-19 digits. A 16-digit id, a snowflake with whitespace, and a
        // numeric-looking value with a path separator all have to die too.
        for (const bad of ['', '   ', '1234567890123456', `${GOOD_CHANNEL} `, `${GOOD_CHANNEL}/../x`, '12345678901234567890123']) {
            expect((await sendDiscordChannelMessage(bad, { content: 'x' })).error, `accepted ${JSON.stringify(bad)}`).toBeTruthy();
        }
        expect(h.calls).toEqual([]);
    });

    it('a real snowflake still goes through, to the intended route', async () => {
        // The guard is worthless if it also blocks the working path.
        const r = await sendDiscordChannelMessage(GOOD_CHANNEL, { content: 'x' });
        expect(r.error).toBeUndefined();
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].url).toBe(`https://discord.com/api/v10/channels/${GOOD_CHANNEL}/messages`);
        expect(h.calls[0].method).toBe('POST');
    });
});

describe('the call sites validate too, so junk is never persisted', () => {
    const ROOT = resolve(__dirname, '..');
    const actions = readFileSync(resolve(ROOT, 'api', 'actions', 'operations.ts'), 'utf8');
    const ops = readFileSync(resolve(ROOT, 'lib', 'db', 'ops.ts'), 'utf8');

    it('operation:create shape-checks the announcement channel, like its repost sibling', () => {
        const create = actions.slice(actions.indexOf("'operation:create'"), actions.indexOf("'operation:get_details'"));
        expect(create, 'the create path is back to passing the raw payload value through')
            .toMatch(/normaliseDiscordSnowflake\(opData\.discordAnnouncementChannelId/);
        expect(create).not.toMatch(/postOperationAnnouncementEmbed\(\s*String\(opData\.discordAnnouncementChannelId\)\.trim\(\)/);
    });

    it('createOperation refuses to persist a non-snowflake channel id', () => {
        // Persisted junk outlives the request: lib/db/opStartNotices.ts re-reads this
        // column and fires it on a timer.
        const persist = ops.slice(ops.indexOf('discord_announcement_channel_id:'), ops.indexOf('discord_start_notice:'));
        expect(persist).toMatch(/DISCORD_SNOWFLAKE_RE\.test/);
    });
});
