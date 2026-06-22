import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Federation hardening across the federation package:
//   channels.operations revocation takes effect at serve time:
//     getOperationSnapshotForPeer / getOperationManifestForPeer /
//     acceptInviteForPeer all re-read the peer's channels.operations and refuse
//     (empty/forbidden) when it is not true (mirroring the roster/fleet serve-time
//     gate). An invite row alone no longer keeps pulling live op content after
//     "Joint Ops" is toggled off.
//   the guest-initiated pull paths (acceptMirroredOperation /
//     pollMirroredOperation / pullMirrorFromHost via reconcile) apply
//     boundedInboundSnapshot, the same MAX_INBOUND_SNAPSHOT_BYTES cap the
//     host-pushed paths enforce, so a hostile host can't park a multi-MB blob.
//   sanitizeRosterProjection / sanitizeFleetProjection cap the inbound
//     directory-cache element arrays (members[] / groups[] / shipsByCategory[]) so
//     a hostile peer can't stream an unbounded list.

const h = vi.hoisted(() => ({
    orgEmits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    mutations: [] as Array<{ table: string; op: string; values: Record<string, unknown> | null; filters: Record<string, unknown> }>,
    peerCalls: [] as Array<{ peerId: string; path: string; body?: unknown }>,
    respond: null as null | ((peerId: string, path: string) => unknown),
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
    getFullOperationDetails: async (id: string) => ({ id, name: 'Op', participants: [], tasks: [], commandNodes: [], logistics: [], commsPlan: [], limitingMarkers: [] }),
}));

vi.mock('../lib/db/mappers', () => ({
    toMirroredOperation: (r: Record<string, unknown>) => r,
}));

// Keep the real alliances module (so sanitizeRosterProjection /
// sanitizeFleetProjection are exercised as shipped) but replace the
// network-touching callAlliancePeer with a controllable stub.
vi.mock('../lib/db/alliances', async () => {
    const actual = await vi.importActual<typeof import('../lib/db/alliances')>('../lib/db/alliances');
    return {
        ...actual,
        callAlliancePeer: async (peerId: string, path: string, init?: { body?: unknown }) => {
            h.peerCalls.push({ peerId, path, body: init?.body });
            const out = h.respond ? h.respond(peerId, path) : null;
            if (out instanceof Error) throw out;
            if (out === null || out === undefined) return null;
            const { status = 200, json = {} } = out as { status?: number; json?: unknown };
            return { ok: status >= 200 && status < 300, status, json: async () => json } as Response;
        },
    };
});

import {
    getOperationSnapshotForPeer, getOperationManifestForPeer, acceptInviteForPeer,
    acceptMirroredOperation, pollMirroredOperation,
    reconcileMirrorsWithPeer, __resetReconcileStateForTests,
} from '../lib/db/operations-federation';
import { sanitizeRosterProjection, sanitizeFleetProjection } from '../lib/db/alliances';
import { __resetAllianceSyncStateForTests } from '../lib/db/allianceSyncState';
import type { AllyRosterData, AllyFleetSummary } from '../types';

beforeEach(() => {
    h.orgEmits = [];
    h.mutations = [];
    h.peerCalls = [];
    h.respond = null;
    h.tables = {};
    __resetReconcileStateForTests();
    __resetAllianceSyncStateForTests();
});
afterEach(() => { vi.useRealTimers(); });

// The cap inside operations-federation.ts. A snapshot whose JSON length exceeds
// this must be rejected by boundedInboundSnapshot on every ingress path.
const OVER_CAP = 1_000_001;
const hugeSnapshot = () => ({ name: 'op', blob: 'x'.repeat(OVER_CAP) });

