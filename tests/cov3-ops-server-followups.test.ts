import { describe, it, expect, vi, beforeEach } from 'vitest';

// Review follow-ups to the 2026-11-02 "a FORMER participant keeps READ access" change
// (lib/db/ops.ts, lib/db/intel.ts). Each block pins one behaviour change:
//
//   (a) updateOperationDetails — an UNCHANGED limiting-marker set is not written.
//       OpAdministerTab sends markerIds on every save, so an unconditional RPC refused
//       EVERY Administer-tab save on a database where schema.sql had not been re-run.
//       A changed set still goes only through op_replace_limiting_markers, and still
//       fails closed when that function is missing.
//   (c) addOperationParticipant — an explicit manager re-add RE-ACTIVATES a former
//       participant (time_left: null), instead of silently leaving them "former".
//   (d) getDossier — the viewer-participation read uses the READ term (any roster
//       row), the last server READ path that was still active-only.
//
// (b), the board-delta projection, is pinned in tests/opBoardDeltaException.test.ts.

vi.mock('../lib/db/common', async () => (await import('./cov-db-ops-fake')).commonMock);
vi.mock('../lib/log', async () => (await import('./cov-db-ops-fake')).logMock);
vi.mock('../lib/db/operations-federation', async () => (await import('./cov-db-ops-fake')).fed);
vi.mock('../lib/push', async () => ({ sendPushToUsers: (await import('./cov-db-ops-fake')).collab.sendPushToUsers }));
vi.mock('../lib/db/users', async () => {
    const f = await import('./cov-db-ops-fake');
    return { getUserById: f.collab.getUserById, getActorLabel: f.collab.getActorLabel };
});
vi.mock('../lib/db/notifications', async () => ({ createNotification: (await import('./cov-db-ops-fake')).collab.createNotification }));
vi.mock('../lib/db/securityEvents', async () => ({ recordSecurityEvent: (await import('./cov-db-ops-fake')).collab.recordSecurityEvent }));
// getDossier's unrelated collaborators (feeds / federation). The op gate it calls —
// canUserSeeOpInList — is deliberately the REAL one from lib/db/ops.
vi.mock('../lib/db/system', () => ({ verifyApiKey: vi.fn(), getPublicFeedData: vi.fn() }));
vi.mock('../lib/ssrf', () => ({ ssrfSafeFetch: vi.fn() }));
vi.mock('../lib/crypto', () => ({ decryptSecret: (s: string) => s }));
vi.mock('../lib/db/allianceSyncState', () => ({
    getCachedAllianceSyncConfig: vi.fn(), recordPeerFailure: vi.fn(), recordPeerSuccess: vi.fn(), setSyncAlert: vi.fn(),
}));

import {
    fake, resetFake, resetCollaborators, on, onRpc, route, collab, queriesOn, writesOn, readsOn, argsOf, cols, eqs,
    payload, opUpdates, newOpId, writeKind, type FakeQuery,
} from './cov-db-ops-fake';
import { updateOperationDetails, addOperationParticipant, assertOpVisibleToUser } from '../lib/db/ops';
import { getDossier } from '../lib/db/intel';

const MANAGER = { id: 20, clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: ['operations:manage'] };
const RERUN = 'Database update required — re-run schema.sql (op_replace_limiting_markers is missing).';

const marker = (id: unknown) => ({ marker: { id, name: `M${String(id)}`, code: `M${String(id)}` } });
const liveOp = (markers: unknown[] | null | undefined, over: Record<string, unknown> = {}) => ({
    data: { id: 'op-1', clearance_level: 0, is_special: false, join_code: null, limiting_markers: markers, ...over },
});
const opWrites = () => writesOn('operations', 'update').map((q) => payload(q) as Record<string, unknown>);
const logEntries = () => writesOn('operation_log_entries', 'insert').map((q) => payload(q) as Record<string, unknown>);

