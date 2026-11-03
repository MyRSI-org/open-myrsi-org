import { describe, it, expect, vi, beforeEach, afterEach, afterAll, type Mock } from 'vitest';

// =============================================================================
// actions-core handlers behind the REAL dispatcher (api/services.ts).
//
// The handler suites (tests/cov3-actions-core-*.test.ts) pin what each handler
// does with the payload it receives. This file pins the other half: that the
// payload a REAL handler receives is the one the dispatcher built — actor ids
// forced to the session user, the injected `user` record replacing anything the
// client sent under that name, target-identity fields left alone — so the
// in-handler gates (genuine-Admin by identity, position-history HR gate, EAM
// gate) decide on SERVER facts, never on client-asserted ones.
//
// Real: the dispatcher, the action handlers, lib/auth session tokens, the rate
// limiters, SecurityDenial routing. Doubled: the db barrel, LiveKit eviction,
// notification inserts, the logger.
// =============================================================================

const h = vi.hoisted(() => {
    const prevSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'cov3-actions-core-dispatch-secret-0a1b2c3d4e5f60718293a4b5c6d7e8f9';
    const logStub: Record<string, unknown> = {};
    for (const level of ['debug', 'info', 'warn', 'error']) logStub[level] = () => undefined;
    logStub.child = () => logStub;
    return {
        prevSecret,
        logStub,
        users: {} as Record<number, Record<string, unknown>>,
        db: {
            getPlatformSettings: vi.fn(),
            getUserById: vi.fn(),
            findActiveBan: vi.fn(),
            resolveIsSystemAdminFresh: vi.fn(),
            recordSecurityEvent: vi.fn(),
            isClientCaller: vi.fn(),
            isOptionalFeatureEnabled: vi.fn(),
            markNotificationsRead: vi.fn(),
            loadBanTarget: vi.fn(),
            getBanPermissionHolderIds: vi.fn(),
            filterActivelyBanned: vi.fn(),
            createBan: vi.fn(),
            dropPushSubscriptions: vi.fn(),
            getBanNotice: vi.fn(),
            createBanAppeal: vi.fn(),
            updatePlatformSettings: vi.fn(),
            getUserPositionHistory: vi.fn(),
            updateDiscordSettings: vi.fn(),
            deleteApiKey: vi.fn(),
            getActiveEam: vi.fn(),
            fullResetOrg: vi.fn(),
        } as Record<string, Mock<(...args: any[]) => any>>,
        evictUserFromAllRooms: vi.fn(),
        createNotification: vi.fn(),
    };
});

vi.mock('../lib/log', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../lib/log')>();
    return { ...orig, log: h.logStub };
});
vi.mock('../lib/db', () => ({
    supabase: { from: () => { throw new Error('no direct table access expected on these paths'); } },
    ...h.db,
}));
vi.mock('../lib/radio', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/radio')>()),
    evictUserFromAllRooms: h.evictUserFromAllRooms,
}));
vi.mock('../lib/db/notifications', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/db/notifications')>()),
    createNotification: h.createNotification,
}));

import handler from '../api/services';
import { signToken } from '../lib/auth';
import { __resetUserRateLimitForTest } from '../lib/userRateLimit';

type Res = { statusCode: number; body: any; status: (c: number) => Res; json: (b: unknown) => Res; setHeader: (k: string, v: string) => Res; append: (k: string, v: string) => Res };
function mockRes(): Res {
    const res = { statusCode: 0, body: undefined } as Res;
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = () => res;
    res.append = () => res;
    return res;
}
async function call(action: string, payload: Record<string, unknown>, user: Record<string, unknown> & { id: number }) {
    h.users[user.id] = user;
    const req = {
        method: 'POST', secure: false, ip: '203.0.113.9', query: {},
        headers: { authorization: `Bearer ${signToken({ userId: user.id })}` },
        body: { action, payload },
    };
    const res = mockRes();
    await handler(req as never, res as unknown as import('express').Response);
    return res;
}

const member = (id: number, permissions: string[] = [], extra: Record<string, unknown> = {}) =>
    ({ id, discordId: `d-${id}`, rsiHandle: `Handle${id}`, role: 'Member', roleId: 3, isSystemAdmin: false, permissions, tokensValidFrom: null, ...extra });

