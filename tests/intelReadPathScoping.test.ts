import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Intel read-path behaviour:
//   1. getIntelStats clearance ceiling          — lib/db/intel.ts
//   2. dossier.requests request-duty gate        — api/actions/intel.ts handler
//   3. feed unknown-marker fail-closed           — lib/db/intel.ts syncTrustedFeeds
//   4. feed byte cap (Content-Length + non-JSON) — lib/db/intel.ts syncTrustedFeeds
//   5. intel bulk reportIds length cap           — lib/db/intel.ts
//
// The lib-level tests (1/3/4/5) run against a select-string-aware + stateful
// supabase mock. The handler-level test (2) is driven through intelActions with
// ../lib/db spied — a different module path, so the two mocks coexist without
// colliding.

const h = vi.hoisted(() => ({
    // Per-table fixture resolver for select/single/maybeSingle reads.
    resolveQuery: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: null as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown; count?: number },
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    // For the stateful feed-ingest tests:
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
    nextId: 1,
    stateful: false, // when true, the feed-ingest stateful builder is active
}));

vi.mock('../lib/db/common', () => {
    // --- Stateful builder (feed-ingest) — only used when h.stateful === true ---
    function statefulBuilder(table: string) {
        const state = { op: 'select' as string, values: null as Record<string, unknown> | null, filters: {} as Record<string, unknown>, ilikes: {} as Record<string, string>, returning: false };
        const rows = () => (h.tables[table] ?? []).filter((r) => {
            for (const [col, val] of Object.entries(state.filters)) if (r[col] !== val) return false;
            for (const [col, val] of Object.entries(state.ilikes)) if (String(r[col] ?? '').toLowerCase() !== val.toLowerCase()) return false;
            return true;
        });
        const b: any = {};
        b.select = () => { state.returning = true; return b; };
        b.update = (values: Record<string, unknown>) => { state.op = 'update'; state.values = values; return b; };
        b.insert = (values: Record<string, unknown>) => { state.op = 'insert'; state.values = values; return b; };
        b.upsert = (values: Record<string, unknown>) => { state.op = 'upsert'; state.values = values; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = (col: string, val: unknown) => { state.filters[col] = val; return b; };
        b.ilike = (col: string, val: string) => { state.ilikes[col] = val; return b; };
        b.in = (col: string, vals: unknown[]) => { state.filters[`in:${col}`] = vals; return b; };
        b.is = () => b; b.not = () => b; b.order = () => b; b.limit = () => b; b.gt = () => b; b.lte = () => b; b.gte = () => b;
        const settle = (mode: 'many' | 'single') => {
            if (state.op === 'select') {
                let data = rows();
                const ps = state.filters['in:pairing_state'] as unknown[] | undefined;
                if (ps) data = (h.tables[table] ?? []).filter(r => ps.includes(r.pairing_state));
                const idIn = state.filters['in:id'] as unknown[] | undefined;
                if (idIn) data = data.filter(r => idIn.includes(r.id));
                const codeIn = state.filters['in:code'] as unknown[] | undefined;
                if (codeIn) data = (h.tables[table] ?? []).filter(r => codeIn.includes(r.code));
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            if (state.op === 'insert') {
                const vals = Array.isArray(state.values) ? state.values : [state.values];
                const list = (h.tables[table] = h.tables[table] ?? []);
                const newRows = vals.map((v) => ({ id: `gen-${h.nextId++}`, ...(v as Record<string, unknown>) }));
                for (const r of newRows) { list.push(r); h.inserts.push({ table, values: r }); }
                return Promise.resolve({ data: state.returning ? { id: newRows[0]?.id } : null, error: null });
            }
            if (state.op === 'update') for (const r of rows()) Object.assign(r, state.values);
            return Promise.resolve({ data: null, error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (resolve: any, reject: any) => settle('many').then(resolve, reject);
        return b;
    }

    // --- Stateless select-string-aware builder (getIntelStats) ---
    function statelessBuilder(table: string) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'gt', 'gte', 'lt', 'lte', 'ilike', 'update', 'insert', 'delete', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
        }
        const settle = () => Promise.resolve(h.resolveQuery({ table, calls }));
        b.single = () => { calls.push({ method: 'single', args: [] }); return settle(); };
        b.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return settle(); };
        b.then = (resolve: any, reject: any) => settle().then(resolve, reject);
        return b;
    }

    return {
        supabase: { from: (t: string) => (h.stateful ? statefulBuilder(t) : statelessBuilder(t)), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ event, payload }); },
        broadcastToChannel: () => {},
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
        getSystemRoles: async () => ({}),
    };
});

