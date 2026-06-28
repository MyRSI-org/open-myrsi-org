import { describe, it, expect, vi, beforeEach } from 'vitest';

// Follow-up intel hardening (cluster intel2):
//   c6  — getDossier operations list engages the special-op participation gate
//         (clearance-0 invite-only ops hidden from non-owner/non-manager/
//         non-participant viewers).                              lib/db/intel.ts
//   c14 — getIntelStats / getIntelHubStats counts are limiting-MARKER filtered
//         (not just clearance-level ceilinged) for non-bypass viewers, so
//         compartmented report volume can't be inferred.         lib/db/intel.ts
//   c18 — federated warrant ingest normalises action/status/uec_reward (pure
//         helpers, mirrors the own-org write boundary).          lib/db/intel.ts
//
// All lib-level tests run against a select-string-aware stateless supabase mock
// (mirrors tests/intelReadPathScoping.test.ts) so each query resolves from a
// per-table fixture.

const h = vi.hoisted(() => ({
    resolveQuery: ((_q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => ({ data: null as unknown, error: null as unknown })) as (q: { table: string; calls: Array<{ method: string; args: unknown[] }> }) => { data?: unknown; error?: unknown; count?: number },
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
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
        supabase: { from: (t: string) => statelessBuilder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.broadcasts.push({ event, payload }); },
        broadcastToChannel: () => {},
        safeFetch: async (q: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
            try { const { data, error } = await q; return error ? fallback : (data ?? fallback); } catch { return fallback; }
        },
        getSystemRoles: async () => ({}),
    };
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
vi.mock('../lib/push', () => ({ sendPushToStaff: vi.fn(), sendPushToUsers: vi.fn() }));

import {
    getDossier, getIntelStats, getIntelHubStats, getIntelTargetIndex,
    normalizeWarrantStatus, normalizeWarrantUecReward,
} from '../lib/db/intel';
import { WarrantStatus } from '../types';

type Viewer = { id?: number; role?: string; permissions?: string[]; clearanceLevel?: { level?: number } | null; limitingMarkers?: unknown[] };
const viewer = (over: Partial<Viewer> = {}): Viewer => ({ id: 6, role: 'Member', permissions: [], clearanceLevel: { level: 0 }, limitingMarkers: [], ...over });

beforeEach(() => {
    h.resolveQuery = () => ({ data: null, error: null });
    h.broadcasts = [];
});

// ---------------------------------------------------------------------------
// c6 — getDossier special-op participation gate
// ---------------------------------------------------------------------------
describe('c6 getDossier operations list hides invite-only special ops', () => {
    const SUBJECT_ID = 42;       // the dossier subject (participant on both ops)
    const OWNER_ID = 999;        // the ops' commander

    // A clearance-0 invite-only special op: it has NO clearance/marker barrier
    // (the join PIN is the gate), so a level-only filter would leak it.
    const SPECIAL_OP = { id: 'op-special', name: 'Black Site Raid', status: 'Planning', type: 'Covert', description: 'TACTICAL PLAN — compartmented', created_at: '2026-02-01T00:00:00.000Z', owner_id: OWNER_ID, clearance_level: 0, is_special: true, limiting_markers: [], participants: [{ user_id: SUBJECT_ID }] };
    const NORMAL_OP = { id: 'op-normal', name: 'Border Patrol', status: 'Active', type: 'Patrol', description: 'routine', created_at: '2026-02-02T00:00:00.000Z', owner_id: OWNER_ID, clearance_level: 0, is_special: false, limiting_markers: [], participants: [{ user_id: SUBJECT_ID }] };

    // viewerParticipation drives the viewer's own active operation_participants
    // rows (configurable per-test); defaults to "viewer participates in nothing".
    let viewerParticipation: Array<{ operation_id: string }> = [];

    function dossierFixture(ops: Array<Record<string, unknown>>) {
        viewerParticipation = [];
        h.resolveQuery = ({ table, calls }) => {
            const sel = String(calls.find(c => c.method === 'select')?.args[0] ?? '');
            if (table === 'users') return { data: { id: SUBJECT_ID }, error: null };
            if (table === 'intel_reports') {
                if (sel === 'subject_type') return { data: { subject_type: 'Person' }, error: null };
                return { data: [], error: null };
            }
            if (table === 'operations') return { data: ops, error: null };
            if (table === 'operation_participants') return { data: viewerParticipation, error: null };
            if (table === 'warrants') return { data: [], error: null };
            if (table === 'service_requests') return { data: [], error: null };
            if (table === 'dossier_summaries') return { data: null, error: null };
            return { data: [], error: null };
        };
    }

    it('a plain Member (not owner / not manager / not participant) does NOT see the special op', async () => {
        dossierFixture([SPECIAL_OP, NORMAL_OP]);
        const d = await getDossier('subject', viewer({ permissions: ['intel:view'] }));
        const ids = d.operations.map(o => o.id);
        expect(ids).toContain('op-normal');     // non-special clearance-0 op still visible (no regression)
        expect(ids).not.toContain('op-special');// invite-only special op excluded
    });

    it('an operations:manage viewer DOES see the special op', async () => {
        dossierFixture([SPECIAL_OP, NORMAL_OP]);
        const d = await getDossier('subject', viewer({ permissions: ['intel:view', 'operations:manage'] }));
        expect(d.operations.map(o => o.id)).toEqual(expect.arrayContaining(['op-special', 'op-normal']));
    });

    it('the op OWNER sees the special op', async () => {
        dossierFixture([SPECIAL_OP, NORMAL_OP]);
        const d = await getDossier('subject', viewer({ id: OWNER_ID, permissions: ['intel:view'] }));
        expect(d.operations.map(o => o.id)).toContain('op-special');
    });

    it('a non-owner Member who IS an active participant sees the special op (behaviour parity with the list path)', async () => {
        dossierFixture([SPECIAL_OP, NORMAL_OP]);
        viewerParticipation = [{ operation_id: 'op-special' }]; // viewer is an active participant
        const d = await getDossier('subject', viewer({ permissions: ['intel:view'] }));
        expect(d.operations.map(o => o.id)).toContain('op-special');
    });

    it('the special op tactical description never crosses the wire to a plain Member', async () => {
        dossierFixture([SPECIAL_OP, NORMAL_OP]);
        const d = await getDossier('subject', viewer({ permissions: ['intel:view'] }));
        expect(JSON.stringify(d)).not.toContain('compartmented');
    });
});

// ---------------------------------------------------------------------------
// c14 — stats counts are limiting-marker filtered, not just level-ceilinged
// ---------------------------------------------------------------------------
describe('c14 intel stats counts exclude marker-gated reports (clearance-markers volume inference)', () => {
    const RECENT = new Date(Date.now() - 60 * 1000).toISOString();
    const OLD = '2000-01-01T00:00:00.000Z';
    // r2 is at/below the viewer's clearance LEVEL but carries marker GAMMA the
    // viewer does NOT hold — it must be excluded from the counts/breakdown even
    // though the level ceiling alone would include it.
    const REPORTS = [
        { id: 'r1', target_id: 't1', threat_level: 'High', classification_level: 0, created_at: RECENT, intel_report_limiting_markers: [] },
        { id: 'r2', target_id: 't2', threat_level: 'Critical', classification_level: 0, created_at: RECENT, intel_report_limiting_markers: [{ marker: { id: 7, code: 'GAMMA' } }] },
        { id: 'r3', target_id: 't3', threat_level: 'Low', classification_level: 0, created_at: OLD, intel_report_limiting_markers: [] },
    ];

    function statsFixture() {
        h.resolveQuery = ({ table, calls }) => {
            if (table === 'intel_reports') {
                const lte = calls.find(c => c.method === 'lte' && c.args[0] === 'classification_level');
                const inThreat = calls.find(c => c.method === 'in' && c.args[0] === 'threat_level');
                const gteCreated = calls.find(c => c.method === 'gte' && c.args[0] === 'created_at');
                let rows = REPORTS as Array<Record<string, unknown>>;
                if (lte) rows = rows.filter(r => Number(r.classification_level) <= Number(lte.args[1]));
                if (inThreat) rows = rows.filter(r => (inThreat.args[1] as string[]).includes(String(r.threat_level)));
                if (gteCreated) rows = rows.filter(r => String(r.created_at) >= String(gteCreated.args[1]));
                return { data: rows, count: rows.length, error: null };
            }
            if (table === 'warrants') return { data: [{ id: 'w1' }, { id: 'w2' }], count: 2, error: null };
            return { data: [], count: 0, error: null };
        };
    }

    it('getIntelStats excludes the marker-gated report from totalReports + threatBreakdown for a viewer lacking the marker', async () => {
        statsFixture();
        const stats = await getIntelStats(viewer({ permissions: ['intel:view'] }));
        expect(stats.totalReports).toBe(2);              // r2 (GAMMA) excluded
        expect(stats.threatBreakdown.High).toBe(1);
        expect(stats.threatBreakdown.Low).toBe(1);
        expect(stats.threatBreakdown.Critical ?? 0).toBe(0); // the only Critical was marker-gated
    });

    it('getIntelHubStats excludes the marker-gated report from total/critical/recent counts', async () => {
        statsFixture();
        const stats = await getIntelHubStats(viewer({ permissions: ['intel:view'] }));
        expect(stats.totalReports).toBe(2);   // r2 excluded
        expect(stats.criticalCount).toBe(1);  // r1 (High) counts; r2 (Critical) excluded by marker
        expect(stats.recentCount7d).toBe(1);  // only r1 is recent + visible (r3 old, r2 excluded)
    });

    it('a viewer WHO HOLDS the marker sees the marker-gated report counted', async () => {
        statsFixture();
        const held = viewer({ permissions: ['intel:view'], limitingMarkers: [{ id: 7, code: 'GAMMA' }] });
        const stats = await getIntelStats(held);
        expect(stats.totalReports).toBe(3);
        expect(stats.threatBreakdown.Critical).toBe(1);
    });

    it('Admin / intel:manage still see ALL reports via the count-pushdown path (bypass unchanged)', async () => {
        statsFixture();
        const admin = await getIntelStats(viewer({ role: 'Admin' }));
        expect(admin.totalReports).toBe(3);
        expect(admin.threatBreakdown.Critical).toBe(1);
        expect(admin.activeWarrants).toBe(2);

        const hub = await getIntelHubStats(viewer({ permissions: ['intel:manage'] }));
        expect(hub.totalReports).toBe(3);
        expect(hub.criticalCount).toBe(2); // r1 High + r2 Critical, no marker filter for bypass
    });

    it('the asymmetry-closed invariant holds: stats total <= marker-filtered index count for the same viewer', async () => {
        statsFixture();
        const v = viewer({ permissions: ['intel:view'] });
        const stats = await getIntelStats(v);
        const index = await getIntelTargetIndex(v);
        expect(stats.totalReports).toBeLessThanOrEqual(index.length);
        expect(index.map(e => e.targetId).sort()).toEqual(['t1', 't3']); // t2 (GAMMA) hidden from the index too
        expect(stats.totalReports).toBe(index.length);                   // exact consistency on this fixture
    });
});

// ---------------------------------------------------------------------------
// c18 — federated warrant ingest normalisation helpers (pure)
// ---------------------------------------------------------------------------
describe('c18 federated warrant ingest normalisation (warrant-feed hygiene)', () => {
    it('normalizeWarrantStatus accepts the real enum and defaults everything else to Active', () => {
        expect(normalizeWarrantStatus('Active')).toBe(WarrantStatus.Active);
        expect(normalizeWarrantStatus('Standing')).toBe(WarrantStatus.Standing);
        expect(normalizeWarrantStatus('Claimed')).toBe(WarrantStatus.Claimed);
        expect(normalizeWarrantStatus('Cancelled')).toBe(WarrantStatus.Cancelled);
        // Arbitrary peer-supplied strings / wrong types fall back to Active (fail closed).
        expect(normalizeWarrantStatus('PWNED')).toBe(WarrantStatus.Active);
        expect(normalizeWarrantStatus('')).toBe(WarrantStatus.Active);
        expect(normalizeWarrantStatus(undefined)).toBe(WarrantStatus.Active);
        expect(normalizeWarrantStatus(123)).toBe(WarrantStatus.Active);
        expect(normalizeWarrantStatus({ status: 'Active' })).toBe(WarrantStatus.Active);
    });

    it('normalizeWarrantUecReward coerces to a bounded non-negative integer, else null', () => {
        expect(normalizeWarrantUecReward(5000)).toBe(5000);
        expect(normalizeWarrantUecReward('2500')).toBe(2500);  // numeric string coerced
        expect(normalizeWarrantUecReward(0)).toBe(0);
        expect(normalizeWarrantUecReward(12.9)).toBe(12);      // floored
        expect(normalizeWarrantUecReward(-1)).toBeNull();      // negative rejected
        expect(normalizeWarrantUecReward(null)).toBeNull();
        expect(normalizeWarrantUecReward(undefined)).toBeNull();
        expect(normalizeWarrantUecReward('not a number')).toBeNull();
        expect(normalizeWarrantUecReward(Number.POSITIVE_INFINITY)).toBeNull();
        expect(normalizeWarrantUecReward(NaN)).toBeNull();
        // Absurd/overflow bounty is clamped, never stored verbatim.
        expect(normalizeWarrantUecReward(1e30)).toBe(1_000_000_000_000);
    });
});
