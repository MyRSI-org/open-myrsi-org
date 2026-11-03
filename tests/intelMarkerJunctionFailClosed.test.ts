import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Limiting-marker junction writes in lib/db/intel.ts fail CLOSED.
//
// supabase-js RESOLVES a failed insert as `{ data: null, error }` — it does not
// throw. Every marker path used to drop that error on the floor, so a failed
// junction insert silently left compartmented intel UNMARKED (readable by every
// intel:view holder who passes the level check) or, on update, STRIPPED the
// report's existing markers. createIntelBulletin was fixed first (pinned in
// intelBulletinEgress.test.ts); this file pins the other four paths:
//   - createIntelReport          → row deleted + throw (markers validated first)
//   - updateIntelReport          → add → row → remove, so any failure throws with
//                                  the report OVER-marked, never stripped
//   - syncTrustedFeeds (reports) → row deleted + counted as a skipped item
//   - syncTrustedFeeds (bulletins) → row deleted + counted as a skipped item
// …and that each success path is unchanged.
//
// The supabase fake is STATEFUL (rows really land in / leave h.tables), so "no
// unmarked row is left behind" is asserted against the resulting table state,
// not against which calls were made.

type Row = Record<string, unknown>;
type Filter = { kind: 'eq' | 'ilike' | 'in'; col: string; val: unknown };

const h = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    nextId: 1,
    // Fault injection: return true to make that op on that table resolve `{ error }`.
    fail: null as null | ((op: string, table: string, values: unknown) => boolean),
    // Every settled query as `${table}:${op}`, plus broadcasts, in order.
    timeline: [] as string[],
    orgEmits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    errors: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
    // Called after every successfully applied write, to observe intermediate states.
    afterWrite: null as null | ((table: string, op: string) => void),
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
        let values: unknown = null;
        let returning = false;
        let columns = '';
        const filters: Filter[] = [];
        const matches = (r: Row) => filters.every((f) => {
            if (f.kind === 'eq') return r[f.col] === f.val;
            if (f.kind === 'ilike') return String(r[f.col] ?? '').toLowerCase() === String(f.val).toLowerCase();
            return (f.val as unknown[]).includes(r[f.col]);
        });
        const b: any = {};
        b.select = (cols?: string) => { returning = true; columns = cols ?? ''; return b; };
        b.insert = (v: unknown) => { op = 'insert'; values = v; return b; };
        b.update = (v: unknown) => { op = 'update'; values = v; return b; };
        b.upsert = (v: unknown) => { op = 'update'; values = v; return b; };
        b.delete = () => { op = 'delete'; return b; };
        b.eq = (col: string, val: unknown) => { filters.push({ kind: 'eq', col, val }); return b; };
        b.ilike = (col: string, val: unknown) => { filters.push({ kind: 'ilike', col, val }); return b; };
        b.in = (col: string, val: unknown[]) => { filters.push({ kind: 'in', col, val }); return b; };
        b.is = () => b; b.not = () => b; b.order = () => b; b.limit = () => b; b.gt = () => b;
        const settle = (single: boolean) => {
            h.timeline.push(`${table}:${op}`);
            if (h.fail?.(op, table, values)) {
                return Promise.resolve({ data: null, error: { message: `simulated ${op} failure on ${table}` } });
            }
            const list = (h.tables[table] = h.tables[table] ?? []);
            if (op === 'insert') {
                const vals = (Array.isArray(values) ? values : [values]) as Row[];
                // Junction rows are keyed by (parent_id, marker_id) — no surrogate id.
                const rows = vals.map((v) => (table.endsWith('_limiting_markers') ? { ...v } : { id: `${table}-${h.nextId++}`, ...v }));
                list.push(...rows);
                h.afterWrite?.(table, op);
                return Promise.resolve({ data: returning ? (single ? { id: rows[0]?.id } : rows) : null, error: null });
            }
            if (op === 'delete') {
                h.tables[table] = list.filter((r) => !matches(r));
                h.afterWrite?.(table, op);
                return Promise.resolve({ data: null, error: null });
            }
            if (op === 'update') {
                for (const r of list) if (matches(r)) Object.assign(r, values);
                h.afterWrite?.(table, op);
                return Promise.resolve({ data: null, error: null });
            }
            let data = list.filter(matches);
            // The one embed these paths use: updateIntelReport snapshots the report's
            // marker set inside its existence read.
            if (table === 'intel_reports' && columns.includes('intel_report_limiting_markers(marker_id)')) {
                data = data.map((r) => ({
                    ...r,
                    intel_report_limiting_markers: (h.tables.intel_report_limiting_markers ?? [])
                        .filter((j) => j.report_id === r.id)
                        .map((j) => ({ marker_id: j.marker_id })),
                }));
            }
            return Promise.resolve({ data: single ? (data[0] ?? null) : data, error: null });
        };
        b.single = () => settle(true);
        b.maybeSingle = () => settle(true);
        b.then = (res: any, rej: any) => settle(false).then(res, rej);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => {
            h.orgEmits.push({ event, payload });
            h.timeline.push(`broadcast:${event}`);
        },
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});

