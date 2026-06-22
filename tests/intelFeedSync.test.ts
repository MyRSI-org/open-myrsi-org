import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Live-sync intel-ingest tests (lib/db/intel.ts syncTrustedFeeds):
//   - the dedicated PEER-CLOCK cursor: written from _meta.fetchedAt, used with
//     the configurable overlap, legacy last_contact_at fallback for upgraded
//     rows, and NEVER advanced on a transport failure
//   - warrants: nullable issued_by ingest (no admin actor), external_id dedup
//     with the content-match fallback
//   - poison-item isolation: one bad row skips + alerts, the rest ingest and
//     the cursor still advances
//   - realtime nudges: ids/discriminators only

const h = vi.hoisted(() => ({
    orgEmits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    mutations: [] as Array<{ table: string; op: string; values: Record<string, unknown> | null; filters: Record<string, unknown> }>,
    failInsert: null as null | ((table: string, values: Record<string, unknown>) => boolean),
    nextId: 1,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = {
            op: 'select' as string,
            values: null as Record<string, unknown> | null,
            filters: {} as Record<string, unknown>,
            ilikes: {} as Record<string, string>,
            returning: false,
        };
        const rows = () => (h.tables[table] ?? []).filter((r) => {
            for (const [col, val] of Object.entries(state.filters)) if (r[col] !== val) return false;
            for (const [col, val] of Object.entries(state.ilikes)) {
                if (String(r[col] ?? '').toLowerCase() !== val.toLowerCase()) return false;
            }
            return true;
        });
        const b: any = {};
        b.select = () => { state.returning = true; return b; };
        b.update = (values: Record<string, unknown>) => { state.op = 'update'; state.values = values; return b; };
        b.insert = (values: Record<string, unknown>) => { state.op = 'insert'; state.values = values; return b; };
        b.upsert = (values: Record<string, unknown>) => { state.op = 'upsert'; state.values = values; return b; };
        b.eq = (col: string, val: unknown) => { state.filters[col] = val; return b; };
        b.ilike = (col: string, val: string) => { state.ilikes[col] = val; return b; };
        b.in = (col: string, vals: unknown[]) => {
            // only used by the feed-list query in this suite
            state.filters[`in:${col}`] = vals; return b;
        };
        b.is = () => b; b.not = () => b; b.order = () => b; b.limit = () => b; b.gt = () => b;
        const settle = (mode: 'many' | 'single') => {
            if (state.op === 'select') {
                let data = rows();
                const inFilter = state.filters['in:pairing_state'] as unknown[] | undefined;
                if (inFilter) data = (h.tables[table] ?? []).filter(r => inFilter.includes(r.pairing_state));
                const idFilter = state.filters['in:id'] as unknown[] | undefined;
                if (idFilter) data = data.filter(r => idFilter.includes(r.id));
                const codeFilter = state.filters['in:code'] as unknown[] | undefined;
                // Re-fetch from the table (rows() above mistreats the in:code key as a
                // regular column filter and empties the result — mirror in:pairing_state).
                if (codeFilter) data = (h.tables[table] ?? []).filter(r => codeFilter.includes(r.code));
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            if (state.op === 'insert') {
                if (h.failInsert?.(table, state.values!)) {
                    return Promise.resolve({ data: null, error: { message: 'simulated insert failure' } });
                }
                // Handle BOTH single-object and array inserts (the latter used by the
                // report/bulletin limiting-marker junction writes).
                const vals = Array.isArray(state.values) ? state.values : [state.values];
                const list = (h.tables[table] = h.tables[table] ?? []);
                const newRows = vals.map((v) => ({ id: `gen-${h.nextId++}`, ...(v as Record<string, unknown>) }));
                for (const r of newRows) { list.push(r); h.mutations.push({ table, op: 'insert', values: r, filters: {} }); }
                return Promise.resolve({ data: state.returning ? { id: newRows[0]?.id } : null, error: null });
            }
            h.mutations.push({ table, op: state.op, values: state.values, filters: { ...state.filters } });
            if (state.op === 'update') for (const r of rows()) Object.assign(r, state.values);
            return Promise.resolve({ data: null, error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (resolve: any, reject: any) => settle('many').then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (table: string) => builder(table), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.orgEmits.push({ event, payload }); },
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});

// ssrfSafeFetch is the production outbound path; in tests it delegates
// to the stubbed global fetch so the existing fetch-based assertions hold.
vi.mock('../lib/ssrf', () => ({
    assertResolvesToPublicHost: async () => [],
    ssrfSafeFetch: (url: string, init?: Record<string, unknown>) => (globalThis.fetch as typeof fetch)(url, init as RequestInit),
}));
vi.mock('../lib/crypto', () => ({ decryptSecret: (s: string) => s, encryptSecret: (s: string) => s }));
vi.mock('../lib/db/system', () => ({
    verifyApiKey: async () => null,
    getPublicFeedData: async () => ({ reports: [], warrants: [], bulletins: [], _meta: { maxShareableLevel: 0 } }),
}));

import { syncTrustedFeeds } from '../lib/db/intel';
import { __resetAllianceSyncStateForTests, ALLIANCE_SYNC_DEFAULTS } from '../lib/db/allianceSyncState';

const PEER_FETCHED_AT = '2026-06-05T11:11:11.000Z';

function feedRow(over: Record<string, unknown> = {}) {
    return {
        id: 'feedA', label: 'Ally Org', base_url: 'https://peer.example',
        outbound_key_enc: 'ak_test', last_contact_at: '2026-06-05T08:00:00.000Z',
        intel_synced_at: '2026-06-05T10:00:00.000Z', inbound_max_clearance: 5,
        pairing_state: 'active',
        channels: { reports: true, warrants: true, bulletins: true },
        ...over,
    };
}

const fetchCalls: string[] = [];
function stubFetch(payload: unknown, opts?: { fail?: boolean; status?: number }) {
    vi.stubGlobal('fetch', async (url: string) => {
        fetchCalls.push(String(url));
        if (opts?.fail) throw new TypeError('fetch failed');
        return {
            ok: (opts?.status ?? 200) < 400,
            status: opts?.status ?? 200,
            statusText: 'X',
            headers: { get: () => 'application/json' },
            json: async () => payload,
            text: async () => JSON.stringify(payload),
        };
    });
}

const emptyPayload = { reports: [], warrants: [], bulletins: [], _meta: { maxShareableLevel: 5, fetchedAt: PEER_FETCHED_AT } };

beforeEach(() => {
    h.orgEmits = [];
    h.mutations = [];
    h.tables = { alliance_peers: [feedRow()], warrants: [], intel_reports: [], intel_bulletins: [], security_limiting_markers: [] };
    h.failInsert = null;
    h.nextId = 1;
    fetchCalls.length = 0;
    __resetAllianceSyncStateForTests();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('cursor semantics (peer-clock + overlap)', () => {
    it('pulls with ?since = cursor − overlap and advances the cursor to the peer\'s _meta.fetchedAt', async () => {
        stubFetch(emptyPayload);
        await syncTrustedFeeds();
        expect(fetchCalls).toHaveLength(1);
        const url = new URL(fetchCalls[0]);
        const overlapMs = ALLIANCE_SYNC_DEFAULTS.cursorOverlapMinutes * 60_000;
        expect(url.searchParams.get('since'))
            .toBe(new Date(new Date('2026-06-05T10:00:00.000Z').getTime() - overlapMs).toISOString());
        // Cursor written from the PEER's clock — exactly its fetchedAt.
        expect(h.tables.alliance_peers[0].intel_synced_at).toBe(PEER_FETCHED_AT);
    });
    it('NULL cursor (upgraded row) falls back to last_contact_at — a delta, not a full re-pull', async () => {
        h.tables.alliance_peers = [feedRow({ intel_synced_at: null })];
        stubFetch(emptyPayload);
        await syncTrustedFeeds();
        const url = new URL(fetchCalls[0]);
        const overlapMs = ALLIANCE_SYNC_DEFAULTS.cursorOverlapMinutes * 60_000;
        expect(url.searchParams.get('since'))
            .toBe(new Date(new Date('2026-06-05T08:00:00.000Z').getTime() - overlapMs).toISOString());
    });
    it('force bypasses the cursor (full pull)', async () => {
        stubFetch(emptyPayload);
        await syncTrustedFeeds(true);
        expect(new URL(fetchCalls[0]).searchParams.get('since')).toBeNull();
    });
    it('a transport failure NEVER advances the cursor and feeds the health machine', async () => {
        stubFetch(null, { fail: true });
        const res = await syncTrustedFeeds();
        expect(h.tables.alliance_peers[0].intel_synced_at).toBe('2026-06-05T10:00:00.000Z');
        expect(h.tables.alliance_peers[0].sync_failures).toBe(1);
        expect(h.tables.alliance_peers[0].sync_health).toBe('degraded');
        expect(res.feedResults.some(r => r.status === 'error')).toBe(true);
    });
    it('an HTTP 5xx backs off (peer broken) but a 4xx does not (peer up, rejecting us)', async () => {
        stubFetch({}, { status: 500 });
        await syncTrustedFeeds();
        expect(h.tables.alliance_peers[0].sync_failures).toBe(1);
        h.tables.alliance_peers = [feedRow()];
        stubFetch({}, { status: 403 });
        await syncTrustedFeeds();
        expect(h.tables.alliance_peers[0].sync_failures ?? 0).toBe(0);
    });
    it('onlyPeerIds scopes the pass to one peer (the engine\'s per-peer cadence hook)', async () => {
        h.tables.alliance_peers = [feedRow(), feedRow({ id: 'feedB', base_url: 'https://other.example' })];
        stubFetch(emptyPayload);
        await syncTrustedFeeds(false, ['feedB']);
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0]).toContain('other.example');
    });
});

describe('feed ingest sanitization + caps (M6)', () => {
    it('strips HTML from ingested report free-text fields', async () => {
        stubFetch({ ...emptyPayload, reports: [{ id: 'r1', target_id: 'Bad<script>x</script>Guy', summary: '<b>danger</b> ahead', affiliated_org: '<i>ORG</i>', threat_level: 'High', subject_type: 'Person' }] });
        await syncTrustedFeeds();
        const row = h.tables.intel_reports[0];
        expect(String(row.summary)).not.toContain('<');
        expect(String(row.target_id)).not.toContain('<script');
        expect(String(row.affiliated_org ?? '')).not.toContain('<');
    });
    it('strips HTML from ingested warrant + bulletin fields', async () => {
        stubFetch({
            ...emptyPayload,
            warrants: [{ id: 'w1', target_rsi_handle: 'Bad<b>Guy</b>', reason: '<script>evil()</script>piracy', action: 'Detain', uec_reward: 1, status: 'Active' }],
            bulletins: [{ title: '<b>Alert</b>', body: '<script>x</script>incoming', threat_level: 'High' }],
        });
        await syncTrustedFeeds();
        expect(String(h.tables.warrants[0].reason)).not.toContain('<script');
        expect(String(h.tables.warrants[0].target_rsi_handle)).not.toContain('<');
        expect(String(h.tables.intel_bulletins[0].body)).not.toContain('<script');
        expect(String(h.tables.intel_bulletins[0].title)).not.toContain('<');
    });
    it('caps the number of ingested reports per channel', async () => {
        const many = Array.from({ length: 1005 }, (_, i) => ({ id: `r${i}`, target_id: `T${i}`, summary: `s${i}`, threat_level: 'Low', subject_type: 'Person' }));
        stubFetch({ ...emptyPayload, reports: many });
        const res = await syncTrustedFeeds();
        expect(res.totalReports).toBe(1000); // MAX_FEED_ITEMS
    });
    it('content-match dedup uses the SANITIZED values (no re-insert of an HTML-laden duplicate)', async () => {
        // The cleaned target/summary feed BOTH the content-match dedup AND the
        // insert. A markup-laden feed report whose CLEANED form matches a
        // pre-existing internal report must LINK to it, not insert a second
        // copy. Under a revert (dedup-on-raw, insert-clean) the raw
        // '<b>Bandit</b>' wouldn't match the stored 'Bandit' → re-insert.
        h.tables.intel_reports = [{ id: 'r-local', target_id: 'Bandit', summary: 'spotted at HUR', external_id: null, source_feed_id: null }];
        stubFetch({ ...emptyPayload, reports: [{ id: 'feed-r-1', target_id: '<b>Bandit</b>', summary: '<i>spotted</i> at HUR', threat_level: 'High', subject_type: 'Person' }] });
        const res = await syncTrustedFeeds();
        expect(res.totalReports).toBe(0);                 // linked, not newly inserted
        expect(h.tables.intel_reports).toHaveLength(1);   // no duplicate row
        expect(h.tables.intel_reports[0].external_id).toBe('feed-r-1'); // linked to the feed
    });
    it('does NOT relink a locally-authored report on content match (provenance-hijack guard)', async () => {
        // A report WE authored (created_by_id set, source_feed_id null) that an ally
        // happens to match by target+summary must NOT be relabeled as feed-sourced:
        // that would steal its provenance AND drop it from our outbound re-share
        // (outbound shares only source_feed_id IS NULL). Dedupe only — no mutation.
        h.tables.intel_reports = [{ id: 'r-mine', target_id: 'Bandit', summary: 'spotted at HUR', external_id: null, source_feed_id: null, created_by_id: 42 }];
        stubFetch({ ...emptyPayload, reports: [{ id: 'feed-r-1', target_id: 'Bandit', summary: 'spotted at HUR', threat_level: 'High', subject_type: 'Person' }] });
        const res = await syncTrustedFeeds();
        expect(res.totalReports).toBe(0);                  // deduped, not inserted
        expect(h.tables.intel_reports).toHaveLength(1);    // no duplicate row
        const row = h.tables.intel_reports[0];
        expect(row.external_id).toBeNull();                // provenance NOT hijacked
        expect(row.source_feed_id).toBeNull();             // still shareable outbound
    });
    it('refuses an oversized response body before parsing', async () => {
        // text() returns a >8MB string → the byte ceiling rejects it (no parse, no ingest).
        const huge = 'x'.repeat(8 * 1024 * 1024 + 10);
        vi.stubGlobal('fetch', async () => ({
            ok: true, status: 200, statusText: 'X',
            headers: { get: () => 'application/json' },
            text: async () => huge,
            json: async () => ({}),
        }));
        const res = await syncTrustedFeeds();
        expect(res.feedResults.some(r => r.status === 'error' && /too large/i.test(r.message ?? ''))).toBe(true);
        expect(h.tables.intel_reports).toHaveLength(0);
    });
});

describe('warrant ingest (nullable issued_by + external_id dedup)', () => {
    const warrant = (over: Record<string, unknown> = {}) => ({
        id: 'w-ext-1', target_rsi_handle: 'Bandit', reason: 'Piracy', action: 'Detain',
        uec_reward: 100, status: 'Active', created_at: '2026-06-05T10:30:00.000Z', ...over,
    });
    it('ingests with issued_by NULL + "via ally" provenance (no admin actor needed)', async () => {
        stubFetch({ ...emptyPayload, warrants: [warrant()] });
        const res = await syncTrustedFeeds();
        expect(res.totalWarrants).toBe(1);
        const row = h.tables.warrants[0];
        expect(row.issued_by).toBeNull();
        expect(row.source_feed_id).toBe('feedA');
        expect(row.external_id).toBe('w-ext-1');
    });
    it('dedups by (source_feed_id, external_id) on re-pull (overlap replays are free)', async () => {
        h.tables.warrants = [{ id: 'local-1', external_id: 'w-ext-1', source_feed_id: 'feedA', target_rsi_handle: 'Bandit', reason: 'Piracy' }];
        stubFetch({ ...emptyPayload, warrants: [warrant()] });
        const res = await syncTrustedFeeds();
        expect(res.totalWarrants).toBe(0);
        expect(h.tables.warrants).toHaveLength(1);
    });
    it('falls back to content match for id-less legacy feeds', async () => {
        h.tables.warrants = [{ id: 'local-1', external_id: null, source_feed_id: null, target_rsi_handle: 'Bandit', reason: 'Piracy' }];
        stubFetch({ ...emptyPayload, warrants: [warrant({ id: undefined })] });
        const res = await syncTrustedFeeds();
        expect(res.totalWarrants).toBe(0);
    });
    it('nudges with warrant ids only (no content on the wire)', async () => {
        stubFetch({ ...emptyPayload, warrants: [warrant()] });
        await syncTrustedFeeds();
        const emit = h.orgEmits.find(e => e.event === 'warrant_update');
        expect(emit).toBeTruthy();
        expect(emit!.payload).toEqual({ warrantIds: [h.tables.warrants[0].id] });
        expect(JSON.stringify(emit!.payload)).not.toContain('Piracy');
    });
});

describe('poison-item isolation', () => {
    it('one failing row skips + alerts; the rest ingest and the cursor STILL advances', async () => {
        h.failInsert = (table, values) => table === 'warrants' && values.target_rsi_handle === 'PoisonRow';
        stubFetch({
            ...emptyPayload,
            warrants: [
                { id: 'w1', target_rsi_handle: 'PoisonRow', reason: 'bad row' },
                { id: 'w2', target_rsi_handle: 'GoodRow', reason: 'fine' },
            ],
        });
        const res = await syncTrustedFeeds();
        expect(res.totalWarrants).toBe(1);
        expect(res.skippedItems).toBe(1);
        expect(h.tables.warrants.map(w => w.target_rsi_handle)).toEqual(['GoodRow']);
        // The cursor advanced anyway — a poison item can never stall the feed.
        expect(h.tables.alliance_peers[0].intel_synced_at).toBe(PEER_FETCHED_AT);
        // Operator-visible alert, not a silent swallow.
        expect(h.tables.alliance_peers[0].sync_alert).toMatch(/skipped 1 item/);
    });
});

describe('report + bulletin nudges', () => {
    it('new reports emit ONE intel_update {kind:report}; bulletins emit per-id', async () => {
        stubFetch({
            ...emptyPayload,
            reports: [{ id: 'r1', target_id: 'Bandit', summary: 'spotted', subject_type: 'Person', threat_level: 'High', classification_level: 0 }],
            bulletins: [{ title: 'Alert', body: 'incoming', threat_level: 'High' }],
        });
        await syncTrustedFeeds();
        const intel = h.orgEmits.filter(e => e.event === 'intel_update');
        expect(intel).toEqual([{ event: 'intel_update', payload: { kind: 'report' } }]);
        const bulletins = h.orgEmits.filter(e => e.event === 'bulletin_update');
        expect(bulletins).toHaveLength(1);
        expect(bulletins[0].payload).toEqual({ bulletinId: h.tables.intel_bulletins[0].id });
        // Loop guard provenance stamped on the ingested bulletin.
        expect(h.tables.intel_bulletins[0].source_organization_id).toBe('feedA');
        expect(h.tables.intel_bulletins[0].shared_with_allies).toBe(false);
    });
});

describe('bulletin ingest clearance ceiling + markers (IMP-D1)', () => {
    it('drops an ally bulletin ABOVE the feed inbound_max_clearance, ingests one AT the ceiling', async () => {
        h.tables.alliance_peers = [feedRow({ inbound_max_clearance: 2 })];
        stubFetch({
            ...emptyPayload,
            bulletins: [
                { title: 'TopSecret', body: 'x', classification_level: 4 }, // above ceiling → dropped
                { title: 'AtCeiling', body: 'y', classification_level: 2 },  // at ceiling → ingested
            ],
        });
        const res = await syncTrustedFeeds();
        expect(res.totalBulletins).toBe(1);
        expect(h.tables.intel_bulletins.map(b => b.title)).toEqual(['AtCeiling']);
    });

    it('attaches the ingested bulletin\'s limiting markers by code (compartment preserved)', async () => {
        h.tables.alliance_peers = [feedRow({ inbound_max_clearance: 5 })];
        h.tables.security_limiting_markers = [{ id: 9, code: 'GAMMA' }];
        h.tables.intel_bulletin_limiting_markers = [];
        stubFetch({
            ...emptyPayload,
            bulletins: [{ title: 'Compartmented', body: 'z', classification_level: 1, limiting_markers: ['GAMMA'] }],
        });
        await syncTrustedFeeds();
        const bId = h.tables.intel_bulletins[0].id;
        expect(h.tables.intel_bulletin_limiting_markers).toContainEqual(
            expect.objectContaining({ bulletin_id: bId, marker_id: 9 }),
        );
    });
});
