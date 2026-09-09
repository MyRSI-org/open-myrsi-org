import { describe, it, expect, vi, beforeEach } from 'vitest';

// EGRESS GATE for operations -> Discord.
//
// An operation has TWO independent Discord surfaces, and both used to publish the
// full briefing unconditionally:
//   1. the announcement embed, posted to an operator-picked GENERAL channel; and
//   2. the Guild Scheduled Event, which is privacy_level GUILD_ONLY — i.e. every
//      member of the Discord server, a strictly WIDER audience.
// Neither has a per-recipient clearance/marker filter, while the in-app read path
// (canUserSeeOpInList / assertOpVisibleToUser / passesClearance) hides the same op
// from uncleared members. So for a RESTRICTED op — clearance > 0, any limiting
// marker, or a Special Operation — both surfaces collapse to a bare notice.
//
// These assertions render the REAL embed from the captured input, so each one is
// over the exact bytes that would ship to Discord.

const h = vi.hoisted(() => ({
    op: {} as Record<string, unknown>,
    markerCount: 0 as number | null,
    markerError: null as unknown,
    posted: [] as Array<{ channelId: string; input: any }>,
    edited: [] as Array<{ channelId: string; messageId: string; input: any }>,
    events: [] as Array<{ kind: 'create' | 'update'; options: any }>,
}));

