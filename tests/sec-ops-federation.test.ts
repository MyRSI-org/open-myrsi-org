import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Tests for the ops-federation security behaviour:
//   - pushOperationToAllies + pushLocalRsvpsForPeer honor the per-peer
//     channels.operations toggle — fail closed.
//   - allied RSVP ingest (upsert/remove) re-checks channels.operations.
//   - operationHasSyncRestrictedMarker fails CLOSED on a DB error (treat the
//     op as restricted → buildOperationSnapshot returns null).
//   - projectOperationSnapshot fails CLOSED when recipientPeerId is omitted
//     (drops every ally's orgs/participants instead of relaying all of them).
//
// Harness mirrors tests/operationsFederationLiveSync.test.ts (a vi.hoisted
// in-memory table mock for lib/db/common) with an added per-table error
// injection hook (h.tableErrors) used by the fail-closed marker case.

const h = vi.hoisted(() => ({
    orgEmits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    mutations: [] as Array<{ table: string; op: string; values: Record<string, unknown> | null; filters: Record<string, unknown> }>,
    peerCalls: [] as Array<{ peerId: string; path: string; body?: unknown }>,
    respond: null as null | ((peerId: string, path: string) => unknown),
    opClearance: 0,
    globalMax: 5,
    // table → error object to inject on a SELECT settle for that table.
    tableErrors: {} as Record<string, unknown>, // drives the fail-closed marker case
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
                return { ...r, operation: op ? { joint_version: op.joint_version, clearance_level: op.clearance_level ?? null } : null };
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
                const injErr = h.tableErrors[table];
                if (injErr) return Promise.resolve({ data: null, error: injErr });
                const data = rows().map(withEmbeds);
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            h.mutations.push({ table, op: state.op, values: state.values, filters: { ...state.filters, ...Object.fromEntries(Object.entries(state.ins).map(([k, v]) => [`in:${k}`, v])) } });
            const list = (h.tables[table] = h.tables[table] ?? []);
            if (state.op === 'update') {
                for (const r of rows()) Object.assign(r, state.values);
            } else if (state.op === 'upsert') {
                const v = state.values!;
                const key = 'id';
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
    getFullOperationDetails: async (id: string) => ({ id, name: 'Op', clearanceLevel: h.opClearance, participants: [], tasks: [], commandNodes: [], logistics: [], commsPlan: [], limitingMarkers: [] }),
}));
vi.mock('../lib/db/system', () => ({ getMaxShareableClearance: async () => h.globalMax }));
vi.mock('../lib/db/mappers', () => ({ toMirroredOperation: (r: Record<string, unknown>) => r }));
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
// Neutralise the per-peer budget so the channel gate (not token exhaustion) is
// what these tests exercise.
vi.mock('../lib/db/allianceSyncState', () => ({
    scheduleDebounced: () => {}, cancelDebounced: () => {}, tryConsumeToken: () => true,
    getCachedAllianceSyncConfig: () => ({}),
    recordPeerFailure: () => Promise.resolve(), recordPeerSuccess: () => Promise.resolve(),
}));

import {
    pushOperationToAllies, pushLocalRsvpsForPeer,
    upsertAlliedParticipant, removeAlliedParticipant,
    buildOperationSnapshot, projectOperationSnapshot,
} from '../lib/db/operations-federation';
import type { HydratedOperation } from '../types';

beforeEach(() => {
    h.orgEmits = [];
    h.mutations = [];
    h.peerCalls = [];
    h.respond = null;
    h.tables = {};
    h.opClearance = 0;
    h.globalMax = 5;
    h.tableErrors = {};
});
afterEach(() => { vi.useRealTimers(); });

// =============================================================================
// live-sync push honors channels.operations
// =============================================================================
describe('pushOperationToAllies honors per-peer channels.operations', () => {
    const seed = () => {
        h.tables.operation_allied_orgs = [
            { operation_id: 'op1', peer_id: 'peerOff', accepted: true },
            { operation_id: 'op1', peer_id: 'peerOn', accepted: true },
        ];
        h.tables.operations = [{ id: 'op1', joint_version: 3 }];
        h.tables.operation_limiting_markers = [];
        h.tables.alliance_peers = [
            { id: 'peerOff', sync_health: 'healthy', outbound_max_clearance: 5, channels: { operations: false } },
            { id: 'peerOn', sync_health: 'healthy', outbound_max_clearance: 5, channels: { operations: true } },
        ];
        h.respond = () => ({ status: 200, json: { ok: true } });
    };

    it('does NOT push to a channel-disabled peer, but DOES push to a channel-enabled one', async () => {
        seed();
        await pushOperationToAllies('op1', 'full');
        const pushed = h.peerCalls.filter((c) => c.path === '/api/alliance/op-mirror/push').map((c) => c.peerId);
        expect(pushed).toContain('peerOn');
        expect(pushed).not.toContain('peerOff');
    });

    it('skips a peer whose channels.operations key is missing (fail closed)', async () => {
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerMissing', accepted: true }];
        h.tables.operations = [{ id: 'op1', joint_version: 3 }];
        h.tables.operation_limiting_markers = [];
        h.tables.alliance_peers = [{ id: 'peerMissing', sync_health: 'healthy', outbound_max_clearance: 5, channels: {} }];
        h.respond = () => ({ status: 200, json: { ok: true } });
        await pushOperationToAllies('op1', 'full');
        expect(h.peerCalls.filter((c) => c.path === '/api/alliance/op-mirror/push')).toHaveLength(0);
    });

    it('the channel gate also applies to immediate events (status_change)', async () => {
        seed();
        await pushOperationToAllies('op1', 'status_change');
        const pushed = h.peerCalls.filter((c) => c.path === '/api/alliance/op-mirror/push').map((c) => c.peerId);
        expect(pushed).toEqual(['peerOn']);
    });
});

describe('pushLocalRsvpsForPeer honors channels.operations (guest side)', () => {
    const seedMirror = (channels: unknown) => {
        h.tables.alliance_peers = [{ id: 'peerX', status: 'Active', channels }];
        h.tables.mirrored_operations = [{ id: 'm1', host_peer_id: 'peerX', accepted: true, revoked_at: null }];
        h.tables.mirrored_operation_participation = [{
            mirror_op_id: 'm1', rsvp_status: 'Going', ship_text: null, is_ready: true,
            user: { name: 'Alice', rsi_handle: 'alice', avatar_url: null },
        }];
        h.respond = () => ({ status: 200, json: { ok: true } });
    };

    it('does NOT re-push RSVPs when the operations channel is disabled', async () => {
        seedMirror({ operations: false });
        await pushLocalRsvpsForPeer('peerX');
        expect(h.peerCalls.filter((c) => c.path.includes('/rsvp'))).toHaveLength(0);
    });

    it('re-pushes RSVPs when the operations channel is enabled (control)', async () => {
        seedMirror({ operations: true });
        await pushLocalRsvpsForPeer('peerX');
        expect(h.peerCalls.filter((c) => c.path.endsWith('/rsvp'))).toHaveLength(1);
    });
});

// =============================================================================
// allied RSVP ingest re-checks channels.operations
// =============================================================================
describe('upsert/removeAlliedParticipant re-check channels.operations', () => {
    it('upsertAlliedParticipant refuses a channel-disabled (but accepted) peer', async () => {
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Active', channels: { operations: false } }];
        await expect(upsertAlliedParticipant('op1', 'peerA', { remoteUserHandle: 'x', rsvpStatus: 'Going' }))
            .rejects.toThrow('forbidden');
        expect(h.mutations.find((m) => m.table === 'operation_allied_participants')).toBeUndefined();
    });

    it('removeAlliedParticipant refuses a channel-disabled (but accepted) peer', async () => {
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Active', channels: { operations: false } }];
        await expect(removeAlliedParticipant('op1', 'peerA', 'x')).rejects.toThrow('forbidden');
        expect(h.mutations.find((m) => m.table === 'operation_allied_participants' && m.op === 'delete')).toBeUndefined();
    });

    it('upsertAlliedParticipant lands the row when the channel is enabled (control)', async () => {
        h.tables.operation_allied_orgs = [{ operation_id: 'op1', peer_id: 'peerA', accepted: true }];
        h.tables.operations = [{ id: 'op1', joint_version: 1, is_joint: true }];
        h.tables.operation_allied_participants = [];
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Active', channels: { operations: true } }];
        await upsertAlliedParticipant('op1', 'peerA', { remoteUserHandle: 'x', rsvpStatus: 'Going' });
        const up = h.mutations.find((m) => m.table === 'operation_allied_participants' && m.op === 'upsert');
        expect(up).toBeTruthy();
        expect((up!.values as { remote_user_handle: string }).remote_user_handle).toBe('x');
    });
});

// =============================================================================
// operationHasSyncRestrictedMarker fails CLOSED on a DB error
// =============================================================================
describe('sync-restricted marker check fails closed on a DB error', () => {
    it('buildOperationSnapshot returns null when the marker query errors (treat as restricted)', async () => {
        h.opClearance = 0; h.globalMax = 5; // clearance ceiling would otherwise ALLOW the op
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Active', channels: { operations: true }, outbound_max_clearance: 5 }];
        h.tableErrors.operation_limiting_markers = { code: '57014', message: 'statement timeout' };
        expect(await buildOperationSnapshot('op1', 'peerA')).toBeNull();
    });

    it('buildOperationSnapshot returns a snapshot when the marker query succeeds (control)', async () => {
        h.opClearance = 0; h.globalMax = 5;
        h.tables.operation_limiting_markers = [];
        h.tables.alliance_peers = [{ id: 'peerA', status: 'Active', channels: { operations: true }, outbound_max_clearance: 5 }];
        expect(await buildOperationSnapshot('op1', 'peerA')).not.toBeNull();
    });
});

// =============================================================================
// projectOperationSnapshot fails CLOSED with no recipientPeerId
// =============================================================================
describe('projectOperationSnapshot drops all allies when recipientPeerId is omitted', () => {
    const baseOp = () => ({
        id: 'op1', name: 'Joint', type: 'Combat', status: 'Planning', description: '',
        owner: { id: 5, name: 'Cmd' }, participants: [],
        alliedOrgs: [
            { id: 1, operationId: 'op1', peerId: 'peer-B', accepted: true, invitedAt: 't', label: 'OrgB' },
            { id: 2, operationId: 'op1', peerId: 'peer-C', accepted: true, invitedAt: 't', label: 'OrgC' },
        ],
        alliedParticipants: [
            { operationId: 'op1', peerId: 'peer-B', remoteUserHandle: 'b-member', rsvpStatus: 'going', isReady: true, updatedAt: 't' },
            { operationId: 'op1', peerId: 'peer-C', remoteUserHandle: 'c-member', rsvpStatus: 'going', isReady: true, updatedAt: 't' },
        ],
    } as unknown as HydratedOperation);

    it('omitted recipient → empty alliedOrgs/alliedParticipants and no peer handles on the wire', () => {
        const snap = projectOperationSnapshot(baseOp(), false)!;
        expect(snap.alliedOrgs).toEqual([]);
        expect(snap.alliedParticipants).toEqual([]);
        const blob = JSON.stringify(snap);
        expect(blob).not.toContain('peer-B');
        expect(blob).not.toContain('peer-C');
        expect(blob).not.toContain('b-member');
        expect(blob).not.toContain('c-member');
    });

    it('a concrete recipient still gets ONLY its own roster, peerId neutralised (unchanged behavior)', () => {
        const snap = projectOperationSnapshot(baseOp(), false, 'peer-C')!;
        expect((snap.alliedOrgs ?? []).map((o) => o.label)).toEqual(['OrgC']);
        expect((snap.alliedParticipants ?? []).map((p) => p.remoteUserHandle)).toEqual(['c-member']);
        expect((snap.alliedOrgs ?? []).every((o) => o.peerId === '')).toBe(true);
        expect((snap.alliedParticipants ?? []).every((p) => p.peerId === '')).toBe(true);
        expect(JSON.stringify(snap)).not.toContain('peer-B');
    });
});
