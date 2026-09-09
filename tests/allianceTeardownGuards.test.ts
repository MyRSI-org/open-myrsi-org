import { describe, it, expect, vi, beforeEach } from 'vitest';

// Federation teardown scoping in lib/db/system.ts — deleteTrustedFeed /
// updateTrustedFeed (below) and deleteApiKey (bottom of file).
//
// Feeds and handshake-paired allies are rows in the SAME table (alliance_peers),
// discriminated only by pairing_state. The read half (getTrustedFeeds) and the add
// half (addTrustedFeed) were scoped to FEED_PAIRING_STATES; the id-addressed delete
// and update were not, so a copied peer id purged a live ally — cascading our own
// members' RSVPs on every joint op that ally hosts, nulling intel provenance (which
// disables the partial dedup indexes) and discarding the revoked_at audit record.
//
// Pinned here:
//   - every feed verb is filtered by the discriminator, INSIDE the statement
//   - a denial is opaque across not-found vs paired-ally (no existence oracle)
//   - a Supabase error is surfaced, not swallowed, and never broadcasts success
//   - malformed ids fail before any query runs
//   - the channels merge cannot be fed by a swallowed read (which REPLACES the
//     jsonb and desynchronises getTrustedFeeds from syncTrustedFeeds)

const h = vi.hoisted(() => ({
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    // `matched` is the row count the statement's own filters selected — the
    // assertion that matters, since the guard lives INSIDE the delete/update.
    mutations: [] as Array<{ table: string; op: string; matched: number; values: Record<string, unknown> | null }>,
    emits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    fail: null as null | ((table: string, op: string) => boolean),
}));

vi.mock('../lib/db/common', () => {
    function builder(table: string) {
        const state = {
            op: 'select' as string,
            values: null as Record<string, unknown> | null,
            eq: {} as Record<string, unknown>,
            ins: {} as Record<string, unknown[]>,
            notIns: {} as Record<string, unknown[]>,
            returning: false,
        };
        // Membership filters are applied as membership tests, NOT folded into the
        // eq map: doing the latter rejects every row, which makes deny-cases pass
        // vacuously and allow-cases fail.
        const rows = () => (h.tables[table] ?? []).filter((r) =>
            Object.entries(state.eq).every(([c, v]) => r[c] === v)
            && Object.entries(state.ins).every(([c, vs]) => vs.includes(r[c]))
            && Object.entries(state.notIns).every(([c, vs]) => !vs.includes(r[c])));

        const b: any = {};
        b.select = () => { state.returning = true; return b; };
        b.update = (v: Record<string, unknown>) => { state.op = 'update'; state.values = v; return b; };
        b.insert = (v: Record<string, unknown>) => { state.op = 'insert'; state.values = v; return b; };
        b.delete = () => { state.op = 'delete'; return b; };
        b.eq = (c: string, v: unknown) => { state.eq[c] = v; return b; };
        b.in = (c: string, vs: readonly unknown[]) => { state.ins[c] = [...vs]; return b; };
        // PostgREST spells NOT IN as .not(col, 'in', '(a,b)').
        b.not = (c: string, op: string, literal: string) => {
            if (op === 'in') state.notIns[c] = String(literal).replace(/^\(|\)$/g, '').split(',');
            return b;
        };
        b.is = () => b; b.order = () => b; b.limit = () => b; b.gt = () => b; b.neq = () => b;

        const settle = (mode: 'many' | 'single') => {
            if (h.fail?.(table, state.op)) {
                return Promise.resolve({ data: null, error: { message: 'simulated failure' } });
            }
            if (state.op === 'select') {
                const data = rows();
                return Promise.resolve({ data: mode === 'single' ? (data[0] ?? null) : data, error: null });
            }
            const matched = rows();
            h.mutations.push({ table, op: state.op, matched: matched.length, values: state.values });
            const list = (h.tables[table] = h.tables[table] ?? []);
            if (state.op === 'update') for (const r of matched) Object.assign(r, state.values);
            if (state.op === 'delete') for (const r of matched) list.splice(list.indexOf(r), 1);
            if (state.op === 'insert') list.push({ ...(state.values as Record<string, unknown>) });
            return Promise.resolve({ data: state.returning ? matched.map((r) => ({ id: r.id })) : null, error: null });
        };
        b.single = () => settle('single');
        b.maybeSingle = () => settle('single');
        b.then = (resolve: any, reject: any) => settle('many').then(resolve, reject);
        return b;
    }
    return {
        supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => { if (error) throw new Error(message); },
        broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => { h.emits.push({ event, payload }); },
        broadcastToChannel: () => {},
        safeFetch: async (q: any, fallback: unknown) => (await q).data ?? fallback,
        getSystemRoles: async () => ({}),
    };
});

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deleteTrustedFeed, updateTrustedFeed, getTrustedFeeds, deleteApiKey, FEED_PAIRING_STATES } from '../lib/db/system';
import { isSecurityDenial } from '../lib/errors';

