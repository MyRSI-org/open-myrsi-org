import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fake, broadcastSpy, hasCall, assertNoWildcardSelects, type FakeQuery } from './cov-db-intel-alliances-fake';

// =============================================================================
// lib/db/operations-federation.ts — joint-op federation. HOST side: snapshot
// egress gates (sync_restricted marker fail-closed, clearance ceiling, channel
// re-check at every serve path), invite/revoke/accept/decline, the per-peer push
// (down/channel/budget/ceiling gating + health accounting), the manifest and the
// allied-RSVP ingest cap. GUEST side: inbound size cap + ship-seat strip, mirror
// ownership guards, version gating, accept/poll/RSVP flows and the reconcile
// anti-entropy loop (pull kinds, per-cycle cap, false-revoke + mass-shrink guards).
// =============================================================================

const m = vi.hoisted(() => ({
    getFullOperationDetails: vi.fn(),
    callAlliancePeer: vi.fn(),
    getMaxShareableClearance: vi.fn(),
    scheduleDebounced: vi.fn(),
    cancelDebounced: vi.fn(),
    tryConsumeToken: vi.fn(),
    getCachedAllianceSyncConfig: vi.fn(),
    recordPeerFailure: vi.fn(),
    recordPeerSuccess: vi.fn(),
}));

vi.mock('../lib/db/common.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/db/common.js')>();
    const h = await import('./cov-db-intel-alliances-fake');
    return { ...actual, supabase: h.fake.client, broadcastToOrg: h.broadcastSpy };
});
vi.mock('../lib/db/ops.js', () => ({ getFullOperationDetails: m.getFullOperationDetails }));
vi.mock('../lib/db/alliances.js', () => ({ callAlliancePeer: m.callAlliancePeer }));
vi.mock('../lib/db/system.js', () => ({ getMaxShareableClearance: m.getMaxShareableClearance }));
vi.mock('../lib/db/allianceSyncState.js', () => ({
    scheduleDebounced: m.scheduleDebounced,
    cancelDebounced: m.cancelDebounced,
    tryConsumeToken: m.tryConsumeToken,
    getCachedAllianceSyncConfig: m.getCachedAllianceSyncConfig,
    recordPeerFailure: m.recordPeerFailure,
    recordPeerSuccess: m.recordPeerSuccess,
}));

import {
    projectOperationSnapshot, shouldApplyVersion, buildOperationSnapshot, bumpOperationVersion,
    inviteAllyToOperation, revokeAllyFromOperation, reconcilePeerClearanceShares, pushOperationToAllies,
    scheduleAlliedPush, getOperationSnapshotForPeer, getOperationManifestForPeer, acceptInviteForPeer,
    declineInviteForPeer, upsertAlliedParticipant, removeAlliedParticipant, receiveMirrorInvite,
    receiveMirrorPush, receiveMirrorRevoke, listMirroredOperations, getMirroredOperation,
    acceptMirroredOperation, declineMirroredOperation, pollMirroredOperation, rsvpMirroredOperation,
    removeMirroredRsvp, pushLocalRsvpsForPeer, reconcileMirrorsWithPeer, __resetReconcileStateForTests,
} from '../lib/db/operations-federation';
import type { HydratedOperation } from '../types';

const OP = 'op-1';
const PEER = 'peer-A';
const MARKER_COLS = 'marker:security_limiting_markers!inner(sync_restricted)';

function res(status: number, body?: unknown, jsonThrows = false) {
    return {
        ok: status >= 200 && status < 300, status,
        json: async () => { if (jsonThrows) throw new Error('bad json'); return body; },
    } as unknown as Response;
}

const hostOp = (over: Partial<HydratedOperation> = {}) => ({
    id: OP, name: 'Op', type: 'Combat', status: 'Planning', clearanceLevel: 0,
    owner: { id: 42, name: 'Owner', email: 'o@x', avatarUrl: 'https://cdn.x.net/o.png' },
    participants: [{ userId: 99, user: { id: 99, name: 'P' }, rsvpStatus: 'Going' }],
    alliedOrgs: [{ peerId: PEER, orgName: 'A' }, { peerId: 'peer-B', orgName: 'B' }],
    alliedParticipants: [{ peerId: PEER, remoteUserHandle: 'a1' }, { peerId: 'peer-B', remoteUserHandle: 'b1' }],
    totalUec: 9999, joinCode: 'JOIN', commsPlan: [{ ch: 1 }],
    ...over,
}) as unknown as HydratedOperation;

/** Route-table responder for the shared tables. Each entry may return undefined to fall through. */
interface Routes {
    peerChannels?: unknown;          // alliance_peers select channels (channel gate)
    peerCeiling?: unknown;           // alliance_peers select outbound_max_clearance
    peerInvite?: unknown;            // alliance_peers select status, channels
    peerHealth?: unknown;            // alliance_peers select id, sync_health, …
    markers?: unknown;               // operation_limiting_markers
    opVersion?: unknown;             // operations select joint_version[, is_joint]
    allied?: (q: FakeQuery) => unknown;
    participants?: (q: FakeQuery) => unknown;
    mirrors?: (q: FakeQuery) => unknown;
    participation?: (q: FakeQuery) => unknown;
    users?: unknown;
}
function route(r: Routes = {}) {
    fake.on('alliance_peers', (q) => {
        if (q.columns === 'channels') return (r.peerChannels as never) ?? { data: { channels: { operations: true } } };
        if (q.columns === 'outbound_max_clearance') return (r.peerCeiling as never) ?? { data: { outbound_max_clearance: 3 } };
        if (q.columns === 'status, channels') return (r.peerInvite as never) ?? { data: { status: 'Active', channels: { operations: true } } };
        if (q.columns === 'id, sync_health, outbound_max_clearance, channels') return (r.peerHealth as never) ?? { data: [] };
        return { data: null };
    });
    fake.on('operation_limiting_markers', (r.markers as never) ?? { data: [] });
    fake.on('operations', (q) => {
        if (q.op === 'update') return { error: null };
        return (r.opVersion as never) ?? { data: { joint_version: 4, is_joint: true } };
    });
    fake.on('operation_allied_orgs', (q) => (r.allied?.(q) as never) ?? { data: null, error: null });
    fake.on('operation_allied_participants', (q) => (r.participants?.(q) as never) ?? { data: null, error: null });
    fake.on('mirrored_operations', (q) => (r.mirrors?.(q) as never) ?? { data: null, error: null });
    fake.on('mirrored_operation_participation', (q) => (r.participation?.(q) as never) ?? { data: null, error: null });
    fake.on('users', (r.users as never) ?? { data: null });
}

const emits = () => broadcastSpy.mock.calls.map((c) => (c as unknown[])[1]);

beforeEach(() => {
    fake.reset();
    broadcastSpy.mockClear();
    vi.clearAllMocks();
    __resetReconcileStateForTests();
    m.getMaxShareableClearance.mockResolvedValue(3);
    m.getFullOperationDetails.mockResolvedValue(hostOp());
    m.tryConsumeToken.mockReturnValue(true);
    m.getCachedAllianceSyncConfig.mockReturnValue({ pushDebounceMs: 1500 });
    m.recordPeerFailure.mockResolvedValue(undefined);
    m.recordPeerSuccess.mockResolvedValue(undefined);
    m.callAlliancePeer.mockResolvedValue(res(200, {}));
});
afterEach(() => assertNoWildcardSelects(fake));

