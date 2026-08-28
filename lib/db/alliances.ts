// =============================================================================
// lib/db/alliances.ts — Alliances federation (Phase 1: directory + handshake)
// =============================================================================
// Secure server-to-server federation between independent self-hosted instances.
// The browser NEVER holds a peer key or talks to a peer — everything here runs
// on the server under the service-role client.
//
// Trust bootstrap: SYMMETRIC DUAL-CODE, code-authenticated X25519 ECDH.
//   - Each org generates a one-time pairing code (singleton settings value),
//     swaps it out-of-band, and enters the OTHER org's code when adding a peer.
//   - Both servers hold both code values → shared secret S = HKDF(canonical(codes)).
//   - The handshake exchanges ephemeral X25519 public keys + nonces, with the
//     transcript HMAC-authenticated under S, so a MITM cannot substitute keys
//     even behind a TLS-terminating proxy. The codes never transit the wire.
//   - A master secret (ECDH ⊕ S) derives two DIRECTIONAL keys by protocol role
//     (initiator/responder) — identical on both sides, NEVER transmitted. Our
//     outbound key is stored encrypted-at-rest; the peer's inbound key is stored
//     hashed in api_keys so verifyApiKey() matches it on inbound channel calls.
// =============================================================================

import {
    randomBytes, createHash, createHmac, hkdfSync, timingSafeEqual,
    generateKeyPairSync, diffieHellman, createPublicKey,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { supabase, handleSupabaseError, broadcastToOrg, safeFetch, getSystemRoles } from './common.js';
import { collectShareableIntel, getMaxShareableClearance, verifyApiKey } from './system.js';
import { getCachedAllianceSyncConfig, noteInboundContact, tryConsumeToken } from './allianceSyncState.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { sanitizePublicLinkUrl } from '../linkUrl.js';
import { resolveAppUrl } from '../appUrl.js';
import { sanitizeImageUrl } from '../imageUrl.js';
import { stripHtml, stripHtmlSingleLine } from '../textSanitize.js';
import { ssrfSafeFetch } from '../ssrf.js';
import type {
    AlliancePeer, AllianceDirectoryEntry, AllianceSelfProfile, AlliancePairingCode, AllianceChannels,
    AllyRosterMember, AllyRosterData, AllyFleetSummary, AllyFleetGroup,
} from '../../types.js';
import { log as baseLog } from '../log.js';

const log = baseLog.child({ module: 'db.alliances' });

const CODE_TTL_MS = 15 * 60_000;       // pairing codes live 15 minutes
const SELF_PROFILE_KEY = 'allianceSelfProfile';
const LOCAL_CODE_KEY = 'allianceLocalPairingCode';
const FETCH_TIMEOUT_MS = 15_000;

const nowIso = () => new Date().toISOString();

// =============================================================================
// Crypto helpers (pure — unit-tested in tests/alliances.crypto.test.ts)
// =============================================================================

/** Order two strings deterministically so both peers derive identical material. */
export function canonicalPair(a: string, b: string): [string, string] {
    return a <= b ? [a, b] : [b, a];
}

const PAIR_SALT = Buffer.from('alliance-pair-salt-v1', 'utf8');

/** Shared secret from both one-time pairing codes (order-independent). */
export function deriveSharedSecret(localCode: string, peerCode: string): Buffer {
    const [c1, c2] = canonicalPair(localCode.trim(), peerCode.trim());
    const ikm = Buffer.from(`${c1}\u0000${c2}`, 'utf8');
    return Buffer.from(hkdfSync('sha256', ikm, PAIR_SALT, Buffer.from('alliance-pair-v1'), 32));
}

/** Fresh ephemeral X25519 keypair; public key as SPKI/DER base64. */
export function genEphemeral(): { publicKeyB64: string; privateKey: KeyObject } {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    return { publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
}

/** ECDH against a peer's SPKI/DER base64 public key. */
export function ecdhShared(privateKey: KeyObject, peerPublicKeyB64: string): Buffer {
    const publicKey = createPublicKey({ key: Buffer.from(peerPublicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return diffieHellman({ privateKey, publicKey });
}

/** Master secret binds the ECDH output to the code-derived secret S. */
export function deriveMaster(ecdh: Buffer, S: Buffer): Buffer {
    return Buffer.from(hkdfSync('sha256', ecdh, S, Buffer.from('alliance-master-v1'), 32));
}

/**
 * Two directional channel keys, labelled by protocol role (initiator/responder).
 * Both sides derive the same pair from the same master; each keeps one as its
 * outbound key and the other (hashed) as the key it expects inbound.
 */
export function deriveDirectionalKeys(master: Buffer): { initToResp: string; respToInit: string } {
    const a = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('alliance-dir:init->resp'), 24));
    const b = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('alliance-dir:resp->init'), 24));
    return { initToResp: `ak_${a.toString('base64url')}`, respToInit: `ak_${b.toString('base64url')}` };
}

/** Initiator's proof of knowledge of S over its ephemeral pub + nonce. */
export function codeProofMac(S: Buffer, ephemeralPubB64: string, nonceB64: string): Buffer {
    return createHmac('sha256', S)
        .update('alliance-init-v1').update('\u0000')
        .update(ephemeralPubB64).update('\u0000')
        .update(nonceB64).digest();
}

/** Responder's MAC binds BOTH ephemeral pubs + nonces under S. */
export function responderMac(S: Buffer, initPub: string, initNonce: string, respPub: string, respNonce: string): Buffer {
    return createHmac('sha256', S)
        .update('alliance-resp-v1').update('\u0000')
        .update(initPub).update('\u0000').update(initNonce).update('\u0000')
        .update(respPub).update('\u0000').update(respNonce).digest();
}

/** Constant-time, length-checked buffer comparison. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
    if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

// =============================================================================
// URL / settings helpers
// =============================================================================

/**
 * Validate a peer base URL and return its origin, or null. Public https only,
 * SSRF-guarded. A dev-only escape hatch (NODE_ENV!=='production' +
 * ALLIANCE_DEV_ALLOW_LOOPBACK=1) permits loopback for two-instance E2E testing.
 */
function validatePeerBaseUrl(raw: unknown): string | null {
    const ok = sanitizePublicLinkUrl(raw);
    if (ok && ok.startsWith('https:')) { try { return new URL(ok).origin; } catch { return null; } }
    if (process.env.NODE_ENV !== 'production' && process.env.ALLIANCE_DEV_ALLOW_LOOPBACK === '1') {
        try {
            const u = new URL(String(raw));
            if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
        } catch { /* fall through */ }
    }
    return null;
}

async function readSetting<T>(key: string): Promise<T | null> {
    const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    return (data?.value as T) ?? null;
}

async function writeSetting(key: string, value: unknown): Promise<void> {
    const { error } = await supabase.from('settings').upsert({ key, value }, { onConflict: 'key' });
    handleSupabaseError({ error, message: `Failed to write ${key}` });
}

async function deleteSetting(key: string): Promise<void> {
    await supabase.from('settings').delete().eq('key', key);
}

/**
 * Our own public origin — the value we ADVERTISE to a peer as `fromBaseUrl`, which
 * the peer looks up with an exact `.eq('base_url', origin)` match (see respondToPair).
 * A wrong value therefore fails pairing outright rather than degrading.
 *
 * Resolution is env-first (process.env.APP_URL over settings.systemConfig.appUrl) —
 * see lib/appUrl.ts. It previously read the stored row ONLY, so an install that set
 * APP_URL correctly in .env but never triggered the admin console's write could not
 * federate at all, and a database restored onto a new host advertised the old origin.
 *
 * The resolved value then goes through validatePeerBaseUrl — the SAME public-https +
 * SSRF check we apply to a peer's origin, including its NODE_ENV!=='production' +
 * ALLIANCE_DEV_ALLOW_LOOPBACK=1 hatch for two-instance local E2E. Reusing it (rather
 * than hand-rolling a second check) keeps both sides of the handshake on one rule, and
 * means the localhost fallback from resolveAppUrl is rejected in production instead of
 * being advertised.
 */
async function getOurOrigin(): Promise<string | undefined> {
    const sys = await readSetting<{ appUrl?: string }>('systemConfig');
    const resolved = resolveAppUrl(process.env.APP_URL, sys?.appUrl);
    return validatePeerBaseUrl(resolved.url) ?? undefined;
}

// Our singleton one-time pairing code (the code WE generated and shared OOB).
async function getLocalCode(): Promise<string | null> {
    const v = await readSetting<{ codeEnc: string; expiresAt: string }>(LOCAL_CODE_KEY);
    if (!v) return null;
    if (new Date(v.expiresAt).getTime() < Date.now()) { await deleteSetting(LOCAL_CODE_KEY); return null; }
    return decryptSecret(v.codeEnc);
}
async function clearLocalCode(): Promise<void> { await deleteSetting(LOCAL_CODE_KEY); }

// =============================================================================
// Row mappers
// =============================================================================

interface PeerRow {
    id: string; label: string; base_url: string;
    peer_org_name: string | null; peer_org_tag: string | null;
    peer_icon_url: string | null; peer_blurb: string | null;
    status: AlliancePeer['status']; type: AlliancePeer['type'];
    inbound_max_clearance: number; outbound_max_clearance: number;
    channels: AllianceChannels | null; pairing_state: string;
    outbound_key_enc: string | null; inbound_key_id: string | null;
    entered_peer_code_enc: string | null; entered_peer_code_expires: string | null;
    last_contact_at: string | null; created_at: string;
    // Live-sync engine state (lib/db/allianceSync.ts).
    sync_health: string | null; sync_failures: number | null;
    sync_last_ok_at: string | null; sync_next_attempt_at: string | null;
    sync_alert: string | null;
    intel_synced_at: string | null; ops_synced_at: string | null;
}

// STRICT allow-list to the browser — never spread the row. The directory-cache
// jsonb blobs live in a separate table and deliberately have NO mapping here.
function mapPeerRow(row: PeerRow): AlliancePeer {
    return {
        id: row.id, label: row.label, baseUrl: row.base_url,
        peerOrgName: row.peer_org_name, peerOrgTag: row.peer_org_tag,
        peerIconUrl: row.peer_icon_url, peerBlurb: row.peer_blurb,
        status: row.status, type: row.type,
        inboundMaxClearance: row.inbound_max_clearance, outboundMaxClearance: row.outbound_max_clearance,
        channels: row.channels || {}, pairingState: row.pairing_state,
        hasOutboundKey: !!row.outbound_key_enc,
        lastContactAt: row.last_contact_at, createdAt: row.created_at,
        syncHealth: (row.sync_health as AlliancePeer['syncHealth']) ?? 'unknown',
        syncFailures: row.sync_failures ?? 0,
        syncLastOkAt: row.sync_last_ok_at ?? null,
        syncNextAttemptAt: row.sync_next_attempt_at ?? null,
        syncAlert: row.sync_alert ?? null,
    };
}

function mapDirectoryRow(row: Partial<PeerRow>): AllianceDirectoryEntry {
    return {
        id: row.id as string, peerOrgName: row.peer_org_name ?? null, peerOrgTag: row.peer_org_tag ?? null,
        peerIconUrl: row.peer_icon_url ?? null, peerBlurb: row.peer_blurb ?? null,
        status: row.status as AlliancePeer['status'], type: row.type as AlliancePeer['type'],
        lastContactAt: row.last_contact_at ?? null,
    };
}

// Feed-style rows (legacy backfill + manual subscriptions) are managed in the
// Alliances tab's "Receive-only Feeds" card; they are excluded from the alliance
// directory + peer list, which show handshake-paired allies only.
const FEED_STATES = '(legacy,manual)';

// =============================================================================
// Directory + peer CRUD
// =============================================================================

export async function listAlliancePeers(): Promise<AlliancePeer[]> {
    const query = supabase.from('alliance_peers').select('id, label, base_url, peer_org_name, peer_org_tag, peer_icon_url, peer_blurb, status, type, inbound_max_clearance, outbound_max_clearance, channels, pairing_state, outbound_key_enc, inbound_key_id, entered_peer_code_enc, entered_peer_code_expires, last_contact_at, created_at, sync_health, sync_failures, sync_last_ok_at, sync_next_attempt_at, sync_alert, intel_synced_at, ops_synced_at')
        .not('pairing_state', 'in', FEED_STATES)
        .order('created_at', { ascending: false });
    const rows = await safeFetch<PeerRow[]>(query, [], 'Failed to list alliance peers');
    return rows.map(mapPeerRow);
}

export async function getAllianceDirectory(): Promise<AllianceDirectoryEntry[]> {
    const query = supabase.from('alliance_peers')
        .select('id, peer_org_name, peer_org_tag, peer_icon_url, peer_blurb, status, type, last_contact_at')
        .not('pairing_state', 'in', FEED_STATES)
        .neq('status', 'Dissolved')
        .order('peer_org_name', { ascending: true });
    const rows = await safeFetch<Partial<PeerRow>[]>(query, [], 'Failed to load alliance directory');
    return rows.map(mapDirectoryRow);
}

export interface AlliancePeerUpdates {
    label?: string;
    type?: AlliancePeer['type'];
    inboundMaxClearance?: number;
    outboundMaxClearance?: number;
    channels?: AllianceChannels;
}

export async function updateAlliancePeer(id: string, updates: AlliancePeerUpdates): Promise<void> {
    const dbUpdates: Record<string, unknown> = { updated_at: nowIso() };
    if (updates.label !== undefined) dbUpdates.label = updates.label;
    if (updates.type !== undefined) dbUpdates.type = updates.type;
    if (updates.inboundMaxClearance !== undefined) dbUpdates.inbound_max_clearance = updates.inboundMaxClearance;
    if (updates.outboundMaxClearance !== undefined) dbUpdates.outbound_max_clearance = updates.outboundMaxClearance;
    if (updates.channels !== undefined) dbUpdates.channels = updates.channels;
    const { error } = await supabase.from('alliance_peers').update(dbUpdates).eq('id', id);
    handleSupabaseError({ error, message: 'Failed to update alliance peer' });
    broadcastToOrg('alliance_update', { id });
}

/** Revoke an alliance: dissolve it and destroy both directions of key material. */
export async function revokeAlliancePeer(id: string): Promise<void> {
    const { data: row } = await supabase.from('alliance_peers').select('inbound_key_id').eq('id', id).maybeSingle();
    if (row?.inbound_key_id) await supabase.from('api_keys').delete().eq('id', row.inbound_key_id);
    const { error } = await supabase.from('alliance_peers').update({
        status: 'Dissolved', pairing_state: 'revoked',
        outbound_key_enc: null, inbound_key_id: null,
        entered_peer_code_enc: null, entered_peer_code_expires: null,
        revoked_at: nowIso(), updated_at: nowIso(),
    }).eq('id', id);
    handleSupabaseError({ error, message: 'Failed to revoke alliance peer' });
    broadcastToOrg('alliance_update', { id });
}

// =============================================================================
// Self profile (the org's own directory card; settings-backed)
// =============================================================================

const DEFAULT_SELF_PROFILE: AllianceSelfProfile = { orgName: '', directoryVisible: false };

export async function getAllianceSelfProfile(): Promise<AllianceSelfProfile> {
    const v = await readSetting<AllianceSelfProfile>(SELF_PROFILE_KEY);
    return { ...DEFAULT_SELF_PROFILE, ...(v || {}) };
}

export async function saveAllianceSelfProfile(profile: Partial<AllianceSelfProfile>): Promise<void> {
    const clean: AllianceSelfProfile = {
        orgName: String(profile?.orgName || '').slice(0, 120),
        orgTag: profile?.orgTag ? String(profile.orgTag).slice(0, 32) : undefined,
        iconUrl: profile?.iconUrl ? (sanitizeImageUrl(profile.iconUrl) || undefined) : undefined,
        blurb: profile?.blurb ? String(profile.blurb).slice(0, 500) : undefined,
        contactDiscord: profile?.contactDiscord ? String(profile.contactDiscord).slice(0, 120) : undefined,
        directoryVisible: !!profile?.directoryVisible,
    };
    await writeSetting(SELF_PROFILE_KEY, clean);
    broadcastToOrg('settings_update', {});
}

// =============================================================================
// Handshake — pairing code + add/connect + inbound responder
// =============================================================================

export async function generatePairingCode(): Promise<AlliancePairingCode> {
    const code = randomBytes(20).toString('base64url'); // ~160 bits
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    await writeSetting(LOCAL_CODE_KEY, { codeEnc: encryptSecret(code), expiresAt });
    return { code, expiresAt };
}

export interface AddPeerArgs {
    label: string;
    baseUrl: string;
    peerCode: string;
    type?: AlliancePeer['type'];
}

/**
 * Create or update a Pending peer with the OTHER org's code. No network call —
 * both admins do this, then ONE side calls connectPeer to run the handshake.
 */
export async function createOrUpdatePeer(args: AddPeerArgs): Promise<{ peerId: string }> {
    const origin = validatePeerBaseUrl(args.baseUrl);
    if (!origin) throw new Error('Invalid peer URL: must be a public https:// origin.');
    const peerCode = String(args.peerCode || '').trim();
    if (!peerCode) throw new Error('Peer pairing code is required.');
    const label = String(args.label || '').slice(0, 120) || origin;
    const type = args.type || 'Alliance';
    const enteredEnc = encryptSecret(peerCode);
    const enteredExp = new Date(Date.now() + CODE_TTL_MS).toISOString();

    // Exact origin match — new URL().origin already normalizes scheme/host/port,
    // so .eq() is correct. .ilike() would treat LIKE metacharacters (_ / %) in a
    // caller-influenced origin as wildcards and could mis-match a DIFFERENT peer.
    const { data: existing } = await supabase.from('alliance_peers').select('id').eq('base_url', origin).maybeSingle();
    if (existing) {
        const { error } = await supabase.from('alliance_peers').update({
            label, type, entered_peer_code_enc: enteredEnc, entered_peer_code_expires: enteredExp,
            pairing_state: 'awaiting_peer', status: 'Pending', updated_at: nowIso(),
        }).eq('id', existing.id);
        handleSupabaseError({ error, message: 'Failed to update alliance peer' });
        broadcastToOrg('alliance_update', { id: existing.id });
        return { peerId: existing.id };
    }
    const { data: ins, error } = await supabase.from('alliance_peers').insert({
        label, base_url: origin, type, status: 'Pending', pairing_state: 'awaiting_peer',
        entered_peer_code_enc: enteredEnc, entered_peer_code_expires: enteredExp,
    }).select('id').single();
    handleSupabaseError({ error, message: 'Failed to create alliance peer' });
    broadcastToOrg('alliance_update', { id: ins!.id });
    return { peerId: ins!.id };
}

async function markFailed(peerId: string): Promise<void> {
    await supabase.from('alliance_peers').update({ pairing_state: 'failed', updated_at: nowIso() }).eq('id', peerId);
    broadcastToOrg('alliance_update', { id: peerId });
}

/**
 * Persist derived directional keys: our outbound key encrypted on the peer row,
 * the peer's inbound key hashed into api_keys (so verifyApiKey matches it).
 */
async function persistKeys(peerId: string, keys: { outboundKey: string; inboundKey: string }): Promise<void> {
    const hash = createHash('sha256').update(keys.inboundKey).digest('hex');
    const { data: prev } = await supabase.from('alliance_peers').select('inbound_key_id').eq('id', peerId).maybeSingle();
    if (prev?.inbound_key_id) await supabase.from('api_keys').delete().eq('id', prev.inbound_key_id);
    const { data: keyRow, error: keyErr } = await supabase.from('api_keys')
        .insert({ label: `alliance:${peerId}`, key_hash: hash }).select('id').single();
    handleSupabaseError({ error: keyErr, message: 'Failed to mint inbound alliance key' });
    const { error } = await supabase.from('alliance_peers').update({
        outbound_key_enc: encryptSecret(keys.outboundKey), inbound_key_id: keyRow!.id,
        status: 'Active', pairing_state: 'active', last_contact_at: nowIso(), updated_at: nowIso(),
        handshake_nonce: null, handshake_expires: null,
    }).eq('id', peerId);
    handleSupabaseError({ error, message: 'Failed to persist alliance keys' });
}

interface PairResponse { ephemeralPub: string; nonce: string; mac: string }

async function postPair(origin: string, body: Record<string, unknown>): Promise<PairResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        // ssrfSafeFetch = resolve-validate-pin + no redirects. No credential on
        // this pre-handshake call, but a followed redirect would still be an SSRF
        // into private/metadata targets.
        const res = await ssrfSafeFetch(`${origin}/api/alliance/pair`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body), signal: controller.signal,
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`Peer returned ${res.status}${txt ? `: ${txt.slice(0, 200)}` : ''}`);
        }
        return await res.json() as PairResponse;
    } finally {
        clearTimeout(timer);
    }
}

