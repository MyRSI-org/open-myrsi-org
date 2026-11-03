import { describe, it, expect, vi, beforeEach } from 'vitest';

// EGRESS GATE for intel bulletins -> staff push + Discord.
//
// intel:create_bulletin has TWO unfiltered egress paths: sendPushToStaff (every
// staff member, lands on lock screens) and the Discord intel-channel embed (every
// member who can read the channel). Neither can filter per recipient, while the
// in-app read path (filterIntelByClearance → passesClearance) hides a bulletin
// on clearance level AND limiting markers. Both gates used to test the level
// only, so a Level-0 compartmented bulletin posted in full. Both now share
// lib/db/intel.ts bulletinIsRestricted, which this file runs for real against a
// stateful supabase fake — a stubbed predicate would make every assertion vacuous.
//
// The same file pins createIntelBulletin's ordering: markers validated before
// the row exists, a failed junction insert rolls the row back, and nothing is
// broadcast / pushed / posted until everything has succeeded.

type Call = { method: string; args: unknown[] };

const h = vi.hoisted(() => ({
    // Stateful: the inserted bulletin row, and the junction rows attached to it.
    rows: new Map<string, { classification_level: number }>(),
    junction: [] as Array<{ bulletin_id: string; marker_id: number }>,
    nextId: 1,
    // Fault injection.
    validMarkerIds: [] as number[],
    markerReadError: null as unknown,
    junctionError: null as unknown,
    rowReadError: null as unknown,
    rowReadThrows: false,
    markerCountError: null as unknown,
    // Observations.
    queries: [] as Array<{ table: string; calls: Call[] }>,
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    // Settled queries and broadcasts, in the order they happened.
    timeline: [] as string[],
}));

vi.mock('../lib/db/common', () => {
    function resolve(table: string, calls: Call[]) {
        const has = (m: string) => calls.some((c) => c.method === m);
        const arg = (m: string, i = 0) => calls.find((c) => c.method === m)?.args[i];
        if (table === 'security_limiting_markers') {
            if (h.markerReadError) return { data: null, error: h.markerReadError };
            const wanted = (arg('in', 1) as number[]) || [];
            return { data: wanted.filter((id) => h.validMarkerIds.includes(id)).map((id) => ({ id })), error: null };
        }
        if (table === 'intel_bulletins') {
            if (has('insert')) {
                const ins = arg('insert') as Record<string, unknown>;
                const id = `b-${h.nextId++}`;
                const row = {
                    id, title: ins.title, body: ins.body, threat_level: ins.threat_level, location: ins.location,
                    duration_minutes: ins.duration_minutes, expires_at: ins.expires_at,
                    classification_level: ins.classification_level as number, created_by_id: ins.created_by_id ?? null,
                    created_at: '2026-11-02T00:00:00.000Z', shared_with_allies: ins.shared_with_allies,
                    source_organization_id: null, source_bulletin_id: null, source_organization_name: null,
                };
                h.rows.set(id, { classification_level: row.classification_level });
                return { data: row, error: null };
            }
            if (has('delete')) {
                h.rows.delete(arg('eq', 1) as string);
                return { data: null, error: null };
            }
            // bulletinIsRestricted's row probe.
            if (h.rowReadThrows) throw new Error('socket hang up');
            if (h.rowReadError) return { data: null, error: h.rowReadError };
            const r = h.rows.get(arg('eq', 1) as string);
            return { data: r ? { classification_level: r.classification_level } : null, error: null };
        }
        if (table === 'intel_bulletin_limiting_markers') {
            if (has('insert')) {
                if (h.junctionError) return { data: null, error: h.junctionError };
                h.junction.push(...(arg('insert') as Array<{ bulletin_id: string; marker_id: number }>));
                return { data: null, error: null };
            }
            // bulletinIsRestricted's head-only marker count.
            if (h.markerCountError) return { data: null, count: null, error: h.markerCountError };
            const id = arg('eq', 1) as string;
            return { data: null, count: h.junction.filter((j) => j.bulletin_id === id).length, error: null };
        }
        if (table === 'settings') {
            return {
                data: [
                    { key: 'discordConfig', value: { intelChannelId: '123456789012345678' } },
                    { key: 'brandingConfig', value: { name: 'Acme Corp', iconUrl: '' } },
                ],
                error: null,
            };
        }
        return { data: null, error: null };
    }
    function builder(table: string) {
        const calls: Call[] = [];
        const q = { table, calls };
        h.queries.push(q);
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'lt', 'insert', 'delete', 'update', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => {
            const op = calls.some((c) => c.method === 'insert') ? 'insert' : calls.some((c) => c.method === 'delete') ? 'delete' : 'read';
            h.timeline.push(`${table}:${op}`);
            return Promise.resolve(resolve(table, calls));
        };
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (res: any, rej: any) => settle().then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => {
            h.broadcasts.push({ event, payload });
            h.timeline.push(`broadcast:${event}`);
        },
        broadcastToChannel: () => {},
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
    };
});

