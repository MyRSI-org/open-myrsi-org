import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// api/actions/operations.ts — handler-level behaviour.
//
// Every db-layer function is a recording spy (the db layer has its own suites:
// tests/cov-db-ops-*.test.ts); what is under test here is what each HANDLER does with
// its payload: which gate it calls (and with which participation term), the exact db
// function + arguments it forwards, the order (gate → write → broadcast), what it
// broadcasts (operation ids only — the board delta is the one documented exception,
// tests/opBoardDeltaException.test.ts), the Discord mirroring paths, and how failures
// map onto the result or the thrown error. Style precedent:
// tests/opParticipationConsistency.test.ts (which pins the READ/ACT split statically).
//
// Kept REAL: lib/clearance (get_details' gate), the shared participation term
// hasOpReadParticipation, normaliseDiscordSnowflake (the channel/role id check) and
// toOperationBoardElement (the board add projection).

vi.mock('../lib/db/common', async () => (await import('./cov-db-ops-fake')).commonMock);
vi.mock('../lib/log', async () => (await import('./cov-db-ops-fake')).logMock);
vi.mock('../lib/db/operations-federation', async () => (await import('./cov-db-ops-fake')).fed);
vi.mock('../lib/push', async () => ({ sendPushToUsers: (await import('./cov-db-ops-fake')).collab.sendPushToUsers }));
vi.mock('../lib/db/users', async () => {
    const f = await import('./cov-db-ops-fake');
    return { getUserById: f.collab.getUserById, getActorLabel: f.collab.getActorLabel };
});
vi.mock('../lib/db/notifications', async () => ({ createNotification: (await import('./cov-db-ops-fake')).collab.createNotification }));
vi.mock('../lib/db/securityEvents', async () => ({ recordSecurityEvent: (await import('./cov-db-ops-fake')).collab.recordSecurityEvent }));

const h = vi.hoisted(() => {
    const DB = [
        'createOperation', 'createOperationReminders', 'getOrgTenantUrl', 'operationIsRestricted', 'getFullOperationDetails',
        'deleteOperation', 'updateOperationDetails', 'updateOperationStatus', 'assertOpVisibleToUser', 'joinOperation',
        'leaveOperation', 'notifyOperationRemoval', 'addOperationParticipant', 'addOperationUec', 'addOperationCost',
        'setOperationPayoutMode', 'setOperationPayoutSplits', 'toggleParticipantPayoutPaid', 'logOperationEntry',
        'broadcastOpChange', 'toggleParticipantReady', 'updateParticipantLiveStatus', 'resetOperationReadiness',
        'updateOperationParticipant', 'rsvpOperation', 'getUserShipsByUserIds', 'updateLiveStatus', 'verifyOperationAccess',
        'addOperationPhase', 'updateOperationPhase', 'deleteOperationPhase', 'addScheduleEntry', 'updateScheduleEntry',
        'deleteScheduleEntry', 'addOperationTask', 'notifyOperationAssignee', 'updateOperationTask', 'deleteOperationTask',
        'addCommandNode', 'updateCommandNode', 'deleteCommandNode', 'addShipSlot', 'updateShipSlot', 'deleteShipSlot',
        'assignSlot', 'decideSlotApplication', 'removeSlotAssignment', 'applyForSlot', 'addBoardElement', 'broadcastBoardAdd',
        'updateBoardElement', 'broadcastBoardUpdate', 'deleteBoardElement', 'broadcastBoardDelete', 'saveBoardLayout',
        'addLogisticsItem', 'updateLogisticsItem', 'deleteLogisticsItem', 'fulfillLogisticsItem', 'broadcastOperationAlert',
        'getLatestOperationAlert', 'addAAREntry', 'deleteAAREntry', 'submitAAR', 'getOperationOwnerId', 'getSystemRoles',
        'getUserById', 'reopenAAR', 'generateAARDraftForOperation', 'listOperationTemplates', 'getOperationTemplate',
        'getOperationClassification', 'createOperationTemplate', 'broadcastToOrg', 'updateOperationTemplate',
        'deleteOperationTemplate', 'extractTemplatePayloadFromOperation',
    ];
    const DISCORD = [
        'createGuildScheduledEvent', 'deleteGuildScheduledEvent', 'updateGuildScheduledEvent', 'listGuildChannels',
        'postOperationAnnouncementEmbed', 'editOperationAnnouncementEmbed', 'deleteDiscordChannelMessage',
    ];
    const db: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const n of DB) db[n] = vi.fn();
    const discord: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const n of DISCORD) discord[n] = vi.fn();
    return {
        DB, DISCORD, db, discord,
        buildAnnouncementEmbedInput: vi.fn(),
        assertAiRateLimit: vi.fn(),
        /** Every spy call, in order, as 'db.<fn>' / 'discord.<fn>' / 'embed' / 'ai'. */
        trail: [] as string[],
        /** Per-test behaviour, keyed like the trail. Absent → resolves undefined. */
        impl: {} as Record<string, (...a: unknown[]) => unknown>,
    };
});

vi.mock('../lib/db', async () => {
    const f = await import('./cov-db-ops-fake');
    const ops = await import('../lib/db/ops');
    return { ...h.db, supabase: f.supabaseFake, hasOpReadParticipation: ops.hasOpReadParticipation };
});
vi.mock('../lib/discord', () => h.discord);
vi.mock('../lib/db/opAnnouncement', () => ({ buildAnnouncementEmbedInput: h.buildAnnouncementEmbedInput }));
vi.mock('../lib/aiRateLimit', () => ({ assertAiRateLimit: h.assertAiRateLimit }));

import { fake, resetFake, on, route, writesOn, readsOn, cols, eqs, payload, has } from './cov-db-ops-fake';
import { operationActions } from '../api/actions/operations';

const OP = '7f3e2d1c-0b9a-4876-9543-210fedcba987';
const MEMBER = { id: 6, permissions: ['operations:view'], clearanceLevel: { level: 0 }, limitingMarkers: [] as unknown[] };
const MANAGER = { id: 20, permissions: ['operations:manage'], clearanceLevel: { level: 0 }, limitingMarkers: [] as unknown[] };
const INPUT = { name: 'Embed input' };
const CHANNEL = '123456789012345678';
const OTHER_CHANNEL = '876543210987654321';
const ROLE = '223456789012345678';

type Handler = (p: Record<string, unknown>) => Promise<unknown>;
const act = (action: string, p: Record<string, unknown>) => (operationActions as unknown as Record<string, Handler>)[action](p);
const db = h.db;
const discord = h.discord;

function arm(key: string, spy: ReturnType<typeof vi.fn>) {
    spy.mockReset();
    spy.mockImplementation(async (...a: unknown[]) => {
        h.trail.push(key);
        const f = h.impl[key];
        return f ? f(...a) : undefined;
    });
}

beforeEach(() => {
    resetFake();
    h.trail.length = 0;
    for (const k of Object.keys(h.impl)) delete h.impl[k];
    for (const n of h.DB) arm(`db.${n}`, db[n]);
    for (const n of h.DISCORD) arm(`discord.${n}`, discord[n]);
    arm('embed', h.buildAnnouncementEmbedInput);
    // Synchronous, exactly like the real limiter: it THROWS to refuse.
    h.assertAiRateLimit.mockReset();
    h.assertAiRateLimit.mockImplementation((...a: unknown[]) => { h.trail.push('ai'); const f = h.impl.ai; if (f) f(...a); });
    h.impl['db.getSystemRoles'] = () => ({});
});

/** Every operation_update fan-out must be an id-only call. */
function expectOpChange(times = 1) {
    expect(db.broadcastOpChange.mock.calls).toEqual(Array(times).fill([OP]));
}

const refuse = (msg: string) => () => { throw new Error(msg); };

