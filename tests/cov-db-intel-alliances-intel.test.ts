import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fake, broadcastSpy, filters, hasCall, columnsOf, assertNoWildcardSelects, type FakeQuery } from './cov-db-intel-alliances-fake';

// =============================================================================
// lib/db/intel.ts (non-feed half) — warrants + append-only notes, report
// create/update with fail-closed marker validation and over-mark-never-under-mark
// write ordering, the dossier (escaped LIKE everywhere, clearance-filtered
// affiliates, op gate inputs, summary gating), cursor-paginated list with
// visible-set page accounting, clearance-filtered stats/index, bulk caps, search
// sanitisation, maintenance dedupe jobs, and bulletins (restriction probe fails
// closed, marker rollback, id-only emits).
// =============================================================================

const m = vi.hoisted(() => ({
    verifyApiKey: vi.fn(),
    getPublicFeedData: vi.fn(),
    canUserSeeOpInList: vi.fn(),
    ssrfSafeFetch: vi.fn(),
    getCachedAllianceSyncConfig: vi.fn(),
    recordPeerFailure: vi.fn(),
    recordPeerSuccess: vi.fn(),
    setSyncAlert: vi.fn(),
}));

vi.mock('../lib/db/common.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/db/common.js')>();
    const h = await import('./cov-db-intel-alliances-fake');
    return { ...actual, supabase: h.fake.client, broadcastToOrg: h.broadcastSpy };
});
vi.mock('../lib/db/system.js', () => ({ verifyApiKey: m.verifyApiKey, getPublicFeedData: m.getPublicFeedData }));
vi.mock('../lib/db/ops.js', () => ({ canUserSeeOpInList: m.canUserSeeOpInList }));
vi.mock('../lib/ssrf.js', () => ({ ssrfSafeFetch: m.ssrfSafeFetch }));
vi.mock('../lib/crypto.js', () => ({ decryptSecret: (s: string) => s }));
vi.mock('../lib/db/allianceSyncState.js', () => ({
    getCachedAllianceSyncConfig: m.getCachedAllianceSyncConfig,
    recordPeerFailure: m.recordPeerFailure,
    recordPeerSuccess: m.recordPeerSuccess,
    setSyncAlert: m.setSyncAlert,
}));

import {
    normalizeThreatLevel, normalizeWarrantStatus, normalizeWarrantUecReward, filterIntelByClearance,
    createWarrant, updateWarrant, deleteWarrant, bulkDeleteWarrants, getWarrantByIdHydrated, addWarrantNote,
    getWarrantNotes, generateReportFromWarrant, createIntelReport, updateIntelReport, getIntelReportsForTarget,
    getDossier, getRecentIntelReports, listIntelReports, getIntelHubStats, getIntelTargetIndex,
    updateIntelAffiliation, bulkUpdateIntelAffiliation, bulkAddIntelTags, bulkDeleteIntelReports,
    deleteIntelReport, searchIntelReports, getIntelStats, syncWarrantsToReports, deduplicateWarrants,
    deduplicateIntelReports, saveDossierSummary, bulletinIsRestricted, createIntelBulletin,
    getActiveBulletins, getBulletinByIdForViewer, deleteIntelBulletin, cleanupExpiredBulletins,
} from '../lib/db/intel';

const NF = { id: 7, name: 'NOFORN', code: 'NF' };
const MANAGER = { clearanceLevel: { level: 0 }, permissions: ['intel:manage'] };
const LOW = { id: 3, clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: ['intel:view'] };
const CLEARED = { id: 4, clearanceLevel: { level: 2 }, limitingMarkers: [NF], permissions: ['intel:view', 'warrant:view'] };
const UUID = '0b8a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';

const isCount = (q: FakeQuery) => (q.selectOptions as { head?: boolean } | undefined)?.head === true;
const emitsOf = (event: string) => broadcastSpy.mock.calls.filter((c) => (c as unknown[])[0] === event).map((c) => (c as unknown[])[1]);
const reportRow = (over: Record<string, unknown> = {}) => ({
    id: 'r1', target_id: 'Target', subject_type: 'Person', threat_level: 'High', tags: [], summary: 's', evidence_urls: [],
    external_author: null, affiliated_org: null, created_at: '2026-10-01T00:00:00Z', classification_level: 0,
    intel_report_limiting_markers: [], ...over,
});

beforeEach(() => {
    fake.reset();
    broadcastSpy.mockClear();
    vi.clearAllMocks();
    m.canUserSeeOpInList.mockReturnValue(true);
});
afterEach(() => {
    assertNoWildcardSelects(fake);
    vi.restoreAllMocks();
});

// =============================================================================
describe('pure normalisers', () => {
    it('threat level, warrant status and reward are clamped to known/bounded values', () => {
        expect(normalizeThreatLevel('Critical')).toBe('Critical');
        expect(normalizeThreatLevel('Apocalyptic')).toBe('Medium');
        expect(normalizeThreatLevel(3)).toBe('Medium');
        expect(normalizeWarrantStatus('Standing')).toBe('Standing');
        expect(normalizeWarrantStatus('<b>x</b>')).toBe('Active');
        expect(normalizeWarrantUecReward(null)).toBeNull();
        expect(normalizeWarrantUecReward('12.9')).toBe(12);
        expect(normalizeWarrantUecReward(-1)).toBeNull();
        expect(normalizeWarrantUecReward(Infinity)).toBeNull();
        expect(normalizeWarrantUecReward(1e20)).toBe(1_000_000_000_000);
    });

    it('filterIntelByClearance hides above-level and unheld-marker items; intel:manage sees all', () => {
        const items = [{ id: 1, classificationLevel: 0 }, { id: 2, classificationLevel: 3 }, { id: 3, classificationLevel: 0, limitingMarkers: [NF] }];
        expect(filterIntelByClearance(items, LOW).map((i) => i.id)).toEqual([1]);
        expect(filterIntelByClearance(items, CLEARED).map((i) => i.id)).toEqual([1, 3]);
        expect(filterIntelByClearance(items, MANAGER).map((i) => i.id)).toEqual([1, 2, 3]);
        expect(filterIntelByClearance(items, null).map((i) => i.id)).toEqual([1]);
    });
});

