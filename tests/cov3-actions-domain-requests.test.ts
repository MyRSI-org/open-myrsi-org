import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Handler-level suite for api/actions/requests.ts.
//
// What is pinned here:
//   * every handler forwards exactly the documented arguments to its db-layer call
//     (argument ORDER matters — several db functions take (requestId, memberId,
//     actorId) and a swap would act on the wrong person);
//   * the in-handler security preconditions on start / complete / cancel / rate:
//     an unidentified caller throws BEFORE any db call, and a failed responder/owner
//     assertion stops the mutation (fail-closed ordering);
//   * the new_request realtime broadcast carries ids only (Security rule 4);
//   * the Discord new-request embed: per-service-type routing with a global
//     fallback, no-channel skip, value fallbacks/truncation, footer branding, and
//     that every Discord/settings failure is swallowed so the create still succeeds.

type Call = { method: string; args: unknown[] };

const h = vi.hoisted(() => ({
    queries: [] as Array<{ table: string; calls: Call[] }>,
    settingsData: null as unknown,
    settingsThrows: false,
    serviceTypeResult: { data: null, error: null } as { data: unknown; error: unknown },
    serviceTypeThrows: false,
    userResult: { data: { name: 'Vex Talon' }, error: null } as { data: unknown; error: unknown },
}));

const spies = vi.hoisted(() => ({
    createServiceRequest: vi.fn(),
    createAdHocServiceRequest: vi.fn(),
    updateRequestStatus: vi.fn(),
    adminAcceptAndAssignRequest: vi.fn(),
    acceptRequest: vi.fn(),
    assertRequestResponderOrDuty: vi.fn(),
    completeRequest: vi.fn(),
    assertRequestOwnerOrDuty: vi.fn(),
    rateRequest: vi.fn(),
    addRequestNote: vi.fn(),
    dispatchMembers: vi.fn(),
    addResponderToRequest: vi.fn(),
    removeResponderFromRequest: vi.fn(),
    setLeadResponder: vi.fn(),
    addRequestPartyMember: vi.fn(),
    removeRequestPartyMember: vi.fn(),
    deleteServiceRequest: vi.fn(),
    sendDiscordChannelMessage: vi.fn(),
    broadcastToOrg: vi.fn(),
}));

vi.mock('../lib/db', () => {
    function builder(table: string) {
        const calls: Call[] = [];
        h.queries.push({ table, calls });
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => {
            if (table === 'settings') {
                if (h.settingsThrows) return Promise.reject(new Error('settings read blew up'));
                return Promise.resolve({ data: h.settingsData, error: null });
            }
            if (table === 'service_types') {
                if (h.serviceTypeThrows) return Promise.reject(new Error('column does not exist'));
                return Promise.resolve(h.serviceTypeResult);
            }
            if (table === 'users') return Promise.resolve(h.userResult);
            return Promise.resolve({ data: null, error: null });
        };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t) },
        createServiceRequest: spies.createServiceRequest,
        createAdHocServiceRequest: spies.createAdHocServiceRequest,
        updateRequestStatus: spies.updateRequestStatus,
        adminAcceptAndAssignRequest: spies.adminAcceptAndAssignRequest,
        acceptRequest: spies.acceptRequest,
        assertRequestResponderOrDuty: spies.assertRequestResponderOrDuty,
        completeRequest: spies.completeRequest,
        assertRequestOwnerOrDuty: spies.assertRequestOwnerOrDuty,
        rateRequest: spies.rateRequest,
        addRequestNote: spies.addRequestNote,
        dispatchMembers: spies.dispatchMembers,
        addResponderToRequest: spies.addResponderToRequest,
        removeResponderFromRequest: spies.removeResponderFromRequest,
        setLeadResponder: spies.setLeadResponder,
        addRequestPartyMember: spies.addRequestPartyMember,
        removeRequestPartyMember: spies.removeRequestPartyMember,
        deleteServiceRequest: spies.deleteServiceRequest,
    };
});
vi.mock('../lib/discord', () => ({ sendDiscordChannelMessage: spies.sendDiscordChannelMessage }));
vi.mock('../lib/db/common', () => ({ broadcastToOrg: spies.broadcastToOrg }));