// Real uuids: the feed verbs shape-check the id before any query runs.
const F1 = '11111111-1111-4111-8111-111111111111'; // pairing_state 'manual'
const F2 = '22222222-2222-4222-8222-222222222222'; // pairing_state 'legacy'
const P1 = '33333333-3333-4333-8333-333333333333'; // paired ally, 'active'
const P2 = '44444444-4444-4444-8444-444444444444'; // mid-handshake, 'awaiting_peer'
const P3 = '55555555-5555-4555-8555-555555555555'; // torn down, 'revoked'
const GONE = '66666666-6666-4666-8666-666666666666'; // no such row

// api_keys rows. The inbound half of a pairing lives here, not on the peer row.
const K_MANUAL = '77777777-7777-4777-8777-777777777777'; // an ordinary operator key
const K_ALLY = '88888888-8888-4888-8888-888888888888'; // P1's live inbound credential
const K_ORPHAN = '99999999-9999-4999-8999-999999999999'; // reserved label, no peer left
const K_MISLABELLED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // P2's credential, plain label

function peerRow(id: string, pairingState: string, inboundKeyId: string | null = null) {
    return {
        id, label: `row-${pairingState}`, base_url: `https://${pairingState}.example`,
        last_contact_at: null, created_at: '2026-06-01T00:00:00.000Z',
        inbound_max_clearance: 1, outbound_key_enc: 'ak_secret',
        channels: { reports: true, warrants: true, bulletins: true },
        pairing_state: pairingState, inbound_key_id: inboundKeyId,
    };
}

const settingsBroadcasts = () => h.emits.filter((e) => e.event === 'settings_update');
const peerMutations = (op: string) => h.mutations.filter((m) => m.table === 'alliance_peers' && m.op === op);
const keyMutations = (op: string) => h.mutations.filter((m) => m.table === 'api_keys' && m.op === op);
const rowById = (id: string) => h.tables.alliance_peers.find((r) => r.id === id);
const keyById = (id: string) => h.tables.api_keys.find((r) => r.id === id);

beforeEach(() => {
    h.tables = {
        alliance_peers: [
            peerRow(F1, 'manual'),
            peerRow(F2, 'legacy'),
            peerRow(P1, 'active', K_ALLY),
            peerRow(P2, 'awaiting_peer', K_MISLABELLED),
            peerRow(P3, 'revoked'),
        ],
        api_keys: [
            { id: K_MANUAL, label: 'Ops dashboard', key_hash: 'h1' },
            { id: K_ALLY, label: `alliance:${P1}`, key_hash: 'h2' },
            { id: K_ORPHAN, label: `alliance:${GONE}`, key_hash: 'h3' },
            { id: K_MISLABELLED, label: 'imported feed key', key_hash: 'h4' },
        ],
    };
    h.mutations = [];
    h.emits = [];
    h.fail = null;
});