vi.mock('../lib/secrets', () => ({ getOrgSecret: async () => null }));

// The handler imports the ../lib/db barrel. Route the two functions under test to
// the REAL lib/db/intel implementations (running against the fake above).
vi.mock('../lib/db', async () => {
    const common = await import('../lib/db/common');
    const intel = await import('../lib/db/intel');
    return {
        supabase: common.supabase,
        createIntelBulletin: intel.createIntelBulletin,
        bulletinIsRestricted: intel.bulletinIsRestricted,
    };
});

const spies = vi.hoisted(() => ({
    push: vi.fn(async (_p: Record<string, unknown>) => undefined),
    discord: vi.fn(async (_channelId: string, _msg: { embeds: Array<Record<string, unknown>> }) => undefined),
}));
vi.mock('../lib/push', () => ({ sendPushToStaff: spies.push }));
vi.mock('../lib/discord', () => ({ sendDiscordChannelMessage: spies.discord }));
vi.mock('../lib/ai', () => ({ generateDossierSummary: vi.fn() }));
vi.mock('../lib/aiRateLimit', () => ({ assertAiRateLimit: vi.fn() }));

import { intelActions } from '../api/actions/intel';
import { bulletinIsRestricted, createIntelBulletin } from '../lib/db/intel';

const TITLE = 'Nightjar sighted';
const BODY = 'SECRET: Nightjar wing staging at the Yela belt, 14 hulls, departs 0300.';
const LOCATION = 'Yela Belt Cluster 7';
const MARKER_ID = 7;

// intel:manage bypasses assertCanClassify, so the classification itself is not
// what is under test here.
const manager = { id: 1, role: 'Member', permissions: ['intel:manage'], clearanceLevel: { level: 0 }, limitingMarkers: [] };

const create = (over: Record<string, unknown> = {}) =>
    (intelActions as unknown as Record<string, (p: unknown) => Promise<{ id: string }>>)['intel:create_bulletin']({
        title: TITLE, body: BODY, location: LOCATION, threatLevel: 'Critical',
        classificationLevel: 0, durationMinutes: 60, createdById: 1, user: manager,
        ...over,
    });

// The Discord notice is fire-and-forget; let its microtask chain drain.
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

const pushJson = () => JSON.stringify(spies.push.mock.calls.map((c) => c[0]));
const discordEmbed = () => spies.discord.mock.calls[0]?.[1].embeds[0] as Record<string, unknown> | undefined;
const discordJson = () => JSON.stringify(spies.discord.mock.calls.map((c) => c[1]));

const insertedBulletinRows = () => h.queries.filter((q) => q.table === 'intel_bulletins' && q.calls.some((c) => c.method === 'insert'));

function expectNoContent(json: string) {
    expect(json).not.toContain(TITLE);
    expect(json).not.toContain('Nightjar');
    expect(json).not.toContain('Yela');
    expect(json).not.toContain('SECRET');
}

