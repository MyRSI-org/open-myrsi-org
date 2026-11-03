import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/db/system.ts — maintenance & broadcast paths: repairDatabase (every recovery leg and
// the operator-facing outcome string), the EAM fan-out (push audience mirrors the read gate;
// the realtime emit carries no body; Discord ping resolution), the system broadcast, prune
// (fail-closed retention window), per-feature resets, and full reset / full wipe.

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

import { db, mocks, logSpy, resetHarness, has, arg0, args, type Q } from './cov-db-system-harness';
import {
    repairDatabase, broadcastEAM, getActiveEam, broadcastSystemAlert, pruneDatabaseData,
    resetFinancesData, resetQuartermasterData, fullResetOrg, fullWipeOrg,
} from '../lib/db/system';

beforeEach(() => resetHarness());

const isCount = (q: Q) => (args(q, 'select')[0]?.[1] as { count?: string } | undefined)?.count === 'exact';
const sel = (q: Q) => arg0(q, 'select');

// ─────────────────────────────────────────────────────────────────────────────
describe('repairDatabase', () => {
    /** A healthy org: 4 roles, a fully-permissioned admin, nothing to fix. */
    function healthyOrg(existingPermNames: string[] = []) {
        db.on('permissions', { data: existingPermNames.map((name) => ({ name })) }, (q) => sel(q) === 'name');
        db.on('permissions', { data: [{ id: 1 }, { id: 2 }] }, (q) => sel(q) === 'id');
        db.on('roles', { count: 4 }, isCount);
        db.on('roles', { data: [] }, (q) => has(q, 'in'));
        db.on('role_permissions', { count: 80 }, isCount);
        db.on('role_permissions', { data: [{ permission_id: 1 }, { permission_id: 2 }] }, (q) => sel(q) === 'permission_id');
        db.on('users', { count: 1 }, isCount);
    }
    const insertedPerms = () => {
        const q = db.q('permissions').find((x) => has(x, 'insert'));
        return q ? (arg0(q, 'insert') as Array<{ name: string; description: string; category: string }>) : [];
    };

    it('a healthy org reports plain completion and touches nothing structural', async () => {
        healthyOrg();
        const all = insertedPerms; // first run discovers the catalog
        expect(await repairDatabase()).toEqual({ success: true, message: 'Database repair complete.' });
        const catalog = all();
        expect(catalog.length).toBeGreaterThan(100);
        expect(catalog.every((p) => p.name && p.description && p.category)).toBe(true);
        expect(catalog.map((p) => p.name)).toEqual(expect.arrayContaining(['admin:access', 'admin:db:destroy', 'blueprint:manage']));

        // Second run with the full catalog present: no insert, every description re-synced.
        resetHarness();
        healthyOrg(catalog.map((p) => p.name));
        await repairDatabase();
        expect(insertedPerms()).toEqual([]);
        expect(logSpy.info).toHaveBeenCalledWith('repair all global permissions present');
        const updates = db.q('permissions').filter((q) => has(q, 'update'));
        expect(updates).toHaveLength(catalog.length);
        const access = updates.find((q) => has(q, 'eq', 'name', 'admin:access'))!;
        expect(arg0(access, 'update')).toEqual({ description: 'Access the Admin Dashboard', category: 'System' });
        expect(mocks.seedNewOrganization).not.toHaveBeenCalled();
        expect(db.q('role_permissions').some((q) => has(q, 'upsert'))).toBe(false);
        expect(db.q('users').some((q) => has(q, 'update') && has(q, 'eq', 'id'))).toBe(false);
    });

    it('inserts only the MISSING permissions and logs (not throws) an insert fault', async () => {
        healthyOrg(['admin:access', 'wiki:view']);
        db.on('permissions', { error: { message: 'x' } }, (q) => has(q, 'insert'));
        const out = await repairDatabase();
        expect(out.success).toBe(true);
        const names = insertedPerms().map((p) => p.name);
        expect(names).not.toContain('admin:access');
        expect(names).not.toContain('wiki:view');
        expect(names).toContain('marketplace:admin');
        expect(db.q('permissions').filter((q) => has(q, 'update'))).toHaveLength(2);
        expect(logSpy.error).toHaveBeenCalledWith('failed to add missing permissions', expect.objectContaining({ err: { message: 'x' } }));
    });

    it('re-grants the admin role every permission it lacks (upsert, duplicates ignored)', async () => {
        healthyOrg();
        db.on('permissions', { data: [{ id: 1 }, { id: 2 }, { id: 3 }] }, (q) => sel(q) === 'id');
        db.on('role_permissions', { data: [{ permission_id: 1 }] }, (q) => sel(q) === 'permission_id');
        await repairDatabase();
        const up = db.q('role_permissions').find((q) => has(q, 'upsert'))!;
        expect(up.ops[0]).toEqual(['upsert', [[{ role_id: 4, permission_id: 2 }, { role_id: 4, permission_id: 3 }], { ignoreDuplicates: true }]]);
        const read = db.q('role_permissions').find((q) => sel(q) === 'permission_id')!;
        expect(has(read, 'eq', 'role_id', 4)).toBe(true);
    });

    it('an admin-permission sync fault is logged, and repair still completes', async () => {
        healthyOrg();
        db.on('permissions', { data: [{ id: 9 }] }, (q) => sel(q) === 'id');
        db.on('role_permissions', { data: null }, (q) => sel(q) === 'permission_id');
        db.on('role_permissions', { error: { message: 'rp' } }, (q) => has(q, 'upsert'));
        expect((await repairDatabase()).success).toBe(true);
        expect(logSpy.error).toHaveBeenCalledWith('repair failed to sync admin permissions', { err: { message: 'rp' } });
    });

    it('stamps is_system on the seeded role names and drops the role memo before re-resolving', async () => {
        healthyOrg();
        db.on('roles', { data: [{ id: 1, name: 'Client' }, { id: 4, name: 'Admin' }] }, (q) => has(q, 'in'));
        await repairDatabase();
        const byName = db.q('roles').find((q) => has(q, 'in'))!;
        expect(sel(byName)).toBe('id, name');
        expect(has(byName, 'in', 'name', ['Client', 'Member', 'Dispatcher', 'Admin'])).toBe(true);
        const stamp = db.q('roles').find((q) => has(q, 'update'))!;
        expect(arg0(stamp, 'update')).toEqual({ is_system: true });
        expect(has(stamp, 'in', 'id', [1, 4])).toBe(true);
        expect(db.q('roles').some((q) => has(q, 'eq', 'is_system', true))).toBe(true);
        expect(mocks.cacheInvalidate).toHaveBeenCalledWith('system_roles');
        // the invalidate precedes the final roles lookup
        const invalidateAt = mocks.cacheInvalidate.mock.invocationCallOrder[0];
        const lastRolesAt = mocks.getSystemRoles.mock.invocationCallOrder.at(-1)!;
        expect(invalidateAt).toBeLessThan(lastRolesAt);
    });

    it('re-seeds when roles are missing (or the count is unreadable), skipping the admin sync', async () => {
        healthyOrg();
        db.on('roles', { count: 2 }, isCount);
        await repairDatabase();
        expect(mocks.seedNewOrganization).toHaveBeenCalledTimes(1);
        expect(db.q('permissions').some((q) => sel(q) === 'id')).toBe(false);
        resetHarness();
        healthyOrg();
        db.on('roles', { count: null }, isCount);
        await repairDatabase();
        expect(mocks.seedNewOrganization).toHaveBeenCalledTimes(1);
    });

    it('re-seeds when the admin role is (nearly) unpermissioned', async () => {
        healthyOrg();
        db.on('role_permissions', { count: 3 }, isCount);
        await repairDatabase();
        expect(mocks.seedNewOrganization).toHaveBeenCalledTimes(1);
        const countQ = db.q('role_permissions').find(isCount)!;
        expect(has(countQ, 'eq', 'role_id', 4)).toBe(true);
    });

    it('a failed re-seed aborts with the reason (Error or not)', async () => {
        healthyOrg();
        db.on('roles', { count: 0 }, isCount);
        mocks.seedNewOrganization.mockRejectedValueOnce(new Error('seed exploded'));
        expect(await repairDatabase()).toEqual({ success: false, message: 'Re-seed failed: seed exploded' });
        mocks.seedNewOrganization.mockRejectedValueOnce('plain');
        expect(await repairDatabase()).toEqual({ success: false, message: 'Re-seed failed: plain' });
        expect(mocks.drainStaleOperationReminders).not.toHaveBeenCalled();
    });

    it('null catalog reads are treated as empty, and no Member role skips the null-role backfill', async () => {
        healthyOrg();
        db.on('permissions', { data: null }, (q) => sel(q) === 'name');
        db.on('permissions', { data: null }, (q) => sel(q) === 'id');
        mocks.getSystemRoles.mockResolvedValue({ admin: { id: 4 }, client: { id: 1 } });
        expect((await repairDatabase()).success).toBe(true);
        expect(insertedPerms().length).toBeGreaterThan(100);
        expect(db.q('role_permissions').some((q) => has(q, 'upsert'))).toBe(false);
        expect(db.q('users').some((q) => has(q, 'is', 'role_id', null))).toBe(false);
    });

    it('with no resolvable admin role the admin checks are skipped', async () => {
        healthyOrg();
        mocks.getSystemRoles.mockResolvedValue({ member: { id: 2 } });
        await repairDatabase();
        expect(db.q('role_permissions')).toHaveLength(0);
        expect(db.q('users').some(isCount)).toBe(false);
        expect(mocks.enforceClientRolePermissionLock).not.toHaveBeenCalled();
        // member exists ⇒ the null-role backfill still runs
        const backfill = db.q('users').find((q) => has(q, 'update'))!;
        expect(arg0(backfill, 'update')).toEqual({ role_id: 2 });
        expect(has(backfill, 'is', 'role_id', null)).toBe(true);
    });

    it('reports every recovery outcome in the operator-facing message', async () => {
        healthyOrg();
        mocks.enforceClientRolePermissionLock.mockResolvedValueOnce({ stripped: 3 });
        mocks.backfillOptionalModuleRoleDefaults.mockResolvedValueOnce({ status: 'granted', granted: 5 });
        mocks.drainStaleOperationReminders.mockResolvedValueOnce(4);
        mocks.liftBansOnSystemAdmins.mockResolvedValueOnce(2);
        db.on('users', { count: 0 }, isCount);
        db.on('users', { data: { id: 17 } }, (q) => has(q, 'maybeSingle'));
        const out = await repairDatabase();
        expect(out).toEqual({ success: true, message:
            'Database repair complete.'
            + ' Stripped 3 excess permission(s) from the Client role.'
            + ' Granted 5 default module permission(s) to the Member/Dispatcher roles.'
            + ' Retired 4 stale operation reminder(s).'
            + ' Lifted 2 ban(s) on Admin-role holders — an Admin cannot be banned.' });
        expect(mocks.enforceClientRolePermissionLock).toHaveBeenCalledWith(1);
        expect(mocks.backfillOptionalModuleRoleDefaults).toHaveBeenCalledWith(expect.objectContaining({ admin: { id: 4, name: 'Admin' } }));
        // no live admin ⇒ the earliest live user is promoted
        const earliest = db.q('users').find((q) => has(q, 'maybeSingle'))!;
        expect(sel(earliest)).toBe('id');
        expect(has(earliest, 'is', 'deleted_at', null)).toBe(true);
        expect(has(earliest, 'order', 'created_at', { ascending: true })).toBe(true);
        expect(has(earliest, 'limit', 1)).toBe(true);
        const promote = db.q('users').find((q) => has(q, 'update') && has(q, 'eq', 'id', 17))!;
        expect(arg0(promote, 'update')).toEqual({ role_id: 4 });
        const adminCount = db.q('users').find(isCount)!;
        expect(has(adminCount, 'eq', 'role_id', 4)).toBe(true);
        expect(has(adminCount, 'is', 'deleted_at', null)).toBe(true);
    });

    it.each([
        ['skipped-configured', ' Module role defaults were left alone — those roles are already configured.'],
        ['skipped-roles', ' Module role defaults were skipped — the Member/Dispatcher system roles could not be identified.'],
        ['failed', ' Module role defaults could not be applied — see the server log; Repair can be run again.'],
        ['already-applied', ''],
    ])('backfill outcome %s is reported verbatim', async (status, note) => {
        healthyOrg();
        mocks.backfillOptionalModuleRoleDefaults.mockResolvedValueOnce({ status, granted: 0 });
        expect((await repairDatabase()).message).toBe(`Database repair complete.${note}`);
    });

    it('contained failures still let the rest of repair run, and are reported', async () => {
        healthyOrg();
        mocks.enforceClientRolePermissionLock.mockRejectedValueOnce(new Error('unverifiable'));
        mocks.liftBansOnSystemAdmins.mockRejectedValueOnce(new Error('bans down'));
        db.on('users', { error: { message: 'u' } }, (q) => has(q, 'update'));
        db.on('users', { count: 0 }, isCount);
        db.on('users', { data: null }, (q) => has(q, 'maybeSingle'));
        const out = await repairDatabase();
        expect(out.message).toBe('Database repair complete.'
            + ' The Client role permission lock could not be verified — re-run Repair.'
            + ' Bans on Admin-role holders could not be checked — re-run Repair.');
        expect(logSpy.error).toHaveBeenCalledWith('repair failed for users', { err: { message: 'u' } });
        expect(mocks.drainStaleOperationReminders).toHaveBeenCalled();
        // no earliest user ⇒ nobody promoted
        expect(db.q('users').some((q) => has(q, 'update') && has(q, 'eq', 'id'))).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('broadcastEAM', () => {
    const discordRead = (q: Q) => has(q, 'in', 'key', ['discordConfig', 'brandingConfig']);
    const settings = (discordConfig: unknown, brandingConfig?: unknown) => db.on('settings', { data: [
        { key: 'discordConfig', value: discordConfig },
        ...(brandingConfig === undefined ? [] : [{ key: 'brandingConfig', value: brandingConfig }]),
    ] }, discordRead);

    it('persists, emits a body-less trigger, and pushes ONLY to staff + EAM receivers', async () => {
        await broadcastEAM('All hands to stations');
        const up = db.q('settings').find((q) => has(q, 'upsert'))!;
        const row = arg0(up, 'upsert') as { key: string; value: { message: string; timestamp: string } };
        expect(row.key).toBe('active_eam');
        expect(row.value.message).toBe('All hands to stations');
        expect(mocks.broadcastToChannel).toHaveBeenCalledWith('auth-alerts', 'eam_broadcast', { timestamp: row.value.timestamp });
        expect(JSON.stringify(mocks.broadcastToChannel.mock.calls)).not.toContain('All hands');
        const push = { title: '🚨 EMERGENCY ACTION MESSAGE 🚨', body: 'All hands to stations', tag: 'eam', data: { type: 'eam' }, requireInteraction: true, renotify: true };
        expect(mocks.sendPushToStaff).toHaveBeenCalledWith(push);
        expect(mocks.sendPushToPermission).toHaveBeenCalledWith('user:receive:eam', push);
        expect(mocks.sendPushToAll).not.toHaveBeenCalled();
        // no EAM channel configured ⇒ no Discord post
        const read = db.q('settings').find(discordRead)!;
        expect(sel(read)).toBe('key, value');
        expect(mocks.sendDiscordChannelMessage).not.toHaveBeenCalled();
    });

    it('posts the Discord embed with branding and the default @here + configured-role ping', async () => {
        settings({ eamChannelId: '123456789012345678', eamPingRoleId: '987654321098765432' }, { name: 'ACME', iconUrl: 'https://cdn.example.com/i.png' });
        await broadcastEAM('Code red');
        expect(mocks.buildMentionContent).toHaveBeenCalledWith({ here: true, roleId: '987654321098765432' });
        const [channelId, msg] = mocks.sendDiscordChannelMessage.mock.calls[0] as [string, { content: string; embeds: Array<Record<string, unknown>> }];
        expect(channelId).toBe('123456789012345678');
        expect(msg.content).toBe('mention:{"here":true,"roleId":"987654321098765432"}');
        const embed = msg.embeds[0];
        expect(embed.title).toBe('🚨 EMERGENCY ACTION MESSAGE');
        expect(embed.description).toBe('```\nCode red\n```');
        expect(embed.color).toBe(0xdc2626);
        expect(embed.footer).toEqual({ text: 'ACME Command Authority', icon_url: 'https://cdn.example.com/i.png' });
        expect((embed.fields as Array<{ name: string; value: string }>)[1].value).toMatch(/^<t:\d+:F>$/);
    });

    it.each([
        ['none', {}],
        ['here', { here: true }],
        ['role', { roleId: '987654321098765432' }],
        ['', { here: true, roleId: '987654321098765432' }],
    ])('ping target %j resolves to %j', async (pingTarget, expected) => {
        settings({ eamChannelId: '123456789012345678', eamPingRoleId: '987654321098765432' });
        await broadcastEAM('m', pingTarget as never);
        expect(mocks.buildMentionContent).toHaveBeenCalledWith(expected);
    });

    it('"role" with no configured role pings nobody; an unknown target drops the ping (logged) but still sends', async () => {
        settings({ eamChannelId: '123456789012345678' });
        await broadcastEAM('m', 'role');
        expect(mocks.buildMentionContent).toHaveBeenLastCalledWith({ roleId: null });
        await broadcastEAM('m');
        expect(mocks.buildMentionContent).toHaveBeenLastCalledWith({ here: true, roleId: null });
        await broadcastEAM('m', `@everyone${'x'.repeat(50)}` as never);
        expect(mocks.buildMentionContent).toHaveBeenLastCalledWith({});
        expect(logSpy.warn).toHaveBeenCalledWith('unknown EAM ping target — sending without a ping', { pingTarget: `@everyone${'x'.repeat(23)}` });
        expect(mocks.sendDiscordChannelMessage).toHaveBeenCalledTimes(3);
    });

    it('truncates a long message, and falls back to a generic footer without an off-origin icon', async () => {
        settings({ eamChannelId: '123456789012345678' }, { name: '', iconUrl: '/media/local.png' });
        await broadcastEAM('y'.repeat(4500));
        const embed = (mocks.sendDiscordChannelMessage.mock.calls[0][1] as { embeds: Array<Record<string, unknown>> }).embeds[0];
        expect(embed.description).toBe('```\n' + 'y'.repeat(3997) + '...\n```');
        expect(embed.footer).toEqual({ text: 'Organization Command Authority' });
        resetHarness();
        settings({ eamChannelId: '123456789012345678' });
        await broadcastEAM('short');
        const e2 = (mocks.sendDiscordChannelMessage.mock.calls[0][1] as { embeds: Array<Record<string, unknown>> }).embeds[0];
        expect(e2.footer).toEqual({ text: 'Organization Command Authority' });
    });

    it('a Discord failure is swallowed and logged; in-app + push still go out', async () => {
        settings({ eamChannelId: '123456789012345678' });
        mocks.sendDiscordChannelMessage.mockRejectedValueOnce(new Error('discord 500'));
        await expect(broadcastEAM('m')).resolves.toBeUndefined();
        expect(logSpy.error).toHaveBeenCalledWith('discord eam broadcast notification failed', expect.objectContaining({ err: expect.any(Error) }));
        expect(mocks.sendPushToStaff).toHaveBeenCalled();
    });

    it('a null settings read is treated as "no channel"', async () => {
        db.on('settings', { data: null }, discordRead);
        await broadcastEAM('m');
        expect(mocks.sendDiscordChannelMessage).not.toHaveBeenCalled();
    });
});

describe('getActiveEam', () => {
    it('returns the persisted EAM only when it carries a non-empty string message', async () => {
        db.once('settings', { data: { value: { message: 'Hold', timestamp: 't1' } } });
        expect(await getActiveEam()).toEqual({ message: 'Hold', timestamp: 't1' });
        const [q] = db.q('settings');
        expect(sel(q)).toBe('value');
        expect(has(q, 'eq', 'key', 'active_eam')).toBe(true);
        db.once('settings', { data: { value: { message: 'Hold', timestamp: 5 } } });
        expect(await getActiveEam()).toEqual({ message: 'Hold', timestamp: '' });
        db.once('settings', { data: { value: { message: '' } } });
        expect(await getActiveEam()).toBeNull();
        db.once('settings', { data: { value: { message: { html: 'x' } } } });
        expect(await getActiveEam()).toBeNull();
        expect(await getActiveEam()).toBeNull();
    });
});

describe('broadcastSystemAlert', () => {
    it('persists, emits on the private auth-alerts channel and pushes to all', async () => {
        await broadcastSystemAlert('Maintenance at 0200');
        const row = arg0(db.q('settings')[0], 'upsert') as { key: string; value: { message: string; id: string } };
        expect(row.key).toBe('system_broadcast');
        expect(row.value.message).toBe('Maintenance at 0200');
        expect(row.value.id).toMatch(/^\d+$/);
        expect(mocks.broadcastToChannel).toHaveBeenCalledWith('auth-alerts', 'system_broadcast', { message: 'Maintenance at 0200' });
        expect(mocks.sendPushToAll).toHaveBeenCalledWith({ title: 'System Broadcast', body: 'Maintenance at 0200', tag: 'broadcast' });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pruneDatabaseData — never a full wipe', () => {
    it.each([0, -1, 1.5, Number.NaN])('refuses retentionDays=%s before issuing any DELETE', async (days) => {
        await expect(pruneDatabaseData(days, ['requests'])).rejects.toThrow('retentionDays must be a positive integer (>= 1).');
        expect(db.queries).toHaveLength(0);
    });

    it('deletes only rows older than the cutoff, with the per-table status guards', async () => {
        db.on('service_requests', { count: 3 });
        db.on('warrants', { count: 2 });
        db.on('intel_reports', { count: 0 });
        db.on('operations', { count: 5 });
        db.on('hr_applications', { count: 1 });
        const before = Date.now();
        const out = await pruneDatabaseData(30, ['requests', 'warrants', 'intel', 'operations', 'hr']);
        expect(out).toEqual({ requests: 3, warrants: 2, intel: 0, operations: 5, hr: 1 });
        const cutoff = Date.parse(String(args(db.q('service_requests')[0], 'lt')[0][1]));
        expect(Math.abs(cutoff - (before - 30 * 86400_000))).toBeLessThan(3 * 3600_000 + 5000); // DST-tolerant
        for (const t of ['service_requests', 'warrants', 'intel_reports', 'operations', 'hr_applications']) {
            const [q] = db.q(t);
            expect(q.ops[0]).toEqual(['delete', [{ count: 'exact' }]]);
        }
        expect(has(db.q('service_requests')[0], 'lt', 'created_at')).toBe(true);
        expect(has(db.q('warrants')[0], 'lt', 'updated_at')).toBe(true);
        expect(has(db.q('warrants')[0], 'in', 'status', ['Claimed', 'Cancelled'])).toBe(true);
        expect(has(db.q('operations')[0], 'eq', 'status', 'Concluded')).toBe(true);
        expect(has(db.q('hr_applications')[0], 'in', 'status', ['Rejected', 'Withdrawn'])).toBe(true);
    });

    it('only the named targets are touched, and a failed delete is omitted from the result', async () => {
        db.on('intel_reports', { error: { message: 'x' } });
        db.on('warrants', { error: { message: 'x' } });
        db.on('operations', { error: { message: 'x' } });
        db.on('hr_applications', { error: { message: 'x' } });
        db.on('service_requests', { error: { message: 'x' } });
        expect(await pruneDatabaseData(7, ['intel', 'warrants', 'operations', 'hr', 'requests'])).toEqual({});
        resetHarness();
        expect(await pruneDatabaseData(7, ['hr'])).toEqual({ hr: null });
        expect(db.queries.map((q) => q.table)).toEqual(['hr_applications']);
    });
});

describe('per-feature resets', () => {
    it('a single target touches exactly one table', async () => {
        db.on('service_requests', { count: 9 });
        expect(await pruneDatabaseData(90, ['requests'])).toEqual({ requests: 9 });
        expect(db.queries.map((q) => q.table)).toEqual(['service_requests']);
    });

    it('resetFinancesData deletes ledger entries BEFORE accounts and nudges with {}', async () => {
        db.on('treasury_ledger_entries', { count: 12 });
        const out = await resetFinancesData();
        expect(out).toEqual({ ledger_entries: 12, accounts: 0 });
        expect(db.queries.map((q) => q.table)).toEqual(['treasury_ledger_entries', 'treasury_accounts']);
        expect(db.queries.every((q) => q.ops.length === 1 && q.ops[0][0] === 'delete')).toBe(true);
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('finance:reset', {});
    });

    it('resetFinancesData reports 0 for an unreadable count', async () => {
        db.on('treasury_accounts', { count: 2 });
        expect(await resetFinancesData()).toEqual({ ledger_entries: 0, accounts: 2 });
    });

    it('resetQuartermasterData deletes in dependency order and keeps platform catalog rows', async () => {
        db.on('quartermaster_issuances', { count: 1 });
        db.on('quartermaster_inventory_movements', { count: 2 });
        db.on('quartermaster_inventory', { count: 3 });
        db.on('quartermaster_locations', { count: 4 });
        db.on('quartermaster_catalog', { count: 5 });
        expect(await resetQuartermasterData()).toEqual({ issuances: 1, movements: 2, inventory: 3, locations: 4, catalog: 5 });
        expect(db.queries.map((q) => q.table)).toEqual([
            'quartermaster_issuances', 'quartermaster_inventory_movements', 'quartermaster_inventory',
            'quartermaster_locations', 'quartermaster_catalog',
        ]);
        expect(has(db.q('quartermaster_catalog')[0], 'eq', 'source', 'custom')).toBe(true);
        expect(mocks.broadcastToOrg).toHaveBeenCalledWith('qm:reset', {});
        resetHarness();
        expect(await resetQuartermasterData()).toEqual({ issuances: 0, movements: 0, inventory: 0, locations: 0, catalog: 0 });
    });
});

describe('full reset / full wipe', () => {
    const admin = { id: 42, auth_user_id: 'auth-1', discord_id: 'd-1', name: 'Boss', rsi_handle: 'BOSS', avatar_url: 'https://cdn/a.png' };

    it('aborts BEFORE wiping when the acting admin cannot be captured', async () => {
        db.once('users', { error: { message: 'x' } });
        await expect(fullResetOrg(42)).rejects.toThrow('Could not identify the acting admin — reset aborted, no data was changed.');
        db.once('users', { data: null });
        await expect(fullResetOrg(42)).rejects.toThrow(/reset aborted/);
        expect(db.rpcCalls).toHaveLength(0);
    });

    it('a wipe failure is reported and nothing is re-seeded', async () => {
        db.on('users', { data: admin }, (q) => has(q, 'single'));
        db.rpcResults.push({ error: { message: 'permission denied' } });
        await expect(fullResetOrg(42)).rejects.toThrow('Reset failed during wipe: permission denied');
        expect(mocks.seedNewOrganization).not.toHaveBeenCalled();
    });

    it('restores the admin under its ORIGINAL id on the fresh Admin role and closes onboarding', async () => {
        db.on('users', { data: admin }, (q) => has(q, 'single'));
        db.on('roles', { data: { id: 99 } });
        const out = await fullResetOrg(42);
        const cap = db.q('users')[0];
        expect(sel(cap)).toBe('id, auth_user_id, discord_id, name, rsi_handle, avatar_url');
        expect(has(cap, 'eq', 'id', 42)).toBe(true);
        expect(db.rpcCalls).toEqual([{ fn: 'admin_truncate_all_data', args: {} }]);
        expect(mocks.cacheInvalidate).toHaveBeenCalledTimes(2);
        expect(mocks.seedNewOrganization).toHaveBeenCalledTimes(1);
        const roleQ = db.q('roles')[0];
        expect(sel(roleQ)).toBe('id');
        expect(has(roleQ, 'eq', 'name', 'Admin')).toBe(true);
        expect(arg0(db.q('users').find((q) => has(q, 'insert'))!, 'insert')).toEqual({ ...admin, role_id: 99, rsi_verified: true });
        expect(db.q('settings')[0].ops[0]).toEqual(['upsert', [{ key: 'setup_completed', value: true }, { onConflict: 'key' }]]);
        expect(out).toEqual({ ok: true, message: 'Organization reset to a fresh install. You are still signed in as Admin — reload the app to see the clean slate.' });
    });

    it('no Admin role after re-seed, or a failed restore, is reported with the recovery path', async () => {
        db.on('users', { data: admin }, (q) => has(q, 'single'));
        await expect(fullResetOrg(42)).rejects.toThrow('Reset re-seeded defaults but no Admin role was found — restart the server to mint a fresh claim code.');
        db.on('roles', { data: { id: 99 } });
        db.on('users', { error: { message: 'duplicate key' } }, (q) => has(q, 'insert'));
        await expect(fullResetOrg(42)).rejects.toThrow('Reset re-seeded defaults but could not restore your admin account: duplicate key. Restart the server to mint a fresh claim code.');
        expect(db.q('settings')).toHaveLength(0);
    });

    it('fullWipeOrg truncates without re-seeding and invalidates the role memo', async () => {
        expect(await fullWipeOrg()).toEqual({ ok: true, message: 'All data wiped. Restart or redeploy the server now to generate a new admin claim code.' });
        expect(db.rpcCalls).toEqual([{ fn: 'admin_truncate_all_data', args: {} }]);
        expect(mocks.cacheInvalidate).toHaveBeenCalledWith('system_roles');
        expect(mocks.seedNewOrganization).not.toHaveBeenCalled();
        db.rpcResults.push({ error: { message: 'nope' } });
        await expect(fullWipeOrg()).rejects.toThrow('Wipe failed: nope');
    });
});
