import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fake, broadcastSpy, hasCall, assertNoWildcardSelects } from './cov-db-intel-alliances-fake';

// =============================================================================
// lib/db/allianceSync.ts — live-sync engine: due-time gating, the down-peer
// probe, transport-failure short-circuit, alert raise/clear, recovery RSVP
// re-push, every swallowed best-effort side effect (a failing health write must
// never abort the pass), the tick wall-clock budget and force-sync.
// The job modules + health state machine are mocked; a controllable clock
// drives the cadences.
// =============================================================================

const m = vi.hoisted(() => ({
    getAllianceSyncConfig: vi.fn(),
    recordPeerFailure: vi.fn(),
    recordPeerSuccess: vi.fn(),
    setSyncAlert: vi.fn(),
    reconcile: vi.fn(),
    rsvp: vi.fn(),
    intel: vi.fn(),
    directory: vi.fn(),
}));

vi.mock('../lib/db/common.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/db/common.js')>();
    const h = await import('./cov-db-intel-alliances-fake');
    return { ...actual, supabase: h.fake.client, broadcastToOrg: h.broadcastSpy };
});
vi.mock('../lib/db/allianceSyncState.js', () => ({
    getAllianceSyncConfig: m.getAllianceSyncConfig,
    recordPeerFailure: m.recordPeerFailure,
    recordPeerSuccess: m.recordPeerSuccess,
    setSyncAlert: m.setSyncAlert,
}));
vi.mock('../lib/db/operations-federation.js', () => ({ reconcileMirrorsWithPeer: m.reconcile, pushLocalRsvpsForPeer: m.rsvp }));
vi.mock('../lib/db/intel.js', () => ({ syncTrustedFeeds: m.intel }));
vi.mock('../lib/db/alliances.js', () => ({ refreshPeerDirectory: m.directory }));

import { allianceSyncTick, forceSyncPeer, peerPhaseOffsetMs, __resetAllianceSyncEngineForTests } from '../lib/db/allianceSync';

const COLS = 'id, label, status, pairing_state, channels, sync_health, sync_next_attempt_at, sync_alert';
const CFG = { enabled: true, opsPollMinutes: 2, intelPollMinutes: 5, directoryHours: 6 };
const CLEAN_RECONCILE = { ok: true, peerUp: true, pulled: 0, revoked: 0, deferred: 0 };
const CLEAN_INTEL = { skippedItems: 0, feedResults: [] };

let clock = 0;
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);

/** An id whose phase offset is 0 for the ops cadence ⇒ ops due on first sight. */
function idWithZeroOffset(cadenceMs: number): string {
    for (let i = 0; i < 100_000; i++) {
        const id = `peer-${i}`;
        if (peerPhaseOffsetMs(id, cadenceMs) === 0) return id;
    }
    throw new Error('no zero-offset id');
}

const ally = (over: Record<string, unknown> = {}) => ({
    id: 'ally-1', label: 'Ally', status: 'Active', pairing_state: 'active',
    channels: { operations: true }, sync_health: 'healthy', sync_next_attempt_at: null, sync_alert: null, ...over,
});

function arm(peers: unknown[] | null, cache: unknown[] | null = []) {
    fake.on('alliance_peers', (q) => {
        if (q.op === 'select' && q.calls.some(([mm]) => mm === 'maybeSingle')) {
            const id = q.calls.find(([mm, a]) => mm === 'eq' && a[0] === 'id')?.[1][1];
            return { data: (peers ?? []).find((p) => (p as { id: string }).id === id) ?? null };
        }
        if (q.op === 'select') return { data: peers };
        return { error: null };
    });
    fake.on('alliance_peer_directory_cache', { data: cache });
}

beforeEach(() => {
    fake.reset();
    broadcastSpy.mockClear();
    vi.clearAllMocks();
    __resetAllianceSyncEngineForTests();
    clock = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    m.getAllianceSyncConfig.mockResolvedValue(CFG);
    m.recordPeerFailure.mockResolvedValue(undefined);
    m.recordPeerSuccess.mockResolvedValue(undefined);
    m.setSyncAlert.mockResolvedValue(undefined);
    m.reconcile.mockResolvedValue(CLEAN_RECONCILE);
    m.rsvp.mockResolvedValue(undefined);
    m.intel.mockResolvedValue(CLEAN_INTEL);
    m.directory.mockResolvedValue(undefined);
});
afterEach(() => {
    assertNoWildcardSelects(fake);
    vi.restoreAllMocks();
});