// =============================================================================
describe('warrants', () => {
    it('create strips + caps text, attributes the issuer, and emits the new id', async () => {
        fake.queue('warrants', { data: { id: 'w1' } });
        await createWarrant({ targetRsiHandle: '<b>Bad</b>\nGuy', reason: `<script>x</script>${'r'.repeat(9000)}`, action: '<i>Arrest</i>', uecReward: 5, status: 'Active', notes: '<u>n</u>' }, 9);
        const ins = fake.find('warrants', 'insert')[0];
        const p = ins.payload as Record<string, unknown>;
        expect(p).toMatchObject({ target_rsi_handle: 'Bad Guy', action: 'Arrest', uec_reward: 5, status: 'Active', issued_by: 9, notes: 'n' });
        expect((p.reason as string).length).toBeLessThanOrEqual(8000);
        expect(p.reason).not.toContain('<script>');
        expect(ins.columns).toBe('id');
        expect(emitsOf('warrant_update')).toEqual([{ warrantId: 'w1' }]);
        expect(fake.find('intel_reports')).toHaveLength(0);
    });

    it('create falls back to payload issuer, leaves optional fields undefined, emits id-less when no row', async () => {
        fake.queue('warrants', { data: null });
        await createWarrant({ targetRsiHandle: 'x', reason: 'y', issuedById: 4 });
        expect(fake.find('warrants', 'insert')[0].payload).toMatchObject({ issued_by: 4, action: undefined, notes: undefined });
        expect(emitsOf('warrant_update')).toEqual([{}]);
    });

    it('create surfaces an insert error', async () => {
        fake.queue('warrants', { data: null, error: { message: 'x' } });
        await expect(createWarrant({ targetRsiHandle: 'x', reason: 'y' }, 1)).rejects.toThrow('Failed to create warrant');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('autoFileReport files a level-0 intel report; its failure is logged, never fatal', async () => {
        fake.queue('warrants', { data: { id: 'w1' } });
        fake.queue('intel_reports', { data: { id: 'r9' } });
        await createWarrant({ targetRsiHandle: 'Bad', reason: 'theft', autoFileReport: true }, 9);
        const rep = fake.find('intel_reports', 'insert')[0];
        expect(rep.payload).toMatchObject({ target_id: 'Bad', subject_type: 'Person', threat_level: 'High', tags: ['Caution Note'], created_by_id: 9, classification_level: 0, summary: '[AUTOMATED REPORT FROM CAUTION NOTE] theft' });
        fake.queue('warrants', { data: { id: 'w2' } });
        fake.queue('intel_reports', { data: null, error: { message: 'x' } });
        await expect(createWarrant({ targetRsiHandle: 'Bad', reason: 'theft', autoFileReport: true }, 9)).resolves.toBeUndefined();
        expect(emitsOf('warrant_update')).toContainEqual({ warrantId: 'w2' });
    });

    it('update sanitises changed fields only and sets/clears the claim per status', async () => {
        await updateWarrant('w1', { updates: { targetRsiHandle: '<b>T</b>', reason: '<i>R</i>', action: 'A', notes: 'N', uecReward: 3, status: 'Claimed' }, claimedById: 5 });
        const u1 = fake.find('warrants', 'update')[0];
        expect(u1.payload).toMatchObject({ target_rsi_handle: 'T', reason: 'R', action: 'A', notes: 'N', uec_reward: 3, status: 'Claimed', claimed_by: 5 });
        expect(typeof (u1.payload as Record<string, unknown>).claimed_at).toBe('string');
        expect(hasCall(u1, 'eq', 'id', 'w1')).toBe(true);
        await updateWarrant('w1', { updates: { status: 'Active' } });
        expect(fake.find('warrants', 'update')[1].payload).toMatchObject({ claimed_by: null, claimed_at: null, target_rsi_handle: undefined, reason: undefined });
        await updateWarrant('w1', {});
        expect('claimed_by' in (fake.find('warrants', 'update')[2].payload as object)).toBe(false);
        expect(emitsOf('warrant_update')).toEqual([{ warrantId: 'w1' }, { warrantId: 'w1' }, { warrantId: 'w1' }]);
        fake.queue('warrants', { error: { message: 'x' } });
        await expect(updateWarrant('w1', {})).rejects.toThrow('Failed to update warrant');
    });

    it('delete / bulk delete scope by id(s) and emit ids only', async () => {
        await deleteWarrant('w1');
        expect(hasCall(fake.find('warrants', 'delete')[0], 'eq', 'id', 'w1')).toBe(true);
        await bulkDeleteWarrants(['a', 'b']);
        expect(hasCall(fake.find('warrants', 'delete')[1], 'in', 'id', ['a', 'b'])).toBe(true);
        expect(emitsOf('warrant_update')).toEqual([{ warrantId: 'w1' }, { warrantIds: ['a', 'b'] }]);
        fake.queue('warrants', { error: { message: 'x' } });
        await expect(deleteWarrant('w1')).rejects.toThrow('Failed to delete warrant');
    });

    it('slice fetch maps the list row, returns null when gone, and throws on error', async () => {
        fake.queue('warrants', { data: { id: 'w1', target_rsi_handle: 'T', reason: 'r', status: 'Active', created_at: 'c', feed: { label: 'Ally' } } }, { data: null }, { data: null, error: { message: 'x' } });
        expect(await getWarrantByIdHydrated('w1')).toMatchObject({ id: 'w1', targetRsiHandle: 'T', sourceFeedLabel: 'Ally' });
        expect(columnsOf(fake.find('warrants')[0])).toContain('feed:alliance_peers(id, label)');
        expect(await getWarrantByIdHydrated('w2')).toBeNull();
        await expect(getWarrantByIdHydrated('w3')).rejects.toThrow('Failed to get warrant slice');
    });

    describe('notes', () => {
        it('rejects empty notes and unknown warrants', async () => {
            await expect(addWarrantNote('w1', '   ', 1)).rejects.toThrow('Warrant note content is required');
            await expect(addWarrantNote('w1', null as unknown as string, 1)).rejects.toThrow('Warrant note content is required');
            fake.queue('warrants', { count: 0 });
            await expect(addWarrantNote('w1', 'hi', 1)).rejects.toThrow('Warrant not found');
            expect(fake.find('warrant_notes')).toHaveLength(0);
        });

        it('appends a stripped note, mirrors it to warrants.notes, and emits', async () => {
            fake.queue('warrants', { count: 1 }, { error: null });
            await addWarrantNote('w1', '  <b>Seen</b> at Lorville  ', 5);
            const cnt = fake.find('warrants')[0];
            expect(isCount(cnt)).toBe(true);
            expect(hasCall(cnt, 'eq', 'id', 'w1')).toBe(true);
            expect(fake.find('warrant_notes', 'insert')[0].payload).toEqual({ warrant_id: 'w1', author_id: 5, content: 'Seen at Lorville' });
            expect(fake.find('warrants', 'update')[0].payload).toMatchObject({ notes: 'Seen at Lorville' });
            expect(emitsOf('warrant_update')).toEqual([{ warrantId: 'w1' }]);
        });

        it('soft-fails a missing notes table (42P01) but surfaces any other insert error', async () => {
            fake.queue('warrants', { count: 1 });
            fake.queue('warrant_notes', { error: { code: '42P01', message: 'missing' } });
            await addWarrantNote('w1', 'x', 5);
            expect(fake.find('warrants', 'update')).toHaveLength(1);
            fake.queue('warrants', { count: 1 });
            fake.queue('warrant_notes', { error: { code: '23503', message: 'fk' } });
            await expect(addWarrantNote('w1', 'x', 5)).rejects.toThrow('Failed to add warrant note');
        });

        it('lists notes newest-first only for an existing warrant', async () => {
            fake.queue('warrants', { count: 0 });
            expect(await getWarrantNotes('w1')).toEqual([]);
            expect(fake.find('warrant_notes')).toHaveLength(0);
            fake.queue('warrants', { count: 1 });
            fake.queue('warrant_notes', { data: [
                { id: 'n1', warrant_id: 'w1', author_id: 5, content: 'c', created_at: 't', author: { id: 5, name: 'A' } },
                { id: 'n2', warrant_id: 'w1', author_id: null, content: 'd', created_at: 't2', author: null },
            ] });
            const out = await getWarrantNotes('w1');
            expect(out.map((n) => [n.id, n.authorId, n.author?.name])).toEqual([['n1', 5, 'A'], ['n2', null, undefined]]);
            const q = fake.find('warrant_notes')[0];
            expect(hasCall(q, 'order', 'created_at', { ascending: false })).toBe(true);
            expect(q.columns).toContain('author:users!warrant_notes_author_id_fkey(id, name, avatar_url, role_id)');
        });

        it('notes: pre-migration table returns empty; other errors throw; null data → []', async () => {
            fake.queue('warrants', { count: 1 }, { count: 1 }, { count: 1 });
            fake.queue('warrant_notes', { data: null, error: { code: '42P01' } }, { data: null, error: { code: 'XX' } }, { data: null });
            expect(await getWarrantNotes('w1')).toEqual([]);
            await expect(getWarrantNotes('w1')).rejects.toThrow('Failed to load warrant notes');
            expect(await getWarrantNotes('w1')).toEqual([]);
        });
    });

    it('generateReportFromWarrant files a report for an existing warrant only', async () => {
        fake.queue('warrants', { data: null });
        await generateReportFromWarrant('w0', 1);
        expect(fake.find('intel_reports')).toHaveLength(0);
        fake.queue('warrants', { data: { target_rsi_handle: 'Bad', reason: 'piracy' } });
        fake.queue('intel_reports', { data: { id: 'r1' } });
        await generateReportFromWarrant('w1', 6);
        expect(fake.find('intel_reports', 'insert')[0].payload).toMatchObject({ target_id: 'Bad', created_by_id: 6, summary: '[AUTOMATED REPORT FROM CAUTION NOTE] piracy' });
    });
});

// =============================================================================
describe('createIntelReport / updateIntelReport', () => {
    it('refuses mislabel-up and unheld markers before any query', async () => {
        await expect(createIntelReport({ user: LOW, classificationLevel: 1, targetId: 'x' })).rejects.toThrow('above your own clearance');
        await expect(createIntelReport({ user: LOW, markerIds: [7], targetId: 'x' })).rejects.toThrow('limiting marker you do not hold');
        expect(fake.queries).toHaveLength(0);
    });

    it('validates marker ids BEFORE inserting (fail closed on read error / foreign ids)', async () => {
        fake.queue('security_limiting_markers', { data: null, error: { message: 'x' } });
        await expect(createIntelReport({ user: MANAGER, markerIds: [7], targetId: 'x' })).rejects.toThrow('Failed to verify limiting markers for intel report');
        fake.queue('security_limiting_markers', { data: [{ id: 7 }] });
        await expect(createIntelReport({ user: MANAGER, markerIds: [7, 99], targetId: 'x' })).rejects.toThrow('not valid for this organization');
        fake.queue('security_limiting_markers', { data: null });
        await expect(createIntelReport({ user: MANAGER, markerIds: [7], targetId: 'x' })).rejects.toThrow('not valid for this organization');
        expect(fake.find('intel_reports')).toHaveLength(0);
        expect(hasCall(fake.find('security_limiting_markers')[0], 'in', 'id', [7])).toBe(true);
    });

    it('inserts sanitised fields (evidence allow-list, tag caps), attaches markers, emits kind:report', async () => {
        fake.queue('security_limiting_markers', { data: [{ id: 7 }] });
        fake.queue('intel_reports', { data: { id: 'r1' } });
        await createIntelReport({
            user: CLEARED, markerIds: [7], classificationLevel: 2, targetId: '<b>Tgt</b>', subjectType: 'Person', threatLevel: 'Bogus',
            tags: Array.from({ length: 30 }, (_, i) => `<i>t${i}</i>`), summary: '<script>x</script>sum',
            evidenceUrls: ['https://ok.example-intel.net/a', 'javascript:alert(1)', 'http://plain.net', 'https://10.0.0.1/x'],
            createdById: 4, affiliatedOrg: '<b>ORG</b>',
        });
        const p = fake.find('intel_reports', 'insert')[0].payload as Record<string, unknown>;
        expect(p).toMatchObject({ target_id: 'Tgt', threat_level: 'Medium', affiliated_org: 'ORG', classification_level: 2, created_by_id: 4 });
        expect(p.evidence_urls).toEqual(['https://ok.example-intel.net/a']);
        expect((p.tags as string[]).length).toBe(20);
        expect((p.tags as string[])[0]).toBe('t0');
        expect(p.summary).not.toContain('<script>');
        expect(fake.find('intel_report_limiting_markers', 'insert')[0].payload).toEqual([{ report_id: 'r1', marker_id: 7 }]);
        expect(emitsOf('intel_update')).toEqual([{ kind: 'report' }]);
    });

    it('accepts snake threat_level, nulls a blank org, and skips markers when none were asked for', async () => {
        fake.queue('intel_reports', { data: { id: 'r1' } });
        await createIntelReport({ targetId: 'x', threat_level: 'Low', tags: 'nope', evidenceUrls: 'nope' });
        const p = fake.find('intel_reports', 'insert')[0].payload as Record<string, unknown>;
        expect(p).toMatchObject({ threat_level: 'Low', affiliated_org: null, classification_level: 0, tags: [], evidence_urls: undefined });
        expect(fake.find('intel_report_limiting_markers')).toHaveLength(0);
    });

    it('rolls the report back (and throws, no emit) when the marker attach fails', async () => {
        fake.queue('security_limiting_markers', { data: [{ id: 7 }] }, { data: [{ id: 7 }] });
        fake.queue('intel_reports', { data: { id: 'r1' } }, { error: null }, { data: { id: 'r2' } }, { error: { message: 'locked' } });
        fake.queue('intel_report_limiting_markers', { error: { message: 'fk' } }, { error: { message: 'fk' } });
        await expect(createIntelReport({ user: MANAGER, markerIds: [7], targetId: 'x' })).rejects.toThrow('Failed to attach limiting markers to intel report');
        expect(hasCall(fake.find('intel_reports', 'delete')[0], 'eq', 'id', 'r1')).toBe(true);
        await expect(createIntelReport({ user: MANAGER, markerIds: [7], targetId: 'x' })).rejects.toThrow('Failed to attach limiting markers to intel report');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('surfaces the insert error', async () => {
        fake.queue('intel_reports', { data: null, error: { message: 'x' } });
        await expect(createIntelReport({ targetId: 'x' })).rejects.toThrow('Failed to create intel report');
    });

    it('update refuses when the current marker set is unreadable or the report is missing', async () => {
        fake.queue('intel_reports', { data: null, error: { message: 'x' } });
        await expect(updateIntelReport('r1', {})).rejects.toThrow('Failed to read limiting markers for intel report');
        fake.queue('intel_reports', { data: null });
        await expect(updateIntelReport('r1', {})).rejects.toThrow('Intel report not found');
        expect(fake.find('intel_reports', 'update')).toHaveLength(0);
        expect(fake.find('intel_reports')[0].columns).toBe('id, intel_report_limiting_markers(marker_id)');
    });

    it('update orders writes ADD → row → REMOVE so a failure leaves it over-marked, never under-marked', async () => {
        fake.queue('intel_reports', { data: { id: 'r1', intel_report_limiting_markers: [{ marker_id: 1 }, { marker_id: 2 }] } });
        await updateIntelReport('r1', { markerIds: [2, 3], threatLevel: 'High', tags: ['a'], summary: 'S', evidenceUrls: ['javascript:x'], subjectType: 'Person', affiliatedOrg: '', classificationLevel: 1 });
        const ops = fake.queries.filter((q) => q.op !== 'select').map((q) => `${q.table}:${q.op}`);
        expect(ops).toEqual(['intel_report_limiting_markers:insert', 'intel_reports:update', 'intel_report_limiting_markers:delete']);
        expect(fake.find('intel_report_limiting_markers', 'insert')[0].payload).toEqual([{ report_id: 'r1', marker_id: 3 }]);
        const del = fake.find('intel_report_limiting_markers', 'delete')[0];
        expect(hasCall(del, 'eq', 'report_id', 'r1')).toBe(true);
        expect(hasCall(del, 'in', 'marker_id', [1])).toBe(true);
        expect(fake.find('intel_reports', 'update')[0].payload).toMatchObject({ threat_level: 'High', evidence_urls: [], affiliated_org: null, classification_level: 1 });
        expect(emitsOf('intel_update')).toEqual([{ kind: 'report' }]);
    });

    it('update: an add failure aborts before the row write; a row error aborts before removal; a removal error throws', async () => {
        fake.queue('intel_reports', { data: { id: 'r1', intel_report_limiting_markers: null } });
        fake.queue('intel_report_limiting_markers', { error: { message: 'x' } });
        await expect(updateIntelReport('r1', { markerIds: [5] })).rejects.toThrow('Failed to attach limiting markers to intel report');
        expect(fake.find('intel_reports', 'update')).toHaveLength(0);

        fake.queue('intel_reports', { data: { id: 'r1', intel_report_limiting_markers: [{ marker_id: 1 }] } }, { error: { message: 'x' } });
        await expect(updateIntelReport('r1', {})).rejects.toThrow('Failed to update intel report');
        expect(fake.find('intel_report_limiting_markers', 'delete')).toHaveLength(0);

        fake.queue('intel_reports', { data: { id: 'r1', intel_report_limiting_markers: [{ marker_id: 1 }] } }, { error: null });
        fake.queue('intel_report_limiting_markers', { error: { message: 'x' } });
        await expect(updateIntelReport('r1', {})).rejects.toThrow('Failed to update limiting markers for intel report');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('per-target reads escape LIKE metacharacters and cap the result', async () => {
        fake.queue('intel_reports', { data: [reportRow()] });
        const out = await getIntelReportsForTarget('50%_off');
        expect(out[0].targetId).toBe('Target');
        const q = fake.find('intel_reports')[0];
        expect(hasCall(q, 'ilike', 'target_id', '50\\%\\_off')).toBe(true);
        expect(hasCall(q, 'limit', 500)).toBe(true);
        fake.queue('intel_reports', { data: null, error: { message: 'x' } });
        expect(await getIntelReportsForTarget('x')).toEqual([]);
    });
});

// =============================================================================
describe('getDossier', () => {
    interface DossierArm {
        user?: unknown; latest?: unknown; members?: unknown; primary?: unknown; reports?: unknown[]; orgReports?: Record<string, unknown[]>;
        ops?: unknown[]; viewerParts?: unknown[]; warrants?: unknown[]; requests?: unknown[]; summary?: unknown;
    }
    function arm(a: DossierArm) {
        fake.on('users', { data: a.user ?? null });
        fake.on('intel_reports', (q) => {
            if (q.columns === 'subject_type') return { data: a.latest ?? null };
            if (q.columns?.startsWith('target_id, threat_level, created_at')) return { data: a.members ?? [] };
            if (q.columns?.startsWith('affiliated_org, threat_level, created_at')) return { data: a.primary ?? [] };
            const target = filters(q, 'ilike')[0]?.[1] as string;
            if (a.orgReports && target in a.orgReports) return { data: a.orgReports[target] };
            return { data: a.reports ?? [] };
        });
        fake.on('operations', { data: a.ops ?? [] });
        fake.on('operation_participants', { data: a.viewerParts ?? [] });
        fake.on('warrants', { data: a.warrants ?? [] });
        fake.on('service_requests', { data: a.requests ?? [] });
        fake.on('dossier_summaries', { data: a.summary ?? null });
    }

    it('escapes the target in EVERY lookup and serves a person dossier with warrants, requests and ops', async () => {
        arm({
            user: { id: 77 },
            latest: { subject_type: 'Person' },
            primary: [
                { affiliated_org: 'red_fleet', threat_level: 'High', created_at: '2026-01-02', classification_level: 0, intel_report_limiting_markers: [] },
                { affiliated_org: 'red_fleet', threat_level: 'Low', created_at: '2026-01-01', classification_level: 0 },
                { affiliated_org: 'red_fleet', threat_level: 'Critical', created_at: '2026-01-05', classification_level: 0 },
                { affiliated_org: null, threat_level: 'Low', created_at: '2026-01-01', classification_level: 0 },
                { affiliated_org: 'SECRET_ORG', threat_level: 'High', created_at: '2026-01-01', classification_level: 3 },
            ],
            reports: [reportRow({ id: 'r1', created_at: '2026-01-01T00:00:00Z' })],
            orgReports: { 'RED\\_FLEET': [reportRow({ id: 'r1' }), reportRow({ id: 'o2', target_id: 'RED_FLEET', created_at: '2026-02-01T00:00:00Z' })] },
            ops: [{ id: 'op1', name: 'Op', status: 'Planning', type: 'Combat', description: 'd', created_at: 'c', owner_id: 1, clearance_level: 2, is_special: true, limiting_markers: [{ marker: NF }] }],
            viewerParts: [{ operation_id: 'op1' }],
            warrants: [{ id: 'w1', target_rsi_handle: 'bad_guy', reason: 'r', status: 'Active', created_at: 'c' }],
            requests: [{ id: 'SR-1', client_id: null, unregistered_client_rsi_handle: 'bad_guy', service_type: 'Med', location: 'L', description: 'd', status: 'Submitted', urgency: 'Low', threat_level: 'Low', created_at: 'c', updated_at: 'u' }],
        });
        const out = await getDossier('bad_guy', CLEARED as never);
        for (const q of fake.queries.filter((qq) => ['users', 'warrants', 'service_requests'].includes(qq.table))) {
            expect(filters(q, 'ilike')[0][1]).toBe('bad\\_guy');
        }
        for (const q of fake.find('intel_reports')) {
            for (const [, v] of filters(q, 'ilike')) expect(['bad\\_guy', 'RED\\_FLEET']).toContain(v);
        }
        // Affiliates: only cleared orgs, latest threat per org.
        expect(out.affiliates).toEqual([{ targetId: 'RED_FLEET', threatLevel: 'Critical', lastReportedAt: '2026-01-05' }]);
        // Org reports merged (deduped) newest-first.
        expect(out.reports.map((r) => r.id)).toEqual(['o2', 'r1']);
        expect(out.warrants[0].id).toBe('w1');
        expect(out.requests[0]).toMatchObject({ id: 'SR-1', serviceType: 'Med', statusHistory: [] });
        // Op gate inputs: clearance, markers, special flag and the VIEWER's participation
        // (id only — the READ term, hasOpReadParticipation, ignores time_left).
        expect(m.canUserSeeOpInList).toHaveBeenCalledWith(CLEARED, { ownerId: 1, clearanceLevel: 2, limitingMarkers: [NF], isSpecial: true, participants: [{ userId: 4 }] });
        expect(out.operations).toEqual([{ id: 'op1', name: 'Op', status: 'Planning', type: 'Combat', description: 'd', createdAt: 'c' }]);
        const opsQ = fake.find('operations')[0];
        expect(hasCall(opsQ, 'eq', 'participants.user_id', 77)).toBe(true);
        // The viewer-participation read matches ANY roster row (current OR former): it
        // is scoped to the viewer and carries NO time_left filter, matching every other
        // op READ path. Converted from the old active-only pin (`.is('time_left', null)`).
        const vp = fake.find('operation_participants')[0];
        expect(vp.columns).toBe('operation_id');
        expect(vp.calls.filter(([mm]) => mm !== 'select')).toEqual([['eq', ['user_id', 4]]]);
        expect(filters(vp, 'is')).toEqual([]);
        // Not a summary-bypass viewer → summary query skipped entirely.
        expect(fake.find('dossier_summaries')).toHaveLength(0);
        expect(out.cachedSummary).toBeUndefined();
    });

    it('drops ops the gate rejects, and hides every op from an absent viewer', async () => {
        arm({ user: { id: 77 }, ops: [{ id: 'op1', name: 'x', owner_id: 1, clearance_level: null }] });
        m.canUserSeeOpInList.mockReturnValue(false);
        expect((await getDossier('t', CLEARED as never)).operations).toEqual([]);
        expect(m.canUserSeeOpInList.mock.calls[0][1]).toMatchObject({ clearanceLevel: 0, participants: [] });
        m.canUserSeeOpInList.mockReturnValue(true);
        fake.reset();
        arm({ user: { id: 77 }, ops: [{ id: 'op1', name: 'x', owner_id: 1, clearance_level: 0 }] });
        expect((await getDossier('t', null)).operations).toEqual([]);
        expect(fake.find('operation_participants')).toHaveLength(0);
    });

    it('a target with no local user fetches no ops; an ops:manage viewer skips the participation probe', async () => {
        arm({});
        await getDossier('ghost', CLEARED as never);
        expect(fake.find('operations')).toHaveLength(0);
        expect(fake.find('operation_participants')).toHaveLength(0);
        fake.reset();
        arm({ user: { id: 77 }, ops: [] });
        await getDossier('t', { id: 1, permissions: ['operations:manage', 'intel:view'] } as never);
        expect(fake.find('operations')).toHaveLength(1);
        expect(fake.find('operation_participants')).toHaveLength(0);
    });

    it('serves the cached AI summary only to the intel:manage population', async () => {
        arm({ summary: { summary: 'AI prose', generated_at: 'g' } });
        const out = await getDossier('t', MANAGER as never);
        expect(out).toMatchObject({ cachedSummary: 'AI prose', cachedSummaryDate: 'g' });
        expect(hasCall(fake.find('dossier_summaries')[0], 'eq', 'target_id', 't')).toBe(true);
    });

    it('an organization dossier lists clearance-filtered affiliates and skips person-only surfaces', async () => {
        arm({
            latest: { subject_type: 'Organization' },
            members: [
                { target_id: 'Alice', threat_level: 'High', created_at: '2', classification_level: 0, intel_report_limiting_markers: [] },
                { target_id: 'alice', threat_level: 'Low', created_at: '1', classification_level: 0 },
                { target_id: 'Spy', threat_level: 'Critical', created_at: '3', classification_level: 0, intel_report_limiting_markers: [{ marker: { id: 99 } }] },
            ],
            reports: [reportRow({ id: 'org-r' })],
        });
        const out = await getDossier('Red_Fleet', CLEARED as never);
        expect(out.affiliates).toEqual([{ targetId: 'Alice', threatLevel: 'High', lastReportedAt: '2' }]);
        const mem = fake.find('intel_reports').find((q) => q.columns?.startsWith('target_id, threat_level, created_at'))!;
        expect(hasCall(mem, 'ilike', 'affiliated_org', 'Red\\_Fleet')).toBe(true);
        expect(out).toMatchObject({ warrants: [], requests: [], operations: [] });
        expect(out.reports.map((r) => r.id)).toEqual(['org-r']);
        // Person-only surfaces are never EXECUTED for an org subject.
        expect(fake.find('warrants').filter((q) => q.executed)).toHaveLength(0);
        expect(fake.find('service_requests').filter((q) => q.executed)).toHaveLength(0);
    });

    it('tolerates null member / primary sets', async () => {
        fake.on('users', { data: null });
        fake.on('intel_reports', (q) => (q.columns === 'subject_type' ? { data: { subject_type: 'Organization' } } : { data: null }));
        expect((await getDossier('x', LOW as never)).affiliates).toEqual([]);
        fake.reset();
        fake.on('intel_reports', { data: null });
        expect((await getDossier('x', LOW as never)).reports).toEqual([]);
    });
});

// =============================================================================
describe('listIntelReports', () => {
    const cursorOf = (createdAt: string, id: string) => Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');

    it('warrantsOnly short-circuits with no active warrant targets; otherwise filters by them (lower-cased, deduped)', async () => {
        fake.queue('warrants', { data: [] });
        expect(await listIntelReports({ warrantsOnly: true })).toEqual({ items: [], nextCursor: null, hasMore: false });
        expect(fake.find('intel_reports')).toHaveLength(0);
        expect(hasCall(fake.find('warrants')[0], 'in', 'status', ['Active', 'Standing'])).toBe(true);
        fake.queue('warrants', { data: [{ target_rsi_handle: 'Bad' }, { target_rsi_handle: 'bad' }, { target_rsi_handle: null }] });
        fake.queue('intel_reports', { data: [] });
        await listIntelReports({ warrantsOnly: true });
        expect(hasCall(fake.find('intel_reports')[0], 'in', 'target_id', ['bad'])).toBe(true);
        fake.queue('warrants', { data: null });
        expect((await listIntelReports({ warrantsOnly: true })).items).toEqual([]);
    });

    it('applies filters, the SQL clearance ceiling for non-managers, and clamps the page size', async () => {
        fake.queue('intel_reports', { data: [] });
        await listIntelReports({ limit: 500, threatLevel: 'High' as never, subjectType: 'Person' as never, tag: 'Pirate', viewer: CLEARED });
        const q = fake.find('intel_reports')[0];
        expect(hasCall(q, 'eq', 'threat_level', 'High')).toBe(true);
        expect(hasCall(q, 'eq', 'subject_type', 'Person')).toBe(true);
        expect(hasCall(q, 'contains', 'tags', ['Pirate'])).toBe(true);
        expect(hasCall(q, 'lte', 'classification_level', 2)).toBe(true);
        expect(hasCall(q, 'limit', 101)).toBe(true);
        fake.queue('intel_reports', { data: [] });
        await listIntelReports({ limit: 0, viewer: MANAGER });
        const q2 = fake.find('intel_reports')[1];
        expect(filters(q2, 'lte')).toHaveLength(0);
        expect(hasCall(q2, 'limit', 2)).toBe(true);
        fake.queue('intel_reports', { data: [] });
        await listIntelReports({ viewer: { permissions: [] } });
        expect(hasCall(fake.find('intel_reports')[2], 'lte', 'classification_level', 0)).toBe(true);
    });

    it('sanitises search into a safe disjunction, and returns empty when nothing survives', async () => {
        expect(await listIntelReports({ q: '%%%' })).toEqual({ items: [], nextCursor: null, hasMore: false });
        fake.queue('intel_reports', { data: [] });
        await listIntelReports({ q: 'Bad}},target_id.eq.x' });
        expect(hasCall(fake.find('intel_reports')[1], 'or', 'target_id.ilike.%Badtarget_ideqx%,summary.ilike.%Badtarget_ideqx%,tags.cs.{Badtarget_ideqx}')).toBe(true);
    });

    it('page accounting comes from the VISIBLE set while the cursor advances on the last FETCHED row', async () => {
        const rows = [
            reportRow({ id: UUID.replace(/.$/, '1'), created_at: '2026-10-03T00:00:00Z' }),
            reportRow({ id: UUID.replace(/.$/, '2'), created_at: '2026-10-02T00:00:00Z', intel_report_limiting_markers: [{ marker: { id: 99 } }] }),
            reportRow({ id: UUID.replace(/.$/, '3'), created_at: '2026-10-01T00:00:00Z' }),
        ];
        fake.queue('intel_reports', { data: rows });
        const out = await listIntelReports({ limit: 2, viewer: CLEARED });
        expect(out.items.map((i) => i.id)).toEqual([rows[0].id, rows[2].id]);
        expect(out.hasMore).toBe(true);
        expect(Buffer.from(out.nextCursor!, 'base64url').toString()).toBe(`2026-10-02T00:00:00Z|${rows[1].id}`);
        fake.queue('intel_reports', { data: rows.slice(0, 1) });
        expect(await listIntelReports({ limit: 2, viewer: MANAGER })).toMatchObject({ hasMore: false, nextCursor: null });
        fake.queue('intel_reports', { data: null, error: { message: 'x' } });
        expect((await listIntelReports({})).items).toEqual([]);
    });

    it('keyset cursor: strict predicate without search; inclusive lte + boundary discard with search', async () => {
        const c = cursorOf('2026-10-02T00:00:00Z', UUID);
        fake.queue('intel_reports', { data: [] });
        await listIntelReports({ cursor: c });
        expect(hasCall(fake.find('intel_reports')[0], 'or', `created_at.lt.2026-10-02T00:00:00Z,and(created_at.eq.2026-10-02T00:00:00Z,id.lt.${UUID})`)).toBe(true);
        const lower = UUID.replace('0b8a', '0a00');
        fake.queue('intel_reports', { data: [
            reportRow({ id: UUID, created_at: '2026-10-02T00:00:00Z' }),            // boundary → dropped
            reportRow({ id: lower, created_at: '2026-10-02T00:00:00Z' }),            // same ts, lower id → kept
            reportRow({ id: 'zzz', created_at: '2026-10-03T00:00:00Z' }),            // newer → dropped
            reportRow({ id: 'old', created_at: '2026-10-01T00:00:00Z' }),            // older → kept
        ] });
        const out = await listIntelReports({ cursor: c, q: 'pirate', viewer: MANAGER });
        const q = fake.find('intel_reports')[1];
        expect(hasCall(q, 'lte', 'created_at', '2026-10-02T00:00:00Z')).toBe(true);
        expect(hasCall(q, 'limit', 56)).toBe(true);
        expect(out.items.map((i) => i.id)).toEqual([lower, 'old']);
    });

    it('rejects a cursor with a non-uuid id or a non-ISO timestamp, and ignores an undecodable one', async () => {
        await expect(listIntelReports({ cursor: cursorOf('2026-10-02T00:00:00Z', 'x),id.gt.0') })).rejects.toThrow();
        await expect(listIntelReports({ cursor: cursorOf('Oct 2 2026', UUID) })).rejects.toThrow('Invalid cursor timestamp');
        for (const bad of [cursorOf('nodelim', ''), Buffer.from('noseparator').toString('base64url'), cursorOf('', UUID), cursorOf('not a date', UUID)]) {
            fake.queue('intel_reports', { data: [] });
            await expect(listIntelReports({ cursor: bad })).resolves.toMatchObject({ items: [] });
        }
        const q = fake.find('intel_reports').at(-1)!;
        expect(filters(q, 'or')).toHaveLength(0);
    });
});

// =============================================================================
describe('stats + target index (clearance-filtered aggregates)', () => {
    it('hub stats: managers get exact count pushdowns', async () => {
        fake.queue('intel_reports', { count: 10 }, { count: 4 }, { count: null });
        expect(await getIntelHubStats(MANAGER)).toEqual({ totalReports: 10, criticalCount: 4, recentCount7d: 0 });
        const [, crit, recent] = fake.find('intel_reports');
        expect(hasCall(crit, 'in', 'threat_level', ['Critical', 'High'])).toBe(true);
        expect(filters(recent, 'gte')[0][0]).toBe('created_at');
        expect(fake.find('intel_reports').every(isCount)).toBe(true);
    });

    it('hub stats: everyone else counts only rows they could read (level in SQL, markers per row)', async () => {
        const recent = new Date().toISOString();
        fake.queue('intel_reports', { data: [
            { threat_level: 'Critical', classification_level: 0, created_at: recent, intel_report_limiting_markers: [] },
            { threat_level: 'High', classification_level: 1, created_at: '2020-01-01', intel_report_limiting_markers: [{ marker: NF }] },
            { threat_level: 'Low', classification_level: null, created_at: recent },
            { threat_level: 'High', classification_level: 0, created_at: recent, intel_report_limiting_markers: [{ marker: { id: 99 } }] },
        ] });
        expect(await getIntelHubStats(CLEARED)).toEqual({ totalReports: 3, criticalCount: 2, recentCount7d: 2 });
        const q = fake.find('intel_reports')[0];
        expect(hasCall(q, 'lte', 'classification_level', 2)).toBe(true);
        expect(hasCall(q, 'limit', 20000)).toBe(true);
        fake.queue('intel_reports', { data: null });
        expect(await getIntelHubStats(undefined)).toEqual({ totalReports: 0, criticalCount: 0, recentCount7d: 0 });
        expect(hasCall(fake.find('intel_reports')[1], 'lte', 'classification_level', 0)).toBe(true);
    });

    it('target index: highest threat per case-insensitive target, None/blank skipped, markers enforced', async () => {
        fake.queue('intel_reports', { data: [
            { target_id: 'Bad', threat_level: 'Low', classification_level: 0 },
            { target_id: 'bad', threat_level: 'Critical', classification_level: 0, intel_report_limiting_markers: [] },
            { target_id: 'BAD', threat_level: 'Medium', classification_level: 0 },
            { target_id: '  ', threat_level: 'High' },
            { target_id: 'Calm', threat_level: 'None' },
            { target_id: 'Calm2', threat_level: null },
            { target_id: 'Spy', threat_level: 'High', classification_level: 0, intel_report_limiting_markers: [{ marker: { id: 99 } }] },
            { target_id: 'Odd', threat_level: 'Weird', classification_level: 0 },
            { target_id: 'Odd', threat_level: 'Low', classification_level: 0 },
        ] });
        const out = await getIntelTargetIndex(CLEARED);
        expect(out).toEqual([{ targetId: 'bad', threatLevel: 'Critical' }, { targetId: 'Odd', threatLevel: 'Low' }]);
        expect(hasCall(fake.find('intel_reports')[0], 'lte', 'classification_level', 2)).toBe(true);
    });

    it('target index: managers see all without a ceiling; the result is capped at 5000', async () => {
        fake.queue('intel_reports', { data: Array.from({ length: 5002 }, (_, i) => ({ target_id: `t${i}`, threat_level: 'Low', intel_report_limiting_markers: [{ marker: { id: 99 } }] })) });
        const out = await getIntelTargetIndex(MANAGER);
        expect(out).toHaveLength(5000);
        expect(filters(fake.find('intel_reports')[0], 'lte')).toHaveLength(0);
        fake.queue('intel_reports', { data: null });
        expect(await getIntelTargetIndex(null)).toEqual([]);
    });

    it('getIntelStats: manager breakdown via pushdown + sample; warrants only with warrant:view', async () => {
        fake.queue('intel_reports', { count: 3 }, { data: [{ threat_level: 'High' }, { threat_level: 'High' }, { threat_level: 'Low' }] });
        fake.queue('warrants', { count: 2 });
        expect(await getIntelStats({ ...MANAGER, permissions: ['intel:manage', 'warrant:view'] })).toEqual({ totalReports: 3, activeWarrants: 2, threatBreakdown: { High: 2, Low: 1 } });
        expect(hasCall(fake.find('warrants')[0], 'eq', 'status', 'Active')).toBe(true);
        expect(hasCall(fake.find('intel_reports')[1], 'limit', 5000)).toBe(true);
        fake.queue('intel_reports', { count: null }, { data: null });
        expect(await getIntelStats(MANAGER)).toEqual({ totalReports: 0, activeWarrants: 0, threatBreakdown: {} });
        expect(fake.find('warrants')).toHaveLength(1);
    });

    it('getIntelStats: non-managers get a marker-filtered total + breakdown', async () => {
        fake.queue('intel_reports', { data: [
            { threat_level: 'High', classification_level: 0 },
            { threat_level: 'High', classification_level: 2, intel_report_limiting_markers: [{ marker: NF }] },
            { threat_level: null, classification_level: 0 },
            { threat_level: 'Critical', classification_level: 0, intel_report_limiting_markers: [{ marker: { id: 99 } }] },
        ] });
        fake.queue('warrants', { count: null });
        expect(await getIntelStats(CLEARED)).toEqual({ totalReports: 3, activeWarrants: 0, threatBreakdown: { High: 2 } });
        fake.queue('intel_reports', { data: null });
        expect(await getIntelStats(null)).toEqual({ totalReports: 0, activeWarrants: 0, threatBreakdown: {} });
    });
});

// =============================================================================
describe('affiliation, bulk ops, delete, search', () => {
    it('affiliation update escapes the target pattern and clamps the org', async () => {
        await updateIntelAffiliation('%', '<b>Red</b> Fleet');
        const u = fake.find('intel_reports', 'update')[0];
        expect(u.payload).toEqual({ affiliated_org: 'Red Fleet' });
        expect(hasCall(u, 'ilike', 'target_id', '\\%')).toBe(true);
        await updateIntelAffiliation('x', '');
        expect(fake.find('intel_reports', 'update')[1].payload).toEqual({ affiliated_org: null });
        expect(emitsOf('intel_update')).toEqual([{ kind: 'report' }, { kind: 'report' }]);
        fake.queue('intel_reports', { error: { message: 'x' } });
        await expect(updateIntelAffiliation('x', 'y')).rejects.toThrow('Failed to update affiliation');
    });

    it('bulk ops reject non-arrays and oversized batches before writing', async () => {
        await expect(bulkUpdateIntelAffiliation('x' as never, 'o')).rejects.toThrow('reportIds must be an array');
        await expect(bulkDeleteIntelReports(Array.from({ length: 1001 }, (_, i) => String(i)))).rejects.toThrow('Too many reports in bulk operation (1001; max 1000).');
        await expect(bulkAddIntelTags(['a'], 'x' as never)).rejects.toThrow('tags must be an array');
        await expect(bulkAddIntelTags(['a'], Array.from({ length: 51 }, () => 't'))).rejects.toThrow('Too many tags');
        expect(fake.queries).toHaveLength(0);
    });

    it('bulk affiliation / delete scope by id list and emit', async () => {
        await bulkUpdateIntelAffiliation(['a', 'b'], '<i>Org</i>');
        const u = fake.find('intel_reports', 'update')[0];
        expect(u.payload).toEqual({ affiliated_org: 'Org' });
        expect(hasCall(u, 'in', 'id', ['a', 'b'])).toBe(true);
        await bulkDeleteIntelReports(['c']);
        expect(hasCall(fake.find('intel_reports', 'delete')[0], 'in', 'id', ['c'])).toBe(true);
        await deleteIntelReport('d');
        expect(hasCall(fake.find('intel_reports', 'delete')[1], 'eq', 'id', 'd')).toBe(true);
        expect(emitsOf('intel_update')).toHaveLength(3);
        fake.queue('intel_reports', { error: { message: 'x' } });
        await expect(bulkUpdateIntelAffiliation(['a'], 'o')).rejects.toThrow('Bulk update failed');
    });

    it('bulk tags: sanitised + deduped, merged per row, no-op for empty input', async () => {
        await bulkAddIntelTags([], ['a']);
        await bulkAddIntelTags(['a'], ['<b></b>', '']);
        expect(fake.queries).toHaveLength(0);
        fake.queue('intel_reports', { data: [{ id: 'a', tags: ['x', 'Pirate'] }, { id: 'b', tags: null }] });
        await bulkAddIntelTags(['a', 'b', 'missing'], ['<b>Pirate</b>', 'Pirate', 'T'.repeat(60)]);
        expect(fake.find('intel_reports', 'select')[0].columns).toBe('id, tags');
        const ups = fake.find('intel_reports', 'update');
        expect(ups.map((q) => q.payload)).toEqual([{ tags: ['x', 'Pirate', 'T'.repeat(40)] }, { tags: ['Pirate', 'T'.repeat(40)] }]);
        expect(emitsOf('intel_update')).toEqual([{ kind: 'report' }]);
        fake.queue('intel_reports', { data: null });
        await bulkAddIntelTags(['a'], ['t']);
        expect(fake.find('intel_reports', 'update')).toHaveLength(2);
    });

    it('search strips filter-syntax characters, optionally scopes by subject, and caps at 50', async () => {
        expect(await searchIntelReports('{}%,.()')).toEqual([]);
        expect(await searchIntelReports(42 as unknown as string)).toEqual([]);
        expect(fake.queries).toHaveLength(0);
        fake.queue('intel_reports', { data: [reportRow()] });
        const out = await searchIntelReports('pi.rate}},x', 'Person');
        expect(out[0].id).toBe('r1');
        const q = fake.find('intel_reports')[0];
        expect(hasCall(q, 'or', 'target_id.ilike.%piratex%,summary.ilike.%piratex%,tags.cs.{piratex}')).toBe(true);
        expect(hasCall(q, 'eq', 'subject_type', 'Person')).toBe(true);
        expect(hasCall(q, 'limit', 50)).toBe(true);
        fake.queue('intel_reports', { data: null });
        expect(await searchIntelReports('x')).toEqual([]);
    });

    it('recent reports: page clamped to 1..100, optional subject filter, [] on error', async () => {
        fake.queue('intel_reports', { data: [reportRow()] }, { data: [] }, { data: null, error: { message: 'x' } });
        expect((await getRecentIntelReports('Organization', 500))[0].id).toBe('r1');
        expect(hasCall(fake.find('intel_reports')[0], 'limit', 100)).toBe(true);
        expect(hasCall(fake.find('intel_reports')[0], 'eq', 'subject_type', 'Organization')).toBe(true);
        await getRecentIntelReports(undefined, -3);
        expect(hasCall(fake.find('intel_reports')[1], 'limit', 1)).toBe(true);
        expect(filters(fake.find('intel_reports')[1], 'eq')).toHaveLength(0);
        expect(await getRecentIntelReports()).toEqual([]);
    });
});

// =============================================================================
describe('maintenance jobs', () => {
    it('syncWarrantsToReports files one report per active warrant target lacking any report', async () => {
        fake.queue('warrants', { data: [{ id: 'w1', target_rsi_handle: 'Bad', reason: 'r1' }, { id: 'w2', target_rsi_handle: 'Known', reason: 'r2' }] });
        fake.on('intel_reports', (q) => (q.op === 'select' ? { data: [{ target_id: 'KNOWN' }] } : { data: { id: 'new' } }));
        expect(await syncWarrantsToReports(1)).toBe(1);
        expect(hasCall(fake.find('intel_reports', 'select')[0], 'in', 'target_id', ['bad', 'known'])).toBe(true);
        expect(fake.find('intel_reports', 'insert')[0].payload).toMatchObject({ target_id: 'Bad', tags: ['Caution Note', 'Auto-Sync'], created_by_id: 1 });
        fake.reset();
        fake.queue('warrants', { data: [] });
        expect(await syncWarrantsToReports(1)).toBe(0);
        fake.queue('warrants', { data: [{ id: 'w1', target_rsi_handle: 'X', reason: 'r' }] });
        fake.queue('intel_reports', { data: null }, { data: { id: 'n' } });
        expect(await syncWarrantsToReports(1)).toBe(1);
    });

    it('deduplicateWarrants keeps the newest per handle and deletes the rest', async () => {
        fake.queue('warrants', { data: null });
        expect(await deduplicateWarrants()).toBe(0);
        fake.queue('warrants', { data: [{ id: 'new', target_rsi_handle: 'Bad' }, { id: 'old', target_rsi_handle: 'bad' }, { id: 'solo', target_rsi_handle: 'X' }] });
        expect(await deduplicateWarrants()).toBe(1);
        expect(hasCall(fake.find('warrants', 'delete')[0], 'in', 'id', ['old'])).toBe(true);
        expect(hasCall(fake.find('warrants', 'select')[1], 'order', 'created_at', { ascending: false })).toBe(true);
        fake.queue('warrants', { data: [{ id: 'a', target_rsi_handle: 'A' }] });
        expect(await deduplicateWarrants()).toBe(0);
        expect(fake.find('warrants', 'delete')).toHaveLength(1);
    });

    it('deduplicateIntelReports prefers locally-authored rows and chunks deletes', async () => {
        fake.queue('intel_reports', { data: null });
        expect(await deduplicateIntelReports()).toBe(0);
        fake.queue('intel_reports', { data: [
            { id: 'feed1', target_id: 'T', summary: 'Same  text', created_by_id: null },
            { id: 'mine', target_id: 't', summary: 'same text', created_by_id: 5 },     // replaces feed1
            { id: 'feed2', target_id: 'T', summary: 'same text', created_by_id: null },  // dup of authored → delete
            { id: 'mine2', target_id: 'T', summary: 'same text', created_by_id: 6 },     // both authored → delete later
            { id: 'other', target_id: 'U', summary: 'x', created_by_id: null },
        ] });
        expect(await deduplicateIntelReports()).toBe(3);
        expect(hasCall(fake.find('intel_reports', 'delete')[0], 'in', 'id', ['feed1', 'feed2', 'mine2'])).toBe(true);
        fake.queue('intel_reports', { data: Array.from({ length: 502 }, (_, i) => ({ id: `d${i}`, target_id: 'T', summary: 's', created_by_id: null })) });
        expect(await deduplicateIntelReports()).toBe(501);
        expect(fake.find('intel_reports', 'delete').slice(1).map((q) => (filters(q, 'in')[0][1] as string[]).length)).toEqual([500, 1]);
    });

    it('saveDossierSummary upserts by target and emits ONLY the dossier discriminator (never the subject)', async () => {
        await saveDossierSummary('Secret_Subject', 'prose');
        const up = fake.find('dossier_summaries', 'upsert')[0];
        expect(up.payload).toMatchObject({ target_id: 'Secret_Subject', summary: 'prose' });
        expect(up.writeOptions).toEqual({ onConflict: 'target_id' });
        expect(emitsOf('intel_update')).toEqual([{ kind: 'dossier' }]);
        expect(JSON.stringify(broadcastSpy.mock.calls)).not.toContain('Secret_Subject');
        fake.queue('dossier_summaries', { error: { message: 'x' } });
        await expect(saveDossierSummary('t', 's')).rejects.toThrow('Failed to save dossier summary');
    });
});

// =============================================================================
describe('bulletins', () => {
    it('restriction probe fails CLOSED on any fault, missing row or unreadable count', async () => {
        fake.queue('intel_bulletins', { data: null, error: { message: 'x' } }, { data: null }, { data: { classification_level: 2 } }, { data: { classification_level: 0 } }, { data: { classification_level: null } }, { data: { classification_level: 0 } }, { data: { classification_level: 0 } });
        fake.queue('intel_bulletin_limiting_markers', { count: null, error: { message: 'x' } }, { count: null }, { count: 1 }, { count: 0 });
        expect(await bulletinIsRestricted('b')).toBe(true);
        expect(await bulletinIsRestricted('b')).toBe(true);
        expect(await bulletinIsRestricted('b')).toBe(true);
        expect(await bulletinIsRestricted('b')).toBe(true);
        expect(await bulletinIsRestricted('b')).toBe(true);
        expect(await bulletinIsRestricted('b')).toBe(true);
        expect(await bulletinIsRestricted('b')).toBe(false);
        const probe = fake.find('intel_bulletin_limiting_markers')[0];
        expect(probe.columns).toBe('bulletin_id');
        expect(probe.selectOptions).toEqual({ count: 'exact', head: true });
    });

    it('create: clearance + marker validation before insert, sanitised row, id-only emit (no threat level)', async () => {
        await expect(createIntelBulletin({ user: LOW, classificationLevel: 1 })).rejects.toThrow('above your own clearance');
        fake.queue('security_limiting_markers', { data: null, error: { message: 'x' } });
        await expect(createIntelBulletin({ user: MANAGER, markerIds: [7] })).rejects.toThrow('Failed to verify limiting markers for intel bulletin');
        fake.queue('security_limiting_markers', { data: [] });
        await expect(createIntelBulletin({ user: MANAGER, markerIds: [7] })).rejects.toThrow('not valid for this organization');
        expect(fake.find('intel_bulletins')).toHaveLength(0);

        fake.queue('security_limiting_markers', { data: [{ id: 7 }] });
        fake.queue('intel_bulletins', { data: { id: 'b1', title: 'T', body: 'B', threat_level: 'Critical', created_by_id: 4, duration_minutes: 30, expires_at: 'e', created_at: 'c' } });
        const before = Date.now();
        const out = await createIntelBulletin({ user: CLEARED, markerIds: [7], classificationLevel: 2, title: '<b>T</b>', body: '<script>x</script>B', threatLevel: 'Critical', location: '', durationMinutes: 30, createdById: 4, sharedWithAllies: true });
        const ins = fake.find('intel_bulletins', 'insert')[0];
        const p = ins.payload as Record<string, unknown>;
        expect(p).toMatchObject({ title: 'T', threat_level: 'Critical', location: null, duration_minutes: 30, classification_level: 2, created_by_id: 4, shared_with_allies: true });
        expect(p.body).not.toContain('<script>');
        expect(new Date(p.expires_at as string).getTime() - before).toBeGreaterThanOrEqual(30 * 60_000 - 100);
        expect(columnsOf(ins)).toContain('source_organization_name');
        expect(fake.find('intel_bulletin_limiting_markers', 'insert')[0].payload).toEqual([{ bulletin_id: 'b1', marker_id: 7 }]);
        expect(emitsOf('bulletin_update')).toEqual([{ type: 'new_bulletin', bulletinId: 'b1', createdById: 4 }]);
        expect(out).toMatchObject({ id: 'b1', threatLevel: 'Critical' });
    });

    it('create: indefinite duration, defaults, insert failures and marker rollback', async () => {
        fake.queue('intel_bulletins', { data: { id: 'b2', created_by_id: 1 } });
        await createIntelBulletin({ durationMinutes: 0, title: 't', body: 'b' });
        expect(fake.find('intel_bulletins', 'insert')[0].payload).toMatchObject({ expires_at: '9999-12-31T23:59:59.000Z', threat_level: 'Medium', shared_with_allies: false, classification_level: 0 });
        fake.queue('intel_bulletins', { data: { id: 'b3' } });
        await createIntelBulletin({ title: 't', body: 'b' });
        expect(fake.find('intel_bulletins', 'insert')[1].payload).toMatchObject({ duration_minutes: 60 });

        fake.queue('intel_bulletins', { data: null, error: { message: 'x' } });
        await expect(createIntelBulletin({ title: 't' })).rejects.toThrow('Failed to create intel bulletin');
        fake.queue('intel_bulletins', { data: null });
        await expect(createIntelBulletin({ title: 't' })).rejects.toThrow('Failed to create intel bulletin');

        broadcastSpy.mockClear();
        fake.queue('security_limiting_markers', { data: [{ id: 7 }] }, { data: [{ id: 7 }] });
        fake.queue('intel_bulletins', { data: { id: 'b4' } }, { error: null }, { data: { id: 'b5' } }, { error: { message: 'x' } });
        fake.queue('intel_bulletin_limiting_markers', { error: { message: 'fk' } }, { error: { message: 'fk' } });
        await expect(createIntelBulletin({ user: MANAGER, markerIds: [7] })).rejects.toThrow('Failed to attach limiting markers to intel bulletin');
        expect(hasCall(fake.find('intel_bulletins', 'delete')[0], 'eq', 'id', 'b4')).toBe(true);
        await expect(createIntelBulletin({ user: MANAGER, markerIds: [7] })).rejects.toThrow('Failed to attach limiting markers to intel bulletin');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('active list: unexpired only, newest first, [] on error', async () => {
        fake.queue('intel_bulletins', { data: [{ id: 'b1', title: 't', intel_bulletin_limiting_markers: [{ marker: NF }] }] }, { data: null, error: { message: 'x' } });
        const [b] = await getActiveBulletins();
        expect(b.limitingMarkers).toEqual([NF]);
        const q = fake.find('intel_bulletins')[0];
        expect(filters(q, 'gt')[0][0]).toBe('expires_at');
        expect(hasCall(q, 'order', 'created_at', { ascending: false })).toBe(true);
        expect(await getActiveBulletins()).toEqual([]);
    });

    it('slice: clearance-filtered for the viewer, null when gone, throws on error', async () => {
        const row = { id: 'b1', title: 't', classification_level: 0, intel_bulletin_limiting_markers: [{ marker: NF }] };
        fake.queue('intel_bulletins', { data: row }, { data: row }, { data: null }, { data: null, error: { message: 'x' } });
        expect(await getBulletinByIdForViewer('b1', LOW)).toBeNull();
        expect((await getBulletinByIdForViewer('b1', CLEARED))!.id).toBe('b1');
        expect(await getBulletinByIdForViewer('b1', MANAGER)).toBeNull();
        await expect(getBulletinByIdForViewer('b1', MANAGER)).rejects.toThrow('Failed to get bulletin slice');
        expect(hasCall(fake.find('intel_bulletins')[0], 'eq', 'id', 'b1')).toBe(true);
    });

    it('delete: existence check, scoped delete, id-only emit', async () => {
        fake.queue('intel_bulletins', { data: null });
        await expect(deleteIntelBulletin('b1')).rejects.toThrow('Bulletin not found');
        fake.queue('intel_bulletins', { data: { id: 'b1' } }, { error: null });
        await deleteIntelBulletin('b1');
        expect(hasCall(fake.find('intel_bulletins', 'delete')[0], 'eq', 'id', 'b1')).toBe(true);
        expect(emitsOf('bulletin_update')).toEqual([{ type: 'bulletin_deleted', bulletinId: 'b1' }]);
        fake.queue('intel_bulletins', { data: { id: 'b1' } }, { error: { message: 'x' } });
        await expect(deleteIntelBulletin('b1')).rejects.toThrow('Failed to delete intel bulletin');
    });

    it('cleanup deletes expired, non-indefinite bulletins and only logs a failure', async () => {
        await cleanupExpiredBulletins();
        const d = fake.find('intel_bulletins', 'delete')[0];
        expect(filters(d, 'lt')[0][0]).toBe('expires_at');
        expect(hasCall(d, 'neq', 'duration_minutes', 0)).toBe(true);
        fake.queue('intel_bulletins', { error: { message: 'x' } });
        await expect(cleanupExpiredBulletins()).resolves.toBeUndefined();
    });
});