beforeEach(() => {
    h.rows = new Map();
    h.junction = [];
    h.nextId = 1;
    h.validMarkerIds = [MARKER_ID];
    h.markerReadError = null;
    h.junctionError = null;
    h.rowReadError = null;
    h.rowReadThrows = false;
    h.markerCountError = null;
    h.queries = [];
    h.broadcasts = [];
    h.timeline = [];
    spies.push.mockClear();
    spies.discord.mockClear();
});

describe('intel:create_bulletin — restricted bulletins egress only a generic notice', () => {
    it('Level 0 + a limiting marker: neither the push nor the Discord embed carries title/body/location', async () => {
        await create({ markerIds: [MARKER_ID] });
        await flush();

        expect(spies.push).toHaveBeenCalledTimes(1);
        const push = spies.push.mock.calls[0][0] as { title: string; body: string; data: Record<string, unknown> };
        expect(push.title).toBe('New Classified Intel Bulletin');
        expect(push.body).toBe('A classified bulletin was posted — view it in the terminal (clearance required).');
        // ids only in the deep-link data
        expect(Object.keys(push.data).sort()).toEqual(['bulletinId', 'type']);
        expectNoContent(pushJson());

        expect(spies.discord).toHaveBeenCalledTimes(1);
        const embed = discordEmbed()!;
        expect(embed.title).toBe('📡 CLASSIFIED INTEL BULLETIN');
        expectNoContent(discordJson());
    });

    it('a marker-only notice claims no "Level 0", never names the marker, and does not colour-code the threat', async () => {
        await create({ markerIds: [MARKER_ID] });
        await flush();
        const embed = discordEmbed()!;
        const json = discordJson();
        expect(embed.description).toBe('A restricted intel bulletin was posted. Access it in the operations terminal (clearance required).');
        expect(json).not.toMatch(/Level 0/);
        expect(json).not.toContain('Unclassified');
        expect(json).not.toMatch(/marker/i);
        expect(json).not.toContain('Critical');
        expect((embed.fields as Array<{ name: string; value: string }>)).toEqual([{ name: 'Classification', value: 'Restricted', inline: true }]);
        // Fixed slate, not the Critical red — the threat level is content.
        expect(embed.color).toBe(0x64748b);
    });

    it('Level > 0 keeps the existing level-stating notice (the level IS the restriction)', async () => {
        await create({ classificationLevel: 3 });
        await flush();
        const embed = discordEmbed()!;
        expect(embed.description).toBe('A Level 3 intel bulletin was posted. Access it in the operations terminal (clearance required).');
        expect(embed.color).toBe(0x64748b);
        expectNoContent(discordJson());
        expectNoContent(pushJson());
    });

    it('FAIL-CLOSED: a marker-count read error is treated as restricted', async () => {
        // supabase-js RESOLVES { count: null, error } instead of throwing, so an
        // unread error would read as "no markers" and publish the bulletin in full.
        h.markerCountError = { message: 'boom' };
        await create();
        await flush();
        expect(spies.push).toHaveBeenCalledTimes(1);
        expectNoContent(pushJson());
        expect(spies.discord).toHaveBeenCalledTimes(1);
        expectNoContent(discordJson());
    });

    it('FAIL-CLOSED: a predicate that throws is treated as restricted, and the create still succeeds', async () => {
        // The bulletin is already committed when the probe runs, so a throw must
        // neither fail the action nor fall through to the full-content branch.
        h.rowReadThrows = true;
        await expect(create()).resolves.toMatchObject({ id: 'b-1' });
        await flush();
        expect(spies.push).toHaveBeenCalledTimes(1);
        expectNoContent(pushJson());
        expect(spies.discord).toHaveBeenCalledTimes(1);
        expectNoContent(discordJson());
    });

    it('is not a blanket gag: Level 0 with no markers still egresses the full content', async () => {
        await create();
        await flush();
        const push = spies.push.mock.calls[0][0] as { title: string; body: string };
        expect(push.title).toBe(`Intel Bulletin: ${TITLE}`);
        expect(push.body).toBe(BODY.substring(0, 120));

        const json = discordJson();
        expect(json).toContain(TITLE);
        expect(json).toContain('Nightjar wing staging');
        expect(json).toContain(LOCATION);
        expect(json).toContain('Unclassified');
    });
});