// ssrfSafeFetch delegates to the stubbed global fetch (matches intelFeedSync.test.ts).
vi.mock('../lib/ssrf', () => ({
    assertResolvesToPublicHost: async () => [],
    ssrfSafeFetch: (url: string, init?: Record<string, unknown>) => (globalThis.fetch as typeof fetch)(url, init as RequestInit),
}));
vi.mock('../lib/crypto', () => ({ decryptSecret: (s: string) => s, encryptSecret: (s: string) => s }));
vi.mock('../lib/db/system', () => ({
    verifyApiKey: async () => null,
    getPublicFeedData: async () => ({ reports: [], warrants: [], bulletins: [], _meta: { maxShareableLevel: 0 } }),
}));

// Handler-level mock: the api/actions/intel.ts handler imports ../lib/db (the
// barrel). Spy only what intel:get_dossier touches. This is a different module
// path from ../lib/db/common, so it never shadows the real lib/db/intel.ts used
// by the lib-level tests below.
const dbSpies = vi.hoisted(() => ({
    getDossier: vi.fn(),
    filterIntelByClearance: vi.fn((items: unknown[]) => items),
}));
vi.mock('../lib/db', () => ({
    getDossier: dbSpies.getDossier,
    filterIntelByClearance: dbSpies.filterIntelByClearance,
}));
vi.mock('../lib/ai', () => ({ generateDossierSummary: vi.fn() }));
vi.mock('../lib/aiRateLimit', () => ({ assertAiRateLimit: vi.fn() }));
vi.mock('../lib/discord', () => ({}));
vi.mock('../lib/push', () => ({ sendPushToStaff: vi.fn() }));

import { getIntelStats, syncTrustedFeeds, bulkDeleteIntelReports, bulkUpdateIntelAffiliation, bulkAddIntelTags } from '../lib/db/intel';
import { intelActions } from '../api/actions/intel';
import { __resetAllianceSyncStateForTests } from '../lib/db/allianceSyncState';

type Viewer = { id?: number; role?: string; permissions?: string[]; clearanceLevel?: { level?: number } | null; limitingMarkers?: unknown[] };
const viewer = (over: Partial<Viewer> = {}): Viewer => ({ id: 6, role: 'Member', permissions: [], clearanceLevel: { level: 0 }, limitingMarkers: [], ...over });

beforeEach(() => {
    h.resolveQuery = () => ({ data: null, error: null });
    h.broadcasts = [];
    h.tables = {};
    h.inserts = [];
    h.nextId = 1;
    h.stateful = false;
    dbSpies.getDossier.mockReset();
    dbSpies.filterIntelByClearance.mockReset();
    dbSpies.filterIntelByClearance.mockImplementation((items: unknown[]) => items);
    __resetAllianceSyncStateForTests();
});

