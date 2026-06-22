// api/actions/alliances.ts — RPC handlers for the Alliances federation feature.
// Mutations require 'alliance:manage'; directory/profile reads require
// 'alliance:view' (see fullPermissionMap in api/services.ts). The inbound
// handshake responder is NOT here — it is a server-to-server HTTP endpoint
// (POST /api/alliance/pair in server.ts), not a browser RPC.

import * as db from '../../lib/db.js';
import type { AllianceType, AllianceChannels, AllianceSelfProfile } from '../../types.js';

interface AddPeerPayload {
    label: string;
    baseUrl: string;
    peerCode: string;
    type?: AllianceType;
}
interface PeerIdPayload { peerId: string }
interface UpdatePeerPayload {
    peerId: string;
    updates: {
        label?: string;
        type?: AllianceType;
        inboundMaxClearance?: number;
        outboundMaxClearance?: number;
        channels?: AllianceChannels;
    };
}
interface SaveSelfProfilePayload { profile: Partial<AllianceSelfProfile> }

export const allianceActions = {
    // Trust bootstrap
    'alliance:generate_code': () => db.generatePairingCode(),
    'alliance:add_peer': (payload: AddPeerPayload) => db.createOrUpdatePeer(payload),
    'alliance:connect_peer': ({ peerId }: PeerIdPayload) => db.connectPeer(peerId),

    // Management
    'alliance:list_peers': () => db.listAlliancePeers(),
    'alliance:update_peer': async ({ peerId, updates }: UpdatePeerPayload) => {
        await db.updateAlliancePeer(peerId, updates);
        // Lowering the clearance ceiling doesn't change any op, so the peer won't
        // re-pull on its own. Pull back any shared ops that now exceed the new ceiling.
        if (updates && updates.outboundMaxClearance !== undefined) {
            await db.reconcilePeerClearanceShares(peerId);
        }
    },
    'alliance:delete_peer': ({ peerId }: PeerIdPayload) => db.revokeAlliancePeer(peerId),

    // Directory + self profile
    'alliance:get_directory': () => db.getAllianceDirectory(),
    'alliance:get_self_profile': () => db.getAllianceSelfProfile(),
    'alliance:save_self_profile': ({ profile }: SaveSelfProfilePayload) => db.saveAllianceSelfProfile(profile),

    // Fetch an ally's shared roster / fleet summary (server-to-server pull,
    // returned to the browser; outbound keys never reach the client). Served
    // from the live-sync directory cache when fresh.
    'alliance:fetch_peer_roster': ({ peerId }: PeerIdPayload) => db.fetchPeerRoster(peerId),
    'alliance:fetch_peer_fleet': ({ peerId }: PeerIdPayload) => db.fetchPeerFleet(peerId),

    // Live-sync: admin "Sync now" — run every applicable sync job for one peer
    // immediately (budget-gated + cooldown inside forceSyncPeer).
    'alliance:force_sync': ({ peerId }: PeerIdPayload) => db.forceSyncPeer(peerId),
};