// The real lib/db/ops.operationIsRestricted runs against this fake, so the
// fail-closed leg is exercised rather than stubbed.
vi.mock('../lib/db/common', () => {
    function resolveFor(table: string) {
        switch (table) {
            case 'operations': return { data: h.op, error: null };
            case 'operation_limiting_markers': return { data: null, count: h.markerCount, error: h.markerError };
            case 'units': return { data: { name: 'Ghost Squadron' }, error: null };
            case 'locations': return { data: { name: 'Depot Prime' }, error: null };
            case 'settings': return { data: [{ key: 'brandingConfig', value: { name: 'Acme Corp' } }], error: null };
            case 'security_clearances': return { data: { name: 'Top Secret', level: 5 }, error: null };
            default: return { data: null, error: null };
        }
    }
    function builder(table: string) {
        const b: any = {};
        for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = () => b;
        }
        const settle = () => Promise.resolve(resolveFor(table));
        b.single = () => settle();
        b.maybeSingle = () => settle();
        b.then = (res: any, rej: any) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: () => {}, broadcastToChannel: () => {}, getSystemRoles: async () => ({}),
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

const dbSpies = vi.hoisted(() => ({
    createOperation: vi.fn(async () => ({ id: 'op-1' })),
    createOperationReminders: vi.fn(async () => undefined),
    getOrgTenantUrl: vi.fn(async () => 'https://org.example'),
    updateOperationDetails: vi.fn(async () => ({ id: 'op-1' })),
}));

// The barrel is stubbed EXCEPT operationIsRestricted, which is the predicate under
// test — a stubbed one would make every assertion below vacuous.
vi.mock('../lib/db', async () => {
    const common = await import('../lib/db/common');
    const ops = await import('../lib/db/ops');
    return { ...dbSpies, supabase: common.supabase, operationIsRestricted: ops.operationIsRestricted };
});

vi.mock('../lib/secrets', () => ({ getOrgSecret: async () => 'bot-token' }));
vi.mock('../lib/cache', () => ({ cache: { get: () => undefined, set: () => {}, invalidate: () => {}, invalidatePrefix: () => {} }, TTL: {} }));

// Capture stubs for the senders; the embed BUILDER stays real so the assertions
// render the bytes that would actually ship.
vi.mock('../lib/discord', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/discord')>();
    return {
        ...actual,
        postOperationAnnouncementEmbed: vi.fn(async (channelId: string, input: any) => {
            h.posted.push({ channelId, input }); return { messageId: 'msg-1' };
        }),
        editOperationAnnouncementEmbed: vi.fn(async (channelId: string, messageId: string, input: any) => {
            h.edited.push({ channelId, messageId, input }); return { ok: true };
        }),
        createGuildScheduledEvent: vi.fn(async (options: any) => {
            h.events.push({ kind: 'create', options }); return { eventId: 'ev-1' };
        }),
        updateGuildScheduledEvent: vi.fn(async (_eventId: string, options: any) => {
            h.events.push({ kind: 'update', options }); return { ok: true };
        }),
        deleteGuildScheduledEvent: vi.fn(async () => undefined),
        deleteDiscordChannelMessage: vi.fn(async () => undefined),
        listGuildChannels: vi.fn(async () => []),
    };
});

import { buildOperationAnnouncementEmbed } from '../lib/discord';
import { operationActions } from '../api/actions/operations';

const BRIEFING = 'SECRET BRIEFING: strike the depot at 0300, ROE attached.';
const CHANNEL = '123456789012345678';

const opRow = (over: Record<string, unknown> = {}) => ({
    id: 'op-1',
    name: 'Operation Nightfall',
    description: BRIEFING,
    type: 'Combat',
    scheduled_start: '2026-09-01T20:00:00.000Z',
    scheduled_end: '2026-09-01T22:00:00.000Z',
    clearance_level: 0,
    unit_id: 1,
    location_id: 1,
    location_text: 'Hidden Staging Point Delta',
    is_special: false,
    discord_event_id: null,
    discord_announcement_channel_id: null,
    discord_announcement_message_id: null,
    ...over,
});

// The exact bytes Discord would receive for an embed post.
const renderedJson = (input: any) => {
    const embed = buildOperationAnnouncementEmbed(input);
    return JSON.stringify({ title: embed.title, description: embed.description, fields: embed.fields });
};

const create = (over: Record<string, unknown> = {}) => operationActions['operation:create']({
    name: 'Operation Nightfall',
    description: BRIEFING,
    scheduledStart: '2026-09-01T20:00:00.000Z',
    scheduledEnd: '2026-09-01T22:00:00.000Z',
    postDiscordAnnouncement: true,
    discordAnnouncementChannelId: CHANNEL,
    userId: 1,
    ...over,
});

beforeEach(() => {
    h.op = opRow();
    h.markerCount = 0;
    h.markerError = null;
    h.posted = []; h.edited = []; h.events = [];
    dbSpies.createOperation.mockClear();
    dbSpies.updateOperationDetails.mockClear();
});

describe('announcement embed — restricted ops collapse to a bare notice', () => {
    it('clearance > 0: no briefing, no clearance label, no location, no unit, no type', async () => {
        h.op = opRow({ clearance_level: 5 });
        await create();
        expect(h.posted).toHaveLength(1);
        expect(h.posted[0].input.restricted).toBe(true);

        const embed = buildOperationAnnouncementEmbed(h.posted[0].input);
        expect(embed.description).toBe('A restricted operation was posted. Open the dashboard to view.');
        const json = renderedJson(h.posted[0].input);
        expect(json).not.toContain('SECRET BRIEFING');
        expect(json).not.toContain('Hidden Staging Point Delta');
        expect(json).not.toContain('Clearance');
        expect(json).not.toContain('Ghost Squadron');
        expect(json).not.toContain('Combat');
        // The deep link survives — this deployment's own URL, and the only way a
        // cleared member reaches the gated detail.
        expect(json).toContain('Open in myRSI');
    });

    it('a limiting marker on a clearance-0 op is enough', async () => {
        h.markerCount = 1;
        await create();
        expect(h.posted[0].input.restricted).toBe(true);
        expect(renderedJson(h.posted[0].input)).not.toContain('SECRET BRIEFING');
    });

    it('a clearance-0 Special Operation is enough', async () => {
        // Special ops are invite-only in-app (canUserSeeOpInList) and the realtime
        // authorization policy gates on is_special too, so their briefings leak
        // through the same door as markered ops.
        h.op = opRow({ is_special: true });
        await create();
        expect(h.posted[0].input.restricted).toBe(true);
        expect(renderedJson(h.posted[0].input)).not.toContain('SECRET BRIEFING');
    });

    it('FAIL-CLOSED: a marker-probe error restricts rather than unrestricting', async () => {
        // supabase-js RESOLVES { count: null, error } instead of throwing, so an
        // unread error would collapse a markered op to "no markers" and publish its
        // briefing exactly when the DB blips.
        h.markerError = { message: 'boom' };
        h.markerCount = null;
        await create();
        expect(h.posted[0].input.restricted).toBe(true);
        expect(renderedJson(h.posted[0].input)).not.toContain('SECRET BRIEFING');
    });

    it('is not a blanket gag: an unrestricted op still posts the full embed', async () => {
        await create();
        expect(h.posted[0].input.restricted).toBe(false);
        const json = renderedJson(h.posted[0].input);
        expect(json).toContain('SECRET BRIEFING');
        expect(json).toContain('Hidden Staging Point Delta');
        expect(json).toContain('Ghost Squadron');
    });
});

describe('announcement embed — edits re-render through the same gate', () => {
    const announced = (over: Record<string, unknown> = {}) => opRow({
        discord_announcement_channel_id: CHANNEL,
        discord_announcement_message_id: 'msg-1',
        ...over,
    });

    it('an edited briefing on a restricted op never reaches the channel', async () => {
        h.op = announced({ clearance_level: 7 });
        await operationActions['operation:update']({ operationId: 'op-1', updates: { description: BRIEFING }, userId: 1 });
        expect(h.edited).toHaveLength(1);
        const json = renderedJson(h.edited[0].input);
        expect(json).not.toContain('SECRET BRIEFING');
        expect(json).not.toContain('Hidden Staging Point Delta');
    });

    it('attaching a limiting marker re-renders the already-published embed', async () => {
        // markerIds is a supported edit that RESTRICTS an announced op. Without it in
        // the `touched` list the full briefing simply stays published — the whole
        // gate bypassed by a one-field edit.
        h.op = announced();
        h.markerCount = 1;
        await operationActions['operation:update']({ operationId: 'op-1', updates: { markerIds: [7] }, userId: 1 });
        expect(h.edited).toHaveLength(1);
        expect(h.edited[0].input.restricted).toBe(true);
        expect(renderedJson(h.edited[0].input)).not.toContain('SECRET BRIEFING');
    });

    it('flipping an announced op to Special re-renders it too', async () => {
        h.op = announced({ is_special: true });
        await operationActions['operation:update']({ operationId: 'op-1', updates: { isSpecial: true }, userId: 1 });
        expect(h.edited).toHaveLength(1);
        expect(h.edited[0].input.restricted).toBe(true);
        expect(renderedJson(h.edited[0].input)).not.toContain('SECRET BRIEFING');
    });
});

describe('guild scheduled event — the wider, guild-wide egress', () => {
    it('a restricted op creates the event with NO description', async () => {
        h.op = opRow({ clearance_level: 5 });
        await create({ createDiscordEvent: true, postDiscordAnnouncement: false });
        expect(h.events).toHaveLength(1);
        expect(h.events[0].kind).toBe('create');
        expect(h.events[0].options.description).toBeUndefined();
        expect(JSON.stringify(h.events[0].options)).not.toContain('SECRET BRIEFING');
    });

    it('an unrestricted op still gets its briefing on the event', async () => {
        await create({ createDiscordEvent: true, postDiscordAnnouncement: false });
        expect(h.events[0].options.description).toBe(BRIEFING);
    });

    it('CLEARS the published event description when an edit restricts the op', async () => {
        // Sent unconditionally when restricted, not only when `description` was
        // edited — otherwise a marker-only edit restricts the op while leaving the
        // previously-published briefing sitting on a guild-wide event.
        h.op = opRow({ discord_event_id: 'ev-1' });
        h.markerCount = 1;
        await operationActions['operation:update']({ operationId: 'op-1', updates: { markerIds: [7] }, userId: 1 });
        const update = h.events.find(e => e.kind === 'update');
        expect(update).toBeDefined();
        expect(update!.options.description).toBe('');
    });

    it('a restricted op editing its briefing does not mirror it into the event', async () => {
        h.op = opRow({ discord_event_id: 'ev-1', clearance_level: 5 });
        await operationActions['operation:update']({ operationId: 'op-1', updates: { description: BRIEFING }, userId: 1 });
        const update = h.events.find(e => e.kind === 'update');
        expect(update!.options.description).toBe('');
        expect(JSON.stringify(update!.options)).not.toContain('SECRET BRIEFING');
    });

    it('an unrestricted op still mirrors an edited briefing', async () => {
        h.op = opRow({ discord_event_id: 'ev-1' });
        await operationActions['operation:update']({ operationId: 'op-1', updates: { description: BRIEFING }, userId: 1 });
        const update = h.events.find(e => e.kind === 'update');
        expect(update!.options.description).toBe(BRIEFING);
    });
});

describe('buildOperationAnnouncementEmbed variant', () => {
    // The restricted leg is a branch INSIDE this builder rather than a second
    // builder precisely so a later "starting soon" notice reuses it verbatim.
    it('renders the restricted starting-soon title', () => {
        const embed = buildOperationAnnouncementEmbed({ name: 'X', restricted: true, variant: 'starting' });
        expect(embed.title).toBe('⏱️ RESTRICTED OPERATION STARTING SOON: X');
        expect(embed.description).toBe('A restricted operation was posted. Open the dashboard to view.');
    });

    it('renders the unrestricted starting-soon title', () => {
        const embed = buildOperationAnnouncementEmbed({ name: 'X', description: BRIEFING, restricted: false, variant: 'starting' });
        expect(embed.title).toBe('⏱️ STARTING SOON: X');
        expect(embed.description).toBe(BRIEFING);
    });

    it('defaults to the announce variant', () => {
        expect(buildOperationAnnouncementEmbed({ name: 'X', restricted: true }).title).toBe('🛰️ RESTRICTED OPERATION: X');
        expect(buildOperationAnnouncementEmbed({ name: 'X' }).title).toBe('🛰️ OPERATION: X');
    });
});