/** Run the outbound handshake for an existing Pending peer (initiator side). */
export async function connectPeer(peerId: string): Promise<{ peerId: string; status: string }> {
    const ourOrigin = await getOurOrigin();
    // Names the env var rather than a settings screen: APP_URL is the source of truth
    // and there is no App URL field in the admin console to point an operator at.
    if (!ourOrigin) throw new Error('Set APP_URL to this deployment’s public https origin (in .env) before pairing.');
    const localCode = await getLocalCode();
    if (!localCode) throw new Error('Generate a pairing code first (it may have expired).');

    const { data: row } = await supabase.from('alliance_peers').select('entered_peer_code_enc, entered_peer_code_expires, base_url').eq('id', peerId).maybeSingle();
    if (!row) throw new Error('Alliance peer not found.');
    if (!row.entered_peer_code_enc) throw new Error('Missing the peer pairing code — re-add the partner.');
    if (row.entered_peer_code_expires && new Date(row.entered_peer_code_expires).getTime() < Date.now()) {
        throw new Error('The peer pairing code has expired — re-add the partner.');
    }
    const origin = validatePeerBaseUrl(row.base_url);
    if (!origin) throw new Error('Invalid peer URL.');
    const peerCode = decryptSecret(row.entered_peer_code_enc);

    const S = deriveSharedSecret(localCode, peerCode);
    const eph = genEphemeral();
    const nonce = randomBytes(16).toString('base64');
    const codeProof = codeProofMac(S, eph.publicKeyB64, nonce).toString('base64');

    let resp: PairResponse;
    try {
        resp = await postPair(origin, { fromBaseUrl: ourOrigin, ephemeralPub: eph.publicKeyB64, nonce, codeProof });
    } catch (e) {
        await markFailed(peerId);
        throw e;
    }

    const expected = responderMac(S, eph.publicKeyB64, nonce, String(resp.ephemeralPub), String(resp.nonce));
    if (!safeEqual(expected, Buffer.from(String(resp.mac || ''), 'base64'))) {
        await markFailed(peerId);
        throw new Error('Handshake verification failed — wrong code or tampered response.');
    }

    const master = deriveMaster(ecdhShared(eph.privateKey, String(resp.ephemeralPub)), S);
    const { initToResp, respToInit } = deriveDirectionalKeys(master);
    // Initiator: we call them with initToResp; they call us with respToInit.
    await persistKeys(peerId, { outboundKey: initToResp, inboundKey: respToInit });
    await clearLocalCode();
    await supabase.from('alliance_peers').update({ entered_peer_code_enc: null, entered_peer_code_expires: null, is_local_initiator: true }).eq('id', peerId);
    await refreshPeerProfile(peerId).catch((e) => log.warn('peer profile refresh failed', { peerId, err: e }));
    broadcastToOrg('alliance_update', { id: peerId });
    return { peerId, status: 'Active' };
}