// Capture log.error so the "rollback/restore also failed" branches can be shown
// to name the orphaned row's id (the operator's only handle on it).
vi.mock('../lib/log', async (importOriginal) => {
    const mk = (): Record<string, unknown> => ({
        debug: () => {}, info: () => {}, warn: () => {},
        error: (msg: string, fields?: Record<string, unknown>) => { h.errors.push({ msg, fields }); },
        child: () => mk(),
    });
    return { ...(await importOriginal<Record<string, unknown>>()), log: mk() };
});

vi.mock('../lib/ssrf', () => ({
    assertResolvesToPublicHost: async () => [],
    ssrfSafeFetch: (url: string, init?: Record<string, unknown>) => (globalThis.fetch as typeof fetch)(url, init as RequestInit),
}));
vi.mock('../lib/crypto', () => ({ decryptSecret: (s: string) => s, encryptSecret: (s: string) => s }));
vi.mock('../lib/db/system', () => ({
    verifyApiKey: async () => null,
    getPublicFeedData: async () => ({ reports: [], warrants: [], bulletins: [], _meta: { maxShareableLevel: 0 } }),
}));

import { createIntelReport, updateIntelReport, syncTrustedFeeds } from '../lib/db/intel';
import { __resetAllianceSyncStateForTests } from '../lib/db/allianceSyncState';

const REPORT_ID = '00000000-0000-0000-0000-0000000000aa';
// intel:manage bypasses assertCanClassify — classification is not under test here.
const manager = { id: 1, role: 'Member', permissions: ['intel:manage'], clearanceLevel: { level: 0 }, limitingMarkers: [] };

const failJunctionInsert = (table: string, pred: (rows: Row[]) => boolean = () => true) =>
    (op: string, t: string, values: unknown) => op === 'insert' && t === table && pred(values as Row[]);

const junction = (table: string) => h.tables[table] ?? [];

beforeEach(() => {
    h.tables = {
        security_limiting_markers: [{ id: 1, code: 'ALPHA' }, { id: 2, code: 'BRAVO' }, { id: 9, code: 'GAMMA' }],
        intel_reports: [],
        intel_report_limiting_markers: [],
        intel_bulletins: [],
        intel_bulletin_limiting_markers: [],
        warrants: [],
    };
    h.nextId = 1;
    h.fail = null;
    h.timeline = [];
    h.orgEmits = [];
    h.errors = [];
    h.afterWrite = null;
});

describe('createIntelReport — markers attached atomically or not at all', () => {
    const create = (over: Record<string, unknown> = {}) => createIntelReport({
        targetId: 'Bandit', subjectType: 'Person', threatLevel: 'High', summary: 'compartmented sighting',
        createdById: 1, classificationLevel: 0, user: manager, ...over,
    });

    it('a failed junction insert deletes the report row, throws, and nothing is broadcast', async () => {
        h.fail = failJunctionInsert('intel_report_limiting_markers');
        await expect(create({ markerIds: [1, 2] })).rejects.toThrow('Failed to attach limiting markers to intel report');
        // No unmarked report survives — the compensating delete removed it.
        expect(h.tables.intel_reports).toEqual([]);
        expect(junction('intel_report_limiting_markers')).toEqual([]);
        expect(h.orgEmits).toEqual([]);
        expect(h.timeline).toEqual([
            'security_limiting_markers:select',
            'intel_reports:insert',
            'intel_report_limiting_markers:insert',
            'intel_reports:delete',
        ]);
    });

    it('if the compensating delete ALSO fails, it logs the orphan id and still throws', async () => {
        h.fail = (op, t, v) => failJunctionInsert('intel_report_limiting_markers')(op, t, v) || (op === 'delete' && t === 'intel_reports');
        await expect(create({ markerIds: [1] })).rejects.toThrow('Failed to attach limiting markers to intel report');
        const orphanId = h.tables.intel_reports[0]?.id;
        expect(orphanId).toBeDefined();
        expect(h.errors).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ reportId: orphanId }) }));
        expect(h.orgEmits).toEqual([]);
    });

    it('invalid marker ids throw BEFORE any report row is inserted', async () => {
        await expect(create({ markerIds: [1, 404] })).rejects.toThrow(/not valid/i);
        expect(h.timeline).not.toContain('intel_reports:insert');
        expect(h.tables.intel_reports).toEqual([]);
    });

    it('a marker-validation read error fails closed BEFORE any report row is inserted', async () => {
        h.fail = (op, t) => op === 'select' && t === 'security_limiting_markers';
        await expect(create({ markerIds: [1] })).rejects.toThrow('Failed to verify limiting markers for intel report');
        expect(h.timeline).not.toContain('intel_reports:insert');
        expect(h.tables.intel_reports).toEqual([]);
    });

    it('success path: validate → insert → attach → broadcast (ids only)', async () => {
        await create({ markerIds: [1, 2] });
        const id = h.tables.intel_reports[0].id;
        expect(junction('intel_report_limiting_markers')).toEqual([
            { report_id: id, marker_id: 1 },
            { report_id: id, marker_id: 2 },
        ]);
        expect(h.timeline).toEqual([
            'security_limiting_markers:select',
            'intel_reports:insert',
            'intel_report_limiting_markers:insert',
            'broadcast:intel_update',
        ]);
        expect(h.orgEmits).toEqual([{ event: 'intel_update', payload: { kind: 'report' } }]);
    });

    it('success path without markers is unchanged: no marker read, no junction write', async () => {
        await create();
        expect(h.tables.intel_reports).toHaveLength(1);
        expect(h.timeline).toEqual(['intel_reports:insert', 'broadcast:intel_update']);
    });
});

