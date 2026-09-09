import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Discord's default, when `allowed_mentions` is absent from a message body, is to
// parse @everyone / @here / <@&role> out of `content`. sendDiscordChannelMessage
// stringified the caller's object verbatim, so it was an unguarded mass-ping
// primitive by construction. Not reachable today (all four call sites put
// member-authored text in `embeds`, and a mention inside an embed never notifies
// anyone) — this pins the default so the first path that puts text in `content`
// cannot become one.
//
// The one deliberate ping in the product is the EAM's hard-coded '@here'
// (lib/db/system.ts), which passes an explicit allowed_mentions. That opt-in must
// keep winning; assertion 'explicit allowed_mentions still wins' is its guard.

const h = vi.hoisted(() => ({
    bodies: [] as unknown[],
}));

vi.mock('../lib/secrets', () => ({ getOrgSecret: async () => 'bot-token' }));
vi.mock('../lib/db/common', () => ({
    supabase: { from: () => ({}) },
    handleSupabaseError: () => undefined,
}));
vi.mock('../lib/cache', () => ({ cache: { get: () => undefined, set: () => {}, invalidate: () => {}, invalidatePrefix: () => {} }, TTL: {} }));

import { sendDiscordChannelMessage, editDiscordChannelMessage, buildMentionContent } from '../lib/discord';

const realFetch = globalThis.fetch;
const fetchStub = vi.fn(async (_url: string, init: { body?: string }) => {
    h.bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
    return { ok: true, status: 200, json: async () => ({ id: 'msg-1' }) };
});
globalThis.fetch = fetchStub as unknown as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

const lastBody = () => h.bodies[h.bodies.length - 1] as Record<string, any>;

beforeEach(() => { h.bodies = []; fetchStub.mockClear(); });

// Real snowflakes. lib/discord.ts refuses a non-snowflake channel/message id before it
// builds a URL (an id chooses the ENDPOINT on a bot-authenticated request — see
// tests/discordRouteIdGuard.test.ts), so a placeholder here would be rejected at the
// guard and these mention-suppression assertions would never reach the request body.
const CHANNEL_ID = '123456789012345678';
const MESSAGE_ID = '876543210987654321';

describe('sendDiscordChannelMessage mention suppression', () => {
    it('adds allowed_mentions: { parse: [] } to an embed-only post', async () => {
        await sendDiscordChannelMessage(CHANNEL_ID, { embeds: [{ title: 't' }] });
        expect(lastBody().allowed_mentions).toEqual({ parse: [] });
        expect(lastBody().embeds).toEqual([{ title: 't' }]);
    });

    it('MASS-PING REGRESSION GUARD: content full of mentions notifies nobody', async () => {
        await sendDiscordChannelMessage(CHANNEL_ID, { content: 'Heads up @everyone @here <@&123456789012345678>' });
        expect(lastBody().allowed_mentions.parse).toEqual([]);
        expect(lastBody().allowed_mentions.roles).toBeUndefined();
    });

    it('explicit allowed_mentions still wins (the EAM @here contract)', async () => {
        // lib/db/system.ts's notifyDiscordEam sends { content: '@here', ...,
        // allowed_mentions: { parse: ['everyone'] } }. If this ever fails, the
        // suppression default was applied AFTER the caller's keys and silently
        // disarmed the one intentional ping in the product.
        await sendDiscordChannelMessage(CHANNEL_ID, { content: '@here', embeds: [], allowed_mentions: { parse: ['everyone'] } });
        expect(lastBody().allowed_mentions.parse).toEqual(['everyone']);
    });

    it('an explicitly-undefined allowed_mentions does not disarm the default', async () => {
        // The fail-OPEN edge a spread default would have: `allowed_mentions:
        // undefined` overwrites, JSON.stringify drops the key, Discord goes back to
        // parsing every mention out of content.
        await sendDiscordChannelMessage(CHANNEL_ID, { content: 'x @everyone', allowed_mentions: undefined });
        expect(lastBody().allowed_mentions).toEqual({ parse: [] });
    });

    it('does not mutate the caller object (embeds are reused across the enqueue tick)', async () => {
        const payload: Record<string, unknown> = { embeds: [{ title: 't' }] };
        await sendDiscordChannelMessage(CHANNEL_ID, payload);
        expect(Object.hasOwn(payload, 'allowed_mentions')).toBe(false);
    });

    it('passes a non-object payload through untouched', async () => {
        await sendDiscordChannelMessage(CHANNEL_ID, 'raw-string' as unknown as Record<string, unknown>);
        expect(lastBody()).toBe('raw-string');
    });
});

describe('editDiscordChannelMessage mention suppression', () => {
    it('applies the same default so the two paths cannot drift', async () => {
        await editDiscordChannelMessage(CHANNEL_ID, MESSAGE_ID, { embeds: [] });
        expect(lastBody().allowed_mentions).toEqual({ parse: [] });
    });
});

describe('buildMentionContent — the opt-in', () => {
    it('is a spreadable no-op when nothing should be pinged', () => {
        expect(buildMentionContent({})).toEqual({});
        expect(buildMentionContent({ here: false, everyone: false, roleId: null })).toEqual({});
    });

    it('@here uses parse: [everyone], which is what covers @here', () => {
        expect(buildMentionContent({ here: true })).toEqual({
            content: '@here',
            allowed_mentions: { parse: ['everyone'] },
        });
    });

    it('@everyone SUPERSEDES @here rather than combining', () => {
        // '@here @everyone' would notify the same people twice in one message.
        const out = buildMentionContent({ here: true, everyone: true });
        expect(out.content).toBe('@everyone');
    });

    it('a role ping names the role in `roles`, never in `parse` (Discord 400s on both)', () => {
        expect(buildMentionContent({ roleId: '123456789012345678' })).toEqual({
            content: '<@&123456789012345678>',
            allowed_mentions: { parse: [], roles: ['123456789012345678'] },
        });
    });

    it('combines @here with a role ping', () => {
        expect(buildMentionContent({ here: true, roleId: '123456789012345678' })).toEqual({
            content: '@here <@&123456789012345678>',
            allowed_mentions: { parse: ['everyone'], roles: ['123456789012345678'] },
        });
    });

    it('drops a non-snowflake role id rather than emitting junk mention markup', () => {
        expect(buildMentionContent({ roleId: 'not-a-snowflake' })).toEqual({});
        expect(buildMentionContent({ roleId: '<@&123>' })).toEqual({});
    });
});