export interface RespondToPairArgs {
    fromBaseUrl: string;
    ephemeralPub: string;
    nonce: string;
    codeProof: string;
}

/** Inbound handshake responder (called by POST /api/alliance/pair). */
export async function respondToPair(args: RespondToPairArgs): Promise<PairResponse> {
    const origin = validatePeerBaseUrl(args.fromBaseUrl);
    if (!origin) throw new Error('invalid_from_url');
    if (!args.ephemeralPub || !args.nonce || !args.codeProof) throw new Error('malformed_request');

    const localCode = await getLocalCode();
    if (!localCode) throw new Error('no_pending_pairing');

    // Exact origin match (see createOrUpdatePeer): the initiator-supplied
    // fromBaseUrl is normalized to an origin, so .eq() is correct and .ilike()
    // would let an underscore/percent in the origin wildcard-match another peer.
    const { data: row } = await supabase.from('alliance_peers').select('id, entered_peer_code_enc, entered_peer_code_expires').eq('base_url', origin).maybeSingle();
    if (!row || !row.entered_peer_code_enc) throw new Error('no_pending_pairing');
    if (row.entered_peer_code_expires && new Date(row.entered_peer_code_expires).getTime() < Date.now()) {
        throw new Error('pairing_expired');
    }
    const peerCode = decryptSecret(row.entered_peer_code_enc);
    const S = deriveSharedSecret(localCode, peerCode);

    const expectedProof = codeProofMac(S, String(args.ephemeralPub), String(args.nonce));
    if (!safeEqual(expectedProof, Buffer.from(String(args.codeProof || ''), 'base64'))) {
        throw new Error('handshake_verification_failed');
    }

    const eph = genEphemeral();
    const nonce = randomBytes(16).toString('base64');
    const mac = responderMac(S, String(args.ephemeralPub), String(args.nonce), eph.publicKeyB64, nonce);

    const master = deriveMaster(ecdhShared(eph.privateKey, String(args.ephemeralPub)), S);
    const { initToResp, respToInit } = deriveDirectionalKeys(master);
    // Responder: we call them with respToInit; they call us with initToResp.
    await persistKeys(row.id, { outboundKey: respToInit, inboundKey: initToResp });
    await clearLocalCode();
    await supabase.from('alliance_peers').update({ entered_peer_code_enc: null, entered_peer_code_expires: null, is_local_initiator: false }).eq('id', row.id);
    broadcastToOrg('alliance_update', { id: row.id });
    // Cache the initiator's profile in the background.
    void refreshPeerProfile(row.id).catch((e) => log.warn('peer profile refresh failed', { peerId: row.id, err: e }));

    return { ephemeralPub: eph.publicKeyB64, nonce, mac: mac.toString('base64') };
}