import { requestActions } from '../api/actions/requests';

type Handler = (p: unknown) => unknown;
const call = (name: string, p: unknown) => (requestActions as unknown as Record<string, Handler>)[name](p);

type Embed = {
    title: string;
    color: number;
    fields: Array<{ name: string; value: string; inline?: boolean }>;
    timestamp: string;
    footer: { text: string; icon_url?: string };
};
const embedOf = (i = 0) => (spies.sendDiscordChannelMessage.mock.calls[i][1] as { embeds: Embed[] }).embeds[0];
const field = (e: Embed, name: string) => e.fields.find((f) => f.name === name)?.value;
const queriesOf = (table: string) => h.queries.filter((q) => q.table === table);

const NOW = new Date('2026-11-02T03:04:05.000Z');
const SECRET_DESC = 'Pinned down at the Kareah wreck, two Cutlass hostiles inbound';

const MAPPED_REQUEST = {
    id: 'REQ-1001',
    clientId: 42,
    serviceType: 'Medical Rescue',
    location: 'Kareah',
    threatLevel: 'High',
    description: SECRET_DESC,
    urgency: 'Critical',
};

const discordSettings = () => [
    { key: 'discordConfig', value: { newRequestChannelId: 'global-chan' } },
    { key: 'brandingConfig', value: { name: 'Acme Rescue', iconUrl: 'https://cdn.example/icon.png' } },
];

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    h.queries = [];
    h.settingsData = discordSettings();
    h.settingsThrows = false;
    h.serviceTypeResult = { data: null, error: null };
    h.serviceTypeThrows = false;
    h.userResult = { data: { name: 'Vex Talon' }, error: null };
    for (const s of Object.values(spies)) s.mockReset();
    spies.createServiceRequest.mockResolvedValue({ ...MAPPED_REQUEST });
    spies.createAdHocServiceRequest.mockResolvedValue({ ...MAPPED_REQUEST, id: 'REQ-2002', clientId: undefined, unregisteredClientRsiHandle: 'Drifter_77' });
    spies.sendDiscordChannelMessage.mockResolvedValue(undefined);
    spies.assertRequestResponderOrDuty.mockResolvedValue(undefined);
    spies.assertRequestOwnerOrDuty.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('request:create', () => {
    it('creates via the db layer, looks the client name up by id, broadcasts ids only, and returns the request', async () => {
        const newRequest = { serviceType: 'Medical Rescue', description: SECRET_DESC };
        const out = await call('request:create', { newRequest, userId: 42 });

        expect(spies.createServiceRequest).toHaveBeenCalledWith(newRequest, 42);
        expect(out).toEqual(MAPPED_REQUEST);

        const users = queriesOf('users');
        expect(users).toHaveLength(1);
        expect(users[0].calls).toEqual([
            { method: 'select', args: ['name'] },
            { method: 'eq', args: ['id', 42] },
            { method: 'single', args: [] },
        ]);

        // Security rule 4: the realtime payload is ids only — the body never rides it.
        expect(spies.broadcastToOrg).toHaveBeenCalledTimes(1);
        expect(spies.broadcastToOrg).toHaveBeenCalledWith('new_request', { id: 'REQ-1001', clientId: 42 });
        expect(JSON.stringify(spies.broadcastToOrg.mock.calls)).not.toContain('Kareah');
    });

    it('reads only the two settings keys, with explicit columns', async () => {
        await call('request:create', { newRequest: {}, userId: 42 });
        const settings = queriesOf('settings');
        expect(settings).toHaveLength(1);
        expect(settings[0].calls).toEqual([
            { method: 'select', args: ['key, value'] },
            { method: 'in', args: ['key', ['discordConfig', 'brandingConfig']] },
        ]);
    });

    it('posts the full embed to the global channel when no per-type channel is set', async () => {
        await call('request:create', { newRequest: {}, userId: 42 });

        expect(spies.sendDiscordChannelMessage).toHaveBeenCalledTimes(1);
        expect(spies.sendDiscordChannelMessage.mock.calls[0][0]).toBe('global-chan');
        expect(embedOf()).toEqual({
            title: '🚨 NEW SERVICE REQUEST: REQ-1001',
            color: 0x38bdf8,
            fields: [
                { name: 'Client', value: 'Vex Talon', inline: true },
                { name: 'Service Type', value: 'Medical Rescue', inline: true },
                { name: 'Urgency', value: 'Critical', inline: true },
                { name: 'Location', value: 'Kareah', inline: true },
                { name: 'Threat Level', value: 'High', inline: true },
                { name: 'Description', value: SECRET_DESC },
            ],
            timestamp: NOW.toISOString(),
            footer: { text: 'Acme Rescue Ops Terminal', icon_url: 'https://cdn.example/icon.png' },
        });
    });

    it('routes to the per-service-type channel when the matching service_types row has one', async () => {
        h.serviceTypeResult = { data: { discord_channel_id: 'medical-chan' }, error: null };
        await call('request:create', { newRequest: {}, userId: 42 });

        const st = queriesOf('service_types');
        expect(st).toHaveLength(1);
        expect(st[0].calls).toEqual([
            { method: 'select', args: ['discord_channel_id'] },
            { method: 'eq', args: ['name', 'Medical Rescue'] },
            { method: 'maybeSingle', args: [] },
        ]);
        expect(spies.sendDiscordChannelMessage.mock.calls[0][0]).toBe('medical-chan');
    });

    it('uses the per-type channel even with no global channel configured', async () => {
        h.settingsData = [{ key: 'brandingConfig', value: { name: 'Acme Rescue' } }];
        h.serviceTypeResult = { data: { discord_channel_id: 'medical-chan' }, error: null };
        await call('request:create', { newRequest: {}, userId: 42 });
        expect(spies.sendDiscordChannelMessage.mock.calls[0][0]).toBe('medical-chan');
    });

    it('falls back to the global channel when the per-type lookup returns an error', async () => {
        h.serviceTypeResult = { data: { discord_channel_id: 'medical-chan' }, error: { message: 'boom' } };
        await call('request:create', { newRequest: {}, userId: 42 });
        expect(spies.sendDiscordChannelMessage.mock.calls[0][0]).toBe('global-chan');
    });

    it('falls back to the global channel when the per-type row has no channel', async () => {
        h.serviceTypeResult = { data: { discord_channel_id: null }, error: null };
        await call('request:create', { newRequest: {}, userId: 42 });
        expect(spies.sendDiscordChannelMessage.mock.calls[0][0]).toBe('global-chan');
    });

    it('falls back to the global channel when the per-type lookup throws (pre-migration column)', async () => {
        h.serviceTypeThrows = true;
        await expect(call('request:create', { newRequest: {}, userId: 42 })).resolves.toEqual(MAPPED_REQUEST);
        expect(spies.sendDiscordChannelMessage.mock.calls[0][0]).toBe('global-chan');
    });

    it('skips the per-type lookup entirely when the request has no service type', async () => {
        spies.createServiceRequest.mockResolvedValue({ id: 'REQ-1', clientId: 1 });
        await call('request:create', { newRequest: {}, userId: 42 });
        expect(queriesOf('service_types')).toHaveLength(0);
        expect(spies.sendDiscordChannelMessage.mock.calls[0][0]).toBe('global-chan');
    });

    it('sends nothing when neither a per-type nor a global channel is configured', async () => {
        h.settingsData = [{ key: 'brandingConfig', value: { name: 'Acme Rescue' } }];
        await expect(call('request:create', { newRequest: {}, userId: 42 })).resolves.toEqual(MAPPED_REQUEST);
        expect(spies.sendDiscordChannelMessage).not.toHaveBeenCalled();
    });

    it('treats a null settings read as "nothing configured"', async () => {
        h.settingsData = null;
        await call('request:create', { newRequest: {}, userId: 42 });
        expect(spies.sendDiscordChannelMessage).not.toHaveBeenCalled();
    });

    it('a failing settings read is swallowed: the create still returns and still broadcasts', async () => {
        h.settingsThrows = true;
        await expect(call('request:create', { newRequest: {}, userId: 42 })).resolves.toEqual(MAPPED_REQUEST);
        expect(spies.broadcastToOrg).toHaveBeenCalledTimes(1);
        expect(spies.sendDiscordChannelMessage).not.toHaveBeenCalled();
    });

    it('a Discord send failure is swallowed: the create still returns', async () => {
        spies.sendDiscordChannelMessage.mockRejectedValue(new Error('discord 500'));
        await expect(call('request:create', { newRequest: {}, userId: 42 })).resolves.toEqual(MAPPED_REQUEST);
        expect(spies.sendDiscordChannelMessage).toHaveBeenCalledTimes(1);
    });

    it('a db create failure propagates and nothing is broadcast or posted', async () => {
        spies.createServiceRequest.mockRejectedValue(new Error('Failed to create request'));
        await expect(call('request:create', { newRequest: {}, userId: 42 })).rejects.toThrow('Failed to create request');
        expect(spies.broadcastToOrg).not.toHaveBeenCalled();
        expect(spies.sendDiscordChannelMessage).not.toHaveBeenCalled();
    });

    it('fills every empty / missing field with its fallback and defaults the footer branding', async () => {
        h.settingsData = [{ key: 'discordConfig', value: { newRequestChannelId: 'global-chan' } }];
        h.userResult = { data: null, error: null };
        spies.createServiceRequest.mockResolvedValue({
            id: 'REQ-9', clientId: 1, location: '   ', threatLevel: null, description: '', urgency: undefined,
        });
        await call('request:create', { newRequest: {}, userId: 42 });

        const e = embedOf();
        expect(field(e, 'Client')).toBe('Unknown Client');
        expect(field(e, 'Service Type')).toBe('Service');
        expect(field(e, 'Location')).toBe('Unknown Location');
        expect(field(e, 'Threat Level')).toBe('Unknown');
        expect(field(e, 'Description')).toBe('No description provided.');
        expect(field(e, 'Urgency')).toBe('Normal');
        expect(e.footer).toEqual({ text: 'Organization Ops Terminal' });
    });

    it('a branding row with an empty name and a non-http icon gets the default name and no icon_url', async () => {
        h.settingsData = [
            { key: 'discordConfig', value: { newRequestChannelId: 'global-chan' } },
            { key: 'brandingConfig', value: { name: '', iconUrl: 'javascript:alert(1)' } },
        ];
        await call('request:create', { newRequest: {}, userId: 42 });
        expect(embedOf().footer).toEqual({ text: 'Organization Ops Terminal' });
    });

    it('caps a Discord field value at 1024 characters (1021 + ellipsis)', async () => {
        const long = 'x'.repeat(1500);
        spies.createServiceRequest.mockResolvedValue({ ...MAPPED_REQUEST, description: long });
        await call('request:create', { newRequest: {}, userId: 42 });
        const desc = field(embedOf(), 'Description') as string;
        expect(desc).toHaveLength(1024);
        expect(desc).toBe('x'.repeat(1021) + '...');
    });

    it('keeps a value of exactly 1024 characters intact', async () => {
        const exact = 'y'.repeat(1024);
        spies.createServiceRequest.mockResolvedValue({ ...MAPPED_REQUEST, description: exact });
        await call('request:create', { newRequest: {}, userId: 42 });
        expect(field(embedOf(), 'Description')).toBe(exact);
    });

    it('reads snake_case fields from a raw-row-shaped request', async () => {
        h.userResult = { data: null, error: null };
        spies.createServiceRequest.mockResolvedValue({
            id: 'REQ-3', clientId: 3, service_type: 'Escort', threat_level: 'Low',
            unregistered_client_rsi_handle: 'Raw_Handle',
        });
        await call('request:create', { newRequest: {}, userId: 42 });
        const e = embedOf();
        expect(field(e, 'Client')).toBe('Raw_Handle');
        expect(field(e, 'Service Type')).toBe('Escort');
        expect(field(e, 'Threat Level')).toBe('Low');
        expect(queriesOf('service_types')[0].calls[1]).toEqual({ method: 'eq', args: ['name', 'Escort'] });
    });
});