describe('fed#1: channels.operations revocation gates the operations serve paths', () => {
    const seedInvited = (channels: unknown) => {
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        h.tables.operations = [{ id: 'op1', joint_version: 4, is_joint: true }];
        h.tables.operation_limiting_markers = [];
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Active', channels }];
    };

    it('getOperationSnapshotForPeer SERVES when channels.operations === true', async () => {
        seedInvited({ operations: true });
        const res = await getOperationSnapshotForPeer('op1', 'peerA');
        expect('unchanged' in res).toBe(false);
        if (!('unchanged' in res)) {
            expect(res.version).toBe(4);
            expect(res.snapshot).toBeTruthy();
        }
    });

    it('getOperationSnapshotForPeer REFUSES when channels.operations is false (even with a valid invite row)', async () => {
        seedInvited({ operations: false });
        await expect(getOperationSnapshotForPeer('op1', 'peerA')).rejects.toThrow('forbidden');
    });

    it('getOperationSnapshotForPeer REFUSES when the operations channel is absent (fail closed)', async () => {
        seedInvited({ roster: true }); // operations key missing entirely
        await expect(getOperationSnapshotForPeer('op1', 'peerA')).rejects.toThrow('forbidden');
    });

    it('getOperationManifestForPeer serves the op when channels.operations === true', async () => {
        seedInvited({ operations: true });
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        const m = await getOperationManifestForPeer('peerA');
        expect(m.accepted).toEqual({ op1: 4 });
    });

    it('getOperationManifestForPeer returns an EMPTY manifest when channels.operations is false', async () => {
        seedInvited({ operations: false });
        const m = await getOperationManifestForPeer('peerA');
        expect(m.v).toBe(1);
        expect(m.accepted).toEqual({});
        expect(m.invited).toEqual([]);
        // It must NOT have even queried/disclosed the invited op ids.
        expect(JSON.stringify(m)).not.toContain('op1');
    });

    it('acceptInviteForPeer REFUSES when channels.operations is false', async () => {
        seedInvited({ operations: false });
        await expect(acceptInviteForPeer('op1', 'peerA')).rejects.toThrow('forbidden');
        // The invite row must NOT have been latched accepted.
        const updated = h.mutations.find(m => m.table === 'operation_allied_orgs' && m.op === 'update');
        expect(updated).toBeUndefined();
    });

    it('acceptInviteForPeer SERVES the first snapshot when channels.operations === true', async () => {
        seedInvited({ operations: true });
        const res = await acceptInviteForPeer('op1', 'peerA');
        expect(res.snapshot).toBeTruthy();
        expect(res.version).toBe(4);
    });

    it('all three serve paths refuse when the peer is not Active (channel gate fails closed)', async () => {
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        h.tables.operations = [{ id: 'op1', joint_version: 4, is_joint: true }];
        h.tables.operation_limiting_markers = [];
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Dissolved', channels: { operations: true } }];
        await expect(getOperationSnapshotForPeer('op1', 'peerA')).rejects.toThrow('forbidden');
        await expect(acceptInviteForPeer('op1', 'peerA')).rejects.toThrow('forbidden');
        const m = await getOperationManifestForPeer('peerA');
        expect(m.accepted).toEqual({});
    });
});

describe('fed#2: boundedInboundSnapshot caps the guest-INITIATED pull paths', () => {
    it('acceptMirroredOperation rejects an oversized host-served snapshot and persists nothing', async () => {
        h.tables.mirrored_operations = [{ id: 'op1', host_peer_id: 'hostA', version: 0, accepted: false, revoked_at: null }];
        h.respond = (_p, path) => {
            if (path === '/api/alliance/op/op1/accept') return { status: 200, json: { v: 1, op_id: 'op1', version: 1, snapshot: hugeSnapshot() } };
            return null;
        };
        await expect(acceptMirroredOperation('op1')).rejects.toThrow('malformed_request');
        const row = h.tables.mirrored_operations.find(m => m.id === 'op1')!;
        expect(row.accepted).toBe(false);        // not latched accepted
        expect(row.snapshot).toBeUndefined();    // oversized blob NOT stored
    });

    it('acceptMirroredOperation stores an in-cap snapshot normally', async () => {
        h.tables.mirrored_operations = [{ id: 'op1', host_peer_id: 'hostA', version: 0, accepted: false, revoked_at: null }];
        h.respond = (_p, path) => {
            if (path === '/api/alliance/op/op1/accept') return { status: 200, json: { v: 1, op_id: 'op1', version: 1, snapshot: { name: 'fine' } } };
            return null;
        };
        await acceptMirroredOperation('op1');
        const row = h.tables.mirrored_operations.find(m => m.id === 'op1')!;
        expect(row.accepted).toBe(true);
        expect((row.snapshot as { name: string }).name).toBe('fine');
    });

    it('pollMirroredOperation rejects an oversized host-served snapshot and leaves the mirror unchanged', async () => {
        h.tables.mirrored_operations = [{ id: 'op1', host_peer_id: 'hostA', version: 1, accepted: true, revoked_at: null, snapshot: { name: 'current' } }];
        h.respond = (_p, path) => {
            if (path.startsWith('/api/alliance/op/op1')) return { status: 200, json: { v: 1, op_id: 'op1', version: 2, snapshot: hugeSnapshot() } };
            return null;
        };
        await expect(pollMirroredOperation('op1')).rejects.toThrow('malformed_request');
        const row = h.tables.mirrored_operations.find(m => m.id === 'op1')!;
        expect(row.version).toBe(1);                                  // not bumped
        expect((row.snapshot as { name: string }).name).toBe('current'); // not overwritten
    });

    it('reconcile pull (pullMirrorFromHost via reconcileMirrorsWithPeer) drops an oversized snapshot — nothing persisted', async () => {
        h.tables.mirrored_operations = [];
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Active', channels: { operations: true } }];
        h.respond = (_p, path) => {
            if (path === '/api/alliance/op-manifest') return { status: 200, json: { v: 1, fetchedAt: new Date().toISOString(), accepted: { op1: 5 }, invited: [] } };
            if (path.startsWith('/api/alliance/op/op1')) return { status: 200, json: { v: 1, op_id: 'op1', version: 5, snapshot: hugeSnapshot() } };
            return null;
        };
        const r = await reconcileMirrorsWithPeer('peerA');
        // The pull throws inside pullMirrorFromHost → caught by reconcile → not
        // counted as applied → no mirror row created (fail closed).
        expect(r.pulled).toBe(0);
        expect(h.tables.mirrored_operations.find(m => m.id === 'op1')).toBeUndefined();
    });

    it('reconcile pull persists an in-cap snapshot (control: the path itself works)', async () => {
        h.tables.mirrored_operations = [];
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Active', channels: { operations: true } }];
        h.respond = (_p, path) => {
            if (path === '/api/alliance/op-manifest') return { status: 200, json: { v: 1, fetchedAt: new Date().toISOString(), accepted: { op1: 5 }, invited: [] } };
            if (path.startsWith('/api/alliance/op/op1')) return { status: 200, json: { v: 1, op_id: 'op1', version: 5, snapshot: { name: 'healed' } } };
            return null;
        };
        const r = await reconcileMirrorsWithPeer('peerA');
        expect(r.pulled).toBe(1);
        expect(h.tables.mirrored_operations.find(m => m.id === 'op1')).toMatchObject({ host_peer_id: 'peerA', version: 5, accepted: true });
    });
});