// getIntelStats — clearance ceiling on report counts + threat breakdown +
// warrant aggregation.
describe('getIntelStats clearance ceiling (clearance-markers#2)', () => {
    // Fixture: 3 reports (levels 0,0,5), 2 active warrants. The mock honours the
    // .lte('classification_level', N) ceiling, so a level-0 viewer's count
    // excludes the level-5 report.
    function statsFixture() {
        const ALL_REPORTS = [
            { threat_level: 'Low', classification_level: 0 },
            { threat_level: 'High', classification_level: 0 },
            { threat_level: 'Critical', classification_level: 5 },
        ];
        h.resolveQuery = ({ table, calls }) => {
            if (table === 'intel_reports') {
                const lte = calls.find(c => c.method === 'lte' && c.args[0] === 'classification_level');
                // getIntelStats now uses count-pushdown for the total (head:true →
                // reads .count) and a bounded scan for the breakdown (reads .data),
                // both still ceilinged by .lte('classification_level', N). Return
                // both so either query shape resolves correctly.
                const rows = lte
                    ? ALL_REPORTS.filter(r => r.classification_level <= Number(lte.args[1]))
                    : ALL_REPORTS;
                return { data: rows, count: rows.length, error: null };
            }
            if (table === 'warrants') return { data: [{ id: 'w1' }, { id: 'w2' }], count: 2, error: null };
            return { data: [], count: 0, error: null };
        };
    }

    it('a low-clearance intel:view viewer sees ONLY at-or-below-level reports in the count + breakdown', async () => {
        statsFixture();
        const stats = await getIntelStats(viewer({ permissions: ['intel:view'] }));
        expect(stats.totalReports).toBe(2);                  // the level-5 report is excluded
        expect(stats.threatBreakdown.Critical ?? 0).toBe(0); // the only Critical was level-5
        expect(stats.threatBreakdown.Low).toBe(1);
        expect(stats.threatBreakdown.High).toBe(1);
    });

    it('an Admin / intel:manage holder sees ALL reports (no ceiling)', async () => {
        statsFixture();
        const admin = await getIntelStats(viewer({ role: 'Admin' }));
        expect(admin.totalReports).toBe(3);
        expect(admin.threatBreakdown.Critical).toBe(1);
        const manager = await getIntelStats(viewer({ permissions: ['intel:manage'] }));
        expect(manager.totalReports).toBe(3);
    });

    it('an undefined viewer fails closed (treated as clearance 0)', async () => {
        statsFixture();
        const stats = await getIntelStats(undefined);
        expect(stats.totalReports).toBe(2); // only level-0 rows
    });

    it('warrant aggregation requires warrant:view — withheld from an intel-only viewer', async () => {
        statsFixture();
        const noWarrant = await getIntelStats(viewer({ permissions: ['intel:view'] }));
        expect(noWarrant.activeWarrants).toBe(0);
        const withWarrant = await getIntelStats(viewer({ permissions: ['intel:view', 'warrant:view'] }));
        expect(withWarrant.activeWarrants).toBe(2);
    });
});

// intel:get_dossier handler — dossier.requests honour the request-duty gate.
describe('intel:get_dossier withholds service-request bodies without request duty (readpath-authz#3)', () => {
    const REQUESTS = [{ id: 'req1', description: 'secret op location', threatLevel: 'High' }];
    const callDossier = (p: unknown) => (intelActions as unknown as Record<string, (x: unknown) => Promise<{ requests: unknown[] }>>)['intel:get_dossier'](p);

    beforeEach(() => {
        dbSpies.getDossier.mockResolvedValue({ targetId: 'jdoe', reports: [], warrants: [], requests: REQUESTS, operations: [], affiliates: [] });
    });

    it('an intel:view caller WITHOUT a request-duty permission gets requests: []', async () => {
        const res = await callDossier({ targetId: 'jdoe', user: viewer({ permissions: ['intel:view'] }) });
        expect(res.requests).toEqual([]);
        // The PII never crossed the wire.
        expect(JSON.stringify(res)).not.toContain('secret op location');
    });

    it('a request:dispatch holder DOES receive the request bodies', async () => {
        const res = await callDossier({ targetId: 'jdoe', user: viewer({ permissions: ['intel:view', 'request:dispatch'] }) });
        expect(res.requests).toEqual(REQUESTS);
    });

    it('Admin receives the request bodies', async () => {
        const res = await callDossier({ targetId: 'jdoe', user: viewer({ role: 'Admin' }) });
        expect(res.requests).toEqual(REQUESTS);
    });

    it('request:triage and request:accept also unlock the requests', async () => {
        const triage = await callDossier({ targetId: 'jdoe', user: viewer({ permissions: ['request:triage'] }) });
        expect(triage.requests).toEqual(REQUESTS);
        const accept = await callDossier({ targetId: 'jdoe', user: viewer({ permissions: ['request:accept'] }) });
        expect(accept.requests).toEqual(REQUESTS);
    });
});