// Inbound peer directory-card text caps. A paired-but-hostile peer's advertised
// orgName/orgTag/blurb are persisted on alliance_peers and re-served to every
// member with alliance:view (getAllianceDirectory) and rendered in the admin
// browser. The columns are unconstrained `text`, so without a bound a peer could
// park multi-MB strings. Mirror the SELF-profile caps (saveAllianceSelfProfile:
// 120/32/500) — a peer must never advertise a card larger than it could set on
// itself — and strip markup for parity with other persisted peer-text.
const MAX_PEER_ORG_NAME = 120;
const MAX_PEER_ORG_TAG = 32;
const MAX_PEER_BLURB = 500;

/** PURE: clamp + strip a paired peer's advertised directory-card text fields to
 *  the same caps we enforce on our own profile. Empty/absent → null. Mirrors
 *  sanitizeRosterProjection / sanitizeFleetProjection (unit-tested). */
export function sanitizePeerProfileText(
    profile: Partial<AllianceSelfProfile> | null | undefined,
): { orgName: string | null; orgTag: string | null; blurb: string | null } {
    const p = profile || {};
    return {
        orgName: stripHtmlSingleLine(p.orgName, MAX_PEER_ORG_NAME) || null,
        orgTag: stripHtmlSingleLine(p.orgTag, MAX_PEER_ORG_TAG) || null,
        blurb: stripHtml(p.blurb, MAX_PEER_BLURB) || null,
    };
}