beforeEach(() => {
    h.users = {};
    for (const fn of Object.values(h.db)) fn.mockReset();
    h.evictUserFromAllRooms.mockReset().mockResolvedValue(0);
    h.createNotification.mockReset().mockResolvedValue({ id: 1 });
    h.db.getPlatformSettings.mockResolvedValue({});
    h.db.getUserById.mockImplementation(async (id: number) => h.users[id] ?? null);
    h.db.findActiveBan.mockResolvedValue(null);
    h.db.resolveIsSystemAdminFresh.mockResolvedValue(false);
    h.db.recordSecurityEvent.mockResolvedValue(undefined);
    h.db.isClientCaller.mockResolvedValue(false);
    h.db.isOptionalFeatureEnabled.mockResolvedValue(true);
    __resetUserRateLimitForTest();
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => {
    if (h.prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = h.prevSecret;
});

// ---------------------------------------------------------------------------
describe('actor ids are the SESSION user, whatever the client sent', () => {
    it('notifications:mark_read marks the caller\'s inbox even when the payload names another user', async () => {
        h.db.markNotificationsRead.mockResolvedValue(1);
        const res = await call('notifications:mark_read', { userId: 999, notificationIds: [5] }, member(42));
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, data: { success: true, updated: 1 } });
        expect(h.db.markNotificationsRead).toHaveBeenCalledWith(42, [5]);
    });

    it('api:delete_key attributes the revoke to the session user, not a client-supplied user record', async () => {
        const res = await call('api:delete_key', { keyId: 'k1', user: { id: 1 } }, member(42, ['admin:config:api']));
        expect(res.statusCode).toBe(200);
        expect(h.db.deleteApiKey).toHaveBeenCalledWith('k1', 42, 'operator');
    });

    it('admin:db:full_reset restores exactly the acting Admin, never a payload userId', async () => {
        const admin = member(1, ['admin:db:destroy'], { role: 'Admin', roleId: 4, isSystemAdmin: true });
        const res = await call('admin:db:full_reset', { userId: 999, confirmPhrase: 'RESET' }, admin);
        expect(res.statusCode).toBe(200);
        expect(h.db.fullResetOrg).toHaveBeenCalledWith(1);
    });
});

