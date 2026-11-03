import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Handler-level suite for api/actions/intel.ts.
//
// Complements tests/intelBulletinEgress.test.ts (which runs the REAL
// bulletinIsRestricted against a stateful fake) and tests/intelReadPathScoping.test.ts.
// Here the db layer is fully mocked so every handler's wiring is pinned:
//   * every clearance-scoped read returns what db.filterIntelByClearance returned
//     for THE INJECTED USER — never the raw db rows;
//   * intel:get_dossier withholds warrants without warrant:view and service-request
//     bodies without a request-duty permission (no role-name bypass);
//   * intel:list silently drops the warrantsOnly filter for a non-warrant:view caller
//     (the filter itself discloses who is under warrant) and passes the viewer through
//     for the SQL clearance ceiling;
//   * the AI-metered handlers throttle on the server user id before any db call;
//   * intel:create_bulletin egress: push + Discord carry content only for an
//     unrestricted bulletin, a push failure does not stop the Discord notice, and
//     every Discord/settings failure is swallowed so the create still returns.

type Call = { method: string; args: unknown[] };

const h = vi.hoisted(() => ({
    queries: [] as Array<{ table: string; calls: Call[] }>,
    settingsData: null as unknown,
    settingsThrows: false,
}));

const spies = vi.hoisted(() => ({
    createWarrant: vi.fn(),
    updateWarrant: vi.fn(),
    deleteWarrant: vi.fn(),
    generateReportFromWarrant: vi.fn(),
    addWarrantNote: vi.fn(),
    getWarrantNotes: vi.fn(),
    createIntelReport: vi.fn(),
    updateIntelReport: vi.fn(),
    getIntelReportsForTarget: vi.fn(),
    filterIntelByClearance: vi.fn(),
    getDossier: vi.fn(),
    getRecentIntelReports: vi.fn(),
    listIntelReports: vi.fn(),
    getIntelHubStats: vi.fn(),
    deleteIntelReport: vi.fn(),
    searchIntelReports: vi.fn(),
    updateIntelAffiliation: vi.fn(),
    bulkUpdateIntelAffiliation: vi.fn(),
    bulkAddIntelTags: vi.fn(),
    bulkDeleteIntelReports: vi.fn(),
    getIntelStats: vi.fn(),
    syncTrustedFeeds: vi.fn(),
    createIntelBulletin: vi.fn(),
    bulletinIsRestricted: vi.fn(),
    deleteIntelBulletin: vi.fn(),
    getActiveBulletins: vi.fn(),
    getTrustedFeeds: vi.fn(),
    addTrustedFeed: vi.fn(),
    deleteTrustedFeed: vi.fn(),
    updateTrustedFeed: vi.fn(),
    syncWarrantsToReports: vi.fn(),
    deduplicateWarrants: vi.fn(),
    deduplicateIntelReports: vi.fn(),
    generateDossierSummary: vi.fn(),
    assertAiRateLimit: vi.fn(),
    sendPushToStaff: vi.fn(),
    sendDiscordChannelMessage: vi.fn(),
}));

vi.mock('../lib/db', () => {
    function builder(table: string) {
        const calls: Call[] = [];
        h.queries.push({ table, calls });
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'in']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
            const p = h.settingsThrows
                ? Promise.reject(new Error('settings read blew up'))
                : Promise.resolve({ data: h.settingsData, error: null });
            return p.then(res, rej);
        };
        return b;
    }
    const { generateDossierSummary: _a, assertAiRateLimit: _b, sendPushToStaff: _c, sendDiscordChannelMessage: _d, ...dbFns } = spies;
    return { supabase: { from: (t: string) => builder(t) }, ...dbFns };
});
vi.mock('../lib/ai', () => ({ generateDossierSummary: spies.generateDossierSummary }));
vi.mock('../lib/aiRateLimit', () => ({ assertAiRateLimit: spies.assertAiRateLimit }));
vi.mock('../lib/push', () => ({ sendPushToStaff: spies.sendPushToStaff }));
vi.mock('../lib/discord', () => ({ sendDiscordChannelMessage: spies.sendDiscordChannelMessage }));