describe('fed#3: sanitizeRosterProjection caps the inbound members[] array', () => {
    it('truncates an oversized members[] to the ceiling', () => {
        const members = Array.from({ length: 6_000 }, (_v, i) => ({
            id: i, rsiHandle: `h${i}`, name: `n${i}`, avatarUrl: null, isDuty: false,
        }));
        const data = { memberCount: members.length, members, fetchedAt: 't' } as AllyRosterData;
        const out = sanitizeRosterProjection(data);
        expect(out.members.length).toBe(5_000);
        expect(out.members.length).toBeLessThan(members.length);
    });

    it('leaves a normal-sized members[] intact (and clamps avatar URLs — M6)', () => {
        const data = {
            memberCount: 2, fetchedAt: 't',
            members: [
                { id: 1, rsiHandle: 'a', name: 'A', avatarUrl: 'javascript:alert(1)', isDuty: true },
                { id: 2, rsiHandle: 'b', name: 'B', avatarUrl: 'https://cdn.example.com/x.png', isDuty: false },
            ],
        } as AllyRosterData;
        const out = sanitizeRosterProjection(data);
        expect(out.members.length).toBe(2);
        expect(out.members[0].avatarUrl).toBeNull();                       // unsafe scheme dropped
        expect(out.members[1].avatarUrl).toBe('https://cdn.example.com/x.png');
    });
});

describe('fed#3: sanitizeFleetProjection caps groups[] and shipsByCategory[]', () => {
    it('truncates oversized element arrays to the ceilings', () => {
        const groups = Array.from({ length: 3_000 }, (_v, i) => ({ name: `g${i}`, type: 'x', totalShips: 1 }));
        const shipsByCategory = Array.from({ length: 3_000 }, (_v, i) => ({ category: `c${i}`, count: 1 }));
        const data = { groupCount: groups.length, totalShips: 9999, shipsByCategory, groups, fetchedAt: 't' } as AllyFleetSummary;
        const out = sanitizeFleetProjection(data);
        expect(out.groups.length).toBe(2_000);
        expect(out.shipsByCategory.length).toBe(2_000);
    });

    it('leaves a normal aggregate intact', () => {
        const data = {
            groupCount: 1, totalShips: 3, fetchedAt: 't',
            shipsByCategory: [{ category: 'Combat', count: 3 }],
            groups: [{ name: 'Alpha', type: 'Squadron', totalShips: 3 }],
        } as AllyFleetSummary;
        const out = sanitizeFleetProjection(data);
        expect(out.groups.length).toBe(1);
        expect(out.shipsByCategory.length).toBe(1);
    });
});