// syncTrustedFeeds — feed ingest hardening.
const PEER_FETCHED_AT = '2026-06-05T11:11:11.000Z';
function feedRow(over: Record<string, unknown> = {}) {
    return {
        id: 'feedA', label: 'Ally Org', base_url: 'https://peer.example',
        outbound_key_enc: 'ak_test', last_contact_at: '2026-06-05T08:00:00.000Z',
        intel_synced_at: '2026-06-05T10:00:00.000Z', inbound_max_clearance: 5,
        pairing_state: 'active', channels: { reports: true, warrants: true, bulletins: true },
        ...over,
    };
}
const emptyPayload = { reports: [], warrants: [], bulletins: [], _meta: { maxShareableLevel: 5, fetchedAt: PEER_FETCHED_AT } };

function stubFeed(payload: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }, textOverride?: string) {
    vi.stubGlobal('fetch', async () => ({
        ok: true, status: 200, statusText: 'X',
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        json: async () => payload,
        text: async () => textOverride ?? JSON.stringify(payload),
    }));
}

describe('feed unknown-marker fail-CLOSED (import-ingest#1)', () => {
    beforeEach(() => {
        h.stateful = true;
        h.tables = { alliance_peers: [feedRow()], warrants: [], intel_reports: [], intel_bulletins: [], security_limiting_markers: [{ id: 9, code: 'GAMMA' }], intel_report_limiting_markers: [], intel_bulletin_limiting_markers: [] };
    });
    afterEach(() => vi.unstubAllGlobals());

    it('SKIPS a feed REPORT bearing an unknown marker code — never inserted markerless', async () => {
        stubFeed({ ...emptyPayload, reports: [{ id: 'r-bad', target_id: 'Bandit', summary: 'spotted', subject_type: 'Person', threat_level: 'High', classification_level: 1, limiting_markers: ['UNKNOWN_COMPARTMENT'] }] });
        const res = await syncTrustedFeeds();
        expect(res.totalReports).toBe(0);
        expect(h.tables.intel_reports).toHaveLength(0); // not inserted at all (no markerless leak)
        expect(res.skippedItems).toBe(1);
    });

    it('INGESTS a feed report whose marker code IS known (compartment preserved)', async () => {
        stubFeed({ ...emptyPayload, reports: [{ id: 'r-ok', target_id: 'Bandit', summary: 'spotted', subject_type: 'Person', threat_level: 'High', classification_level: 1, limiting_markers: ['GAMMA'] }] });
        const res = await syncTrustedFeeds();
        expect(res.totalReports).toBe(1);
        expect(h.tables.intel_reports).toHaveLength(1);
        const rId = h.tables.intel_reports[0].id;
        expect(h.tables.intel_report_limiting_markers).toContainEqual(expect.objectContaining({ report_id: rId, marker_id: 9 }));
    });

    it('SKIPS a feed BULLETIN bearing an unknown marker code — never inserted markerless', async () => {
        stubFeed({ ...emptyPayload, bulletins: [{ title: 'Compartmented', body: 'x', classification_level: 1, limiting_markers: ['UNKNOWN_COMPARTMENT'] }] });
        const res = await syncTrustedFeeds();
        expect(res.totalBulletins).toBe(0);
        expect(h.tables.intel_bulletins).toHaveLength(0);
    });

    it('INGESTS a feed bulletin whose marker code IS known', async () => {
        stubFeed({ ...emptyPayload, bulletins: [{ title: 'Compartmented', body: 'x', classification_level: 1, limiting_markers: ['GAMMA'] }] });
        const res = await syncTrustedFeeds();
        expect(res.totalBulletins).toBe(1);
        const bId = h.tables.intel_bulletins[0].id;
        expect(h.tables.intel_bulletin_limiting_markers).toContainEqual(expect.objectContaining({ bulletin_id: bId, marker_id: 9 }));
    });

    it('a partially-resolvable marker set (one known, one unknown) STILL fails closed (skips)', async () => {
        stubFeed({ ...emptyPayload, reports: [{ id: 'r-mix', target_id: 'Bandit', summary: 'spotted', subject_type: 'Person', threat_level: 'High', classification_level: 1, limiting_markers: ['GAMMA', 'UNKNOWN_COMPARTMENT'] }] });
        const res = await syncTrustedFeeds();
        expect(res.totalReports).toBe(0);
        expect(h.tables.intel_reports).toHaveLength(0);
    });
});

