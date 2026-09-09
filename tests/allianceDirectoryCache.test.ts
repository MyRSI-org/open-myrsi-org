import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Ally directory cache tests (lib/db/alliances.ts, the slow-lane directory fetch):
//   - sanitize-at-WRITE: a hostile peer cannot park javascript:/data: avatar
//     URLs in our DB (stored-XSS class)
//   - cache-or-live-fetch: fresh cache served without a wire call; stale +
//     reachable refreshes; 403 (not shared) CLEARS the cache (fail closed);
//     transient miss degrades to the stale copy
//   - budget gating on the member-triggered live path
//   - mapPeerRow allow-list: health fields ride to the admin UI, the cache
//     blobs and key material NEVER do

const h = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    mutations: [] as Array<{ table: string; op: string; matched: number; values: Record<string, unknown> | null }>,
    emits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = {
            op: 'select' as string,
            values: null as Record<string, unknown> | null,
            filters: {} as Record<string, unknown>,
            notIns: {} as Record<string, unknown[]>,
            returning: false,
        };
        // .not(col, 'in', '(a,b)') is a membership test, not an equality filter —
        // folding it into `filters` would reject every row and make the peer/feed
        // scope assertions below pass vacuously.
        const rows = () => (h.tables[table] ?? []).filter((r) =>
            Object.entries(state.filters).every(([c, v]) => r[c] === v)
            && Object.entries(state.notIns).every(([c, vs]) => !vs.includes(r[c])));
        const b: any = {};
        b.select = () => { state.returning = true; return b; };
        b.update = (v: Record<string, unknown>) => { state.op = 'update'; state.values = v; return b; };
        b.upsert = (v: Record<string, unknown>) => { state.op = 'upsert'; state.values = v; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        b.not = (c: string, op: string, literal: string) => {
            if (op === 'in') state.notIns[c] = String(literal).replace(/^\(|\)$/g, '').split(',');
            return b;
        };
        b.in = () => b; b.is = () => b; b.order = () => b; b.limit = () => b; b.neq = () => b; b.ilike = (c: string, v: unknown) => { state.filters[c] = v; return b; };
        const settle = (mode: 'many' | 'single') => {
            if (state.op === 'select') {
                const data = rows();
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            const matched = rows();
            h.mutations.push({ table, op: state.op, matched: matched.length, values: state.values });
            const list = (h.tables[table] = h.tables[table] ?? []);
            if (state.op === 'update') for (const r of matched) Object.assign(r, state.values);
            if (state.op === 'delete') for (const r of matched) list.splice(list.indexOf(r), 1);
            if (state.op === 'upsert') {
                const v = state.values!;
                const existing = list.find(r => r.peer_id === v.peer_id);
                if (existing) Object.assign(existing, v); else list.push({ ...v });
            }
            return Promise.resolve({ data: state.returning ? matched.map((r) => ({ id: r.id })) : null, error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (resolve: any, reject: any) => settle('many').then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.emits.push({ event, payload }); },
        broadcastToChannel: () => {},
        safeFetch: async (q: any) => (await q).data ?? [],
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
    collectShareableIntel: async () => ({ reports: [], warrants: [], bulletins: [], _meta: {} }),
    getMaxShareableClearance: async () => 0,
    FEED_PAIRING_STATES: ['legacy', 'manual'],
    // A factory mock replaces the WHOLE module, and alliances.ts derives its
    // FEED_STATES literal from this at module scope — omit it and the file
    // throws at import time.
}));

import { fetchPeerRoster, sanitizeRosterProjection, listAlliancePeers, revokeAlliancePeer, updateAlliancePeer } from '../lib/db/alliances';
import { isSecurityDenial } from '../lib/errors';
import { __resetAllianceSyncStateForTests, tryConsumeToken, ALLIANCE_SYNC_DEFAULTS } from '../lib/db/allianceSyncState';
import type { AllyRosterData } from '../types';

const HOSTILE_ROSTER: AllyRosterData = {
    memberCount: 2,
    fetchedAt: '2026-06-05T10:00:00.000Z',
    members: [
        { id: 1, rsiHandle: 'a', name: 'A', avatarUrl: 'javascript:alert(1)', rankName: null, rankIcon: null, unitName: null, roleName: null, isDuty: false, specializations: [] },
        { id: 2, rsiHandle: 'b', name: 'B', avatarUrl: 'https://cdn.example/avatar.png', rankName: null, rankIcon: null, unitName: null, roleName: null, isDuty: false, specializations: [] },
    ],
};

function peerRow(over: Record<string, unknown> = {}) {
    return {
        id: 'p1', label: 'Ally', base_url: 'https://peer.example',
        peer_org_name: 'Ally Org', peer_org_tag: 'ALLY', peer_icon_url: null, peer_blurb: null,
        status: 'Active', type: 'Alliance', inbound_max_clearance: 0, outbound_max_clearance: 0,
        channels: {}, pairing_state: 'active',
        outbound_key_enc: 'ak_key_material_secret', inbound_key_id: 'k1',
        entered_peer_code_enc: 'enc_code_secret', entered_peer_code_expires: null,
        last_contact_at: null, created_at: '2026-06-01T00:00:00.000Z',
        sync_health: 'degraded', sync_failures: 2, sync_last_ok_at: '2026-06-05T09:00:00.000Z',
        sync_next_attempt_at: null, sync_alert: 'Intel sync skipped 2 item(s)',
        intel_synced_at: '2026-06-05T08:00:00.000Z', ops_synced_at: '2026-06-05T08:00:00.000Z',
        ...over,
    };
}

function stubFetch(responder: () => { status: number; json?: unknown } | 'fail') {
    vi.stubGlobal('fetch', async () => {
        const r = responder();
        if (r === 'fail') throw new TypeError('fetch failed');
        return { ok: r.status < 400, status: r.status, json: async () => r.json ?? {}, text: async () => '' };
    });
}

beforeEach(() => {
    h.tables = { alliance_peers: [peerRow()], alliance_peer_directory_cache: [], api_keys: [] };
    h.mutations = [];
    h.emits = [];
    __resetAllianceSyncStateForTests();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('sanitizeRosterProjection (stored-XSS guard, sanitize-at-write)', () => {
    it('neutralizes hostile avatar URLs (→ null) and keeps safe ones', () => {
        const out = sanitizeRosterProjection(HOSTILE_ROSTER);
        expect(out.members[0].avatarUrl ?? null).toBeNull();
        expect(out.members[1].avatarUrl).toBe('https://cdn.example/avatar.png');
    });
});

describe('fetchPeerRoster cache behavior', () => {
    it('serves a FRESH cache without any wire call', async () => {
        h.tables.alliance_peer_directory_cache = [{
            peer_id: 'p1', roster: { memberCount: 1, members: [], fetchedAt: 'x' }, fleet: null,
            synced_at: new Date().toISOString(),
        }];
        let called = false;
        stubFetch(() => { called = true; return { status: 200, json: {} }; });
        const out = await fetchPeerRoster('p1');
        expect(out?.memberCount).toBe(1);
        expect(called).toBe(false);
    });
    it('a stale cache triggers a live fetch; the cache write is SANITIZED', async () => {
        h.tables.alliance_peer_directory_cache = [{
            peer_id: 'p1', roster: { memberCount: 0, members: [], fetchedAt: 'old' }, fleet: null,
            synced_at: new Date(Date.now() - (ALLIANCE_SYNC_DEFAULTS.directoryHours + 1) * 3_600_000).toISOString(),
        }];
        stubFetch(() => ({ status: 200, json: HOSTILE_ROSTER }));
        const out = await fetchPeerRoster('p1');
        expect(out?.memberCount).toBe(2);
        const cached = h.tables.alliance_peer_directory_cache[0].roster as AllyRosterData;
        expect(JSON.stringify(cached)).not.toContain('javascript:');
        expect(cached.members[1].avatarUrl).toBe('https://cdn.example/avatar.png');
    });
    it('403 (peer stopped sharing) CLEARS the cached roster — fail closed', async () => {
        h.tables.alliance_peer_directory_cache = [{
            peer_id: 'p1', roster: { memberCount: 5, members: [], fetchedAt: 'old' }, fleet: null,
            synced_at: new Date(Date.now() - (ALLIANCE_SYNC_DEFAULTS.directoryHours + 1) * 3_600_000).toISOString(),
        }];
        stubFetch(() => ({ status: 403 }));
        const out = await fetchPeerRoster('p1');
        expect(out).toBeNull();
        expect(h.tables.alliance_peer_directory_cache[0].roster).toBeNull();
    });
    it('a transient failure degrades to the STALE cache instead of nothing', async () => {
        const stale = { memberCount: 3, members: [], fetchedAt: 'old' };
        h.tables.alliance_peer_directory_cache = [{
            peer_id: 'p1', roster: stale, fleet: null,
            synced_at: new Date(Date.now() - (ALLIANCE_SYNC_DEFAULTS.directoryHours + 1) * 3_600_000).toISOString(),
        }];
        stubFetch(() => 'fail');
        const out = await fetchPeerRoster('p1');
        expect(out?.memberCount).toBe(3);
        // And the stale cache is NOT overwritten by the failure.
        expect((h.tables.alliance_peer_directory_cache[0].roster as AllyRosterData).memberCount).toBe(3);
    });
    it('budget-starved live fetches fall back to the stale cache (no wire call)', async () => {
        h.tables.alliance_peer_directory_cache = [{
            peer_id: 'p1', roster: { memberCount: 4, members: [], fetchedAt: 'old' }, fleet: null,
            synced_at: new Date(Date.now() - (ALLIANCE_SYNC_DEFAULTS.directoryHours + 1) * 3_600_000).toISOString(),
        }];
        for (let i = 0; i < ALLIANCE_SYNC_DEFAULTS.outboundBudgetPerMin + 1; i++) tryConsumeToken('p1');
        let called = false;
        stubFetch(() => { called = true; return { status: 200, json: HOSTILE_ROSTER }; });
        const out = await fetchPeerRoster('p1');
        expect(out?.memberCount).toBe(4);
        expect(called).toBe(false);
    });
});

describe('mapPeerRow allow-list (browser-bound peer shape)', () => {
    it('exposes the live-sync health fields and NEVER key material or cache blobs', async () => {
        const [peer] = await listAlliancePeers();
        expect(peer.syncHealth).toBe('degraded');
        expect(peer.syncFailures).toBe(2);
        expect(peer.syncLastOkAt).toBe('2026-06-05T09:00:00.000Z');
        expect(peer.syncAlert).toMatch(/skipped 2/);
        const blob = JSON.stringify(peer);
        // Secrets stay server-side (existing posture, re-pinned with new fields).
        expect(blob).not.toContain('ak_key_material_secret');
        expect(blob).not.toContain('enc_code_secret');
        // The directory cache never rides the peer row to the browser.
        const keys = Object.keys(peer as unknown as Record<string, unknown>).map(k => k.toLowerCase());
        expect(keys.some(k => k.includes('roster') || k.includes('fleet') || k.includes('cache'))).toBe(false);
        // Internal cursor bookkeeping doesn't ride either.
        expect((peer as unknown as Record<string, unknown>).intelSyncedAt).toBeUndefined();
        expect((peer as unknown as Record<string, unknown>).opsSyncedAt).toBeUndefined();
    });
});

// Teardown direction — the MIRROR of tests/allianceTeardownGuards.test.ts.
// Feeds and handshake peers share one table, so BOTH id-addressed APIs have to
// be scoped: revokeAlliancePeer on a feed row would destroy the stored partner
// key and flip pairing_state to 'revoked', stranding the row — invisible to the
// feed API and a phantom Dissolved ally in the peer list. This also pins the
// soft-teardown contract the feed guard redirects callers to, so a later
// refactor cannot turn revoke into a hard delete and re-open the hole from the
// other side (a hard delete cascades mirrored ops, allied op participants and
// the directory cache, and nulls intel provenance).

const PEER_ID = '77777777-7777-4777-8777-777777777777';
const FEED_ID = '88888888-8888-4888-8888-888888888888';

describe('alliance teardown is soft — the row is the record', () => {
    beforeEach(() => {
        h.tables.alliance_peers = [
            peerRow({ id: PEER_ID, inbound_key_id: 'k1' }),
            peerRow({ id: FEED_ID, pairing_state: 'manual', inbound_key_id: null, outbound_key_enc: 'feed_partner_key' }),
        ];
        h.tables.api_keys = [{ id: 'k1', label: `alliance:${PEER_ID}` }];
    });

    it('keeps the peer row, destroys both directions of key material and REVOKES the inbound key', async () => {
        await revokeAlliancePeer(PEER_ID);
        const row = h.tables.alliance_peers.find(r => r.id === PEER_ID);
        expect(row).toBeDefined();
        expect(row!.status).toBe('Dissolved');
        expect(row!.pairing_state).toBe('revoked');
        expect(row!.outbound_key_enc).toBeNull();
        expect(row!.inbound_key_id).toBeNull();
        expect(row!.entered_peer_code_enc).toBeNull();
        expect(typeof row!.revoked_at).toBe('string');
        // The inbound credential is SOFT-revoked, not deleted. This describe block is titled
        // "alliance teardown is soft — the row is the record", and the key that authenticated
        // the relationship is part of that record: hard-deleting it left an operator unable to
        // answer when the ally's key was issued or last used. It is dead either way, because
        // verifyApiKey refuses a revoked row.
        const key = h.tables.api_keys.find(k => k.id === 'k1');
        expect(key).toBeDefined();
        expect(key!.revoked_at).toBeTruthy();
        expect(key!.revoked_reason).toBe('alliance_revoked');
    });

    it('broadcasts one id-only alliance_update (rule 4: ids, never content)', async () => {
        await revokeAlliancePeer(PEER_ID);
        const emits = h.emits.filter(e => e.event === 'alliance_update');
        expect(emits).toHaveLength(1);
        expect(emits[0].payload).toEqual({ id: PEER_ID });
    });

    it('REFUSES to revoke a receive-only feed row, leaving its partner key intact', async () => {
        await expect(revokeAlliancePeer(FEED_ID)).rejects.toSatisfy(isSecurityDenial);
        const row = h.tables.alliance_peers.find(r => r.id === FEED_ID);
        expect(row!.pairing_state).toBe('manual');
        expect(row!.outbound_key_enc).toBe('feed_partner_key');
        // The api_keys leg must not run either — it fires before the update.
        expect(h.mutations.filter(m => m.table === 'api_keys')).toHaveLength(0);
        expect(h.emits).toHaveLength(0);
    });

    it('REFUSES to retune a receive-only feed row through the peer API', async () => {
        await expect(updateAlliancePeer(FEED_ID, { inboundMaxClearance: 5 })).rejects.toSatisfy(isSecurityDenial);
        const row = h.tables.alliance_peers.find(r => r.id === FEED_ID);
        expect(row!.inbound_max_clearance).toBe(0);
        expect(h.mutations.filter(m => m.table === 'alliance_peers' && m.op === 'update').every(m => m.matched === 0)).toBe(true);
        expect(h.emits).toHaveLength(0);
    });

    it('rejects a malformed peer id before any query runs', async () => {
        await expect(revokeAlliancePeer('p1')).rejects.toThrow(/Invalid peerId/);
        await expect(updateAlliancePeer('', { label: 'x' })).rejects.toThrow(/Invalid peerId/);
        expect(h.mutations).toHaveLength(0);
        expect(h.emits).toHaveLength(0);
    });
});