describe('allianceSyncTick — gating', () => {
    it('does nothing (not even a read) when the engine is disabled', async () => {
        m.getAllianceSyncConfig.mockResolvedValue({ ...CFG, enabled: false });
        await allianceSyncTick();
        expect(fake.queries).toHaveLength(0);
    });

    it('reads only the sync columns of feed + active peers, and stops when there are none', async () => {
        arm(null);
        await allianceSyncTick();
        expect(fake.queries).toHaveLength(1);
        const q = fake.find('alliance_peers')[0];
        expect(q.columns).toBe(COLS);
        expect(hasCall(q, 'in', 'pairing_state', ['legacy', 'manual', 'active'])).toBe(true);
    });

    it('first sight staggers ops by the peer phase offset; a missing directory cache is due at once', async () => {
        const id = 'ally-staggered';
        expect(peerPhaseOffsetMs(id, 120_000)).toBeGreaterThan(0);
        arm([ally({ id })], null);
        await allianceSyncTick();
        expect(m.reconcile).not.toHaveBeenCalled();
        expect(m.directory).toHaveBeenCalledWith(id);
        expect(m.recordPeerSuccess).toHaveBeenCalledWith(id);
        const cacheQ = fake.find('alliance_peer_directory_cache')[0];
        expect(cacheQ.columns).toBe('peer_id, synced_at');
        expect(hasCall(cacheQ, 'in', 'peer_id', [id])).toBe(true);
        // One full ops cadence later the reconcile is due.
        clock += 120_000;
        await allianceSyncTick();
        expect(m.reconcile).toHaveBeenCalledWith(id);
    });

    it('a fresh directory cache is not refreshed; a stale one is', async () => {
        const id = idWithZeroOffset(120_000);
        arm([ally({ id })], [{ peer_id: id, synced_at: new Date(T0 - 3_600_000).toISOString() }]);
        await allianceSyncTick();
        expect(m.directory).not.toHaveBeenCalled();
        expect(m.reconcile).toHaveBeenCalledWith(id);
        fake.reset();
        arm([ally({ id })], [{ peer_id: id, synced_at: new Date(T0 - 7 * 3_600_000).toISOString() }]);
        clock += 1000;
        await allianceSyncTick();
        expect(m.directory).toHaveBeenCalledWith(id);
    });

    it('feed peers get intel only — no ops/directory, no directory-cache read', async () => {
        arm([{ ...ally({ id: 'feed-1', pairing_state: 'manual', status: 'Active', channels: { reports: true } }) }]);
        clock += 10 * 60_000; // let the first-sight intel offset elapse on the next tick
        await allianceSyncTick();
        clock += 5 * 60_000;
        await allianceSyncTick();
        expect(m.intel).toHaveBeenCalledWith(false, ['feed-1']);
        expect(m.reconcile).not.toHaveBeenCalled();
        expect(m.directory).not.toHaveBeenCalled();
        expect(fake.find('alliance_peer_directory_cache')).toHaveLength(0);
    });

    it('a peer with no due jobs and no channels produces no work', async () => {
        arm([ally({ id: 'feed-x', pairing_state: 'legacy', channels: null })]);
        await allianceSyncTick();
        expect(m.reconcile).not.toHaveBeenCalled();
        expect(m.intel).not.toHaveBeenCalled();
        expect(m.directory).not.toHaveBeenCalled();
    });
});

describe('allianceSyncTick — down peers and recovery', () => {
    it('skips a down peer until its probe time; then the reconcile runs regardless of cadence', async () => {
        const id = 'ally-down';
        arm([ally({ id, sync_health: 'down', sync_next_attempt_at: new Date(T0 + 60_000).toISOString() })], [{ peer_id: id, synced_at: new Date(T0).toISOString() }]);
        await allianceSyncTick();
        expect(m.reconcile).not.toHaveBeenCalled();
        clock += 61_000;
        await allianceSyncTick();
        expect(m.reconcile).toHaveBeenCalledWith(id);
        // Probe succeeded: health recorded, ops_synced_at stamped, RSVPs re-pushed.
        expect(m.recordPeerSuccess).toHaveBeenCalledWith(id);
        const upd = fake.find('alliance_peers', 'update')[0];
        expect(Object.keys(upd.payload as object)).toEqual(['ops_synced_at']);
        expect(hasCall(upd, 'eq', 'id', id)).toBe(true);
        expect(m.rsvp).toHaveBeenCalledWith(id);
    });

    it('probes immediately when the down peer has no / an unparseable next-attempt time', async () => {
        arm([ally({ id: 'd1', sync_health: 'down', sync_next_attempt_at: null }), ally({ id: 'd2', sync_health: 'down', sync_next_attempt_at: 'garbage' })], [
            { peer_id: 'd1', synced_at: new Date(T0).toISOString() }, { peer_id: 'd2', synced_at: new Date(T0).toISOString() },
        ]);
        await allianceSyncTick();
        expect(m.reconcile.mock.calls.map((c) => c[0]).sort()).toEqual(['d1', 'd2']);
    });

    it('a failing RSVP re-push is logged, not thrown', async () => {
        arm([ally({ id: 'd1', sync_health: 'down' })], [{ peer_id: 'd1', synced_at: new Date(T0).toISOString() }]);
        m.rsvp.mockRejectedValue(new Error('peer busy'));
        await expect(allianceSyncTick()).resolves.toBeUndefined();
        expect(m.rsvp).toHaveBeenCalledWith('d1');
    });

    it('no re-push when the recovering peer is still unreachable', async () => {
        arm([ally({ id: 'd1', sync_health: 'down' })], null);
        m.reconcile.mockRejectedValue(new Error('ECONNREFUSED'));
        await allianceSyncTick();
        expect(m.recordPeerFailure).toHaveBeenCalledWith('d1');
        expect(m.directory).not.toHaveBeenCalled(); // short-circuited
        expect(m.rsvp).not.toHaveBeenCalled();
    });
});