describe('request:create_adhoc', () => {
    it('passes the dispatcher-injected user through for the binding-duty check, broadcasts ids only, and posts', async () => {
        const user = { id: 5, permissions: ['request:dispatch'] };
        const newRequest = { unregisteredClientRsiHandle: 'Drifter_77' };
        const out = await call('request:create_adhoc', { newRequest, userId: 5, user });

        expect(spies.createAdHocServiceRequest).toHaveBeenCalledWith(newRequest, 5, user);
        expect(out).toMatchObject({ id: 'REQ-2002' });
        expect(spies.broadcastToOrg).toHaveBeenCalledWith('new_request', { id: 'REQ-2002', clientId: undefined });
        // No users lookup on the ad-hoc path: the client is the unregistered handle.
        expect(queriesOf('users')).toHaveLength(0);
        expect(field(embedOf(), 'Client')).toBe('Drifter_77');
        expect(embedOf().title).toBe('🚨 NEW SERVICE REQUEST: REQ-2002');
    });

    it('a db failure propagates with nothing broadcast or posted', async () => {
        spies.createAdHocServiceRequest.mockRejectedValue(new Error('Forbidden: dispatch duty required'));
        await expect(call('request:create_adhoc', { newRequest: {}, userId: 5, user: { id: 5 } })).rejects.toThrow('Forbidden: dispatch duty required');
        expect(spies.broadcastToOrg).not.toHaveBeenCalled();
        expect(spies.sendDiscordChannelMessage).not.toHaveBeenCalled();
    });
});