// =============================================================================
describe('pure helpers', () => {
    it('projection tolerates absent collections and drops every allied entry without a recipient', () => {
        const bare = { id: OP, name: 'x' } as unknown as HydratedOperation;
        const out = projectOperationSnapshot(bare, false)!;
        expect(out).toMatchObject({ commsPlan: [], limitingMarkers: [], participants: [], tasks: [], commandNodes: [], logistics: [], alliedOrgs: [], alliedParticipants: [], ownerId: 0 });
        expect(out.owner).toEqual({ id: 0, name: 'Allied Member', avatarUrl: undefined });
        const full = projectOperationSnapshot(hostOp(), false)!;
        expect(full.alliedOrgs).toEqual([]);
        expect(full.alliedParticipants).toEqual([]);
        expect(projectOperationSnapshot(hostOp(), true)).toBeNull();
    });

    it('projection strips every user/unit/fleet assignment ref from tasks, command nodes and logistics', () => {
        const out = projectOperationSnapshot(hostOp({
            tasks: [{ id: 1, title: 'T', assignedUserId: 5, assignedUnitId: 2, assignedUser: { id: 5 }, assignedUnit: { id: 2 } }],
            commandNodes: [{ id: 'n', label: 'L', assignedUserId: 5, assignedUnitId: 2, fleetGroupId: 3, fleetGroup: { id: 3 } }],
            logistics: [{ id: 9, item: 'Fuel', fulfilledByUserId: 5 }],
        } as unknown as Partial<HydratedOperation>), false, PEER)!;
        expect(out.tasks).toEqual([{ id: 1, title: 'T', assignedUserId: undefined, assignedUnitId: undefined, assignedUser: undefined, assignedUnit: undefined }]);
        expect(out.commandNodes).toEqual([{ id: 'n', label: 'L', assignedUserId: undefined, assignedUnitId: undefined, assignedUser: undefined, assignedUnit: undefined, fleetGroupId: undefined, fleetGroup: undefined }]);
        expect(out.logistics).toEqual([{ id: 9, item: 'Fuel', fulfilledByUserId: undefined }]);
    });

    it('version gate applies only strictly newer numeric versions', () => {
        expect(shouldApplyVersion(1, null)).toBe(true);
        expect(shouldApplyVersion(0, undefined)).toBe(true);
        expect(shouldApplyVersion(3, 3)).toBe(false);
        expect(shouldApplyVersion('9' as unknown as number, 1)).toBe(false);
    });
});

// =============================================================================
describe('buildOperationSnapshot (egress gate)', () => {
    it('returns null for a missing op without further reads', async () => {
        route();
        m.getFullOperationDetails.mockResolvedValue(null);
        expect(await buildOperationSnapshot(OP, PEER)).toBeNull();
        expect(fake.queries).toHaveLength(0);
    });

    it.each([
        ['object embed', { data: [{ marker: { sync_restricted: true } }] }],
        ['array embed', { data: [{ marker: [{ sync_restricted: false }, { sync_restricted: true }] }] }],
        ['an unreadable marker set (fail closed)', { data: null, error: { message: 'x' } }],
    ])('withholds an op with a sync_restricted marker — %s', async (_l, markers) => {
        route({ markers });
        expect(await buildOperationSnapshot(OP, PEER)).toBeNull();
        const q = fake.find('operation_limiting_markers')[0];
        expect(q.columns).toBe(MARKER_COLS);
        expect(hasCall(q, 'eq', 'operation_id', OP)).toBe(true);
    });

    it('enforces min(org ceiling, peer ceiling); an unknown/omitted peer is ceiling 0', async () => {
        route({ markers: { data: [{ marker: null }, { marker: { sync_restricted: false } }] } });
        m.getFullOperationDetails.mockResolvedValue(hostOp({ clearanceLevel: 2 }));
        m.getMaxShareableClearance.mockResolvedValue(1);
        expect(await buildOperationSnapshot(OP, PEER)).toBeNull();
        m.getMaxShareableClearance.mockResolvedValue(5);
        route({ peerCeiling: { data: { outbound_max_clearance: 1 } } });
        expect(await buildOperationSnapshot(OP, PEER)).toBeNull();
        route({ peerCeiling: { data: null } });
        expect(await buildOperationSnapshot(OP, PEER)).toBeNull();
        expect(await buildOperationSnapshot(OP)).toBeNull();
        const ceil = fake.find('alliance_peers').find((q) => q.columns === 'outbound_max_clearance')!;
        expect(hasCall(ceil, 'eq', 'id', PEER)).toBe(true);
    });

    it('projects a cleared op scoped to the recipient — no financials, no foreign allies, no real ids', async () => {
        route();
        const snap = (await buildOperationSnapshot(OP, PEER))!;
        expect(snap.alliedOrgs).toEqual([{ peerId: '', orgName: 'A' }]);
        expect(snap.alliedParticipants).toEqual([{ peerId: '', remoteUserHandle: 'a1' }]);
        expect(snap).toMatchObject({ totalUec: 0, joinCode: undefined, ownerId: 0 });
        expect(JSON.stringify(snap)).not.toContain('o@x');
        expect(snap.participants[0].userId).toBe(1);
        // A clearance-0 op is shareable even with no recipient.
        expect((await buildOperationSnapshot(OP))!.alliedOrgs).toEqual([]);
    });
});

describe('bumpOperationVersion', () => {
    it('only bumps joint ops', async () => {
        route({ opVersion: { data: { joint_version: 2, is_joint: false } } });
        expect(await bumpOperationVersion(OP)).toBe(2);
        route({ opVersion: { data: null } });
        expect(await bumpOperationVersion(OP)).toBe(0);
        expect(fake.find('operations', 'update')).toHaveLength(0);
        route({ opVersion: { data: { joint_version: null, is_joint: true } } });
        expect(await bumpOperationVersion(OP)).toBe(1);
        const up = fake.find('operations', 'update')[0];
        expect(up.payload).toMatchObject({ joint_version: 1 });
        expect(hasCall(up, 'eq', 'id', OP)).toBe(true);
        expect(fake.find('operations', 'select')[0].columns).toBe('joint_version, is_joint');
    });
});

// =============================================================================
describe('invite / revoke / clearance reconcile', () => {
    it.each([
        ['missing peer', { data: null }],
        ['inactive peer', { data: { status: 'Pending', channels: { operations: true } } }],
        ['joint ops off', { data: { status: 'Active', channels: null } }],
    ])('refuses to invite a %s', async (_l, peerInvite) => {
        route({ peerInvite });
        await expect(inviteAllyToOperation(OP, PEER)).rejects.toThrow('Peer is not an active ally with joint operations enabled.');
        expect(fake.find('operation_allied_orgs')).toHaveLength(0);
    });

    it('refuses an op that cannot be shared (ceiling / restricted) — no invite row, no push', async () => {
        route();
        m.getFullOperationDetails.mockResolvedValue(hostOp({ clearanceLevel: 9 }));
        await expect(inviteAllyToOperation(OP, PEER)).rejects.toThrow('cannot be shared with this ally');
        expect(fake.find('operation_allied_orgs')).toHaveLength(0);
        expect(m.callAlliancePeer).not.toHaveBeenCalled();
    });

    it('records the invite, bumps the version, pushes the scoped snapshot and emits the op id', async () => {
        route();
        await inviteAllyToOperation(OP, PEER);
        const up = fake.find('operation_allied_orgs', 'upsert')[0];
        expect(up.payload).toMatchObject({ operation_id: OP, peer_id: PEER, accepted: false });
        expect(up.writeOptions).toEqual({ onConflict: 'operation_id,peer_id' });
        expect(fake.find('operations', 'update')).toHaveLength(1);
        const [peerId, path, init] = m.callAlliancePeer.mock.calls[0];
        expect([peerId, path, init.method]).toEqual([PEER, '/api/alliance/op-mirror/invite', 'POST']);
        expect(init.body).toMatchObject({ v: 1, op_id: OP, version: 4 });
        expect(init.body.snapshot.alliedOrgs).toEqual([{ peerId: '', orgName: 'A' }]);
        expect(broadcastSpy).toHaveBeenCalledWith('operation_update', { operationId: OP });
    });

    it('a failed invite push is logged, and an invite write error is surfaced', async () => {
        route();
        m.callAlliancePeer.mockRejectedValue(new Error('net'));
        await expect(inviteAllyToOperation(OP, PEER)).resolves.toBeUndefined();
        route({ allied: (q) => (q.op === 'upsert' ? { error: { message: 'x' } } : undefined) });
        await expect(inviteAllyToOperation(OP, PEER)).rejects.toThrow('Failed to invite ally');
    });

    it('revoke deletes the invite + that peer\'s participants, notifies the peer, emits', async () => {
        route();
        m.callAlliancePeer.mockRejectedValue(new Error('down'));
        await revokeAllyFromOperation(OP, PEER);
        for (const t of ['operation_allied_orgs', 'operation_allied_participants']) {
            const d = fake.find(t, 'delete')[0];
            expect(hasCall(d, 'eq', 'operation_id', OP)).toBe(true);
            expect(hasCall(d, 'eq', 'peer_id', PEER)).toBe(true);
        }
        expect(m.callAlliancePeer).toHaveBeenCalledWith(PEER, '/api/alliance/op-mirror/revoke', { method: 'POST', body: { v: 1, op_id: OP } });
        expect(emits()).toEqual([{ operationId: OP }]);
    });

    it('clearance reconcile revokes only shares that no longer fit (and survives a failed revoke)', async () => {
        route({ allied: (q) => (q.op === 'select' ? { data: [{ operation_id: 'ok-op' }, { operation_id: 'hot-op' }] } : undefined) });
        m.getFullOperationDetails.mockImplementation(async (id: string) => hostOp({ id, clearanceLevel: id === 'hot-op' ? 9 : 0 }));
        await reconcilePeerClearanceShares(PEER);
        expect(m.callAlliancePeer.mock.calls.map((c) => c[2].body.op_id)).toEqual(['hot-op']);
        // A revoke whose delete throws is swallowed.
        route({
            allied: (q) => {
                if (q.op === 'select') return { data: [{ operation_id: 'hot-op' }] };
                if (q.op === 'delete') throw new Error('db gone');
                return undefined;
            },
        });
        await expect(reconcilePeerClearanceShares(PEER)).resolves.toBeUndefined();
        route({ allied: () => ({ data: null }) });
        await expect(reconcilePeerClearanceShares(PEER)).resolves.toBeUndefined();
    });
});

