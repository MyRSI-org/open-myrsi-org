import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { User } from '../types';

// lib/db/ops.ts — the READ side: who may see an operation, what the list / slice /
// detail paths put on the wire, and the egress predicates (operationIsRestricted,
// the alert push) that fail CLOSED when the database blips.
//
// The fake (tests/cov-db-ops-fake.ts) records every query with its full builder
// chain, so each test pins the table, the explicit column list (never '*'), the
// filters, and what the mapped result exposes.

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

import {
    fake, resetFake, resetCollaborators, on, fed, collab, queriesOn, readsOn, argsOf, has, cols, eqs,
    warnings, opUpdates, newOpId, flush,
} from './cov-db-ops-fake';
import {
    operationIsRestricted, broadcastOperationAlert, getLatestOperationAlert, verifyOperationAccess,
    broadcastOpChange, canUserSeeOpInList, getOperations, assertOpVisibleToUser, getOperationClassification,
    getOperationByIdLite, getFullOperationDetails, getOperationOwnerId, deleteOperation, hasOpReadParticipation,
} from '../lib/db/ops';

const MEMBER = { id: 10, clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: ['operations:view'] };
const CLEARED = { id: 30, clearanceLevel: { level: 3 }, limitingMarkers: [{ id: 7, code: 'K', name: 'Kilo' }], permissions: ['operations:view'] };
const MANAGER = { id: 20, clearanceLevel: { level: 0 }, limitingMarkers: [], permissions: ['operations:manage'] };
const asUser = (u: object) => u as unknown as User;

const MARKER_7 = { marker: { id: 7, name: 'Kilo', code: 'K' } };

/** A row in the OPS_SELECT shape (only the fields the mapper/predicates read). */
const opRow = (over: Record<string, unknown> = {}) => ({
    id: 'op-1', name: 'Op', owner_id: 99, status: 'Planning', type: 'Combat', description: 'd',
    created_at: '2026-01-01T00:00:00Z', clearance_level: 0, is_special: false, join_code: null,
    limiting_markers: [], participants: [], log: [], owner: { id: 99, name: 'Owner', avatar_url: 'a' },
    ...over,
});