describe('status transitions forward the right status and arguments', () => {
    it('request:triage passes Triaged and wraps urgency in a metadata object', async () => {
        spies.updateRequestStatus.mockResolvedValue('ok');
        await expect(call('request:triage', { requestId: 'R1', notes: 'checked', urgency: 'High', userId: 7 })).resolves.toBe('ok');
        expect(spies.updateRequestStatus).toHaveBeenCalledWith('R1', 'Triaged', 7, 'checked', undefined, { urgency: 'High' });
    });

    it('request:triage without urgency passes no metadata object', async () => {
        await call('request:triage', { requestId: 'R1', userId: 7 });
        expect(spies.updateRequestStatus).toHaveBeenCalledWith('R1', 'Triaged', 7, undefined, undefined, undefined);
    });

    it('request:admin_accept forwards (requestId, leadResponderId, actor, notes, urgency)', async () => {
        await call('request:admin_accept', { requestId: 'R1', leadResponderId: 33, notes: 'go', urgency: 'Low', userId: 7 });
        expect(spies.adminAcceptAndAssignRequest).toHaveBeenCalledWith('R1', 33, 7, 'go', 'Low');
    });

    it('request:accept forwards the caller-supplied memberId AND the injected user so the db can scope it', async () => {
        const user = { id: 7, permissions: [] };
        await call('request:accept', { requestId: 'R1', memberId: 99, userId: 7, user });
        expect(spies.acceptRequest).toHaveBeenCalledWith('R1', 99, 7, user);
    });

    it('request:update_status forwards status, notes and report', async () => {
        const report = { notes: 'done', uecEarned: 5000 };
        await call('request:update_status', { requestId: 'R1', status: 'Success', notes: 'n', report, userId: 7 });
        expect(spies.updateRequestStatus).toHaveBeenCalledWith('R1', 'Success', 7, 'n', report, undefined);
    });

    it('request:refuse passes Refused with the notes', async () => {
        await call('request:refuse', { requestId: 'R1', notes: 'out of range', userId: 7 });
        expect(spies.updateRequestStatus).toHaveBeenCalledWith('R1', 'Refused', 7, 'out of range', undefined, undefined);
    });
});