beforeEach(() => {
    resetFake();
    resetCollaborators();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('(a) updateOperationDetails — an unchanged marker set is never sent to op_replace_limiting_markers', () => {
    it('the SAME set (any order, duplicates folded) makes no RPC call; the rest of the edit still lands', async () => {
        on('operations', liveOp([marker(4), marker(3)]));
        await updateOperationDetails('op-1', { markerIds: [3, 4, 3], name: 'Renamed' }, 1, MANAGER);
        expect(fake.rpcs).toEqual([]);
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
        expect(opWrites()).toEqual([{ name: 'Renamed' }]);
        expect(eqs(writesOn('operations', 'update')[0])).toEqual([['id', 'op-1']]);
        expect(logEntries()).toEqual([expect.objectContaining({ entry_type: 'UPDATE', log_entry: 'User#1 updated operation details', author_id: 1 })]);
        expect(opUpdates()).toEqual([{ operationId: 'op-1' }]);
    });

    it('an Administer-tab save BEFORE schema.sql is re-run succeeds when the markers did not change', async () => {
        // The RPC would refuse if called (function missing); the save must not depend on it.
        on('operations', liveOp([marker(3)]), { data: { scheduled_start: '2026-07-01T18:00:00Z' } });
        onRpc('op_replace_limiting_markers', { error: { code: '42883', message: 'function does not exist' } });
        await expect(updateOperationDetails('op-1', { markerIds: [3], scheduledStart: '2026-07-01T18:00:00Z', name: 'N' }, 1, MANAGER))
            .resolves.toBeUndefined();
        expect(fake.rpcs).toEqual([]);
        expect(opWrites()).toEqual([{ name: 'N', scheduled_start: '2026-07-01T18:00:00Z' }]);
        expect(fake.logs.filter((l) => l.level === 'error')).toEqual([]);
    });

    it.each([
        ['an empty live set requested empty', [], []],
        ['a live row with no markers embed requested empty', undefined, []],
        ['a null markers embed requested empty', null, []],
    ])('empty -> empty is not a change: %s', async (_label, live, requested) => {
        on('operations', liveOp(live as unknown[] | null | undefined));
        await updateOperationDetails('op-1', { markerIds: requested as number[], locationId: 9 }, 1, MANAGER);
        expect(fake.rpcs).toEqual([]);
        expect(opWrites()).toEqual([{ location_id: 9 }]);
    });

    it.each([
        ['a marker removed (subset)', [3, 4], [3]],
        ['a marker added (superset)', [3], [3, 5]],
        ['the same size, one swapped', [3, 4], [3, 5]],
        ['cleared from a marked set', [3], []],
        ['set on an unmarked op', [], [7]],
    ])('a CHANGED set goes through exactly one RPC call: %s', async (_label, live, requested) => {
        on('operations', liveOp((live as number[]).map(marker)));
        await updateOperationDetails('op-1', { markerIds: requested as number[] }, 1, MANAGER);
        expect(fake.rpcs).toEqual([{ name: 'op_replace_limiting_markers', args: { p_operation_id: 'op-1', p_marker_ids: requested } }]);
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
    });

    it('the RPC receives the caller\'s list exactly as sent (dedupe is only for the comparison)', async () => {
        on('operations', liveOp([marker(3)]));
        await updateOperationDetails('op-1', { markerIds: [5, 3, 5] }, 1, MANAGER);
        expect(fake.rpcs).toEqual([{ name: 'op_replace_limiting_markers', args: { p_operation_id: 'op-1', p_marker_ids: [5, 3, 5] } }]);
    });

    it.each([['42883'], ['PGRST202']])('a CHANGED set with the function missing (%s) is still REFUSED — no fallback, no partial write', async (code) => {
        on('operations', liveOp([marker(3)]));
        onRpc('op_replace_limiting_markers', { error: { code, message: 'Could not find the function' } });
        await expect(updateOperationDetails('op-1', { markerIds: [3, 5], name: 'renamed' }, 1, MANAGER)).rejects.toThrow(RERUN);
        expect(fake.rpcs).toHaveLength(1);
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
        expect(writesOn('operations')).toHaveLength(0);
        expect(logEntries()).toEqual([]);
        expect(opUpdates()).toEqual([]);
    });

    it.each([
        ['string ids', [marker(3), marker(4)], ['3', '4']],
        ['a fractional id', [marker(3)], [3.5]],
        ['a null entry', [marker(3)], [3, null]],
    ])('anything that is not a plain integer id list takes the validating RPC path: %s', async (_label, live, requested) => {
        on('operations', liveOp(live));
        await updateOperationDetails('op-1', { markerIds: requested as number[] }, 1, MANAGER);
        expect(fake.rpcs).toEqual([{ name: 'op_replace_limiting_markers', args: { p_operation_id: 'op-1', p_marker_ids: requested } }]);
    });

    it.each([
        ['a junction row whose marker did not resolve', [marker(3), { marker: null }], [3]],
        ['a junction row with no marker key at all', [marker(3), {}], [3]],
        // Spelled identically on both sides, so only the integer check stops a skip.
        ['a string marker id, even when the request repeats it verbatim', [marker(3), marker('4')], [3, '4']],
        ['string ids on both sides', [marker('3'), marker('4')], ['3', '4']],
    ])('a live set that cannot be read as plain ids is never "unchanged": %s', async (_label, live, requested) => {
        on('operations', liveOp(live));
        await updateOperationDetails('op-1', { markerIds: requested as number[] }, 1, MANAGER);
        expect(fake.rpcs).toEqual([{ name: 'op_replace_limiting_markers', args: { p_operation_id: 'op-1', p_marker_ids: requested } }]);
    });

    it('the skip sits AFTER the clearance gates: an unchanged set from a viewer who lacks a live marker is refused with no write', async () => {
        const holder = { id: 5, clearanceLevel: { level: 2 }, limitingMarkers: [{ id: 3 }], permissions: [] as string[] };
        on('operations', liveOp([marker(3), marker(4)]));
        await expect(updateOperationDetails('op-1', { markerIds: [3, 4], name: 'x' }, 5, holder)).rejects.toThrow('You are not cleared to edit this operation.');
        expect(fake.rpcs).toEqual([]);
        expect(writesOn('operations')).toHaveLength(0);
        expect(opUpdates()).toEqual([]);
    });

    it('a CHANGED set whose RPC error carries no code and no message still refuses — never reads as success', async () => {
        on('operations', liveOp([marker(3)]));
        onRpc('op_replace_limiting_markers', { error: {} });
        await expect(updateOperationDetails('op-1', { markerIds: [4] }, 1, MANAGER)).rejects.toThrow('Failed to update operation markers');
        expect(writesOn('operations')).toHaveLength(0);
        expect(opUpdates()).toEqual([]);
    });

    it('turning an op Special with NO stored PIN and none supplied is refused before any write (markers included)', async () => {
        on('operations', liveOp([marker(3)], { join_code: null, is_special: false }));
        await expect(updateOperationDetails('op-1', { isSpecial: true, markerIds: [3, 4] }, 1, MANAGER))
            .rejects.toThrow('Special Operations require a join PIN of at least 6 characters.');
        expect(fake.rpcs).toEqual([]);
        expect(writesOn('operations')).toHaveLength(0);
    });

    it('a non-array list is still refused by the marker writer, never skipped', async () => {
        on('operations', liveOp([]));
        await expect(updateOperationDetails('op-1', { markerIds: {} as unknown as number[] }, 1, MANAGER)).rejects.toThrow('Invalid limiting marker list.');
        expect(fake.rpcs).toEqual([]);
        expect(writesOn('operations')).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// A stateful operation_participants table, so "re-activated" is observed through the
// real ACTIVE-only write gate (assertOpVisibleToUser, default 'act'), not only as an
// upsert payload. The read honours `.is('time_left', null)` exactly as PostgREST would;
// the upsert merges ONLY the columns it names onto the conflicting row.
type Row = { operation_id: string; user_id: number; attendance_status?: string; time_left: string | null };

function participantsTable(rows: Row[], opts: { priorReadError?: boolean } = {}) {
    route('operation_participants', (q: FakeQuery) => {
        const kind = writeKind(q);
        if (kind === 'upsert') {
            const p = payload(q) as Row;
            const hit = rows.find((r) => r.operation_id === p.operation_id && r.user_id === p.user_id);
            if (hit) Object.assign(hit, p); else rows.push({ ...p });
            return { data: null };
        }
        if (kind !== 'read') return { data: null };
        if (opts.priorReadError) {
            opts.priorReadError = false;
            return { error: { message: 'read fault' } };
        }
        const want = new Map(eqs(q));
        const activeOnly = argsOf(q, 'is').some(([k, v]) => k === 'time_left' && v === null);
        const hit = rows.find((r) => r.operation_id === want.get('operation_id') && r.user_id === want.get('user_id')
            && (!activeOnly || r.time_left === null));
        return { data: hit ? { user_id: hit.user_id } : null };
    });
}

describe('(c) addOperationParticipant — an explicit re-add RE-ACTIVATES a former participant', () => {
    const FORMER_ID = 7;
    const CONCLUDED = '2026-10-01T18:00:00Z';
    const member = { id: FORMER_ID, clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: ['operations:view'] };

    function specialOp(op: string) {
        route('operations', (q) => {
            const c = cols(q);
            if (c === 'is_joint') return { data: { is_joint: false } };
            if (c.startsWith('id, owner_id, is_special, clearance_level')) {
                return { data: { id: op, owner_id: 1, is_special: true, clearance_level: 0, limiting_markers: [] } };
            }
            return { data: null };
        });
    }

    it('the upsert clears time_left, and the former participant can ACT again — with no "added" notification', async () => {
        const op = newOpId();
        specialOp(op);
        const rows: Row[] = [{ operation_id: op, user_id: FORMER_ID, attendance_status: 'Attended', time_left: CONCLUDED }];
        participantsTable(rows);

        // Before: a former participant is refused every ACTIVE-only write.
        await expect(assertOpVisibleToUser(op, member)).rejects.toThrow('Insufficient access to act on this special operation.');

        await addOperationParticipant(op, FORMER_ID, 1);
        const up = writesOn('operation_participants', 'upsert');
        expect(up).toHaveLength(1);
        expect(payload(up[0])).toEqual({ operation_id: op, user_id: FORMER_ID, attendance_status: 'Registered', time_left: null });
        expect(argsOf(up[0], 'upsert')[0][1]).toEqual({ onConflict: 'operation_id,user_id', ignoreDuplicates: false });
        expect(rows).toEqual([{ operation_id: op, user_id: FORMER_ID, attendance_status: 'Registered', time_left: null }]);

        // After: the same gate admits them.
        await expect(assertOpVisibleToUser(op, member)).resolves.toBeUndefined();

        // A prior row of ANY kind is a re-add: never a fresh "Added to an operation" push.
        expect(collab.createNotification).not.toHaveBeenCalled();
        expect(logEntries()).toEqual([expect.objectContaining({ entry_type: 'ADD_MEMBER', log_entry: `User#${FORMER_ID} added by User#1`, author_id: 1 })]);
        expect(opUpdates()).toEqual([{ operationId: op }]);
    });

    it('the prior read is unfiltered (it sees a former row) and scoped to the op + target', async () => {
        const op = newOpId();
        specialOp(op);
        participantsTable([{ operation_id: op, user_id: FORMER_ID, time_left: CONCLUDED }]);
        await addOperationParticipant(op, FORMER_ID, 1);
        const prior = readsOn('operation_participants')[0];
        expect(cols(prior)).toBe('user_id');
        expect(eqs(prior)).toEqual([['operation_id', op], ['user_id', FORMER_ID]]);
        expect(argsOf(prior, 'is')).toEqual([]);
    });

    it('a faulted prior read still fails CLOSED to "no notify" — and the re-add still re-activates', async () => {
        const op = newOpId();
        specialOp(op);
        const rows: Row[] = [];
        participantsTable(rows, { priorReadError: true });
        await addOperationParticipant(op, 12, 1);
        expect(collab.createNotification).not.toHaveBeenCalled();
        expect(payload(writesOn('operation_participants', 'upsert')[0])).toEqual({ operation_id: op, user_id: 12, attendance_status: 'Registered', time_left: null });
        expect(rows).toEqual([{ operation_id: op, user_id: 12, attendance_status: 'Registered', time_left: null }]);
    });

    it('a genuinely new member is notified once (the no-notify rule is unchanged for them)', async () => {
        const op = newOpId();
        specialOp(op);
        participantsTable([]);
        await addOperationParticipant(op, 12, 1);
        expect(collab.createNotification).toHaveBeenCalledTimes(1);
        expect(collab.createNotification).toHaveBeenCalledWith(12, {
            type: 'operation_assigned', title: 'Added to an operation', body: 'A team member added you to an operation.',
            link: 'operations', metadata: { operationId: op },
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The dossier ops list runs the REAL canUserSeeOpInList against a participation read
// that honours a `.is('time_left', null)` filter if one is present — so re-adding the
// old active-only filter would hide the op from the FORMER participant here.
describe('(d) getDossier — a FORMER participant sees the special op, like every other op READ path', () => {
    const OP_ID = '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const ROSTER = [
        { operation_id: OP_ID, user_id: 6, time_left: null as string | null },
        { operation_id: OP_ID, user_id: 7, time_left: '2026-10-01T18:00:00Z' as string | null },
    ];
    const viewer = (id: number) => ({ id, clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: ['intel:view', 'operations:view'] });
    const CAST: Array<[string, number, boolean]> = [['ACTIVE', 6, true], ['FORMER', 7, true], ['REMOVED', 8, false], ['OUTSIDER', 9, false]];

    beforeEach(() => {
        route('users', () => ({ data: { id: 77 } }));
        route('intel_reports', () => ({ data: [] }));
        route('warrants', () => ({ data: [] }));
        route('service_requests', () => ({ data: [] }));
        route('operations', () => ({
            data: [{
                id: OP_ID, name: 'Black Op', status: 'Concluded', type: 'Combat', description: 'covert', created_at: '2026-09-30T09:00:00Z',
                owner_id: 5, clearance_level: 0, is_special: true, limiting_markers: [],
            }],
        }));
        route('operation_participants', (q) => {
            const uid = eqs(q).find(([k]) => k === 'user_id')?.[1];
            const activeOnly = argsOf(q, 'is').some(([k, v]) => k === 'time_left' && v === null);
            return { data: ROSTER.filter((r) => r.user_id === uid && (!activeOnly || r.time_left === null)).map((r) => ({ operation_id: r.operation_id })) };
        });
    });

    it.each(CAST)('%s (user %i)', async (_who, id, sees) => {
        const out = await getDossier('subject_handle', viewer(id));
        expect(out.operations).toEqual(sees
            ? [{ id: OP_ID, name: 'Black Op', status: 'Concluded', type: 'Combat', description: 'covert', createdAt: '2026-09-30T09:00:00Z' }]
            : []);
        const vp = queriesOn('operation_participants');
        expect(vp).toHaveLength(1);
        expect(cols(vp[0])).toBe('operation_id');
        expect(eqs(vp[0])).toEqual([['user_id', id]]);
        expect(argsOf(vp[0], 'is')).toEqual([]);
    });

    it('participation never substitutes for clearance: the former participant below the op level sees nothing', async () => {
        route('operations', () => ({
            data: [{ id: OP_ID, name: 'Black Op', status: 'Concluded', type: 'Combat', description: 'covert', created_at: 'c', owner_id: 5, clearance_level: 2, is_special: true, limiting_markers: [] }],
        }));
        expect((await getDossier('subject_handle', viewer(7))).operations).toEqual([]);
    });

    it('a participation read fault — or an empty answer — hides the special op (fail closed), it never shows it', async () => {
        route('operation_participants', () => ({ error: { code: '08006', message: 'down' } }));
        expect((await getDossier('subject_handle', viewer(7))).operations).toEqual([]);
        route('operation_participants', () => ({ data: null }));
        expect((await getDossier('subject_handle', viewer(7))).operations).toEqual([]);
    });

    it('an ops read that returns no rows yields an empty list, not a crash', async () => {
        route('operations', () => ({ data: null }));
        expect((await getDossier('subject_handle', viewer(6))).operations).toEqual([]);
    });
});
