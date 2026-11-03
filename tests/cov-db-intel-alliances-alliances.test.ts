import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { fake, broadcastSpy, filters, hasCall, columnsOf, assertNoWildcardSelects, type FakeQuery } from './cov-db-intel-alliances-fake';

// =============================================================================
// lib/db/alliances.ts — behaviour coverage for the federation data layer:
// directory/peer CRUD scoping, the dual-code X25519 handshake (both roles),
// peer profile refresh via ssrfSafeFetch, credentialed peer calls, inbound key
// resolution + scope enforcement, roster/fleet PII-minimised projections, and
// the inbound directory cache (sanitise-before-write, fail-closed on 403).
// =============================================================================

const m = vi.hoisted(() => ({
    verifyApiKey: vi.fn(),
    collectShareableIntel: vi.fn(),
    getMaxShareableClearance: vi.fn(),
    getSystemRoles: vi.fn(),
    noteInboundContact: vi.fn(),
    tryConsumeToken: vi.fn(),
    getCachedAllianceSyncConfig: vi.fn(),
    ssrfSafeFetch: vi.fn(),
}));

vi.mock('../lib/db/common.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/db/common.js')>();
    const h = await import('./cov-db-intel-alliances-fake');
    return { ...actual, supabase: h.fake.client, broadcastToOrg: h.broadcastSpy, getSystemRoles: m.getSystemRoles };
});
vi.mock('../lib/db/system.js', () => ({
    collectShareableIntel: m.collectShareableIntel,
    getMaxShareableClearance: m.getMaxShareableClearance,
    verifyApiKey: m.verifyApiKey,
    FEED_PAIRING_STATES: ['legacy', 'manual'],
}));
vi.mock('../lib/db/allianceSyncState.js', () => ({
    getCachedAllianceSyncConfig: m.getCachedAllianceSyncConfig,
    noteInboundContact: m.noteInboundContact,
    tryConsumeToken: m.tryConsumeToken,
}));
vi.mock('../lib/ssrf.js', () => ({ ssrfSafeFetch: m.ssrfSafeFetch }));
// Reversible stand-in so tests can see WHAT was encrypted at rest, and make a
// stored value undecryptable (anything without the enc: prefix throws).
vi.mock('../lib/crypto.js', () => ({
    encryptSecret: (s: string) => `enc:${s}`,
    decryptSecret: (s: string) => {
        if (typeof s !== 'string' || !s.startsWith('enc:')) throw new Error('undecryptable');
        return s.slice(4);
    },
}));

import {
    listAlliancePeers, getAllianceDirectory, updateAlliancePeer, revokeAlliancePeer,
    getAllianceSelfProfile, saveAllianceSelfProfile, generatePairingCode, createOrUpdatePeer,
    connectPeer, respondToPair, refreshPeerProfile, callAlliancePeer, getAlliancePeerByInboundKey,
    getAllianceShareableData, getAllyRosterProjection, getAllyFleetProjection,
    sanitizeRosterProjection, sanitizeFleetProjection, fetchPeerRoster, fetchPeerFleet, refreshPeerDirectory,
    sanitizePeerProfileText,
    deriveSharedSecret, genEphemeral, codeProofMac, responderMac, deriveMaster, ecdhShared, deriveDirectionalKeys,
} from '../lib/db/alliances';
import { SecurityDenial } from '../lib/errors';
import { AllianceType } from '../types';
import type { AllyRosterData, AllyFleetSummary } from '../types';

const PEER_ID = '11111111-2222-4333-8444-555555555555';
const OUR_ORIGIN = 'https://ours.myrsi-alpha.net';
const PEER_ORIGIN = 'https://peer.myrsi-bravo.net';
const PEER_ONLY = 'No handshake-paired ally with that id. Receive-only feeds are managed from the Alliances feed list.';
const FEED_NOT = ['pairing_state', 'in', '(legacy,manual)'];

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

function res(status: number, body: unknown, text?: string | (() => Promise<string>)) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: typeof text === 'function' ? text : async () => text ?? '',
    } as unknown as Response;
}

/** settings table responder keyed by the .eq('key', …) filter. */
function settingsWith(values: Record<string, unknown>) {
    fake.on('settings', (q: FakeQuery) => {
        if (q.op !== 'select') return { data: null, error: null };
        const key = filters(q, 'eq').find((a) => a[0] === 'key')?.[1] as string;
        return { data: key in values ? { value: values[key] } : null, error: null };
    });
}

const settingsWrites = () => fake.find('settings').filter((q) => q.op !== 'select');

beforeEach(() => {
    fake.reset();
    broadcastSpy.mockClear();
    vi.clearAllMocks();
    m.getSystemRoles.mockResolvedValue({});
    m.getCachedAllianceSyncConfig.mockReturnValue({ directoryHours: 6 });
    m.tryConsumeToken.mockReturnValue(true);
    vi.unstubAllEnvs();
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('ALLIANCE_DEV_ALLOW_LOOPBACK', '');
});

afterEach(() => {
    assertNoWildcardSelects(fake);
    vi.unstubAllEnvs();
});

// -----------------------------------------------------------------------------
describe('listAlliancePeers / getAllianceDirectory', () => {
    const fullRow = {
        id: PEER_ID, label: 'Bravo', base_url: PEER_ORIGIN, peer_org_name: 'Bravo Org', peer_org_tag: 'BRV',
        peer_icon_url: null, peer_blurb: 'hi', status: 'Active', type: 'Alliance',
        inbound_max_clearance: 2, outbound_max_clearance: 3, channels: null, pairing_state: 'active',
        outbound_key_enc: 'enc:SECRET-OUT', inbound_key_id: 'k1', entered_peer_code_enc: 'enc:CODE',
        entered_peer_code_expires: null, last_contact_at: null, created_at: '2026-01-01',
        sync_health: null, sync_failures: null, sync_last_ok_at: null, sync_next_attempt_at: null, sync_alert: null,
        intel_synced_at: null, ops_synced_at: null,
    };

    it('lists handshake peers only (feed rows excluded), newest first, with an allow-listed mapping', async () => {
        fake.queue('alliance_peers', { data: [fullRow] });
        const out = await listAlliancePeers();
        const q = fake.find('alliance_peers')[0];
        expect(columnsOf(q)).toContain('outbound_key_enc');
        expect(hasCall(q, 'not', ...FEED_NOT)).toBe(true);
        expect(hasCall(q, 'order', 'created_at', { ascending: false })).toBe(true);
        expect(out).toEqual([{
            id: PEER_ID, label: 'Bravo', baseUrl: PEER_ORIGIN, peerOrgName: 'Bravo Org', peerOrgTag: 'BRV',
            peerIconUrl: null, peerBlurb: 'hi', status: 'Active', type: 'Alliance',
            inboundMaxClearance: 2, outboundMaxClearance: 3, channels: {}, pairingState: 'active',
            hasOutboundKey: true, lastContactAt: null, createdAt: '2026-01-01',
            syncHealth: 'unknown', syncFailures: 0, syncLastOkAt: null, syncNextAttemptAt: null, syncAlert: null,
        }]);
        // Key material never crosses to the browser — only the boolean.
        const blob = JSON.stringify(out);
        expect(blob).not.toContain('SECRET-OUT');
        expect(blob).not.toContain('enc:CODE');
        expect(blob).not.toContain('k1');
    });

    it('keeps populated sync-state fields and reports hasOutboundKey=false without a key', async () => {
        fake.queue('alliance_peers', { data: [{ ...fullRow, outbound_key_enc: null, channels: { reports: true }, sync_health: 'down', sync_failures: 4, sync_last_ok_at: 'a', sync_next_attempt_at: 'b', sync_alert: 'c' }] });
        const [p] = await listAlliancePeers();
        expect(p.hasOutboundKey).toBe(false);
        expect(p.channels).toEqual({ reports: true });
        expect([p.syncHealth, p.syncFailures, p.syncLastOkAt, p.syncNextAttemptAt, p.syncAlert]).toEqual(['down', 4, 'a', 'b', 'c']);
    });

    it('fails closed to [] on a read error', async () => {
        fake.queue('alliance_peers', { data: null, error: { code: 'XX000', message: 'boom' } });
        expect(await listAlliancePeers()).toEqual([]);
    });

    it('directory serves only card fields, excludes feeds + Dissolved, sorted by org name', async () => {
        fake.queue('alliance_peers', { data: [
            { id: 'a', peer_org_name: 'Alpha', peer_org_tag: 'A', peer_icon_url: 'https://x/i.png', peer_blurb: 'b', status: 'Active', type: 'Alliance', last_contact_at: 't' },
            { id: 'b', status: 'Pending', type: AllianceType.Rivalry },
        ] });
        const out = await getAllianceDirectory();
        const q = fake.find('alliance_peers')[0];
        expect(columnsOf(q)).toEqual(['id', 'peer_org_name', 'peer_org_tag', 'peer_icon_url', 'peer_blurb', 'status', 'type', 'last_contact_at']);
        expect(hasCall(q, 'not', ...FEED_NOT)).toBe(true);
        expect(hasCall(q, 'neq', 'status', 'Dissolved')).toBe(true);
        expect(hasCall(q, 'order', 'peer_org_name', { ascending: true })).toBe(true);
        expect(out).toEqual([
            { id: 'a', peerOrgName: 'Alpha', peerOrgTag: 'A', peerIconUrl: 'https://x/i.png', peerBlurb: 'b', status: 'Active', type: 'Alliance', lastContactAt: 't' },
            { id: 'b', peerOrgName: null, peerOrgTag: null, peerIconUrl: null, peerBlurb: null, status: 'Pending', type: AllianceType.Rivalry, lastContactAt: null },
        ]);
    });

    it('directory fails closed to [] on error', async () => {
        fake.queue('alliance_peers', { data: null, error: { message: 'x' } });
        expect(await getAllianceDirectory()).toEqual([]);
    });
});