describe('bulletinIsRestricted — fail-closed predicate', () => {
    it('is false only for a present Level-0 row with a readable zero marker count', async () => {
        h.rows.set('b-x', { classification_level: 0 });
        await expect(bulletinIsRestricted('b-x')).resolves.toBe(false);
    });

    it('is true for classification_level > 0', async () => {
        h.rows.set('b-x', { classification_level: 2 });
        await expect(bulletinIsRestricted('b-x')).resolves.toBe(true);
    });

    it('is true when a limiting marker is attached at Level 0', async () => {
        h.rows.set('b-x', { classification_level: 0 });
        h.junction.push({ bulletin_id: 'b-x', marker_id: MARKER_ID });
        await expect(bulletinIsRestricted('b-x')).resolves.toBe(true);
    });

    it('is true when the row read errors', async () => {
        h.rows.set('b-x', { classification_level: 0 });
        h.rowReadError = { message: 'boom' };
        await expect(bulletinIsRestricted('b-x')).resolves.toBe(true);
    });

    it('is true when the row is missing', async () => {
        await expect(bulletinIsRestricted('b-missing')).resolves.toBe(true);
    });

    it('is true when the marker count read errors', async () => {
        h.rows.set('b-x', { classification_level: 0 });
        h.markerCountError = { message: 'boom' };
        await expect(bulletinIsRestricted('b-x')).resolves.toBe(true);
    });
});

describe('createIntelBulletin — markers are attached atomically or not at all', () => {
    it('a failed junction insert deletes the bulletin row, throws, and nothing egresses', async () => {
        h.junctionError = { message: 'fk violation' };
        await expect(create({ markerIds: [MARKER_ID] })).rejects.toThrow(/limiting markers/i);
        await flush();

        // The compensating delete targeted the just-inserted row.
        const del = h.queries.find((q) => q.table === 'intel_bulletins' && q.calls.some((c) => c.method === 'delete'));
        expect(del).toBeDefined();
        expect(del!.calls.find((c) => c.method === 'eq')?.args).toEqual(['id', 'b-1']);
        expect(h.rows.size).toBe(0);

        expect(spies.push).not.toHaveBeenCalled();
        expect(spies.discord).not.toHaveBeenCalled();
        // No realtime nudge for a bulletin that no longer exists.
        expect(h.broadcasts).toEqual([]);
    });

    it('invalid marker ids throw before any bulletin row is inserted', async () => {
        h.validMarkerIds = []; // id 7 does not exist in this org
        await expect(create({ markerIds: [MARKER_ID] })).rejects.toThrow(/not valid/i);
        expect(insertedBulletinRows()).toHaveLength(0);
        expect(h.broadcasts).toEqual([]);
        await flush();
        expect(spies.push).not.toHaveBeenCalled();
        expect(spies.discord).not.toHaveBeenCalled();
    });

    it('a marker-validation read error fails closed before any bulletin row is inserted', async () => {
        h.markerReadError = { message: 'boom' };
        await expect(createIntelBulletin({ title: TITLE, body: BODY, markerIds: [MARKER_ID], user: manager }))
            .rejects.toThrow(/failed to verify limiting markers/i);
        expect(insertedBulletinRows()).toHaveLength(0);
    });

    it('the realtime broadcast fires only after the markers are attached, and carries ids only', async () => {
        await create({ markerIds: [MARKER_ID] });
        expect(h.junction).toEqual([{ bulletin_id: 'b-1', marker_id: MARKER_ID }]);
        expect(h.broadcasts).toEqual([{ event: 'bulletin_update', payload: { type: 'new_bulletin', bulletinId: 'b-1', createdById: 1 } }]);
        // validate markers → insert row → attach markers → broadcast
        expect(h.timeline.slice(0, 4)).toEqual([
            'security_limiting_markers:read',
            'intel_bulletins:insert',
            'intel_bulletin_limiting_markers:insert',
            'broadcast:bulletin_update',
        ]);
    });
});