beforeEach(() => {
    resetFake();
    resetCollaborators();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('operationIsRestricted — the single egress predicate, fail-closed', () => {
    it('a read fault on the operation row is RESTRICTED, and the marker probe never runs', async () => {
        on('operations', { error: { code: '08006', message: 'connection reset' } });
        await expect(operationIsRestricted('op-1')).resolves.toBe(true);
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
        const q = queriesOn('operations')[0];
        expect(cols(q)).toBe('clearance_level, is_special');
        expect(eqs(q)).toEqual([['id', 'op-1']]);
        expect(has(q, 'maybeSingle')).toBe(true);
    });

    it('clearance > 0 is restricted without a marker probe', async () => {
        on('operations', { data: { clearance_level: 2, is_special: false } });
        await expect(operationIsRestricted('op-1')).resolves.toBe(true);
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
    });

    it('a Special Operation is restricted even at clearance 0', async () => {
        on('operations', { data: { clearance_level: 0, is_special: true } });
        await expect(operationIsRestricted('op-1')).resolves.toBe(true);
        expect(queriesOn('operation_limiting_markers')).toHaveLength(0);
    });

    it('a clearance-0, non-special op is unrestricted only when the HEAD marker probe counts zero', async () => {
        on('operations', { data: { clearance_level: 0, is_special: false } });
        on('operation_limiting_markers', { count: 0 });
        await expect(operationIsRestricted('op-1')).resolves.toBe(false);
        const probe = queriesOn('operation_limiting_markers')[0];
        // Head-only: the count, never the marker rows.
        expect(argsOf(probe, 'select')[0]).toEqual(['operation_id', { count: 'exact', head: true }]);
        expect(eqs(probe)).toEqual([['operation_id', 'op-1']]);
    });

    it('any limiting marker restricts the op', async () => {
        on('operations', { data: { clearance_level: 0, is_special: false } });
        on('operation_limiting_markers', { count: 1 });
        await expect(operationIsRestricted('op-1')).resolves.toBe(true);
    });

    it('a marker-probe fault is RESTRICTED (a null count must not read as zero markers)', async () => {
        on('operations', { data: { clearance_level: 0, is_special: false } });
        on('operation_limiting_markers', { error: { message: 'timeout' }, count: null });
        await expect(operationIsRestricted('op-1')).resolves.toBe(true);
    });

    it('a missing row falls through to the marker probe (no level, not special)', async () => {
        on('operations', { data: null });
        on('operation_limiting_markers', { count: 0 });
        await expect(operationIsRestricted('op-1')).resolves.toBe(false);
        expect(queriesOn('operation_limiting_markers')).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('broadcastOperationAlert — ids on the wire, alert text only to unrestricted pushes', () => {
    it('unrestricted op: id-only realtime trigger, push carries the message to ACTIVE participants', async () => {
        on('operations', { data: { clearance_level: 0, is_special: false } });
        on('operation_limiting_markers', { count: 0 });
        on('operation_participants', { data: [{ user_id: 4 }, { user_id: 5 }] });

        await broadcastOperationAlert('op-1', 'Fall back to the LZ');

        const alert = fake.emits.find((e) => e.event === 'operation_alert')!;
        expect(alert.channel).toBe('auth-alerts');
        expect(Object.keys(alert.payload).sort()).toEqual(['operationId', 'timestamp']);
        expect(alert.payload.operationId).toBe('op-1');

        const pq = queriesOn('operation_participants')[0];
        expect(cols(pq)).toBe('user_id');
        expect(eqs(pq)).toEqual([['operation_id', 'op-1']]);
        expect(argsOf(pq, 'is')).toEqual([['time_left', null]]);

        expect(collab.sendPushToUsers).toHaveBeenCalledTimes(1);
        const [ids, msg] = collab.sendPushToUsers.mock.calls[0];
        expect(ids).toEqual([4, 5]);
        expect(msg).toMatchObject({
            title: 'Operations Alert', body: 'Fall back to the LZ', tag: 'high-priority',
            data: { type: 'operation_alert', operationId: 'op-1', url: '/operations' },
            requireInteraction: true, renotify: true,
        });
        expect(fed.pushOperationToAllies).toHaveBeenCalledWith('op-1', 'alert');
    });

    it('restricted op: the push body is generic — the alert text never reaches a lock screen', async () => {
        on('operations', { data: { clearance_level: 4, is_special: false } });
        on('operation_participants', { data: [{ user_id: 4 }] });

        await broadcastOperationAlert('op-1', 'SECRET: rendezvous at Yela');

        const [, msg] = collab.sendPushToUsers.mock.calls[0];
        expect(msg.body).toBe('An alert was posted on an operation you are on. Open the dashboard to view.');
        expect(JSON.stringify(msg)).not.toContain('Yela');
    });

    it('an unverifiable op (read fault) is treated as restricted', async () => {
        on('operations', { error: { message: 'down' } });
        on('operation_participants', { data: [{ user_id: 4 }] });
        await broadcastOperationAlert('op-1', 'classified text');
        expect(collab.sendPushToUsers.mock.calls[0][1].body).not.toContain('classified');
    });

    it('no active participants: no push at all, the trigger still goes out', async () => {
        on('operations', { data: { clearance_level: 0, is_special: false } });
        on('operation_limiting_markers', { count: 0 });
        on('operation_participants', { data: null });
        await broadcastOperationAlert('op-1', 'm');
        expect(collab.sendPushToUsers).not.toHaveBeenCalled();
        expect(fake.emits.filter((e) => e.event === 'operation_alert')).toHaveLength(1);
    });

    it('an allied-push rejection is swallowed (fire-and-forget)', async () => {
        fed.pushOperationToAllies.mockRejectedValueOnce(new Error('peer down'));
        on('operations', { data: { clearance_level: 0, is_special: false } });
        on('operation_limiting_markers', { count: 0 });
        await expect(broadcastOperationAlert('op-1', 'm')).resolves.toBeUndefined();
        await flush();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getLatestOperationAlert — the gated fetch behind the trigger', () => {
    it('reads the newest ALERT entry and strips the handler prefix', async () => {
        on('operation_log_entries', { data: { log_entry: 'Operations Alert: Hold position', created_at: 't1', author: { name: 'Cmdr' } } });
        await expect(getLatestOperationAlert('op-1')).resolves.toEqual({ message: 'Hold position', senderName: 'Cmdr', timestamp: 't1' });
        const q = queriesOn('operation_log_entries')[0];
        expect(cols(q)).toBe('log_entry, created_at, author:users!operation_log_entries_author_id_fkey(name)');
        expect(eqs(q)).toEqual([['operation_id', 'op-1'], ['entry_type', 'ALERT']]);
        expect(argsOf(q, 'order')).toEqual([['created_at', { ascending: false }]]);
        expect(argsOf(q, 'limit')).toEqual([[1]]);
    });

    it('a missing author reads as "Command" and a null body as an empty message', async () => {
        on('operation_log_entries', { data: { log_entry: null, created_at: 't2', author: null } });
        await expect(getLatestOperationAlert('op-1')).resolves.toEqual({ message: '', senderName: 'Command', timestamp: 't2' });
    });

    it('no alert → null', async () => {
        on('operation_log_entries', { data: null });
        await expect(getLatestOperationAlert('op-1')).resolves.toBeNull();
    });

    it('a read fault throws the high-level message (never a silent null)', async () => {
        on('operation_log_entries', { error: { message: 'x' } });
        await expect(getLatestOperationAlert('op-1')).rejects.toThrow('Failed to get operation alert');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('verifyOperationAccess — existence check with a positive-only cache', () => {
    it('a missing op throws and is NOT cached (the next call re-reads)', async () => {
        const id = newOpId();
        on('operations', { data: null }, { data: null });
        await expect(verifyOperationAccess(id)).rejects.toThrow('Operation not found or access denied.');
        await expect(verifyOperationAccess(id)).rejects.toThrow('Operation not found or access denied.');
        expect(queriesOn('operations')).toHaveLength(2);
        expect(cols(queriesOn('operations')[0])).toBe('is_joint');
    });

    it('a hit is cached: the second call issues no query', async () => {
        const id = newOpId();
        on('operations', { data: { is_joint: true } });
        await expect(verifyOperationAccess(id)).resolves.toEqual({ isJoint: true, hostOrgId: '' });
        await expect(verifyOperationAccess(id)).resolves.toEqual({ isJoint: true, hostOrgId: '' });
        expect(queriesOn('operations')).toHaveLength(1);
    });

    it('deleteOperation actively invalidates the cached entry', async () => {
        const id = newOpId();
        on('operations', { data: { is_joint: false } });
        await verifyOperationAccess(id);
        await deleteOperation(id, 1);
        on('operations', { data: null });
        await expect(verifyOperationAccess(id)).rejects.toThrow('Operation not found or access denied.');
    });
});

describe('broadcastOpChange — id-only fan-out plus federation nudges', () => {
    it('emits exactly { operationId } and nudges the joint version + allied push', async () => {
        await broadcastOpChange('op-9');
        expect(opUpdates()).toEqual([{ operationId: 'op-9' }]);
        expect(fed.bumpOperationVersion).toHaveBeenCalledWith('op-9');
        expect(fed.scheduleAlliedPush).toHaveBeenCalledWith('op-9');
    });

    it('a rejected version bump is swallowed', async () => {
        fed.bumpOperationVersion.mockRejectedValueOnce(new Error('db'));
        await expect(broadcastOpChange('op-9')).resolves.toBeUndefined();
        await flush();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('canUserSeeOpInList — the shared list/slice predicate', () => {
    const base = { clearanceLevel: 0, ownerId: 99, limitingMarkers: [] as unknown[] };

    it('denies an op above the viewer clearance; the owner and a manager pass', () => {
        const op = { ...base, clearanceLevel: 3 };
        expect(canUserSeeOpInList(MEMBER, op)).toBe(false);
        expect(canUserSeeOpInList({ ...MEMBER, id: 99 }, op)).toBe(true);
        expect(canUserSeeOpInList(MANAGER, op)).toBe(true);
    });

    it('enforces every limiting marker — level alone is not enough', () => {
        const op = { ...base, clearanceLevel: 1, limitingMarkers: [{ id: 7 }, { id: 8 }] };
        expect(canUserSeeOpInList(CLEARED, op)).toBe(false);
        expect(canUserSeeOpInList(CLEARED, { ...op, limitingMarkers: [{ id: 7 }] })).toBe(true);
    });

    it('a string viewer id never matches a numeric owner id (fail closed to clearance)', () => {
        expect(canUserSeeOpInList({ ...MEMBER, id: '99' }, { ...base, clearanceLevel: 2 })).toBe(false);
    });

    it('a null ownerId is nobody\'s op', () => {
        expect(canUserSeeOpInList({ ...MEMBER, id: undefined }, { ...base, ownerId: null, clearanceLevel: 1 })).toBe(false);
    });

    it('special op: a participant row with a null userId does not admit anyone', () => {
        const op = { ...base, isSpecial: true, participants: [{ userId: null, timeLeft: null }] };
        expect(canUserSeeOpInList(MEMBER, op)).toBe(false);
        expect(canUserSeeOpInList(MEMBER, { ...op, participants: undefined })).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getOperations — list read, visibility filter, PIN redaction', () => {
    it('no user → [] and no query at all', async () => {
        await expect(getOperations(null)).resolves.toEqual([]);
        expect(fake.queries).toHaveLength(0);
        expect(warnings(/user is null/)).toHaveLength(1);
    });

    it('pins the capped, totally-ordered read with an explicit projection', async () => {
        on('operations', { data: [] });
        await getOperations(asUser(MEMBER));
        const q = queriesOn('operations')[0];
        const sel = cols(q);
        expect(sel).not.toMatch(/\*/);
        expect(sel).toContain('location:locations!operations_location_id_fkey(id, name, type, parent_id)');
        expect(argsOf(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(argsOf(q, 'limit')).toEqual([[100]]);
    });

    it('filters by clearance/markers/special-gate, redacts the PIN for non-owners, and sorts newest first', async () => {
        on('operations', {
            data: [
                opRow({ id: 'old', created_at: '2026-01-01T00:00:00Z', join_code: 'PIN-OLD-1' }),
                opRow({ id: 'secret', clearance_level: 5 }),
                opRow({ id: 'compartment', limiting_markers: [MARKER_7] }),
                opRow({ id: 'special', is_special: true, join_code: 'PIN-SPECIAL' }),
                opRow({ id: 'mine', owner_id: 10, created_at: '2026-03-01T00:00:00Z', join_code: 'PIN-MINE-1', is_special: true }),
                opRow({ id: 'new', created_at: '2026-02-01T00:00:00Z' }),
            ],
        });
        const ops = await getOperations(asUser(MEMBER));
        expect(ops.map((o) => o.id)).toEqual(['mine', 'new', 'old']);
        expect(ops.find((o) => o.id === 'old')!.joinCode).toBeUndefined();
        // The owner keeps their own PIN.
        expect(ops.find((o) => o.id === 'mine')!.joinCode).toBe('PIN-MINE-1');
    });

    it('an operations:manage holder sees everything and keeps every PIN', async () => {
        on('operations', { data: [opRow({ id: 's', clearance_level: 5, is_special: true, join_code: 'PIN-123456' })] });
        const ops = await getOperations(asUser(MANAGER));
        expect(ops.map((o) => o.id)).toEqual(['s']);
        expect(ops[0].joinCode).toBe('PIN-123456');
    });

    it('warns when every fetched op is filtered out (a clearance-config smell), returns []', async () => {
        on('operations', { data: [opRow({ clearance_level: 9 })] });
        await expect(getOperations(asUser(MEMBER))).resolves.toEqual([]);
        const w = warnings(/all ops filtered out/);
        expect(w).toHaveLength(1);
        expect(w[0].fields).toMatchObject({ filteredCount: 1, userId: 10, clearanceLevel: 0, canManage: false });
    });

    it('a read fault degrades to an empty list (safeFetch), not a 500', async () => {
        on('operations', { error: { code: 'PGRST201', message: 'ambiguous' } });
        await expect(getOperations(asUser(MEMBER))).resolves.toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('assertOpVisibleToUser — the sub-resource action gate', () => {
    it('no user → Authentication required, before any query', async () => {
        await expect(assertOpVisibleToUser('op-1', null)).rejects.toThrow('Authentication required.');
        expect(fake.queries).toHaveLength(0);
    });

    it('a read fault throws (never a silent pass)', async () => {
        on('operations', { error: { message: 'x' } });
        await expect(assertOpVisibleToUser('op-1', MEMBER)).rejects.toThrow('Failed to verify operation access');
    });

    it('a missing op throws not-found', async () => {
        on('operations', { data: null });
        await expect(assertOpVisibleToUser('op-1', MEMBER)).rejects.toThrow('Operation not found.');
        const q = queriesOn('operations')[0];
        expect(cols(q)).toBe('id, owner_id, is_special, clearance_level, limiting_markers:operation_limiting_markers(marker:security_limiting_markers(id, name, code))');
    });

    it('denies a viewer below the op clearance', async () => {
        on('operations', { data: { id: 'op-1', owner_id: 99, is_special: false, clearance_level: 4, limiting_markers: [] } });
        await expect(assertOpVisibleToUser('op-1', CLEARED)).rejects.toThrow('Insufficient clearance to act on this operation.');
    });

    it('denies a viewer missing one of the op markers', async () => {
        on('operations', { data: { id: 'op-1', owner_id: 99, is_special: false, clearance_level: 1, limiting_markers: [MARKER_7, { marker: { id: 8 } }, { marker: null }] } });
        await expect(assertOpVisibleToUser('op-1', CLEARED)).rejects.toThrow('Insufficient clearance');
    });

    it('a null clearance_level is level 0 and passes a level-0 viewer', async () => {
        on('operations', { data: { id: 'op-1', owner_id: 99, is_special: false, clearance_level: null, limiting_markers: null } });
        await expect(assertOpVisibleToUser('op-1', MEMBER)).resolves.toBeUndefined();
    });

    it('the owner passes regardless of clearance', async () => {
        on('operations', { data: { id: 'op-1', owner_id: 10, is_special: false, clearance_level: 9, limiting_markers: [MARKER_7] } });
        await expect(assertOpVisibleToUser('op-1', MEMBER)).resolves.toBeUndefined();
    });

    it('special op: a non-participant is refused, via an ACTIVE-participant lookup', async () => {
        on('operations', { data: { id: 'op-1', owner_id: 99, is_special: true, clearance_level: 0, limiting_markers: [] } });
        on('operation_participants', { data: null });
        await expect(assertOpVisibleToUser('op-1', MEMBER)).rejects.toThrow('Insufficient access to act on this special operation.');
        const pq = queriesOn('operation_participants')[0];
        expect(cols(pq)).toBe('user_id');
        expect(eqs(pq)).toEqual([['operation_id', 'op-1'], ['user_id', 10]]);
        expect(argsOf(pq, 'is')).toEqual([['time_left', null]]);
    });

    it('special op: an active participant passes', async () => {
        on('operations', { data: { id: 'op-1', owner_id: 99, is_special: true, clearance_level: 0, limiting_markers: [] } });
        on('operation_participants', { data: { user_id: 10 } });
        await expect(assertOpVisibleToUser('op-1', MEMBER)).resolves.toBeUndefined();
    });

    it('special op: a join attempt skips the participation gate (the PIN is the invite) but not clearance', async () => {
        on('operations', { data: { id: 'op-1', owner_id: 99, is_special: true, clearance_level: 0, limiting_markers: [] } });
        await expect(assertOpVisibleToUser('op-1', MEMBER, { isJoinAttempt: true })).resolves.toBeUndefined();
        expect(queriesOn('operation_participants')).toHaveLength(0);

        on('operations', { data: { id: 'op-1', owner_id: 99, is_special: true, clearance_level: 2, limiting_markers: [] } });
        await expect(assertOpVisibleToUser('op-1', MEMBER, { isJoinAttempt: true })).rejects.toThrow('Insufficient clearance');
    });

    it('special op: a manager needs no participation lookup', async () => {
        on('operations', { data: { id: 'op-1', owner_id: 99, is_special: true, clearance_level: 5, limiting_markers: [] } });
        await expect(assertOpVisibleToUser('op-1', MANAGER)).resolves.toBeUndefined();
        expect(queriesOn('operation_participants')).toHaveLength(0);
    });

    // READ vs ACT. Former participants (time_left stamped at conclusion) keep READ
    // access; writes stay active-only, and 'act' is the DEFAULT so a caller that forgets
    // the option gets the strict term.
    const specialRow = { data: { id: 'op-1', owner_id: 99, is_special: true, clearance_level: 0, limiting_markers: [] } };

    it("special op, access 'read': the lookup matches ANY roster row (no time_left filter)", async () => {
        on('operations', specialRow);
        on('operation_participants', { data: { user_id: 10 } });
        await expect(assertOpVisibleToUser('op-1', MEMBER, { access: 'read' })).resolves.toBeUndefined();
        const pq = queriesOn('operation_participants')[0];
        expect(cols(pq)).toBe('user_id');
        expect(eqs(pq)).toEqual([['operation_id', 'op-1'], ['user_id', 10]]);
        expect(argsOf(pq, 'is')).toEqual([]);
        expect(has(pq, 'maybeSingle')).toBe(true);
    });

    it("special op, access 'read': no row at all (left / removed / never joined) is still refused", async () => {
        on('operations', specialRow);
        on('operation_participants', { data: null });
        await expect(assertOpVisibleToUser('op-1', MEMBER, { access: 'read' })).rejects.toThrow('Insufficient access to act on this special operation.');
    });

    it("special op, access 'read': a lookup FAULT refuses (fail closed), never passes", async () => {
        on('operations', specialRow);
        on('operation_participants', { data: null, error: { code: '08006', message: 'down' } });
        await expect(assertOpVisibleToUser('op-1', MEMBER, { access: 'read' })).rejects.toThrow('Insufficient access to act on this special operation.');
    });

    it("special op, explicit access 'act' is the same strict lookup as the default", async () => {
        on('operations', specialRow);
        on('operation_participants', { data: null });
        await expect(assertOpVisibleToUser('op-1', MEMBER, { access: 'act' })).rejects.toThrow('Insufficient access to act on this special operation.');
        expect(argsOf(queriesOn('operation_participants')[0], 'is')).toEqual([['time_left', null]]);
    });

    it("access 'read' never relaxes clearance or markers", async () => {
        on('operations', { data: { id: 'op-1', owner_id: 99, is_special: true, clearance_level: 4, limiting_markers: [] } });
        await expect(assertOpVisibleToUser('op-1', CLEARED, { access: 'read' })).rejects.toThrow('Insufficient clearance to act on this operation.');
        on('operations', { data: { id: 'op-1', owner_id: 99, is_special: true, clearance_level: 0, limiting_markers: [{ marker: { id: 8 } }] } });
        await expect(assertOpVisibleToUser('op-1', CLEARED, { access: 'read' })).rejects.toThrow('Insufficient clearance');
        expect(queriesOn('operation_participants')).toHaveLength(0);
    });
});

describe('hasOpReadParticipation — the shared special-op READ participation term', () => {
    it('any roster row counts — active or former', () => {
        expect(hasOpReadParticipation([{ userId: 10 }], 10)).toBe(true);
        expect(hasOpReadParticipation([{ userId: 10, timeLeft: '2026-10-01T00:00:00Z' } as { userId: number }], 10)).toBe(true);
    });

    it('fails closed: no roster, no matching row, a null row id, or a non-numeric viewer id', () => {
        expect(hasOpReadParticipation(undefined, 10)).toBe(false);
        expect(hasOpReadParticipation(null, 10)).toBe(false);
        expect(hasOpReadParticipation([], 10)).toBe(false);
        expect(hasOpReadParticipation([{ userId: 11 }], 10)).toBe(false);
        expect(hasOpReadParticipation([{ userId: null }], 10)).toBe(false);
        expect(hasOpReadParticipation([{ userId: 10 }], '10')).toBe(false);
        expect(hasOpReadParticipation([{ userId: 10 }], undefined)).toBe(false);
        expect(hasOpReadParticipation([{ userId: 10 }], null)).toBe(false);
    });

    it('canUserSeeOpInList admits a FORMER participant of a special op (owner decision 2026-11-02)', () => {
        const op = { clearanceLevel: 0, ownerId: 99, limitingMarkers: [], isSpecial: true, participants: [{ userId: 10, timeLeft: '2026-10-01T00:00:00Z' }] };
        expect(canUserSeeOpInList(MEMBER, op)).toBe(true);
        // …but participation never substitutes for clearance.
        expect(canUserSeeOpInList(MEMBER, { ...op, clearanceLevel: 2 })).toBe(false);
    });
});

describe('participant embeds select time_left on every op read that maps participants', () => {
    const embedOf = (sel: string) => sel.slice(sel.indexOf('participants:operation_participants('), sel.indexOf('log:operation_log_entries('));

    it('list (OPS_SELECT) and detail (getFullOperationDetails) both carry it', async () => {
        on('operations', { data: [] });
        await getOperations(asUser(MEMBER));
        on('operations', { data: opRow() });
        await getFullOperationDetails('op-1');
        const [list, detail] = queriesOn('operations').map((q) => embedOf(cols(q).replace(/\s+/g, ' ')));
        for (const e of [list, detail]) {
            expect(e).toMatch(/^participants:operation_participants\(user_id, joined_at, time_left, is_ready,/);
        }
    });

    it('the mapped op exposes it, so the UI can show who has left', async () => {
        on('operations', { data: opRow({ participants: [{ user_id: 10, joined_at: 'j', time_left: '2026-10-01T00:00:00Z' }, { user_id: 11, joined_at: 'j', time_left: null }] }) });
        const op = await getOperationByIdLite('op-1', asUser(MEMBER));
        expect(op!.participants.map((p) => [p.userId, p.timeLeft])).toEqual([[10, '2026-10-01T00:00:00Z'], [11, null]]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getOperationClassification — server-side label for template stamping', () => {
    it('returns the level and numeric marker ids only', async () => {
        on('operations', { data: { clearance_level: 3, limiting_markers: [{ marker: { id: 7 } }, { marker: null }, { marker: { id: 'x' } }, { marker: { id: 9 } }] } });
        await expect(getOperationClassification('op-1')).resolves.toEqual({ classificationLevel: 3, markerIds: [7, 9] });
        expect(cols(queriesOn('operations')[0])).toBe('clearance_level, limiting_markers:operation_limiting_markers(marker:security_limiting_markers(id))');
    });

    // BUG PINNED: both of these used to return { classificationLevel: 0, markerIds: [] },
    // stamping a classified op's extracted plan as an UNCLASSIFIED template.
    it('a read fault refuses — it must never stamp the template unclassified', async () => {
        on('operations', { error: { code: '08006', message: 'connection reset' } });
        await expect(getOperationClassification('op-1')).rejects.toThrow('Failed to read operation classification');
    });

    it('an op deleted mid-request has no classification to stamp — refuse', async () => {
        on('operations', { data: null });
        await expect(getOperationClassification('op-1')).rejects.toThrow('Operation not found.');
    });

    it('an op with no markers embed is its level with no markers', async () => {
        on('operations', { data: { clearance_level: null } });
        await expect(getOperationClassification('op-1')).resolves.toEqual({ classificationLevel: 0, markerIds: [] });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getOperationByIdLite — the realtime slice row', () => {
    it('no user → null with no query', async () => {
        await expect(getOperationByIdLite('op-1', null)).resolves.toBeNull();
        expect(fake.queries).toHaveLength(0);
    });

    it('THROWS on a read fault (null would evict a live op from every list)', async () => {
        on('operations', { error: { message: 'x' } });
        await expect(getOperationByIdLite('op-1', asUser(MEMBER))).rejects.toThrow('Failed to get operation slice');
    });

    it('a missing row → null', async () => {
        on('operations', { data: null });
        await expect(getOperationByIdLite('op-1', asUser(MEMBER))).resolves.toBeNull();
        const q = queriesOn('operations')[0];
        expect(eqs(q)).toEqual([['id', 'op-1']]);
        expect(cols(q)).not.toMatch(/\*/);
    });

    it('an op the viewer cannot see → null (same predicate as the list)', async () => {
        on('operations', { data: opRow({ limiting_markers: [MARKER_7] }) });
        await expect(getOperationByIdLite('op-1', asUser(MEMBER))).resolves.toBeNull();
    });

    it('a visible op ships without the join PIN for a non-owner', async () => {
        on('operations', { data: opRow({ join_code: 'PIN-ABCDEF' }) });
        const op = await getOperationByIdLite('op-1', asUser(MEMBER));
        expect(op!.id).toBe('op-1');
        expect(op!.joinCode).toBeUndefined();
    });

    it('the owner keeps the PIN on the slice', async () => {
        on('operations', { data: opRow({ owner_id: 10, join_code: 'PIN-ABCDEF' }) });
        const op = await getOperationByIdLite('op-1', asUser(MEMBER));
        expect(op!.joinCode).toBe('PIN-ABCDEF');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getFullOperationDetails — the detail fan-out', () => {
    it('a fault on the operation row throws', async () => {
        on('operations', { error: { message: 'x' } });
        await expect(getFullOperationDetails('op-1')).rejects.toThrow('Failed to get operation details');
    });

    it('reads every sub-resource with an explicit, op-scoped projection and nests seats under slots', async () => {
        on('operations', { data: opRow({ id: 'op-1' }) });
        on('operation_phases', { data: [{ id: 1, operation_id: 'op-1', name: 'Insert', sort_order: 0, status: 'Pending' }] });
        on('operation_ship_slots', { data: [{ id: 5, operation_id: 'op-1', label: 'Hammerhead', capacity: 2 }, { id: 6, operation_id: 'op-1', label: 'Escort', capacity: 1 }] });
        on('operation_slot_assignments', {
            data: [
                { id: 1, slot_id: 5, user_id: 4, status: 'assigned' },
                { id: 2, slot_id: 5, user_id: 8, status: 'applied' },
                { id: 3, slot_id: 'bogus', user_id: 9, status: 'assigned' },
            ],
        });
        // A soft-failing sub-read degrades to [] rather than killing the detail view.
        on('operation_logistics', { error: { code: '42P01', message: 'missing' } });

        const op = await getFullOperationDetails('op-1');

        const tables = ['operation_phases', 'operation_schedule_entries', 'operation_tasks', 'operation_command_nodes',
            'operation_board_elements', 'operation_logistics', 'operation_aar_entries', 'operation_locations',
            'operation_allied_orgs', 'operation_allied_participants', 'operation_ship_slots', 'operation_slot_assignments'];
        for (const t of tables) {
            const q = queriesOn(t);
            expect(q, t).toHaveLength(1);
            expect(cols(q[0]), t).not.toMatch(/\*/);
            expect(eqs(q[0]), t).toEqual([['operation_id', 'op-1']]);
        }
        // Seats are capped and totally ordered; assignments carry no assigned_by.
        const slotsQ = queriesOn('operation_ship_slots')[0];
        expect(argsOf(slotsQ, 'order')).toEqual([['sort_order'], ['id']]);
        expect(argsOf(slotsQ, 'limit')).toEqual([[200]]);
        const asgQ = queriesOn('operation_slot_assignments')[0];
        expect(cols(asgQ)).toBe('id, operation_id, slot_id, user_id, status, user_ship_id, created_at, updated_at');
        expect(argsOf(asgQ, 'limit')).toEqual([[1000]]);

        expect(op.phases).toHaveLength(1);
        expect(op.logistics).toEqual([]);
        const slots = op.shipSlots as unknown as Array<{ id: number; assignments: Array<{ userId: number }> }>;
        expect(slots.map((s) => s.id)).toEqual([5, 6]);
        expect(slots[0].assignments.map((a) => a.userId)).toEqual([4, 8]);
        expect(slots[1].assignments).toEqual([]);
    });
});

describe('getOperationOwnerId', () => {
    it('returns owner_id from a narrow read', async () => {
        on('operations', { data: { owner_id: 42 } });
        await expect(getOperationOwnerId('op-1')).resolves.toBe(42);
        expect(cols(readsOn('operations')[0])).toBe('owner_id');
    });

    it('a row without an owner → null', async () => {
        on('operations', { data: null });
        await expect(getOperationOwnerId('op-1')).resolves.toBeNull();
    });

    it('a fault throws', async () => {
        on('operations', { error: { message: 'x' } });
        await expect(getOperationOwnerId('op-1')).rejects.toThrow('Failed to fetch operation owner');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('read-path edge shapes', () => {
    it('getOperations: a null result set is an empty list with no "all filtered" warning', async () => {
        on('operations', { data: null });
        await expect(getOperations(asUser(MEMBER))).resolves.toEqual([]);
        expect(warnings(/all ops filtered out/)).toHaveLength(0);
    });

    it('getOperations: a viewer with no clearance record or permissions is level 0 and cannot manage', async () => {
        on('operations', { data: [opRow({ clearance_level: 1 })] });
        await expect(getOperations(asUser({ id: 10 }))).resolves.toEqual([]);
        expect(warnings(/all ops filtered out/)[0].fields).toMatchObject({ clearanceLevel: 0, canManage: false });
    });

    it('getFullOperationDetails: a null assignments read and an id-less slot both yield empty seat lists', async () => {
        on('operations', { data: opRow() });
        on('operation_ship_slots', { data: [{ operation_id: 'op-1', label: 'No id' }, { id: 5, operation_id: 'op-1', label: 'Ship' }] });
        on('operation_slot_assignments', { data: null });
        const op = await getFullOperationDetails('op-1');
        const slots = op.shipSlots as unknown as Array<{ label: string; assignments: unknown[] }>;
        expect(slots.map((s) => [s.label, s.assignments])).toEqual([['No id', []], ['Ship', []]]);
    });

    it('getFullOperationDetails: a null slots read yields no slots', async () => {
        on('operations', { data: opRow() });
        on('operation_ship_slots', { data: null });
        const op = await getFullOperationDetails('op-1');
        expect(op.shipSlots).toEqual([]);
    });
});
