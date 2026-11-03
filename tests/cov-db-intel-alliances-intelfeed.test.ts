import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fake, broadcastSpy, filters, hasCall, assertNoWildcardSelects, type FakeQuery } from './cov-db-intel-alliances-fake';

// =============================================================================
// lib/db/intel.ts syncTrustedFeeds — the federation ingest boundary. Covers:
// feed discovery + per-peer key isolation, URL/cursor construction, the
// self-hosted DB shortcut (never for allies), SSRF + transport/HTTP failure
// handling with health accounting, response size/type caps, and per-item
// hygiene: clearance ceilings, sanitise-then-dedup, local-authorship relink
// guard, compartment FAIL-CLOSED marker resolution with rollback, warrant/
// bulletin normalisation + timestamp clamps, cursor advance, id-only nudges,
// poison-item alerts and the operator-facing result summary.
// =============================================================================

const m = vi.hoisted(() => ({
    verifyApiKey: vi.fn(),
    getPublicFeedData: vi.fn(),
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
vi.mock('../lib/db/ops.js', () => ({ canUserSeeOpInList: vi.fn() }));
vi.mock('../lib/ssrf.js', () => ({ ssrfSafeFetch: m.ssrfSafeFetch }));
vi.mock('../lib/crypto.js', () => ({
    decryptSecret: (s: string) => { if (!s.startsWith('enc:')) throw new Error('undecryptable'); return s.slice(4); },
}));
vi.mock('../lib/db/allianceSyncState.js', () => ({
    getCachedAllianceSyncConfig: m.getCachedAllianceSyncConfig,
    recordPeerFailure: m.recordPeerFailure,
    recordPeerSuccess: m.recordPeerSuccess,
    setSyncAlert: m.setSyncAlert,
}));

import { syncTrustedFeeds } from '../lib/db/intel';

const FEED_COLS = 'id, label, base_url, outbound_key_enc, last_contact_at, intel_synced_at, inbound_max_clearance, pairing_state, channels';
const ALL_CH = { reports: true, warrants: true, bulletins: true };

const peer = (over: Record<string, unknown> = {}) => ({
    id: 'p1', label: 'Ally', base_url: 'https://ally.myrsi-bravo.net/', outbound_key_enc: 'enc:KEY', last_contact_at: null,
    intel_synced_at: null, inbound_max_clearance: 2, pairing_state: 'active', channels: ALL_CH, ...over,
});

function httpRes(status: number, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }, statusText = '') {
    return {
        ok: status >= 200 && status < 300, status, statusText,
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        text: async () => body,
    } as unknown as Response;
}
const json = (data: unknown) => httpRes(200, JSON.stringify(data));

interface Db {
    externalReports?: string[];                 // external_id values already imported
    internal?: Array<Record<string, unknown>>;  // content-match candidates
    markers?: Array<{ id: number; code: string }>;
    reportInsertFails?: (p: Record<string, unknown>) => boolean;
    reportMarkerFails?: boolean;
    reportRollbackFails?: boolean;
    externalWarrants?: string[];
    contentWarrants?: string[];                 // cleaned handles already present
    warrantInsertFails?: (p: Record<string, unknown>) => boolean;
    titles?: string[];
    bulletinInsertFails?: (p: Record<string, unknown>) => boolean;
    bulletinMarkerFails?: boolean;
    bulletinRollbackFails?: boolean;
    throwOn?: (q: FakeQuery) => boolean;
}
function db(peers: unknown[] | null, d: Db = {}, feedError?: unknown) {
    let nextId = 1;
    const guard = (q: FakeQuery) => { if (d.throwOn?.(q)) throw new Error('boom'); };
    fake.on('alliance_peers', (q) => (q.op === 'select' ? { data: peers, error: feedError ?? null } : { error: null }));
    fake.on('intel_reports', (q) => {
        guard(q);
        if (q.op === 'select' && q.columns === 'id') {
            const ext = filters(q, 'eq').find((a) => a[0] === 'external_id')?.[1];
            return { data: (d.externalReports ?? []).includes(ext as string) ? { id: 'dup' } : null };
        }
        if (q.op === 'select') return { data: d.internal ?? [] };
        if (q.op === 'insert') return d.reportInsertFails?.(q.payload as Record<string, unknown>) ? { data: null, error: { message: 'ins' } } : { data: { id: `r${nextId++}` } };
        if (q.op === 'delete') return d.reportRollbackFails ? { error: { message: 'rb' } } : { error: null };
        return { error: null };
    });
    fake.on('security_limiting_markers', { data: d.markers ?? [] });
    fake.on('intel_report_limiting_markers', d.reportMarkerFails ? { error: { message: 'fk' } } : { error: null });
    fake.on('warrants', (q) => {
        guard(q);
        if (q.op === 'select' && filters(q, 'ilike').length === 0) {
            const ext = filters(q, 'eq').find((a) => a[0] === 'external_id')?.[1];
            return { data: (d.externalWarrants ?? []).includes(ext as string) ? { id: 'dupw' } : null };
        }
        if (q.op === 'select') {
            const h = filters(q, 'ilike')[0][1] as string;
            return { data: (d.contentWarrants ?? []).includes(h) ? { id: 'dupc' } : null };
        }
        if (q.op === 'insert') return d.warrantInsertFails?.(q.payload as Record<string, unknown>) ? { data: null, error: { message: 'ins' } } : { data: { id: `w${nextId++}` } };
        return { error: null };
    });
    fake.on('intel_bulletins', (q) => {
        guard(q);
        if (q.op === 'select') {
            const t = filters(q, 'eq').find((a) => a[0] === 'title')?.[1];
            return { data: (d.titles ?? []).includes(t as string) ? { id: 'dupb' } : null };
        }
        if (q.op === 'insert') return d.bulletinInsertFails?.(q.payload as Record<string, unknown>) ? { data: null, error: { message: 'ins' } } : { data: { id: `b${nextId++}` } };
        if (q.op === 'delete') return d.bulletinRollbackFails ? { error: { message: 'rb' } } : { error: null };
        return { error: null };
    });
    fake.on('intel_bulletin_limiting_markers', d.bulletinMarkerFails ? { error: { message: 'fk' } } : { error: null });
}

const fetchedUrl = (i = 0) => m.ssrfSafeFetch.mock.calls[i][0] as string;
const results = (r: Awaited<ReturnType<typeof syncTrustedFeeds>>, status?: string) => r.feedResults.filter((x) => !status || x.status === status).map((x) => x.message);
const emitsOf = (event: string) => broadcastSpy.mock.calls.filter((c) => (c as unknown[])[0] === event).map((c) => (c as unknown[])[1]);

beforeEach(() => {
    fake.reset();
    broadcastSpy.mockClear();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('ALLIANCE_DEV_ALLOW_LOOPBACK', '');
    m.getCachedAllianceSyncConfig.mockReturnValue({ cursorOverlapMinutes: 10 });
    m.recordPeerFailure.mockResolvedValue(undefined);
    m.recordPeerSuccess.mockResolvedValue(undefined);
    m.setSyncAlert.mockResolvedValue(undefined);
});
afterEach(() => {
    assertNoWildcardSelects(fake);
    vi.unstubAllEnvs();
});

// =============================================================================
describe('feed discovery', () => {
    it('reads feed rows with explicit columns, optionally scoped to the requested peers', async () => {
        db([]);
        const r = await syncTrustedFeeds(false, ['p1']);
        const q = fake.find('alliance_peers')[0];
        expect(q.columns).toBe(FEED_COLS);
        expect(hasCall(q, 'in', 'pairing_state', ['legacy', 'manual', 'active'])).toBe(true);
        expect(hasCall(q, 'in', 'id', ['p1'])).toBe(true);
        expect(r.feedResults).toEqual([{ label: 'System', status: 'warning', message: 'Peer is not an intel feed source.' }]);
        fake.reset();
        db(null);
        // An empty id list does not narrow the read (only pairing_state is filtered).
        await syncTrustedFeeds(false, []);
        expect(filters(fake.find('alliance_peers')[0], 'in')).toHaveLength(1);
        const r2 = await syncTrustedFeeds();
        expect(results(r2)[0]).toContain('No trusted feeds configured');
    });

    it('reports a feed-list query failure as a System error', async () => {
        db(null, {}, { message: 'relation missing' });
        const r = await syncTrustedFeeds();
        expect(r).toEqual({ totalReports: 0, totalWarrants: 0, totalBulletins: 0, skippedItems: 0, feedResults: [{ label: 'System', status: 'error', message: 'Failed to query feed list: relation missing' }] });
    });

    it('an undecryptable key fails only that peer (sent empty), the others still sync', async () => {
        db([peer({ id: 'bad', label: 'Bad', outbound_key_enc: 'rotated' }), peer({ id: 'good', label: 'Good', outbound_key_enc: null })]);
        m.ssrfSafeFetch.mockResolvedValue(json({ reports: [] }));
        await syncTrustedFeeds();
        expect(m.ssrfSafeFetch.mock.calls.map((c) => c[1].headers['x-api-key'])).toEqual(['', '']);
        expect(fake.find('alliance_peers', 'update')).toHaveLength(2);
    });
});

// =============================================================================
describe('URL + cursor construction', () => {
    it('alliance peers pull /api/alliance/data with an overlap-adjusted peer-clock cursor', async () => {
        db([peer({ intel_synced_at: '2026-10-01T12:00:00.000Z', last_contact_at: '2020-01-01T00:00:00Z' })]);
        m.ssrfSafeFetch.mockResolvedValue(json({}));
        await syncTrustedFeeds();
        expect(fetchedUrl()).toBe(`https://ally.myrsi-bravo.net/api/alliance/data?since=${encodeURIComponent('2026-10-01T11:50:00.000Z')}`);
        const [, init] = m.ssrfSafeFetch.mock.calls[0];
        expect(init).toMatchObject({ method: 'GET', headers: { 'x-api-key': 'KEY' } });
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('legacy feeds pull /api/intel/feed, falling back to last_contact_at; force and bad cursors pull everything', async () => {
        db([peer({ pairing_state: 'legacy', base_url: 'https://feed.myrsi-bravo.net', last_contact_at: '2026-10-01T00:10:00.000Z' })]);
        m.ssrfSafeFetch.mockResolvedValue(json({}));
        await syncTrustedFeeds();
        expect(fetchedUrl()).toBe(`https://feed.myrsi-bravo.net/api/intel/feed?since=${encodeURIComponent('2026-10-01T00:00:00.000Z')}`);
        await syncTrustedFeeds(true);
        expect(fetchedUrl(1)).toBe('https://feed.myrsi-bravo.net/api/intel/feed');
        fake.reset();
        db([peer({ pairing_state: 'manual', base_url: 'https://feed.myrsi-bravo.net/api/intel/feed', last_contact_at: 'garbage' })]);
        await syncTrustedFeeds();
        expect(fetchedUrl(2)).toBe('https://feed.myrsi-bravo.net/api/intel/feed');
    });

    it('a direct /api/query?target=feed URL is kept and the cursor appended with &', async () => {
        db([peer({ pairing_state: 'manual', base_url: 'https://feed.myrsi-bravo.net/api/query?target=feed', intel_synced_at: '2026-10-01T00:10:00.000Z' })]);
        m.ssrfSafeFetch.mockResolvedValue(json({}));
        await syncTrustedFeeds();
        expect(fetchedUrl()).toBe(`https://feed.myrsi-bravo.net/api/query?target=feed&since=${encodeURIComponent('2026-10-01T00:00:00.000Z')}`);
    });

    it('an alliance URL already ending in /api/alliance/data is not doubled', async () => {
        db([peer({ base_url: 'https://ally.myrsi-bravo.net/api/alliance/data' })]);
        m.ssrfSafeFetch.mockResolvedValue(json({}));
        await syncTrustedFeeds();
        expect(fetchedUrl()).toBe('https://ally.myrsi-bravo.net/api/alliance/data');
    });
});

// =============================================================================
describe('self-hosted shortcut', () => {
    it('a loopback legacy feed resolves via a verified direct DB read (no HTTP)', async () => {
        db([peer({ pairing_state: 'legacy', base_url: 'http://localhost:3000', channels: ALL_CH })]);
        m.verifyApiKey.mockResolvedValue({ id: 'k' });
        m.getPublicFeedData.mockResolvedValue({ reports: [{ id: 'x1', target_id: 'T', summary: 'S' }], warrants: [], bulletins: [], _meta: { fetchedAt: '2026-10-02T00:00:00Z' } });
        const r = await syncTrustedFeeds(true);
        expect(m.ssrfSafeFetch).not.toHaveBeenCalled();
        expect(m.verifyApiKey).toHaveBeenCalledWith('KEY');
        expect(m.getPublicFeedData).toHaveBeenCalledWith(undefined);
        expect(r.totalReports).toBe(1);
        expect(results(r, 'info')).toContain('Local platform feed detected — resolving via direct DB query');
        expect(fake.find('alliance_peers', 'update')[0].payload).toMatchObject({ intel_synced_at: '2026-10-02T00:00:00Z' });
    });

    it('uses APP_URL host matching, but NEVER for an alliance peer', async () => {
        vi.stubEnv('APP_URL', 'https://ally.myrsi-bravo.net');
        db([peer({ pairing_state: 'active' })]);
        m.ssrfSafeFetch.mockResolvedValue(json({}));
        await syncTrustedFeeds();
        expect(m.ssrfSafeFetch).toHaveBeenCalled();
        expect(m.verifyApiKey).not.toHaveBeenCalled();
    });

    it('fails the feed on a revoked key or a direct-query exception', async () => {
        db([peer({ pairing_state: 'legacy', base_url: 'http://127.0.0.1:3000' })]);
        m.verifyApiKey.mockResolvedValueOnce(null);
        let r = await syncTrustedFeeds();
        expect(results(r, 'error')).toEqual(['API key verification failed. The key may have been revoked or is invalid.']);
        m.verifyApiKey.mockResolvedValueOnce({ id: 'k' });
        m.getPublicFeedData.mockRejectedValueOnce(new Error('db down'));
        r = await syncTrustedFeeds();
        expect(results(r, 'error')).toEqual(['Direct DB query failed: db down']);
        m.verifyApiKey.mockRejectedValueOnce('weird');
        r = await syncTrustedFeeds();
        expect(results(r, 'error')).toEqual(['Direct DB query failed: Unknown error']);
        expect(fake.find('alliance_peers', 'update')).toHaveLength(0);
    });
});

// =============================================================================
describe('transport + response guards', () => {
    it('rejects non-public feed URLs before fetching (dev loopback hatch only for allies)', async () => {
        db([peer({ pairing_state: 'manual', base_url: 'http://192.168.1.5' })]);
        const r = await syncTrustedFeeds();
        expect(results(r, 'error')[0]).toContain('Feed URL rejected');
        expect(m.ssrfSafeFetch).not.toHaveBeenCalled();
        vi.stubEnv('ALLIANCE_DEV_ALLOW_LOOPBACK', '1');
        fake.reset();
        db([peer({ pairing_state: 'active', base_url: 'http://10.0.0.2:3001' })]);
        m.ssrfSafeFetch.mockResolvedValue(json({}));
        const r2 = await syncTrustedFeeds();
        expect(fetchedUrl()).toBe('http://10.0.0.2:3001/api/alliance/data');
        expect(results(r2, 'error')).toEqual([]);
    });

    it('a transport failure reports timeout vs network error and feeds health (failure swallowed); cursor untouched', async () => {
        db([peer()]);
        const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
        m.ssrfSafeFetch.mockRejectedValueOnce(abort).mockRejectedValueOnce(new Error('ECONNRESET')).mockRejectedValueOnce('str');
        m.recordPeerFailure.mockRejectedValueOnce(new Error('x'));
        expect(results(await syncTrustedFeeds(), 'error')).toEqual(['Connection timed out after 15s']);
        expect(results(await syncTrustedFeeds(), 'error')).toEqual(['Network error: ECONNRESET']);
        expect(results(await syncTrustedFeeds(), 'error')).toEqual(['Network error: str']);
        expect(m.recordPeerFailure).toHaveBeenCalledTimes(3);
        expect(fake.find('alliance_peers', 'update')).toHaveLength(0);
    });

    it('HTTP errors: 5xx backs off, 4xx does not; body excerpt included when readable', async () => {
        db([peer()]);
        m.ssrfSafeFetch.mockResolvedValueOnce(httpRes(503, 'x'.repeat(300), {}, 'Unavailable'));
        expect(results(await syncTrustedFeeds(), 'error')).toEqual([`HTTP 503 Unavailable — ${'x'.repeat(200)}`]);
        expect(m.recordPeerFailure).toHaveBeenCalledTimes(1);
        const unreadable = { ...httpRes(403, '', {}, 'Forbidden'), text: async () => { throw new Error('gone'); } } as unknown as Response;
        m.ssrfSafeFetch.mockResolvedValueOnce(unreadable);
        m.recordPeerFailure.mockRejectedValueOnce(new Error('x'));
        expect(results(await syncTrustedFeeds(), 'error')).toEqual(['HTTP 403 Forbidden']);
        expect(m.recordPeerFailure).toHaveBeenCalledTimes(1);
        m.ssrfSafeFetch.mockResolvedValueOnce(httpRes(500, '', {}, 'ISE'));
        m.recordPeerFailure.mockRejectedValueOnce(new Error('x'));
        expect(results(await syncTrustedFeeds(), 'error')).toEqual(['HTTP 500 ISE']);
    });

    it('refuses oversized bodies (declared or actual) and non-JSON responses', async () => {
        db([peer()]);
        const big = 8 * 1024 * 1024 + 1;
        m.ssrfSafeFetch.mockResolvedValueOnce(httpRes(200, '{}', { 'content-type': 'application/json', 'content-length': String(big) }));
        expect(results(await syncTrustedFeeds(), 'error')[0]).toContain('Feed response too large');
        m.ssrfSafeFetch.mockResolvedValueOnce(httpRes(200, 'x'.repeat(big), { 'content-type': 'application/json' }));
        expect(results(await syncTrustedFeeds(), 'error')[0]).toContain('Feed response too large');
        m.ssrfSafeFetch.mockResolvedValueOnce(httpRes(200, 'x'.repeat(big), { 'content-type': 'text/plain' }));
        expect(results(await syncTrustedFeeds(), 'error')[0]).toContain('Feed response too large');
        m.ssrfSafeFetch.mockResolvedValueOnce(httpRes(200, '  <html>', { 'content-type': 'text/plain' }));
        expect(results(await syncTrustedFeeds(), 'error')[0]).toContain('Received HTML instead of JSON');
        m.ssrfSafeFetch.mockResolvedValueOnce(httpRes(200, 'body', { 'content-type': 'text/html' }));
        expect(results(await syncTrustedFeeds(), 'error')[0]).toContain('Received HTML instead of JSON');
        m.ssrfSafeFetch.mockResolvedValueOnce(httpRes(200, 'plain words', {}));
        expect(results(await syncTrustedFeeds(), 'error')[0]).toBe('Unexpected response type (). Preview: plain words');
        m.ssrfSafeFetch.mockResolvedValueOnce(httpRes(200, '{not json', { 'content-type': 'application/json' }));
        expect(results(await syncTrustedFeeds(), 'error')[0]).toBe('Failed to parse JSON response (Content-Type: application/json). The remote server may be misconfigured.');
        expect(fake.find('alliance_peers', 'update')).toHaveLength(0);
    });

    it('an unexpected throw inside a feed is reported against that feed only', async () => {
        db([peer({ id: 'p0', label: 'Broken', base_url: null }), peer({ id: 'p1', label: 'Fine' })]);
        m.ssrfSafeFetch.mockResolvedValue(json({}));
        const r = await syncTrustedFeeds();
        expect(r.feedResults.find((x) => x.label === 'Broken')!.message).toMatch(/^Unexpected error: /);
        expect(fake.find('alliance_peers', 'update')).toHaveLength(1);
    });
});

// =============================================================================
describe('report ingest', () => {
    it('inserts sanitised, clamped, ceiling-respecting reports and links legacy feed rows; local-authored rows are never relinked', async () => {
        db([peer({ inbound_max_clearance: null })], {
            externalReports: ['dup-ext'],
            internal: [
                { id: 'legacy', summary: 'Seen  Near  Port', external_id: null, created_by_id: null, source_feed_id: 'p1' },
                { id: 'mine', summary: 'authored here', external_id: null, created_by_id: 9, source_feed_id: null },
            ],
        });
        m.ssrfSafeFetch.mockResolvedValue(json({
            reports: [
                { id: 'n1', target_id: '<b>Bad_Guy</b>', summary: '<script>x</script>Spotted', threat_level: 'Bogus', tags: ['<i>a</i>', 'b'], affiliated_org: '', created_at: '2999-01-01T00:00:00Z', classification_level: 1, subject_type: 'Person' },
                { id: 'dup-ext', target_id: 'T', summary: 'S' },
                { id: 'link', target_id: 'T', summary: 'seen near port' },
                { id: 'auth', target_id: 'T', summary: 'Authored Here' },
                { id: 'hot', target_id: 'T', summary: 'S', classification_level: 9 },
                { id: 'blank', target_id: '<b></b>', summary: 'S' },
                { id: 'nosum', target_id: 'T' },
            ],
        }));
        const before = Date.now();
        const r = await syncTrustedFeeds();
        const ins = fake.find('intel_reports', 'insert');
        expect(ins).toHaveLength(1);
        const p = ins[0].payload as Record<string, unknown>;
        expect(p).toMatchObject({ target_id: 'Bad_Guy', threat_level: 'Medium', tags: ['a', 'b'], affiliated_org: null, source_feed_id: 'p1', external_id: 'n1', external_author: 'Ally', created_by_id: null, classification_level: 1 });
        expect(p.summary).not.toContain('<script>');
        expect(new Date(p.created_at as string).getTime()).toBeLessThanOrEqual(Date.now());
        expect(new Date(p.created_at as string).getTime()).toBeGreaterThanOrEqual(before - 1000);
        // Dedup probes: external id scoped to this feed; content match LIKE-escaped.
        const ext = fake.find('intel_reports', 'select').find((q) => q.columns === 'id')!;
        expect(hasCall(ext, 'eq', 'source_feed_id', 'p1')).toBe(true);
        const content = fake.find('intel_reports', 'select').find((q) => q.columns === 'id, summary, external_id, created_by_id, source_feed_id')!;
        expect(hasCall(content, 'ilike', 'target_id', 'Bad\\_Guy')).toBe(true);
        // Relink only the legacy feed row.
        const up = fake.find('intel_reports', 'update');
        expect(up).toHaveLength(1);
        expect(up[0].payload).toEqual({ external_id: 'link', source_feed_id: 'p1', external_author: 'Ally' });
        expect(hasCall(up[0], 'eq', 'id', 'legacy')).toBe(true);
        expect(r.totalReports).toBe(1);
        expect(results(r).at(-1)).toBe('1 new report(s), 2 duplicate report(s) skipped, 1 existing report(s) linked');
        expect(r.feedResults.at(-1)!.status).toBe('success');
        expect(emitsOf('intel_update')).toEqual([{ kind: 'report' }]);
    });

    it('compartment FAIL-CLOSED: an unknown marker code skips the item; known codes are attached', async () => {
        db([peer()], { markers: [{ id: 7, code: 'NF' }] });
        m.ssrfSafeFetch.mockResolvedValue(json({ reports: [
            { id: 'a', target_id: 'T1', summary: 'S1', limiting_markers: ['NF', 'NF'] },
            { id: 'b', target_id: 'T2', summary: 'S2', limiting_markers: ['NF', 'GHOST'] },
        ] }));
        const r = await syncTrustedFeeds();
        expect(fake.find('intel_reports', 'insert')).toHaveLength(1);
        expect(fake.find('intel_report_limiting_markers', 'insert')[0].payload).toEqual([{ report_id: 'r1', marker_id: 7 }]);
        expect(hasCall(fake.find('security_limiting_markers')[0], 'in', 'code', ['NF', 'NF'])).toBe(true);
        expect(r.skippedItems).toBe(1);
        expect(m.setSyncAlert).toHaveBeenCalledWith('p1', 'Intel sync skipped 1 item(s) — see server logs.');
        expect(r.feedResults.at(-1)).toMatchObject({ status: 'warning', message: '1 new report(s), 1 report(s) failed to import' });
    });

    it('a failed marker attach removes the just-inserted report (and logs a failed rollback)', async () => {
        db([peer()], { markers: [{ id: 7, code: 'NF' }], reportMarkerFails: true });
        m.ssrfSafeFetch.mockResolvedValue(json({ reports: [{ id: 'a', target_id: 'T', summary: 'S', limiting_markers: ['NF'] }] }));
        let r = await syncTrustedFeeds();
        expect(hasCall(fake.find('intel_reports', 'delete')[0], 'eq', 'id', 'r1')).toBe(true);
        expect(r.totalReports).toBe(0);
        expect(r.skippedItems).toBe(1);
        expect(emitsOf('intel_update')).toEqual([]);
        fake.reset();
        db([peer()], { markers: [{ id: 7, code: 'NF' }], reportMarkerFails: true, reportRollbackFails: true });
        r = await syncTrustedFeeds();
        expect(r.skippedItems).toBe(1);
    });

    it('insert errors and thrown items are counted, never fatal; a reports channel that is off is ignored', async () => {
        db([peer()], { reportInsertFails: (p) => p.target_id === 'Fail', throwOn: (q) => q.table === 'intel_reports' && q.op === 'select' && hasCall(q, 'eq', 'external_id', 'boom') });
        m.ssrfSafeFetch.mockResolvedValue(json({ reports: [{ id: 'f', target_id: 'Fail', summary: 'S' }, { id: 'boom', target_id: 'X', summary: 'S' }, { id: 'ok', target_id: 'Ok', summary: 'S' }] }));
        const r = await syncTrustedFeeds();
        expect(r).toMatchObject({ totalReports: 1, skippedItems: 2 });
        fake.reset();
        db([peer({ channels: { reports: false } })]);
        m.ssrfSafeFetch.mockResolvedValue(json({ reports: [{ id: 'ok', target_id: 'Ok', summary: 'S' }] }));
        expect((await syncTrustedFeeds()).totalReports).toBe(0);
        expect(fake.find('intel_reports')).toHaveLength(0);
    });

    it('caps a channel at 1000 items and logs the truncation', async () => {
        db([peer()], { externalReports: Array.from({ length: 1001 }, (_, i) => `x${i}`) });
        m.ssrfSafeFetch.mockResolvedValue(json({ reports: Array.from({ length: 1001 }, (_, i) => ({ id: `x${i}`, target_id: 'T', summary: 'S' })) }));
        const r = await syncTrustedFeeds();
        expect(results(r, 'info')).toContain('Truncated reports 1001→1000 (feed cap)');
        expect(fake.find('intel_reports', 'select')).toHaveLength(1000);
    });
});

// =============================================================================
describe('warrant ingest', () => {
    it('normalises peer warrants (no admin attribution) and dedups by feed id then content', async () => {
        db([peer()], { externalWarrants: ['7'], contentWarrants: ['Known'] });
        m.ssrfSafeFetch.mockResolvedValue(json({ warrants: [
            { id: 1, target_rsi_handle: '<b>Bad</b>', reason: '<i>piracy</i>', action: '<u>Kill</u>', uec_reward: -5, status: 'Pwned', issued_at: '2026-01-01T00:00:00Z' },
            { id: 7, target_rsi_handle: 'Dup', reason: 'r' },
            { target_rsi_handle: 'Known', reason: 'r' },
            { target_rsi_handle: 'Plain', reason: 'r', uec_reward: 50 },
            { target_rsi_handle: '', reason: 'r' },
            { target_rsi_handle: '<b></b>', reason: 'r' },
        ] }));
        const r = await syncTrustedFeeds();
        const ins = fake.find('warrants', 'insert').map((q) => q.payload as Record<string, unknown>);
        expect(ins).toHaveLength(2);
        expect(ins[0]).toMatchObject({ target_rsi_handle: 'Bad', reason: 'piracy', action: 'Kill', uec_reward: null, status: 'Active', created_at: '2026-01-01T00:00:00Z', source_feed_id: 'p1', external_id: '1', issued_by: null });
        expect(ins[1]).toMatchObject({ action: null, uec_reward: 50, external_id: null });
        expect(typeof ins[1].created_at).toBe('string');
        const extProbe = fake.find('warrants', 'select').find((q) => hasCall(q, 'eq', 'external_id', '7'))!;
        expect(hasCall(extProbe, 'eq', 'source_feed_id', 'p1')).toBe(true);
        expect(r.totalWarrants).toBe(2);
        expect(emitsOf('warrant_update')).toEqual([{ warrantIds: ['w1', 'w2'] }]);
        expect(results(r).at(-1)).toBe('2 new warrant(s), 2 duplicate warrant(s) skipped');
    });

    it('insert errors / throws count as skipped; >20 new warrants emit an id-less nudge', async () => {
        db([peer()], { warrantInsertFails: (p) => p.target_rsi_handle === 'Fail', throwOn: (q) => q.table === 'warrants' && hasCall(q, 'ilike', 'target_rsi_handle', 'Boom') });
        m.ssrfSafeFetch.mockResolvedValue(json({ warrants: [{ target_rsi_handle: 'Fail', reason: 'r' }, { target_rsi_handle: 'Boom', reason: 'r' }] }));
        const r = await syncTrustedFeeds();
        expect(r).toMatchObject({ totalWarrants: 0, skippedItems: 2 });
        expect(results(r).at(-1)).toBe('2 warrant(s) failed to import');
        fake.reset(); broadcastSpy.mockClear();
        db([peer()]);
        m.ssrfSafeFetch.mockResolvedValue(json({ warrants: Array.from({ length: 21 }, (_, i) => ({ target_rsi_handle: `t${i}`, reason: 'r' })) }));
        await syncTrustedFeeds();
        expect(emitsOf('warrant_update')).toEqual([{}]);
    });

    it('caps warrants at 1000 and ignores them when the channel is off', async () => {
        db([peer()], { contentWarrants: ['t'] });
        m.ssrfSafeFetch.mockResolvedValue(json({ warrants: Array.from({ length: 1001 }, () => ({ target_rsi_handle: 't', reason: 'r' })) }));
        const r = await syncTrustedFeeds();
        expect(results(r, 'info')).toContain('Truncated warrants 1001→1000 (feed cap)');
        fake.reset();
        db([peer({ channels: { warrants: false } })]);
        m.ssrfSafeFetch.mockResolvedValue(json({ warrants: [{ target_rsi_handle: 'x', reason: 'r' }] }));
        await syncTrustedFeeds();
        expect(fake.find('warrants')).toHaveLength(0);
    });
});

// =============================================================================
describe('bulletin ingest', () => {
    it('inserts clamped, provenance-marked, never-reshared bulletins under the clearance ceiling; title dups skipped', async () => {
        db([peer()], { titles: ['Old'], markers: [{ id: 7, code: 'NF' }] });
        m.ssrfSafeFetch.mockResolvedValue(json({ bulletins: [
            { title: '<b>Alert</b>', body: '<script>x</script>Body', threat_level: 'Nope', location: '', expires_at: '2999-01-01T00:00:00Z', duration_minutes: 999999, classification_level: 1, created_at: '2999-01-01T00:00:00Z', limiting_markers: ['NF'] },
            { title: 'Past', body: 'b', expires_at: '2000-01-01T00:00:00Z', duration_minutes: -5 },
            { title: 'Old', body: 'b' },
            { title: 'Hot', body: 'b', classification_level: 9 },
            { title: '', body: 'b' },
            { title: '<b></b>', body: 'b' },
        ] }));
        const now = Date.now();
        const r = await syncTrustedFeeds();
        const ins = fake.find('intel_bulletins', 'insert').map((q) => q.payload as Record<string, unknown>);
        expect(ins).toHaveLength(2);
        expect(ins[0]).toMatchObject({ title: 'Alert', threat_level: 'Medium', location: null, duration_minutes: 43200, classification_level: 1, source_organization_id: 'p1', source_organization_name: 'Ally', shared_with_allies: false });
        expect(ins[0].body).not.toContain('<script>');
        const exp0 = new Date(ins[0].expires_at as string).getTime();
        expect(exp0).toBeLessThanOrEqual(now + 30 * 24 * 3_600_000 + 5000);
        expect(new Date(ins[0].created_at as string).getTime()).toBeLessThanOrEqual(Date.now());
        expect(ins[1].duration_minutes).toBe(1);
        expect(new Date(ins[1].expires_at as string).getTime()).toBeGreaterThanOrEqual(now - 1000);
        expect(fake.find('intel_bulletin_limiting_markers', 'insert')[0].payload).toEqual([{ bulletin_id: 'b1', marker_id: 7 }]);
        expect(r.totalBulletins).toBe(2);
        expect(emitsOf('bulletin_update')).toEqual([{ bulletinId: 'b1' }, { bulletinId: 'b2' }]);
    });

    it('defaults a missing expiry to 24h and duration to a day', async () => {
        db([peer()]);
        m.ssrfSafeFetch.mockResolvedValue(json({ bulletins: [{ title: 'T', body: 'B' }] }));
        const now = Date.now();
        await syncTrustedFeeds();
        const p = fake.find('intel_bulletins', 'insert')[0].payload as Record<string, unknown>;
        expect(p.duration_minutes).toBe(1440);
        expect(Math.abs(new Date(p.expires_at as string).getTime() - (now + 24 * 3_600_000))).toBeLessThan(5000);
    });

    it('unknown marker codes, insert errors, failed attaches (with rollback) and throws are all skipped + counted', async () => {
        db([peer()], {
            markers: [{ id: 7, code: 'NF' }], bulletinMarkerFails: true,
            bulletinInsertFails: (p) => p.title === 'Fail',
            throwOn: (q) => q.table === 'intel_bulletins' && q.op === 'select' && hasCall(q, 'eq', 'title', 'Boom'),
        });
        m.ssrfSafeFetch.mockResolvedValue(json({ bulletins: [
            { title: 'Ghost', body: 'b', limiting_markers: ['GHOST'] },
            { title: 'Fail', body: 'b' },
            { title: 'Marked', body: 'b', limiting_markers: ['NF'] },
            { title: 'Boom', body: 'b' },
        ] }));
        const r = await syncTrustedFeeds();
        expect(r).toMatchObject({ totalBulletins: 0, skippedItems: 4 });
        expect(hasCall(fake.find('intel_bulletins', 'delete')[0], 'eq', 'id', 'b1')).toBe(true);
        expect(results(r).at(-1)).toBe('4 bulletin(s) failed to import');
        fake.reset();
        db([peer()], { markers: [{ id: 7, code: 'NF' }], bulletinMarkerFails: true, bulletinRollbackFails: true });
        m.ssrfSafeFetch.mockResolvedValue(json({ bulletins: [{ title: 'Marked', body: 'b', limiting_markers: ['NF'] }] }));
        expect((await syncTrustedFeeds()).skippedItems).toBe(1);
    });

    it('>20 new bulletins emit one id-less nudge; caps at 1000; ignored when the channel is off', async () => {
        db([peer()]);
        m.ssrfSafeFetch.mockResolvedValue(json({ bulletins: Array.from({ length: 21 }, (_, i) => ({ title: `t${i}`, body: 'b' })) }));
        await syncTrustedFeeds();
        expect(emitsOf('bulletin_update')).toEqual([{}]);
        fake.reset();
        db([peer()], { titles: ['t'] });
        m.ssrfSafeFetch.mockResolvedValue(json({ bulletins: Array.from({ length: 1001 }, () => ({ title: 't', body: 'b' })) }));
        expect(results(await syncTrustedFeeds(), 'info')).toContain('Truncated bulletins 1001→1000 (feed cap)');
        fake.reset();
        db([peer({ channels: null })]);
        m.ssrfSafeFetch.mockResolvedValue(json({ bulletins: [{ title: 't', body: 'b' }] }));
        await syncTrustedFeeds();
        expect(fake.find('intel_bulletins')).toHaveLength(0);
    });
});

// =============================================================================
describe('cursor advance + result summary', () => {
    it('advances the cursor from the peer clock (meta → top-level → local) and records success (swallowed)', async () => {
        db([peer()]);
        m.ssrfSafeFetch.mockResolvedValueOnce(json({ fetchedAt: 'top', _meta: { fetchedAt: 'meta' } }));
        m.recordPeerSuccess.mockRejectedValueOnce(new Error('x'));
        await syncTrustedFeeds();
        m.ssrfSafeFetch.mockResolvedValueOnce(json({ fetchedAt: 'top' }));
        await syncTrustedFeeds();
        m.ssrfSafeFetch.mockResolvedValueOnce(json({}));
        await syncTrustedFeeds();
        const ups = fake.find('alliance_peers', 'update');
        expect(ups.map((q) => (q.payload as { intel_synced_at: string }).intel_synced_at).slice(0, 2)).toEqual(['meta', 'top']);
        expect(Date.parse((ups[2].payload as { intel_synced_at: string }).intel_synced_at)).not.toBeNaN();
        for (const u of ups) expect(hasCall(u, 'eq', 'id', 'p1')).toBe(true);
        expect(m.recordPeerSuccess).toHaveBeenCalledTimes(3);
    });

    it('reports an empty feed, an all-duplicate feed, a sharing-filter warning, and swallows an alert-write failure', async () => {
        db([peer()], { externalReports: ['d'] });
        m.ssrfSafeFetch.mockResolvedValueOnce(json({ countReports: 0 }));
        let r = await syncTrustedFeeds();
        expect(r.feedResults.at(-1)).toEqual({ label: 'Ally', status: 'info', message: 'Remote feed returned 0 records (check their Outbound Sharing Policy)' });

        m.ssrfSafeFetch.mockResolvedValueOnce(json({ countWarrants: 3, warrants: [], _meta: { totalReportsBeforeFilter: 10, reportsExcludedByClearance: 4, reportsExcludedByMarker: 0, maxShareableLevel: 1 } }));
        r = await syncTrustedFeeds();
        expect(results(r, 'warning')).toEqual(['Source org sharing filter: 10 total reports, 4 excluded by clearance (max level: 1), 0 excluded by marker restriction']);
        expect(r.feedResults.at(-1)).toMatchObject({ status: 'info', message: 'All records already exist locally' });

        m.ssrfSafeFetch.mockResolvedValueOnce(json({ _meta: { totalReportsBeforeFilter: 0, reportsExcludedByClearance: 5 } }));
        r = await syncTrustedFeeds();
        expect(results(r, 'warning')).toEqual([]);
        m.ssrfSafeFetch.mockResolvedValueOnce(json({ _meta: { totalReportsBeforeFilter: 5 } }));
        r = await syncTrustedFeeds();
        expect(results(r, 'warning')).toEqual([]);

        m.setSyncAlert.mockRejectedValueOnce(new Error('x'));
        m.ssrfSafeFetch.mockResolvedValueOnce(json({ reports: [{ id: 'z', target_id: 'T', summary: 'S', limiting_markers: ['GHOST'] }] }));
        r = await syncTrustedFeeds();
        expect(r.skippedItems).toBe(1);
        expect(r.feedResults.at(-1)!.status).toBe('warning');
    });

    it('accumulates totals across feeds', async () => {
        db([peer({ id: 'a', label: 'A' }), peer({ id: 'b', label: 'B' })]);
        m.ssrfSafeFetch.mockImplementation(async (url: string) => json({ reports: [{ id: url, target_id: 'T', summary: url }] }));
        const r = await syncTrustedFeeds();
        expect(r.totalReports).toBe(2);
        expect(r.feedResults.filter((x) => x.status === 'success').map((x) => x.label)).toEqual(['A', 'B']);
    });
});
