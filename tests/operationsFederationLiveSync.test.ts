import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Live-sync tests for the joint-op federation surface:
//   - the manifest endpoint's peer scoping
//   - the invited-not-accepted snapshot posture (matches today's invite push)
//   - RSVP removal scoped to the CALLING peer's own rows
//   - inbound pushes stay strictly version-gated — a malicious peer can NEVER
//     roll a mirror back by replaying a stale/lower version
//   - push gating: down-peer drop, budget deferral, immediate-event override,
//     debounce coalescing
//   - the guest reconcile loop: missed-invite/accept healing, stale pulls,
//     version-regression heal (alert raised; only reachable from reconcile),
//     and the FALSE-REVOKE guard (malformed/empty manifests revoke nothing;
//     absence needs 2 consecutive well-formed manifests; mass-shrink holds).

const h = vi.hoisted(() => ({
    orgEmits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    mutations: [] as Array<{ table: string; op: string; values: Record<string, unknown> | null; filters: Record<string, unknown> }>,
    peerCalls: [] as Array<{ peerId: string; path: string; body?: unknown }>,
    // path-prefix → responder; configured per test.
    respond: null as null | ((peerId: string, path: string) => unknown),
    // Federation clearance ceiling inputs.
    opClearance: 0,
    globalMax: 5,
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = {
            op: 'select' as string,
            values: null as Record<string, unknown> | null,
            filters: {} as Record<string, unknown>,
            ins: {} as Record<string, unknown[]>,
            selectStr: '' as string,
        };
        const rows = () => (h.tables[table] ?? []).filter((r) => {
            for (const [col, val] of Object.entries(state.filters)) {
                if (col.startsWith('is:')) { if (r[col.slice(3)] != null) return false; }
                else if (r[col] !== val) return false;
            }
            for (const [col, vals] of Object.entries(state.ins)) {
                if (!vals.includes(r[col])) return false;
            }
            return true;
        });
        const withEmbeds = (r: Record<string, unknown>) => {
            if (table === 'operation_allied_orgs' && state.selectStr.includes('operation:operations')) {
                const op = (h.tables['operations'] ?? []).find((o) => o.id === r.operation_id) ?? null;
                return { ...r, operation: op ? { joint_version: op.joint_version } : null };
            }
            return r;
        };
        const b: any = {};
        b.select = (s?: string) => { state.selectStr = s ?? ''; return b; };
        b.update = (values: Record<string, unknown>) => { state.op = 'update'; state.values = values; return b; };
        b.upsert = (values: Record<string, unknown>) => { state.op = 'upsert'; state.values = values; return b; };
        b.insert = (values: Record<string, unknown>) => { state.op = 'insert'; state.values = values; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = (col: string, val: unknown) => { state.filters[col] = val; return b; };
        b.is = (col: string, _v: unknown) => { state.filters[`is:${col}`] = null; return b; };
        b.in = (col: string, vals: unknown[]) => { state.ins[col] = vals; return b; };
        b.order = () => b; b.limit = () => b; b.not = () => b;
        const settle = (mode: 'many' | 'single') => {
            if (state.op === 'select') {
                const data = rows().map(withEmbeds);
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            h.mutations.push({ table, op: state.op, values: state.values, filters: { ...state.filters, ...Object.fromEntries(Object.entries(state.ins).map(([k, v]) => [`in:${k}`, v])) } });
            const list = (h.tables[table] = h.tables[table] ?? []);
            if (state.op === 'update') {
                for (const r of rows()) Object.assign(r, state.values);
            } else if (state.op === 'upsert') {
                const v = state.values!;
                const key = table === 'alliance_peer_directory_cache' ? 'peer_id' : 'id';
                const existing = list.find((r) => r[key] === v[key]);
                if (existing) Object.assign(existing, v); else list.push({ ...v });
            } else if (state.op === 'insert') {
                list.push({ ...(state.values as Record<string, unknown>) });
            } else if (state.op === 'delete') {
                const doomed = new Set(rows());
                h.tables[table] = list.filter((r) => !doomed.has(r));
            }
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

vi.mock('../lib/db/ops', () => ({
    // Minimal hydrated op for buildOperationSnapshot; the projection itself is
    // pinned in tests/operations-federation.projection.test.ts.
    getFullOperationDetails: async (id: string) => ({ id, name: 'Op', clearanceLevel: h.opClearance, participants: [], tasks: [], commandNodes: [], logistics: [], commsPlan: [], limitingMarkers: [] }),
}));

// operations-federation imports getMaxShareableClearance from ./system for the
// egress ceiling — mock it deterministically (default high so the existing
// snapshot/manifest tests, which use an unclassified op, are unaffected).
vi.mock('../lib/db/system', () => ({ getMaxShareableClearance: async () => h.globalMax }));

vi.mock('../lib/db/mappers', () => ({
    toMirroredOperation: (r: Record<string, unknown>) => r,
}));

vi.mock('../lib/db/alliances', () => ({
    callAlliancePeer: async (peerId: string, path: string, init?: { body?: unknown }) => {
        h.peerCalls.push({ peerId, path, body: init?.body });
        const out = h.respond ? h.respond(peerId, path) : null;
        if (out instanceof Error) throw out;
        if (out === null || out === undefined) return null;
        const { status = 200, json = {} } = out as { status?: number; json?: unknown };
        return { ok: status >= 200 && status < 300, status, json: async () => json } as Response;
    },
}));

import {
    getOperationSnapshotForPeer, getOperationManifestForPeer,
    removeAlliedParticipant, receiveMirrorPush, receiveMirrorInvite,
    pushOperationToAllies, scheduleAlliedPush, reconcilePeerClearanceShares,
    reconcileMirrorsWithPeer, __resetReconcileStateForTests,
} from '../lib/db/operations-federation';
import { __resetAllianceSyncStateForTests, tryConsumeToken, ALLIANCE_SYNC_DEFAULTS } from '../lib/db/allianceSyncState';

beforeEach(() => {
    h.orgEmits = [];
    h.mutations = [];
    h.peerCalls = [];
    h.respond = null;
    h.tables = {};
    h.opClearance = 0;
    h.globalMax = 5;
    // The guest ingest + reconcile paths now require the operations channel to be
    // enabled for the peer (the gate that blocks mirror-squat). Seed the peers these
    // tests use as Active + ops-enabled. Host-push tests overwrite this with their own
    // rows (the push path doesn't consult this gate).
    h.tables.alliance_peers = ['peerA', 'peerB', 'attacker', 'victimHost', 'hostA', 'otherHost']
        .map((id) => ({ id, status: 'Active', channels: { operations: true } }));
    __resetReconcileStateForTests();
    __resetAllianceSyncStateForTests();
});
afterEach(() => { vi.useRealTimers(); });

const drainBucket = (peerId: string) => {
    for (let i = 0; i < ALLIANCE_SYNC_DEFAULTS.outboundBudgetPerMin + 1; i++) tryConsumeToken(peerId);
};

// --- HOST surface ---

describe('getOperationSnapshotForPeer posture (invite row, not acceptance)', () => {
    it('non-invited peer stays forbidden', async () => {
        h.tables.operation_allied_orgs = [];
        await expect(getOperationSnapshotForPeer('op1', 'peerA')).rejects.toThrow('forbidden');
    });
    it('invited-but-not-accepted peer is served the snapshot (same posture as the invite push)', async () => {
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: false }];
        h.tables.operations = [{ id: 'op1', joint_version: 4 }];
        h.tables.operation_limiting_markers = [];
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Active', channels: { operations: true } }]; // serve-time channel gate
        const res = await getOperationSnapshotForPeer('op1', 'peerA');
        expect('unchanged' in res).toBe(false);
        if (!('unchanged' in res)) {
            expect(res.version).toBe(4);
            expect(res.snapshot).toBeTruthy();
        }
    });
    it('?since at or above the current version answers unchanged', async () => {
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        h.tables.operations = [{ id: 'op1', joint_version: 4 }];
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Active', channels: { operations: true } }]; // serve-time channel gate
        const res = await getOperationSnapshotForPeer('op1', 'peerA', 4);
        expect(res).toEqual({ unchanged: true });
    });
});

describe('getOperationManifestForPeer (SECURITY: per-peer scoping, L6)', () => {
    it('contains ONLY the calling peer\'s ops — accepted with versions, invited as ids', async () => {
        h.tables.operation_allied_orgs = [
            { operation_id: 'op1', peer_id: 'peerA', accepted: true },
            { operation_id: 'op2', peer_id: 'peerA', accepted: false },
            { operation_id: 'op3', peer_id: 'peerB', accepted: true }, // other peer — must NOT appear
        ];
        h.tables.operations = [
            { id: 'op1', joint_version: 7 },
            { id: 'op2', joint_version: 2 },
            { id: 'op3', joint_version: 9 },
        ];
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Active', channels: { operations: true } }]; // serve-time channel gate
        const m = await getOperationManifestForPeer('peerA');
        expect(m.v).toBe(1);
        expect(m.accepted).toEqual({ op1: 7 });
        expect(m.invited).toEqual(['op2']);
        expect(JSON.stringify(m)).not.toContain('op3');
        expect(typeof m.fetchedAt).toBe('string');
    });
    it('drops rows whose operation vanished mid-query', async () => {
        h.tables.operation_allied_orgs = [{ operation_id: 'gone', peer_id: 'peerA', accepted: true }];
        h.tables.operations = [];
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Active', channels: { operations: true } }]; // serve-time channel gate
        const m = await getOperationManifestForPeer('peerA');
        expect(m.accepted).toEqual({});
        expect(m.invited).toEqual([]);
    });
});

describe('removeAlliedParticipant (SECURITY: delete scoped to the caller)', () => {
    it('requires the accepted ally gate', async () => {
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: false }];
        await expect(removeAlliedParticipant('op1', 'peerA', 'someone')).rejects.toThrow('forbidden');
    });
    it('rejects a missing handle', async () => {
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        await expect(removeAlliedParticipant('op1', 'peerA', '')).rejects.toThrow('malformed_request');
    });
    it('deletes only the (op, CALLING peer, handle) row — peer A cannot delete peer B\'s rows', async () => {
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        h.tables.operations = [{ id: 'op1', joint_version: 1, is_joint: true }];
        h.tables.operation_allied_participants = [
            { operation_id: 'op1', peer_id: 'peerA', remote_user_handle: 'jenk' },
            { operation_id: 'op1', peer_id: 'peerB', remote_user_handle: 'jenk' },
        ];
        await removeAlliedParticipant('op1', 'peerA', 'jenk');
        const del = h.mutations.find(m => m.table === 'operation_allied_participants' && m.op === 'delete');
        expect(del).toBeTruthy();
        expect(del!.filters).toMatchObject({ operation_id: 'op1', peer_id: 'peerA', remote_user_handle: 'jenk' });
        // Peer B's identical-handle row survives.
        expect(h.tables.operation_allied_participants).toEqual([
            { operation_id: 'op1', peer_id: 'peerB', remote_user_handle: 'jenk' },
        ]);
    });
});

// --- Inbound pushes stay version-gated (the regression override is NOT here) ---

describe('receiveMirrorInvite cross-peer clobber guard (VULN-1 regression)', () => {
    it('a DIFFERENT peer cannot clobber a victim-hosted mirror (host_peer_id / snapshot / accepted unchanged)', async () => {
        h.tables.mirrored_operations = [{
            id: 'op1', host_peer_id: 'victimHost', version: 5, accepted: true, revoked_at: null,
            snapshot: { name: 'real op' },
        }];
        // Attacker (peerB) tries to hijack op1 with forged content + version pin.
        await receiveMirrorInvite({ id: 'attacker' }, { v: 1, op_id: 'op1', version: 999999, snapshot: { name: 'forged' } as never });
        const row = h.tables.mirrored_operations.find(m => m.id === 'op1')!;
        expect(row.host_peer_id).toBe('victimHost');           // NOT redirected to attacker
        expect((row.snapshot as { name: string }).name).toBe('real op'); // NOT spoofed
        expect(row.accepted).toBe(true);                       // NOT reset to false (no DoS)
        expect(row.version).toBe(5);
    });
    it('the legitimate owning host can still update its own invite', async () => {
        h.tables.mirrored_operations = [{ id: 'op1', host_peer_id: 'victimHost', version: 5, accepted: true, revoked_at: null, snapshot: { name: 'old' } }];
        await receiveMirrorInvite({ id: 'victimHost' }, { v: 1, op_id: 'op1', version: 6, snapshot: { name: 'new' } as never });
        const row = h.tables.mirrored_operations.find(m => m.id === 'op1')!;
        expect(row.host_peer_id).toBe('victimHost');
        expect(row.accepted).toBe(false); // invite re-issue resets to pending (by design)
    });
    it('a brand-new invite (no existing row) is stored as pending', async () => {
        h.tables.mirrored_operations = [];
        await receiveMirrorInvite({ id: 'hostA' }, { v: 1, op_id: 'newop', version: 1, snapshot: { name: 'x' } as never });
        expect(h.tables.mirrored_operations.find(m => m.id === 'newop')).toMatchObject({ host_peer_id: 'hostA', accepted: false });
    });
    it('rejects an oversized inbound snapshot (storage-amplification guard, VULN-2)', async () => {
        h.tables.mirrored_operations = [];
        const huge = { blob: 'x'.repeat(1_000_001) } as never;
        await expect(receiveMirrorInvite({ id: 'hostA' }, { v: 1, op_id: 'op1', version: 1, snapshot: huge })).rejects.toThrow('malformed_request');
        expect(h.tables.mirrored_operations).toHaveLength(0);
    });
});

describe('mirror ingest requires the operations channel', () => {
    it('receiveMirrorInvite from a peer without the ops channel creates NO mirror (squat blocked)', async () => {
        h.tables.alliance_peers = [{ id: 'noops', status: 'Active', channels: {} }];
        h.tables.mirrored_operations = [];
        await receiveMirrorInvite({ id: 'noops' }, { v: 1, op_id: 'opX', version: 1, snapshot: { name: 'squat' } as never });
        expect(h.tables.mirrored_operations).toHaveLength(0);
    });
    it('receiveMirrorPush from a peer without the ops channel is ignored', async () => {
        h.tables.alliance_peers = [{ id: 'noops', status: 'Active', channels: {} }];
        h.tables.mirrored_operations = [{ id: 'opX', host_peer_id: 'noops', version: 1, snapshot: { name: 'old' } }];
        await receiveMirrorPush({ id: 'noops' }, { v: 1, op_id: 'opX', version: 2, event: 'full', snapshot: { name: 'new' } as never });
        expect(h.tables.mirrored_operations[0].version).toBe(1); // unchanged
    });
    it('reconcileMirrorsWithPeer skips a peer without the ops channel (no manifest call)', async () => {
        h.tables.alliance_peers = [{ id: 'noops', status: 'Active', channels: {} }];
        h.respond = () => manifest({ opX: 1 });
        const r = await reconcileMirrorsWithPeer('noops');
        expect(r.peerUp).toBe(false);
        expect(h.peerCalls).toHaveLength(0); // never reached the manifest fetch
    });
});

describe('receiveMirrorPush replay safety', () => {
    it('a stale/lower version from a push NEVER rolls the mirror back', async () => {
        h.tables.mirrored_operations = [{ id: 'op1', host_peer_id: 'peerA', version: 10, snapshot: { name: 'current' } }];
        await receiveMirrorPush({ id: 'peerA' }, { v: 1, op_id: 'op1', version: 5, event: 'full', snapshot: { name: 'rollback' } as never });
        expect(h.tables.mirrored_operations[0].version).toBe(10);
        expect((h.tables.mirrored_operations[0].snapshot as { name: string }).name).toBe('current');
        expect(h.mutations.filter(m => m.table === 'mirrored_operations' && m.op === 'update')).toHaveLength(0);
    });
    it('ignores pushes for ops hosted by a DIFFERENT peer', async () => {
        h.tables.mirrored_operations = [{ id: 'op1', host_peer_id: 'peerA', version: 1 }];
        await receiveMirrorPush({ id: 'peerB' }, { v: 1, op_id: 'op1', version: 99, snapshot: null });
        expect(h.tables.mirrored_operations[0].version).toBe(1);
    });
});

// --- Push gating + debounce ---

describe('pushOperationToAllies live-sync gating', () => {
    const seedJointOp = () => {
        h.tables.operation_allied_orgs = [
            { operation_id: 'op1', peer_id: 'peerA', accepted: true },
            { operation_id: 'op1', peer_id: 'peerB', accepted: true },
        ];
        h.tables.operations = [{ id: 'op1', joint_version: 3 }];
        h.tables.alliance_peers = [
            { id: 'peerA', sync_health: 'healthy' },
            { id: 'peerB', sync_health: 'down' },
        ];
    };
    it('drops pushes to down peers (reconcile converges on recovery) but pushes to healthy ones', async () => {
        seedJointOp();
        h.respond = () => ({ status: 200, json: { ok: true } });
        await pushOperationToAllies('op1', 'full');
        expect(h.peerCalls.map(c => c.peerId)).toEqual(['peerA']);
        expect(h.peerCalls[0].path).toBe('/api/alliance/op-mirror/push');
        expect((h.peerCalls[0].body as { event: string }).event).toBe('full');
    });
    it('budget-starved FULL pushes defer (re-coalesce) instead of dropping silently', async () => {
        vi.useFakeTimers();
        seedJointOp();
        h.tables.alliance_peers = [{ id: 'peerA', sync_health: 'healthy' }];
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        drainBucket('peerA');
        h.respond = () => ({ status: 200, json: { ok: true } });
        await pushOperationToAllies('op1', 'full');
        expect(h.peerCalls).toHaveLength(0); // deferred, not sent
        // The bucket refills with time; the re-scheduled flush then delivers.
        await vi.advanceTimersByTimeAsync(11_000);
        expect(h.peerCalls.length).toBeGreaterThan(0);
    });
    it('immediate events are never blocked by an empty bucket', async () => {
        seedJointOp();
        h.tables.alliance_peers = [{ id: 'peerA', sync_health: 'healthy' }];
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        drainBucket('peerA');
        h.respond = () => ({ status: 200, json: { ok: true } });
        await pushOperationToAllies('op1', 'status_change');
        expect(h.peerCalls).toHaveLength(1);
    });
    it('no accepted allies → no peer lookups, no calls', async () => {
        h.tables.operation_allied_orgs = [];
        await pushOperationToAllies('op1', 'full');
        expect(h.peerCalls).toHaveLength(0);
    });
});

describe('pushOperationToAllies clearance ceiling', () => {
    const seedPeers = (peers: Array<{ id: string; outbound_max_clearance: number }>) => {
        h.tables.operation_allied_orgs = peers.map((p) => ({ operation_id: 'op1', peer_id: p.id, accepted: true }));
        h.tables.operations = [{ id: 'op1', joint_version: 3 }];
        h.tables.alliance_peers = peers.map((p) => ({ id: p.id, sync_health: 'healthy', outbound_max_clearance: p.outbound_max_clearance }));
        h.tables.operation_limiting_markers = [];
        h.respond = () => ({ status: 200, json: { ok: true } });
    };
    const snapshotFor = (peerId: string) => {
        const call = h.peerCalls.find((c) => c.peerId === peerId && c.path === '/api/alliance/op-mirror/push');
        return (call?.body as { snapshot: unknown } | undefined)?.snapshot;
    };

    it('pushes a NULL snapshot to a peer below the op clearance (no content leak)', async () => {
        h.opClearance = 5; h.globalMax = 5;
        seedPeers([{ id: 'peerLow', outbound_max_clearance: 0 }]); // min(5,0)=0, 5>0
        await pushOperationToAllies('op1', 'full');
        expect(h.peerCalls).toHaveLength(1);
        expect(snapshotFor('peerLow')).toBeNull();
    });

    it('pushes the projected snapshot to a peer at/above the op clearance', async () => {
        h.opClearance = 2; h.globalMax = 5;
        seedPeers([{ id: 'peerHi', outbound_max_clearance: 5 }]); // min(5,5)=5, 2<=5
        await pushOperationToAllies('op1', 'full');
        expect(snapshotFor('peerHi')).toBeTruthy();
        expect((snapshotFor('peerHi') as { id: string }).id).toBe('op1');
    });

    it('enforces the ORG-WIDE ceiling even when the peer ceiling is higher', async () => {
        h.opClearance = 3; h.globalMax = 2;
        seedPeers([{ id: 'peerHi', outbound_max_clearance: 5 }]); // min(2,5)=2, 3>2
        await pushOperationToAllies('op1', 'full');
        expect(snapshotFor('peerHi')).toBeNull();
    });

    it('scopes per peer in ONE push: over-ceiling peer gets null, cleared peer gets content', async () => {
        h.opClearance = 3; h.globalMax = 5;
        seedPeers([
            { id: 'peerLow', outbound_max_clearance: 0 }, // min(5,0)=0, 3>0 → null
            { id: 'peerHi', outbound_max_clearance: 5 },  // min(5,5)=5, 3<=5 → content
        ]);
        await pushOperationToAllies('op1', 'full');
        expect(snapshotFor('peerLow')).toBeNull();
        expect(snapshotFor('peerHi')).toBeTruthy();
    });

    it('the ceiling also applies to immediate events (status_change/alert)', async () => {
        h.opClearance = 5; h.globalMax = 5;
        seedPeers([{ id: 'peerLow', outbound_max_clearance: 0 }]);
        await pushOperationToAllies('op1', 'status_change');
        expect(snapshotFor('peerLow')).toBeNull();
    });

    it('an unclassified op still pushes content to a ceiling-0 peer', async () => {
        h.opClearance = 0; h.globalMax = 5;
        seedPeers([{ id: 'peerLow', outbound_max_clearance: 0 }]); // min(5,0)=0, 0<=0
        await pushOperationToAllies('op1', 'full');
        expect(snapshotFor('peerLow')).toBeTruthy();
    });
});

describe('reconcilePeerClearanceShares', () => {
    it('revokes a share whose op now exceeds the (lowered) peer ceiling', async () => {
        h.opClearance = 5; h.globalMax = 5;
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        h.tables.operations = [{ id: 'op1', joint_version: 3 }];
        h.tables.alliance_peers = [{ id: 'peerA', outbound_max_clearance: 0 }]; // min(5,0)=0, op 5 → over
        h.tables.operation_limiting_markers = [];
        h.respond = () => ({ status: 200, json: { ok: true } });
        await reconcilePeerClearanceShares('peerA');
        expect(h.peerCalls.some((c) => c.path === '/api/alliance/op-mirror/revoke')).toBe(true);
        expect(h.tables.operation_allied_orgs).toHaveLength(0); // share clawed back
    });
    it('leaves a share still within the ceiling untouched', async () => {
        h.opClearance = 0; h.globalMax = 5;
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        h.tables.operations = [{ id: 'op1', joint_version: 3 }];
        h.tables.alliance_peers = [{ id: 'peerA', outbound_max_clearance: 0 }]; // op 0 <= 0 → ok
        h.tables.operation_limiting_markers = [];
        h.respond = () => ({ status: 200, json: { ok: true } });
        await reconcilePeerClearanceShares('peerA');
        expect(h.peerCalls.some((c) => c.path === '/api/alliance/op-mirror/revoke')).toBe(false);
        expect(h.tables.operation_allied_orgs).toHaveLength(1);
    });
});

describe('scheduleAlliedPush coalescing', () => {
    it('N rapid mutations coalesce into ONE full push', async () => {
        vi.useFakeTimers();
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        h.tables.operations = [{ id: 'op1', joint_version: 3 }];
        h.tables.alliance_peers = [{ id: 'peerA', sync_health: 'healthy' }];
        h.respond = () => ({ status: 200, json: { ok: true } });
        scheduleAlliedPush('op1');
        scheduleAlliedPush('op1');
        scheduleAlliedPush('op1');
        await vi.advanceTimersByTimeAsync(ALLIANCE_SYNC_DEFAULTS.pushDebounceMs + 500);
        expect(h.peerCalls.filter(c => c.path === '/api/alliance/op-mirror/push')).toHaveLength(1);
    });
    it('an immediate push supersedes (cancels) the pending coalesced one', async () => {
        vi.useFakeTimers();
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        h.tables.operations = [{ id: 'op1', joint_version: 3 }];
        h.tables.alliance_peers = [{ id: 'peerA', sync_health: 'healthy' }];
        h.respond = () => ({ status: 200, json: { ok: true } });
        scheduleAlliedPush('op1');
        await pushOperationToAllies('op1', 'status_change');
        await vi.advanceTimersByTimeAsync(ALLIANCE_SYNC_DEFAULTS.pushDebounceMs + 500);
        expect(h.peerCalls).toHaveLength(1); // only the immediate
        expect((h.peerCalls[0].body as { event: string }).event).toBe('status_change');
    });
});

// --- GUEST reconcile loop ---

const manifest = (accepted: Record<string, number>, invited: string[] = []) =>
    ({ status: 200, json: { v: 1, fetchedAt: new Date().toISOString(), accepted, invited } });

describe('reconcileMirrorsWithPeer — healing', () => {
    it('heals a missed invite+accept: creates the accepted mirror from the manifest', async () => {
        h.tables.mirrored_operations = [];
        h.respond = (_p, path) => {
            if (path === '/api/alliance/op-manifest') return manifest({ op1: 5 });
            if (path.startsWith('/api/alliance/op/op1')) return { status: 200, json: { v: 1, op_id: 'op1', version: 5, snapshot: { name: 'healed' } } };
            return null;
        };
        const r = await reconcileMirrorsWithPeer('peerA');
        expect(r.ok).toBe(true);
        expect(r.pulled).toBe(1);
        const mirror = h.tables.mirrored_operations.find(m => m.id === 'op1');
        expect(mirror).toMatchObject({ host_peer_id: 'peerA', version: 5, accepted: true, revoked_at: null });
        expect(h.orgEmits.some(e => e.event === 'operation_update' && (e.payload as { operationId: string }).operationId === 'op1')).toBe(true);
    });
    it('heals a missed invite: creates a PENDING mirror for admin review', async () => {
        h.tables.mirrored_operations = [];
        h.respond = (_p, path) => {
            if (path === '/api/alliance/op-manifest') return manifest({}, ['op2']);
            if (path.startsWith('/api/alliance/op/op2')) return { status: 200, json: { v: 1, op_id: 'op2', version: 1, snapshot: { name: 'invite' } } };
            return null;
        };
        await reconcileMirrorsWithPeer('peerA');
        expect(h.tables.mirrored_operations.find(m => m.id === 'op2')).toMatchObject({ accepted: false, revoked_at: null });
    });
    it('fed-sync-1: missing-* heal does NOT clobber a mirror owned by a DIFFERENT host', async () => {
        // A mirror legitimately held for otherHost. peerB serves a forged manifest
        // listing the same opId; reconcile sees no peerB-owned row for it and would
        // (pre-fix) upsert by the id-only PK, taking the row over. The ownership
        // guard must skip it: content/owner/version stay intact.
        h.tables.mirrored_operations = [{ id: 'op1', host_peer_id: 'otherHost', version: 7, accepted: true, revoked_at: null, snapshot: { name: 'legit' } }];
        h.respond = (_p, path) => {
            if (path === '/api/alliance/op-manifest') return manifest({ op1: 9 });
            if (path.startsWith('/api/alliance/op/op1')) return { status: 200, json: { v: 1, op_id: 'op1', version: 9, snapshot: { name: 'ATTACKER' } } };
            return null;
        };
        const r = await reconcileMirrorsWithPeer('peerB');
        const row = h.tables.mirrored_operations.find(m => m.id === 'op1')!;
        expect(row.host_peer_id).toBe('otherHost');
        expect((row.snapshot as { name: string }).name).toBe('legit');
        expect(row.version).toBe(7);
        expect(r.pulled).toBe(0);
    });
    it('stale mirrors pull with ?since= and apply version-gated', async () => {
        h.tables.mirrored_operations = [{ id: 'op1', host_peer_id: 'peerA', version: 3, accepted: true, revoked_at: null }];
        h.respond = (_p, path) => {
            if (path === '/api/alliance/op-manifest') return manifest({ op1: 8 });
            if (path === '/api/alliance/op/op1?since=3') return { status: 200, json: { v: 1, op_id: 'op1', version: 8, snapshot: { name: 'newer' } } };
            return null;
        };
        const r = await reconcileMirrorsWithPeer('peerA');
        expect(r.pulled).toBe(1);
        expect(h.peerCalls.some(c => c.path === '/api/alliance/op/op1?since=3')).toBe(true);
        expect(h.tables.mirrored_operations[0].version).toBe(8);
    });
    it('VERSION REGRESSION (host backup restore) heals via a FULL pull and raises the operator alert', async () => {
        h.tables.mirrored_operations = [{ id: 'op1', host_peer_id: 'peerA', version: 50, accepted: true, revoked_at: null, snapshot: { name: 'newer' } }];
        h.respond = (_p, path) => {
            if (path === '/api/alliance/op-manifest') return manifest({ op1: 12 });
            // MUST be the no-?since form — ?since=50 would answer {unchanged}
            // and the deadlock would persist forever.
            if (path === '/api/alliance/op/op1') return { status: 200, json: { v: 1, op_id: 'op1', version: 12, snapshot: { name: 'rolled-back-truth' } } };
            return null;
        };
        const r = await reconcileMirrorsWithPeer('peerA');
        expect(h.peerCalls.some(c => c.path === '/api/alliance/op/op1')).toBe(true);
        expect(h.peerCalls.some(c => c.path.includes('since='))).toBe(false);
        expect(h.tables.mirrored_operations[0].version).toBe(12);
        expect((h.tables.mirrored_operations[0].snapshot as { name: string }).name).toBe('rolled-back-truth');
        expect(r.alert).toMatch(/restored from a backup/i);
    });
    it('heals a LOST ACCEPT-ACK: host accepted, local still pending → latches accepted (BUG-1 regression)', async () => {
        // Guest accepted; host committed accepted=true but the HTTP ack was lost,
        // so the local mirror is stuck pending at the same version.
        h.tables.mirrored_operations = [{ id: 'op1', host_peer_id: 'peerA', version: 4, accepted: false, revoked_at: null, snapshot: { name: 'pending' } }];
        h.respond = (_p, path) => {
            if (path === '/api/alliance/op-manifest') return manifest({ op1: 4 }); // SAME version, host says accepted
            if (path.startsWith('/api/alliance/op/op1')) return { status: 200, json: { v: 1, op_id: 'op1', version: 4, snapshot: { name: 'confirmed' } } };
            return null;
        };
        const r = await reconcileMirrorsWithPeer('peerA');
        expect(r.pulled).toBe(1);
        expect(h.tables.mirrored_operations.find(m => m.id === 'op1')!.accepted).toBe(true);
    });
    it('resurrects a spuriously-revoked mirror the host still lists as accepted, at the SAME version', async () => {
        h.tables.mirrored_operations = [{ id: 'op1', host_peer_id: 'peerA', version: 7, accepted: true, revoked_at: new Date().toISOString(), snapshot: { name: 'stale' } }];
        h.respond = (_p, path) => {
            if (path === '/api/alliance/op-manifest') return manifest({ op1: 7 }); // same version, still accepted on host
            if (path.startsWith('/api/alliance/op/op1')) return { status: 200, json: { v: 1, op_id: 'op1', version: 7, snapshot: { name: 'alive' } } };
            return null;
        };
        await reconcileMirrorsWithPeer('peerA');
        const m = h.tables.mirrored_operations.find(x => x.id === 'op1')!;
        expect(m.revoked_at).toBeNull();
        expect(m.accepted).toBe(true);
    });
    it('caps pulls per cycle and reports the deferred remainder', async () => {
        h.tables.mirrored_operations = [];
        const accepted: Record<string, number> = {};
        for (let i = 0; i < 8; i++) accepted[`op${i}`] = 1;
        h.respond = (_p, path) => {
            if (path === '/api/alliance/op-manifest') return manifest(accepted);
            return { status: 200, json: { v: 1, op_id: path.split('/').pop(), version: 1, snapshot: null } };
        };
        const r = await reconcileMirrorsWithPeer('peerA');
        expect(r.pulled).toBe(5);
        expect(r.deferred).toBe(3);
    });
});

describe('reconcileMirrorsWithPeer — FALSE-REVOKE guard', () => {
    const twoMirrors = () => {
        h.tables.mirrored_operations = [
            { id: 'op1', host_peer_id: 'peerA', version: 1, accepted: true, revoked_at: null },
            { id: 'op2', host_peer_id: 'peerA', version: 1, accepted: true, revoked_at: null },
        ];
    };
    it('a failed/malformed manifest is "no information" — revokes NOTHING', async () => {
        twoMirrors();
        h.respond = () => ({ status: 500, json: {} });
        let r = await reconcileMirrorsWithPeer('peerA');
        expect(r.ok).toBe(false);
        h.respond = () => ({ status: 200, json: { junk: true } });
        r = await reconcileMirrorsWithPeer('peerA');
        expect(r.ok).toBe(false);
        expect(h.tables.mirrored_operations.every(m => m.revoked_at === null)).toBe(true);
    });
    it('an EMPTY manifest (mass shrink) holds ALL revokes and raises the anomaly alert', async () => {
        twoMirrors();
        h.respond = () => manifest({});
        const r = await reconcileMirrorsWithPeer('peerA');
        expect(r.revoked).toBe(0);
        expect(r.alert).toMatch(/holding revokes/i);
        expect(h.tables.mirrored_operations.every(m => m.revoked_at === null)).toBe(true);
        // Even a second empty manifest holds (mass-shrink needs 3 to be real).
        await reconcileMirrorsWithPeer('peerA');
        expect(h.tables.mirrored_operations.every(m => m.revoked_at === null)).toBe(true);
    });
    it('single-op absence revokes only after 2 consecutive well-formed manifests', async () => {
        twoMirrors();
        h.respond = () => manifest({ op1: 1 }); // op2 absent, op1 present (1 of 2 — not a mass shrink)
        let r = await reconcileMirrorsWithPeer('peerA');
        expect(r.revoked).toBe(0); // first sighting — streak 1
        expect(h.tables.mirrored_operations.find(m => m.id === 'op2')!.revoked_at).toBeNull();
        r = await reconcileMirrorsWithPeer('peerA');
        expect(r.revoked).toBe(1); // second consecutive — revoke
        expect(h.tables.mirrored_operations.find(m => m.id === 'op2')!.revoked_at).toBeTruthy();
        expect(h.tables.mirrored_operations.find(m => m.id === 'op1')!.revoked_at).toBeNull();
    });
    it('reappearing in the manifest resets the absence streak', async () => {
        twoMirrors();
        h.respond = () => manifest({ op1: 1 });
        await reconcileMirrorsWithPeer('peerA'); // op2 streak 1
        h.respond = () => manifest({ op1: 1, op2: 1 });
        await reconcileMirrorsWithPeer('peerA'); // op2 present — reset
        h.respond = () => manifest({ op1: 1 });
        const r = await reconcileMirrorsWithPeer('peerA'); // streak 1 again
        expect(r.revoked).toBe(0);
        expect(h.tables.mirrored_operations.find(m => m.id === 'op2')!.revoked_at).toBeNull();
    });
});

// --- Inbound-only cache / projection isolation — source-scan pin ---

describe('directory cache never feeds an outbound projection (source pin)', () => {
    const ROOT = resolve(__dirname, '..');
    it('no outbound projection module references alliance_peer_directory_cache', () => {
        // The cache is OUR copy of data a peer shared with US. It must never be
        // re-served to other peers: only the member-facing fetchers and the
        // engine may touch it.
        for (const file of ['lib/db/system.ts', 'lib/db/operations-federation.ts']) {
            const src = readFileSync(join(ROOT, file), 'utf8');
            expect(src.includes('alliance_peer_directory_cache'), `${file} must not read the directory cache`).toBe(false);
        }
        // In alliances.ts, the outbound projections must not touch it: the only
        // permitted call sites are the cache helpers + member-facing fetchers.
        const alliances = readFileSync(join(ROOT, 'lib/db/alliances.ts'), 'utf8');
        const outboundSection = alliances.slice(
            alliances.indexOf('export async function getAllyRosterProjection'),
            alliances.indexOf('// Ally directory cache'),
        );
        expect(outboundSection.length).toBeGreaterThan(0);
        expect(outboundSection.includes('alliance_peer_directory_cache')).toBe(false);
    });
});