describe('feed byte cap — Content-Length pre-check + non-JSON branch (ssrf#2)', () => {
    beforeEach(() => {
        h.stateful = true;
        h.tables = { alliance_peers: [feedRow()], warrants: [], intel_reports: [], intel_bulletins: [], security_limiting_markers: [], intel_report_limiting_markers: [], intel_bulletin_limiting_markers: [] };
    });
    afterEach(() => vi.unstubAllGlobals());

    it('rejects EARLY on a declared Content-Length over the cap (body never buffered)', async () => {
        let textRead = false;
        vi.stubGlobal('fetch', async () => ({
            ok: true, status: 200, statusText: 'X',
            headers: { get: (k: string) => ({ 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) } as Record<string, string>)[k.toLowerCase()] ?? null },
            json: async () => ({}),
            text: async () => { textRead = true; return ''; },
        }));
        const res = await syncTrustedFeeds();
        expect(res.feedResults.some(r => r.status === 'error' && /too large/i.test(r.message ?? ''))).toBe(true);
        expect(textRead).toBe(false); // refused before reading the body
        expect(h.tables.intel_reports).toHaveLength(0);
    });

    it('caps the NON-JSON (text/plain) branch too — an oversized text body is refused', async () => {
        const huge = 'x'.repeat(8 * 1024 * 1024 + 10);
        stubFeed({}, { 'content-type': 'text/plain' }, huge); // no content-length; JSON path not taken
        const res = await syncTrustedFeeds();
        expect(res.feedResults.some(r => r.status === 'error' && /too large/i.test(r.message ?? ''))).toBe(true);
        expect(h.tables.intel_reports).toHaveLength(0);
    });

    it('a JSON body over the cap with no Content-Length is still refused post-buffer (M6 regression)', async () => {
        const huge = 'x'.repeat(8 * 1024 * 1024 + 10);
        stubFeed({}, { 'content-type': 'application/json' }, huge);
        const res = await syncTrustedFeeds();
        expect(res.feedResults.some(r => r.status === 'error' && /too large/i.test(r.message ?? ''))).toBe(true);
    });
});

describe('intel bulk reportIds length cap (ratelimit#3)', () => {
    beforeEach(() => { h.stateful = true; h.tables = { intel_reports: [] }; });
    afterEach(() => vi.unstubAllGlobals());

    const oversized = Array.from({ length: 1001 }, (_, i) => `id-${i}`);

    it('bulkDeleteIntelReports rejects an oversized reportIds array', async () => {
        await expect(bulkDeleteIntelReports(oversized)).rejects.toThrow(/too many/i);
    });

    it('bulkUpdateIntelAffiliation rejects an oversized reportIds array', async () => {
        await expect(bulkUpdateIntelAffiliation(oversized, 'ORG')).rejects.toThrow(/too many/i);
    });

    it('bulkAddIntelTags rejects an oversized reportIds array', async () => {
        await expect(bulkAddIntelTags(oversized, ['tag'])).rejects.toThrow(/too many/i);
    });

    it('a within-cap array is accepted (no false positive)', async () => {
        await expect(bulkDeleteIntelReports(['a', 'b', 'c'])).resolves.toBeUndefined();
    });
});

describe('intel bulk_add_tags tags-array bounds', () => {
    beforeEach(() => { h.stateful = true; h.tables = { intel_reports: [] }; });

    it('rejects an oversized tags array (write/storage amplification guard)', async () => {
        const tooManyTags = Array.from({ length: 51 }, (_, i) => `t${i}`);
        await expect(bulkAddIntelTags(['r1'], tooManyTags)).rejects.toThrow(/too many tags/i);
    });

    it('rejects a non-array tags value', async () => {
        await expect(bulkAddIntelTags(['r1'], 'nope' as unknown as string[])).rejects.toThrow(/must be an array/i);
    });

    it('a within-cap tags array is accepted', async () => {
        await expect(bulkAddIntelTags(['r1'], ['alpha', 'bravo'])).resolves.toBeUndefined();
    });
});