import { intelActions } from '../api/actions/intel';

type Handler = (p?: unknown) => unknown;
const call = (name: string, p?: unknown) => (intelActions as unknown as Record<string, Handler>)[name](p);

// A deterministic stand-in for the clearance filter: drops every item flagged
// `classified`. It lets each test observe that the handler returns the FILTERED
// list (not the raw db rows) without re-testing lib/clearance itself.
const fakeFilter = (items: Array<{ classified?: boolean }> | null | undefined) => (items || []).filter((i) => !i.classified);

const OPEN = { id: 'r-open', summary: 'routine sighting' };
const CLASSIFIED = { id: 'r-classified', summary: 'TOP SECRET staging', classified: true };

const viewer = (permissions: string[] = ['intel:view']) => ({
    id: 7, permissions, clearanceLevel: { level: 1 }, limitingMarkers: [], isSystemAdmin: false,
});

type Embed = {
    title: string;
    description: string;
    color: number;
    fields: Array<{ name: string; value: string; inline?: boolean }>;
    timestamp: string;
    footer: { text: string; icon_url?: string };
};
const embed = () => (spies.sendDiscordChannelMessage.mock.calls[0][1] as { embeds: Embed[] }).embeds[0];
const field = (name: string) => embed().fields.find((f) => f.name === name)?.value;
const push = () => spies.sendPushToStaff.mock.calls[0][0] as { title: string; body: string; tag: string; data: Record<string, unknown> };

// The Discord notice is fire-and-forget; drain its promise chain without timers.
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

const NOW = new Date('2026-11-02T03:04:05.000Z');