// -----------------------------------------------------------------------------
describe('updateAlliancePeer', () => {
    it('rejects a non-uuid id before any query', async () => {
        await expect(updateAlliancePeer('nope', { label: 'x' })).rejects.toThrow();
        expect(fake.queries).toHaveLength(0);
    });

    it('writes only the supplied fields (snake-cased), scoped away from feed rows, then broadcasts the id', async () => {
        fake.queue('alliance_peers', { data: [{ id: PEER_ID }] });
        await updateAlliancePeer(PEER_ID, { label: 'New', type: AllianceType.Rivalry, inboundMaxClearance: 1, outboundMaxClearance: 2, channels: { roster: true } });
        const q = fake.find('alliance_peers', 'update')[0];
        expect(q.payload).toMatchObject({ label: 'New', type: AllianceType.Rivalry, inbound_max_clearance: 1, outbound_max_clearance: 2, channels: { roster: true } });
        expect(typeof (q.payload as Record<string, unknown>).updated_at).toBe('string');
        expect(hasCall(q, 'eq', 'id', PEER_ID)).toBe(true);
        expect(hasCall(q, 'not', ...FEED_NOT)).toBe(true);
        expect(q.columns).toBe('id');
        expect(broadcastSpy).toHaveBeenCalledWith('alliance_update', { id: PEER_ID });
    });

    it('omits untouched fields from the update payload', async () => {
        fake.queue('alliance_peers', { data: [{ id: PEER_ID }] });
        await updateAlliancePeer(PEER_ID, { label: 'Only' });
        expect(Object.keys(fake.find('alliance_peers', 'update')[0].payload as object).sort()).toEqual(['label', 'updated_at']);
    });

    it('denies (SecurityDenial, no broadcast) when the scoped write matched nothing — feed rows / unknown ids', async () => {
        fake.queue('alliance_peers', { data: [] });
        const err = await updateAlliancePeer(PEER_ID, { label: 'x' }).catch((e) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect(err.message).toBe(PEER_ONLY);
        expect(err.auditEvent).toBe('authz.peer_scope.denied');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('denies when the write returns null data', async () => {
        fake.queue('alliance_peers', { data: null });
        await expect(updateAlliancePeer(PEER_ID, {})).rejects.toBeInstanceOf(SecurityDenial);
    });

    it('surfaces a db error with the generic message', async () => {
        fake.queue('alliance_peers', { data: null, error: { message: 'constraint xyz' } });
        await expect(updateAlliancePeer(PEER_ID, { label: 'x' })).rejects.toThrow('Failed to update alliance peer');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });
});

// -----------------------------------------------------------------------------
describe('revokeAlliancePeer', () => {
    it('soft-revokes the inbound key and wipes all key material on the scoped peer row', async () => {
        fake.queue('alliance_peers', { data: { id: PEER_ID, inbound_key_id: 'key-9' } }, { data: [{ id: PEER_ID }] });
        await revokeAlliancePeer(PEER_ID);
        const [read, upd] = fake.find('alliance_peers');
        expect(read.columns).toBe('id, inbound_key_id');
        expect(hasCall(read, 'not', ...FEED_NOT)).toBe(true);
        const key = fake.find('api_keys', 'update')[0];
        expect(key.payload).toMatchObject({ revoked_reason: 'alliance_revoked' });
        expect(hasCall(key, 'eq', 'id', 'key-9')).toBe(true);
        expect(hasCall(key, 'is', 'revoked_at', null)).toBe(true);
        expect(fake.find('api_keys', 'delete')).toHaveLength(0);
        expect(upd.op).toBe('update');
        expect(upd.payload).toMatchObject({
            status: 'Dissolved', pairing_state: 'revoked', outbound_key_enc: null, inbound_key_id: null,
            entered_peer_code_enc: null, entered_peer_code_expires: null,
        });
        expect(hasCall(upd, 'not', ...FEED_NOT)).toBe(true);
        expect(broadcastSpy).toHaveBeenCalledWith('alliance_update', { id: PEER_ID });
    });

    it('skips the api_keys write when the peer never minted an inbound key', async () => {
        fake.queue('alliance_peers', { data: { id: PEER_ID, inbound_key_id: null } }, { data: [{ id: PEER_ID }] });
        await revokeAlliancePeer(PEER_ID);
        expect(fake.find('api_keys')).toHaveLength(0);
    });

    it('denies before touching key material when the id is not a handshake peer', async () => {
        fake.queue('alliance_peers', { data: null });
        await expect(revokeAlliancePeer(PEER_ID)).rejects.toBeInstanceOf(SecurityDenial);
        expect(fake.find('api_keys')).toHaveLength(0);
        expect(fake.find('alliance_peers', 'update')).toHaveLength(0);
    });

    it('surfaces a read error without writing', async () => {
        fake.queue('alliance_peers', { data: null, error: { message: 'down' } });
        await expect(revokeAlliancePeer(PEER_ID)).rejects.toThrow('Failed to load alliance peer');
        expect(fake.find('alliance_peers', 'update')).toHaveLength(0);
    });

    it('surfaces a write error and denies a write that matched no row', async () => {
        fake.queue('alliance_peers', { data: { id: PEER_ID, inbound_key_id: null } }, { data: null, error: { message: 'x' } });
        await expect(revokeAlliancePeer(PEER_ID)).rejects.toThrow('Failed to revoke alliance peer');
        fake.queue('alliance_peers', { data: { id: PEER_ID, inbound_key_id: null } }, { data: [] });
        await expect(revokeAlliancePeer(PEER_ID)).rejects.toThrow(PEER_ONLY);
        expect(broadcastSpy).not.toHaveBeenCalled();
    });
});

// -----------------------------------------------------------------------------
describe('self profile', () => {
    it('defaults when no setting is stored and merges a stored one', async () => {
        settingsWith({});
        expect(await getAllianceSelfProfile()).toEqual({ orgName: '', directoryVisible: false });
        const read = fake.find('settings')[0];
        expect(read.columns).toBe('value');
        expect(hasCall(read, 'eq', 'key', 'allianceSelfProfile')).toBe(true);
        fake.reset();
        settingsWith({ allianceSelfProfile: { orgName: 'Alpha', orgTag: 'A' } });
        expect(await getAllianceSelfProfile()).toEqual({ orgName: 'Alpha', orgTag: 'A', directoryVisible: false });
    });

    it('clamps every text field, drops unsafe icon URLs, coerces visibility, then broadcasts a bare settings_update', async () => {
        await saveAllianceSelfProfile({
            orgName: 'N'.repeat(200), orgTag: 'T'.repeat(50), iconUrl: 'javascript:alert(1)',
            blurb: 'B'.repeat(900), contactDiscord: 'D'.repeat(300), directoryVisible: 1 as unknown as boolean,
        });
        const w = fake.find('settings', 'upsert')[0];
        expect(w.writeOptions).toEqual({ onConflict: 'key' });
        const { key, value } = w.payload as { key: string; value: Record<string, unknown> };
        expect(key).toBe('allianceSelfProfile');
        expect((value.orgName as string).length).toBe(120);
        expect((value.orgTag as string).length).toBe(32);
        expect((value.blurb as string).length).toBe(500);
        expect((value.contactDiscord as string).length).toBe(120);
        expect(value.iconUrl).toBeUndefined();
        expect(value.directoryVisible).toBe(true);
        expect(broadcastSpy).toHaveBeenCalledWith('settings_update', {});
    });

    it('keeps a safe https image icon and leaves absent optionals undefined', async () => {
        await saveAllianceSelfProfile({ iconUrl: 'https://cdn.myrsi-alpha.net/logo.png' });
        const { value } = fake.find('settings', 'upsert')[0].payload as { value: Record<string, unknown> };
        expect(value).toEqual({ orgName: '', orgTag: undefined, iconUrl: 'https://cdn.myrsi-alpha.net/logo.png', blurb: undefined, contactDiscord: undefined, directoryVisible: false });
    });

    it('does not broadcast when the settings write fails', async () => {
        fake.queue('settings', { error: { message: 'nope' } });
        await expect(saveAllianceSelfProfile({ orgName: 'x' })).rejects.toThrow('Failed to write allianceSelfProfile');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });
});

// -----------------------------------------------------------------------------
describe('generatePairingCode / createOrUpdatePeer', () => {
    it('mints a ~160-bit code, stores it ONLY encrypted with a 15-minute expiry', async () => {
        const before = Date.now();
        const out = await generatePairingCode();
        expect(out.code).toMatch(/^[A-Za-z0-9_-]{27}$/);
        const exp = new Date(out.expiresAt).getTime();
        expect(exp - before).toBeGreaterThanOrEqual(15 * 60_000 - 50);
        expect(exp - before).toBeLessThanOrEqual(15 * 60_000 + 1000);
        const w = fake.find('settings', 'upsert')[0];
        expect(w.payload).toEqual({ key: 'allianceLocalPairingCode', value: { codeEnc: `enc:${out.code}`, expiresAt: out.expiresAt } });
    });

    it.each([
        ['http://peer.myrsi-bravo.net'], ['https://localhost'], ['https://10.0.0.5'], ['not a url'], [''],
    ])('rejects a non-public-https peer URL %s', async (url) => {
        await expect(createOrUpdatePeer({ label: 'x', baseUrl: url, peerCode: 'c' })).rejects.toThrow('Invalid peer URL: must be a public https:// origin.');
        expect(fake.queries).toHaveLength(0);
    });

    it('requires a non-blank peer code', async () => {
        await expect(createOrUpdatePeer({ label: 'x', baseUrl: PEER_ORIGIN, peerCode: '   ' })).rejects.toThrow('Peer pairing code is required.');
    });

    it('inserts a new Pending peer at the normalised origin with the code encrypted', async () => {
        fake.queue('alliance_peers', { data: null }, { data: { id: 'new-peer' } });
        const out = await createOrUpdatePeer({ label: '', baseUrl: `${PEER_ORIGIN}/some/path?x=1`, peerCode: '  CODE-B  ' });
        expect(out).toEqual({ peerId: 'new-peer' });
        const [lookup, ins] = fake.find('alliance_peers');
        expect(lookup.columns).toBe('id');
        expect(hasCall(lookup, 'eq', 'base_url', PEER_ORIGIN)).toBe(true);
        expect(filters(lookup, 'ilike')).toHaveLength(0);
        expect(ins.op).toBe('insert');
        expect(ins.payload).toMatchObject({
            label: PEER_ORIGIN, base_url: PEER_ORIGIN, type: 'Alliance', status: 'Pending', pairing_state: 'awaiting_peer',
            entered_peer_code_enc: 'enc:CODE-B',
        });
        expect(JSON.stringify(ins.payload)).not.toContain('"CODE-B"');
        expect(ins.columns).toBe('id');
        expect(broadcastSpy).toHaveBeenCalledWith('alliance_update', { id: 'new-peer' });
    });

    it('re-arms an existing peer row instead of inserting a duplicate', async () => {
        fake.queue('alliance_peers', { data: { id: PEER_ID } }, { data: null });
        const out = await createOrUpdatePeer({ label: 'L'.repeat(150), baseUrl: PEER_ORIGIN, peerCode: 'C2', type: AllianceType.Rivalry });
        expect(out).toEqual({ peerId: PEER_ID });
        const upd = fake.find('alliance_peers', 'update')[0];
        expect((upd.payload as Record<string, string>).label).toHaveLength(120);
        expect(upd.payload).toMatchObject({ type: AllianceType.Rivalry, entered_peer_code_enc: 'enc:C2', pairing_state: 'awaiting_peer', status: 'Pending' });
        expect(hasCall(upd, 'eq', 'id', PEER_ID)).toBe(true);
        expect(fake.find('alliance_peers', 'insert')).toHaveLength(0);
        expect(broadcastSpy).toHaveBeenCalledWith('alliance_update', { id: PEER_ID });
    });

    it('surfaces update/insert failures', async () => {
        fake.queue('alliance_peers', { data: { id: PEER_ID } }, { error: { message: 'x' } });
        await expect(createOrUpdatePeer({ label: 'a', baseUrl: PEER_ORIGIN, peerCode: 'c' })).rejects.toThrow('Failed to update alliance peer');
        fake.queue('alliance_peers', { data: null }, { data: null, error: { message: 'x' } });
        await expect(createOrUpdatePeer({ label: 'a', baseUrl: PEER_ORIGIN, peerCode: 'c' })).rejects.toThrow('Failed to create alliance peer');
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('accepts http loopback only under the non-production dev hatch', async () => {
        vi.stubEnv('ALLIANCE_DEV_ALLOW_LOOPBACK', '1');
        fake.queue('alliance_peers', { data: null }, { data: { id: 'loop' } });
        await createOrUpdatePeer({ label: 'x', baseUrl: 'http://localhost:3001/x', peerCode: 'c' });
        expect(fake.find('alliance_peers', 'insert')[0].payload).toMatchObject({ base_url: 'http://localhost:3001' });
        // ftp: is never accepted even with the hatch, nor is garbage.
        await expect(createOrUpdatePeer({ label: 'x', baseUrl: 'ftp://localhost', peerCode: 'c' })).rejects.toThrow('Invalid peer URL');
        await expect(createOrUpdatePeer({ label: 'x', baseUrl: '::::', peerCode: 'c' })).rejects.toThrow('Invalid peer URL');
        vi.stubEnv('NODE_ENV', 'production');
        await expect(createOrUpdatePeer({ label: 'x', baseUrl: 'http://localhost:3001', peerCode: 'c' })).rejects.toThrow('Invalid peer URL');
    });
});

// -----------------------------------------------------------------------------
// Handshake: drive connectPeer (initiator) against a simulated responder, and
// respondToPair (responder) against a simulated initiator, using the module's
// own pure crypto helpers. The keys each side persists must line up.
// -----------------------------------------------------------------------------
describe('connectPeer (initiator)', () => {
    const LOCAL = 'LOCAL-CODE-A';
    const PEERC = 'PEER-CODE-B';

    function arm(opts: { row?: Record<string, unknown> | null; prevKey?: string | null; keyInsert?: unknown; localCode?: unknown } = {}) {
        vi.stubEnv('APP_URL', OUR_ORIGIN);
        settingsWith({
            systemConfig: {},
            allianceLocalPairingCode: 'localCode' in opts ? opts.localCode : { codeEnc: `enc:${LOCAL}`, expiresAt: future() },
        });
        const row = 'row' in opts ? opts.row : { entered_peer_code_enc: `enc:${PEERC}`, entered_peer_code_expires: future(), base_url: PEER_ORIGIN };
        fake.on('alliance_peers', (q) => {
            if (q.op !== 'select') return { data: null, error: null };
            if (q.columns === 'entered_peer_code_enc, entered_peer_code_expires, base_url') return { data: row };
            if (q.columns === 'inbound_key_id') return { data: { inbound_key_id: opts.prevKey ?? null } };
            if (q.columns === 'base_url, outbound_key_enc') return { data: null }; // profile refresh: skip
            return { data: null };
        });
        fake.on('api_keys', (q) => (q.op === 'insert' ? (opts.keyInsert as never) ?? { data: { id: 'minted-key' } } : { data: null }));
    }

    /** A well-behaved responder computing its half with the shared helpers. */
    function honestResponder(capture: { keys?: { initToResp: string; respToInit: string }; body?: Record<string, string> }) {
        m.ssrfSafeFetch.mockImplementation(async (url: string, init: { body: string }) => {
            expect(url).toBe(`${PEER_ORIGIN}/api/alliance/pair`);
            const body = JSON.parse(init.body) as Record<string, string>;
            capture.body = body;
            const S = deriveSharedSecret(PEERC, LOCAL); // order-independent
            const eph = genEphemeral();
            const nonce = Buffer.from('resp-nonce-16byt').toString('base64');
            const mac = responderMac(S, body.ephemeralPub, body.nonce, eph.publicKeyB64, nonce).toString('base64');
            capture.keys = deriveDirectionalKeys(deriveMaster(ecdhShared(eph.privateKey, body.ephemeralPub), S));
            return res(200, { ephemeralPub: eph.publicKeyB64, nonce, mac });
        });
    }

    it('refuses to pair without a public https APP_URL', async () => {
        settingsWith({ systemConfig: {} });
        await expect(connectPeer(PEER_ID)).rejects.toThrow('Set APP_URL');
        expect(m.ssrfSafeFetch).not.toHaveBeenCalled();
    });

    it('requires a live local pairing code and deletes an expired one', async () => {
        arm({ localCode: null });
        await expect(connectPeer(PEER_ID)).rejects.toThrow('Generate a pairing code first');
        fake.reset();
        arm({ localCode: { codeEnc: `enc:${LOCAL}`, expiresAt: past() } });
        await expect(connectPeer(PEER_ID)).rejects.toThrow('Generate a pairing code first');
        const del = fake.find('settings', 'delete')[0];
        expect(hasCall(del, 'eq', 'key', 'allianceLocalPairingCode')).toBe(true);
    });

    it('scopes the peer lookup away from feed rows and rejects unknown / incomplete / expired / bad-URL peers', async () => {
        arm({ row: null });
        await expect(connectPeer(PEER_ID)).rejects.toThrow('Alliance peer not found.');
        const look = fake.find('alliance_peers')[0];
        expect(hasCall(look, 'eq', 'id', PEER_ID)).toBe(true);
        expect(hasCall(look, 'not', ...FEED_NOT)).toBe(true);
        fake.reset();
        arm({ row: { entered_peer_code_enc: null, entered_peer_code_expires: null, base_url: PEER_ORIGIN } });
        await expect(connectPeer(PEER_ID)).rejects.toThrow('Missing the peer pairing code');
        fake.reset();
        arm({ row: { entered_peer_code_enc: `enc:${PEERC}`, entered_peer_code_expires: past(), base_url: PEER_ORIGIN } });
        await expect(connectPeer(PEER_ID)).rejects.toThrow('The peer pairing code has expired');
        fake.reset();
        arm({ row: { entered_peer_code_enc: `enc:${PEERC}`, entered_peer_code_expires: null, base_url: 'http://10.1.1.1' } });
        await expect(connectPeer(PEER_ID)).rejects.toThrow('Invalid peer URL.');
        expect(m.ssrfSafeFetch).not.toHaveBeenCalled();
    });

    it('completes the handshake: codes never transit, keys line up with the responder, old key soft-revoked', async () => {
        arm({ prevKey: 'old-key' });
        const cap: { keys?: { initToResp: string; respToInit: string }; body?: Record<string, string> } = {};
        honestResponder(cap);
        const out = await connectPeer(PEER_ID);
        expect(out).toEqual({ peerId: PEER_ID, status: 'Active' });

        // Wire body: our advertised origin + ephemeral + nonce + a valid code proof; no codes.
        expect(Object.keys(cap.body!).sort()).toEqual(['codeProof', 'ephemeralPub', 'fromBaseUrl', 'nonce']);
        expect(cap.body!.fromBaseUrl).toBe(OUR_ORIGIN);
        const S = deriveSharedSecret(LOCAL, PEERC);
        expect(cap.body!.codeProof).toBe(codeProofMac(S, cap.body!.ephemeralPub, cap.body!.nonce).toString('base64'));
        expect(JSON.stringify(cap.body)).not.toContain(LOCAL);
        expect(JSON.stringify(cap.body)).not.toContain(PEERC);
        const [, init] = m.ssrfSafeFetch.mock.calls[0];
        expect(init.method).toBe('POST');
        expect(init.signal).toBeInstanceOf(AbortSignal);

        // Superseded credential soft-revoked, not deleted.
        const revoke = fake.find('api_keys', 'update')[0];
        expect(revoke.payload).toMatchObject({ revoked_reason: 'rekeyed' });
        expect(hasCall(revoke, 'eq', 'id', 'old-key')).toBe(true);
        expect(hasCall(revoke, 'is', 'revoked_at', null)).toBe(true);
        // Inbound key minted scoped + hashed: the responder calls us with respToInit.
        const mint = fake.find('api_keys', 'insert')[0];
        expect(mint.payload).toEqual({ label: `alliance:${PEER_ID}`, key_hash: sha256(cap.keys!.respToInit), scopes: ['alliance'] });
        // Our outbound key (initToResp) stored encrypted; peer flips Active.
        const peerUpdates = fake.find('alliance_peers', 'update').map((q) => q.payload as Record<string, unknown>);
        const persist = peerUpdates.find((p) => 'outbound_key_enc' in p)!;
        expect(persist).toMatchObject({
            outbound_key_enc: `enc:${cap.keys!.initToResp}`, inbound_key_id: 'minted-key', status: 'Active', pairing_state: 'active',
            handshake_nonce: null, handshake_expires: null,
        });
        expect(peerUpdates).toContainEqual({ entered_peer_code_enc: null, entered_peer_code_expires: null, is_local_initiator: true });
        // The one-time local code is consumed.
        expect(hasCall(fake.find('settings', 'delete')[0], 'eq', 'key', 'allianceLocalPairingCode')).toBe(true);
        expect(broadcastSpy).toHaveBeenLastCalledWith('alliance_update', { id: PEER_ID });
    });

    it('skips the revoke when there is no previous key, and fails loud if the mint fails', async () => {
        arm({ prevKey: null, keyInsert: { data: null, error: { message: 'x' } } });
        honestResponder({});
        await expect(connectPeer(PEER_ID)).rejects.toThrow('Failed to mint inbound alliance key');
        expect(fake.find('api_keys', 'update')).toHaveLength(0);
        expect(fake.find('alliance_peers', 'update').some((q) => 'outbound_key_enc' in (q.payload as object))).toBe(false);
    });

    it('fails loud when persisting the keys onto the peer row fails', async () => {
        arm();
        honestResponder({});
        fake.on('alliance_peers', (q) => {
            if (q.op === 'update' && 'outbound_key_enc' in (q.payload as object)) return { error: { message: 'x' } };
            if (q.columns === 'entered_peer_code_enc, entered_peer_code_expires, base_url') return { data: { entered_peer_code_enc: `enc:${PEERC}`, entered_peer_code_expires: null, base_url: PEER_ORIGIN } };
            return { data: null };
        });
        await expect(connectPeer(PEER_ID)).rejects.toThrow('Failed to persist alliance keys');
    });

    it('marks the peer failed and rethrows on a non-OK pair response (body excerpt included)', async () => {
        arm();
        m.ssrfSafeFetch.mockResolvedValue(res(409, {}, 'x'.repeat(300)));
        const err = await connectPeer(PEER_ID).catch((e) => e);
        expect(err.message).toBe(`Peer returned 409: ${'x'.repeat(200)}`);
        const failed = fake.find('alliance_peers', 'update')[0];
        expect(failed.payload).toMatchObject({ pairing_state: 'failed' });
        expect(hasCall(failed, 'eq', 'id', PEER_ID)).toBe(true);
        expect(broadcastSpy).toHaveBeenCalledWith('alliance_update', { id: PEER_ID });
        expect(fake.find('api_keys')).toHaveLength(0);
    });

    it('reports the bare status when the error body is unreadable or empty', async () => {
        arm();
        m.ssrfSafeFetch.mockResolvedValueOnce(res(502, {}, () => Promise.reject(new Error('stream'))));
        await expect(connectPeer(PEER_ID)).rejects.toThrow(/^Peer returned 502$/);
        m.ssrfSafeFetch.mockResolvedValueOnce(res(500, {}, ''));
        await expect(connectPeer(PEER_ID)).rejects.toThrow(/^Peer returned 500$/);
    });

    it('marks failed when the transport itself throws', async () => {
        arm();
        m.ssrfSafeFetch.mockRejectedValue(new Error('ECONNRESET'));
        await expect(connectPeer(PEER_ID)).rejects.toThrow('ECONNRESET');
        expect(fake.find('alliance_peers', 'update')[0].payload).toMatchObject({ pairing_state: 'failed' });
    });

    it('rejects a responder MAC that does not verify (wrong code / MITM) and persists nothing', async () => {
        arm();
        m.ssrfSafeFetch.mockImplementation(async (_u: string, init: { body: string }) => {
            const body = JSON.parse(init.body);
            const wrongS = deriveSharedSecret('ATTACKER', LOCAL);
            const eph = genEphemeral();
            const mac = responderMac(wrongS, body.ephemeralPub, body.nonce, eph.publicKeyB64, 'bm9uY2U=').toString('base64');
            return res(200, { ephemeralPub: eph.publicKeyB64, nonce: 'bm9uY2U=', mac });
        });
        await expect(connectPeer(PEER_ID)).rejects.toThrow('Handshake verification failed');
        expect(fake.find('alliance_peers', 'update')[0].payload).toMatchObject({ pairing_state: 'failed' });
        expect(fake.find('api_keys')).toHaveLength(0);
    });

    it('treats a missing mac as a verification failure', async () => {
        arm();
        m.ssrfSafeFetch.mockResolvedValue(res(200, { ephemeralPub: genEphemeral().publicKeyB64, nonce: 'x' }));
        await expect(connectPeer(PEER_ID)).rejects.toThrow('Handshake verification failed');
    });

    it('a failing post-pair profile refresh does not undo an Active pairing', async () => {
        arm();
        honestResponder({});
        fake.on('alliance_peers', (q) => {
            if (q.columns === 'entered_peer_code_enc, entered_peer_code_expires, base_url') return { data: { entered_peer_code_enc: `enc:${PEERC}`, entered_peer_code_expires: null, base_url: PEER_ORIGIN } };
            if (q.columns === 'base_url, outbound_key_enc') throw new Error('profile read blew up');
            return { data: null };
        });
        await expect(connectPeer(PEER_ID)).resolves.toEqual({ peerId: PEER_ID, status: 'Active' });
    });
});

describe('respondToPair (responder)', () => {
    const LOCAL = 'RESPONDER-CODE';
    const INIT = 'INITIATOR-CODE';

    function arm(row: Record<string, unknown> | null = { id: PEER_ID, entered_peer_code_enc: `enc:${INIT}`, entered_peer_code_expires: future() }, localCode: unknown = { codeEnc: `enc:${LOCAL}`, expiresAt: future() }) {
        settingsWith({ allianceLocalPairingCode: localCode });
        fake.on('alliance_peers', (q) => {
            if (q.op !== 'select') return { data: null };
            if (q.columns === 'id, entered_peer_code_enc, entered_peer_code_expires') return { data: row };
            return { data: null };
        });
        fake.on('api_keys', (q) => (q.op === 'insert' ? { data: { id: 'resp-key' } } : { data: null }));
    }

    function initiator(code = INIT) {
        const S = deriveSharedSecret(code, LOCAL);
        const eph = genEphemeral();
        const nonce = Buffer.from('init-nonce-16byt').toString('base64');
        return { S, eph, nonce, args: { fromBaseUrl: `${PEER_ORIGIN}/ignored`, ephemeralPub: eph.publicKeyB64, nonce, codeProof: codeProofMac(S, eph.publicKeyB64, nonce).toString('base64') } };
    }

    it('rejects a bad origin and malformed bodies before any lookup', async () => {
        await expect(respondToPair({ fromBaseUrl: 'http://x', ephemeralPub: 'a', nonce: 'b', codeProof: 'c' })).rejects.toThrow('invalid_from_url');
        await expect(respondToPair({ fromBaseUrl: PEER_ORIGIN, ephemeralPub: '', nonce: 'b', codeProof: 'c' })).rejects.toThrow('malformed_request');
        await expect(respondToPair({ fromBaseUrl: PEER_ORIGIN, ephemeralPub: 'a', nonce: '', codeProof: 'c' })).rejects.toThrow('malformed_request');
        await expect(respondToPair({ fromBaseUrl: PEER_ORIGIN, ephemeralPub: 'a', nonce: 'b', codeProof: '' })).rejects.toThrow('malformed_request');
        expect(fake.queries).toHaveLength(0);
    });

    it('refuses without a pending local code, a matching peer row, or an unexpired entered code', async () => {
        arm(undefined, null);
        await expect(respondToPair(initiator().args)).rejects.toThrow('no_pending_pairing');
        fake.reset();
        arm(null);
        await expect(respondToPair(initiator().args)).rejects.toThrow('no_pending_pairing');
        const look = fake.find('alliance_peers')[0];
        expect(hasCall(look, 'eq', 'base_url', PEER_ORIGIN)).toBe(true);
        fake.reset();
        arm({ id: PEER_ID, entered_peer_code_enc: null, entered_peer_code_expires: null });
        await expect(respondToPair(initiator().args)).rejects.toThrow('no_pending_pairing');
        fake.reset();
        arm({ id: PEER_ID, entered_peer_code_enc: `enc:${INIT}`, entered_peer_code_expires: past() });
        await expect(respondToPair(initiator().args)).rejects.toThrow('pairing_expired');
        expect(fake.find('api_keys')).toHaveLength(0);
    });

    it('rejects a code proof made with the wrong code and mints nothing', async () => {
        arm();
        await expect(respondToPair(initiator('GUESSED-CODE').args)).rejects.toThrow('handshake_verification_failed');
        expect(fake.find('api_keys')).toHaveLength(0);
        expect(fake.find('alliance_peers', 'update')).toHaveLength(0);
    });

    it('treats a missing proof value as verification failure, not a crash', async () => {
        arm();
        const a = initiator().args;
        await expect(respondToPair({ ...a, codeProof: 'AAAA' })).rejects.toThrow('handshake_verification_failed');
    });

    it('answers with a MAC the initiator can verify and persists the mirrored key pair', async () => {
        arm(undefined);
        const ini = initiator();
        const out = await respondToPair(ini.args);
        expect(Object.keys(out).sort()).toEqual(['ephemeralPub', 'mac', 'nonce']);
        expect(out.mac).toBe(responderMac(ini.S, ini.eph.publicKeyB64, ini.nonce, out.ephemeralPub, out.nonce).toString('base64'));
        const keys = deriveDirectionalKeys(deriveMaster(ecdhShared(ini.eph.privateKey, out.ephemeralPub), ini.S));
        // Responder: outbound = respToInit (encrypted); inbound = initToResp (hashed).
        expect(fake.find('api_keys', 'insert')[0].payload).toEqual({ label: `alliance:${PEER_ID}`, key_hash: sha256(keys.initToResp), scopes: ['alliance'] });
        const ups = fake.find('alliance_peers', 'update').map((q) => q.payload as Record<string, unknown>);
        expect(ups.find((p) => 'outbound_key_enc' in p)).toMatchObject({ outbound_key_enc: `enc:${keys.respToInit}`, inbound_key_id: 'resp-key', status: 'Active' });
        expect(ups).toContainEqual({ entered_peer_code_enc: null, entered_peer_code_expires: null, is_local_initiator: false });
        expect(hasCall(fake.find('settings', 'delete')[0], 'eq', 'key', 'allianceLocalPairingCode')).toBe(true);
        expect(broadcastSpy).toHaveBeenCalledWith('alliance_update', { id: PEER_ID });
        expect(JSON.stringify(out)).not.toContain(LOCAL);
    });

    it('swallows a background profile-refresh failure', async () => {
        arm(undefined);
        fake.on('alliance_peers', (q) => {
            if (q.columns === 'id, entered_peer_code_enc, entered_peer_code_expires') return { data: { id: PEER_ID, entered_peer_code_enc: `enc:${INIT}`, entered_peer_code_expires: null } };
            if (q.columns === 'base_url, outbound_key_enc') throw new Error('bg refresh failed');
            return { data: null };
        });
        await expect(respondToPair(initiator().args)).resolves.toHaveProperty('mac');
        await new Promise((r) => setTimeout(r, 0));
    });
});

// -----------------------------------------------------------------------------
describe('refreshPeerProfile', () => {
    const peerRow = (over: Record<string, unknown> = {}) => fake.on('alliance_peers', (q) => (q.op === 'select' ? { data: { base_url: PEER_ORIGIN, outbound_key_enc: 'enc:OUT-KEY', ...over } } : { data: null }));

    it('does nothing for a peer with no outbound key, a bad URL, or an undecryptable key', async () => {
        fake.on('alliance_peers', { data: null });
        await refreshPeerProfile(PEER_ID);
        fake.reset(); peerRow({ outbound_key_enc: null });
        await refreshPeerProfile(PEER_ID);
        fake.reset(); peerRow({ base_url: 'http://192.168.0.1' });
        await refreshPeerProfile(PEER_ID);
        fake.reset(); peerRow({ outbound_key_enc: 'garbled' });
        await refreshPeerProfile(PEER_ID);
        expect(m.ssrfSafeFetch).not.toHaveBeenCalled();
        expect(fake.find('alliance_peers', 'update')).toHaveLength(0);
    });

    it('leaves the cached card untouched on a non-OK profile response', async () => {
        peerRow();
        m.ssrfSafeFetch.mockResolvedValue(res(500, {}));
        await refreshPeerProfile(PEER_ID);
        expect(fake.find('alliance_peers', 'update')).toHaveLength(0);
        expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('fetches with the decrypted key via ssrfSafeFetch and persists a stripped, capped, icon-clamped card', async () => {
        peerRow();
        m.ssrfSafeFetch.mockResolvedValue(res(200, {
            orgName: `<b>Bravo</b>${'N'.repeat(200)}`, orgTag: '<i>BRV</i>', blurb: `<script>x</script>${'B'.repeat(900)}`,
            iconUrl: 'javascript:alert(1)',
        }));
        await refreshPeerProfile(PEER_ID);
        const [url, init] = m.ssrfSafeFetch.mock.calls[0];
        expect(url).toBe(`${PEER_ORIGIN}/api/alliance/profile`);
        expect(init.headers).toEqual({ 'x-api-key': 'OUT-KEY' });
        const read = fake.find('alliance_peers', 'select')[0];
        expect(read.columns).toBe('base_url, outbound_key_enc');
        const upd = fake.find('alliance_peers', 'update')[0];
        const p = upd.payload as Record<string, string | null>;
        expect(p.peer_org_name!.startsWith('Bravo')).toBe(true);
        expect(p.peer_org_name!.length).toBeLessThanOrEqual(120);
        expect(p.peer_org_tag).toBe('BRV');
        expect(p.peer_blurb!.length).toBeLessThanOrEqual(500);
        expect(p.peer_blurb).not.toContain('<script>');
        expect(p.peer_icon_url).toBeNull();
        expect(hasCall(upd, 'eq', 'id', PEER_ID)).toBe(true);
        expect(broadcastSpy).toHaveBeenCalledWith('alliance_update', { id: PEER_ID });
    });

    it('stores a safe https icon and nulls empty text', async () => {
        peerRow();
        m.ssrfSafeFetch.mockResolvedValue(res(200, { iconUrl: 'https://cdn.myrsi-bravo.net/i.png' }));
        await refreshPeerProfile(PEER_ID);
        expect(fake.find('alliance_peers', 'update')[0].payload).toMatchObject({
            peer_org_name: null, peer_org_tag: null, peer_blurb: null, peer_icon_url: 'https://cdn.myrsi-bravo.net/i.png',
        });
    });

    it('sanitizePeerProfileText tolerates a null profile', () => {
        expect(sanitizePeerProfileText(null)).toEqual({ orgName: null, orgTag: null, blurb: null });
    });
});

// -----------------------------------------------------------------------------
describe('callAlliancePeer', () => {
    it('only reaches Active peers and returns null when the key or URL is unusable', async () => {
        fake.queue('alliance_peers', { data: null });
        expect(await callAlliancePeer(PEER_ID, '/api/alliance/x')).toBeNull();
        const q = fake.find('alliance_peers')[0];
        expect(q.columns).toBe('base_url, outbound_key_enc');
        expect(hasCall(q, 'eq', 'id', PEER_ID)).toBe(true);
        expect(hasCall(q, 'eq', 'status', 'Active')).toBe(true);
        fake.queue('alliance_peers', { data: { base_url: 'https://localhost', outbound_key_enc: 'enc:k' } });
        expect(await callAlliancePeer(PEER_ID, '/x')).toBeNull();
        fake.queue('alliance_peers', { data: { base_url: PEER_ORIGIN, outbound_key_enc: 'rotated-away' } });
        expect(await callAlliancePeer(PEER_ID, '/x')).toBeNull();
        expect(m.ssrfSafeFetch).not.toHaveBeenCalled();
    });

    it('GETs with only the api key by default', async () => {
        fake.queue('alliance_peers', { data: { base_url: PEER_ORIGIN, outbound_key_enc: 'enc:K1' } });
        const r = res(200, {});
        m.ssrfSafeFetch.mockResolvedValue(r);
        expect(await callAlliancePeer(PEER_ID, '/api/alliance/intel')).toBe(r);
        const [url, init] = m.ssrfSafeFetch.mock.calls[0];
        expect(url).toBe(`${PEER_ORIGIN}/api/alliance/intel`);
        expect(init).toMatchObject({ method: 'GET', headers: { 'x-api-key': 'K1' }, body: undefined });
    });

    it('sends a JSON body with content-type when given one', async () => {
        fake.queue('alliance_peers', { data: { base_url: PEER_ORIGIN, outbound_key_enc: 'enc:K1' } });
        m.ssrfSafeFetch.mockResolvedValue(res(200, {}));
        await callAlliancePeer(PEER_ID, '/api/alliance/op', { method: 'POST', body: { a: 1 } });
        const [, init] = m.ssrfSafeFetch.mock.calls[0];
        expect(init).toMatchObject({ method: 'POST', headers: { 'x-api-key': 'K1', 'content-type': 'application/json' }, body: '{"a":1}' });
    });

    it('propagates a network error (the sync engine counts it toward health)', async () => {
        fake.queue('alliance_peers', { data: { base_url: PEER_ORIGIN, outbound_key_enc: 'enc:K1' } });
        m.ssrfSafeFetch.mockRejectedValue(new Error('ETIMEDOUT'));
        await expect(callAlliancePeer(PEER_ID, '/x')).rejects.toThrow('ETIMEDOUT');
    });
});

// -----------------------------------------------------------------------------
describe('getAlliancePeerByInboundKey', () => {
    it('returns null without a query for an unknown key', async () => {
        m.verifyApiKey.mockResolvedValue(null);
        expect(await getAlliancePeerByInboundKey('ak_x')).toBeNull();
        expect(fake.queries).toHaveLength(0);
    });

    it('refuses a verified key that lacks the alliance scope', async () => {
        m.verifyApiKey.mockResolvedValue({ id: 'k1', scopes: ['feed'] });
        expect(await getAlliancePeerByInboundKey('ak_x')).toBeNull();
        m.verifyApiKey.mockResolvedValue({ id: 'k1', scopes: [] });
        expect(await getAlliancePeerByInboundKey('ak_x')).toBeNull();
        expect(fake.queries).toHaveLength(0);
    });

    it('resolves the Active peer owning the key and notes inbound contact', async () => {
        m.verifyApiKey.mockResolvedValue({ id: 'k1', scopes: ['alliance'] });
        const row = { id: PEER_ID, sync_health: 'down' };
        fake.queue('alliance_peers', { data: row });
        expect(await getAlliancePeerByInboundKey('ak_x')).toBe(row);
        const q = fake.find('alliance_peers')[0];
        expect(hasCall(q, 'eq', 'inbound_key_id', 'k1')).toBe(true);
        expect(hasCall(q, 'eq', 'status', 'Active')).toBe(true);
        expect(m.noteInboundContact).toHaveBeenCalledWith(row);
    });

    it('returns null (no contact noted) when no Active peer owns a grandfathered key', async () => {
        m.verifyApiKey.mockResolvedValue({ id: 'k2', scopes: null });
        fake.queue('alliance_peers', { data: null });
        expect(await getAlliancePeerByInboundKey('ak_x')).toBeNull();
        expect(m.noteInboundContact).not.toHaveBeenCalled();
    });
});

describe('getAllianceShareableData', () => {
    it('bounds clearance by the lower of the org ceiling and the peer ceiling, and requires the bulletin share flag', async () => {
        m.getMaxShareableClearance.mockResolvedValue(3);
        m.collectShareableIntel.mockResolvedValue({ ok: 1 });
        expect(await getAllianceShareableData({ outbound_max_clearance: 5, channels: { reports: true } }, '2026-01-01')).toEqual({ ok: 1 });
        expect(m.collectShareableIntel).toHaveBeenLastCalledWith({ maxClearance: 3, channels: { reports: true }, bulletinsRequireSharedFlag: true, since: '2026-01-01' });
        await getAllianceShareableData({ outbound_max_clearance: 1, channels: null });
        expect(m.collectShareableIntel).toHaveBeenLastCalledWith({ maxClearance: 1, channels: {}, bulletinsRequireSharedFlag: true, since: undefined });
        await getAllianceShareableData({ outbound_max_clearance: null as unknown as number, channels: null });
        expect(m.collectShareableIntel).toHaveBeenLastCalledWith(expect.objectContaining({ maxClearance: 0 }));
    });
});

// -----------------------------------------------------------------------------
describe('roster / fleet projections (outbound, PII-minimised)', () => {
    it('roster selects only display columns, excludes deleted users and the Client role', async () => {
        m.getSystemRoles.mockResolvedValue({ client: { id: 9, name: 'Client' } });
        fake.queue('users', { data: [{ id: 41, name: 'P', rsi_handle: 'h', avatar_url: null, is_duty: 0, rank: [{ name: 'Cpt', icon_url: null }], unit: null, role: [], specializations: [
            { specialization: [{ name: 'Medic', icon: 'm' }] }, { specialization: null }, { specialization: { name: '', icon: null } },
            { specialization: { name: 'B', icon: null } }, { specialization: { name: 'C', icon: null } }, { specialization: { name: 'D', icon: null } },
        ] }] });
        const out = await getAllyRosterProjection({ channels: { roster: true } });
        const q = fake.find('users')[0];
        const cols = q.columns!;
        for (const banned of ['discord', 'email', 'clearance', 'notes', 'permissions', 'deleted_at']) expect(cols).not.toContain(banned);
        expect(hasCall(q, 'is', 'deleted_at', null)).toBe(true);
        expect(hasCall(q, 'neq', 'role_id', 9)).toBe(true);
        expect(out!.members[0]).toEqual({
            id: 1, rsiHandle: 'h', name: 'P', avatarUrl: null, rankName: 'Cpt', rankIcon: null, unitName: null, roleName: null, isDuty: false,
            specializations: [{ name: 'Medic', icon: 'm' }, { name: 'B', icon: null }, { name: 'C', icon: null }],
        });
    });

    it('fleet is null and unqueried unless the fleet channel is explicitly on', async () => {
        expect(await getAllyFleetProjection({ channels: null })).toBeNull();
        expect(await getAllyFleetProjection({ channels: { fleet: 'yes' as unknown as boolean } })).toBeNull();
        expect(fake.queries).toHaveLength(0);
    });

    it('fleet aggregates counts only — no per-member ownership — sorted by count', async () => {
        fake.queue('user_ships', { data: [
            { ship: { career: 'Combat', role: 'Fighter' } }, { ship: [{ career: 'Combat', role: null }] },
            { ship: { career: null, role: 'Hauler' } }, { ship: null },
        ] });
        fake.queue('fleet_groups', { data: [{ name: 'Wing', type: 'Squadron', fleet_group_ships: [{ id: 1 }, { id: 2 }] }, { name: 'Empty', type: 'Wing', fleet_group_ships: null }] });
        const out = await getAllyFleetProjection({ channels: { fleet: true } });
        const ships = fake.find('user_ships')[0];
        expect(ships.columns).toBe('ship:platform_ships(career, role)');
        expect(hasCall(ships, 'order', 'id', { ascending: true })).toBe(true);
        expect(hasCall(ships, 'limit', 20_000)).toBe(true);
        expect(fake.find('fleet_groups')[0].columns).toBe('name, type, fleet_group_ships(id)');
        expect(hasCall(fake.find('fleet_groups')[0], 'order', 'sort_order')).toBe(true);
        expect(out).toMatchObject({
            groupCount: 2, totalShips: 4,
            shipsByCategory: [{ category: 'Combat', count: 2 }, { category: 'Hauler', count: 1 }, { category: 'Other', count: 1 }],
            groups: [{ name: 'Wing', type: 'Squadron', totalShips: 2 }, { name: 'Empty', type: 'Wing', totalShips: 0 }],
        });
        expect(JSON.stringify(out)).not.toMatch(/user_id|owner/);
    });

    it('fleet degrades to an empty summary when both reads fail', async () => {
        fake.queue('user_ships', { data: null, error: { message: 'x' } });
        fake.queue('fleet_groups', { data: null, error: { message: 'x' } });
        expect(await getAllyFleetProjection({ channels: { fleet: true } })).toMatchObject({ groupCount: 0, totalShips: 0, shipsByCategory: [], groups: [] });
    });
});

// -----------------------------------------------------------------------------
describe('inbound directory cache sanitisers', () => {
    it('roster: caps members at 5000 and clamps every avatar to a safe https image', () => {
        const members = Array.from({ length: 5003 }, (_, i) => ({ id: i, avatarUrl: i === 0 ? 'javascript:alert(1)' : 'https://cdn.x.net/a.png' }));
        const out = sanitizeRosterProjection({ memberCount: 5003, members, fetchedAt: 't' } as unknown as AllyRosterData);
        expect(out.members).toHaveLength(5000);
        expect(out.members[0].avatarUrl).toBeNull();
        expect(out.members[1].avatarUrl).toBe('https://cdn.x.net/a.png');
        expect(out.memberCount).toBe(5003);
        const odd = { memberCount: 0, members: 'nope' } as unknown as AllyRosterData;
        expect(sanitizeRosterProjection(odd)).toBe(odd);
        expect(sanitizeRosterProjection(null as unknown as AllyRosterData)).toBeNull();
    });

    it('fleet: caps both element arrays at 2000 and passes non-arrays/null through', () => {
        const big = Array.from({ length: 2005 }, (_, i) => ({ category: String(i), count: 1 }));
        const groups = Array.from({ length: 2001 }, () => ({ name: 'g', type: 't', totalShips: 1 }));
        const out = sanitizeFleetProjection({ groupCount: 1, totalShips: 1, shipsByCategory: big, groups, fetchedAt: 't' } as AllyFleetSummary);
        expect(out.shipsByCategory).toHaveLength(2000);
        expect(out.groups).toHaveLength(2000);
        const odd = sanitizeFleetProjection({ shipsByCategory: 'x', groups: 'y' } as unknown as AllyFleetSummary);
        expect(odd).toMatchObject({ shipsByCategory: 'x', groups: 'y' });
        expect(sanitizeFleetProjection(null as unknown as AllyFleetSummary)).toBeNull();
    });
});

describe('fetchPeerRoster / fetchPeerFleet / refreshPeerDirectory', () => {
    const freshAt = () => new Date(Date.now() - 60_000).toISOString();
    const staleAt = () => new Date(Date.now() - 7 * 3_600_000).toISOString();
    const roster = (n: string) => ({ memberCount: 1, members: [{ id: 1, name: n, avatarUrl: 'javascript:x' }], fetchedAt: 't' });
    const fleet = { groupCount: 0, totalShips: 3, shipsByCategory: [], groups: [], fetchedAt: 't' };
    const activePeer = () => fake.on('alliance_peers', { data: { base_url: PEER_ORIGIN, outbound_key_enc: 'enc:K' } });

    it('serves a fresh cache without contacting the peer or spending a token', async () => {
        fake.queue('alliance_peer_directory_cache', { data: { roster: roster('cached'), fleet, synced_at: freshAt() } });
        expect((await fetchPeerRoster(PEER_ID))!.members[0].name).toBe('cached');
        const q = fake.find('alliance_peer_directory_cache')[0];
        expect(q.columns).toBe('roster, fleet, synced_at');
        expect(hasCall(q, 'eq', 'peer_id', PEER_ID)).toBe(true);
        fake.queue('alliance_peer_directory_cache', { data: { roster: null, fleet, synced_at: freshAt() } });
        expect(await fetchPeerFleet(PEER_ID)).toEqual(fleet);
        expect(m.tryConsumeToken).not.toHaveBeenCalled();
        expect(m.ssrfSafeFetch).not.toHaveBeenCalled();
    });

    it('serves the stale cache (or null) when the live-fetch budget is spent', async () => {
        m.tryConsumeToken.mockReturnValue(false);
        fake.queue('alliance_peer_directory_cache', { data: { roster: roster('stale'), fleet: null, synced_at: staleAt() } });
        expect((await fetchPeerRoster(PEER_ID))!.members[0].name).toBe('stale');
        fake.queue('alliance_peer_directory_cache', { data: null });
        expect(await fetchPeerRoster(PEER_ID)).toBeNull();
        fake.queue('alliance_peer_directory_cache', { data: { roster: null, fleet, synced_at: staleAt() } });
        expect(await fetchPeerFleet(PEER_ID)).toEqual(fleet);
        fake.queue('alliance_peer_directory_cache', { data: null });
        expect(await fetchPeerFleet(PEER_ID)).toBeNull();
        expect(m.tryConsumeToken).toHaveBeenCalledWith(PEER_ID);
        expect(m.ssrfSafeFetch).not.toHaveBeenCalled();
    });

    it('treats an unparseable synced_at as stale', async () => {
        m.tryConsumeToken.mockReturnValue(false);
        fake.queue('alliance_peer_directory_cache', { data: { roster: roster('r'), fleet: null, synced_at: 'garbage' } });
        await fetchPeerRoster(PEER_ID);
        expect(m.tryConsumeToken).toHaveBeenCalled();
    });

    it('live-refreshes a stale roster, sanitising BEFORE the cache write', async () => {
        activePeer();
        fake.queue('alliance_peer_directory_cache', { data: { roster: roster('old'), fleet: null, synced_at: staleAt() } });
        m.ssrfSafeFetch.mockResolvedValue(res(200, roster('live')));
        const out = await fetchPeerRoster(PEER_ID);
        expect(out!.members[0]).toEqual({ id: 1, name: 'live', avatarUrl: null });
        expect(m.ssrfSafeFetch.mock.calls[0][0]).toBe(`${PEER_ORIGIN}/api/alliance/roster`);
        const up = fake.find('alliance_peer_directory_cache', 'upsert')[0];
        expect(up.writeOptions).toEqual({ onConflict: 'peer_id' });
        expect((up.payload as { roster: AllyRosterData }).roster.members[0].avatarUrl).toBeNull();
        expect(up.payload).toMatchObject({ peer_id: PEER_ID });
    });

    it('clears the cache (fail closed) when the peer answers 403 — it no longer shares that channel', async () => {
        activePeer();
        fake.queue('alliance_peer_directory_cache', { data: { roster: roster('old'), fleet, synced_at: staleAt() } });
        m.ssrfSafeFetch.mockResolvedValue(res(403, {}));
        expect(await fetchPeerRoster(PEER_ID)).toBeNull();
        expect(fake.find('alliance_peer_directory_cache', 'upsert')[0].payload).toMatchObject({ peer_id: PEER_ID, roster: null });
        fake.queue('alliance_peer_directory_cache', { data: { roster: null, fleet, synced_at: staleAt() } });
        expect(await fetchPeerFleet(PEER_ID)).toBeNull();
        expect(fake.find('alliance_peer_directory_cache', 'upsert')[1].payload).toMatchObject({ peer_id: PEER_ID, fleet: null });
    });

    it('keeps the stale cache untouched on a transient 5xx or an unreachable peer', async () => {
        activePeer();
        fake.queue('alliance_peer_directory_cache', { data: { roster: roster('old'), fleet, synced_at: staleAt() } });
        m.ssrfSafeFetch.mockResolvedValue(res(503, {}));
        expect((await fetchPeerRoster(PEER_ID))!.members[0].name).toBe('old');
        fake.queue('alliance_peer_directory_cache', { data: { roster: null, fleet, synced_at: staleAt() } });
        expect(await fetchPeerFleet(PEER_ID)).toEqual(fleet);
        fake.on('alliance_peers', { data: null }); // peer no longer Active
        fake.queue('alliance_peer_directory_cache', { data: null });
        expect(await fetchPeerFleet(PEER_ID)).toBeNull();
        fake.queue('alliance_peer_directory_cache', { data: null });
        expect(await fetchPeerRoster(PEER_ID)).toBeNull();
        expect(fake.find('alliance_peer_directory_cache', 'upsert')).toHaveLength(0);
    });

    it('falls back to the cache when the live fetch throws', async () => {
        activePeer();
        m.ssrfSafeFetch.mockRejectedValue(new Error('net'));
        fake.queue('alliance_peer_directory_cache', { data: { roster: roster('old'), fleet, synced_at: staleAt() } });
        expect((await fetchPeerRoster(PEER_ID))!.members[0].name).toBe('old');
        fake.queue('alliance_peer_directory_cache', { data: { roster: null, fleet, synced_at: staleAt() } });
        expect(await fetchPeerFleet(PEER_ID)).toEqual(fleet);
        fake.queue('alliance_peer_directory_cache', { data: null }, { data: null });
        expect(await fetchPeerRoster(PEER_ID)).toBeNull();
        expect(await fetchPeerFleet(PEER_ID)).toBeNull();
    });

    it('live-refreshes and caps a stale fleet', async () => {
        activePeer();
        fake.queue('alliance_peer_directory_cache', { data: { roster: null, fleet: null, synced_at: null } });
        m.ssrfSafeFetch.mockResolvedValue(res(200, { ...fleet, groups: Array.from({ length: 2100 }, () => ({ name: 'g', type: 't', totalShips: 0 })) }));
        const out = await fetchPeerFleet(PEER_ID);
        expect(out!.groups).toHaveLength(2000);
        expect(m.ssrfSafeFetch.mock.calls[0][0]).toBe(`${PEER_ORIGIN}/api/alliance/fleet`);
        expect((fake.find('alliance_peer_directory_cache', 'upsert')[0].payload as { fleet: AllyFleetSummary }).fleet.groups).toHaveLength(2000);
    });

    it('refreshPeerDirectory runs profile → roster → fleet and propagates network errors', async () => {
        activePeer();
        m.ssrfSafeFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/profile')) return res(200, { orgName: 'B' });
            if (url.endsWith('/roster')) return res(200, roster('r'));
            return res(200, fleet);
        });
        await refreshPeerDirectory(PEER_ID);
        expect(m.ssrfSafeFetch.mock.calls.map((c) => (c[0] as string).split('/').pop())).toEqual(['profile', 'roster', 'fleet']);
        expect(fake.find('alliance_peer_directory_cache', 'upsert')).toHaveLength(2);
        m.ssrfSafeFetch.mockReset();
        m.ssrfSafeFetch.mockRejectedValue(new Error('down'));
        await expect(refreshPeerDirectory(PEER_ID)).rejects.toThrow('down');
    });
});