// ---------------------------------------------------------------------------
describe('ban:place — actor forced, target kept, denials routed opaquely', () => {
    const banAdmin = () => member(42, ['admin:user:ban']);

    beforeEach(() => {
        h.db.getBanPermissionHolderIds.mockResolvedValue([1, 42]);
        h.db.filterActivelyBanned.mockResolvedValue(new Set());
        h.db.createBan.mockResolvedValue({ id: 501, userId: 7, expiresAt: null });
    });

    it('bans the TARGET (targetUserId untouched) as the SESSION actor (spoofed userId overwritten)', async () => {
        h.db.loadBanTarget.mockResolvedValue({ id: 7, discordId: 'd-7' });
        const res = await call('ban:place', { targetUserId: 7, userId: 1, reason: 'conduct' }, banAdmin());
        expect(res.statusCode).toBe(200);
        expect(h.db.loadBanTarget).toHaveBeenCalledWith(7);
        expect(h.db.createBan).toHaveBeenCalledWith({ userId: 7, discordId: 'd-7', reason: 'conduct', expiresAt: undefined }, 42);
        expect(h.db.recordSecurityEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'authz.org_ban.placed', actorUserId: 42 }));
    });

    it('a spoofed userId cannot dodge the self-ban guard: 403 with the opaque message, detail only in the audit row', async () => {
        h.db.loadBanTarget.mockResolvedValue({ id: 42, discordId: 'd-42' });
        const res = await call('ban:place', { targetUserId: 42, userId: 1, reason: 'x' }, banAdmin());
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ success: false, message: 'That member cannot be banned.' });
        expect(h.db.createBan).not.toHaveBeenCalled();
        expect(h.db.recordSecurityEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: 'authz.org_ban.self_denied', action: 'ban:place', actorUserId: 42, details: { targetUserId: 42 },
        }));
    });

    it('is refused at the permission gate for a caller without admin:user:ban (handler never runs)', async () => {
        const res = await call('ban:place', { targetUserId: 7 }, member(43, ['user:view:roster']));
        expect(res.statusCode).toBe(403);
        expect(h.db.loadBanTarget).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('ban:submit_appeal — reachable while banned, writes onto the caller\'s OWN ban', () => {
    it('ignores a payload banId and uses the session user\'s notice', async () => {
        h.db.findActiveBan.mockResolvedValue({ id: 501 });
        h.db.getBanNotice.mockResolvedValue({ banId: 501, canAppeal: true });
        h.db.createBanAppeal.mockResolvedValue({ id: 900, banId: 501 });
        h.db.getBanPermissionHolderIds.mockResolvedValue([]);
        const res = await call('ban:submit_appeal', { banId: 12345, userId: 1, statement: 'please' }, member(42));
        expect(res.statusCode).toBe(200);
        expect(h.db.getBanNotice).toHaveBeenCalledWith(42, 'd-42');
        expect(h.db.createBanAppeal).toHaveBeenCalledWith(501, 'please');
    });
});

// ---------------------------------------------------------------------------
describe('in-handler gates decide on the INJECTED user record, never a client-sent one', () => {
    it('admin:update_platform_settings: a perm-holding non-Admin sending user.isSystemAdmin=true is still refused', async () => {
        const dispatcher = member(50, ['admin:db:destroy'], { role: 'Dispatcher', roleId: 2 });
        const res = await call('admin:update_platform_settings', { maintenanceMode: true, user: { id: 50, isSystemAdmin: true, roleId: 4 } }, dispatcher);
        expect(res.statusCode).toBe(500);
        expect(res.body).toMatchObject({ success: false, message: 'Only an Admin may perform this action.' });
        // The cache-free re-check ran on the SESSION user's role id, not the forged 4.
        expect(h.db.resolveIsSystemAdminFresh).toHaveBeenCalledWith(2);
        expect(h.db.updatePlatformSettings).not.toHaveBeenCalled();
    });

    it('user:get_position_history: a member sending user.permissions=[hr:admin] cannot read another member', async () => {
        const res = await call('user:get_position_history', { targetUserId: 8, user: { permissions: ['hr:admin'] } }, member(42, ['hr:view']));
        expect(res.statusCode).toBe(500);
        expect(res.body).toMatchObject({ success: false, message: 'Not authorized to view this user’s position history.' });
        expect(h.db.getUserPositionHistory).not.toHaveBeenCalled();
    });

    it('user:get_position_history: a real HR manager can, and self-fetch resolves to the session user', async () => {
        h.db.getUserPositionHistory.mockResolvedValue([]);
        expect((await call('user:get_position_history', { targetUserId: 8 }, member(60, ['hr:manager']))).statusCode).toBe(200);
        expect(h.db.getUserPositionHistory).toHaveBeenLastCalledWith(8);
        expect((await call('user:get_position_history', { userId: 8 }, member(61))).statusCode).toBe(200);
        expect(h.db.getUserPositionHistory).toHaveBeenLastCalledWith(61);
    });

    it('broadcast:get_active_eam: a Client-tier caller sending user.permissions=[user:receive:eam] is refused', async () => {
        const res = await call('broadcast:get_active_eam', { user: { permissions: ['user:receive:eam'] } }, member(70, ['request:create'], { role: 'Client', roleId: 1 }));
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('Forbidden: EAM access requires a staff capability or user:receive:eam.');
        expect(h.db.getActiveEam).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('config writes through the dispatcher', () => {
    it('admin:update_discord_config stores only the config keys and returns no settings data', async () => {
        h.db.updateDiscordSettings.mockResolvedValue({ clientSecret: 'STORED-SECRET' });
        const admin = member(1, ['admin:config:discord'], { role: 'Admin', roleId: 4, isSystemAdmin: true });
        const res = await call('admin:update_discord_config', { clientId: 'cid', clientSecret: 'new', userId: 9, adminId: 9, user: { id: 9 } }, admin);
        expect(res.statusCode).toBe(200);
        expect(h.db.updateDiscordSettings).toHaveBeenCalledWith({ clientId: 'cid', clientSecret: 'new' });
        expect(res.body).toEqual({ success: true, data: undefined });
        expect(JSON.stringify(res.body)).not.toContain('STORED-SECRET');
    });
});