describe('allianceSyncTick — per-job outcomes', () => {
    const id = idWithZeroOffset(120_000);
    const freshCache = () => [{ peer_id: id, synced_at: new Date(T0).toISOString() }];

    it('a reconcile that is down-but-answering (peerUp=false) records no success and stamps nothing', async () => {
        arm([ally({ id })], freshCache());
        m.reconcile.mockResolvedValue({ ...CLEAN_RECONCILE, peerUp: false });
        await allianceSyncTick();
        expect(m.recordPeerSuccess).not.toHaveBeenCalled();
        expect(fake.find('alliance_peers', 'update')).toHaveLength(0);
    });

    it('raises the reconcile alert (and does not clear it) when the pass reports one', async () => {
        arm([ally({ id, sync_alert: 'old' })], freshCache());
        m.reconcile.mockResolvedValue({ ok: false, peerUp: true, pulled: 2, revoked: 1, deferred: 0, alert: 'Mirror cap reached.' });
        await allianceSyncTick();
        expect(m.setSyncAlert).toHaveBeenCalledTimes(1);
        expect(m.setSyncAlert).toHaveBeenCalledWith(id, 'Mirror cap reached.');
    });

    it('a swallowed alert-write failure never aborts the tick', async () => {
        arm([ally({ id })], freshCache());
        m.reconcile.mockResolvedValue({ ...CLEAN_RECONCILE, alert: 'x' });
        m.setSyncAlert.mockRejectedValue(new Error('db down'));
        await expect(allianceSyncTick()).resolves.toBeUndefined();
    });

    it('clears a stale alert only after a fully clean pass', async () => {
        arm([ally({ id, sync_alert: 'stale' })], freshCache());
        m.setSyncAlert.mockRejectedValue(new Error('db down')); // and its failure is swallowed
        await allianceSyncTick();
        expect(m.setSyncAlert).toHaveBeenCalledWith(id, null);
    });

    it('a not-ok reconcile without an alert leaves the stale alert standing', async () => {
        arm([ally({ id, sync_alert: 'stale' })], freshCache());
        m.reconcile.mockResolvedValue({ ...CLEAN_RECONCILE, ok: false, deferred: 3 });
        await allianceSyncTick();
        expect(m.setSyncAlert).not.toHaveBeenCalled();
    });

    it('a reconcile transport failure records failure (swallowing its own error) and skips intel + directory', async () => {
        // First tick seeds the cadences (and refreshes the directory); five minutes
        // later intel AND ops are both due and the directory cache is still missing.
        arm([ally({ id, channels: { operations: true, reports: true } })], null);
        await allianceSyncTick();
        vi.clearAllMocks();
        clock += 5 * 60_000;
        m.reconcile.mockRejectedValue(new Error('ETIMEDOUT'));
        m.recordPeerFailure.mockRejectedValue(new Error('health write failed'));
        await expect(allianceSyncTick()).resolves.toBeUndefined();
        expect(m.reconcile).toHaveBeenCalledWith(id);
        expect(m.recordPeerFailure).toHaveBeenCalledWith(id);
        expect(m.intel).not.toHaveBeenCalled();
        expect(m.directory).not.toHaveBeenCalled();
    });

    it.each([
        ['skipped items', { skippedItems: 2, feedResults: [] }],
        ['an errored feed', { skippedItems: 0, feedResults: [{ status: 'ok' }, { status: 'error' }] }],
    ])('intel with %s is not a clean pass (stale alert kept)', async (_l, result) => {
        arm([ally({ id, sync_alert: 'stale', channels: { bulletins: true } })], freshCache());
        await allianceSyncTick(); // first sight: intel staggered, not yet due
        vi.clearAllMocks();
        clock += 5 * 60_000;
        m.intel.mockResolvedValue(result);
        await allianceSyncTick();
        expect(m.intel).toHaveBeenCalled();
        expect(m.setSyncAlert).not.toHaveBeenCalled();
    });

    it('an intel exception is contained and the pass is not clean', async () => {
        arm([ally({ id, sync_alert: 'stale', channels: { warrants: true } })], freshCache());
        await allianceSyncTick();
        vi.clearAllMocks();
        clock += 5 * 60_000;
        m.intel.mockRejectedValue(new Error('parse'));
        await expect(allianceSyncTick()).resolves.toBeUndefined();
        expect(m.setSyncAlert).not.toHaveBeenCalled();
    });

    it('a directory transport failure records failure (swallowed) and blocks recovery re-push', async () => {
        const down = idWithZeroOffset(120_000);
        arm([ally({ id: down, sync_health: 'down' })], null);
        m.directory.mockRejectedValue(new Error('net'));
        m.recordPeerFailure.mockRejectedValue(new Error('x'));
        await allianceSyncTick();
        expect(m.reconcile).toHaveBeenCalled();
        expect(m.recordPeerFailure).toHaveBeenCalledWith(down);
        expect(m.rsvp).not.toHaveBeenCalled();
    });

    it('contains a pass that throws outside its job guards (logged, tick resolves)', async () => {
        arm([ally({ id })], freshCache());
        m.reconcile.mockResolvedValue({ ...CLEAN_RECONCILE, alert: 'a' });
        m.setSyncAlert.mockImplementation(() => { throw new Error('sync throw'); });
        await expect(allianceSyncTick()).resolves.toBeUndefined();
    });
});