// =============================================================================
describe('pushOperationToAllies', () => {
    const allies = (ids: string[]) => (q: FakeQuery) => (q.op === 'select' ? { data: ids.map((peer_id) => ({ peer_id })) } : undefined);
    const health = (rows: unknown[]) => ({ data: rows });
    const ok = (id: string, over: Record<string, unknown> = {}) => ({ id, sync_health: 'healthy', outbound_max_clearance: 3, channels: { operations: true }, ...over });

    it('immediate events cancel the pending coalesced push; no accepted allies → nothing else', async () => {
        route({ allied: () => ({ data: [] }) });
        await pushOperationToAllies(OP, 'status_change');
        expect(m.cancelDebounced).toHaveBeenCalledWith(`oppush:${OP}`);
        const q = fake.find('operation_allied_orgs')[0];
        expect(hasCall(q, 'eq', 'accepted', true)).toBe(true);
        expect(fake.find('alliance_peers')).toHaveLength(0);
        m.cancelDebounced.mockClear();
        route({ allied: () => ({ data: null }) });
        await pushOperationToAllies(OP, 'full');
        expect(m.cancelDebounced).not.toHaveBeenCalled();
    });

    it('skips down peers and peers whose Joint Ops channel is off; pushes a recipient-scoped snapshot to the rest', async () => {
        route({ allied: allies([PEER, 'down', 'off', 'gone']), peerHealth: health([ok(PEER), ok('down', { sync_health: 'down' }), ok('off', { channels: { operations: false } })]) });
        await pushOperationToAllies(OP, 'alert');
        expect(m.callAlliancePeer).toHaveBeenCalledTimes(1);
        const [peerId, path, init] = m.callAlliancePeer.mock.calls[0];
        expect([peerId, path]).toEqual([PEER, '/api/alliance/op-mirror/push']);
        expect(init.body).toMatchObject({ v: 1, op_id: OP, version: 4, event: 'alert' });
        expect(init.body.snapshot.alliedParticipants).toEqual([{ peerId: '', remoteUserHandle: 'a1' }]);
        expect(m.tryConsumeToken).toHaveBeenCalledWith(PEER, { force: true });
        await Promise.resolve();
        expect(m.recordPeerSuccess).toHaveBeenCalledWith(PEER);
        const h = fake.find('alliance_peers')[0];
        expect(hasCall(h, 'in', 'id', [PEER, 'down', 'off', 'gone'])).toBe(true);
    });

    it('sends a null snapshot over the clearance ceiling or for a restricted op; cancel carries none', async () => {
        route({ allied: allies([PEER]), peerHealth: health([ok(PEER, { outbound_max_clearance: null })]) });
        m.getFullOperationDetails.mockResolvedValue(hostOp({ clearanceLevel: 1 }));
        await pushOperationToAllies(OP, 'status_change');
        expect(m.callAlliancePeer.mock.calls[0][2].body.snapshot).toBeNull();
        m.callAlliancePeer.mockClear();
        route({ allied: allies([PEER]), peerHealth: health([ok(PEER)]), markers: { data: [{ marker: { sync_restricted: true } }] } });
        m.getFullOperationDetails.mockResolvedValue(hostOp());
        await pushOperationToAllies(OP, 'status_change');
        expect(m.callAlliancePeer.mock.calls[0][2].body.snapshot).toBeNull();
        m.callAlliancePeer.mockClear();
        m.getFullOperationDetails.mockClear();
        await pushOperationToAllies(OP, 'cancel');
        expect(m.getFullOperationDetails).not.toHaveBeenCalled();
        expect(m.callAlliancePeer.mock.calls[0][2].body).toMatchObject({ event: 'cancel', snapshot: null });
    });

    it('a budget-starved full push re-coalesces in 10s; an immediate one never schedules', async () => {
        route({ allied: allies([PEER]), peerHealth: health([ok(PEER)]) });
        m.tryConsumeToken.mockReturnValue(false);
        await pushOperationToAllies(OP, 'full');
        expect(m.tryConsumeToken).toHaveBeenCalledWith(PEER, { force: false });
        expect(m.callAlliancePeer).not.toHaveBeenCalled();
        expect(m.scheduleDebounced).toHaveBeenCalledWith(`oppush:${OP}`, 10_000, expect.any(Function));
        m.scheduleDebounced.mockClear();
        await pushOperationToAllies(OP, 'alert');
        expect(m.scheduleDebounced).not.toHaveBeenCalled();
    });

    it('health accounting: no response records nothing; a thrown push records failure; health-write errors are swallowed', async () => {
        route({ allied: allies([PEER]), peerHealth: { data: null } });
        await pushOperationToAllies(OP, 'full'); // channel unknown → fail closed, nothing sent
        expect(m.callAlliancePeer).not.toHaveBeenCalled();
        route({ allied: allies([PEER]), peerHealth: health([ok(PEER)]) });
        m.callAlliancePeer.mockResolvedValueOnce(null);
        await pushOperationToAllies(OP, 'full');
        expect(m.recordPeerSuccess).not.toHaveBeenCalled();
        m.callAlliancePeer.mockRejectedValueOnce(new Error('net'));
        m.recordPeerFailure.mockRejectedValueOnce(new Error('x'));
        await pushOperationToAllies(OP, 'full');
        expect(m.recordPeerFailure).toHaveBeenCalledWith(PEER);
        m.recordPeerSuccess.mockRejectedValueOnce(new Error('x'));
        await pushOperationToAllies(OP, 'full');
        await new Promise((r) => setTimeout(r, 0));
        expect(m.recordPeerSuccess).toHaveBeenCalledWith(PEER);
    });

    it('scheduleAlliedPush debounces a full push with the configured window', async () => {
        scheduleAlliedPush(OP);
        expect(m.scheduleDebounced).toHaveBeenCalledWith(`oppush:${OP}`, 1500, expect.any(Function));
        route({ allied: () => ({ data: [] }) });
        await m.scheduleDebounced.mock.calls[0][2]();
        expect(fake.find('operation_allied_orgs')).toHaveLength(1);
        expect(m.cancelDebounced).not.toHaveBeenCalled(); // 'full' is not immediate
    });
});

