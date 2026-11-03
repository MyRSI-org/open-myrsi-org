import { describe, it, expect, vi, beforeEach } from 'vitest';

// Handler-level suite for api/actions/alliances.ts (db layer mocked).
//
// The handlers are thin; the one in-handler rule is on alliance:update_peer:
// LOWERING a peer's outbound clearance ceiling changes no operation, so the peer
// never re-pulls on its own — the handler must reconcile (pull back) any shared op
// that now exceeds the new ceiling. That reconcile must run for ANY explicit
// outboundMaxClearance (0 included — the most restrictive value), must run only
// AFTER the update is persisted, and must not run when the update failed.

const spies = vi.hoisted(() => ({
    generatePairingCode: vi.fn(),
    createOrUpdatePeer: vi.fn(),
    connectPeer: vi.fn(),
    listAlliancePeers: vi.fn(),
    updateAlliancePeer: vi.fn(),
    reconcilePeerClearanceShares: vi.fn(),
    revokeAlliancePeer: vi.fn(),
    getAllianceDirectory: vi.fn(),
    getAllianceSelfProfile: vi.fn(),
    saveAllianceSelfProfile: vi.fn(),
    fetchPeerRoster: vi.fn(),
    fetchPeerFleet: vi.fn(),
    forceSyncPeer: vi.fn(),
}));

vi.mock('../lib/db', () => ({ ...spies }));

import { allianceActions } from '../api/actions/alliances';

type Handler = (p?: unknown) => unknown;
const call = (name: string, p?: unknown) => (allianceActions as unknown as Record<string, Handler>)[name](p);

beforeEach(() => {
    for (const s of Object.values(spies)) s.mockReset();
    spies.updateAlliancePeer.mockResolvedValue(undefined);
    spies.reconcilePeerClearanceShares.mockResolvedValue(undefined);
});

describe('trust bootstrap', () => {
    it('alliance:generate_code returns the db-minted code and takes no caller input', async () => {
        spies.generatePairingCode.mockResolvedValue({ code: 'PAIR-ABC123', expiresAt: 'later' });
        await expect(call('alliance:generate_code', { code: 'attacker-chosen' })).resolves.toEqual({ code: 'PAIR-ABC123', expiresAt: 'later' });
        expect(spies.generatePairingCode).toHaveBeenCalledWith();
    });

    it('alliance:add_peer forwards the payload', async () => {
        const payload = { label: 'Northstar', baseUrl: 'https://northstar.example', peerCode: 'PAIR-XYZ', type: 'allied' };
        spies.createOrUpdatePeer.mockResolvedValue({ id: 'peer-1' });
        await expect(call('alliance:add_peer', payload)).resolves.toEqual({ id: 'peer-1' });
        expect(spies.createOrUpdatePeer).toHaveBeenCalledWith(payload);
    });

    it('alliance:connect_peer addresses the peer by id', async () => {
        await call('alliance:connect_peer', { peerId: 'peer-1' });
        expect(spies.connectPeer).toHaveBeenCalledWith('peer-1');
    });
});

