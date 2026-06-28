import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// =============================================================================
// Federation auth boundary: GET /api/alliance/profile must gate on
// an ACTIVE alliance peer (getAlliancePeerByInboundKey) — exactly like every
// other inbound federation route — NOT on a raw api_keys hash match
// (verifyApiKey). The raw match also admits manual / legacy intel-feed keys that
// were never an alliance peer, leaking the org's self-profile (orgName, orgTag,
// iconUrl, blurb, contactDiscord) to non-allied key holders. It must also honor
// the operator's directoryVisible opt-out.
//
// Two complementary checks:
//   (1) BEHAVIOURAL — the gate predicate the route uses really does
//       distinguish a manual key (verifyApiKey truthy, getAlliancePeerByInboundKey
//       null) from an Active peer (both truthy). Supabase mocked, following the
//       sec-alliances.test.ts / marketplaceSecurity.test.ts precedents.
//   (2) SOURCE — the route handler in server.ts is wired to the Active-peer gate
//       and consults directoryVisible (rather than calling allianceVerifyApiKey
//       and ignoring directoryVisible).
// =============================================================================

const h = vi.hoisted(() => ({
    state: {
        apiKeysRow: null as { id: string; label: string } | null,
        peerRow: null as Record<string, unknown> | null,
        peerEqCalls: [] as Array<[string, unknown]>,
    },
}));

// Mock the db barrel-common module so verifyApiKey (lib/db/system) and
// getAlliancePeerByInboundKey (lib/db/alliances) run without a live Supabase.
// A tiny chainable builder routes results by table name.
vi.mock('../lib/db/common.js', () => {
    const makeBuilder = (table: string) => {
        const builder: Record<string, unknown> = {
            select: () => builder,
            update: () => builder,
            insert: () => builder,
            eq: (col: string, val: unknown) => {
                if (table === 'alliance_peers') h.state.peerEqCalls.push([col, val]);
                return builder;
            },
            maybeSingle: async () => {
                if (table === 'api_keys') return { data: h.state.apiKeysRow, error: null };
                if (table === 'alliance_peers') return { data: h.state.peerRow, error: null };
                return { data: null, error: null };
            },
            // `.update(...).eq(...)` is awaited directly (verifyApiKey's
            // last_used_at bump) — make the builder itself thenable.
            then: (res: (v: { data: null; error: null }) => unknown) => res({ data: null, error: null }),
        };
        return builder;
    };
    return {
        supabase: { from: (table: string) => makeBuilder(table) },
        handleSupabaseError: () => {},
        broadcastToOrg: () => {},
        broadcastToChannel: () => {},
        safeFetch: async () => [],
        getSystemRoles: async () => ({}),
    };
});

import { verifyApiKey } from '../lib/db/system';
import { getAlliancePeerByInboundKey } from '../lib/db/alliances';

describe('/api/alliance/profile gate predicate (behavioural)', () => {
    beforeEach(() => {
        h.state.apiKeysRow = null;
        h.state.peerRow = null;
        h.state.peerEqCalls = [];
    });

    it('a manual/legacy api_keys row verifies but is NOT an Active alliance peer', async () => {
        // The api_keys hash matches (a manual intel-feed key the admin issued to a
        // non-allied subscriber), but no Active alliance_peers row owns it.
        h.state.apiKeysRow = { id: 'k-manual', label: 'feed:subscriber-x' };
        h.state.peerRow = null;

        // A raw api_keys verifier would ADMIT this key → leak.
        expect(await verifyApiKey('manual-feed-key')).toBeTruthy();
        // The Active-peer resolver DENIES it.
        expect(await getAlliancePeerByInboundKey('manual-feed-key')).toBeNull();
    });

    it('an Active alliance peer resolves through the gate (legitimate caller preserved)', async () => {
        h.state.apiKeysRow = { id: 'k-peer', label: 'alliance:peer-1' };
        h.state.peerRow = { id: 'peer-1', status: 'Active', sync_health: 'ok' };

        expect(await verifyApiKey('peer-key')).toBeTruthy();
        const peer = await getAlliancePeerByInboundKey('peer-key');
        expect(peer).not.toBeNull();
        expect(peer!.id).toBe('peer-1');
    });

    it('the peer lookup is scoped to status=Active and the verified key id', async () => {
        h.state.apiKeysRow = { id: 'k-peer', label: 'alliance:peer-1' };
        h.state.peerRow = { id: 'peer-1', status: 'Active', sync_health: 'ok' };

        await getAlliancePeerByInboundKey('peer-key');
        // The Active-status filter is part of the gate (a Pending/revoked row,
        // or a manual key, never resolves).
        expect(h.state.peerEqCalls).toContainEqual(['status', 'Active']);
        expect(h.state.peerEqCalls).toContainEqual(['inbound_key_id', 'k-peer']);
    });

    it('no api_keys row at all → both predicates deny (fail closed)', async () => {
        h.state.apiKeysRow = null;
        h.state.peerRow = null;
        expect(await verifyApiKey('nope')).toBeNull();
        expect(await getAlliancePeerByInboundKey('nope')).toBeNull();
    });
});

describe('/api/alliance/profile route wiring (server.ts source)', () => {
    const src = readFileSync(resolve(__dirname, '..', 'server.ts'), 'utf8');
    const start = src.indexOf("'/api/alliance/profile'");
    const end = src.indexOf("'/api/alliance/data'");
    const routeBlock = src.slice(start, end);

    it('the profile route exists and is bounded before the data route', () => {
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
    });

    it('gates on the Active-peer resolver, not the raw api_keys verifier', () => {
        expect(routeBlock).toContain('allianceGetPeerByInboundKey(');
        // allianceVerifyApiKey must not be used by the route (or anywhere in the
        // module), leaving no fail-open path.
        expect(routeBlock).not.toContain('allianceVerifyApiKey(');
        expect(src).not.toContain('allianceVerifyApiKey');
    });

    it('honors the operator directoryVisible opt-out before serving the card', () => {
        expect(routeBlock).toContain('directoryVisible');
    });

    it('still denies with 403 when the caller is not an Active peer', () => {
        expect(routeBlock).toContain("res.status(403)");
    });
});
