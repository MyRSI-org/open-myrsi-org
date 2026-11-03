import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// lib/db/system.ts — admin console data paths: roles & permissions, API keys, receive-only
// intel feeds, clearances/markers, service types, announcements, locations, radio channels,
// roles CRUD. Each test pins the exact query (explicit columns, scoping filters, write
// payload), the error contract (opaque message, no follow-on write or broadcast) and any
// SecurityDenial an out-of-scope id must raise.

vi.mock('../lib/db/common.js', async () => (await import('./cov-db-system-harness')).commonModule());
vi.mock('../lib/cache.js', async () => (await import('./cov-db-system-harness')).cacheModule());
vi.mock('../lib/push.js', async () => (await import('./cov-db-system-harness')).pushModule());
vi.mock('../lib/db/opReminders.js', async () => (await import('./cov-db-system-harness')).opRemindersModule());
vi.mock('../lib/db/bans.js', async () => (await import('./cov-db-system-harness')).bansModule());
vi.mock('../lib/db/roleDefaults.js', async () => (await import('./cov-db-system-harness')).roleDefaultsModule());
vi.mock('../lib/db/clientRoleLock.js', async () => (await import('./cov-db-system-harness')).clientRoleLockModule());
vi.mock('../lib/crypto.js', async () => (await import('./cov-db-system-harness')).cryptoModule());
vi.mock('../lib/db/secretsRotation.js', async () => (await import('./cov-db-system-harness')).secretsRotationModule());
vi.mock('../lib/db/securityEvents.js', async () => (await import('./cov-db-system-harness')).securityEventsModule());
vi.mock('../lib/db/seeder.js', async () => (await import('./cov-db-system-harness')).seederModule());
vi.mock('../lib/db/public.js', async () => (await import('./cov-db-system-harness')).publicModule());
vi.mock('../lib/discord.js', async () => (await import('./cov-db-system-harness')).discordModule());
vi.mock('../lib/log.js', async () => (await import('./cov-db-system-harness')).logModule());

import { db, mocks, logSpy, resetHarness, has, arg0 } from './cov-db-system-harness';
import { SecurityDenial } from '../lib/errors';
import {
    getRoleDetails, updateRolePermissions, createApiKey, listApiKeys, deleteApiKey,
    getTrustedFeeds, addTrustedFeed, deleteTrustedFeed, updateTrustedFeed, FEED_PAIRING_STATES,
    getSecurityClearances, updateSecurityClearance, getLimitingMarkers, addLimitingMarker,
    updateLimitingMarker, deleteLimitingMarker, getServiceTypes, addServiceType, updateServiceType,
    deleteServiceType, addAnnouncement, updateAnnouncement, deleteAnnouncement, addRole, updateRole,
    deleteRole, addLocation, updateLocation, deleteLocation, addRadioChannel, updateRadioChannel,
    deleteRadioChannel,
} from '../lib/db/system';

const UUID = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const FEED_ONLY = 'No receive-only feed with that id. Handshake-paired allies are managed from the Alliances peer list.';

beforeEach(() => resetHarness());

async function denial(p: Promise<unknown>): Promise<SecurityDenial> {
    try { await p; } catch (e) { return e as SecurityDenial; }
    throw new Error('expected a SecurityDenial');
}

// ─────────────────────────────────────────────────────────────────────────────
describe('getRoleDetails', () => {
    it('returns the role with only its assigned permission names plus the Client role id', async () => {
        db.on('roles', { data: { id: 5, name: 'Ops', description: 'd', is_system: false } });
        db.on('permissions', { data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }] });
        db.on('role_permissions', { data: [{ permission_id: 1 }, { permission_id: 3 }] });
        const out = await getRoleDetails('5' as unknown as number);
        expect(out).toEqual({
            role: { id: 5, name: 'Ops', description: 'd', is_system: false, permissions: ['a', 'c'] },
            allPermissions: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }],
            clientRoleId: 1,
        });
        const [rq] = db.q('roles');
        expect(arg0(rq, 'select')).toBe('id, name, description, is_system');
        expect(has(rq, 'eq', 'id', 5)).toBe(true);
        expect(arg0(db.q('permissions')[0], 'select')).toBe('id, name, description, category');
        const [rp] = db.q('role_permissions');
        expect(arg0(rp, 'select')).toBe('permission_id');
        expect(has(rp, 'eq', 'role_id', 5)).toBe(true);
    });

    it('null permission sets and no Client role resolve to empty / null', async () => {
        db.on('roles', { data: { id: 5, name: 'Ops' } });
        mocks.getSystemRoles.mockResolvedValueOnce(null);
        const out = await getRoleDetails(5);
        expect(out.role.permissions).toEqual([]);
        expect(out.allPermissions).toEqual([]);
        expect(out.clientRoleId).toBeNull();
    });

    it('each read fault throws its own opaque message; a missing role is not found', async () => {
        db.once('roles', { error: { message: 'x' } });
        await expect(getRoleDetails(5)).rejects.toThrow('Failed to fetch role');
        db.once('roles', { data: null });
        await expect(getRoleDetails(5)).rejects.toThrow('Role not found');
        db.on('roles', { data: { id: 5 } });
        db.once('permissions', { error: { message: 'x' } });
        await expect(getRoleDetails(5)).rejects.toThrow('Failed to fetch permissions');
        db.once('role_permissions', { error: { message: 'x' } });
        await expect(getRoleDetails(5)).rejects.toThrow('Failed to fetch role permissions');
    });
});