describe('alliance:update_peer', () => {
    it('lowering the outbound ceiling persists the update, THEN reconciles the shared ops', async () => {
        const updates = { label: 'Northstar', outboundMaxClearance: 1 };
        await expect(call('alliance:update_peer', { peerId: 'peer-1', updates })).resolves.toBeUndefined();
        expect(spies.updateAlliancePeer).toHaveBeenCalledWith('peer-1', updates);
        expect(spies.reconcilePeerClearanceShares).toHaveBeenCalledWith('peer-1');
        expect(spies.updateAlliancePeer.mock.invocationCallOrder[0])
            .toBeLessThan(spies.reconcilePeerClearanceShares.mock.invocationCallOrder[0]);
    });

    it('an outbound ceiling of 0 (the most restrictive) still reconciles', async () => {
        await call('alliance:update_peer', { peerId: 'peer-1', updates: { outboundMaxClearance: 0 } });
        expect(spies.reconcilePeerClearanceShares).toHaveBeenCalledWith('peer-1');
    });

    it('an update that does not touch the outbound ceiling does not reconcile', async () => {
        await call('alliance:update_peer', { peerId: 'peer-1', updates: { label: 'Renamed', inboundMaxClearance: 3, channels: { roster: true } } });
        expect(spies.updateAlliancePeer).toHaveBeenCalledWith('peer-1', { label: 'Renamed', inboundMaxClearance: 3, channels: { roster: true } });
        expect(spies.reconcilePeerClearanceShares).not.toHaveBeenCalled();
    });

    it('a missing updates object is passed through and does not reconcile', async () => {
        await call('alliance:update_peer', { peerId: 'peer-1' });
        expect(spies.updateAlliancePeer).toHaveBeenCalledWith('peer-1', undefined);
        expect(spies.reconcilePeerClearanceShares).not.toHaveBeenCalled();
    });

    it('a failed update propagates and never reconciles', async () => {
        spies.updateAlliancePeer.mockRejectedValue(new Error('Peer not found'));
        await expect(call('alliance:update_peer', { peerId: 'peer-1', updates: { outboundMaxClearance: 0 } })).rejects.toThrow('Peer not found');
        expect(spies.reconcilePeerClearanceShares).not.toHaveBeenCalled();
    });

    it('a failed reconcile propagates (the caller must learn shares were not pulled back)', async () => {
        spies.reconcilePeerClearanceShares.mockRejectedValue(new Error('reconcile failed'));
        await expect(call('alliance:update_peer', { peerId: 'peer-1', updates: { outboundMaxClearance: 1 } })).rejects.toThrow('reconcile failed');
    });
});

describe('management, directory and live-sync handlers', () => {
    it('alliance:list_peers / get_directory / get_self_profile return the db result', async () => {
        spies.listAlliancePeers.mockResolvedValue([{ id: 'peer-1' }]);
        spies.getAllianceDirectory.mockResolvedValue([{ id: 'org-1' }]);
        spies.getAllianceSelfProfile.mockResolvedValue({ name: 'Acme' });
        await expect(call('alliance:list_peers')).resolves.toEqual([{ id: 'peer-1' }]);
        await expect(call('alliance:get_directory')).resolves.toEqual([{ id: 'org-1' }]);
        await expect(call('alliance:get_self_profile')).resolves.toEqual({ name: 'Acme' });
        expect(spies.listAlliancePeers).toHaveBeenCalledWith();
        expect(spies.getAllianceDirectory).toHaveBeenCalledWith();
        expect(spies.getAllianceSelfProfile).toHaveBeenCalledWith();
    });

    it('alliance:save_self_profile forwards only the profile object', async () => {
        const profile = { name: 'Acme', motto: 'Fly safe' };
        await call('alliance:save_self_profile', { profile, userId: 1 });
        expect(spies.saveAllianceSelfProfile).toHaveBeenCalledWith(profile);
    });

    it.each([
        ['alliance:delete_peer', 'revokeAlliancePeer'],
        ['alliance:fetch_peer_roster', 'fetchPeerRoster'],
        ['alliance:fetch_peer_fleet', 'fetchPeerFleet'],
        ['alliance:force_sync', 'forceSyncPeer'],
    ] as Array<[string, keyof typeof spies]>)('%s addresses the peer by id and returns the db result', async (action, fn) => {
        spies[fn].mockResolvedValue({ ok: fn });
        await expect(call(action, { peerId: 'peer-7' })).resolves.toEqual({ ok: fn });
        expect(spies[fn]).toHaveBeenCalledWith('peer-7');
    });

    it('a db refusal propagates (e.g. the force-sync cooldown)', async () => {
        spies.forceSyncPeer.mockRejectedValue(new Error('Sync cooldown active'));
        await expect(call('alliance:force_sync', { peerId: 'peer-7' })).rejects.toThrow('Sync cooldown active');
    });
});