describe('request:start / request:complete — responder-or-duty precondition', () => {
    const user = { id: 7, role: 'Member', permissions: [] as string[] };

    it('start: asserts responder-or-duty with the injected user, then moves the request In-Progress', async () => {
        spies.updateRequestStatus.mockResolvedValue('started');
        await expect(call('request:start', { requestId: 'R1', userId: 7, user })).resolves.toBe('started');
        expect(spies.assertRequestResponderOrDuty).toHaveBeenCalledWith('R1', user, 'start');
        expect(spies.updateRequestStatus).toHaveBeenCalledWith('R1', 'In-Progress', 7, 'Mission started.', undefined, undefined);
        expect(spies.assertRequestResponderOrDuty.mock.invocationCallOrder[0])
            .toBeLessThan(spies.updateRequestStatus.mock.invocationCallOrder[0]);
    });

    it('start: an unidentified caller throws before any db call', async () => {
        await expect(call('request:start', { requestId: 'R1', userId: 7 })).rejects.toThrow('Forbidden: unidentified caller.');
        expect(spies.assertRequestResponderOrDuty).not.toHaveBeenCalled();
        expect(spies.updateRequestStatus).not.toHaveBeenCalled();
    });

    it('start: a failed responder assertion stops the status change', async () => {
        spies.assertRequestResponderOrDuty.mockRejectedValue(new Error('Forbidden: not a responder'));
        await expect(call('request:start', { requestId: 'R1', userId: 7, user })).rejects.toThrow('Forbidden: not a responder');
        expect(spies.updateRequestStatus).not.toHaveBeenCalled();
    });

    it('complete: asserts with "complete" then completes with the report and user', async () => {
        const report = { outcome: 'Success', medigelConsumed: 2 };
        spies.completeRequest.mockResolvedValue('completed');
        await expect(call('request:complete', { requestId: 'R1', report, userId: 7, user })).resolves.toBe('completed');
        expect(spies.assertRequestResponderOrDuty).toHaveBeenCalledWith('R1', user, 'complete');
        expect(spies.completeRequest).toHaveBeenCalledWith('R1', report, 7, user);
    });

    it('complete: an unidentified caller throws before any db call', async () => {
        await expect(call('request:complete', { requestId: 'R1', report: {}, userId: 7 })).rejects.toThrow('Forbidden: unidentified caller.');
        expect(spies.assertRequestResponderOrDuty).not.toHaveBeenCalled();
        expect(spies.completeRequest).not.toHaveBeenCalled();
    });

    it('complete: a failed responder assertion stops the completion', async () => {
        spies.assertRequestResponderOrDuty.mockRejectedValue(new Error('Forbidden: not a responder'));
        await expect(call('request:complete', { requestId: 'R1', report: {}, userId: 7, user })).rejects.toThrow('Forbidden: not a responder');
        expect(spies.completeRequest).not.toHaveBeenCalled();
    });
});