const BULLETIN = {
    id: 'b-1',
    title: 'Nightjar sighted',
    body: 'Nightjar wing staging at the Yela belt, 14 hulls, departs 0300. '.repeat(3),
    threatLevel: 'Critical',
    location: 'Yela Belt Cluster 7',
    durationMinutes: 60,
    expiresAt: '2026-11-02T04:04:05.000Z',
    classificationLevel: 0,
    limitingMarkers: [],
    createdById: 7,
    createdAt: NOW.toISOString(),
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    h.queries = [];
    h.settingsThrows = false;
    h.settingsData = [
        { key: 'discordConfig', value: { intelChannelId: 'intel-chan' } },
        { key: 'brandingConfig', value: { name: 'Acme Corp', iconUrl: 'https://cdn.example/i.png' } },
    ];
    for (const s of Object.values(spies)) s.mockReset();
    spies.filterIntelByClearance.mockImplementation(fakeFilter);
    spies.createIntelBulletin.mockResolvedValue({ ...BULLETIN });
    spies.bulletinIsRestricted.mockResolvedValue(false);
    spies.sendPushToStaff.mockResolvedValue(undefined);
    spies.sendDiscordChannelMessage.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('warrant handlers', () => {
    it('warrant:create forwards the payload and the forced actor id', async () => {
        const payload = { targetName: 'Jane', reason: 'piracy', userId: 7 };
        spies.createWarrant.mockResolvedValue({ id: 'w1' });
        await expect(call('warrant:create', payload)).resolves.toEqual({ id: 'w1' });
        expect(spies.createWarrant).toHaveBeenCalledWith(payload, 7);
    });

    it('warrant:update addresses the warrant by id and passes the payload as the update', async () => {
        const payload = { warrantId: 'w1', status: 'Closed' };
        await call('warrant:update', payload);
        expect(spies.updateWarrant).toHaveBeenCalledWith('w1', payload);
    });

    it('warrant:delete / warrant:get_notes address the warrant by id', async () => {
        spies.getWarrantNotes.mockResolvedValue([{ id: 1 }]);
        await call('warrant:delete', { warrantId: 'w1' });
        await expect(call('warrant:get_notes', { warrantId: 'w2' })).resolves.toEqual([{ id: 1 }]);
        expect(spies.deleteWarrant).toHaveBeenCalledWith('w1');
        expect(spies.getWarrantNotes).toHaveBeenCalledWith('w2');
    });

    it('warrant:add_note attributes the note to the actor', async () => {
        await call('warrant:add_note', { warrantId: 'w1', content: 'seen at Lorville', userId: 7 });
        expect(spies.addWarrantNote).toHaveBeenCalledWith('w1', 'seen at Lorville', 7);
    });

    it('warrant:generate_report throttles on the actor id, then generates', async () => {
        spies.generateReportFromWarrant.mockResolvedValue({ id: 'r9' });
        await expect(call('warrant:generate_report', { warrantId: 'w1', userId: 7 })).resolves.toEqual({ id: 'r9' });
        expect(spies.assertAiRateLimit).toHaveBeenCalledWith(7);
        expect(spies.generateReportFromWarrant).toHaveBeenCalledWith('w1', 7);
    });

    it('warrant:generate_report: a throttle rejection stops the metered call', () => {
        spies.assertAiRateLimit.mockImplementation(() => { throw new Error('AI rate limit exceeded'); });
        expect(() => call('warrant:generate_report', { warrantId: 'w1', userId: 7 })).toThrow('AI rate limit exceeded');
        expect(spies.generateReportFromWarrant).not.toHaveBeenCalled();
    });
});

describe('report write handlers', () => {
    it('intel:create_report passes a shallow copy of the payload', async () => {
        const payload = { targetId: 'Jane', summary: 'x', user: viewer() };
        await call('intel:create_report', payload);
        const passed = spies.createIntelReport.mock.calls[0][0];
        expect(passed).toEqual(payload);
        expect(passed).not.toBe(payload);
    });

    it('intel:update_report / delete_report / update_affiliation forward ids and values', async () => {
        await call('intel:update_report', { id: 'r1', updates: { summary: 'new' } });
        await call('intel:delete_report', { reportId: 'r2' });
        await call('intel:update_affiliation', { targetId: 'Jane', affiliatedOrg: 'NINE' });
        expect(spies.updateIntelReport).toHaveBeenCalledWith('r1', { summary: 'new' });
        expect(spies.deleteIntelReport).toHaveBeenCalledWith('r2');
        expect(spies.updateIntelAffiliation).toHaveBeenCalledWith('Jane', 'NINE');
    });

    it('bulk handlers forward the id arrays and values', async () => {
        await call('intel:bulk_update_affiliation', { reportIds: ['a', 'b'], affiliatedOrg: 'NINE' });
        await call('intel:bulk_add_tags', { reportIds: ['a'], tags: ['pirate'] });
        await call('intel:bulk_delete_reports', { reportIds: ['c'] });
        expect(spies.bulkUpdateIntelAffiliation).toHaveBeenCalledWith(['a', 'b'], 'NINE');
        expect(spies.bulkAddIntelTags).toHaveBeenCalledWith(['a'], ['pirate']);
        expect(spies.bulkDeleteIntelReports).toHaveBeenCalledWith(['c']);
    });

    it('intel:sync_feeds forwards force, and tolerates a missing payload', async () => {
        await call('intel:sync_feeds', { force: true });
        await call('intel:sync_feeds');
        expect(spies.syncTrustedFeeds.mock.calls).toEqual([[true], [undefined]]);
    });
});

describe('clearance-scoped reads return the filtered list for the injected user', () => {
    it('intel:get_reports', async () => {
        const user = viewer();
        spies.getIntelReportsForTarget.mockResolvedValue([OPEN, CLASSIFIED]);
        await expect(call('intel:get_reports', { targetId: 'Jane', user })).resolves.toEqual([OPEN]);
        expect(spies.getIntelReportsForTarget).toHaveBeenCalledWith('Jane');
        expect(spies.filterIntelByClearance).toHaveBeenCalledWith([OPEN, CLASSIFIED], user);
    });

    it('intel:get_recent (with and without a subject type)', async () => {
        const user = viewer();
        spies.getRecentIntelReports.mockResolvedValue([CLASSIFIED, OPEN]);
        await expect(call('intel:get_recent', { subjectType: 'Organization', user })).resolves.toEqual([OPEN]);
        expect(spies.getRecentIntelReports).toHaveBeenCalledWith('Organization');
        expect(spies.filterIntelByClearance).toHaveBeenLastCalledWith([CLASSIFIED, OPEN], user);
    });

    it('intel:get_recent with no payload filters as an anonymous viewer (fails closed)', async () => {
        spies.getRecentIntelReports.mockResolvedValue([CLASSIFIED]);
        await expect(call('intel:get_recent')).resolves.toEqual([]);
        expect(spies.getRecentIntelReports).toHaveBeenCalledWith(undefined);
        expect(spies.filterIntelByClearance).toHaveBeenCalledWith([CLASSIFIED], undefined);
    });

    it('intel:search', async () => {
        const user = viewer();
        spies.searchIntelReports.mockResolvedValue([OPEN, CLASSIFIED]);
        await expect(call('intel:search', { query: 'nightjar', subjectType: 'Individual', user })).resolves.toEqual([OPEN]);
        expect(spies.searchIntelReports).toHaveBeenCalledWith('nightjar', 'Individual');
        expect(spies.filterIntelByClearance).toHaveBeenCalledWith([OPEN, CLASSIFIED], user);
    });

    it('intel:get_bulletins', async () => {
        const user = viewer();
        spies.getActiveBulletins.mockResolvedValue([CLASSIFIED, OPEN]);
        await expect(call('intel:get_bulletins', { user })).resolves.toEqual([OPEN]);
        expect(spies.filterIntelByClearance).toHaveBeenCalledWith([CLASSIFIED, OPEN], user);
    });

    it('a db read failure propagates instead of returning an empty (misleading) list', async () => {
        spies.getIntelReportsForTarget.mockRejectedValue(new Error('Failed to load reports'));
        await expect(call('intel:get_reports', { targetId: 'Jane', user: viewer() })).rejects.toThrow('Failed to load reports');
        expect(spies.filterIntelByClearance).not.toHaveBeenCalled();
    });

    it('intel:hub_stats / intel:get_stats pass the viewer for the server-side ceiling', async () => {
        const user = viewer();
        spies.getIntelHubStats.mockResolvedValue({ total: 3 });
        spies.getIntelStats.mockResolvedValue({ total: 4 });
        await expect(call('intel:hub_stats', { user })).resolves.toEqual({ total: 3 });
        await expect(call('intel:get_stats', { user })).resolves.toEqual({ total: 4 });
        expect(spies.getIntelHubStats).toHaveBeenCalledWith(user);
        expect(spies.getIntelStats).toHaveBeenCalledWith(user);
    });
});

describe('intel:get_dossier gates', () => {
    const DOSSIER = {
        targetId: 'Jane',
        reports: [OPEN, CLASSIFIED],
        warrants: [{ id: 'w1', status: 'Active' }],
        requests: [{ id: 'req1', description: 'client PII' }],
        operations: [{ id: 'op1' }],
        affiliates: [{ targetId: 'Bob' }],
    };

    beforeEach(() => {
        spies.getDossier.mockResolvedValue(structuredClone(DOSSIER));
    });

    it('fetches with the user, filters reports, and withholds warrants + requests from a plain intel:view caller', async () => {
        const user = viewer(['intel:view']);
        const out = await call('intel:get_dossier', { targetId: 'Jane', user });
        expect(spies.getDossier).toHaveBeenCalledWith('Jane', user);
        expect(out).toEqual({
            targetId: 'Jane',
            reports: [OPEN],
            warrants: [],
            requests: [],
            operations: [{ id: 'op1' }],
            affiliates: [{ targetId: 'Bob' }],
        });
        expect(JSON.stringify(out)).not.toContain('client PII');
        expect(JSON.stringify(out)).not.toContain('TOP SECRET');
    });

    it('a warrant:view holder receives the warrants (but still no requests without request duty)', async () => {
        const out = await call('intel:get_dossier', { targetId: 'Jane', user: viewer(['intel:view', 'warrant:view']) }) as typeof DOSSIER;
        expect(out.warrants).toEqual(DOSSIER.warrants);
        expect(out.requests).toEqual([]);
    });

    it.each(['request:dispatch', 'request:triage', 'request:accept'])('a %s holder receives the request bodies', async (perm) => {
        const out = await call('intel:get_dossier', { targetId: 'Jane', user: viewer([perm]) }) as typeof DOSSIER;
        expect(out.requests).toEqual(DOSSIER.requests);
        expect(out.warrants).toEqual([]);
    });

    it('a non-duty request permission (request:create) does not unlock the request bodies', async () => {
        const out = await call('intel:get_dossier', { targetId: 'Jane', user: viewer(['request:create', 'request:view']) }) as typeof DOSSIER;
        expect(out.requests).toEqual([]);
    });

    it('a missing user fails closed on every gated surface', async () => {
        const out = await call('intel:get_dossier', { targetId: 'Jane' }) as typeof DOSSIER;
        expect(spies.getDossier).toHaveBeenCalledWith('Jane', undefined);
        expect(out.warrants).toEqual([]);
        expect(out.requests).toEqual([]);
        expect(out.reports).toEqual([OPEN]);
    });

    it('a non-array permissions value fails closed (no substring match through String#includes)', async () => {
        const forged = { ...viewer(), permissions: 'warrant:view request:dispatch' as unknown as string[] };
        const out = await call('intel:get_dossier', { targetId: 'Jane', user: forged }) as typeof DOSSIER;
        expect(out.warrants).toEqual([]);
        expect(out.requests).toEqual([]);
    });
});

describe('intel:list', () => {
    const PAGE = { items: [OPEN, CLASSIFIED], nextCursor: 'c2', total: 2 };

    beforeEach(() => {
        spies.listIntelReports.mockResolvedValue({ ...PAGE });
    });

    it('passes every filter plus the viewer, and returns only filtered items with the page metadata intact', async () => {
        const user = viewer(['intel:view', 'warrant:view']);
        const out = await call('intel:list', {
            limit: 25, cursor: 'c1', threatLevel: 'High', subjectType: 'Individual', tag: 'pirate', warrantsOnly: true, q: 'jane', user,
        });
        expect(spies.listIntelReports).toHaveBeenCalledWith({
            limit: 25, cursor: 'c1', threatLevel: 'High', subjectType: 'Individual', tag: 'pirate', warrantsOnly: true, q: 'jane', viewer: user,
        });
        expect(spies.filterIntelByClearance).toHaveBeenCalledWith([OPEN, CLASSIFIED], user);
        expect(out).toEqual({ items: [OPEN], nextCursor: 'c2', total: 2 });
    });

    it('drops warrantsOnly for a caller without warrant:view (the filter itself is a warrant read)', async () => {
        await call('intel:list', { warrantsOnly: true, user: viewer(['intel:view']) });
        expect(spies.listIntelReports.mock.calls[0][0]).toMatchObject({ warrantsOnly: undefined });
    });

    it('drops warrantsOnly when the user is missing', async () => {
        await call('intel:list', { warrantsOnly: true });
        expect(spies.listIntelReports.mock.calls[0][0]).toMatchObject({ warrantsOnly: undefined, viewer: undefined });
    });
});

describe('intel:generate_summary', () => {
    it('trims the target id, refetches the dossier for the user, and summarises the fresh copy', async () => {
        const user = viewer(['intel:manage']);
        spies.getDossier.mockResolvedValue({ targetId: 'Jane', reports: [OPEN] });
        spies.generateDossierSummary.mockResolvedValue('synthesis');
        await expect(call('intel:generate_summary', { dossier: { targetId: '  Jane  ', reports: [CLASSIFIED] }, user })).resolves.toBe('synthesis');
        expect(spies.assertAiRateLimit).toHaveBeenCalledWith(7);
        expect(spies.getDossier).toHaveBeenCalledWith('Jane', user);
        expect(spies.generateDossierSummary).toHaveBeenCalledWith({ targetId: 'Jane', reports: [OPEN] });
    });

    it.each([
        ['a whitespace-only target id', { targetId: '   ' }],
        ['a non-string target id', { targetId: 42 }],
        ['no dossier at all', undefined],
    ])('rejects %s before any db or AI call', async (_label, dossier) => {
        await expect(call('intel:generate_summary', { dossier, user: viewer() })).rejects.toThrow('A target is required to generate a summary.');
        expect(spies.getDossier).not.toHaveBeenCalled();
        expect(spies.generateDossierSummary).not.toHaveBeenCalled();
    });

    it('a throttle rejection stops the call before the dossier is read', async () => {
        spies.assertAiRateLimit.mockImplementation(() => { throw new Error('AI rate limit exceeded'); });
        await expect(call('intel:generate_summary', { dossier: { targetId: 'Jane' }, user: viewer() })).rejects.toThrow('AI rate limit exceeded');
        expect(spies.getDossier).not.toHaveBeenCalled();
    });
});

describe('intel:create_bulletin — egress', () => {
    const create = (over: Record<string, unknown> = {}) => call('intel:create_bulletin', { title: 'x', user: viewer(), ...over });

    it('forwards the payload, probes restriction by the new id, and returns the bulletin', async () => {
        const payload = { title: 'Nightjar sighted', classificationLevel: 0, user: viewer() };
        await expect(call('intel:create_bulletin', payload)).resolves.toEqual(BULLETIN);
        expect(spies.createIntelBulletin).toHaveBeenCalledWith(payload);
        expect(spies.bulletinIsRestricted).toHaveBeenCalledWith('b-1');
    });

    it('unrestricted: the push carries the title and a 120-char body, with an id-only deep link', async () => {
        await create();
        expect(spies.sendPushToStaff).toHaveBeenCalledTimes(1);
        expect(push()).toEqual({
            title: 'Intel Bulletin: Nightjar sighted',
            body: BULLETIN.body.substring(0, 120),
            tag: 'bulletin-b-1',
            data: { type: 'bulletin', bulletinId: 'b-1' },
        });
        expect(push().body).toHaveLength(120);
    });

    it('unrestricted: the Discord embed carries the content, the threat colour, and the branding', async () => {
        await create();
        await flush();
        expect(spies.sendDiscordChannelMessage).toHaveBeenCalledTimes(1);
        expect(spies.sendDiscordChannelMessage.mock.calls[0][0]).toBe('intel-chan');
        expect(embed()).toEqual({
            title: '📡 INTEL BULLETIN: Nightjar sighted',
            description: BULLETIN.body.trim(),
            color: 0xef4444,
            fields: [
                { name: 'Threat Level', value: 'Critical', inline: true },
                { name: 'Location', value: 'Yela Belt Cluster 7', inline: true },
                { name: 'Classification', value: 'Unclassified', inline: true },
                { name: 'Duration', value: `Expires ${new Date(BULLETIN.expiresAt).toUTCString()}`, inline: false },
            ],
            timestamp: NOW.toISOString(),
            footer: { text: 'Acme Corp Intel Division', icon_url: 'https://cdn.example/i.png' },
        });
        // toUTCString is zone-independent: the same text under AEST and UTC.
        expect(field('Duration')).toBe('Expires Mon, 02 Nov 2026 04:04:05 GMT');
        const settings = h.queries.filter((q) => q.table === 'settings');
        expect(settings).toHaveLength(1);
        expect(settings[0].calls).toEqual([
            { method: 'select', args: ['key, value'] },
            { method: 'in', args: ['key', ['discordConfig', 'brandingConfig']] },
        ]);
    });

    it.each([
        ['High', 0xf97316],
        ['Medium', 0xf59e0b],
        ['Low', 0x38bdf8],
        ['None', 0x64748b],
    ])('unrestricted: threat %s maps to its colour', async (threatLevel, color) => {
        spies.createIntelBulletin.mockResolvedValue({ ...BULLETIN, threatLevel });
        await create();
        await flush();
        expect(embed().color).toBe(color);
    });

    it('unrestricted: a pinned (durationMinutes 0) bulletin reads "Indefinite (Pinned)", not its 9999 sentinel expiry', async () => {
        spies.createIntelBulletin.mockResolvedValue({ ...BULLETIN, durationMinutes: 0, expiresAt: '9999-12-31T23:59:59.000Z' });
        await create();
        await flush();
        expect(field('Duration')).toBe('Indefinite (Pinned)');
    });

    it('unrestricted: no location → no Location field; no expiry → "No expiry"; empty title/body → fallbacks', async () => {
        spies.createIntelBulletin.mockResolvedValue({ ...BULLETIN, title: '  ', body: '', location: null, expiresAt: '' });
        await create();
        await flush();
        const e = embed();
        expect(e.title).toBe('📡 INTEL BULLETIN: Untitled');
        expect(e.description).toBe('No details provided.');
        expect(e.fields.map((f) => f.name)).toEqual(['Threat Level', 'Classification', 'Duration']);
        expect(field('Duration')).toBe('No expiry');
    });

    it('unrestricted: an over-long body is capped at 1024 characters in the embed', async () => {
        spies.createIntelBulletin.mockResolvedValue({ ...BULLETIN, body: 'z'.repeat(2000) });
        await create();
        await flush();
        expect(embed().description).toBe('z'.repeat(1021) + '...');
    });

    it('restricted at Level > 0: generic push + level-stating notice, no title/body/location/threat anywhere', async () => {
        spies.bulletinIsRestricted.mockResolvedValue(true);
        spies.createIntelBulletin.mockResolvedValue({ ...BULLETIN, classificationLevel: 4 });
        await create();
        await flush();
        expect(push()).toEqual({
            title: 'New Classified Intel Bulletin',
            body: 'A classified bulletin was posted — view it in the terminal (clearance required).',
            tag: 'bulletin-b-1',
            data: { type: 'bulletin', bulletinId: 'b-1' },
        });
        expect(embed()).toEqual({
            title: '📡 CLASSIFIED INTEL BULLETIN',
            description: 'A Level 4 intel bulletin was posted. Access it in the operations terminal (clearance required).',
            color: 0x64748b,
            fields: [{ name: 'Classification', value: 'Level 4', inline: true }],
            timestamp: NOW.toISOString(),
            footer: { text: 'Acme Corp Intel Division', icon_url: 'https://cdn.example/i.png' },
        });
        const egress = JSON.stringify([spies.sendPushToStaff.mock.calls, spies.sendDiscordChannelMessage.mock.calls]);
        for (const leak of ['Nightjar', 'Yela', 'Critical', 'Unclassified']) expect(egress).not.toContain(leak);
    });

    it('restricted with a missing classification level reads as "Restricted", never "Level 0"', async () => {
        spies.bulletinIsRestricted.mockResolvedValue(true);
        const { classificationLevel: _drop, ...noLevel } = BULLETIN;
        spies.createIntelBulletin.mockResolvedValue(noLevel);
        await create();
        await flush();
        expect(embed().description).toBe('A restricted intel bulletin was posted. Access it in the operations terminal (clearance required).');
        expect(embed().fields).toEqual([{ name: 'Classification', value: 'Restricted', inline: true }]);
    });

    it('FAIL-CLOSED: a rejected restriction probe is treated as restricted and the create still returns', async () => {
        spies.bulletinIsRestricted.mockRejectedValue(new Error('probe failed'));
        await expect(create()).resolves.toEqual(BULLETIN);
        await flush();
        expect(push().title).toBe('New Classified Intel Bulletin');
        expect(embed().title).toBe('📡 CLASSIFIED INTEL BULLETIN');
        expect(JSON.stringify(spies.sendDiscordChannelMessage.mock.calls)).not.toContain('Nightjar');
    });

    it('a push failure is swallowed and the Discord notice still goes out', async () => {
        spies.sendPushToStaff.mockRejectedValue(new Error('web-push 410'));
        await expect(create()).resolves.toEqual(BULLETIN);
        await flush();
        expect(spies.sendDiscordChannelMessage).toHaveBeenCalledTimes(1);
    });

    it('a Discord send failure is swallowed (the create already returned)', async () => {
        spies.sendDiscordChannelMessage.mockRejectedValue(new Error('discord 500'));
        await expect(create()).resolves.toEqual(BULLETIN);
        await flush();
        expect(spies.sendDiscordChannelMessage).toHaveBeenCalledTimes(1);
    });

    it('a settings read failure is swallowed and nothing is posted', async () => {
        h.settingsThrows = true;
        await expect(create()).resolves.toEqual(BULLETIN);
        await flush();
        expect(spies.sendDiscordChannelMessage).not.toHaveBeenCalled();
        expect(spies.sendPushToStaff).toHaveBeenCalledTimes(1);
    });

    it('no intel channel configured → no Discord post (push still sent)', async () => {
        h.settingsData = [{ key: 'brandingConfig', value: { name: 'Acme Corp' } }];
        await create();
        await flush();
        expect(spies.sendDiscordChannelMessage).not.toHaveBeenCalled();
        expect(spies.sendPushToStaff).toHaveBeenCalledTimes(1);
    });

    it('a null settings read → no Discord post', async () => {
        h.settingsData = null;
        await create();
        await flush();
        expect(spies.sendDiscordChannelMessage).not.toHaveBeenCalled();
    });

    it('no branding row → default footer; a non-http icon is never attached', async () => {
        h.settingsData = [{ key: 'discordConfig', value: { intelChannelId: 'intel-chan' } }];
        await create();
        await flush();
        expect(embed().footer).toEqual({ text: 'Organization Intel Division' });

        spies.sendDiscordChannelMessage.mockClear();
        spies.bulletinIsRestricted.mockResolvedValue(true);
        h.settingsData = [
            { key: 'discordConfig', value: { intelChannelId: 'intel-chan' } },
            { key: 'brandingConfig', value: { name: '', iconUrl: 'data:image/png;base64,AAAA' } },
        ];
        await create();
        await flush();
        expect(embed().footer).toEqual({ text: 'Organization Intel Division' });
    });

    it('a create failure propagates and nothing is probed, pushed or posted', async () => {
        spies.createIntelBulletin.mockRejectedValue(new Error('Failed to create intel bulletin'));
        await expect(create()).rejects.toThrow('Failed to create intel bulletin');
        await flush();
        expect(spies.bulletinIsRestricted).not.toHaveBeenCalled();
        expect(spies.sendPushToStaff).not.toHaveBeenCalled();
        expect(spies.sendDiscordChannelMessage).not.toHaveBeenCalled();
    });

    it('intel:delete_bulletin forwards the id', async () => {
        await call('intel:delete_bulletin', { bulletinId: 'b-9' });
        expect(spies.deleteIntelBulletin).toHaveBeenCalledWith('b-9');
    });
});

describe('admin intel handlers', () => {
    it('trusted-feed CRUD forwards exactly its arguments', async () => {
        spies.getTrustedFeeds.mockResolvedValue([{ id: 'f1', label: 'Ally' }]);
        await expect(call('admin:get_trusted_feeds')).resolves.toEqual([{ id: 'f1', label: 'Ally' }]);
        await call('admin:add_trusted_feed', { label: 'Ally', url: 'https://ally.example', apiKey: 'ak_live' });
        await call('admin:delete_trusted_feed', { feedId: 'f1' });
        await call('admin:update_trusted_feed', { feedId: 'f1', updates: { syncReports: false, inboundMaxClearance: 2 } });
        expect(spies.addTrustedFeed).toHaveBeenCalledWith('Ally', 'https://ally.example', 'ak_live');
        expect(spies.deleteTrustedFeed).toHaveBeenCalledWith('f1');
        expect(spies.updateTrustedFeed).toHaveBeenCalledWith('f1', { syncReports: false, inboundMaxClearance: 2 });
    });

    it('maintenance handlers forward the admin id or nothing', async () => {
        spies.deduplicateWarrants.mockResolvedValue({ removed: 2 });
        spies.deduplicateIntelReports.mockResolvedValue({ removed: 3 });
        await call('admin:sync_warrants_to_reports', { adminId: 1 });
        await expect(call('admin:deduplicate_warrants')).resolves.toEqual({ removed: 2 });
        await expect(call('admin:deduplicate_intel')).resolves.toEqual({ removed: 3 });
        expect(spies.syncWarrantsToReports).toHaveBeenCalledWith(1);
        expect(spies.deduplicateWarrants).toHaveBeenCalledWith();
        expect(spies.deduplicateIntelReports).toHaveBeenCalledWith();
    });
});