// =============================================================================
describe('host serve paths', () => {
    it('snapshot poll: invite row + live channel required; delta answers unchanged', async () => {
        route({ allied: () => ({ data: null }) });
        await expect(getOperationSnapshotForPeer(OP, PEER)).rejects.toThrow('forbidden');
        route({ allied: () => ({ data: { accepted: false } }), peerChannels: { data: { channels: { operations: false } } } });
        await expect(getOperationSnapshotForPeer(OP, PEER)).rejects.toThrow('forbidden');
        route({ allied: () => ({ data: { accepted: false } }) });
        expect(await getOperationSnapshotForPeer(OP, PEER, 4)).toEqual({ unchanged: true });
        const out = await getOperationSnapshotForPeer(OP, PEER, 3) as { version: number; snapshot: HydratedOperation };
        expect(out.version).toBe(4);
        expect(out.snapshot.alliedOrgs).toEqual([{ peerId: '', orgName: 'A' }]);
        const chan = fake.find('alliance_peers').find((q) => q.columns === 'channels')!;
        expect(hasCall(chan, 'eq', 'status', 'Active')).toBe(true);
    });

    it('manifest: empty when the channel is off; otherwise only own rows under the ceiling', async () => {
        route({ peerChannels: { data: null } });
        const empty = await getOperationManifestForPeer(PEER);
        expect(empty).toMatchObject({ v: 1, accepted: {}, invited: [] });
        expect(fake.find('operation_allied_orgs')).toHaveLength(0);
        route({
            peerCeiling: { data: { outbound_max_clearance: 2 } },
            allied: () => ({ data: [
                { operation_id: 'a', accepted: true, operation: { joint_version: 7, clearance_level: 1 } },
                { operation_id: 'b', accepted: false, operation: [{ joint_version: 1, clearance_level: null }] },
                { operation_id: 'hot', accepted: true, operation: { joint_version: 1, clearance_level: 3 } },
                { operation_id: 'gone', accepted: true, operation: null },
                { operation_id: 'nov', accepted: true, operation: { joint_version: null, clearance_level: 0 } },
            ] }),
        });
        const man = await getOperationManifestForPeer(PEER);
        expect(man.accepted).toEqual({ a: 7, nov: 0 });
        expect(man.invited).toEqual(['b']);
        const q = fake.find('operation_allied_orgs')[0];
        expect(q.columns).toBe('operation_id, accepted, operation:operations!inner(joint_version, clearance_level)');
        expect(hasCall(q, 'eq', 'peer_id', PEER)).toBe(true);
        route({ peerCeiling: { data: null }, allied: () => ({ data: null }) });
        expect((await getOperationManifestForPeer(PEER)).accepted).toEqual({});
    });

    it('accept: invite row + channel required; marks accepted and returns the scoped first snapshot', async () => {
        route({ allied: () => ({ data: null }) });
        await expect(acceptInviteForPeer(OP, PEER)).rejects.toThrow('forbidden');
        route({ allied: (q) => (q.op === 'select' ? { data: { peer_id: PEER } } : undefined), peerChannels: { data: { channels: {} } } });
        await expect(acceptInviteForPeer(OP, PEER)).rejects.toThrow('forbidden');
        expect(fake.find('operation_allied_orgs', 'update')).toHaveLength(0);
        route({ allied: (q) => (q.op === 'select' ? { data: { peer_id: PEER } } : { error: null }) });
        const out = await acceptInviteForPeer(OP, PEER);
        const up = fake.find('operation_allied_orgs', 'update')[0];
        expect(up.payload).toMatchObject({ accepted: true });
        expect(hasCall(up, 'eq', 'peer_id', PEER)).toBe(true);
        expect(out).toMatchObject({ v: 1, op_id: OP, version: 4 });
        expect(out.snapshot!.alliedOrgs).toEqual([{ peerId: '', orgName: 'A' }]);
        expect(emits()).toContainEqual({ operationId: OP });
        route({ allied: (q) => (q.op === 'select' ? { data: { peer_id: PEER } } : { error: { message: 'x' } }) });
        await expect(acceptInviteForPeer(OP, PEER)).rejects.toThrow('Failed to accept invite');
    });

    it('decline deletes the peer\'s invite row and emits', async () => {
        route();
        await declineInviteForPeer(OP, PEER);
        const d = fake.find('operation_allied_orgs', 'delete')[0];
        expect(hasCall(d, 'eq', 'operation_id', OP)).toBe(true);
        expect(hasCall(d, 'eq', 'peer_id', PEER)).toBe(true);
        expect(emits()).toEqual([{ operationId: OP }]);
    });
});

// =============================================================================
describe('allied RSVP ingest (host)', () => {
    const accepted = (q: FakeQuery) => (q.op === 'select' ? { data: { accepted: true } } : undefined);

    it('requires an accepted invite, a live channel and a handle', async () => {
        route({ allied: () => ({ data: { accepted: false } }) });
        await expect(upsertAlliedParticipant(OP, PEER, { remoteUserHandle: 'h', rsvpStatus: 'Going' })).rejects.toThrow('forbidden');
        route({ allied: accepted, peerChannels: { data: null } });
        await expect(upsertAlliedParticipant(OP, PEER, { remoteUserHandle: 'h', rsvpStatus: 'Going' })).rejects.toThrow('forbidden');
        route({ allied: accepted });
        await expect(upsertAlliedParticipant(OP, PEER, { remoteUserHandle: '', rsvpStatus: 'Going' })).rejects.toThrow('malformed_request');
        expect(fake.find('operation_allied_participants', 'upsert')).toHaveLength(0);
    });

    it('counts a REAL column and refuses the write when the count faults (cap fails closed)', async () => {
        route({ allied: accepted, participants: (q) => (q.op === 'select' ? { count: null, error: { code: '42703' } } : undefined) });
        await expect(upsertAlliedParticipant(OP, PEER, { remoteUserHandle: 'h', rsvpStatus: 'Going' })).rejects.toThrow('Failed to count allied participants');
        const cnt = fake.find('operation_allied_participants')[0];
        expect(cnt.columns).toBe('remote_user_handle');
        expect(cnt.selectOptions).toEqual({ count: 'exact', head: true });
        expect(fake.find('operation_allied_participants', 'upsert')).toHaveLength(0);
    });

    it('at the 200-row cap a NEW handle is refused but an existing one still updates', async () => {
        let existing: unknown = null;
        route({
            allied: accepted,
            participants: (q) => {
                if (q.op === 'select' && q.selectOptions) return { count: 200 };
                if (q.op === 'select') return { data: existing };
                return { error: null };
            },
        });
        await expect(upsertAlliedParticipant(OP, PEER, { remoteUserHandle: 'new', rsvpStatus: 'Going' })).rejects.toThrow('participant_limit_reached');
        const look = fake.find('operation_allied_participants', 'select')[1];
        expect(hasCall(look, 'eq', 'remote_user_handle', 'new')).toBe(true);
        existing = { remote_user_handle: 'old' };
        await expect(upsertAlliedParticipant(OP, PEER, { remoteUserHandle: 'old', rsvpStatus: 'Going' })).resolves.toBeUndefined();
    });

    it('sanitises peer-supplied fields before storing, bumps the version and emits', async () => {
        route({ allied: accepted, participants: (q) => (q.op === 'select' ? { count: 3 } : { error: null }) });
        await upsertAlliedParticipant(OP, PEER, {
            remoteUserHandle: 'H'.repeat(300), displayName: 'D'.repeat(300), avatarUrl: 'javascript:alert(1)',
            role: '', shipText: 'S'.repeat(400), rsvpStatus: '', isReady: 1 as unknown as boolean,
        });
        const up = fake.find('operation_allied_participants', 'upsert')[0];
        const p = up.payload as Record<string, unknown>;
        expect((p.remote_user_handle as string).length).toBe(120);
        expect((p.display_name as string).length).toBe(120);
        expect((p.ship_text as string).length).toBe(200);
        expect(p).toMatchObject({ operation_id: OP, peer_id: PEER, avatar_url: null, role: null, rsvp_status: 'Pending', is_ready: true });
        expect(up.writeOptions).toEqual({ onConflict: 'operation_id,peer_id,remote_user_handle' });
        expect(fake.find('operations', 'update')).toHaveLength(1);
        expect(emits()).toEqual([{ operationId: OP }]);
    });

    it('keeps a safe avatar and surfaces an upsert failure', async () => {
        route({ allied: accepted, participants: (q) => (q.op === 'select' ? { count: null } : { error: { message: 'x' } }) });
        await expect(upsertAlliedParticipant(OP, PEER, { remoteUserHandle: 'h', avatarUrl: 'https://cdn.x.net/a.png', rsvpStatus: 'Going' })).rejects.toThrow('Failed to record allied RSVP');
        expect(fake.find('operation_allied_participants', 'upsert')[0].payload).toMatchObject({ avatar_url: 'https://cdn.x.net/a.png', rsvp_status: 'Going' });
    });

    it('withdrawal deletes exactly the peer\'s own (op, peer, handle) row', async () => {
        route({ allied: () => ({ data: null }) });
        await expect(removeAlliedParticipant(OP, PEER, 'h')).rejects.toThrow('forbidden');
        route({ allied: accepted, peerChannels: { data: { channels: { operations: 'yes' } } } });
        await expect(removeAlliedParticipant(OP, PEER, 'h')).rejects.toThrow('forbidden');
        route({ allied: accepted });
        await expect(removeAlliedParticipant(OP, PEER, '')).rejects.toThrow('malformed_request');
        await removeAlliedParticipant(OP, PEER, 'h');
        const d = fake.find('operation_allied_participants', 'delete')[0];
        expect(hasCall(d, 'eq', 'operation_id', OP)).toBe(true);
        expect(hasCall(d, 'eq', 'peer_id', PEER)).toBe(true);
        expect(hasCall(d, 'eq', 'remote_user_handle', 'h')).toBe(true);
        expect(emits()).toEqual([{ operationId: OP }]);
        route({ allied: accepted, participants: (q) => (q.op === 'delete' ? { error: { message: 'x' } } : undefined) });
        await expect(removeAlliedParticipant(OP, PEER, 'h')).rejects.toThrow('Failed to remove allied RSVP');
    });
});