describe('updateRolePermissions', () => {
    it('rejects a non-positive / non-integer id before touching anything', async () => {
        for (const bad of [0, -3, 'abc']) {
            await expect(updateRolePermissions(bad as number, [])).rejects.toThrow('Invalid role id.');
        }
        expect(mocks.assertRoleIsNotClient).not.toHaveBeenCalled();
        expect(db.queries).toHaveLength(0);
    });

    it('refuses the code-owned Client role (assertion propagates, nothing written)', async () => {
        mocks.assertRoleIsNotClient.mockRejectedValueOnce(new Error('The Client role is locked.'));
        await expect(updateRolePermissions(1, ['admin:access'])).rejects.toThrow('The Client role is locked.');
        expect(db.q('role_permissions')).toHaveLength(0);
        expect(db.rpcCalls).toEqual([]);
    });

    it('a phantom role id is refused before the replace', async () => {
        await expect(updateRolePermissions(77, ['a'])).rejects.toThrow('Role not found.');
        expect(db.q('role_permissions')).toHaveLength(0);
        expect(db.rpcCalls).toEqual([]);
    });

    it('replaces the role\'s permission set through ONE atomic RPC with the resolved ids', async () => {
        db.on('roles', { data: { id: 6 } });
        db.on('permissions', { data: [{ id: 10, name: 'a' }, { id: 11, name: 'b' }] });
        await updateRolePermissions(6, ['a', 'b', 'ghost']);
        expect(mocks.assertRoleIsNotClient).toHaveBeenCalledWith(6);
        expect(has(db.q('permissions')[0], 'in', 'name', ['a', 'b', 'ghost'])).toBe(true);
        expect(db.rpcCalls).toEqual([{ fn: 'set_role_permissions', args: { p_role_id: 6, p_permission_ids: [10, 11] } }]);
        // No delete-then-insert from Node: the role is never transiently permission-less.
        expect(db.q('role_permissions')).toHaveLength(0);
    });

    // BUG PIN: the permissions lookup error used to be discarded, so a transient read fault
    // resolved to "no permissions", the delete leg ran, and the role was silently stripped of
    // EVERY permission behind a success response. Fail closed: refuse before the replace.
    it('a permissions lookup fault refuses the write and leaves the role untouched', async () => {
        db.on('roles', { data: { id: 6 } });
        db.on('permissions', { data: null, error: { code: '57014', message: 'statement timeout' } });
        await expect(updateRolePermissions(6, ['a', 'b'])).rejects.toThrow('Failed to resolve permissions — no change was made');
        expect(db.q('role_permissions')).toHaveLength(0);
        expect(db.rpcCalls).toEqual([]);
    });

    it('an RPC fault is surfaced, never reported as success, and Node writes nothing itself', async () => {
        db.on('roles', { data: { id: 6 } });
        db.on('permissions', { data: [{ id: 10, name: 'a' }] });
        db.rpcResults.push({ error: { code: '23503', message: 'fk' } });
        await expect(updateRolePermissions(6, ['a'])).rejects.toThrow('Failed to update role permissions');
        expect(db.rpcCalls).toHaveLength(1);
        expect(db.q('role_permissions')).toHaveLength(0);
    });

    it('an RPC error can never read as success even if handleSupabaseError stopped throwing', async () => {
        db.on('roles', { data: { id: 6 } });
        db.on('permissions', { data: [{ id: 10, name: 'a' }] });
        mocks.handleSupabaseError.mockImplementation(() => undefined);
        db.rpcResults.push({ error: { code: 'XX000', message: 'boom' } });
        await expect(updateRolePermissions(6, ['a'])).rejects.toThrow('Failed to update role permissions');
    });

    it.each([['42883'], ['PGRST202']])('set_role_permissions NOT DEPLOYED (%s) fails CLOSED with a re-run instruction — no fallback', async (code) => {
        db.on('roles', { data: { id: 6 } });
        db.on('permissions', { data: [{ id: 10, name: 'a' }] });
        db.rpcResults.push({ error: { code, message: 'Could not find the function public.set_role_permissions' } });
        await expect(updateRolePermissions(6, ['a']))
            .rejects.toThrow('Database update required — re-run schema.sql (set_role_permissions is missing). No change was made.');
        // Never the old delete-then-insert.
        expect(db.q('role_permissions')).toHaveLength(0);
        expect(logSpy.error).toHaveBeenCalledWith(expect.stringMatching(/not deployed/), { roleId: 6, code });
    });

    it('a role deleted between the check and the replace is "Role not found."', async () => {
        db.on('roles', { data: { id: 6 } });
        db.on('permissions', { data: [{ id: 10, name: 'a' }] });
        db.rpcResults.push({ error: { code: 'P0001', message: 'ROLE_PERMS_NO_ROLE: role 6 not found' } });
        await expect(updateRolePermissions(6, ['a'])).rejects.toThrow('Role not found.');
    });

    it('no resolvable names (or a null read) clears the role with an EMPTY set', async () => {
        db.on('roles', { data: { id: 6 } });
        await updateRolePermissions(6, ['ghost']);
        expect(db.rpcCalls).toEqual([{ fn: 'set_role_permissions', args: { p_role_id: 6, p_permission_ids: [] } }]);
        expect(db.q('role_permissions')).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('createApiKey', () => {
    it('stores ONLY the hash + display prefix and returns the raw key once (never key_hash)', async () => {
        db.on('api_keys', (q) => ({ data: { id: 'k1', label: 'Partner feed', scopes: ['feed'], key_prefix: (arg0(q, 'insert') as { key_prefix: string }).key_prefix } }));
        const out = await createApiKey('<b>Partner</b> feed  ', undefined, '2027-01-01T00:00:00.000Z');
        const [q] = db.q('api_keys');
        const row = arg0(q, 'insert') as Record<string, unknown>;
        expect(out.rawKey).toMatch(/^sk_[A-Za-z0-9_-]{16}$/);
        expect(row).toEqual({
            label: 'Partner feed',
            key_hash: createHash('sha256').update(out.rawKey).digest('hex'),
            key_prefix: `${out.rawKey.substring(0, 7)}****`,
            scopes: ['feed'],
            expires_at: '2027-01-01T00:00:00.000Z',
        });
        expect(arg0(q, 'select')).toBe('id, label, created_at, last_used_at, scopes, expires_at, key_prefix');
        expect(String(arg0(q, 'select'))).not.toContain('key_hash');
        expect(out.keyPrefix).toBe(row.key_prefix);
        expect(JSON.stringify(out)).not.toContain(String(row.key_hash));
    });

    it('explicit scopes are normalised (unknown dropped); expiry defaults to null', async () => {
        db.on('api_keys', { data: { id: 'k2' } });
        await createApiKey('Ally', ['alliance', 'root', 'alliance']);
        expect(arg0(db.q('api_keys')[0], 'insert')).toEqual(expect.objectContaining({ scopes: ['alliance'], expires_at: null }));
    });

    it('requires a label and reserves the alliance: prefix', async () => {
        await expect(createApiKey('  <i></i> ')).rejects.toThrow('A label is required.');
        await expect(createApiKey('alliance:peer-1')).rejects.toThrow('Labels starting with "alliance:" are reserved for alliance pairing credentials.');
        expect(db.q('api_keys')).toHaveLength(0);
    });

    it('a failed insert never hands back a phantom raw key', async () => {
        db.once('api_keys', { data: null, error: { message: 'dup' } });
        await expect(createApiKey('x')).rejects.toThrow('Failed to create API key');
        db.once('api_keys', { data: null });
        await expect(createApiKey('x')).rejects.toThrow('Failed to create API key');
    });
});

describe('listApiKeys', () => {
    it('maps every row field-by-field to camelCase with explicit columns and newest-first order', async () => {
        db.on('api_keys', { data: [
            { id: 'a', label: 'A', created_at: 't1', last_used_at: 't2', scopes: ['feed'], expires_at: 't3', revoked_at: 't4', revoked_reason: 'leak', key_prefix: 'sk_abcd****', key_hash: 'MUST-NOT-LEAK' },
            { id: 'b', label: 'B', created_at: 't5', last_used_at: null, scopes: 'garbage', expires_at: null, revoked_at: null, revoked_reason: null, key_prefix: null },
        ] });
        const out = await listApiKeys();
        const [q] = db.q('api_keys');
        expect(arg0(q, 'select')).toBe('id, label, created_at, last_used_at, scopes, expires_at, revoked_at, revoked_reason, key_prefix');
        expect(has(q, 'order', 'created_at', { ascending: false })).toBe(true);
        expect(out).toEqual([
            { id: 'a', label: 'A', createdAt: 't1', lastUsedAt: 't2', scopes: ['feed'], expiresAt: 't3', revokedAt: 't4', revokedReason: 'leak', keyPrefix: 'sk_abcd****' },
            { id: 'b', label: 'B', createdAt: 't5', lastUsedAt: undefined, scopes: null, expiresAt: null, revokedAt: null, revokedReason: null, keyPrefix: 'sk_****' },
        ]);
        expect(JSON.stringify(out)).not.toContain('MUST-NOT-LEAK');
    });

    it('a read fault yields an empty list', async () => {
        db.on('api_keys', { error: { message: 'x' } });
        expect(await listApiKeys()).toEqual([]);
    });
});

describe('deleteApiKey — soft revoke, alliance credentials refused', () => {
    it('rejects a non-UUID id before any read', async () => {
        await expect(deleteApiKey('1 or 1=1')).rejects.toThrow('Invalid keyId: not a UUID');
        expect(db.queries).toHaveLength(0);
    });

    it('a read fault throws; an absent key is an idempotent no-op', async () => {
        db.once('api_keys', { error: { message: 'x' } });
        await expect(deleteApiKey(UUID)).rejects.toThrow('Failed to load API key');
        db.once('api_keys', { data: null });
        await expect(deleteApiKey(UUID)).resolves.toBeUndefined();
        expect(db.q('alliance_peers')).toHaveLength(0);
        expect(db.q('api_keys').filter((q) => has(q, 'update'))).toHaveLength(0);
    });

    it('a key still referenced by a peer is refused with an audited SecurityDenial', async () => {
        db.on('api_keys', { data: { id: UUID, label: 'mislabelled' } });
        db.on('alliance_peers', { data: { id: 'peer-1' } });
        const e = await denial(deleteApiKey(UUID));
        expect(e).toBeInstanceOf(SecurityDenial);
        expect(e.auditEvent).toBe('authz.alliance_key.delete_denied');
        expect(e.fields).toEqual({ keyId: UUID });
        const [pq] = db.q('alliance_peers');
        expect(arg0(pq, 'select')).toBe('id');
        expect(has(pq, 'eq', 'inbound_key_id', UUID)).toBe(true);
        expect(db.q('api_keys').filter((q) => has(q, 'update'))).toHaveLength(0);
    });

    it('a pairing-check fault throws rather than reading as unreferenced', async () => {
        db.on('api_keys', { data: { id: UUID, label: 'x' } });
        db.on('alliance_peers', { error: { message: 'x' } });
        await expect(deleteApiKey(UUID)).rejects.toThrow('Failed to check alliance pairing');
        expect(db.q('api_keys').filter((q) => has(q, 'update'))).toHaveLength(0);
    });

    it('revokes (never deletes) with actor + reason, only if not already revoked', async () => {
        db.on('api_keys', { data: { id: UUID, label: 'Feed' } }, (q) => has(q, 'maybeSingle'));
        await deleteApiKey(UUID, 7, 'leaked');
        const upd = db.q('api_keys').find((q) => has(q, 'update'))!;
        const patch = arg0(upd, 'update') as Record<string, unknown>;
        expect(patch).toEqual({ revoked_at: expect.any(String), revoked_by: 7, revoked_reason: 'leaked' });
        expect(Number.isNaN(Date.parse(String(patch.revoked_at)))).toBe(false);
        expect(has(upd, 'eq', 'id', UUID)).toBe(true);
        expect(has(upd, 'is', 'revoked_at', null)).toBe(true);
        expect(db.q('api_keys').some((q) => has(q, 'delete'))).toBe(false);
    });

    it('an orphaned alliance key is revocable but logged; defaults are null actor / "operator"', async () => {
        db.on('api_keys', { data: { id: UUID, label: 'alliance:peer-9' } }, (q) => has(q, 'maybeSingle'));
        await deleteApiKey(UUID);
        expect(logSpy.warn).toHaveBeenCalledWith('deleting an orphaned alliance inbound key', { keyId: UUID, label: 'alliance:peer-9' });
        const upd = db.q('api_keys').find((q) => has(q, 'update'))!;
        expect(arg0(upd, 'update')).toEqual(expect.objectContaining({ revoked_by: null, revoked_reason: 'operator' }));
    });

    it('a revoke write fault throws', async () => {
        db.on('api_keys', { data: { id: UUID, label: 'Feed' } }, (q) => has(q, 'maybeSingle'));
        db.on('api_keys', { error: { message: 'x' } }, (q) => has(q, 'update'));
        await expect(deleteApiKey(UUID)).rejects.toThrow('Failed to revoke API key');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('receive-only intel feeds (alliance_peers scoped to feed pairing states)', () => {
    it('getTrustedFeeds selects explicit columns, scopes to feed rows and NEVER returns the key', async () => {
        db.on('alliance_peers', { data: [
            { id: 'f1', label: 'L', base_url: 'https://ally', last_contact_at: 't', created_at: 'c', inbound_max_clearance: 2, outbound_key_enc: 'enc:SECRET', channels: { reports: false } },
            { id: 'f2', label: 'M', base_url: 'https://m', last_contact_at: null, created_at: 'd', inbound_max_clearance: 0, outbound_key_enc: null, channels: null },
        ] });
        const out = await getTrustedFeeds();
        const [q] = db.q('alliance_peers');
        expect(arg0(q, 'select')).toBe('id, label, base_url, last_contact_at, created_at, inbound_max_clearance, outbound_key_enc, channels');
        expect(has(q, 'in', 'pairing_state', [...FEED_PAIRING_STATES])).toBe(true);
        expect(has(q, 'order', 'created_at', { ascending: false })).toBe(true);
        expect(out).toEqual([
            { id: 'f1', label: 'L', url: 'https://ally', last_synced_at: 't', created_at: 'c', sync_reports: false, sync_warrants: true, sync_bulletins: true, inbound_max_clearance: 2, hasApiKey: true },
            { id: 'f2', label: 'M', url: 'https://m', last_synced_at: null, created_at: 'd', sync_reports: true, sync_warrants: true, sync_bulletins: true, inbound_max_clearance: 0, hasApiKey: false },
        ]);
        expect(JSON.stringify(out)).not.toContain('SECRET');
    });

    it('addTrustedFeed stores the partner key encrypted as a manual Active feed with defaults', async () => {
        await addTrustedFeed('Ally', 'https://ally.example', 'partner-key');
        expect(arg0(db.q('alliance_peers')[0], 'insert')).toEqual({
            label: 'Ally', base_url: 'https://ally.example', outbound_key_enc: 'enc:partner-key',
            status: 'Active', type: 'Alliance', pairing_state: 'manual', inbound_max_clearance: 5,
            channels: { reports: true, warrants: true, bulletins: true },
        });
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('settings_update', {});
    });

    it('addTrustedFeed honours explicit filter options including a zero ceiling', async () => {
        await addTrustedFeed('A', 'https://a', 'k', { syncReports: false, syncWarrants: true, syncBulletins: false, inboundMaxClearance: 0 });
        expect(arg0(db.q('alliance_peers')[0], 'insert')).toEqual(expect.objectContaining({
            inbound_max_clearance: 0, channels: { reports: false, warrants: true, bulletins: false },
        }));
    });

    it('addTrustedFeed surfaces an insert fault without broadcasting', async () => {
        db.on('alliance_peers', { error: { message: 'x' } });
        await expect(addTrustedFeed('A', 'https://a', 'k')).rejects.toThrow('Failed to add feed');
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('deleteTrustedFeed filters the discriminator INSIDE the delete', async () => {
        db.on('alliance_peers', { data: [{ id: UUID }] });
        await deleteTrustedFeed(UUID);
        const [q] = db.q('alliance_peers');
        expect(q.ops.map(([m]) => m)).toEqual(['delete', 'eq', 'in', 'select']);
        expect(has(q, 'eq', 'id', UUID)).toBe(true);
        expect(has(q, 'in', 'pairing_state', [...FEED_PAIRING_STATES])).toBe(true);
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('settings_update', {});
    });

    it('deleteTrustedFeed: bad id, transport fault, and a paired-ally id (0 rows ⇒ opaque denial)', async () => {
        await expect(deleteTrustedFeed('nope')).rejects.toThrow('Invalid feedId: not a UUID');
        db.once('alliance_peers', { error: { message: 'x' } });
        await expect(deleteTrustedFeed(UUID)).rejects.toThrow('Failed to remove feed');
        db.once('alliance_peers', { data: [] });
        const e = await denial(deleteTrustedFeed(UUID));
        expect(e.message).toBe(FEED_ONLY);
        expect(e.auditEvent).toBe('authz.feed_scope.denied');
        db.once('alliance_peers', { data: null });
        await expect(deleteTrustedFeed(UUID)).rejects.toThrow(FEED_ONLY);
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('updateTrustedFeed merges channel toggles over the stored jsonb and writes a scoped update', async () => {
        db.on('alliance_peers', { data: { channels: { reports: true, warrants: false } } }, (q) => has(q, 'maybeSingle'));
        db.on('alliance_peers', { data: [{ id: UUID }] }, (q) => has(q, 'update'));
        await updateTrustedFeed(UUID, { syncReports: false, syncBulletins: true, inboundMaxClearance: 3 });
        const [read, write] = db.q('alliance_peers');
        expect(arg0(read, 'select')).toBe('channels');
        expect(has(read, 'in', 'pairing_state', [...FEED_PAIRING_STATES])).toBe(true);
        expect(arg0(write, 'update')).toEqual({ channels: { reports: false, warrants: false, bulletins: true }, inbound_max_clearance: 3, updated_at: expect.any(String) });
        expect(has(write, 'eq', 'id', UUID)).toBe(true);
        expect(has(write, 'in', 'pairing_state', [...FEED_PAIRING_STATES])).toBe(true);
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('settings_update', {});
    });

    it('updateTrustedFeed with a null stored channels blob starts from {}', async () => {
        db.on('alliance_peers', { data: { channels: null } }, (q) => has(q, 'maybeSingle'));
        db.on('alliance_peers', { data: [{ id: UUID }] }, (q) => has(q, 'update'));
        await updateTrustedFeed(UUID, { syncWarrants: true });
        expect(arg0(db.q('alliance_peers')[1], 'update')).toEqual({ channels: { warrants: true }, updated_at: expect.any(String) });
    });

    it('updateTrustedFeed: clearance-only skips the read; an empty patch issues nothing', async () => {
        db.on('alliance_peers', { data: [{ id: UUID }] });
        await updateTrustedFeed(UUID, { inboundMaxClearance: 1 });
        expect(db.q('alliance_peers')).toHaveLength(1);
        expect(arg0(db.q('alliance_peers')[0], 'update')).toEqual({ inbound_max_clearance: 1, updated_at: expect.any(String) });
        resetHarness();
        await updateTrustedFeed(UUID, {});
        expect(db.queries).toHaveLength(0);
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });

    it('updateTrustedFeed fails closed: read fault, out-of-scope read, write fault, 0-row write', async () => {
        await expect(updateTrustedFeed('x', {})).rejects.toThrow('Invalid feedId: not a UUID');
        db.once('alliance_peers', { error: { message: 'x' } });
        await expect(updateTrustedFeed(UUID, { syncReports: true })).rejects.toThrow('Failed to load feed');
        db.once('alliance_peers', { data: null });
        await expect(updateTrustedFeed(UUID, { syncReports: true })).rejects.toThrow(FEED_ONLY);
        expect(db.q('alliance_peers').filter((q) => has(q, 'update'))).toHaveLength(0);
        db.once('alliance_peers', { error: { message: 'x' } });
        await expect(updateTrustedFeed(UUID, { inboundMaxClearance: 9 })).rejects.toThrow('Failed to update feed');
        db.once('alliance_peers', { data: [] });
        const e = await denial(updateTrustedFeed(UUID, { inboundMaxClearance: 9 }));
        expect(e.auditEvent).toBe('authz.feed_scope.denied');
        expect(mocks.broadcastToOrg).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('clearances & limiting markers', () => {
    it('getSecurityClearances / getLimitingMarkers read explicit columns in display order; faults → []', async () => {
        db.on('security_clearances', { data: [{ id: 1, name: 'U', level: 0 }] });
        db.on('security_limiting_markers', { data: [{ id: 2, name: 'NOFORN', code: 'NF', sync_restricted: true }] });
        expect(await getSecurityClearances()).toEqual([{ id: 1, name: 'U', level: 0 }]);
        expect(await getLimitingMarkers()).toEqual([{ id: 2, name: 'NOFORN', code: 'NF', sync_restricted: true }]);
        const [cq] = db.q('security_clearances');
        expect(arg0(cq, 'select')).toBe('id, name, level, description');
        expect(has(cq, 'order', 'level', { ascending: true })).toBe(true);
        const [mq] = db.q('security_limiting_markers');
        expect(arg0(mq, 'select')).toBe('id, name, code, description, sync_restricted');
        expect(has(mq, 'order', 'name', { ascending: true })).toBe(true);
        resetHarness();
        db.on('security_clearances', { error: { message: 'x' } });
        db.on('security_limiting_markers', { error: { message: 'x' } });
        expect(await getSecurityClearances()).toEqual([]);
        expect(await getLimitingMarkers()).toEqual([]);
    });

    it('clearance and marker writers send exact payloads and surface faults', async () => {
        await updateSecurityClearance(3, 'Secret', 'desc');
        await addLimitingMarker('Eyes Only', 'EO', 'd', true);
        await updateLimitingMarker(4, 'Eyes Only', 'EO', 'd2', false);
        await deleteLimitingMarker(4);
        const [c] = db.q('security_clearances');
        expect(arg0(c, 'update')).toEqual({ name: 'Secret', description: 'desc' });
        expect(has(c, 'eq', 'id', 3)).toBe(true);
        const [add, upd, del] = db.q('security_limiting_markers');
        expect(arg0(add, 'insert')).toEqual({ name: 'Eyes Only', code: 'EO', description: 'd', sync_restricted: true });
        expect(arg0(upd, 'update')).toEqual({ name: 'Eyes Only', code: 'EO', description: 'd2', sync_restricted: false });
        expect(has(upd, 'eq', 'id', 4)).toBe(true);
        expect(has(del, 'delete')).toBe(true);
        expect(has(del, 'eq', 'id', 4)).toBe(true);

        db.on('security_clearances', { error: { message: 'x' } });
        db.on('security_limiting_markers', { error: { message: 'x' } });
        await expect(updateSecurityClearance(3, 'a', 'b')).rejects.toThrow('Failed to update clearance');
        await expect(addLimitingMarker('a', 'b', 'c', false)).rejects.toThrow('Failed to add marker');
        await expect(updateLimitingMarker(1, 'a', 'b', 'c', false)).rejects.toThrow('Failed to update marker');
        await expect(deleteLimitingMarker(1)).rejects.toThrow('Failed to delete marker');
    });
});

describe('service types', () => {
    it('getServiceTypes maps rows to camelCase via explicit columns', async () => {
        db.on('service_types', { data: [
            { id: 1, name: 'Medical', icon: 'cross', color: '#f00', description: 'd', is_active: true, discord_channel_id: '123', created_at: 't' },
            { id: 2, name: 'Fuel', icon: 'fuel', color: '#0f0', description: null, is_active: false, discord_channel_id: null, created_at: 't' },
        ] });
        const out = await getServiceTypes();
        const [q] = db.q('service_types');
        expect(arg0(q, 'select')).toBe('id, name, icon, color, description, is_active, discord_channel_id, created_at');
        expect(has(q, 'order', 'name')).toBe(true);
        expect(out[0]).toEqual({ id: 1, name: 'Medical', icon: 'cross', color: '#f00', description: 'd', isActive: true, discordChannelId: '123' });
        expect(out[1].discordChannelId).toBeUndefined();
    });

    it('getServiceTypes: a fault, or a null payload, yields []', async () => {
        db.once('service_types', { error: { message: 'x' } });
        expect(await getServiceTypes()).toEqual([]);
        db.once('service_types', { data: null });
        expect(await getServiceTypes()).toEqual([]);
    });

    it('addServiceType inserts the mapped payload ("" channel → null)', async () => {
        await addServiceType({ name: 'Rescue', icon: 'i', color: '#fff', description: 'd', isActive: true, discordChannelId: '' });
        expect(arg0(db.q('service_types')[0], 'insert')).toEqual({ name: 'Rescue', icon: 'i', color: '#fff', description: 'd', is_active: true, discord_channel_id: null });
    });

    it.each(['42703', 'PGRST204'])('addServiceType retries WITHOUT the channel column on %s', async (code) => {
        db.once('service_types', { error: { code, message: 'no column' } });
        await addServiceType({ name: 'R', discordChannelId: '999' });
        const [first, retry] = db.q('service_types');
        expect(arg0(first, 'insert')).toEqual(expect.objectContaining({ discord_channel_id: '999' }));
        expect(arg0(retry, 'insert')).not.toHaveProperty('discord_channel_id');
        expect(logSpy.warn).toHaveBeenCalledWith('service_types.discord_channel_id unavailable; retrying without field', { migration: true });
    });

    it('addServiceType: a failed retry or a non-migration error throws (no retry for the latter)', async () => {
        db.once('service_types', { error: { code: '42703' } });
        db.once('service_types', { error: { code: '23505' } });
        await expect(addServiceType({ name: 'R' })).rejects.toThrow('Failed to add service type');
        resetHarness();
        db.once('service_types', { error: { code: '23505' } });
        await expect(addServiceType({ name: 'R' })).rejects.toThrow('Failed to add service type');
        expect(db.q('service_types')).toHaveLength(1);
    });

    it('updateServiceType updates by id, with the same migration retry', async () => {
        await updateServiceType({ id: 4, name: 'X', discordChannelId: '55' });
        const [q] = db.q('service_types');
        expect(arg0(q, 'update')).toEqual(expect.objectContaining({ name: 'X', discord_channel_id: '55' }));
        expect(has(q, 'eq', 'id', 4)).toBe(true);
        resetHarness();
        db.once('service_types', { error: { code: 'PGRST204' } });
        await updateServiceType({ id: 4, name: 'X' });
        const [, retry] = db.q('service_types');
        expect(arg0(retry, 'update')).not.toHaveProperty('discord_channel_id');
        expect(has(retry, 'eq', 'id', 4)).toBe(true);
        resetHarness();
        db.once('service_types', { error: { code: '42703' } });
        db.once('service_types', { error: { code: '42703' } });
        await expect(updateServiceType({ id: 4 })).rejects.toThrow('Failed to update service type');
        resetHarness();
        db.once('service_types', { error: { code: 'XX000' } });
        await expect(updateServiceType({ id: 4 })).rejects.toThrow('Failed to update service type');
        expect(db.q('service_types')).toHaveLength(1);
    });

    it('deleteServiceType deletes by id and surfaces a fault', async () => {
        await deleteServiceType(9);
        expect(has(db.q('service_types')[0], 'eq', 'id', 9)).toBe(true);
        db.on('service_types', { error: { message: 'fk' } });
        await expect(deleteServiceType(9)).rejects.toThrow('Failed to delete service type');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('announcements — sanitised writes, id-only nudges', () => {
    it('addAnnouncement strips markup, caps lengths, resolves the author name, and nudges with {}', async () => {
        db.on('users', { data: { name: 'Cmdr Shepard' } });
        await addAnnouncement({ title: '<b>Muster</b>\nnow', body: '<script>x</script>Report to hangar', type: 'info', audience: 'Member', expiryDate: '2027-01-01' } as never, 3);
        const [uq] = db.q('users');
        expect(arg0(uq, 'select')).toBe('name');
        expect(has(uq, 'eq', 'id', 3)).toBe(true);
        const row = arg0(db.q('announcements')[0], 'insert') as Record<string, unknown>;
        expect(row).toEqual({ title: 'Muster now', body: 'xReport to hangar', type: 'info', audience: 'Member', expiry_date: '2027-01-01', author: 'Cmdr Shepard' });
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('announcement_update', {});
    });

    it('addAnnouncement falls back to "Unknown" and caps the title at 200 chars', async () => {
        await addAnnouncement({ title: 't'.repeat(300), body: 'b' } as never, 3);
        const row = arg0(db.q('announcements')[0], 'insert') as Record<string, unknown>;
        expect(row.author).toBe('Unknown');
        expect(String(row.title)).toHaveLength(200);
    });

    it('updateAnnouncement / deleteAnnouncement scope by id and broadcast ONLY the id', async () => {
        await updateAnnouncement({ id: 'a1', title: '<i>T</i>', body: 'B', type: 'alert', audience: 'All', expiryDate: null } as never);
        const [u] = db.q('announcements');
        expect(arg0(u, 'update')).toEqual({ title: 'T', body: 'B', type: 'alert', audience: 'All', expiry_date: null });
        expect(has(u, 'eq', 'id', 'a1')).toBe(true);
        expect(mocks.broadcastToOrg).toHaveBeenLastCalledWith('announcement_update', { id: 'a1' });
        await deleteAnnouncement('a2');
        const d = db.q('announcements')[1];
        expect(has(d, 'delete')).toBe(true);
        expect(has(d, 'eq', 'id', 'a2')).toBe(true);
        expect(mocks.broadcastToOrg).toHaveBeenLastCalledWith('announcement_update', { id: 'a2' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('roles CRUD — reserved names and system-role protection', () => {
    it('addRole trims, enforces name rules (reserved case-insensitively) and caps the description', async () => {
        await addRole({ name: '  Pilots  ', description: '  Fly things ' });
        expect(arg0(db.q('roles')[0], 'insert')).toEqual({ name: 'Pilots', description: 'Fly things' });
        await addRole({ name: 'Crew', description: '   ' });
        expect(arg0(db.q('roles')[1], 'insert')).toEqual({ name: 'Crew', description: null });
        await expect(addRole({ name: ' ADMIN ' })).rejects.toThrow('That role name is reserved for a system role.');
        await expect(addRole({ name: '' })).rejects.toThrow('Role name is required.');
        await expect(addRole({})).rejects.toThrow('Role name is required.');
        await expect(addRole({ name: 'x'.repeat(61) })).rejects.toThrow('Role name is too long (max 60 characters).');
        await expect(addRole({ name: 'Ok', description: 'd'.repeat(501) })).rejects.toThrow('Role description is too long (max 500 characters).');
        // The description guard throws while building the insert payload: no insert is ever sent.
        expect(db.q('roles').filter((q) => has(q, 'insert'))).toHaveLength(2);
    });

    it('addRole surfaces a UNIQUE violation instead of toasting a phantom role', async () => {
        db.on('roles', { error: { code: '23505' } });
        await expect(addRole({ name: 'Dup' })).rejects.toThrow('Failed to add role');
    });

    it('updateRole: not found, system rename refused, padded system name keeps the STORED name', async () => {
        db.once('roles', { data: null });
        await expect(updateRole({ id: 1, name: 'x' })).rejects.toThrow('Role not found');
        db.once('roles', { data: { name: 'Admin', is_system: true } });
        await expect(updateRole({ id: 4, name: 'Root' })).rejects.toThrow('System roles cannot be renamed.');
        db.once('roles', { data: { name: 'Admin', is_system: true } });
        await updateRole({ id: 4, name: '  Admin  ', description: 'Top' });
        const upd = db.q('roles').find((q) => has(q, 'update'))!;
        expect(arg0(upd, 'update')).toEqual({ name: 'Admin', description: 'Top' });
        expect(has(upd, 'eq', 'id', 4)).toBe(true);
        expect(arg0(db.q('roles')[0], 'select')).toBe('name, is_system');
    });

    it('updateRole: a custom role cannot be renamed onto a reserved name; write faults surface', async () => {
        db.on('roles', { data: { name: 'Pilots', is_system: false } }, (q) => has(q, 'single'));
        await expect(updateRole({ id: 9, name: 'member' })).rejects.toThrow('That role name is reserved for a system role.');
        await updateRole({ id: 9, name: 'Aces' });
        expect(arg0(db.q('roles').find((q) => has(q, 'update'))!, 'update')).toEqual({ name: 'Aces', description: null });
        db.on('roles', { error: { message: 'x' } }, (q) => has(q, 'update'));
        await expect(updateRole({ id: 9, name: 'Aces' })).rejects.toThrow('Failed to update role');
    });

    it('deleteRole refuses a missing or system role; a custom role is deleted by id', async () => {
        db.once('roles', { data: null });
        await expect(deleteRole(1)).rejects.toThrow('Role not found');
        db.once('roles', { data: { is_system: true } });
        await expect(deleteRole(4)).rejects.toThrow('Cannot delete a system role.');
        expect(db.q('roles').some((q) => has(q, 'delete'))).toBe(false);
        db.once('roles', { data: { is_system: false } });
        await deleteRole(9);
        const del = db.q('roles').find((q) => has(q, 'delete'))!;
        expect(has(del, 'eq', 'id', 9)).toBe(true);
    });
});

describe('locations & radio channels', () => {
    it('location writers send exact payloads and surface faults', async () => {
        await addLocation({ name: 'Lorville', type: 'City', parent_id: 2 } as never);
        await updateLocation({ id: 5, name: 'Area18', type: 'City', parent_id: 3 } as never);
        await deleteLocation(5);
        const [a, u, d] = db.q('locations');
        expect(arg0(a, 'insert')).toEqual({ name: 'Lorville', type: 'City', parent_id: 2 });
        expect(arg0(u, 'update')).toEqual({ name: 'Area18', type: 'City', parent_id: 3 });
        expect(has(u, 'eq', 'id', 5)).toBe(true);
        expect(has(d, 'eq', 'id', 5)).toBe(true);
        db.on('locations', { error: { message: 'x' } });
        await expect(addLocation({} as never)).rejects.toThrow('Failed to add location');
        await expect(updateLocation({ id: 1 } as never)).rejects.toThrow('Failed to update location');
        await expect(deleteLocation(1)).rejects.toThrow('Failed to delete location');
    });

    it('addRadioChannel requires an id and refuses the reserved squad/mission grammar', async () => {
        await expect(addRadioChannel({})).rejects.toThrow('Radio channel id is required.');
        await expect(addRadioChannel({ id: '  ' })).rejects.toThrow('Radio channel id is required.');
        await expect(addRadioChannel({ id: 'unit-3' })).rejects.toThrow("Radio channel ids starting with 'unit-' or 'req-' are reserved for squad and mission channels.");
        await expect(addRadioChannel({ id: 'req-9' })).rejects.toThrow(/reserved/);
        expect(db.q('radio_channels')).toHaveLength(0);
    });

    it('addRadioChannel inserts the trimmed id with a default sort order', async () => {
        await addRadioChannel({ id: ' command ', name: 'Command', color: '#f00', type: 'org' } as never);
        await addRadioChannel({ id: 'ops', name: 'Ops', sort_order: 4 } as never);
        expect(arg0(db.q('radio_channels')[0], 'insert')).toEqual({ id: 'command', name: 'Command', color: '#f00', type: 'org', sort_order: 0 });
        expect(arg0(db.q('radio_channels')[1], 'insert')).toEqual(expect.objectContaining({ id: 'ops', sort_order: 4 }));
    });

    it('updateRadioChannel only sends sort_order when given; deleteRadioChannel by id', async () => {
        await updateRadioChannel('ops', 'Ops', '#0f0');
        await updateRadioChannel('ops', 'Ops', '#0f0', 2);
        await deleteRadioChannel('ops');
        const [u1, u2, d] = db.q('radio_channels');
        expect(arg0(u1, 'update')).toEqual({ name: 'Ops', color: '#0f0' });
        expect(arg0(u2, 'update')).toEqual({ name: 'Ops', color: '#0f0', sort_order: 2 });
        expect(has(u2, 'eq', 'id', 'ops')).toBe(true);
        expect(has(d, 'delete')).toBe(true);
        expect(has(d, 'eq', 'id', 'ops')).toBe(true);
    });

    it('radio channel writers surface faults', async () => {
        db.on('radio_channels', { error: { message: 'x' } });
        await expect(addRadioChannel({ id: 'a' })).rejects.toThrow('Failed to add radio channel');
        await expect(updateRadioChannel('a', 'b', 'c')).rejects.toThrow('Failed to update radio channel');
        await expect(deleteRadioChannel('a')).rejects.toThrow('Failed to delete radio channel');
    });
});