describe('updateIntelReport — a failed marker change never strips the compartment', () => {
    // Before: Level 3 + markers {1,2}. Requested: Level 0 + {2,9} — the edit both
    // LOWERS the level and swaps a marker, the case where a half-applied write
    // could expose the new content to readers neither state admits.
    const OLD = [1, 2];
    const NEW = [2, 9];
    const update = (markerIds: number[] = NEW) => updateIntelReport(REPORT_ID, {
        threatLevel: 'High', summary: 'edited', classificationLevel: 0, markerIds,
    });
    const reportMarkers = () => junction('intel_report_limiting_markers')
        .filter((j) => j.report_id === REPORT_ID)
        .map((j) => j.marker_id as number)
        .sort((a, b) => a - b);

    beforeEach(() => {
        h.tables.intel_reports = [{ id: REPORT_ID, summary: 'original', classification_level: 3 }];
        h.tables.intel_report_limiting_markers = OLD.map((marker_id) => ({ report_id: REPORT_ID, marker_id }));
    });

    it('a failed marker attach throws BEFORE the row or the old markers are touched', async () => {
        h.fail = failJunctionInsert('intel_report_limiting_markers');
        await expect(update()).rejects.toThrow('Failed to attach limiting markers to intel report');
        expect(reportMarkers()).toEqual(OLD);
        expect(h.tables.intel_reports[0]).toMatchObject({ summary: 'original', classification_level: 3 });
        expect(h.timeline).not.toContain('intel_reports:update');
        expect(h.timeline).not.toContain('intel_report_limiting_markers:delete');
        expect(h.orgEmits).toEqual([]);
    });

    it('a failed row write leaves the report OVER-marked (old ∪ new) and throws', async () => {
        h.fail = (op, t) => op === 'update' && t === 'intel_reports';
        await expect(update()).rejects.toThrow('Failed to update intel report');
        expect(reportMarkers()).toEqual([1, 2, 9]);
        expect(h.tables.intel_reports[0]).toMatchObject({ summary: 'original', classification_level: 3 });
        expect(h.orgEmits).toEqual([]);
    });

    it('a failed marker removal leaves the report OVER-marked (old ∪ new) and throws — never success', async () => {
        h.fail = (op, t) => op === 'delete' && t === 'intel_report_limiting_markers';
        await expect(update()).rejects.toThrow('Failed to update limiting markers for intel report');
        expect(reportMarkers()).toEqual([1, 2, 9]);
        expect(h.orgEmits).toEqual([]);
    });

    it('a retry after a partial failure converges on the requested set', async () => {
        h.fail = (op, t) => op === 'delete' && t === 'intel_report_limiting_markers';
        await expect(update()).rejects.toThrow();
        h.fail = null;
        await update();
        expect(reportMarkers()).toEqual(NEW);
    });

    it('no intermediate state is ever under-marked: old content keeps ⊇ old markers, new content ⊇ new markers', async () => {
        const violations: string[] = [];
        h.afterWrite = () => {
            const report = h.tables.intel_reports[0];
            const have = new Set(reportMarkers());
            const need = report.summary === 'edited' ? NEW : OLD;
            for (const m of need) if (!have.has(m)) violations.push(`${String(report.summary)} content missing marker ${m}`);
        };
        await update();
        expect(violations).toEqual([]);
        expect(reportMarkers()).toEqual(NEW);
    });

    it('an unreadable marker set refuses the update before anything is mutated', async () => {
        // The marker read rides the existence read (embedded), so that read failing is the case.
        h.fail = (op, t) => op === 'select' && t === 'intel_reports';
        await expect(update()).rejects.toThrow('Failed to read limiting markers for intel report');
        expect(h.timeline).toEqual(['intel_reports:select']);
        expect(h.tables.intel_reports[0].summary).toBe('original');
        expect(reportMarkers()).toEqual(OLD);
    });

    it('success path: add → row → remove, then one ids-only broadcast', async () => {
        await update();
        expect(reportMarkers()).toEqual(NEW);
        expect(h.tables.intel_reports[0]).toMatchObject({ summary: 'edited', classification_level: 0 });
        expect(h.timeline).toEqual([
            'intel_reports:select',
            'intel_report_limiting_markers:insert',
            'intel_reports:update',
            'intel_report_limiting_markers:delete',
            'broadcast:intel_update',
        ]);
        expect(h.orgEmits).toEqual([{ event: 'intel_update', payload: { kind: 'report' } }]);
    });

    it('success path: an empty marker list still clears the markers', async () => {
        await update([]);
        expect(reportMarkers()).toEqual([]);
        expect(h.timeline).not.toContain('intel_report_limiting_markers:insert');
        expect(h.orgEmits).toEqual([{ event: 'intel_update', payload: { kind: 'report' } }]);
    });

    it('success path: an unchanged marker set issues no junction writes', async () => {
        await update(OLD);
        expect(reportMarkers()).toEqual(OLD);
        expect(h.timeline).toEqual(['intel_reports:select', 'intel_reports:update', 'broadcast:intel_update']);
    });

    it('the removal is scoped to this report — another report\'s markers are untouched', async () => {
        h.tables.intel_report_limiting_markers.push({ report_id: 'other-report', marker_id: 1 });
        await update();
        expect(junction('intel_report_limiting_markers')).toContainEqual({ report_id: 'other-report', marker_id: 1 });
    });
});