// =============================================================================
describe('guest inbound: invite / push / revoke', () => {
    const snap = (extra: Record<string, unknown> = {}) => ({ id: OP, name: 'Mirror', ...extra }) as unknown as HydratedOperation;

    it('invite: rejects a malformed body; ignores a peer without the ops channel or one squatting another host\'s mirror', async () => {
        await expect(receiveMirrorInvite({ id: PEER }, { v: 1, op_id: '' as string, version: 1, snapshot: null })).rejects.toThrow('malformed_request');
        await expect(receiveMirrorInvite({ id: PEER }, null as never)).rejects.toThrow('malformed_request');
        route({ peerChannels: { data: { channels: {} } } });
        await receiveMirrorInvite({ id: PEER }, { v: 1, op_id: OP, version: 1, snapshot: snap() });
        route({ mirrors: (q) => (q.op === 'select' ? { data: { host_peer_id: 'other' } } : undefined) });
        await receiveMirrorInvite({ id: PEER }, { v: 1, op_id: OP, version: 1, snapshot: snap() });
        expect(fake.find('mirrored_operations', 'upsert')).toHaveLength(0);
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('invite: stores a pending mirror with ship seats stripped', async () => {
        route();
        await receiveMirrorInvite({ id: PEER }, { v: 1, op_id: OP, version: undefined as unknown as number, snapshot: snap({ shipSlots: [{ userId: 1 }] }) });
        const up = fake.find('mirrored_operations', 'upsert')[0];
        const p = up.payload as Record<string, unknown>;
        expect(p).toMatchObject({ id: OP, host_peer_id: PEER, version: 0, accepted: false, revoked_at: null });
        expect('shipSlots' in (p.snapshot as object)).toBe(false);
        expect(up.writeOptions).toEqual({ onConflict: 'id' });
        expect(emits()).toEqual([{ operationId: OP }]);
    });

    it('invite: refuses an oversized snapshot and surfaces a write error', async () => {
        route();
        await expect(receiveMirrorInvite({ id: PEER }, { v: 1, op_id: OP, version: 1, snapshot: snap({ blob: 'x'.repeat(1_000_001) }) })).rejects.toThrow('malformed_request');
        route({ mirrors: (q) => (q.op === 'upsert' ? { error: { message: 'x' } } : undefined) });
        await expect(receiveMirrorInvite({ id: PEER }, { v: 1, op_id: OP, version: 1, snapshot: null })).rejects.toThrow('Failed to receive invite');
    });

    it('push: only the owning host may update; cancel revokes; stale versions are dropped', async () => {
        route({ peerChannels: { data: null } });
        await receiveMirrorPush({ id: PEER }, { v: 1, op_id: OP, version: 9, snapshot: snap() });
        route({ mirrors: (q) => (q.op === 'select' ? { data: null } : undefined) });
        await receiveMirrorPush({ id: PEER }, { v: 1, op_id: OP, version: 9, snapshot: snap() });
        route({ mirrors: (q) => (q.op === 'select' ? { data: { version: 1, host_peer_id: 'other' } } : undefined) });
        await receiveMirrorPush({ id: PEER }, { v: 1, op_id: OP, version: 9, snapshot: snap() });
        route({ mirrors: (q) => (q.op === 'select' ? { data: { version: 9, host_peer_id: PEER } } : undefined) });
        await receiveMirrorPush({ id: PEER }, { v: 1, op_id: OP, version: 9, snapshot: snap() });
        expect(fake.find('mirrored_operations', 'update')).toHaveLength(0);

        await receiveMirrorPush({ id: PEER }, { v: 1, op_id: OP, version: 0, event: 'cancel', snapshot: null });
        const cancel = fake.find('mirrored_operations', 'update')[0];
        expect(Object.keys(cancel.payload as object).sort()).toEqual(['revoked_at', 'snapshot_updated_at']);

        await receiveMirrorPush({ id: PEER }, { v: 1, op_id: OP, version: 10, snapshot: snap({ shipSlots: [] }) });
        const apply = fake.find('mirrored_operations', 'update')[1];
        expect(apply.payload).toMatchObject({ version: 10 });
        expect('shipSlots' in ((apply.payload as { snapshot: object }).snapshot)).toBe(false);
        expect(hasCall(apply, 'eq', 'id', OP)).toBe(true);
        expect(emits()).toEqual([{ operationId: OP }, { operationId: OP }]);
    });

    it('revoke: scoped to the owning host and gated on the channel', async () => {
        route({ peerChannels: { data: null } });
        await receiveMirrorRevoke({ id: PEER }, OP);
        expect(fake.find('mirrored_operations')).toHaveLength(0);
        route();
        await receiveMirrorRevoke({ id: PEER }, OP);
        const up = fake.find('mirrored_operations', 'update')[0];
        expect(hasCall(up, 'eq', 'id', OP)).toBe(true);
        expect(hasCall(up, 'eq', 'host_peer_id', PEER)).toBe(true);
        expect(emits()).toEqual([{ operationId: OP }]);
    });
});

// =============================================================================
describe('guest reads + member flows', () => {
    const mirrorRow = (over: Record<string, unknown> = {}) => ({
        id: OP, host_peer_id: PEER, snapshot: { name: 'x' }, version: 2, snapshot_updated_at: 's', accepted: true,
        invited_at: 'i', accepted_at: 'a', last_polled_at: null, peer: { peer_org_name: null, peer_icon_url: null, label: 'Ally' }, ...over,
    });

    it('list: members see accepted, non-revoked mirrors only; admins also see pending; errors → []', async () => {
        route({ mirrors: () => ({ data: [mirrorRow()] }) });
        const [mo] = await listMirroredOperations(false);
        expect(mo).toMatchObject({ id: OP, hostPeerName: 'Ally', accepted: true });
        const q = fake.find('mirrored_operations')[0];
        expect(hasCall(q, 'is', 'revoked_at', null)).toBe(true);
        expect(hasCall(q, 'eq', 'accepted', true)).toBe(true);
        expect(hasCall(q, 'order', 'invited_at', { ascending: false })).toBe(true);
        await listMirroredOperations(true);
        expect(hasCall(fake.find('mirrored_operations')[1], 'eq', 'accepted', true)).toBe(false);
        route({ mirrors: () => ({ data: null, error: { message: 'x' } }) });
        expect(await listMirroredOperations(true)).toEqual([]);
    });

    it('detail: pending mirrors hidden from non-admins; participation mapped to display fields', async () => {
        route({ mirrors: () => ({ data: null }) });
        expect(await getMirroredOperation(OP)).toBeNull();
        expect(hasCall(fake.find('mirrored_operations')[0], 'eq', 'accepted', true)).toBe(true);
        fake.reset();
        route({
            mirrors: () => ({ data: mirrorRow({ accepted: false }) }),
            participation: () => ({ data: [
                { mirror_op_id: OP, user_id: 5, rsvp_status: 'Going', ship_text: null, is_ready: true, updated_at: 'u', user: { id: 5, name: 'N', avatar_url: 'a' } },
                { mirror_op_id: OP, user_id: 6, rsvp_status: 'Maybe', ship_text: 's', is_ready: false, updated_at: 'u', user: null },
            ] }),
        });
        const mo = (await getMirroredOperation(OP, true))!;
        expect(hasCall(fake.find('mirrored_operations')[0], 'eq', 'accepted', true)).toBe(false);
        expect(mo.myParticipation).toEqual([
            { mirrorOpId: OP, userId: 5, rsvpStatus: 'Going', shipText: null, isReady: true, updatedAt: 'u', user: { id: 5, name: 'N', avatarUrl: 'a' } },
            { mirrorOpId: OP, userId: 6, rsvpStatus: 'Maybe', shipText: 's', isReady: false, updatedAt: 'u', user: undefined },
        ]);
        const parts = fake.find('mirrored_operation_participation')[0];
        expect(hasCall(parts, 'eq', 'mirror_op_id', OP)).toBe(true);
        route({ mirrors: () => ({ data: mirrorRow() }), participation: () => ({ data: null }) });
        expect((await getMirroredOperation(OP))!.myParticipation).toEqual([]);
    });

    it('accept: needs the mirror and the host\'s confirmation, then stores the capped first snapshot', async () => {
        route({ mirrors: () => ({ data: null }) });
        await expect(acceptMirroredOperation(OP)).rejects.toThrow('Mirror not found.');
        route({ mirrors: (q) => (q.op === 'select' ? { data: { host_peer_id: PEER } } : undefined) });
        m.callAlliancePeer.mockResolvedValueOnce(null);
        await expect(acceptMirroredOperation(OP)).rejects.toThrow('Host did not confirm the invite.');
        m.callAlliancePeer.mockResolvedValueOnce(res(403));
        await expect(acceptMirroredOperation(OP)).rejects.toThrow('Host did not confirm the invite.');
        m.callAlliancePeer.mockResolvedValueOnce(res(200, { v: 1, op_id: OP, snapshot: { name: 'S', shipSlots: [1] } }));
        await acceptMirroredOperation(OP);
        expect(m.callAlliancePeer).toHaveBeenLastCalledWith(PEER, `/api/alliance/op/${OP}/accept`, { method: 'POST', body: { v: 1, op_id: OP } });
        const up = fake.find('mirrored_operations', 'update')[0];
        expect(up.payload).toMatchObject({ accepted: true, version: 0, snapshot: { name: 'S' } });
        expect(emits()).toEqual([{ operationId: OP }]);
        route({ mirrors: (q) => (q.op === 'select' ? { data: { host_peer_id: PEER } } : { error: { message: 'x' } }) });
        m.callAlliancePeer.mockResolvedValueOnce(res(200, { version: 2, snapshot: null }));
        await expect(acceptMirroredOperation(OP)).rejects.toThrow('Failed to accept operation');
    });

    it('decline: tells the host when known (failure swallowed), always deletes locally', async () => {
        route({ mirrors: (q) => (q.op === 'select' ? { data: { host_peer_id: PEER } } : undefined) });
        m.callAlliancePeer.mockRejectedValueOnce(new Error('down'));
        await declineMirroredOperation(OP);
        expect(m.callAlliancePeer).toHaveBeenCalledWith(PEER, `/api/alliance/op/${OP}/decline`, { method: 'POST', body: { v: 1, op_id: OP } });
        expect(hasCall(fake.find('mirrored_operations', 'delete')[0], 'eq', 'id', OP)).toBe(true);
        m.callAlliancePeer.mockClear();
        route({ mirrors: () => ({ data: null }) });
        await declineMirroredOperation(OP);
        expect(m.callAlliancePeer).not.toHaveBeenCalled();
        expect(fake.find('mirrored_operations', 'delete')).toHaveLength(2);
    });

    it('poll: gated on an accepted mirror and the budget; applies only newer versions', async () => {
        route({ mirrors: () => ({ data: null }) });
        await pollMirroredOperation(OP);
        expect(m.callAlliancePeer).not.toHaveBeenCalled();
        const sel = fake.find('mirrored_operations')[0];
        expect(hasCall(sel, 'eq', 'accepted', true)).toBe(true);
        expect(hasCall(sel, 'is', 'revoked_at', null)).toBe(true);

        route({ mirrors: (q) => (q.op === 'select' ? { data: { host_peer_id: PEER, version: 3 } } : { error: null }) });
        m.tryConsumeToken.mockReturnValueOnce(false);
        await pollMirroredOperation(OP);
        expect(m.callAlliancePeer).not.toHaveBeenCalled();

        m.callAlliancePeer.mockResolvedValueOnce(res(500));
        await pollMirroredOperation(OP);
        expect(m.callAlliancePeer).toHaveBeenLastCalledWith(PEER, `/api/alliance/op/${OP}?since=3`);
        expect(fake.find('mirrored_operations', 'update')).toHaveLength(0);

        m.callAlliancePeer.mockResolvedValueOnce(res(200, { unchanged: true }));
        await pollMirroredOperation(OP);
        expect((fake.find('mirrored_operations', 'update')[0].payload as object)).toHaveProperty('last_polled_at');
        expect(fake.find('mirrored_operations', 'update')).toHaveLength(1);

        m.callAlliancePeer.mockResolvedValueOnce(res(200, { version: 3, snapshot: {} }));
        await pollMirroredOperation(OP);
        expect(fake.find('mirrored_operations', 'update')).toHaveLength(2);

        m.callAlliancePeer.mockResolvedValueOnce(res(200, { version: 5, snapshot: { name: 'new' } }));
        await pollMirroredOperation(OP);
        const apply = fake.find('mirrored_operations', 'update')[3];
        expect(apply.payload).toMatchObject({ version: 5, snapshot: { name: 'new' } });
        expect(emits()).toEqual([{ operationId: OP }]);
    });

    it('RSVP: only on an accepted mirror; stores locally then pushes a handle-only identity to the host', async () => {
        route({ mirrors: () => ({ data: { host_peer_id: PEER, accepted: false } }) });
        await expect(rsvpMirroredOperation(OP, 5, 'Going')).rejects.toThrow('This operation is not active.');
        route({ mirrors: () => ({ data: { host_peer_id: PEER, accepted: true } }), users: { data: { name: 'Nm', rsi_handle: 'Handle', avatar_url: 'a' } } });
        await rsvpMirroredOperation(OP, 5, 'Going', 'Cutlass', true);
        const up = fake.find('mirrored_operation_participation', 'upsert')[0];
        expect(up.payload).toMatchObject({ mirror_op_id: OP, user_id: 5, rsvp_status: 'Going', ship_text: 'Cutlass', is_ready: true });
        expect(up.writeOptions).toEqual({ onConflict: 'mirror_op_id,user_id' });
        expect(fake.find('users')[0].columns).toBe('name, rsi_handle, avatar_url');
        const [, path, init] = m.callAlliancePeer.mock.calls[0];
        expect(path).toBe(`/api/alliance/op/${OP}/rsvp`);
        expect(init.body).toEqual({ v: 1, op_id: OP, remoteUserHandle: 'Handle', displayName: 'Nm', avatarUrl: 'a', shipText: 'Cutlass', rsvpStatus: 'Going', isReady: true });
        expect(JSON.stringify(init.body)).not.toMatch(/"(user_?id|id)":\s*5/);
        expect(emits()).toEqual([{ operationId: OP }]);
    });

    it('RSVP handle falls back name → user-<id>; push failures are swallowed; write errors surfaced', async () => {
        route({ mirrors: () => ({ data: { host_peer_id: PEER, accepted: true } }), users: { data: { name: 'Nm', rsi_handle: null } } });
        m.callAlliancePeer.mockRejectedValueOnce(new Error('x'));
        await rsvpMirroredOperation(OP, 5, 'Maybe');
        expect(m.callAlliancePeer.mock.calls[0][2].body.remoteUserHandle).toBe('Nm');
        expect(fake.find('mirrored_operation_participation', 'upsert')[0].payload).toMatchObject({ ship_text: null, is_ready: false });
        route({ mirrors: () => ({ data: { host_peer_id: PEER, accepted: true } }), users: { data: null } });
        await rsvpMirroredOperation(OP, 5, 'Maybe');
        expect(m.callAlliancePeer.mock.calls[1][2].body.remoteUserHandle).toBe('user-5');
        route({ mirrors: () => ({ data: { host_peer_id: PEER, accepted: true } }), participation: () => ({ error: { message: 'x' } }) });
        await expect(rsvpMirroredOperation(OP, 5, 'Going')).rejects.toThrow('Failed to RSVP');
    });

    it('RSVP withdrawal deletes locally and pushes removed:true with the same handle derivation', async () => {
        route({ mirrors: () => ({ data: null }) });
        await expect(removeMirroredRsvp(OP, 5)).rejects.toThrow('This operation is not active.');
        route({ mirrors: () => ({ data: { host_peer_id: PEER, accepted: true } }), users: { data: { name: 'Nm', rsi_handle: 'H' } } });
        await removeMirroredRsvp(OP, 5);
        const d = fake.find('mirrored_operation_participation', 'delete')[0];
        expect(hasCall(d, 'eq', 'mirror_op_id', OP)).toBe(true);
        expect(hasCall(d, 'eq', 'user_id', 5)).toBe(true);
        expect(m.callAlliancePeer.mock.calls[0][2].body).toEqual({ v: 1, op_id: OP, remoteUserHandle: 'H', removed: true });
        route({ mirrors: () => ({ data: { host_peer_id: PEER, accepted: true } }), users: { data: { name: 'Nm' } } });
        m.callAlliancePeer.mockRejectedValueOnce(new Error('x'));
        await removeMirroredRsvp(OP, 5);
        expect(m.callAlliancePeer.mock.calls[1][2].body.remoteUserHandle).toBe('Nm');
        route({ mirrors: () => ({ data: { host_peer_id: PEER, accepted: true } }), users: { data: null } });
        await removeMirroredRsvp(OP, 5);
        expect(m.callAlliancePeer.mock.calls[2][2].body.remoteUserHandle).toBe('user-5');
    });

    it('recovery re-push: channel-gated, budget-bounded, skips handle-less rows, swallows push failures', async () => {
        route({ peerChannels: { data: null } });
        await pushLocalRsvpsForPeer(PEER);
        expect(fake.find('mirrored_operations')).toHaveLength(0);
        route({ mirrors: () => ({ data: [] }) });
        await pushLocalRsvpsForPeer(PEER);
        expect(fake.find('mirrored_operation_participation')).toHaveLength(0);
        route({
            mirrors: () => ({ data: [{ id: 'm1' }, { id: 'm2' }] }),
            participation: () => ({ data: [
                { mirror_op_id: 'm1', rsvp_status: 'Going', ship_text: null, is_ready: 1, user: [{ name: 'A', rsi_handle: 'ha', avatar_url: null }] },
                { mirror_op_id: 'm1', rsvp_status: 'Going', ship_text: 's', is_ready: false, user: null },
                { mirror_op_id: 'm2', rsvp_status: 'Maybe', ship_text: 's', is_ready: false, user: { name: 'B', rsi_handle: null, avatar_url: 'b' } },
                { mirror_op_id: 'm2', rsvp_status: 'Going', ship_text: null, is_ready: false, user: { name: 'C', rsi_handle: 'hc', avatar_url: null } },
            ] }),
        });
        m.tryConsumeToken.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
        m.callAlliancePeer.mockRejectedValueOnce(new Error('x'));
        await pushLocalRsvpsForPeer(PEER);
        const mq = fake.find('mirrored_operations')[0];
        expect(hasCall(mq, 'eq', 'host_peer_id', PEER)).toBe(true);
        expect(hasCall(mq, 'eq', 'accepted', true)).toBe(true);
        expect(hasCall(fake.find('mirrored_operation_participation')[0], 'in', 'mirror_op_id', ['m1', 'm2'])).toBe(true);
        expect(m.callAlliancePeer.mock.calls.map((c) => [c[1], c[2].body.remoteUserHandle])).toEqual([
            ['/api/alliance/op/m1/rsvp', 'ha'], ['/api/alliance/op/m2/rsvp', 'B'],
        ]);
        expect(m.callAlliancePeer.mock.calls[0][2].body).toMatchObject({ shipText: undefined, isReady: true });
        route({ mirrors: () => ({ data: [{ id: 'm1' }] }), participation: () => ({ data: null }) });
        await expect(pushLocalRsvpsForPeer(PEER)).resolves.toBeUndefined();
    });
});

// =============================================================================
describe('reconcileMirrorsWithPeer', () => {
    /** Mirror table state + a host that answers per-op pulls from a version map. */
    function host(local: Array<Record<string, unknown>>, manifest: unknown, hostVersions: Record<string, number> = {}, opts: { existingOwner?: string; upsertErr?: boolean; staleRow?: unknown } = {}) {
        route({
            mirrors: (q) => {
                if (q.op === 'select' && q.columns === 'id, version, accepted, revoked_at') return { data: local };
                if (q.op === 'select' && q.columns === 'host_peer_id') return { data: opts.existingOwner ? { host_peer_id: opts.existingOwner } : null };
                if (q.op === 'select' && q.columns === 'version') return (opts.staleRow as never) ?? { data: { version: 1 } };
                if (q.op === 'upsert' && opts.upsertErr) return { error: { message: 'x' } };
                return { error: null };
            },
        });
        m.callAlliancePeer.mockImplementation(async (_p: string, path: string) => {
            if (path === '/api/alliance/op-manifest') return res(200, manifest);
            const id = path.split('/').pop()!.split('?')[0];
            if (!(id in hostVersions)) return res(404);
            return res(200, { v: 1, op_id: id, version: hostVersions[id], snapshot: { name: id } });
        });
    }
    const pulledPaths = () => m.callAlliancePeer.mock.calls.map((c) => c[1] as string).filter((p) => p !== '/api/alliance/op-manifest');

    it('no channel / no Active peer → peer not up; a rejected or malformed manifest → up but no information', async () => {
        route({ peerChannels: { data: null } });
        expect(await reconcileMirrorsWithPeer(PEER)).toEqual({ ok: false, peerUp: false, pulled: 0, revoked: 0, deferred: 0 });
        expect(m.callAlliancePeer).not.toHaveBeenCalled();
        route();
        m.callAlliancePeer.mockResolvedValueOnce(null);
        expect((await reconcileMirrorsWithPeer(PEER)).peerUp).toBe(false);
        m.callAlliancePeer.mockResolvedValueOnce(res(500));
        expect(await reconcileMirrorsWithPeer(PEER)).toMatchObject({ ok: false, peerUp: true });
        for (const bad of [null, { v: 2, accepted: {}, invited: [] }, { v: 1, accepted: null, invited: [] }, { v: 1, accepted: 'x', invited: [] }, { v: 1, accepted: {}, invited: 'x' }]) {
            m.callAlliancePeer.mockResolvedValueOnce(res(200, bad));
            expect(await reconcileMirrorsWithPeer(PEER)).toMatchObject({ ok: false, peerUp: true });
        }
        m.callAlliancePeer.mockResolvedValueOnce(res(200, null, true));
        expect(await reconcileMirrorsWithPeer(PEER)).toMatchObject({ ok: false, peerUp: true });
        expect(fake.find('mirrored_operations')).toHaveLength(0);
    });

    it('heals a missed invite+accept as a PENDING invite (the host may not set accepted)', async () => {
        host([], { v: 1, accepted: { 'op-x': 3 }, invited: ['op-i'] }, { 'op-x': 3, 'op-i': 1 });
        const out = await reconcileMirrorsWithPeer(PEER);
        expect(out).toMatchObject({ ok: true, peerUp: true, pulled: 2, revoked: 0, deferred: 0 });
        expect(pulledPaths()).toEqual(['/api/alliance/op/op-x', '/api/alliance/op/op-i']);
        const ups = fake.find('mirrored_operations', 'upsert').map((q) => q.payload as Record<string, unknown>);
        expect(ups).toHaveLength(2);
        for (const u of ups) expect(u).toMatchObject({ host_peer_id: PEER, accepted: false, accepted_at: null, revoked_at: null });
        expect(emits()).toEqual([{ operationId: 'op-x' }, { operationId: 'op-i' }]);
    });

    it('refuses to heal over a mirror owned by a different host, and contains a heal write failure', async () => {
        host([], { v: 1, accepted: { 'op-x': 3 }, invited: [] }, { 'op-x': 3 }, { existingOwner: 'peer-B' });
        expect((await reconcileMirrorsWithPeer(PEER)).pulled).toBe(0);
        expect(fake.find('mirrored_operations', 'upsert')).toHaveLength(0);
        host([], { v: 1, accepted: { 'op-x': 3 }, invited: [] }, { 'op-x': 3 }, { upsertErr: true });
        expect(await reconcileMirrorsWithPeer(PEER)).toMatchObject({ ok: true, pulled: 0 });
    });

    it('stale: delta pull, version-gated apply; resurrect / lost-accept / reinvite each take their own write', async () => {
        host([
            { id: 'stale', version: 1, accepted: true, revoked_at: null },
            { id: 'res', version: 9, accepted: true, revoked_at: 'r' },
            { id: 'lost', version: 2, accepted: false, revoked_at: null },
            { id: 'reinv', version: 2, accepted: false, revoked_at: 'r' },
            { id: 'same', version: 4, accepted: true, revoked_at: null },
        ], { v: 1, accepted: { stale: 2, res: 1, lost: 2, same: 4, junk: 'x' }, invited: ['reinv', '', 7, 'lost'] }, { stale: 2, res: 1, lost: 2, reinv: 3 });
        const out = await reconcileMirrorsWithPeer(PEER);
        expect(out).toMatchObject({ ok: true, pulled: 4, revoked: 0 });
        expect(pulledPaths()).toEqual(['/api/alliance/op/stale?since=1', '/api/alliance/op/res', '/api/alliance/op/lost', '/api/alliance/op/reinv']);
        const updates = fake.find('mirrored_operations', 'update');
        const byId = (id: string) => updates.find((q) => hasCall(q, 'eq', 'id', id))!.payload as Record<string, unknown>;
        expect(byId('stale')).toMatchObject({ version: 2 });
        expect(byId('res')).toMatchObject({ version: 1, revoked_at: null });
        expect('accepted' in byId('res')).toBe(false); // the local decision is left alone
        expect(byId('reinv')).toMatchObject({ accepted: false, accepted_at: null, revoked_at: null, version: 3 });
        expect(fake.find('mirrored_operations', 'upsert')[0].payload).toMatchObject({ id: 'lost', accepted: false });
        for (const u of updates) expect(hasCall(u, 'eq', 'host_peer_id', PEER)).toBe(true);
    });

    it('stale apply is skipped when the local row vanished or is already as new', async () => {
        host([{ id: 'stale', version: 1, accepted: true, revoked_at: null }], { v: 1, accepted: { stale: 2 }, invited: [] }, { stale: 2 }, { staleRow: { data: null } });
        expect((await reconcileMirrorsWithPeer(PEER)).pulled).toBe(0);
        host([{ id: 'stale', version: 1, accepted: true, revoked_at: null }], { v: 1, accepted: { stale: 2 }, invited: [] }, { stale: 2 }, { staleRow: { data: { version: 5 } } });
        expect((await reconcileMirrorsWithPeer(PEER)).pulled).toBe(0);
        expect(fake.find('mirrored_operations', 'update')).toHaveLength(0);
    });

    it('a host version regression is healed with an operator alert', async () => {
        host([{ id: 'r', version: 9, accepted: true, revoked_at: null }], { v: 1, accepted: { r: 2 }, invited: [] }, { r: 2 });
        const out = await reconcileMirrorsWithPeer(PEER);
        expect(out.pulled).toBe(1);
        expect(out.alert).toContain('restored from a backup');
        expect(pulledPaths()).toEqual(['/api/alliance/op/r']); // full pull, never ?since
        expect(fake.find('mirrored_operations', 'update')[0].payload).toMatchObject({ version: 2 });
    });

    it('skips pulls the host answers unchanged / not-ok / mismatched, and contains a thrown pull', async () => {
        host([{ id: 'a', version: 1, accepted: true, revoked_at: null }, { id: 'b', version: 1, accepted: true, revoked_at: null }, { id: 'c', version: 1, accepted: true, revoked_at: null }, { id: 'd', version: 1, accepted: true, revoked_at: null }],
            { v: 1, accepted: { a: 2, b: 2, c: 2, d: 2 }, invited: [] }, {});
        m.callAlliancePeer.mockImplementation(async (_p: string, path: string) => {
            if (path === '/api/alliance/op-manifest') return res(200, { v: 1, accepted: { a: 2, b: 2, c: 2, d: 2 }, invited: [] });
            if (path.includes('/a')) return res(200, { unchanged: true });
            if (path.includes('/b')) return res(200, { v: 1, op_id: 'other', version: 2, snapshot: null });
            if (path.includes('/c')) return null;
            throw new Error('reset');
        });
        expect(await reconcileMirrorsWithPeer(PEER)).toMatchObject({ ok: true, pulled: 0, deferred: 0 });
    });

    it('caps pulls at 5 per cycle and defers on an empty budget', async () => {
        const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
        host([], { v: 1, accepted: Object.fromEntries(ids.map((i) => [i, 1])), invited: [] }, Object.fromEntries(ids.map((i) => [i, 1])));
        expect(await reconcileMirrorsWithPeer(PEER)).toMatchObject({ pulled: 5, deferred: 2 });
        m.tryConsumeToken.mockReturnValue(false);
        host([], { v: 1, accepted: { p1: 1 }, invited: [] }, { p1: 1 });
        expect(await reconcileMirrorsWithPeer(PEER)).toMatchObject({ pulled: 0, deferred: 1 });
    });

    it('revokes a mirror only after TWO consecutive absent manifests (streak resets on reappearance)', async () => {
        const local = [{ id: 'keep1', version: 1, accepted: true, revoked_at: null }, { id: 'keep2', version: 1, accepted: true, revoked_at: null }, { id: 'gone', version: 1, accepted: true, revoked_at: null }];
        host(local, { v: 1, accepted: { keep1: 1, keep2: 1 }, invited: [] });
        expect((await reconcileMirrorsWithPeer(PEER)).revoked).toBe(0);
        // Reappears → streak reset.
        host(local, { v: 1, accepted: { keep1: 1, keep2: 1, gone: 1 }, invited: [] });
        expect((await reconcileMirrorsWithPeer(PEER)).revoked).toBe(0);
        host(local, { v: 1, accepted: { keep1: 1, keep2: 1 }, invited: [] });
        expect((await reconcileMirrorsWithPeer(PEER)).revoked).toBe(0);
        host(local, { v: 1, accepted: { keep1: 1, keep2: 1 }, invited: [] });
        expect((await reconcileMirrorsWithPeer(PEER)).revoked).toBe(1);
        const rv = fake.find('mirrored_operations', 'update')[0];
        expect(Object.keys(rv.payload as object)).toEqual(['revoked_at']);
        expect(hasCall(rv, 'eq', 'id', 'gone')).toBe(true);
        expect(hasCall(rv, 'eq', 'host_peer_id', PEER)).toBe(true);
        expect(emits()).toEqual([{ operationId: 'gone' }]);
    });

    it('holds ALL revokes during a mass shrink for two manifests, then processes normally', async () => {
        const local = [{ id: 'a', version: 1, accepted: true, revoked_at: null }, { id: 'b', version: 1, accepted: true, revoked_at: null }, { id: 'c', version: 1, accepted: true, revoked_at: 'x' }];
        const empty = { v: 1, accepted: {}, invited: [] };
        host(local, empty);
        let out = await reconcileMirrorsWithPeer(PEER);
        expect(out).toMatchObject({ ok: true, revoked: 0 });
        expect(out.alert).toBe('Peer manifest dropped 2 of 2 mirrored operations — holding revokes (anomaly guard).');
        host(local, empty);
        expect((await reconcileMirrorsWithPeer(PEER)).alert).toContain('anomaly guard');
        host(local, empty); // 3rd: real — per-op streak 1
        out = await reconcileMirrorsWithPeer(PEER);
        expect(out).toMatchObject({ revoked: 0, alert: undefined });
        host(local, empty); // 4th: per-op streak 2 → revoke both live mirrors
        expect((await reconcileMirrorsWithPeer(PEER)).revoked).toBe(2);
    });

    it('tolerates a null mirror table read', async () => {
        route({ mirrors: () => ({ data: null }) });
        m.callAlliancePeer.mockResolvedValue(res(200, { v: 1, accepted: {}, invited: [] }));
        expect(await reconcileMirrorsWithPeer(PEER)).toEqual({ ok: true, peerUp: true, pulled: 0, revoked: 0, deferred: 0, alert: undefined });
    });
});