describe('deleteTrustedFeed — the feed API may only delete feed rows', () => {
    it('removes a manual feed and broadcasts exactly once', async () => {
        await deleteTrustedFeed(F1);
        expect(rowById(F1)).toBeUndefined();
        expect(settingsBroadcasts()).toHaveLength(1);
    });

    it('removes a legacy (backfilled) feed', async () => {
        await deleteTrustedFeed(F2);
        expect(rowById(F2)).toBeUndefined();
    });

    it.each([
        ['active', P1],
        ['awaiting_peer', P2],
        ['revoked', P3],
    ])('REFUSES to hard-delete a %s handshake peer', async (_state, id) => {
        await expect(deleteTrustedFeed(id)).rejects.toSatisfy(isSecurityDenial);
        expect(rowById(id)).toBeDefined();
        // The statement may run, but its own discriminator filter must match nothing.
        expect(peerMutations('delete').every((m) => m.matched === 0)).toBe(true);
        expect(settingsBroadcasts()).toHaveLength(0);
    });

    it('denies with 403 and the same message for a missing row as for a paired ally', async () => {
        const missing = await deleteTrustedFeed(GONE).catch((e) => e);
        const paired = await deleteTrustedFeed(P1).catch((e) => e);
        expect(isSecurityDenial(missing)).toBe(true);
        expect(missing.status).toBe(403);
        expect(missing.message).toBe(paired.message);
        expect(settingsBroadcasts()).toHaveLength(0);
    });

    it.each([['empty', ''], ['undefined', undefined], ['not-a-uuid', 'f1']])(
        'rejects a %s id before any query runs', async (_label, id) => {
            await expect(deleteTrustedFeed(id as unknown as string)).rejects.toThrow(/Invalid feedId/);
            expect(h.mutations).toHaveLength(0);
            expect(h.emits).toHaveLength(0);
        });

    it('surfaces a Supabase failure instead of reporting a phantom success', async () => {
        h.fail = (table, op) => table === 'alliance_peers' && op === 'delete';
        const err = await deleteTrustedFeed(F1).catch((e) => e);
        expect(err.message).toBe('Failed to remove feed');
        // A transport failure is NOT an authorization denial.
        expect(isSecurityDenial(err)).toBe(false);
        expect(settingsBroadcasts()).toHaveLength(0);
        expect(rowById(F1)).toBeDefined();
    });
});

describe('updateTrustedFeed — the same discriminator on both halves', () => {
    it('REFUSES to raise a paired ally’s inbound clearance ceiling', async () => {
        await expect(updateTrustedFeed(P1, { inboundMaxClearance: 5 })).rejects.toSatisfy(isSecurityDenial);
        expect(rowById(P1)?.inbound_max_clearance).toBe(1);
        expect(peerMutations('update').every((m) => m.matched === 0)).toBe(true);
        expect(settingsBroadcasts()).toHaveLength(0);
    });

    it('REFUSES to retune a paired ally’s channels, and never reads them into the merge', async () => {
        await expect(updateTrustedFeed(P1, { syncReports: false })).rejects.toSatisfy(isSecurityDenial);
        expect(rowById(P1)?.channels).toEqual({ reports: true, warrants: true, bulletins: true });
        expect(peerMutations('update')).toHaveLength(0);
        expect(settingsBroadcasts()).toHaveLength(0);
    });

    it('merges a feed’s channels rather than replacing them', async () => {
        await updateTrustedFeed(F1, { syncWarrants: false });
        expect(rowById(F1)?.channels).toEqual({ reports: true, warrants: false, bulletins: true });
        expect(settingsBroadcasts()).toHaveLength(1);
    });

    it('a failed channels read aborts the write instead of wiping the jsonb', async () => {
        h.fail = (table, op) => table === 'alliance_peers' && op === 'select';
        await expect(updateTrustedFeed(F1, { syncReports: false })).rejects.toThrow('Failed to load feed');
        expect(rowById(F1)?.channels).toEqual({ reports: true, warrants: true, bulletins: true });
        expect(peerMutations('update')).toHaveLength(0);
        expect(settingsBroadcasts()).toHaveLength(0);
    });

    it('surfaces a failed write instead of broadcasting success', async () => {
        h.fail = (table, op) => table === 'alliance_peers' && op === 'update';
        await expect(updateTrustedFeed(F1, { inboundMaxClearance: 3 })).rejects.toThrow('Failed to update feed');
        expect(settingsBroadcasts()).toHaveLength(0);
    });

    it('a no-op update stays a silent no-op', async () => {
        await updateTrustedFeed(F1, {});
        expect(h.mutations).toHaveLength(0);
        expect(settingsBroadcasts()).toHaveLength(0);
    });
});

describe('the discriminator itself', () => {
    it('getTrustedFeeds lists feed rows only', async () => {
        const feeds = await getTrustedFeeds();
        expect(feeds.map((f) => f.id).sort()).toEqual([F1, F2].sort());
    });

    it('is exported as the single source of truth for the feed half of the table', () => {
        // lib/db/alliances.ts derives its PostgREST exclusion literal from this
        // array; a third feed state must land on both halves at once.
        expect([...FEED_PAIRING_STATES]).toEqual(['legacy', 'manual']);
    });
});