describe('allianceSyncTick — wall-clock budget', () => {
    it('defers peers that miss the 40s window and skips jobs past the deadline', async () => {
        const ids = [0, 1, 2, 3].map((i) => `slow-${i}`);
        arm(ids.map((pid) => ally({ id: pid })), null);
        // Each directory refresh "takes" 41s, blowing the budget on the first wave.
        m.directory.mockImplementation(async () => { await Promise.resolve(); clock += 41_000; });
        await allianceSyncTick();
        // Three workers start one peer each; the fourth rolls to the next tick.
        expect(m.directory).toHaveBeenCalledTimes(3);
        expect(m.directory.mock.calls.map((c) => c[0])).not.toContain('slow-3');
    });

    it('stops a pass mid-way once the deadline passes', async () => {
        const id = idWithZeroOffset(120_000);
        arm([ally({ id, channels: { operations: true, reports: true } })], null);
        m.reconcile.mockImplementation(async () => { clock += 45_000; return CLEAN_RECONCILE; });
        await allianceSyncTick();
        expect(m.reconcile).toHaveBeenCalled();
        expect(m.directory).not.toHaveBeenCalled();
    });
});

describe('forceSyncPeer', () => {
    it('runs every applicable job for an active ally, clears the alert first, then emits the id', async () => {
        arm([ally({ id: 'f1', sync_alert: 'old', channels: { operations: true, reports: true } })]);
        const out = await forceSyncPeer('f1');
        expect(out).toEqual({ ok: true, message: 'Sync completed.' });
        const q = fake.find('alliance_peers', 'select')[0];
        expect(q.columns).toBe(COLS);
        expect(hasCall(q, 'eq', 'id', 'f1')).toBe(true);
        expect(m.setSyncAlert).toHaveBeenNthCalledWith(1, 'f1', null);
        expect(m.reconcile).toHaveBeenCalledWith('f1');
        expect(m.intel).toHaveBeenCalledWith(false, ['f1']);
        expect(m.directory).toHaveBeenCalledWith('f1');
        expect(broadcastSpy).toHaveBeenCalledWith('alliance_update', { id: 'f1' });
    });

    it('enforces a 30s per-peer cooldown', async () => {
        arm([ally({ id: 'f1' })]);
        await forceSyncPeer('f1');
        expect(await forceSyncPeer('f1')).toEqual({ ok: false, message: 'Sync already requested — wait a moment before retrying.' });
        clock += 30_001;
        expect((await forceSyncPeer('f1')).ok).toBe(true);
    });

    it('reports an unknown peer without side effects', async () => {
        arm([]);
        expect(await forceSyncPeer('nope')).toEqual({ ok: false, message: 'Peer not found.' });
        expect(m.setSyncAlert).not.toHaveBeenCalled();
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('reports nothing to sync for a feed peer with no intel channels (alert-clear failure swallowed)', async () => {
        arm([ally({ id: 'feed', pairing_state: 'legacy', channels: { operations: true } })]);
        m.setSyncAlert.mockRejectedValue(new Error('x'));
        expect(await forceSyncPeer('feed')).toEqual({ ok: false, message: 'Nothing to sync for this peer (no enabled channels).' });
        expect(m.reconcile).not.toHaveBeenCalled();
        expect(broadcastSpy).not.toHaveBeenCalled();
    });
});