// ─────────────────────────────────────────────────────────────────────────────
describe('operation:create', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        h.impl['db.createOperation'] = () => ({ id: OP, name: 'Op' });
        h.impl['db.getOrgTenantUrl'] = () => 'https://org.example';
    });
    afterEach(() => { vi.useRealTimers(); });

    it('creates the op and nothing else when no schedule or Discord surface is asked for', async () => {
        const opData = { name: 'Op', userId: 6 };
        expect(await act('operation:create', opData)).toEqual({ id: OP, name: 'Op' });
        expect(db.createOperation).toHaveBeenCalledWith(opData);
        expect(h.trail).toEqual(['db.createOperation']);
        expect(fake.queries).toEqual([]);
    });

    it('a scheduled op gets its reminders; a failing create propagates before anything else runs', async () => {
        await act('operation:create', { name: 'Op', scheduledStart: '2026-06-02T18:00:00.000Z' });
        expect(db.createOperationReminders).toHaveBeenCalledWith(OP, '2026-06-02T18:00:00.000Z');
        expect(discord.createGuildScheduledEvent).not.toHaveBeenCalled();

        h.trail.length = 0;
        h.impl['db.createOperation'] = refuse('Cannot create operation: Missing Owner ID');
        await expect(act('operation:create', { name: 'Op', scheduledStart: 's', createDiscordEvent: true, scheduledEnd: 'e', postDiscordAnnouncement: true, discordAnnouncementChannelId: CHANNEL }))
            .rejects.toThrow('Cannot create operation: Missing Owner ID');
        expect(h.trail).toEqual(['db.createOperation']);
    });

    it('a result without an id skips reminders, the event and the announcement', async () => {
        h.impl['db.createOperation'] = () => ({ name: 'no id' });
        await act('operation:create', {
            name: 'Op', scheduledStart: '2026-06-02T18:00:00Z', scheduledEnd: '2026-06-02T19:00:00Z', createDiscordEvent: true,
            postDiscordAnnouncement: true, discordAnnouncementChannelId: CHANNEL,
        });
        expect(h.trail).toEqual(['db.createOperation']);
    });

    it('Discord event: a future window passes through; an unrestricted op keeps its description; the event id is persisted', async () => {
        h.impl['db.operationIsRestricted'] = () => false;
        h.impl['discord.createGuildScheduledEvent'] = () => ({ eventId: 'ev-1' });
        const out = await act('operation:create', {
            name: 'Op', description: 'Briefing', createDiscordEvent: true,
            scheduledStart: '2026-06-02T18:00:00.000Z', scheduledEnd: '2026-06-02T20:00:00.000Z',
        }) as Record<string, unknown>;
        expect(db.operationIsRestricted).toHaveBeenCalledWith(OP);
        expect(discord.createGuildScheduledEvent).toHaveBeenCalledWith({
            name: 'Op', description: 'Briefing', scheduledStart: '2026-06-02T18:00:00.000Z', scheduledEnd: '2026-06-02T20:00:00.000Z',
            locationUrl: 'https://org.example',
        });
        const w = writesOn('operations', 'update');
        expect(w).toHaveLength(1);
        expect(payload(w[0])).toEqual({ discord_event_id: 'ev-1' });
        expect(eqs(w[0])).toEqual([['id', OP]]);
        expect(out).toEqual({ id: OP, name: 'Op', discordEventId: 'ev-1' });
    });

    it('EGRESS GATE: a restricted op\'s GUILD_ONLY event carries no description', async () => {
        h.impl['db.operationIsRestricted'] = () => true;
        h.impl['discord.createGuildScheduledEvent'] = () => ({ eventId: 'ev-1' });
        await act('operation:create', {
            name: 'Op', description: 'SECRET briefing', createDiscordEvent: true,
            scheduledStart: '2026-06-02T18:00:00.000Z', scheduledEnd: '2026-06-02T20:00:00.000Z',
        });
        expect(discord.createGuildScheduledEvent.mock.calls[0][0]).toMatchObject({ name: 'Op', description: undefined });
        expect(JSON.stringify(discord.createGuildScheduledEvent.mock.calls)).not.toContain('SECRET');
    });

    it.each([
        ['a start in the past is clamped to now + 60s; a later end is kept', '2026-06-01T11:00:00Z', '2026-06-01T13:00:00Z', '2026-06-01T12:01:00.000Z', '2026-06-01T13:00:00.000Z'],
        ['an end at/before the clamped start is pushed 15 minutes past it', '2026-06-01T12:00:30Z', '2026-06-01T12:00:45Z', '2026-06-01T12:01:00.000Z', '2026-06-01T12:16:00.000Z'],
        ['unparseable times fall back to the same clamps', 'not-a-date', 'also-not', '2026-06-01T12:01:00.000Z', '2026-06-01T12:16:00.000Z'],
    ])('Discord event window: %s', async (_label, start, end, wantStart, wantEnd) => {
        h.impl['discord.createGuildScheduledEvent'] = () => ({ eventId: 'ev-1' });
        await act('operation:create', { name: 'Op', createDiscordEvent: true, scheduledStart: start, scheduledEnd: end });
        expect(discord.createGuildScheduledEvent.mock.calls[0][0]).toMatchObject({ scheduledStart: wantStart, scheduledEnd: wantEnd });
    });

    it('an event Discord refuses is reported on the result and nothing is persisted', async () => {
        h.impl['discord.createGuildScheduledEvent'] = () => ({ error: 'Missing Permissions' });
        const out = await act('operation:create', { name: 'Op', createDiscordEvent: true, scheduledStart: '2026-06-02T18:00:00Z', scheduledEnd: '2026-06-02T19:00:00Z' }) as Record<string, unknown>;
        expect(out.discordEventFailed).toBe('Missing Permissions');
        expect(out).not.toHaveProperty('discordEventId');
        expect(writesOn('operations')).toHaveLength(0);

        h.impl['discord.createGuildScheduledEvent'] = () => ({});
        const out2 = await act('operation:create', { name: 'Op', createDiscordEvent: true, scheduledStart: '2026-06-02T18:00:00Z', scheduledEnd: '2026-06-02T19:00:00Z' }) as Record<string, unknown>;
        expect(out2.discordEventFailed).toBe('Unknown error creating Discord event.');
    });

    it('createDiscordEvent without an end (or a start) creates no event', async () => {
        await act('operation:create', { name: 'Op', createDiscordEvent: true, scheduledStart: '2026-06-02T18:00:00Z' });
        await act('operation:create', { name: 'Op', createDiscordEvent: true, scheduledEnd: '2026-06-02T18:00:00Z' });
        expect(discord.createGuildScheduledEvent).not.toHaveBeenCalled();
    });

    it('announcement: posts to the NORMALISED channel with the SERVER-side ping role (never a payload one) and persists the message id', async () => {
        on('settings', { data: { value: { operationAnnouncePingRoleId: ROLE } } });
        h.impl.embed = () => INPUT;
        h.impl['discord.postOperationAnnouncementEmbed'] = () => ({ messageId: 'msg-1' });
        const out = await act('operation:create', {
            name: 'Op', postDiscordAnnouncement: true, discordAnnouncementChannelId: ` ${CHANNEL} `, pingRoleId: '999999999999999999',
        }) as Record<string, unknown>;
        expect(h.buildAnnouncementEmbedInput).toHaveBeenCalledWith(OP);
        expect(discord.postOperationAnnouncementEmbed).toHaveBeenCalledWith(CHANNEL, INPUT, { pingRoleId: ROLE });
        const s = readsOn('settings')[0];
        expect(cols(s)).toBe('value');
        expect(eqs(s)).toEqual([['key', 'discordConfig']]);
        expect(has(s, 'maybeSingle')).toBe(true);
        const w = writesOn('operations', 'update');
        expect(payload(w[0])).toEqual({ discord_announcement_message_id: 'msg-1' });
        expect(eqs(w[0])).toEqual([['id', OP]]);
        expect(out.discordAnnouncementMessageId).toBe('msg-1');
    });

    it.each([
        ['no discordConfig row', () => ({ data: null })],
        ['a configured value that is not a snowflake', () => ({ data: { value: { operationAnnouncePingRoleId: '@everyone' } } })],
        ['a settings read that throws', () => { throw new Error('db down'); }],
    ])('the ping role soft-fails to NULL (%s) — the announcement still posts', async (_label, responder) => {
        route('settings', responder as never);
        h.impl.embed = () => INPUT;
        h.impl['discord.postOperationAnnouncementEmbed'] = () => ({ messageId: 'msg-1' });
        const out = await act('operation:create', { name: 'Op', postDiscordAnnouncement: true, discordAnnouncementChannelId: CHANNEL }) as Record<string, unknown>;
        expect(discord.postOperationAnnouncementEmbed).toHaveBeenCalledWith(CHANNEL, INPUT, { pingRoleId: null });
        expect(out.discordAnnouncementMessageId).toBe('msg-1');
    });

    it('announcement failures land on the result: no embed input, and a post with no message id', async () => {
        h.impl.embed = () => null;
        const out = await act('operation:create', { name: 'Op', postDiscordAnnouncement: true, discordAnnouncementChannelId: CHANNEL }) as Record<string, unknown>;
        expect(out.discordAnnouncementFailed).toBe('Could not load operation details for announcement.');
        expect(discord.postOperationAnnouncementEmbed).not.toHaveBeenCalled();

        h.impl.embed = () => INPUT;
        h.impl['discord.postOperationAnnouncementEmbed'] = () => ({ error: 'Unknown Channel' });
        const out2 = await act('operation:create', { name: 'Op', postDiscordAnnouncement: true, discordAnnouncementChannelId: CHANNEL }) as Record<string, unknown>;
        expect(out2.discordAnnouncementFailed).toBe('Unknown Channel');

        h.impl['discord.postOperationAnnouncementEmbed'] = () => ({});
        const out3 = await act('operation:create', { name: 'Op', postDiscordAnnouncement: true, discordAnnouncementChannelId: CHANNEL }) as Record<string, unknown>;
        expect(out3.discordAnnouncementFailed).toBe('Unknown error posting Discord announcement.');
        expect(writesOn('operations')).toHaveLength(0);
    });

    it('a junk channel id is refused before the bot posts: caught, logged, reported — no ping-role read, no write', async () => {
        h.impl.embed = () => INPUT;
        const out = await act('operation:create', { name: 'Op', postDiscordAnnouncement: true, discordAnnouncementChannelId: 'general' }) as Record<string, unknown>;
        expect(out.discordAnnouncementFailed).toBe('Invalid Discord ID for discordAnnouncementChannelId. Must be a 17-19 digit numeric ID (or empty to clear).');
        expect(discord.postOperationAnnouncementEmbed).not.toHaveBeenCalled();
        expect(readsOn('settings')).toHaveLength(0);
        expect(writesOn('operations')).toHaveLength(0);
        const err = fake.logs.find((l) => l.level === 'error' && l.msg === 'discord announcement post failed');
        expect(err?.fields).toMatchObject({ module: 'actions.operations', action: 'operation:create' });
    });

    it('a whitespace-only channel id reaches the sink as "" (lib/discord refuses it) and the refusal is reported', async () => {
        h.impl.embed = () => INPUT;
        h.impl['discord.postOperationAnnouncementEmbed'] = (channel) => (channel === '' ? { error: 'Invalid channel id.' } : { messageId: 'never' });
        const out = await act('operation:create', { name: 'Op', postDiscordAnnouncement: true, discordAnnouncementChannelId: '   ' }) as Record<string, unknown>;
        expect(discord.postOperationAnnouncementEmbed).toHaveBeenCalledWith('', INPUT, { pingRoleId: null });
        expect(out.discordAnnouncementFailed).toBe('Invalid channel id.');
        expect(writesOn('operations')).toHaveLength(0);
    });

    it('a non-Error throw maps to the generic message; postDiscordAnnouncement without a channel does nothing', async () => {
        h.impl.embed = () => { throw 'boom'; };
        const out = await act('operation:create', { name: 'Op', postDiscordAnnouncement: true, discordAnnouncementChannelId: CHANNEL }) as Record<string, unknown>;
        expect(out.discordAnnouncementFailed).toBe('Unknown error posting Discord announcement.');

        h.buildAnnouncementEmbedInput.mockClear();
        await act('operation:create', { name: 'Op', postDiscordAnnouncement: true });
        expect(h.buildAnnouncementEmbedInput).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('operation:get_details — clearance, special-op participation, PIN and seat-application redaction', () => {
    const detail = (over: Record<string, unknown> = {}) => ({
        id: OP, ownerId: 5, clearanceLevel: 0, limitingMarkers: [], isSpecial: false, joinCode: 'PIN-123456',
        participants: [] as Array<{ userId: number; timeLeft: string | null }>, shipSlots: [] as unknown[], ...over,
    });
    const get = (user: unknown) => act('operation:get_details', { operationId: OP, user });

    it('a missing op is passed through as-is (the read path renders not-found)', async () => {
        h.impl['db.getFullOperationDetails'] = () => null;
        expect(await get(MEMBER)).toBeNull();
        expect(db.getFullOperationDetails).toHaveBeenCalledWith(OP);
    });

    it('below the op level, or missing one of its markers, is refused', async () => {
        h.impl['db.getFullOperationDetails'] = () => detail({ clearanceLevel: 2 });
        await expect(get(MEMBER)).rejects.toThrow('Insufficient clearance to view this operation.');
        h.impl['db.getFullOperationDetails'] = () => detail({ limitingMarkers: [{ id: 3, code: 'K' }] });
        await expect(get(MEMBER)).rejects.toThrow('Insufficient clearance to view this operation.');
        await expect(get({ ...MEMBER, limitingMarkers: [{ id: 3, code: 'K' }] })).resolves.toMatchObject({ id: OP });
    });

    it('the owner and operations:manage bypass clearance and keep the join PIN; everyone else loses it', async () => {
        h.impl['db.getFullOperationDetails'] = () => detail({ clearanceLevel: 4 });
        expect(await get({ ...MEMBER, id: 5 })).toMatchObject({ joinCode: 'PIN-123456' });
        expect(await get(MANAGER)).toMatchObject({ joinCode: 'PIN-123456' });
        h.impl['db.getFullOperationDetails'] = () => detail();
        const seen = await get(MEMBER) as Record<string, unknown>;
        expect(seen.joinCode).toBeUndefined();
    });

    it('a special op opens only to the owner, managers and participants (current OR former)', async () => {
        h.impl['db.getFullOperationDetails'] = () => detail({ isSpecial: true, participants: [{ userId: 7, timeLeft: '2026-10-01T00:00:00Z' }] });
        await expect(get(MEMBER)).rejects.toThrow('Insufficient access to view this special operation.');
        await expect(get({ ...MEMBER, id: 7 })).resolves.toMatchObject({ id: OP, joinCode: undefined });
        await expect(get({ ...MEMBER, id: 5 })).resolves.toMatchObject({ id: OP });
        await expect(get(MANAGER)).resolves.toMatchObject({ id: OP });
        // No viewer id never matches a roster row.
        await expect(get({ ...MEMBER, id: undefined })).rejects.toThrow('Insufficient access to view this special operation.');
    });

    it('other members\' seat applications are hidden from non-managers; their own and assigned seats remain', async () => {
        const slots = () => [
            { id: 1, assignments: [{ userId: 6, status: 'applied' }, { userId: 8, status: 'applied' }, { userId: 9, status: 'assigned' }] },
            { id: 2 },
        ];
        h.impl['db.getFullOperationDetails'] = () => detail({ shipSlots: slots() });
        const seen = await get(MEMBER) as { shipSlots: Array<{ id: number; assignments: unknown[] }> };
        expect(seen.shipSlots).toEqual([
            { id: 1, assignments: [{ userId: 6, status: 'applied' }, { userId: 9, status: 'assigned' }] },
            { id: 2, assignments: [] },
        ]);
        const managed = await get(MANAGER) as { shipSlots: unknown[] };
        expect(managed.shipSlots).toEqual(slots());
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('operation:delete — Discord cleanup first, then the delete', () => {
    it('removes the linked event and announcement before deleting the op', async () => {
        on('operations', { data: { discord_event_id: 'ev-1', discord_announcement_channel_id: CHANNEL, discord_announcement_message_id: 'msg-1' } });
        await act('operation:delete', { operationId: OP, userId: 20 });
        const r = readsOn('operations')[0];
        expect(cols(r)).toBe('discord_event_id, discord_announcement_channel_id, discord_announcement_message_id');
        expect(eqs(r)).toEqual([['id', OP]]);
        expect(has(r, 'single')).toBe(true);
        expect(discord.deleteGuildScheduledEvent).toHaveBeenCalledWith('ev-1');
        expect(discord.deleteDiscordChannelMessage).toHaveBeenCalledWith(CHANNEL, 'msg-1');
        expect(db.deleteOperation).toHaveBeenCalledWith(OP, 20);
        expect(h.trail).toEqual(['discord.deleteGuildScheduledEvent', 'discord.deleteDiscordChannelMessage', 'db.deleteOperation']);
    });

    it('no links (or a channel without a message) means no Discord calls; the delete result is returned', async () => {
        h.impl['db.deleteOperation'] = () => ({ ok: true });
        on('operations', { data: { discord_event_id: null, discord_announcement_channel_id: CHANNEL, discord_announcement_message_id: null } });
        expect(await act('operation:delete', { operationId: OP, userId: 20 })).toEqual({ ok: true });
        on('operations', { data: null });
        await act('operation:delete', { operationId: OP, userId: 20 });
        expect(h.trail).toEqual(['db.deleteOperation', 'db.deleteOperation']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('operation:update — the edit, then the Discord mirror', () => {
    const linked = (over: Record<string, unknown> = {}) => ({
        data: {
            discord_event_id: 'ev-1', discord_announcement_channel_id: null, discord_announcement_message_id: null,
            name: 'DB name', description: 'DB description', scheduled_start: '2026-07-01T18:00:00Z', scheduled_end: '2026-07-01T20:00:00Z', ...over,
        },
    });
    const update = (updates: Record<string, unknown>) => act('operation:update', { operationId: OP, updates, userId: 20, user: MANAGER });

    it('forwards the actor for the clearance clamp; an edit touching no mirrored field reads nothing from Discord', async () => {
        const out = await update({ roe: 'weapons free' });
        expect(db.updateOperationDetails).toHaveBeenCalledWith(OP, { roe: 'weapons free' }, 20, MANAGER);
        expect(fake.queries).toEqual([]);
        expect(out).toEqual({});
    });

    it('mirrors the CURRENT DB values of exactly the touched fields onto the event', async () => {
        on('operations', linked());
        h.impl['db.operationIsRestricted'] = () => false;
        h.impl['discord.updateGuildScheduledEvent'] = () => ({ ok: true });
        await update({ name: 'typed', description: 'typed', scheduledStart: 'x', scheduledEnd: 'y' });
        const r = readsOn('operations')[0];
        expect(cols(r)).toBe('discord_event_id, discord_announcement_channel_id, discord_announcement_message_id, name, description, scheduled_start, scheduled_end');
        expect(eqs(r)).toEqual([['id', OP]]);
        expect(discord.updateGuildScheduledEvent).toHaveBeenCalledWith('ev-1', {
            name: 'DB name', description: 'DB description', scheduledStart: '2026-07-01T18:00:00Z', scheduledEnd: '2026-07-01T20:00:00Z',
        });

        on('operations', linked({ scheduled_start: null, scheduled_end: null }));
        await update({ type: 'Combat', scheduledStart: '', scheduledEnd: '' });
        expect(discord.updateGuildScheduledEvent).toHaveBeenLastCalledWith('ev-1', {});
    });

    it.each([['markerIds', { markerIds: [3] }], ['isSpecial', { isSpecial: true }], ['clearanceLevel', { clearanceLevel: 2 }]])(
        'EGRESS GATE: restricting the op via %s blanks the event description even though description was not edited', async (_k, updates) => {
            on('operations', linked());
            h.impl['db.operationIsRestricted'] = () => true;
            h.impl['discord.updateGuildScheduledEvent'] = () => ({ ok: true });
            await update(updates);
            expect(db.operationIsRestricted).toHaveBeenCalledWith(OP);
            expect(discord.updateGuildScheduledEvent).toHaveBeenCalledWith('ev-1', { description: '' });
        });

    it('an event sync failure reaches the CALLER (updateOperationDetails resolves void)', async () => {
        on('operations', linked());
        h.impl['discord.updateGuildScheduledEvent'] = () => ({ ok: false, error: 'Unknown Guild Scheduled Event' });
        expect(await update({ name: 'n' })).toEqual({ discordEventFailed: 'Unknown Guild Scheduled Event' });

        on('operations', linked());
        h.impl['discord.updateGuildScheduledEvent'] = () => ({ ok: false });
        expect(await update({ name: 'n' })).toEqual({ discordEventFailed: 'Discord event update failed.' });
    });

    it('a db result object is kept and annotated rather than replaced', async () => {
        h.impl['db.updateOperationDetails'] = () => ({ id: OP });
        on('operations', linked());
        h.impl['discord.updateGuildScheduledEvent'] = () => ({ ok: false, error: 'e' });
        expect(await update({ name: 'n' })).toEqual({ id: OP, discordEventFailed: 'e' });
    });

    it('edits a linked announcement in place; a vanished message clears the stored id so a repost starts fresh', async () => {
        const ann = linked({ discord_event_id: null, discord_announcement_channel_id: CHANNEL, discord_announcement_message_id: 'msg-1' });
        h.impl.embed = () => INPUT;
        on('operations', ann);
        h.impl['discord.editOperationAnnouncementEmbed'] = () => ({ ok: true });
        expect(await update({ description: 'd' })).toEqual({});
        expect(discord.editOperationAnnouncementEmbed).toHaveBeenCalledWith(CHANNEL, 'msg-1', INPUT);
        expect(discord.updateGuildScheduledEvent).not.toHaveBeenCalled();
        expect(writesOn('operations')).toHaveLength(0);

        on('operations', ann);
        h.impl['discord.editOperationAnnouncementEmbed'] = () => ({ ok: false, error: 'Unknown Message', gone: true });
        expect(await update({ description: 'd' })).toEqual({ discordAnnouncementFailed: 'Unknown Message' });
        const w = writesOn('operations', 'update');
        expect(w).toHaveLength(1);
        expect(payload(w[0])).toEqual({ discord_announcement_message_id: null });
        expect(eqs(w[0])).toEqual([['id', OP]]);

        on('operations', ann);
        h.impl['discord.editOperationAnnouncementEmbed'] = () => ({ ok: false });
        expect(await update({ description: 'd' })).toEqual({ discordAnnouncementFailed: 'Discord announcement edit failed.' });
        expect(writesOn('operations', 'update')).toHaveLength(1);
    });

    it('no embed input means no edit; an edit that throws is logged and reported', async () => {
        const ann = linked({ discord_event_id: null, discord_announcement_channel_id: CHANNEL, discord_announcement_message_id: 'msg-1' });
        on('operations', ann);
        h.impl.embed = () => null;
        expect(await update({ name: 'n' })).toEqual({});
        expect(discord.editOperationAnnouncementEmbed).not.toHaveBeenCalled();

        on('operations', ann);
        h.impl.embed = () => { throw new Error('embed build failed'); };
        expect(await update({ name: 'n' })).toEqual({ discordAnnouncementFailed: 'embed build failed' });
        expect(fake.logs.find((l) => l.level === 'error' && l.msg === 'discord announcement edit failed')?.fields).toMatchObject({ action: 'operation:update' });

        on('operations', ann);
        h.impl.embed = () => { throw 42; };
        expect(await update({ name: 'n' })).toEqual({ discordAnnouncementFailed: 'Discord announcement edit failed.' });
    });

    it('a refused edit propagates and nothing is mirrored', async () => {
        h.impl['db.updateOperationDetails'] = refuse('You are not cleared to edit this operation.');
        await expect(update({ name: 'n' })).rejects.toThrow('You are not cleared to edit this operation.');
        expect(fake.queries).toEqual([]);
        expect(h.trail).toEqual(['db.updateOperationDetails']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('operation:repost_announcement', () => {
    const stored = (channel: string | null, message: string | null) => ({ data: { discord_announcement_channel_id: channel, discord_announcement_message_id: message } });
    const repost = (channelId?: unknown) => act('operation:repost_announcement', { operationId: OP, channelId });

    beforeEach(() => { h.impl.embed = () => INPUT; });

    it('refuses with no operation id, an unknown op, a junk channel, or no channel at all', async () => {
        await expect(act('operation:repost_announcement', { operationId: '' })).rejects.toThrow('operationId is required.');
        expect(fake.queries).toEqual([]);

        on('operations', { data: null });
        await expect(repost(CHANNEL)).rejects.toThrow('Operation not found or access denied.');
        const r = readsOn('operations')[0];
        expect(cols(r)).toBe('discord_announcement_channel_id, discord_announcement_message_id');
        expect(eqs(r)).toEqual([['id', OP]]);

        on('operations', stored(CHANNEL, 'msg-1'));
        await expect(repost('general')).rejects.toThrow('Invalid Discord ID for channelId.');

        on('operations', stored(null, null));
        await expect(repost('   ')).rejects.toThrow('No Discord channel selected for this announcement.');

        on('operations', stored(CHANNEL, null));
        h.impl.embed = () => null;
        await expect(repost()).rejects.toThrow('Could not load operation details for announcement.');
        expect(discord.postOperationAnnouncementEmbed).not.toHaveBeenCalled();
        expect(discord.editOperationAnnouncementEmbed).not.toHaveBeenCalled();
    });

    it('same channel with a stored message: edited in place, nothing posted or written', async () => {
        on('operations', stored(CHANNEL, 'msg-1'));
        h.impl['discord.editOperationAnnouncementEmbed'] = () => ({ ok: true });
        expect(await repost(CHANNEL)).toEqual({ ok: true, messageId: 'msg-1', channelId: CHANNEL, mode: 'edited' });
        expect(discord.editOperationAnnouncementEmbed).toHaveBeenCalledWith(CHANNEL, 'msg-1', INPUT);
        expect(discord.postOperationAnnouncementEmbed).not.toHaveBeenCalled();
        expect(writesOn('operations')).toHaveLength(0);
    });

    it('an edit that fails for any reason but "gone" is reported, not re-posted', async () => {
        on('operations', stored(CHANNEL, 'msg-1'));
        h.impl['discord.editOperationAnnouncementEmbed'] = () => ({ ok: false, error: 'Missing Access' });
        expect(await repost()).toEqual({ ok: false, error: 'Missing Access' });
        on('operations', stored(CHANNEL, 'msg-1'));
        h.impl['discord.editOperationAnnouncementEmbed'] = () => ({ ok: false });
        expect(await repost()).toEqual({ ok: false, error: 'Edit failed.' });
        expect(discord.postOperationAnnouncementEmbed).not.toHaveBeenCalled();
    });

    it('a vanished message falls through to a fresh post — WITHOUT a role ping — and persists the new id', async () => {
        on('operations', stored(CHANNEL, 'msg-1'));
        h.impl['discord.editOperationAnnouncementEmbed'] = () => ({ ok: false, gone: true });
        h.impl['discord.postOperationAnnouncementEmbed'] = () => ({ messageId: 'msg-2' });
        expect(await repost()).toEqual({ ok: true, messageId: 'msg-2', channelId: CHANNEL, mode: 'posted' });
        expect(discord.postOperationAnnouncementEmbed.mock.calls).toEqual([[CHANNEL, INPUT]]);
        expect(discord.deleteDiscordChannelMessage).not.toHaveBeenCalled();
        const w = writesOn('operations', 'update');
        expect(payload(w[0])).toEqual({ discord_announcement_channel_id: CHANNEL, discord_announcement_message_id: 'msg-2' });
        expect(eqs(w[0])).toEqual([['id', OP]]);
    });

    it('a changed channel deletes the old message first, then posts to the new one', async () => {
        on('operations', stored(CHANNEL, 'msg-1'));
        h.impl['discord.postOperationAnnouncementEmbed'] = () => ({ messageId: 'msg-3' });
        expect(await repost(` ${OTHER_CHANNEL} `)).toEqual({ ok: true, messageId: 'msg-3', channelId: OTHER_CHANNEL, mode: 'posted' });
        expect(discord.editOperationAnnouncementEmbed).not.toHaveBeenCalled();
        expect(h.trail).toEqual(['embed', 'discord.deleteDiscordChannelMessage', 'discord.postOperationAnnouncementEmbed']);
        expect(discord.deleteDiscordChannelMessage).toHaveBeenCalledWith(CHANNEL, 'msg-1');
        expect(payload(writesOn('operations', 'update')[0])).toEqual({ discord_announcement_channel_id: OTHER_CHANNEL, discord_announcement_message_id: 'msg-3' });
    });

    it('a first post goes to the chosen channel; a failed post persists nothing', async () => {
        on('operations', stored(null, null));
        h.impl['discord.postOperationAnnouncementEmbed'] = () => ({ messageId: 'msg-4' });
        expect(await repost(CHANNEL)).toEqual({ ok: true, messageId: 'msg-4', channelId: CHANNEL, mode: 'posted' });

        on('operations', stored(CHANNEL, null));
        h.impl['discord.postOperationAnnouncementEmbed'] = () => ({ error: 'Unknown Channel' });
        expect(await repost()).toEqual({ ok: false, error: 'Unknown Channel' });
        on('operations', stored(CHANNEL, null));
        h.impl['discord.postOperationAnnouncementEmbed'] = () => ({});
        expect(await repost()).toEqual({ ok: false, error: 'Post failed.' });
        expect(writesOn('operations', 'update')).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pass-through handlers forward exactly their arguments and return the db result', () => {
    const SPLITS = [{ userId: 6, percent: 100 }];
    it.each([
        ['operation:update_status', { operationId: OP, status: 'Active', userId: 20 }, 'updateOperationStatus', [OP, 'Active', 20]],
        ['operation:add_participant', { operationId: OP, targetUserId: 6, userId: 20 }, 'addOperationParticipant', [OP, 6, 20]],
        ['operation:add_uec', { operationId: OP, amount: 500, reason: 'loot', userId: 20 }, 'addOperationUec', [OP, 500, 'loot', 20]],
        ['operation:add_cost', { operationId: OP, amount: 50, category: 'fuel', description: 'd', userId: 20 }, 'addOperationCost', [OP, 50, 'fuel', 'd', 20]],
        ['operation:set_payout_mode', { operationId: OP, mode: 'split', userId: 20 }, 'setOperationPayoutMode', [OP, 'split', 20]],
        ['operation:set_payout_splits', { operationId: OP, splits: SPLITS, userId: 20 }, 'setOperationPayoutSplits', [OP, SPLITS, 20]],
        ['operation:toggle_payout_paid', { operationId: OP, targetUserId: 6, paid: true, userId: 20 }, 'toggleParticipantPayoutPaid', [OP, 6, true, 20]],
        ['operation:reset_readiness', { operationId: OP }, 'resetOperationReadiness', [OP]],
        ['operation:update_participant', { operationId: OP, targetUserId: 6, updates: { roleRequested: 'Pilot' } }, 'updateOperationParticipant', [OP, 6, { roleRequested: 'Pilot' }]],
        ['operation:update_live_status', { operationId: OP, liveStatus: 'Engaged', userId: 20 }, 'updateLiveStatus', [OP, 'Engaged', 20]],
        ['operation:template:list', { user: MEMBER }, 'listOperationTemplates', [MEMBER]],
        ['operation:template:get', { id: 3, user: MEMBER }, 'getOperationTemplate', [3, MEMBER]],
    ])('%s → %s', async (action, p, fn, args) => {
        h.impl[`db.${fn}`] = () => ({ ok: fn });
        expect(await act(action, p as Record<string, unknown>)).toEqual({ ok: fn });
        expect(db[fn].mock.calls).toEqual([args]);
        expect(h.trail).toEqual([`db.${fn}`]);
    });

    it('discord channel directories: the admin alias never forwards a cache bypass', async () => {
        h.impl['discord.listGuildChannels'] = () => [{ id: CHANNEL }];
        expect(await act('discord:list_channels_admin', { forceRefresh: true })).toEqual([{ id: CHANNEL }]);
        expect(await act('discord:list_guild_channels', { forceRefresh: 1 })).toEqual([{ id: CHANNEL }]);
        await act('discord:list_guild_channels', {});
        expect(discord.listGuildChannels.mock.calls).toEqual([[{}], [{ forceRefresh: true }], [{ forceRefresh: false }]]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Which handlers pass { access: 'read' } and which the strict default — behaviourally
// (tests/opParticipationConsistency.test.ts pins the same split statically). And the
// fail-closed half: when the gate refuses, the handler calls NOTHING after it.
describe('the per-op gate: participation term per handler, and nothing runs past a refusal', () => {
    const user = MEMBER;
    type Row = [action: string, p: Record<string, unknown>, opts: Record<string, unknown> | undefined];
    const GATED: Row[] = [
        ['operation:join', { operationId: OP, userId: 6, joinCode: 'PIN', user }, { isJoinAttempt: true }],
        ['operation:join_with_role', { operationId: OP, userId: 6, user }, { isJoinAttempt: true }],
        ['operation:get_participant_ships', { operationId: OP, userIds: [6], user }, { access: 'read' }],
        ['operation:get_latest_alert', { operationId: OP, user }, { access: 'read' }],
        ['operation:template:from_operation', { operationId: OP, user }, { access: 'read' }],
        ['operation:template:create', { name: 'T', payload: {}, userId: 6, sourceOperationId: OP, user }, { access: 'read' }],
        ['operation:leave', { operationId: OP, userId: 6, user }, undefined],
        ['operation:timeline_add', { operationId: OP, entry: 'e', userId: 6, user }, undefined],
        ['operation:toggle_ready', { operationId: OP, userId: 6, user }, undefined],
        ['operation:update_participant_live_status', { operationId: OP, userId: 6, liveStatus: 'x', user }, undefined],
        ['operation:rsvp', { operationId: OP, userId: 6, rsvpStatus: 'Going', user }, undefined],
        ['operation:assign_slot', { operationId: OP, slotId: 1, targetUserId: 7, userId: 6, user }, undefined],
        ['operation:decide_slot_application', { operationId: OP, slotId: 1, targetUserId: 7, decision: 'approve', userId: 6, user }, undefined],
        ['operation:remove_slot_assignment', { operationId: OP, slotId: 1, targetUserId: 7, user }, undefined],
        ['operation:apply_for_slot', { operationId: OP, slotId: 1, userId: 6, user }, undefined],
        ['operation:withdraw_slot', { operationId: OP, slotId: 1, userId: 6, user }, undefined],
        ['operation:add_logistics', { operationId: OP, data: {}, user }, undefined],
        ['operation:update_logistics', { operationId: OP, itemId: 1, data: {}, user }, undefined],
        ['operation:delete_logistics', { operationId: OP, itemId: 1, user }, undefined],
        ['operation:fulfill_logistics', { operationId: OP, itemId: 1, quantity: 1, userId: 6, user }, undefined],
        ['operation:add_aar_entry', { operationId: OP, data: {}, userId: 6, user }, { access: 'read' }],
        ['operation:delete_aar_entry', { operationId: OP, entryId: 1, user }, undefined],
    ];

    it.each(GATED)('%s calls the gate with the expected term', async (action, p, opts) => {
        h.impl['db.getFullOperationDetails'] = () => ({ participants: [] });
        h.impl['db.createOperationTemplate'] = () => ({ id: 1 });
        await act(action, p);
        expect(db.assertOpVisibleToUser.mock.calls).toEqual([opts ? [OP, user, opts] : [OP, user]]);
        expect(h.trail[0]).toBe('db.assertOpVisibleToUser');
    });

    it.each(GATED)('%s: a refused gate is the LAST thing that happens', async (action, p) => {
        h.impl['db.assertOpVisibleToUser'] = refuse('Insufficient clearance to act on this operation.');
        await expect(act(action, p)).rejects.toThrow('Insufficient clearance to act on this operation.');
        expect(h.trail).toEqual(['db.assertOpVisibleToUser']);
        expect(fake.queries).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('membership handlers', () => {
    it('join / join_with_role forward every field after the gate', async () => {
        h.impl['db.joinOperation'] = () => ({ joined: true });
        expect(await act('operation:join', { operationId: OP, userId: 6, joinCode: 'PIN', user: MEMBER })).toEqual({ joined: true });
        expect(db.joinOperation).toHaveBeenLastCalledWith(OP, 6, 'PIN');
        await act('operation:join_with_role', { operationId: OP, userId: 6, roleRequested: 'Pilot', shipUtilized: 'Gladius', joinCode: 'PIN', shipId: 4, userShipId: 9, user: MEMBER });
        expect(db.joinOperation).toHaveBeenLastCalledWith(OP, 6, 'PIN', 'Pilot', 'Gladius', 4, 9);
    });

    it('self-leave is gated and never notifies; the handler returns nothing (no membership oracle)', async () => {
        h.impl['db.leaveOperation'] = () => true;
        expect(await act('operation:leave', { operationId: OP, userId: 6, targetUserId: 6, user: MEMBER })).toBeUndefined();
        expect(h.trail).toEqual(['db.assertOpVisibleToUser', 'db.leaveOperation']);
        expect(db.leaveOperation).toHaveBeenCalledWith(OP, 6);
        expect(db.notifyOperationRemoval).not.toHaveBeenCalled();
    });

    it('removing someone else needs operations:manage — checked on the PERMISSION, before anything runs', async () => {
        await expect(act('operation:leave', { operationId: OP, userId: 6, targetUserId: 7, user: MEMBER }))
            .rejects.toThrow('Forbidden: removing other participants requires operations:manage.');
        await expect(act('operation:leave', { operationId: OP, userId: 6, targetUserId: 7, user: { role: 'Admin' } }))
            .rejects.toThrow('Forbidden: removing other participants requires operations:manage.');
        await expect(act('operation:leave', { operationId: OP, userId: 6, targetUserId: 7 }))
            .rejects.toThrow('Forbidden: removing other participants requires operations:manage.');
        expect(h.trail).toEqual([]);
    });

    it('a manager removal notifies the target only when a row was REALLY removed', async () => {
        h.impl['db.leaveOperation'] = () => true;
        expect(await act('operation:leave', { operationId: OP, userId: 20, targetUserId: 7, user: MANAGER })).toBeUndefined();
        expect(h.trail).toEqual(['db.leaveOperation', 'db.notifyOperationRemoval']);
        expect(db.leaveOperation).toHaveBeenCalledWith(OP, 7);
        expect(db.notifyOperationRemoval).toHaveBeenCalledWith(OP, 7, 20);

        h.trail.length = 0;
        h.impl['db.leaveOperation'] = () => false;
        await act('operation:leave', { operationId: OP, userId: 20, targetUserId: 7, user: MANAGER });
        expect(h.trail).toEqual(['db.leaveOperation']);
    });

    it('timeline_add logs a NOTE as the actor, then fans out the op id', async () => {
        await act('operation:timeline_add', { operationId: OP, entry: 'Contact north', userId: 6, user: MEMBER });
        expect(db.logOperationEntry).toHaveBeenCalledWith(OP, 'NOTE', 'Contact north', 6);
        expect(h.trail).toEqual(['db.assertOpVisibleToUser', 'db.logOperationEntry', 'db.broadcastOpChange']);
        expectOpChange();
    });

    it('readiness, live status and RSVP forward their arguments after the gate', async () => {
        h.impl['db.toggleParticipantReady'] = () => ({ ready: true });
        expect(await act('operation:toggle_ready', { operationId: OP, userId: 6, user: MEMBER })).toEqual({ ready: true });
        expect(db.toggleParticipantReady).toHaveBeenCalledWith(OP, 6);
        await act('operation:update_participant_live_status', { operationId: OP, userId: 6, liveStatus: 'Down', user: MEMBER });
        expect(db.updateParticipantLiveStatus).toHaveBeenCalledWith(OP, 6, 'Down');
        await act('operation:rsvp', { operationId: OP, userId: 6, rsvpStatus: 'Going', shipId: 4, userShipId: 9, user: MEMBER });
        expect(db.rsvpOperation).toHaveBeenCalledWith(OP, 6, 'Going', 4, 9);
        expect(h.trail.filter((t) => t === 'db.assertOpVisibleToUser')).toHaveLength(3);
    });

    it('get_participant_ships returns ships only for requested ids that ARE participants', async () => {
        h.impl['db.getFullOperationDetails'] = () => ({ participants: [{ userId: 6 }, { userId: 7 }] });
        h.impl['db.getUserShipsByUserIds'] = (ids) => ({ for: ids });
        expect(await act('operation:get_participant_ships', { operationId: OP, userIds: [7, 99, 6], user: MEMBER })).toEqual({ for: [7, 6] });
        expect(db.getUserShipsByUserIds).toHaveBeenLastCalledWith([7, 6]);
        await act('operation:get_participant_ships', { operationId: OP, user: MEMBER });
        expect(db.getUserShipsByUserIds).toHaveBeenLastCalledWith([]);
        h.impl['db.getFullOperationDetails'] = () => ({});
        await act('operation:get_participant_ships', { operationId: OP, userIds: [6], user: MEMBER });
        expect(db.getUserShipsByUserIds).toHaveBeenLastCalledWith([]);
    });

    it('get_participant_ships on an op that vanished after the gate is refused', async () => {
        h.impl['db.getFullOperationDetails'] = () => null;
        await expect(act('operation:get_participant_ships', { operationId: OP, userIds: [6], user: MEMBER })).rejects.toThrow('Operation not found');
        expect(db.getUserShipsByUserIds).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// operations:manage sub-resource CRUD: existence gate → db write → id-only fan-out.
describe('sub-resource CRUD (phases, schedule, tasks, command nodes, ship slots, logistics)', () => {
    type Crud = [action: string, p: Record<string, unknown>, fn: string, args: unknown[], gate: 'verify' | 'visible', returns: boolean];
    const D = { name: 'X' };
    const CRUD: Crud[] = [
        ['operation:add_phase', { operationId: OP, data: D }, 'addOperationPhase', [OP, D], 'verify', true],
        ['operation:delete_phase', { operationId: OP, phaseId: 3 }, 'deleteOperationPhase', [3, OP], 'verify', false],
        ['operation:add_schedule_entry', { operationId: OP, data: D }, 'addScheduleEntry', [OP, D], 'verify', true],
        ['operation:update_schedule_entry', { operationId: OP, entryId: 3, data: D }, 'updateScheduleEntry', [3, D, OP], 'verify', false],
        ['operation:delete_schedule_entry', { operationId: OP, entryId: 3 }, 'deleteScheduleEntry', [3, OP], 'verify', false],
        ['operation:update_task', { operationId: OP, taskId: 3, data: D }, 'updateOperationTask', [3, D, OP], 'verify', false],
        ['operation:delete_task', { operationId: OP, taskId: 3 }, 'deleteOperationTask', [3, OP], 'verify', false],
        ['operation:update_command_node', { operationId: OP, nodeId: 3, data: D }, 'updateCommandNode', [3, D, OP], 'verify', false],
        ['operation:delete_command_node', { operationId: OP, nodeId: 3 }, 'deleteCommandNode', [3, OP], 'verify', false],
        ['operation:add_ship_slot', { operationId: OP, data: D }, 'addShipSlot', [OP, D], 'verify', true],
        ['operation:update_ship_slot', { operationId: OP, slotId: 3, data: D }, 'updateShipSlot', [3, D, OP], 'verify', false],
        ['operation:delete_ship_slot', { operationId: OP, slotId: 3 }, 'deleteShipSlot', [3, OP], 'verify', false],
        ['operation:save_board', { operationId: OP, elements: [D] }, 'saveBoardLayout', [OP, [D]], 'verify', false],
        ['operation:add_logistics', { operationId: OP, data: D, user: MEMBER }, 'addLogisticsItem', [OP, D], 'visible', true],
        ['operation:update_logistics', { operationId: OP, itemId: 3, data: D, user: MEMBER }, 'updateLogisticsItem', [3, D, OP], 'visible', false],
        ['operation:delete_logistics', { operationId: OP, itemId: 3, user: MEMBER }, 'deleteLogisticsItem', [3, OP], 'visible', false],
        ['operation:fulfill_logistics', { operationId: OP, itemId: 3, quantity: 2, userId: 6, user: MEMBER }, 'fulfillLogisticsItem', [3, 2, 6, OP], 'visible', false],
        ['operation:delete_aar_entry', { operationId: OP, entryId: 3, user: MEMBER }, 'deleteAAREntry', [3, OP], 'visible', false],
    ];

    it.each(CRUD)('%s → %s, then one id-only operation_update', async (action, p, fn, args, gate, returns) => {
        h.impl[`db.${fn}`] = () => ({ id: 3, row: fn });
        const out = await act(action, p);
        expect(out).toEqual(returns ? { id: 3, row: fn } : undefined);
        expect(db[fn].mock.calls).toEqual([args]);
        const gateFn = gate === 'verify' ? 'db.verifyOperationAccess' : 'db.assertOpVisibleToUser';
        expect(h.trail).toEqual([gateFn, `db.${fn}`, 'db.broadcastOpChange']);
        if (gate === 'verify') expect(db.verifyOperationAccess.mock.calls).toEqual([[OP]]);
        expectOpChange();
    });

    it.each(CRUD.filter((c) => c[4] === 'verify'))('%s: an op that does not exist stops it before the write', async (action, p) => {
        h.impl['db.verifyOperationAccess'] = refuse('Operation not found or access denied.');
        await expect(act(action, p)).rejects.toThrow('Operation not found or access denied.');
        expect(h.trail).toEqual(['db.verifyOperationAccess']);
    });

    it.each(CRUD)('%s: a failed write propagates and broadcasts nothing', async (action, p, fn) => {
        h.impl[`db.${fn}`] = refuse('Failed to write');
        await expect(act(action, p)).rejects.toThrow('Failed to write');
        expect(db.broadcastOpChange).not.toHaveBeenCalled();
    });

    it('update_phase completing a phase records the cascade it performed', async () => {
        h.impl['db.updateOperationPhase'] = () => ({ cascadedTasks: 2, cascadedMilestones: 1 });
        expect(await act('operation:update_phase', { operationId: OP, phaseId: 4, data: { status: 'Completed' }, userId: 20 }))
            .toEqual({ cascadedTasks: 2, cascadedMilestones: 1 });
        expect(db.updateOperationPhase).toHaveBeenCalledWith(4, { status: 'Completed' }, OP);
        expect(db.logOperationEntry).toHaveBeenCalledWith(OP, 'NOTE', 'Phase completed — auto-marked 2 task(s) and 1 milestone(s) as Completed.', 20);
        expect(h.trail).toEqual(['db.verifyOperationAccess', 'db.updateOperationPhase', 'db.logOperationEntry', 'db.broadcastOpChange']);
        expectOpChange();
    });

    it.each([
        [{ cascadedTasks: 3, cascadedMilestones: 0 }, 'Phase completed — auto-marked 3 task(s) as Completed.'],
        [{ cascadedTasks: 0, cascadedMilestones: 2 }, 'Phase completed — auto-marked 2 milestone(s) as Completed.'],
    ])('update_phase cascade message names only what moved: %o', async (cascade, msg) => {
        h.impl['db.updateOperationPhase'] = () => cascade;
        await act('operation:update_phase', { operationId: OP, phaseId: 4, data: { status: 'Completed' }, userId: 20 });
        expect(db.logOperationEntry.mock.calls).toEqual([[OP, 'NOTE', msg, 20]]);
    });

    it('update_phase logs nothing when nothing cascaded or the phase did not complete', async () => {
        h.impl['db.updateOperationPhase'] = () => ({ cascadedTasks: 0, cascadedMilestones: 0 });
        await act('operation:update_phase', { operationId: OP, phaseId: 4, data: { status: 'Completed' }, userId: 20 });
        h.impl['db.updateOperationPhase'] = () => ({ cascadedTasks: 5, cascadedMilestones: 5 });
        await act('operation:update_phase', { operationId: OP, phaseId: 4, data: { status: 'Active' }, userId: 20 });
        expect(db.logOperationEntry).not.toHaveBeenCalled();
        expectOpChange(2);
    });

    it.each([
        ['operation:add_task', 'addOperationTask', 'task'],
        ['operation:add_command_node', 'addCommandNode', 'command'],
    ])('%s notifies the assignee through the guarded helper, then fans out', async (action, fn, kind) => {
        h.impl[`db.${fn}`] = () => ({ id: 9, assigned_user_id: 7 });
        expect(await act(action, { operationId: OP, data: D, userId: 20 })).toEqual({ id: 9, assigned_user_id: 7 });
        expect(db[fn]).toHaveBeenCalledWith(OP, D);
        expect(db.notifyOperationAssignee).toHaveBeenCalledWith(OP, 7, 20, kind);
        expect(h.trail).toEqual(['db.verifyOperationAccess', `db.${fn}`, 'db.notifyOperationAssignee', 'db.broadcastOpChange']);

        h.impl[`db.${fn}`] = () => null;
        await act(action, { operationId: OP, data: D, userId: 20 });
        expect(db.notifyOperationAssignee).toHaveBeenLastCalledWith(OP, undefined, 20, kind);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('seats — member identity, so the clearance gate (not existence)', () => {
    it('assign_slot coerces ids, then notifies the seated member', async () => {
        h.impl['db.assignSlot'] = () => ({ seated: true });
        expect(await act('operation:assign_slot', { operationId: OP, slotId: 2, targetUserId: '7', userId: 20, userShipId: '11', user: MANAGER })).toEqual({ seated: true });
        expect(db.assignSlot).toHaveBeenCalledWith(OP, 2, 7, 20, 11);
        expect(db.notifyOperationAssignee).toHaveBeenCalledWith(OP, 7, 20, 'seat');
        expect(h.trail).toEqual(['db.assertOpVisibleToUser', 'db.assignSlot', 'db.notifyOperationAssignee']);
        await act('operation:assign_slot', { operationId: OP, slotId: 2, targetUserId: 7, userId: 20, user: MANAGER });
        expect(db.assignSlot).toHaveBeenLastCalledWith(OP, 2, 7, 20, undefined);
    });

    it('decide_slot_application: only an explicit approve approves (and notifies); anything else denies silently', async () => {
        await act('operation:decide_slot_application', { operationId: OP, slotId: 2, targetUserId: '7', decision: 'approve', userId: 20, user: MANAGER });
        expect(db.decideSlotApplication).toHaveBeenLastCalledWith(OP, 2, 7, 'approve', 20);
        expect(db.notifyOperationAssignee).toHaveBeenCalledTimes(1);
        for (const decision of ['deny', 'APPROVE', undefined]) {
            await act('operation:decide_slot_application', { operationId: OP, slotId: 2, targetUserId: 7, decision, userId: 20, user: MANAGER });
            expect(db.decideSlotApplication).toHaveBeenLastCalledWith(OP, 2, 7, 'deny', 20);
        }
        expect(db.notifyOperationAssignee).toHaveBeenCalledTimes(1);
    });

    it('remove_slot_assignment clears the named member; withdraw_slot can only ever clear the CALLER', async () => {
        await act('operation:remove_slot_assignment', { operationId: OP, slotId: 2, targetUserId: '7', user: MANAGER });
        expect(db.removeSlotAssignment).toHaveBeenLastCalledWith(OP, 2, 7);
        // targetUserId is not part of the withdraw payload — a forged one is ignored.
        await act('operation:withdraw_slot', { operationId: OP, slotId: 2, userId: 6, targetUserId: 7, user: MEMBER });
        expect(db.removeSlotAssignment).toHaveBeenLastCalledWith(OP, 2, 6);
    });

    it('apply_for_slot binds the caller, with an optional numeric ship', async () => {
        h.impl['db.applyForSlot'] = () => ({ applied: true });
        expect(await act('operation:apply_for_slot', { operationId: OP, slotId: 2, userId: 6, userShipId: '11', user: MEMBER })).toEqual({ applied: true });
        expect(db.applyForSlot).toHaveBeenLastCalledWith(OP, 2, 6, 11);
        await act('operation:apply_for_slot', { operationId: OP, slotId: 2, userId: 6, user: MEMBER });
        expect(db.applyForSlot).toHaveBeenLastCalledWith(OP, 2, 6, undefined);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('tactical board handlers — the per-op channel, never the org stream', () => {
    const ROW = {
        id: 41, operation_id: OP, element_type: 'unit', label: 'Alpha', pos_x: 1, pos_y: 2, width: null, height: null,
        rotation: 0, color: null, data: {}, layer: 0, sort_order: 0, created_at: '2026-06-01T00:00:00Z',
    };

    it('add: broadcasts and returns the MAPPED element with the caller\'s nonce', async () => {
        h.impl['db.addBoardElement'] = () => ROW;
        const out = await act('operation:add_board_element', { operationId: OP, data: { label: 'Alpha' }, clientNonce: 'n-1' });
        const element = {
            id: 41, operationId: OP, elementType: 'unit', label: 'Alpha', posX: 1, posY: 2, width: undefined, height: undefined,
            rotation: 0, color: undefined, data: {}, layer: 0, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
        };
        expect(out).toEqual(element);
        expect(db.addBoardElement).toHaveBeenCalledWith(OP, { label: 'Alpha' });
        expect(db.broadcastBoardAdd).toHaveBeenCalledWith(OP, element, 'n-1');
        expect(h.trail).toEqual(['db.verifyOperationAccess', 'db.addBoardElement', 'db.broadcastBoardAdd']);
        expect(db.broadcastOpChange).not.toHaveBeenCalled();
    });

    it('add: no row back is an error and nothing is broadcast', async () => {
        h.impl['db.addBoardElement'] = () => null;
        await expect(act('operation:add_board_element', { operationId: OP, data: {} })).rejects.toThrow('Failed to add board element');
        expect(db.broadcastBoardAdd).not.toHaveBeenCalled();
    });

    it('update: broadcasts the db layer\'s PROJECTION, not the payload it was given', async () => {
        h.impl['db.updateBoardElement'] = () => ({ posX: 5 });
        await act('operation:update_board_element', { operationId: OP, elementId: 41, data: { posX: 5, injected: 'x' } });
        expect(db.updateBoardElement).toHaveBeenCalledWith(41, { posX: 5, injected: 'x' }, OP);
        expect(db.broadcastBoardUpdate.mock.calls).toEqual([[OP, 41, { posX: 5 }]]);
        expect(h.trail).toEqual(['db.verifyOperationAccess', 'db.updateBoardElement', 'db.broadcastBoardUpdate']);
    });

    it('delete: id-only on the board channel', async () => {
        await act('operation:delete_board_element', { operationId: OP, elementId: 41 });
        expect(db.deleteBoardElement).toHaveBeenCalledWith(41, OP);
        expect(db.broadcastBoardDelete.mock.calls).toEqual([[OP, 41]]);
        expect(h.trail).toEqual(['db.verifyOperationAccess', 'db.deleteBoardElement', 'db.broadcastBoardDelete']);
    });

    it.each(['operation:add_board_element', 'operation:update_board_element', 'operation:delete_board_element'])(
        '%s: an op that does not exist stops it before the write or any broadcast', async (action) => {
            h.impl['db.verifyOperationAccess'] = refuse('Operation not found or access denied.');
            await expect(act(action, { operationId: OP, elementId: 41, data: {} })).rejects.toThrow('Operation not found or access denied.');
            expect(h.trail).toEqual(['db.verifyOperationAccess']);
        });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('alerts', () => {
    it('broadcast_alert persists the ALERT entry BEFORE the trigger ping (receivers fetch it on arrival)', async () => {
        await act('operation:broadcast_alert', { operationId: OP, message: 'RTB now', userId: 20 });
        expect(db.logOperationEntry).toHaveBeenCalledWith(OP, 'ALERT', 'Operations Alert: RTB now', 20);
        expect(db.broadcastOperationAlert).toHaveBeenCalledWith(OP, 'RTB now');
        expect(h.trail).toEqual(['db.logOperationEntry', 'db.broadcastOperationAlert', 'db.broadcastOpChange']);
        expectOpChange();
    });

    it('a failed persist sends no ping at all', async () => {
        h.impl['db.logOperationEntry'] = refuse('Failed to log');
        await expect(act('operation:broadcast_alert', { operationId: OP, message: 'm', userId: 20 })).rejects.toThrow('Failed to log');
        expect(db.broadcastOperationAlert).not.toHaveBeenCalled();
    });

    it('get_latest_alert returns the gated content read', async () => {
        h.impl['db.getLatestOperationAlert'] = () => ({ message: 'RTB now', senderName: 'Cmd', timestamp: 't' });
        expect(await act('operation:get_latest_alert', { operationId: OP, user: MEMBER })).toEqual({ message: 'RTB now', senderName: 'Cmd', timestamp: 't' });
        expect(db.getLatestOperationAlert).toHaveBeenCalledWith(OP);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('AAR handlers', () => {
    it('add_aar_entry stamps the ACTOR id over any id in the entry data', async () => {
        h.impl['db.addAAREntry'] = () => ({ id: 5 });
        expect(await act('operation:add_aar_entry', { operationId: OP, data: { content: 'lesson', userId: 999 }, userId: 6, user: MEMBER })).toEqual({ id: 5 });
        expect(db.addAAREntry).toHaveBeenCalledWith(OP, { content: 'lesson', userId: 6 });
        expect(h.trail).toEqual(['db.assertOpVisibleToUser', 'db.addAAREntry', 'db.broadcastOpChange']);
        expectOpChange();
    });

    it('submit_aar forwards the text, then fans out', async () => {
        await act('operation:submit_aar', { operationId: OP, userId: 20, summary: 'S', lessonsLearned: 'L' });
        expect(db.submitAAR).toHaveBeenCalledWith(OP, 20, 'S', 'L');
        expect(h.trail).toEqual(['db.submitAAR', 'db.broadcastOpChange']);
    });

    it.each([
        ['an org admin (role match)', { admin: { id: 1 } }, 99, { roleId: 1 }],
        ['the operation owner', {}, 20, { roleId: 4 }],
    ])('reopen_aar is allowed for %s', async (_who, roles, ownerId, user) => {
        h.impl['db.getSystemRoles'] = () => roles;
        h.impl['db.getOperationOwnerId'] = () => ownerId;
        h.impl['db.getUserById'] = () => user;
        await act('operation:reopen_aar', { operationId: OP, userId: 20 });
        expect(db.getOperationOwnerId).toHaveBeenCalledWith(OP);
        expect(db.getUserById).toHaveBeenCalledWith(20);
        expect(db.reopenAAR).toHaveBeenCalledWith(OP);
        expect(db.logOperationEntry).toHaveBeenCalledWith(OP, 'NOTE', 'AAR reopened for editing.', 20);
        expect(h.trail.slice(-3)).toEqual(['db.reopenAAR', 'db.logOperationEntry', 'db.broadcastOpChange']);
    });

    it.each([
        ['a member who is neither', { admin: { id: 1 } }, 99, { roleId: 4 }],
        ['an unknown owner (null never equals the caller)', {}, null, { roleId: 4 }],
        ['an org with no admin role configured', {}, 99, { roleId: undefined }],
        ['a user that cannot be loaded', { admin: { id: 1 } }, 99, null],
    ])('reopen_aar is refused for %s, with a stable error code and no write', async (_who, roles, ownerId, user) => {
        h.impl['db.getSystemRoles'] = () => roles;
        h.impl['db.getOperationOwnerId'] = () => ownerId;
        h.impl['db.getUserById'] = () => user;
        const err = await act('operation:reopen_aar', { operationId: OP, userId: 20 }).catch((e: unknown) => e) as Error & { code?: string };
        expect(err.message).toBe('Only the operation owner or an org admin can reopen an AAR.');
        expect(err.code).toBe('AAR_REOPEN_FORBIDDEN');
        expect(db.reopenAAR).not.toHaveBeenCalled();
        expect(db.logOperationEntry).not.toHaveBeenCalled();
        expect(db.broadcastOpChange).not.toHaveBeenCalled();
    });

    it('generate_aar_summary is throttled per USER before the paid call; a refusal generates nothing', async () => {
        h.impl['db.generateAARDraftForOperation'] = () => ({ summary: 'S' });
        expect(await act('operation:generate_aar_summary', { operationId: OP, userId: 20 })).toEqual({ summary: 'S' });
        expect(h.assertAiRateLimit).toHaveBeenCalledWith(20);
        expect(h.trail).toEqual(['ai', 'db.generateAARDraftForOperation', 'db.broadcastOpChange']);

        h.trail.length = 0;
        h.impl.ai = refuse('AI rate limit reached. Try again in 30s.');
        await expect(act('operation:generate_aar_summary', { operationId: OP, userId: 20 })).rejects.toThrow('AI rate limit reached. Try again in 30s.');
        expect(h.trail).toEqual(['ai']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('operation templates — id-only org broadcasts', () => {
    const TPL_PAYLOAD = { phases: [{ name: 'Insert' }] };
    const templateEmits = () => db.broadcastToOrg.mock.calls;

    it('create WITHOUT a source op: no gate, no classification, unclassified template', async () => {
        h.impl['db.createOperationTemplate'] = () => ({ id: 12, name: 'T' });
        expect(await act('operation:template:create', { name: 'T', payload: TPL_PAYLOAD, userId: 6, user: MEMBER })).toEqual({ id: 12, name: 'T' });
        expect(db.createOperationTemplate.mock.calls).toEqual([[6, 'T', null, TPL_PAYLOAD, undefined]]);
        expect(db.assertOpVisibleToUser).not.toHaveBeenCalled();
        expect(templateEmits()).toEqual([['operation_templates_changed', { id: 12 }]]);
    });

    it('create FROM a source op: read-gated, and the template inherits the op\'s classification server-side', async () => {
        h.impl['db.getOperationClassification'] = () => ({ classificationLevel: 3, markerIds: [7] });
        h.impl['db.createOperationTemplate'] = () => ({ id: 13 });
        await act('operation:template:create', {
            name: 'T', description: 'desc', payload: TPL_PAYLOAD, userId: 6, sourceOperationId: OP, user: MEMBER,
            classificationLevel: 0, markerIds: [],
        });
        expect(db.getOperationClassification).toHaveBeenCalledWith(OP);
        expect(db.createOperationTemplate.mock.calls).toEqual([[6, 'T', 'desc', TPL_PAYLOAD, { classificationLevel: 3, markerIds: [7] }]]);
        expect(h.trail).toEqual(['db.assertOpVisibleToUser', 'db.getOperationClassification', 'db.createOperationTemplate', 'db.broadcastToOrg']);
        expect(templateEmits()).toEqual([['operation_templates_changed', { id: 13 }]]);
    });

    it('a classification read failure refuses the save (nothing is created unclassified)', async () => {
        h.impl['db.getOperationClassification'] = refuse('Failed to read operation classification');
        await expect(act('operation:template:create', { name: 'T', payload: TPL_PAYLOAD, userId: 6, sourceOperationId: OP, user: MEMBER }))
            .rejects.toThrow('Failed to read operation classification');
        expect(db.createOperationTemplate).not.toHaveBeenCalled();
        expect(db.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('update / delete carry the viewer for the template clearance twin, and broadcast only the id', async () => {
        h.impl['db.updateOperationTemplate'] = () => ({ id: 12, payload: { secret: true } });
        expect(await act('operation:template:update', { id: 12, name: 'N', description: null, payload: TPL_PAYLOAD, user: MEMBER })).toEqual({ id: 12, payload: { secret: true } });
        expect(db.updateOperationTemplate).toHaveBeenCalledWith(12, { name: 'N', description: null, payload: TPL_PAYLOAD }, MEMBER);
        await act('operation:template:delete', { id: 12, user: MEMBER });
        expect(db.deleteOperationTemplate).toHaveBeenCalledWith(12, MEMBER);
        expect(templateEmits()).toEqual([['operation_templates_changed', { id: 12 }], ['operation_templates_changed', { id: 12 }]]);
    });

    it('a refused update/delete broadcasts nothing', async () => {
        h.impl['db.updateOperationTemplate'] = refuse('Template not found.');
        h.impl['db.deleteOperationTemplate'] = refuse('Template not found.');
        await expect(act('operation:template:update', { id: 12, user: MEMBER })).rejects.toThrow('Template not found.');
        await expect(act('operation:template:delete', { id: 12, user: MEMBER })).rejects.toThrow('Template not found.');
        expect(db.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('from_operation extracts after the read gate; import saves the supplied payload unclassified', async () => {
        h.impl['db.extractTemplatePayloadFromOperation'] = () => TPL_PAYLOAD;
        expect(await act('operation:template:from_operation', { operationId: OP, user: MEMBER })).toEqual(TPL_PAYLOAD);
        expect(db.extractTemplatePayloadFromOperation).toHaveBeenCalledWith(OP);

        h.impl['db.createOperationTemplate'] = () => ({ id: 14 });
        expect(await act('operation:template:import', { name: 'I', payload: TPL_PAYLOAD, userId: 6 })).toEqual({ id: 14 });
        expect(db.createOperationTemplate).toHaveBeenLastCalledWith(6, 'I', null, TPL_PAYLOAD);
        expect(db.createOperationTemplate.mock.calls.at(-1)).toHaveLength(4);
        expect(templateEmits()).toEqual([['operation_templates_changed', { id: 14 }]]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security rule 4 across the WHOLE module: every org-stream fan-out a handler makes
// carries an operation id (or template id) and nothing else. Sweeps every handler that
// fans out with a realistic payload carrying content, and checks no content leaked.
describe('broadcast contract — ids only on the org stream', () => {
    it('no handler puts payload content into broadcastOpChange / broadcastToOrg', async () => {
        const SECRET = 'SECRET-CONTENT-xyzzy';
        h.impl['db.createOperationTemplate'] = () => ({ id: 12, name: SECRET });
        h.impl['db.updateOperationTemplate'] = () => ({ id: 12, name: SECRET });
        h.impl['db.updateOperationPhase'] = () => ({ cascadedTasks: 1, cascadedMilestones: 0 });
        h.impl['db.getOperationOwnerId'] = () => 6;
        h.impl['db.getUserById'] = () => ({ roleId: 1 });
        const data = { name: SECRET, description: SECRET, status: 'Completed' };
        const calls: Array<[string, Record<string, unknown>]> = [
            ['operation:add_phase', { operationId: OP, data }], ['operation:update_phase', { operationId: OP, phaseId: 1, data, userId: 6 }],
            ['operation:add_task', { operationId: OP, data, userId: 6 }], ['operation:add_logistics', { operationId: OP, data, user: MEMBER }],
            ['operation:timeline_add', { operationId: OP, entry: SECRET, userId: 6, user: MEMBER }],
            ['operation:broadcast_alert', { operationId: OP, message: SECRET, userId: 6 }],
            ['operation:add_aar_entry', { operationId: OP, data, userId: 6, user: MEMBER }],
            ['operation:submit_aar', { operationId: OP, userId: 6, summary: SECRET, lessonsLearned: SECRET }],
            ['operation:reopen_aar', { operationId: OP, userId: 6 }],
            ['operation:template:create', { name: SECRET, payload: { phases: [{ name: SECRET }] }, userId: 6 }],
            ['operation:template:update', { id: 12, name: SECRET, user: MEMBER }],
            ['operation:save_board', { operationId: OP, elements: [data] }],
        ];
        for (const [action, p] of calls) await act(action, p);
        for (const c of db.broadcastOpChange.mock.calls) expect(c).toEqual([OP]);
        for (const c of db.broadcastToOrg.mock.calls) {
            expect(c[0]).toBe('operation_templates_changed');
            expect(Object.keys(c[1] as object)).toEqual(['id']);
        }
        expect(JSON.stringify([db.broadcastOpChange.mock.calls, db.broadcastToOrg.mock.calls])).not.toContain(SECRET);
        expect(db.broadcastOpChange.mock.calls.length).toBe(calls.length - 2);
    });
});