describe('request:cancel / request:rate — owner-or-duty precondition', () => {
    const user = { id: 12, role: 'Client', permissions: [] as string[] };

    it('cancel: asserts owner-or-duty with "cancel" then cancels with the fixed client note', async () => {
        spies.updateRequestStatus.mockResolvedValue('cancelled');
        await expect(call('request:cancel', { requestId: 'R1', userId: 12, user })).resolves.toBe('cancelled');
        expect(spies.assertRequestOwnerOrDuty).toHaveBeenCalledWith('R1', user, 'cancel');
        expect(spies.updateRequestStatus).toHaveBeenCalledWith('R1', 'Cancelled', 12, 'Request cancelled by client.', undefined, undefined);
    });

    it('cancel: an unidentified caller throws before any db call', async () => {
        await expect(call('request:cancel', { requestId: 'R1', userId: 12 })).rejects.toThrow('Forbidden: unidentified caller.');
        expect(spies.assertRequestOwnerOrDuty).not.toHaveBeenCalled();
        expect(spies.updateRequestStatus).not.toHaveBeenCalled();
    });

    it('cancel: a non-owner is refused and the request is left alone', async () => {
        spies.assertRequestOwnerOrDuty.mockRejectedValue(new Error('Forbidden: not your request'));
        await expect(call('request:cancel', { requestId: 'R1', userId: 12, user })).rejects.toThrow('Forbidden: not your request');
        expect(spies.updateRequestStatus).not.toHaveBeenCalled();
    });

    it('rate: asserts owner-or-duty with "rate" then rates with the user', async () => {
        spies.rateRequest.mockResolvedValue('rated');
        await expect(call('request:rate', { requestId: 'R1', rating: 5, feedback: 'great', user })).resolves.toBe('rated');
        expect(spies.assertRequestOwnerOrDuty).toHaveBeenCalledWith('R1', user, 'rate');
        expect(spies.rateRequest).toHaveBeenCalledWith('R1', 5, 'great', user);
    });

    it('rate: an unidentified caller throws before any db call', async () => {
        await expect(call('request:rate', { requestId: 'R1', rating: 1, feedback: 'x' })).rejects.toThrow('Forbidden: unidentified caller.');
        expect(spies.assertRequestOwnerOrDuty).not.toHaveBeenCalled();
        expect(spies.rateRequest).not.toHaveBeenCalled();
    });

    it('rate: a non-owner is refused and no rating is written', async () => {
        spies.assertRequestOwnerOrDuty.mockRejectedValue(new Error('Forbidden: not your request'));
        await expect(call('request:rate', { requestId: 'R1', rating: 1, feedback: 'x', user })).rejects.toThrow('Forbidden: not your request');
        expect(spies.rateRequest).not.toHaveBeenCalled();
    });
});