// -----------------------------------------------------------------------------
// The third teardown path: api:delete_key (lib/db/system.ts deleteApiKey).
//
// A pairing's INBOUND credential is not on the peer row — persistKeys mints it
// into api_keys labelled `alliance:<peerId>` (lib/db/alliances.ts), where
// listApiKeys shows it beside ordinary operator keys and admin:config:api — a
// DIFFERENT permission from alliance:manage — could delete it. Because
// alliance_peers.inbound_key_id is ON DELETE SET NULL, that reached across the
// boundary and killed inbound federation silently: the peer row kept reading
// Active while every /api/alliance/* call began 403ing, and the delete swallowed
// its own Supabase error so a failure looked like a success too.
// -----------------------------------------------------------------------------

describe('deleteApiKey — an ally’s inbound credential is not an operator key', () => {
    // SOFT revocation. Revoking used to DELETE the row, which destroyed the record an operator
    // needs after a leak — when the key was issued, when it was last used, who killed it and
    // why. The credential dies the moment revoked_at is stamped (verifyApiKey refuses a revoked
    // row), so nothing is weakened by keeping the row.
    it('revokes an ordinary operator key without destroying the record', async () => {
        await deleteApiKey(K_MANUAL, 42, 'operator');
        const row = keyById(K_MANUAL);
        expect(row).toBeDefined();
        expect(row!.revoked_at).toBeTruthy();
        expect(row!.revoked_by).toBe(42);
        expect(row!.revoked_reason).toBe('operator');
        // The record is the point — nothing is deleted.
        expect(keyMutations('delete')).toHaveLength(0);
    });

    it('REFUSES to delete a paired ally’s inbound credential', async () => {
        const err = await deleteApiKey(K_ALLY).catch((e) => e);
        expect(isSecurityDenial(err)).toBe(true);
        expect(err.status).toBe(403);
        expect(err.message).toMatch(/Alliances peer list/);
        expect(keyById(K_ALLY)).toBeDefined();
        // Not "the delete matched nothing" — no delete is issued at all.
        expect(keyMutations('delete')).toHaveLength(0);
    });

    it('refuses on the FK, not the label, so a mislabelled credential can’t slip past', async () => {
        await expect(deleteApiKey(K_MISLABELLED)).rejects.toSatisfy(isSecurityDenial);
        expect(keyById(K_MISLABELLED)).toBeDefined();
        expect(keyMutations('delete')).toHaveLength(0);
    });

    it('still allows an ORPHANED alliance key to be cleaned up by hand', async () => {
        // Left behind by a hard delete predating the peer-scope guards: the
        // reserved label but no peer row pointing at it. Credential hygiene, not
        // a pairing — the guard must not strand it permanently.
        await deleteApiKey(K_ORPHAN);
        expect(keyById(K_ORPHAN)!.revoked_at).toBeTruthy();
    });

    it('a failed pairing check never reads as “unreferenced”', async () => {
        h.fail = (table, op) => table === 'alliance_peers' && op === 'select';
        await expect(deleteApiKey(K_ALLY)).rejects.toThrow('Failed to check alliance pairing');
        expect(keyById(K_ALLY)).toBeDefined();
        expect(keyMutations('delete')).toHaveLength(0);
    });

    it('surfaces a failed key read instead of deleting unguarded', async () => {
        h.fail = (table, op) => table === 'api_keys' && op === 'select';
        await expect(deleteApiKey(K_ALLY)).rejects.toThrow('Failed to load API key');
        expect(keyMutations('delete')).toHaveLength(0);
    });

    it('surfaces a failed revoke instead of reporting a phantom success', async () => {
        h.fail = (table, op) => table === 'api_keys' && op === 'update';
        await expect(deleteApiKey(K_MANUAL)).rejects.toThrow('Failed to revoke API key');
        expect(keyById(K_MANUAL)!.revoked_at).toBeFalsy();
    });

    it.each([['empty', ''], ['undefined', undefined], ['not-a-uuid', 'k1']])(
        'rejects a %s id before any query runs', async (_label, id) => {
            await expect(deleteApiKey(id as unknown as string)).rejects.toThrow(/Invalid keyId/);
            expect(h.mutations).toHaveLength(0);
        });

    it('stays idempotent for a key that is already gone', async () => {
        await deleteApiKey(GONE);
        expect(h.mutations).toHaveLength(0);
    });

    it('guards the prefix persistKeys actually mints', () => {
        // The behavioural cases above are the real pin; this one catches the other
        // half drifting — if the mint format changes, the guard's prefix must too.
        const src = readFileSync(join(resolve(__dirname, '..'), 'lib', 'db', 'alliances.ts'), 'utf8');
        expect(src).toContain('label: `alliance:${peerId}`');
    });
});
