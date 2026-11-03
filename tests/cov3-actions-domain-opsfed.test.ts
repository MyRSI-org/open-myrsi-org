import { describe, it, expect, vi, beforeEach } from 'vitest';

// Handler-level suite for api/actions/operations-federation.ts (db layer mocked).
//
// The in-handler gate: mirror:get may reveal a PENDING (not yet accepted) mirror
// invite only to a diplomacy admin — a caller holding alliance:manage. Permission
// only: a role NAMED 'Admin' without the permission, a missing user, or a malformed
// permissions value all get the accepted-only view. Everything else is pinned for
// exact argument forwarding (mirror:rsvp reorders its arguments for the db layer).

const spies = vi.hoisted(() => ({
    inviteAllyToOperation: vi.fn(),
    revokeAllyFromOperation: vi.fn(),
    listMirroredOperations: vi.fn(),
    getMirroredOperation: vi.fn(),
    acceptMirroredOperation: vi.fn(),
    declineMirroredOperation: vi.fn(),
    pollMirroredOperation: vi.fn(),
    rsvpMirroredOperation: vi.fn(),
    removeMirroredRsvp: vi.fn(),
}));

vi.mock('../lib/db', () => ({ ...spies }));

import { operationsFederationActions } from '../api/actions/operations-federation';

type Handler = (p?: unknown) => unknown;
const call = (name: string, p?: unknown) => (operationsFederationActions as unknown as Record<string, Handler>)[name](p);

beforeEach(() => {
    for (const s of Object.values(spies)) s.mockReset();
});

describe('host invite / revoke', () => {
    it('operation:invite_ally and operation:revoke_ally forward (operationId, peerId)', async () => {
        spies.inviteAllyToOperation.mockResolvedValue({ invited: true });
        await expect(call('operation:invite_ally', { operationId: 'op-1', peerId: 'peer-1' })).resolves.toEqual({ invited: true });
        await call('operation:revoke_ally', { operationId: 'op-1', peerId: 'peer-2' });
        expect(spies.inviteAllyToOperation).toHaveBeenCalledWith('op-1', 'peer-1');
        expect(spies.revokeAllyFromOperation).toHaveBeenCalledWith('op-1', 'peer-2');
    });
});

describe('mirror lists', () => {
    it('mirror:list asks for accepted mirrors only; mirror:list_pending asks for pending', async () => {
        spies.listMirroredOperations.mockResolvedValueOnce([{ id: 'm1' }]).mockResolvedValueOnce([{ id: 'm2' }]);
        await expect(call('mirror:list')).resolves.toEqual([{ id: 'm1' }]);
        await expect(call('mirror:list_pending')).resolves.toEqual([{ id: 'm2' }]);
        expect(spies.listMirroredOperations.mock.calls).toEqual([[false], [true]]);
    });
});

describe('mirror:get — pending visibility is alliance:manage only', () => {
    it('an alliance:manage holder may see a pending mirror', async () => {
        spies.getMirroredOperation.mockResolvedValue({ id: 'm1' });
        await expect(call('mirror:get', { id: 'm1', user: { permissions: ['operations:view', 'alliance:manage'] } })).resolves.toEqual({ id: 'm1' });
        expect(spies.getMirroredOperation).toHaveBeenCalledWith('m1', true);
    });

    it('an ordinary member may not', async () => {
        await call('mirror:get', { id: 'm1', user: { permissions: ['operations:view', 'alliance:view'] } });
        expect(spies.getMirroredOperation).toHaveBeenCalledWith('m1', false);
    });

    it('a role NAMED Admin without the permission may not (no role-name bypass)', async () => {
        await call('mirror:get', { id: 'm1', user: { role: 'Admin', permissions: [] } });
        expect(spies.getMirroredOperation).toHaveBeenCalledWith('m1', false);
    });

    it('a missing user, or a user with no permissions array, may not', async () => {
        await call('mirror:get', { id: 'm1' });
        await call('mirror:get', { id: 'm2', user: {} });
        expect(spies.getMirroredOperation.mock.calls).toEqual([['m1', false], ['m2', false]]);
    });
});

describe('mirror lifecycle', () => {
    it.each([
        ['mirror:accept', 'acceptMirroredOperation'],
        ['mirror:decline', 'declineMirroredOperation'],
        ['mirror:poll', 'pollMirroredOperation'],
    ] as Array<[string, keyof typeof spies]>)('%s addresses the mirror by id and returns the db result', async (action, fn) => {
        spies[fn].mockResolvedValue({ ok: fn });
        await expect(call(action, { id: 'm1', user: { permissions: ['alliance:manage'] } })).resolves.toEqual({ ok: fn });
        expect(spies[fn]).toHaveBeenCalledWith('m1');
    });

    it('mirror:rsvp reorders to (id, actor, status, shipText, isReady)', async () => {
        spies.rsvpMirroredOperation.mockResolvedValue({ rsvp: 'Attending' });
        await expect(call('mirror:rsvp', { id: 'm1', rsvpStatus: 'Attending', shipText: 'Cutlass Red', isReady: true, userId: 7 }))
            .resolves.toEqual({ rsvp: 'Attending' });
        expect(spies.rsvpMirroredOperation).toHaveBeenCalledWith('m1', 7, 'Attending', 'Cutlass Red', true);
    });

    it('mirror:rsvp_remove withdraws the actor\'s own participation', async () => {
        await call('mirror:rsvp_remove', { id: 'm1', userId: 7 });
        expect(spies.removeMirroredRsvp).toHaveBeenCalledWith('m1', 7);
    });

    it('a db refusal propagates', async () => {
        spies.acceptMirroredOperation.mockRejectedValue(new Error('Mirror not found'));
        await expect(call('mirror:accept', { id: 'nope' })).rejects.toThrow('Mirror not found');
    });
});