describe('syncTrustedFeeds — an ingested item whose markers fail to attach is removed and counted', () => {
    const PEER_FETCHED_AT = '2026-06-05T11:11:11.000Z';
    const emptyPayload = { reports: [], warrants: [], bulletins: [], _meta: { maxShareableLevel: 5, fetchedAt: PEER_FETCHED_AT } };

    function stubFetch(payload: unknown) {
        vi.stubGlobal('fetch', async () => ({
            ok: true, status: 200, statusText: 'OK',
            headers: { get: () => 'application/json' },
            json: async () => payload,
            text: async () => JSON.stringify(payload),
        }));
    }

    beforeEach(() => {
        h.tables.alliance_peers = [{
            id: 'feedA', label: 'Ally Org', base_url: 'https://peer.example',
            outbound_key_enc: 'ak_test', last_contact_at: '2026-06-05T08:00:00.000Z',
            intel_synced_at: '2026-06-05T10:00:00.000Z', inbound_max_clearance: 5,
            pairing_state: 'active',
            channels: { reports: true, warrants: true, bulletins: true },
        }];
        __resetAllianceSyncStateForTests();
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    const report = (id: string, over: Record<string, unknown> = {}) =>
        ({ id, target_id: `T-${id}`, summary: `summary ${id}`, subject_type: 'Person', threat_level: 'High', classification_level: 1, ...over });
    const bulletin = (title: string, over: Record<string, unknown> = {}) =>
        ({ title, body: `body ${title}`, threat_level: 'High', classification_level: 1, ...over });

    it('reports: a failed junction insert deletes the row, counts it skipped, and the rest still ingest', async () => {
        h.fail = failJunctionInsert('intel_report_limiting_markers');
        stubFetch({ ...emptyPayload, reports: [report('r-comp', { limiting_markers: ['GAMMA'] }), report('r-open')] });
        const res = await syncTrustedFeeds();
        // The compartmented report is gone; only the unmarked-by-design one remains.
        expect(h.tables.intel_reports.map((r) => r.external_id)).toEqual(['r-open']);
        expect(junction('intel_report_limiting_markers')).toEqual([]);
        expect(res.totalReports).toBe(1);
        expect(res.skippedItems).toBe(1);
        expect(h.tables.alliance_peers[0].sync_alert).toMatch(/skipped 1 item/);
        // The cursor still advances — a poison item can never stall the feed.
        expect(h.tables.alliance_peers[0].intel_synced_at).toBe(PEER_FETCHED_AT);
    });

    it('reports: a failed junction insert alone produces no realtime nudge', async () => {
        h.fail = failJunctionInsert('intel_report_limiting_markers');
        stubFetch({ ...emptyPayload, reports: [report('r-comp', { limiting_markers: ['GAMMA'] })] });
        const res = await syncTrustedFeeds();
        expect(h.tables.intel_reports).toEqual([]);
        expect(res.totalReports).toBe(0);
        expect(h.orgEmits.filter((e) => e.event === 'intel_update')).toEqual([]);
    });

    it('reports: if the compensating delete also fails, the orphan id is logged and it is still counted failed', async () => {
        h.fail = (op, t, v) => failJunctionInsert('intel_report_limiting_markers')(op, t, v) || (op === 'delete' && t === 'intel_reports');
        stubFetch({ ...emptyPayload, reports: [report('r-comp', { limiting_markers: ['GAMMA'] })] });
        const res = await syncTrustedFeeds();
        const orphanId = h.tables.intel_reports[0]?.id;
        expect(orphanId).toBeDefined();
        expect(h.errors).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ reportId: orphanId }) }));
        expect(res.totalReports).toBe(0);
        expect(res.skippedItems).toBe(1);
    });

    it('reports success path: the compartment is attached by code', async () => {
        stubFetch({ ...emptyPayload, reports: [report('r-comp', { limiting_markers: ['GAMMA'] })] });
        const res = await syncTrustedFeeds();
        const id = h.tables.intel_reports[0].id;
        expect(junction('intel_report_limiting_markers')).toEqual([{ report_id: id, marker_id: 9 }]);
        expect(res.totalReports).toBe(1);
        expect(res.skippedItems).toBe(0);
        expect(h.orgEmits.filter((e) => e.event === 'intel_update')).toEqual([{ event: 'intel_update', payload: { kind: 'report' } }]);
    });

    it('bulletins: a failed junction insert deletes the row, counts it skipped, never nudges it, and the rest still ingest', async () => {
        h.fail = failJunctionInsert('intel_bulletin_limiting_markers');
        stubFetch({ ...emptyPayload, bulletins: [bulletin('Compartmented', { limiting_markers: ['GAMMA'] }), bulletin('Open')] });
        const res = await syncTrustedFeeds();
        expect(h.tables.intel_bulletins.map((b) => b.title)).toEqual(['Open']);
        expect(junction('intel_bulletin_limiting_markers')).toEqual([]);
        expect(res.totalBulletins).toBe(1);
        expect(res.skippedItems).toBe(1);
        expect(h.tables.alliance_peers[0].sync_alert).toMatch(/skipped 1 item/);
        // Only the surviving bulletin is nudged.
        expect(h.orgEmits.filter((e) => e.event === 'bulletin_update'))
            .toEqual([{ event: 'bulletin_update', payload: { bulletinId: h.tables.intel_bulletins[0].id } }]);
    });

    it('bulletins: if the compensating delete also fails, the orphan id is logged and it is still counted failed', async () => {
        h.fail = (op, t, v) => failJunctionInsert('intel_bulletin_limiting_markers')(op, t, v) || (op === 'delete' && t === 'intel_bulletins');
        stubFetch({ ...emptyPayload, bulletins: [bulletin('Compartmented', { limiting_markers: ['GAMMA'] })] });
        const res = await syncTrustedFeeds();
        const orphanId = h.tables.intel_bulletins[0]?.id;
        expect(orphanId).toBeDefined();
        expect(h.errors).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ bulletinId: orphanId }) }));
        expect(res.totalBulletins).toBe(0);
        expect(res.skippedItems).toBe(1);
        expect(h.orgEmits.filter((e) => e.event === 'bulletin_update')).toEqual([]);
    });

    it('bulletins success path: the compartment is attached by code and the bulletin is nudged', async () => {
        stubFetch({ ...emptyPayload, bulletins: [bulletin('Compartmented', { limiting_markers: ['GAMMA'] })] });
        const res = await syncTrustedFeeds();
        const id = h.tables.intel_bulletins[0].id;
        expect(junction('intel_bulletin_limiting_markers')).toEqual([{ bulletin_id: id, marker_id: 9 }]);
        expect(res.totalBulletins).toBe(1);
        expect(res.skippedItems).toBe(0);
        expect(h.orgEmits.filter((e) => e.event === 'bulletin_update')).toEqual([{ event: 'bulletin_update', payload: { bulletinId: id } }]);
    });
});