/** Fetch + cache a paired peer's advertised profile (verified-peer call). */
export async function refreshPeerProfile(id: string): Promise<void> {
    const { data: row } = await supabase.from('alliance_peers').select('base_url, outbound_key_enc').eq('id', id).maybeSingle();
    if (!row?.outbound_key_enc) return;
    const origin = validatePeerBaseUrl(row.base_url);
    if (!origin) return;
    const key = decryptSecret(row.outbound_key_enc);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        // Credentialed — MUST go through ssrfSafeFetch (no redirects, vetted-IP
        // pinning) or the x-api-key can be exfiltrated.
        const res = await ssrfSafeFetch(`${origin}/api/alliance/profile`, { headers: { 'x-api-key': key }, signal: controller.signal });
        if (!res.ok) return;
        const p = await res.json() as Partial<AllianceSelfProfile>;
        // Length-cap + strip the inbound text fields (a hostile ally could
        // otherwise park multi-MB orgName/orgTag/blurb that we re-serve to every
        // member). iconUrl is clamped separately to a safe https image URL.
        const text = sanitizePeerProfileText(p);
        await supabase.from('alliance_peers').update({
            peer_org_name: text.orgName, peer_org_tag: text.orgTag,
            // The peer-supplied icon URL is rendered as <img src> in our admin
            // browser — clamp to a safe https image URL (reject javascript:/data:/
            // http: and other schemes) or drop it.
            peer_icon_url: sanitizeImageUrl(p.iconUrl) ?? null, peer_blurb: text.blurb,
            profile_fetched_at: nowIso(), last_contact_at: nowIso(), updated_at: nowIso(),
        }).eq('id', id);
        broadcastToOrg('alliance_update', { id });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Outbound server-to-server call to an Active alliance peer: validates the base
 * URL (SSRF-guarded, with the dev loopback bypass), decrypts our outbound key,
 * and fetches `${origin}${path}` with `x-api-key`. Returns the Response, or null
 * if the peer is missing/inactive/unreachable-by-policy. Reused by P3 joint ops.
 */
export async function callAlliancePeer(peerId: string, path: string, init?: { method?: string; body?: unknown }): Promise<Response | null> {
    const { data: peer } = await supabase.from('alliance_peers')
        .select('base_url, outbound_key_enc').eq('id', peerId).eq('status', 'Active').maybeSingle();
    if (!peer?.outbound_key_enc) return null;
    const origin = validatePeerBaseUrl(peer.base_url);
    if (!origin) return null;
    const key = decryptSecret(peer.outbound_key_enc);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        // Credentialed — MUST go through ssrfSafeFetch (no redirects, vetted-IP
        // pinning) or the x-api-key can be exfiltrated.
        return await ssrfSafeFetch(`${origin}${path}`, {
            method: init?.method || 'GET',
            headers: { 'x-api-key': key, ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
            body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

// =============================================================================
// Intel channel (Phase 2) — inbound peer resolution + outbound projection
// =============================================================================

/** Resolve the calling peer from its inbound directional key (the x-api-key it
 *  presents). Returns the Active peer that owns that hashed key, or null. */
export async function getAlliancePeerByInboundKey(key: string): Promise<PeerRow | null> {
    const verified = await verifyApiKey(key);
    if (!verified) return null;
    const { data } = await supabase.from('alliance_peers').select('id, label, base_url, peer_org_name, peer_org_tag, peer_icon_url, peer_blurb, status, type, inbound_max_clearance, outbound_max_clearance, channels, pairing_state, outbound_key_enc, inbound_key_id, entered_peer_code_enc, entered_peer_code_expires, last_contact_at, created_at, sync_health, sync_failures, sync_last_ok_at, sync_next_attempt_at, sync_alert, intel_synced_at, ops_synced_at')
        .eq('inbound_key_id', verified.id).eq('status', 'Active').maybeSingle();
    const peer = (data as PeerRow) || null;
    // Live-sync recovery trigger: authenticated contact from a peer we consider
    // down pulls its next probe forward (fire-and-forget; no-op when healthy).
    if (peer) noteInboundContact(peer);
    return peer;
}

/**
 * Per-peer outbound intel projection. Clearance is bounded by BOTH the org-wide
 * ceiling and this peer's outbound_max_clearance; only this peer's enabled
 * channels are shared; bulletins require the per-item shared_with_allies flag.
 */
export async function getAllianceShareableData(peer: Pick<PeerRow, 'outbound_max_clearance' | 'channels'>, since?: string) {
    const globalMax = await getMaxShareableClearance();
    const peerMax = peer.outbound_max_clearance ?? 0;
    return collectShareableIntel({
        maxClearance: Math.min(globalMax, peerMax),
        channels: peer.channels || {},
        bulletinsRequireSharedFlag: true,
        since,
    });
}

// =============================================================================
// Roster / fleet visibility (Phase 4) — opt-in, minimal, deny-by-default
// =============================================================================

// PostgREST returns a to-one embed as an object on a live DB but the inferred
// types can be array-shaped; normalise to a single value.
function embedOne<T>(v: T | T[] | null | undefined): T | null {
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

interface RosterRow {
    id: number; name: string; rsi_handle: string; avatar_url: string | null; is_duty: boolean;
    rank: { name: string; icon_url: string | null } | { name: string; icon_url: string | null }[] | null;
    unit: { id: number; name: string } | { id: number; name: string }[] | null;
    role: { name: string } | { name: string }[] | null;
    specializations: { specialization: { name: string; icon: string | null } | { name: string; icon: string | null }[] | null }[] | null;
}

/** PURE: project a user row to the ally-safe roster shape. Reads ONLY safe fields;
 *  PII (discord id, notes, clearance, permissions) is never touched. Unit-tested.
 *  `synthId` is a per-share synthetic index — the real internal users.id is
 *  NEVER emitted across the org boundary, mirroring projectOperationSnapshot's
 *  ownerId:0 / participant userId:i+1 id-neutralization. The receiver only needs
 *  a stable React key; it has no use for our internal primary key. */
export function toAllyRosterMember(row: RosterRow, synthId: number): AllyRosterMember {
    const rank = embedOne(row.rank);
    const unit = embedOne(row.unit);
    const role = embedOne(row.role);
    const specs = (row.specializations || [])
        .map((s) => embedOne(s.specialization))
        .filter((s): s is { name: string; icon: string | null } => !!s?.name)
        .slice(0, 3)
        .map((s) => ({ name: s.name, icon: s.icon }));
    return {
        id: synthId,
        rsiHandle: row.rsi_handle,
        name: row.name,
        avatarUrl: row.avatar_url ?? null,
        rankName: rank?.name ?? null,
        rankIcon: rank?.icon_url ?? null,
        unitName: unit?.name ?? null,
        roleName: role?.name ?? null,
        isDuty: !!row.is_duty,
        specializations: specs,
    };
}

/** Outbound roster projection for a peer with channels.roster enabled. Excludes
 *  Clients and soft-deleted users. Custom explicit SELECT — never `toUser`. */
export async function getAllyRosterProjection(peer: Pick<PeerRow, 'channels'>): Promise<AllyRosterData | null> {
    if (peer.channels?.roster !== true) return null;
    const roles = await getSystemRoles();
    let query = supabase.from('users')
        .select('id, name, rsi_handle, avatar_url, is_duty, rank:rank_id(name, icon_url), unit:unit_id(id, name), role:role_id(name), specializations:user_specializations(specialization:specialization_tags(name, icon))')
        .is('deleted_at', null);
    if (roles.client?.id) query = query.neq('role_id', roles.client.id);
    const rows = await safeFetch<RosterRow[]>(query, [], 'Failed to project ally roster');
    // Per-share synthetic index instead of the real users.id — the internal PK
    // must not cross the org boundary (see toAllyRosterMember / op-snapshot path).
    return { memberCount: rows.length, members: rows.map((row, i) => toAllyRosterMember(row, i + 1)), fetchedAt: nowIso() };
}

/** Outbound fleet projection for a peer with channels.fleet enabled. Aggregate
 *  only — ship-type counts + fleet group sizes, NO per-member ship ownership. */
export async function getAllyFleetProjection(peer: Pick<PeerRow, 'channels'>): Promise<AllyFleetSummary | null> {
    if (peer.channels?.fleet !== true) return null;

    interface ShipRow { ship: { career: string | null; role: string | null } | { career: string | null; role: string | null }[] | null }
    const shipRows = await safeFetch<ShipRow[]>(
        supabase.from('user_ships').select('ship:platform_ships(career, role)').limit(20_000),
        [], 'Failed to project ally fleet ships');
    const byCategory = new Map<string, number>();
    let totalShips = 0;
    for (const r of shipRows) {
        const ship = embedOne(r.ship);
        totalShips += 1;
        const cat = ship?.career || ship?.role || 'Other';
        byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
    }

    interface GroupRow { name: string; type: string; fleet_group_ships: { id: number }[] | null }
    const groupRows = await safeFetch<GroupRow[]>(
        supabase.from('fleet_groups').select('name, type, fleet_group_ships(id)').order('sort_order'),
        [], 'Failed to project ally fleet groups');
    const groups: AllyFleetGroup[] = groupRows.map((g) => ({ name: g.name, type: g.type, totalShips: (g.fleet_group_ships || []).length }));

    return {
        groupCount: groups.length,
        totalShips,
        shipsByCategory: Array.from(byCategory.entries()).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
        groups,
        fetchedAt: nowIso(),
    };
}

// =============================================================================
// Ally directory cache (live-sync D2 slow lane)
// =============================================================================
// Background-refreshed copy of a peer's shared roster/fleet projections in
// alliance_peer_directory_cache (a separate table — the blobs must not ride
// the alliance_peers select('*') hot path). INBOUND-ONLY: our local copy of
// data the peer chose to share with US — never re-served to other peers and
// never read by any outbound projection (pinned by tests). Image URLs are
// sanitized BEFORE the cache write, so a hostile peer can never park a
// javascript:/data: URL in our DB (stored-XSS class).

// Inbound directory-cache element caps. A hostile peer's roster/fleet projection
// is persisted in alliance_peer_directory_cache and rendered in our directory
// view, so cap members[]/groups[]/shipsByCategory[] to bound storage and admin-
// browser load. Ceilings are far above any real org's roster/fleet.
const MAX_CACHED_ROSTER_MEMBERS = 5_000;
const MAX_CACHED_FLEET_GROUPS = 2_000;
const MAX_CACHED_FLEET_CATEGORIES = 2_000;

/** PURE: clamp every member avatar URL before caching/serving and cap the
 *  members[] length to a generous ceiling. */
export function sanitizeRosterProjection(data: AllyRosterData): AllyRosterData {
    if (data && Array.isArray(data.members)) {
        return {
            ...data,
            members: data.members.slice(0, MAX_CACHED_ROSTER_MEMBERS)
                .map((m) => ({ ...m, avatarUrl: sanitizeImageUrl(m.avatarUrl) })),
        };
    }
    return data;
}

/** PURE: cap the aggregate fleet summary's element arrays before caching/serving.
 *  Counts only — no URLs to clamp — so this is purely a length guard. */
export function sanitizeFleetProjection(data: AllyFleetSummary): AllyFleetSummary {
    if (!data) return data;
    return {
        ...data,
        shipsByCategory: Array.isArray(data.shipsByCategory) ? data.shipsByCategory.slice(0, MAX_CACHED_FLEET_CATEGORIES) : data.shipsByCategory,
        groups: Array.isArray(data.groups) ? data.groups.slice(0, MAX_CACHED_FLEET_GROUPS) : data.groups,
    };
}

function directoryCacheFresh(syncedAt: string | null): boolean {
    if (!syncedAt) return false;
    const ageMs = Date.now() - new Date(syncedAt).getTime();
    if (!Number.isFinite(ageMs)) return false;
    return ageMs < getCachedAllianceSyncConfig().directoryHours * 3_600_000;
}

async function readDirectoryCache(peerId: string): Promise<{ roster: AllyRosterData | null; fleet: AllyFleetSummary | null; syncedAt: string | null } | null> {
    const { data } = await supabase.from('alliance_peer_directory_cache')
        .select('roster, fleet, synced_at').eq('peer_id', peerId).maybeSingle();
    if (!data) return null;
    return {
        roster: (data.roster as AllyRosterData | null) ?? null,
        fleet: (data.fleet as AllyFleetSummary | null) ?? null,
        syncedAt: (data.synced_at as string | null) ?? null,
    };
}

type DirectoryFetch<T> = { kind: 'data'; data: T } | { kind: 'not-shared' } | { kind: 'unavailable' };

/** Fetch a directory projection from the peer. 403 = the peer doesn't share
 *  this channel with us (a deliberate, cacheable "nothing"); other non-OK =
 *  transient, keep whatever we had. Network errors propagate (health). */
async function fetchDirectoryProjection<T>(peerId: string, path: string): Promise<DirectoryFetch<T>> {
    const res = await callAlliancePeer(peerId, path);
    if (!res) return { kind: 'unavailable' };
    if (res.status === 403) return { kind: 'not-shared' };
    if (!res.ok) return { kind: 'unavailable' };
    return { kind: 'data', data: await res.json() as T };
}

/** Live roster fetch → sanitize → cache. Returns the fresh value, null when
 *  the peer deliberately doesn't share (cache cleared — fail closed), or
 *  'unavailable' on a transient miss (cache untouched). */
async function refreshRosterCache(peerId: string): Promise<AllyRosterData | null | 'unavailable'> {
    const r = await fetchDirectoryProjection<AllyRosterData>(peerId, '/api/alliance/roster');
    if (r.kind === 'unavailable') return 'unavailable';
    const roster = r.kind === 'data' ? sanitizeRosterProjection(r.data) : null;
    await supabase.from('alliance_peer_directory_cache')
        .upsert({ peer_id: peerId, roster, synced_at: nowIso() }, { onConflict: 'peer_id' });
    return roster;
}

async function refreshFleetCache(peerId: string): Promise<AllyFleetSummary | null | 'unavailable'> {
    const r = await fetchDirectoryProjection<AllyFleetSummary>(peerId, '/api/alliance/fleet');
    if (r.kind === 'unavailable') return 'unavailable';
    // Aggregate counts only — no URLs to clamp — but still cap the element-array
    // lengths so a hostile peer can't park an oversized blob.
    const fleet = r.kind === 'data' ? sanitizeFleetProjection(r.data) : null;
    await supabase.from('alliance_peer_directory_cache')
        .upsert({ peer_id: peerId, fleet, synced_at: nowIso() }, { onConflict: 'peer_id' });
    return fleet;
}

/** Member-facing: serve the cached ally roster when fresh, else live-fetch
 *  (budget-gated) and refresh the cache; a transient miss degrades to the
 *  stale cache rather than nothing. Keys never reach the client. */
export async function fetchPeerRoster(peerId: string): Promise<AllyRosterData | null> {
    const cached = await readDirectoryCache(peerId);
    if (cached?.roster && directoryCacheFresh(cached.syncedAt)) return cached.roster;
    if (!tryConsumeToken(peerId)) return cached?.roster ?? null;
    try {
        const live = await refreshRosterCache(peerId);
        return live === 'unavailable' ? (cached?.roster ?? null) : live;
    } catch {
        return cached?.roster ?? null;
    }
}

export async function fetchPeerFleet(peerId: string): Promise<AllyFleetSummary | null> {
    const cached = await readDirectoryCache(peerId);
    if (cached?.fleet && directoryCacheFresh(cached.syncedAt)) return cached.fleet;
    if (!tryConsumeToken(peerId)) return cached?.fleet ?? null;
    try {
        const live = await refreshFleetCache(peerId);
        return live === 'unavailable' ? (cached?.fleet ?? null) : live;
    } catch {
        return cached?.fleet ?? null;
    }
}

/**
 * Background directory refresh (live-sync cron, slow cadence): profile card +
 * roster + fleet in one pass. Network errors propagate so the engine can feed
 * the health state machine.
 */
export async function refreshPeerDirectory(peerId: string): Promise<void> {
    await refreshPeerProfile(peerId);
    await refreshRosterCache(peerId);
    await refreshFleetCache(peerId);
}