describe('responder / party / note / delete handlers forward exact arguments', () => {
    it('request:add_note → addRequestNote(requestId, note, actor)', async () => {
        spies.addRequestNote.mockResolvedValue('noted');
        await expect(call('request:add_note', { requestId: 'R1', note: 'eta 5', userId: 7 })).resolves.toBe('noted');
        expect(spies.addRequestNote).toHaveBeenCalledWith('R1', 'eta 5', 7);
    });

    it('request:dispatch_members → dispatchMembers(requestId, memberIds, actor)', async () => {
        await call('request:dispatch_members', { requestId: 'R1', memberIds: [3, 4], userId: 7 });
        expect(spies.dispatchMembers).toHaveBeenCalledWith('R1', [3, 4], 7);
    });

    it('request:add_responder → addResponderToRequest(requestId, memberId, actor)', async () => {
        await call('request:add_responder', { requestId: 'R1', memberId: 3, userId: 7 });
        expect(spies.addResponderToRequest).toHaveBeenCalledWith('R1', 3, 7);
    });

    it('request:remove_responder → removeResponderFromRequest(requestId, memberId)', async () => {
        await call('request:remove_responder', { requestId: 'R1', memberId: 3, userId: 7 });
        expect(spies.removeResponderFromRequest).toHaveBeenCalledWith('R1', 3);
    });

    it('request:set_lead → setLeadResponder(requestId, memberId, actor)', async () => {
        await call('request:set_lead', { requestId: 'R1', memberId: 3, userId: 7 });
        expect(spies.setLeadResponder).toHaveBeenCalledWith('R1', 3, 7);
    });

    it('request:add_party_member / remove_party_member forward the handle', async () => {
        await call('request:add_party_member', { requestId: 'R1', handle: 'Wingman_1' });
        await call('request:remove_party_member', { requestId: 'R1', handle: 'Wingman_1' });
        expect(spies.addRequestPartyMember).toHaveBeenCalledWith('R1', 'Wingman_1');
        expect(spies.removeRequestPartyMember).toHaveBeenCalledWith('R1', 'Wingman_1');
    });

    it('request:delete and admin:delete_request both delete the addressed request', async () => {
        spies.deleteServiceRequest.mockResolvedValue(true);
        await expect(call('request:delete', { requestId: 'R1' })).resolves.toBe(true);
        await expect(call('admin:delete_request', { requestId: 'R2' })).resolves.toBe(true);
        expect(spies.deleteServiceRequest.mock.calls).toEqual([['R1'], ['R2']]);
    });

    it('a db-layer rejection on a pass-through handler propagates unchanged', async () => {
        spies.setLeadResponder.mockRejectedValue(new Error('Lead must be a responder'));
        await expect(call('request:set_lead', { requestId: 'R1', memberId: 3, userId: 7 })).rejects.toThrow('Lead must be a responder');
    });
});
