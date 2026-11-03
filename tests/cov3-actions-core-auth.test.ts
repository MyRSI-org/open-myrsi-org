import { describe, it, expect, vi, beforeEach, afterAll, type Mock } from 'vitest';

// =============================================================================
// api/actions/auth.ts — handler-level behaviour suite (coverage phase 3,
// unit actions-core). SECURITY-RELEVANT: the OAuth callback, first-admin setup
// code redemption (validateClaimCode), account finalisation, org:claim and the
// radio token proxies.
//
// The REAL lib/auth signer runs (a fixed, test-only JWT_SECRET is installed in
// vi.hoisted before the module loads and restored in afterAll), so every token
// and grant a handler returns is verified for what it actually binds — not just
// "a string came back". The REAL stripSensitiveUserFields and the REAL
// isValidRsiHandle / generateRsiVerificationCode run too. Doubled: the db
// barrel (incl. a recording supabase builder), Discord, LiveKit radio,
// adminExists, the outbound RSI bio check and the logger.
// =============================================================================

const h = vi.hoisted(() => {
    const prevSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'cov3-actions-core-auth-secret-9f8e7d6c5b4a39281706f5e4d3c2b1a0';
    type LogCall = { level: string; msg: string; fields?: Record<string, unknown> };
    const logs: LogCall[] = [];
    const logStub: Record<string, unknown> = {};
    for (const level of ['debug', 'info', 'warn', 'error']) {
        logStub[level] = (msg: string, fields?: Record<string, unknown>) => { logs.push({ level, msg, fields }); };
    }
    logStub.child = () => logStub;
    type SbCall = { table: string; ops: unknown[][] };
    return {
        prevSecret,
        logs,
        logStub,
        sbCalls: [] as SbCall[],
        respond: ((_rec: SbCall) => ({ data: null, error: null })) as (rec: SbCall) => { data: unknown; error: unknown },
        db: {
            findActiveBan: vi.fn(),
            findUserByDiscordId: vi.fn(),
            getBanNotice: vi.fn(),
            recordSecurityEvent: vi.fn(),
            reactivateUser: vi.fn(),
            refreshUserAvatar: vi.fn(),
            createUser: vi.fn(),
            getSystemRoles: vi.fn(),
        } as Record<string, Mock<(...args: any[]) => any>>,
        discord: {
            exchangeCodeForToken: vi.fn(),
            getDiscordUser: vi.fn(),
            buildGlobalAvatarUrl: vi.fn(),
        } as Record<string, Mock<(...args: any[]) => any>>,
        radio: {
            assertRadioRateLimit: vi.fn(),
            generateRadioToken: vi.fn(),
            generateOpRadioToken: vi.fn(),
            getRadioStatus: vi.fn(),
            rebootRadioNetwork: vi.fn(),
        } as Record<string, Mock<(...args: any[]) => any>>,
        adminExists: vi.fn(),
        verifyRsiHandle: vi.fn(),
        // What the audit emitter RETURNS. A plain function, not the vi.fn: a vi.fn attaches
        // its own .then to a returned promise (mock.settledResults), which would mark a
        // rejection handled and hide a missing .catch in the handler.
        auditResult: (() => Promise.resolve()) as () => unknown,
    };
});

function sbFrom(table: string) {
    const rec = { table, ops: [] as unknown[][] };
    h.sbCalls.push(rec);
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'or', 'update', 'delete']) {
        b[m] = (...args: unknown[]) => { rec.ops.push([m, ...args]); return b; };
    }
    for (const m of ['single', 'maybeSingle']) {
        b[m] = async () => { rec.ops.push([m]); return h.respond(rec); };
    }
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve().then(() => h.respond(rec)).then(resolve, reject);
    return b;
}

vi.mock('../lib/log', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../lib/log')>();
    return { ...orig, log: h.logStub };
});
vi.mock('../lib/db', () => ({
    supabase: { from: (t: string) => sbFrom(t) },
    ...h.db,
    recordSecurityEvent: (event: unknown) => { h.db.recordSecurityEvent(event); return h.auditResult(); },
}));
vi.mock('../lib/discord', () => ({ ...h.discord }));
vi.mock('../lib/radio', () => ({ ...h.radio }));
vi.mock('../lib/firstBoot', () => ({ adminExists: h.adminExists }));
vi.mock('../lib/rsi', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/rsi')>()),
    verifyRsiHandle: h.verifyRsiHandle,
}));

import { authActions, constantTimeEqual } from '../api/actions/auth';
import { constantTimeEqual as realConstantTimeEqual } from '../lib/constantTime';
import { verifyToken, verifyAdminSetupGrant, verifyIdentityGrant, signIdentityGrant, signAdminSetupGrant } from '../lib/auth';

type AnyHandler = (p: any) => any;
const act = (name: string) => (authActions as unknown as Record<string, AnyHandler>)[name];

const DISCORD_ID = '123456789012345678';
const OTHER_DISCORD_ID = '876543210987654321';
const AVATAR = 'https://cdn.discordapp.com/avatars/123456789012345678/abc.png';
const CALLBACK = { code: 'oauth-code', redirectUri: 'https://org.example/auth/callback' };
const BAN_REFUSED = 'You cannot sign in to this organization.';
const SETUP_ROW = { value: { code: 'SETUP-ABCDEF12', failed_attempts: 0 } };

const logged = (level: string, msg: string) => h.logs.filter((l) => l.level === level && l.msg === msg);
const decodeClaims = (token: string) => JSON.parse(Buffer.from(token.split('.')[0], 'base64').toString());
const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Supabase responses keyed on the shape of the recorded chain. */
interface SbScenario {
    setting?: unknown;            // row returned by the settings maybeSingle
    settingError?: unknown;
    consumed?: unknown;           // rows returned by the atomic DELETE … select('key')
    claimUser?: unknown;          // row returned by org:claim's users select
    claimUserError?: unknown;
}
function scenario(s: SbScenario) {
    h.respond = (rec) => {
        const names = rec.ops.map((o) => o[0]);
        if (rec.table === 'settings') {
            if (names.includes('maybeSingle')) return { data: s.setting ?? null, error: s.settingError ?? null };
            if (names[0] === 'delete' && names.includes('select')) {
                return { data: 'consumed' in s ? s.consumed : [{ key: 'admin_setup_code' }], error: null };
            }
            return { data: null, error: null };
        }
        if (rec.table === 'users' && names.includes('single')) {
            return { data: s.claimUser ?? null, error: s.claimUserError ?? null };
        }
        return { data: null, error: null };
    };
}

const SELECT_SETTING = [['select', 'value'], ['eq', 'key', 'admin_setup_code'], ['maybeSingle']];
const CONSUME_SETTING = [['delete'], ['eq', 'key', 'admin_setup_code'], ['select', 'key']];

beforeEach(() => {
    h.logs.length = 0;
    h.sbCalls.length = 0;
    scenario({});
    for (const group of [h.db, h.discord, h.radio]) for (const fn of Object.values(group)) fn.mockReset();
    h.adminExists.mockReset();
    h.verifyRsiHandle.mockReset();

    h.db.findActiveBan.mockResolvedValue(null);
    h.db.findUserByDiscordId.mockResolvedValue(null);
    h.db.getBanNotice.mockResolvedValue(null);
    h.auditResult = () => Promise.resolve();
    h.db.refreshUserAvatar.mockResolvedValue(undefined);
    h.db.getSystemRoles.mockResolvedValue({ admin: { id: 4 }, member: { id: 3 } });
    h.discord.exchangeCodeForToken.mockResolvedValue({ access_token: 'discord-access-token' });
    h.discord.getDiscordUser.mockResolvedValue({ id: DISCORD_ID, username: 'newbie', global_name: 'Newbie Global' });
    h.discord.buildGlobalAvatarUrl.mockReturnValue(AVATAR);
    h.adminExists.mockResolvedValue(false);
    h.verifyRsiHandle.mockResolvedValue(true);
});

afterAll(() => {
    if (h.prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = h.prevSecret;
});

// ---------------------------------------------------------------------------
describe('constantTimeEqual re-export', () => {
    it('is the shared lib/constantTime implementation (existing importers keep working)', () => {
        expect(constantTimeEqual).toBe(realConstantTimeEqual);
        expect(constantTimeEqual('SETUP-1', 'SETUP-1')).toBe(true);
        expect(constantTimeEqual('SETUP-1', 'SETUP-2')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe('radio token proxies', () => {
    const actor = { id: 9, permissions: ['radio:use'] };

    it('radio:auth refuses a call with no injected user before touching the limiter or LiveKit', () => {
        expect(() => act('radio:auth')({ roomName: 'radio-main' })).toThrow('Unauthorized');
        expect(h.radio.assertRadioRateLimit).not.toHaveBeenCalled();
        expect(h.radio.generateRadioToken).not.toHaveBeenCalled();
    });

    it('radio:auth throttles on the injected user id, then mints for that user (participantName/userId ignored)', () => {
        h.radio.generateRadioToken.mockReturnValue('lk-token');
        const out = act('radio:auth')({ roomName: 'radio-main', participantName: 'Spoof', userId: 1, user: actor });
        expect(out).toBe('lk-token');
        expect(h.radio.assertRadioRateLimit).toHaveBeenCalledWith(9);
        expect(h.radio.generateRadioToken).toHaveBeenCalledWith(actor, 'radio-main');
        expect(h.radio.assertRadioRateLimit.mock.invocationCallOrder[0]).toBeLessThan(h.radio.generateRadioToken.mock.invocationCallOrder[0]);
    });

    it('radio:auth never mints when the per-user limiter trips', () => {
        h.radio.assertRadioRateLimit.mockImplementation(() => { throw new Error('Too many radio requests.'); });
        expect(() => act('radio:auth')({ roomName: 'radio-main', user: actor })).toThrow('Too many radio requests.');
        expect(h.radio.generateRadioToken).not.toHaveBeenCalled();
    });

    it('radio:op_auth refuses without a user, and otherwise mints for the injected user + operation', () => {
        expect(() => act('radio:op_auth')({ operationId: 'op-1' })).toThrow('Unauthorized');
        expect(h.radio.generateOpRadioToken).not.toHaveBeenCalled();

        h.radio.generateOpRadioToken.mockReturnValue('op-token');
        expect(act('radio:op_auth')({ operationId: 'op-1', user: actor })).toBe('op-token');
        expect(h.radio.assertRadioRateLimit).toHaveBeenCalledWith(9);
        expect(h.radio.generateOpRadioToken).toHaveBeenCalledWith(actor, 'op-1');
    });

    it('radio:op_auth never mints when the limiter trips', () => {
        h.radio.assertRadioRateLimit.mockImplementation(() => { throw new Error('slow down'); });
        expect(() => act('radio:op_auth')({ operationId: 'op-1', user: actor })).toThrow('slow down');
        expect(h.radio.generateOpRadioToken).not.toHaveBeenCalled();
    });

    it('radio:status includes participant identities only for a radio:manage holder', () => {
        h.radio.getRadioStatus.mockReturnValue({ rooms: [] });
        const manager = { id: 2, permissions: ['radio:manage'] };
        expect(act('radio:status')({ user: manager })).toEqual({ rooms: [] });
        expect(h.radio.assertRadioRateLimit).toHaveBeenCalledWith(2);
        expect(h.radio.getRadioStatus).toHaveBeenLastCalledWith({ includeParticipants: true, viewer: manager });

        act('radio:status')({ user: actor });
        expect(h.radio.getRadioStatus).toHaveBeenLastCalledWith({ includeParticipants: false, viewer: actor });
    });

    it('radio:status grants no participant view by role NAME, and treats a missing user as permissionless', () => {
        const forgedName = { id: 3, name: 'Admin', permissions: ['admin:view'] };
        act('radio:status')({ user: forgedName });
        expect(h.radio.getRadioStatus).toHaveBeenLastCalledWith({ includeParticipants: false, viewer: forgedName });

        act('radio:status')({});
        expect(h.radio.assertRadioRateLimit).toHaveBeenLastCalledWith(undefined);
        expect(h.radio.getRadioStatus).toHaveBeenLastCalledWith({ includeParticipants: false, viewer: undefined });
    });

    it('radio:status is throttled before LiveKit is queried', () => {
        h.radio.assertRadioRateLimit.mockImplementation(() => { throw new Error('throttled'); });
        expect(() => act('radio:status')({ user: actor })).toThrow('throttled');
        expect(h.radio.getRadioStatus).not.toHaveBeenCalled();
    });

    it('radio:reboot is throttled per caller and only then reboots the network', () => {
        h.radio.rebootRadioNetwork.mockReturnValue({ ok: true });
        expect(act('radio:reboot')({ user: { id: 5 } })).toEqual({ ok: true });
        expect(h.radio.assertRadioRateLimit).toHaveBeenCalledWith(5);
        expect(h.radio.rebootRadioNetwork).toHaveBeenCalledTimes(1);

        h.radio.assertRadioRateLimit.mockImplementation(() => { throw new Error('throttled'); });
        expect(() => act('radio:reboot')({ user: { id: 5 } })).toThrow('throttled');
        expect(h.radio.rebootRadioNetwork).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
describe('auth:discord_callback — input + Discord token exchange', () => {
    it('requires an authorization code, before any outbound call', async () => {
        await expect(act('auth:discord_callback')({ redirectUri: CALLBACK.redirectUri })).rejects.toThrow('Missing authorization code from Discord.');
        expect(h.discord.exchangeCodeForToken).not.toHaveBeenCalled();
    });

    it('requires a redirect URI, before any outbound call', async () => {
        await expect(act('auth:discord_callback')({ code: 'c' })).rejects.toThrow('Missing redirect URI for token exchange.');
        expect(h.discord.exchangeCodeForToken).not.toHaveBeenCalled();
    });

    it('exchanges the code for a token with the caller redirect, then reads /users/@me with that token', async () => {
        await act('auth:discord_callback')({ ...CALLBACK, state: 'nonce-1' });
        expect(h.discord.exchangeCodeForToken).toHaveBeenCalledWith('oauth-code', CALLBACK.redirectUri);
        expect(h.discord.getDiscordUser).toHaveBeenCalledWith('discord-access-token');
        expect(logged('info', 'discord callback')[0].fields).toEqual({ redirectUri: CALLBACK.redirectUri, hasState: true });
    });

    it('logs hasState=false when no state is echoed', async () => {
        await act('auth:discord_callback')({ ...CALLBACK });
        expect(logged('info', 'discord callback')[0].fields).toEqual({ redirectUri: CALLBACK.redirectUri, hasState: false });
    });

    it('maps invalid_client to a tagged, generic message that never echoes the redirect URL; detail goes to the log only', async () => {
        const raw = new Error('Discord token exchange failed: {"error":"invalid_client"}');
        h.discord.exchangeCodeForToken.mockRejectedValue(raw);
        const err = await act('auth:discord_callback')({ ...CALLBACK }).catch((e: Error) => e);
        expect(err.message).toBe('DISCORD_OAUTH_INVALID_CLIENT: Discord sign-in is misconfigured for this organization. Please contact your org administrator.');
        expect(err.message).not.toContain(CALLBACK.redirectUri);
        expect((err as Error & { cause?: unknown }).cause).toBe(raw);
        expect(logged('warn', 'discord oauth invalid_client: reset the Client Secret in the Discord Developer Portal and update the org Discord settings')[0].fields)
            .toEqual({ redirectUri: CALLBACK.redirectUri });
        expect(h.discord.getDiscordUser).not.toHaveBeenCalled();
    });

    it.each([
        ['invalid_grant', new Error('{"error":"invalid_grant"}')],
        ['redirect_uri', new Error('Invalid "redirect_uri" in request.')],
        ['a non-Error rejection', 'INVALID_GRANT'],
    ])('maps %s to the tagged redirect-mismatch message', async (_label, raw) => {
        h.discord.exchangeCodeForToken.mockRejectedValue(raw);
        const err = await act('auth:discord_callback')({ ...CALLBACK }).catch((e: Error) => e);
        expect(err.message).toBe('DISCORD_OAUTH_REDIRECT_MISMATCH: Discord sign-in is misconfigured for this organization. Please contact your org administrator.');
        expect(err.message).not.toContain(CALLBACK.redirectUri);
        expect(logged('warn', 'discord oauth redirect mismatch: add the exact redirect URL as an authorized redirect in the Discord Developer Portal')).toHaveLength(1);
    });

    it('rethrows any other exchange failure unchanged (no tag, no log line)', async () => {
        const raw = new Error('network down');
        h.discord.exchangeCodeForToken.mockRejectedValue(raw);
        await expect(act('auth:discord_callback')({ ...CALLBACK })).rejects.toBe(raw);
        expect(h.logs.filter((l) => l.level === 'warn')).toEqual([]);
    });

    it('rethrows an empty rejection as-is', async () => {
        h.discord.exchangeCodeForToken.mockRejectedValue(undefined);
        await expect(act('auth:discord_callback')({ ...CALLBACK })).rejects.toBeUndefined();
        expect(h.discord.getDiscordUser).not.toHaveBeenCalled();
    });

    it.each([
        ['a numeric (non-string) id', { id: 123456789012345680, username: 'x' }],
        ['an id with a filter separator', { id: '123.456', username: 'x' }],
        ['an id with a comma', { id: '1,auth_user_id.is.null', username: 'x' }],
        ['an over-long id', { id: '1'.repeat(26), username: 'x' }],
        ['an empty id', { id: '', username: 'x' }],
        ['no user at all', null],
    ])('refuses %s from Discord before any ban, user or filter query', async (_label, discordUser) => {
        h.discord.getDiscordUser.mockResolvedValue(discordUser);
        await expect(act('auth:discord_callback')({ ...CALLBACK })).rejects.toThrow('Discord returned an unexpected account id.');
        expect(h.db.findActiveBan).not.toHaveBeenCalled();
        expect(h.db.findUserByDiscordId).not.toHaveBeenCalled();
        expect(h.sbCalls).toEqual([]);
    });

    it('accepts the longest permitted id (25 digits)', async () => {
        const id = '9'.repeat(25);
        h.discord.getDiscordUser.mockResolvedValue({ id, username: 'long' });
        const out = await act('auth:discord_callback')({ ...CALLBACK });
        expect(out.user.discordId).toBe(id);
        expect(h.db.findActiveBan).toHaveBeenCalledWith({ discordId: id });
    });
});

// ---------------------------------------------------------------------------
describe('auth:discord_callback — org ban gate (login)', () => {
    const BANNED_USER = { id: 41, rsiHandle: 'Banned_One', discordId: DISCORD_ID };
    const NOTICE = { banId: 77, reason: 'conduct', canAppeal: true };

    it('mints an APPEAL session (token only, no user object) for a banned Discord id', async () => {
        h.db.findActiveBan.mockResolvedValue({ id: 77 });
        h.db.findUserByDiscordId.mockResolvedValue(BANNED_USER);
        h.db.getBanNotice.mockResolvedValue(NOTICE);

        const out = await act('auth:discord_callback')({ ...CALLBACK });
        expect(Object.keys(out).sort()).toEqual(['banNotice', 'banned', 'isNewUser', 'token']);
        expect(out).toMatchObject({ isNewUser: false, banned: true, banNotice: NOTICE });
        expect(verifyToken(out.token)).toMatchObject({ userId: 41 });

        expect(h.db.findActiveBan).toHaveBeenCalledWith({ discordId: DISCORD_ID });
        // includeDeleted=false: a banned-and-deleted member is never reactivated on the way in.
        expect(h.db.findUserByDiscordId).toHaveBeenCalledTimes(1);
        expect(h.db.findUserByDiscordId).toHaveBeenCalledWith(DISCORD_ID, false);
        expect(h.db.getBanNotice).toHaveBeenCalledWith(41, DISCORD_ID);
        expect(h.db.reactivateUser).not.toHaveBeenCalled();
        expect(h.sbCalls).toEqual([]); // no auth_user_id rebind for a banned login

        expect(h.db.recordSecurityEvent).toHaveBeenCalledWith({
            event: 'authz.org_ban.login_denied',
            action: 'auth:discord_callback',
            actorUserId: 41,
            actorLabel: 'Banned_One',
            outcome: 'denied',
            details: { banId: 77, appealSession: true },
        });
    });

    it('runs ABOVE the admin claim: a banned member cannot burn the one-time setup code', async () => {
        h.db.findActiveBan.mockResolvedValue({ id: 77 });
        h.db.findUserByDiscordId.mockResolvedValue(BANNED_USER);
        h.db.getBanNotice.mockResolvedValue(NOTICE);
        scenario({ setting: SETUP_ROW });

        const out = await act('auth:discord_callback')({ ...CALLBACK, state: 'admin_setup:SETUP-ABCDEF12' });
        expect(out.banned).toBe(true);
        expect(out).not.toHaveProperty('adminSetupToken');
        expect(h.adminExists).not.toHaveBeenCalled();
        expect(h.sbCalls.filter((c) => c.table === 'settings')).toEqual([]);
    });

    it('labels the audit row null when the banned member has no RSI handle', async () => {
        h.db.findActiveBan.mockResolvedValue({ id: 5 });
        h.db.findUserByDiscordId.mockResolvedValue({ id: 8, rsiHandle: undefined });
        h.db.getBanNotice.mockResolvedValue(NOTICE);
        await act('auth:discord_callback')({ ...CALLBACK });
        expect(h.db.recordSecurityEvent.mock.calls[0][0]).toMatchObject({ actorUserId: 8, actorLabel: null, details: { banId: 5, appealSession: true } });
    });

    it('refuses with the generic message when the banned Discord id has no live account (ban survives delete)', async () => {
        h.db.findActiveBan.mockResolvedValue({ id: 77 });
        h.db.findUserByDiscordId.mockResolvedValue(null);
        await expect(act('auth:discord_callback')({ ...CALLBACK })).rejects.toThrow(BAN_REFUSED);
        expect(h.db.getBanNotice).not.toHaveBeenCalled();
        expect(h.db.recordSecurityEvent).not.toHaveBeenCalled();
    });

    it('refuses with the generic message when the notice cannot be read (race with a lift)', async () => {
        h.db.findActiveBan.mockResolvedValue({ id: 77 });
        h.db.findUserByDiscordId.mockResolvedValue(BANNED_USER);
        h.db.getBanNotice.mockResolvedValue(null);
        await expect(act('auth:discord_callback')({ ...CALLBACK })).rejects.toThrow(BAN_REFUSED);
        expect(h.db.recordSecurityEvent).not.toHaveBeenCalled();
    });

    it('a rejected audit write never breaks the appeal session and is never left unhandled', async () => {
        h.db.findActiveBan.mockResolvedValue({ id: 77 });
        h.db.findUserByDiscordId.mockResolvedValue(BANNED_USER);
        h.db.getBanNotice.mockResolvedValue(NOTICE);
        h.auditResult = () => Promise.reject(new Error('audit table down'));
        const seen: unknown[] = [];
        const onUnhandled = (reason: unknown) => { seen.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        try {
            const out = await act('auth:discord_callback')({ ...CALLBACK });
            await flushAsync();
            await flushAsync();
            expect(out.banned).toBe(true);
            expect(verifyToken(out.token)?.userId).toBe(41);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        expect(h.db.recordSecurityEvent).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([]);
    });

    it('a synchronously throwing audit emitter never breaks the appeal session', async () => {
        h.db.findActiveBan.mockResolvedValue({ id: 77 });
        h.db.findUserByDiscordId.mockResolvedValue(BANNED_USER);
        h.db.getBanNotice.mockResolvedValue(NOTICE);
        h.auditResult = () => { throw new Error('partial double'); };
        const out = await act('auth:discord_callback')({ ...CALLBACK });
        expect(out.banned).toBe(true);
        expect(h.db.recordSecurityEvent).toHaveBeenCalledTimes(1);
    });

    it('fails CLOSED: a ban-store fault propagates and no session is minted', async () => {
        const fault = Object.assign(new Error('ban check unavailable'), { name: 'BanCheckUnavailable' });
        h.db.findActiveBan.mockRejectedValue(fault);
        await expect(act('auth:discord_callback')({ ...CALLBACK })).rejects.toBe(fault);
        expect(h.db.findUserByDiscordId).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe('auth:discord_callback — first-admin claim via OAuth state', () => {
    it('consumes a valid setup code and returns an admin-setup grant bound to the verified Discord id', async () => {
        scenario({ setting: SETUP_ROW });
        const out = await act('auth:discord_callback')({ ...CALLBACK, state: 'admin_setup:SETUP-ABCDEF12' });

        expect(h.adminExists).toHaveBeenCalledTimes(1);
        expect(h.sbCalls).toEqual([
            { table: 'settings', ops: SELECT_SETTING },
            { table: 'settings', ops: CONSUME_SETTING },
        ]);
        expect(out.isNewUser).toBe(true);
        expect(out.user).toEqual({ discordId: DISCORD_ID, name: 'Newbie Global', avatarUrl: AVATAR, isAdminSetup: true });
        expect(verifyAdminSetupGrant(out.adminSetupToken)).toEqual({ discordId: DISCORD_ID });
    });

    it('refuses once an admin exists — BEFORE the code is read or consumed', async () => {
        h.adminExists.mockResolvedValue(true);
        scenario({ setting: SETUP_ROW });
        await expect(act('auth:discord_callback')({ ...CALLBACK, state: 'admin_setup:SETUP-ABCDEF12' }))
            .rejects.toThrow('An administrator already exists for this organization.');
        expect(h.sbCalls).toEqual([]);
        expect(h.db.findUserByDiscordId).not.toHaveBeenCalled();
    });

    it('a wrong code fails the whole login (no new-user payload, no grant)', async () => {
        scenario({ setting: SETUP_ROW });
        await expect(act('auth:discord_callback')({ ...CALLBACK, state: 'admin_setup:SETUP-WRONG000' })).rejects.toThrow('Invalid setup code.');
        expect(h.db.findUserByDiscordId).not.toHaveBeenCalled();
    });

    it('reads the key from the client\'s real three-segment state (admin_setup:<key>:<nonce>), never the nonce', async () => {
        scenario({ setting: SETUP_ROW });
        const out = await act('auth:discord_callback')({ ...CALLBACK, state: 'admin_setup:SETUP-ABCDEF12:n0nce_ABCDEFGHIJKLMNOP-1234' });
        expect(verifyAdminSetupGrant(out.adminSetupToken)).toEqual({ discordId: DISCORD_ID });
        expect(h.sbCalls[1]).toEqual({ table: 'settings', ops: CONSUME_SETTING });
    });

    it.each([
        ['an empty claim key', 'admin_setup:'],
        ['the client\'s keyless shape', 'admin_setup::n0nce_ABCDEFGHIJKLMNOP-1234'],
        ['an ordinary nonce state', 'nonce_abcdef'],
        ['a state that merely contains the prefix', 'x-admin_setup:SETUP-ABCDEF12'],
    ])('treats %s as NOT a claim (no admin check, no code access, no grant)', async (_label, state) => {
        scenario({ setting: SETUP_ROW });
        const out = await act('auth:discord_callback')({ ...CALLBACK, state });
        expect(h.adminExists).not.toHaveBeenCalled();
        expect(h.sbCalls).toEqual([]);
        expect(out.user.isAdminSetup).toBe(false);
        expect(out).not.toHaveProperty('adminSetupToken');
    });
});

// ---------------------------------------------------------------------------
describe('auth:discord_callback — new user', () => {
    it('returns the pending profile, a server-issued RSI code, and an identity grant carrying THAT code', async () => {
        const out = await act('auth:discord_callback')({ ...CALLBACK });
        expect(Object.keys(out).sort()).toEqual(['identityToken', 'isNewUser', 'user', 'verificationCode']);
        expect(out.isNewUser).toBe(true);
        expect(out.user).toEqual({ discordId: DISCORD_ID, name: 'Newbie Global', avatarUrl: AVATAR, isAdminSetup: false });
        expect(out.verificationCode).toMatch(/^MYRSI-/);
        expect(verifyIdentityGrant(out.identityToken)).toEqual({ discordId: DISCORD_ID, vc: out.verificationCode });
        expect(h.discord.buildGlobalAvatarUrl).toHaveBeenCalledWith({ id: DISCORD_ID, username: 'newbie', global_name: 'Newbie Global' });
        expect(h.db.findUserByDiscordId).toHaveBeenCalledWith(DISCORD_ID, true);
        expect(h.sbCalls).toEqual([]);
    });

    it('falls back to the Discord username when there is no global display name', async () => {
        h.discord.getDiscordUser.mockResolvedValue({ id: DISCORD_ID, username: 'plain_user', global_name: null });
        const out = await act('auth:discord_callback')({ ...CALLBACK });
        expect(out.user.name).toBe('plain_user');
    });
});

// ---------------------------------------------------------------------------
describe('auth:discord_callback — returning user', () => {
    const MEMBER = {
        id: 12, discordId: DISCORD_ID, name: 'Cmdr', avatarUrl: AVATAR, role: 'Member', roleId: 3,
        permissions: ['user:view:roster'], adminNotes: 'admin-only note', personnelNotes: 'own notes',
        rsiVerificationCode: 'MYRSI-OWN', isSystemAdmin: false,
    };

    it('binds the Discord identity to auth_user_id with a filter built only from the vetted numeric id', async () => {
        h.db.findUserByDiscordId.mockResolvedValue({ ...MEMBER });
        await act('auth:discord_callback')({ ...CALLBACK });
        expect(h.sbCalls).toEqual([{
            table: 'users',
            ops: [
                ['update', { auth_user_id: DISCORD_ID }],
                ['eq', 'discord_id', DISCORD_ID],
                ['or', `auth_user_id.is.null,auth_user_id.neq.${DISCORD_ID}`],
            ],
        }]);
    });

    it('returns a session token for the user and a SELF-stripped record (adminNotes blanked without admin:user:update)', async () => {
        h.db.findUserByDiscordId.mockResolvedValue({ ...MEMBER });
        const out = await act('auth:discord_callback')({ ...CALLBACK });
        expect(Object.keys(out).sort()).toEqual(['isNewUser', 'token', 'user']);
        expect(out.isNewUser).toBe(false);
        expect(verifyToken(out.token)).toMatchObject({ userId: 12 });
        expect(out.user.adminNotes).toBeUndefined();
        expect(out.user.isSystemAdmin).toBeUndefined();     // server-internal flag never reaches the browser
        expect(out.user.personnelNotes).toBe('own notes');  // self keeps personal data
        expect(out.user.rsiVerificationCode).toBe('MYRSI-OWN');
        expect(out.user.permissions).toEqual(['user:view:roster']);
        expect(h.db.refreshUserAvatar).not.toHaveBeenCalled(); // avatar unchanged
        expect(h.db.reactivateUser).not.toHaveBeenCalled();
    });

    it('keeps adminNotes for a self record that holds admin:user:update', async () => {
        h.db.findUserByDiscordId.mockResolvedValue({ ...MEMBER, permissions: ['admin:user:update'] });
        const out = await act('auth:discord_callback')({ ...CALLBACK });
        expect(out.user.adminNotes).toBe('admin-only note');
    });

    it('forwards role IDENTITY (isSystemAdmin) so the stamped Admin keeps the full self record', async () => {
        h.db.findUserByDiscordId.mockResolvedValue({ ...MEMBER, role: 'Admin', isSystemAdmin: true, permissions: [] });
        const out = await act('auth:discord_callback')({ ...CALLBACK });
        expect(out.user.adminNotes).toBe('admin-only note');
        expect(out.user.isSystemAdmin).toBeUndefined();
    });

    it('a role NAMED Admin without identity does not get adminNotes, and missing permissions read as none', async () => {
        h.db.findUserByDiscordId.mockResolvedValue({ ...MEMBER, role: 'Admin', isSystemAdmin: undefined, permissions: undefined });
        const out = await act('auth:discord_callback')({ ...CALLBACK });
        expect(out.user.adminNotes).toBeUndefined();
    });

    it('refreshes a stale cached avatar and returns the fresh one', async () => {
        h.db.findUserByDiscordId.mockResolvedValue({ ...MEMBER, avatarUrl: 'https://cdn/old.png' });
        const out = await act('auth:discord_callback')({ ...CALLBACK });
        expect(h.db.refreshUserAvatar).toHaveBeenCalledWith(12, AVATAR);
        expect(out.user.avatarUrl).toBe(AVATAR);
    });

    it('a failed avatar refresh is logged, never fails the login', async () => {
        const fault = new Error('storage down');
        h.db.findUserByDiscordId.mockResolvedValue({ ...MEMBER, avatarUrl: 'https://cdn/old.png' });
        h.db.refreshUserAvatar.mockRejectedValue(fault);
        const out = await act('auth:discord_callback')({ ...CALLBACK });
        await flushAsync();
        expect(verifyToken(out.token)?.userId).toBe(12);
        expect(logged('warn', 'post-login avatar refresh failed')[0].fields).toEqual({ err: fault });
    });

    it('reactivates a soft-deleted returning member with ONLY name + avatar (same user.id keeps history)', async () => {
        h.db.findUserByDiscordId.mockResolvedValue({ ...MEMBER, deletedAt: '2026-01-01T00:00:00Z' });
        h.db.reactivateUser.mockResolvedValue({ ...MEMBER });
        const out = await act('auth:discord_callback')({ ...CALLBACK });
        expect(h.db.reactivateUser).toHaveBeenCalledWith(12, { name: 'Newbie Global', avatar_url: AVATAR });
        expect(verifyToken(out.token)?.userId).toBe(12);
    });

    it('reactivation names fall back to the username', async () => {
        h.discord.getDiscordUser.mockResolvedValue({ id: DISCORD_ID, username: 'plain_user' });
        h.db.findUserByDiscordId.mockResolvedValue({ ...MEMBER, deletedAt: '2026-01-01T00:00:00Z' });
        h.db.reactivateUser.mockResolvedValue({ ...MEMBER });
        await act('auth:discord_callback')({ ...CALLBACK });
        expect(h.db.reactivateUser).toHaveBeenCalledWith(12, { name: 'plain_user', avatar_url: AVATAR });
    });

    it('a failed reactivation refuses the login with no token and no identity rebind', async () => {
        h.db.findUserByDiscordId.mockResolvedValue({ ...MEMBER, deletedAt: '2026-01-01T00:00:00Z' });
        h.db.reactivateUser.mockResolvedValue(null);
        await expect(act('auth:discord_callback')({ ...CALLBACK })).rejects.toThrow('User restoration failed.');
        expect(h.sbCalls).toEqual([]);
    });

    it('an admin-claim state on a RETURNING user consumes the code but grants nothing beyond a normal session', async () => {
        scenario({ setting: SETUP_ROW });
        h.db.findUserByDiscordId.mockResolvedValue({ ...MEMBER });
        const out = await act('auth:discord_callback')({ ...CALLBACK, state: 'admin_setup:SETUP-ABCDEF12' });
        expect(out).not.toHaveProperty('adminSetupToken');
        expect(out.isNewUser).toBe(false);
        expect(h.sbCalls.map((c) => c.table)).toEqual(['settings', 'settings', 'users']);
    });
});

// ---------------------------------------------------------------------------
describe('validateClaimCode (via auth:redeem_setup_code)', () => {
    const identityToken = () => signIdentityGrant(DISCORD_ID, 'MYRSI-1');
    const redeem = (code = 'SETUP-ABCDEF12') => act('auth:redeem_setup_code')({ discordId: DISCORD_ID, code, identityToken: identityToken() });

    it('a settings read fault fails closed with a retry message, logged server-side', async () => {
        const dbErr = { message: 'relation "settings" does not exist', code: '42P01' };
        scenario({ settingError: dbErr });
        await expect(redeem()).rejects.toThrow('Failed to verify setup code. Please try again.');
        expect(logged('error', 'claim code db query failed')[0].fields).toEqual({ err: dbErr });
        expect(h.sbCalls).toHaveLength(1);
    });

    it('no active code is refused with the console pointer', async () => {
        scenario({ setting: null });
        await expect(redeem()).rejects.toThrow(/^No admin setup code is active\./);
        expect(h.sbCalls).toHaveLength(1);
    });

    it('burns the code once failed attempts reach the cap (10), without comparing the submission', async () => {
        scenario({ setting: { value: { code: 'SETUP-ABCDEF12', failed_attempts: 10 } } });
        await expect(redeem('SETUP-ABCDEF12')).rejects.toThrow('Too many failed attempts. The setup code has been revoked — restart the server to generate a new one.');
        expect(h.sbCalls).toEqual([
            { table: 'settings', ops: SELECT_SETTING },
            { table: 'settings', ops: [['delete'], ['eq', 'key', 'admin_setup_code']] },
        ]);
    });

    it('nine prior failures still allow a correct code (cap is >= 10, not > 9 off-by-one the other way)', async () => {
        scenario({ setting: { value: { code: 'SETUP-ABCDEF12', failed_attempts: 9 } } });
        const out = await redeem('SETUP-ABCDEF12');
        expect(verifyAdminSetupGrant(out.adminSetupToken)).toEqual({ discordId: DISCORD_ID });
    });

    it('a wrong code increments failed_attempts, preserving the stored object fields, and is refused', async () => {
        scenario({ setting: { value: { code: 'SETUP-ABCDEF12', failed_attempts: 3, createdAt: 'T0' } } });
        await expect(redeem('SETUP-00000000')).rejects.toThrow('Invalid setup code.');
        expect(h.sbCalls[1]).toEqual({
            table: 'settings',
            ops: [['update', { value: { code: 'SETUP-ABCDEF12', failed_attempts: 4, createdAt: 'T0' } }], ['eq', 'key', 'admin_setup_code']],
        });
        expect(h.sbCalls).toHaveLength(2); // never consumed
    });

    it('a legacy string-shaped code counts from zero and is upgraded to the object shape on a miss', async () => {
        scenario({ setting: { value: 'SETUP-LEGACY01' } });
        await expect(redeem('SETUP-00000000')).rejects.toThrow('Invalid setup code.');
        expect(h.sbCalls[1].ops[0]).toEqual(['update', { value: { code: 'SETUP-LEGACY01', failed_attempts: 1 } }]);
    });

    it('a legacy string-shaped code that matches is consumed', async () => {
        scenario({ setting: { value: 'SETUP-LEGACY01' } });
        const out = await redeem('SETUP-LEGACY01');
        expect(verifyAdminSetupGrant(out.adminSetupToken)).toEqual({ discordId: DISCORD_ID });
        expect(h.sbCalls[1]).toEqual({ table: 'settings', ops: CONSUME_SETTING });
    });

    it('an object without failed_attempts counts from zero', async () => {
        scenario({ setting: { value: { code: 'SETUP-ABCDEF12' } } });
        await expect(redeem('SETUP-00000000')).rejects.toThrow('Invalid setup code.');
        expect(h.sbCalls[1].ops[0]).toEqual(['update', { value: { code: 'SETUP-ABCDEF12', failed_attempts: 1 } }]);
    });

    it('a stored row with no code at all can never be matched (an empty submission does not equal "nothing")', async () => {
        scenario({ setting: { value: null } });
        await expect(act('auth:redeem_setup_code')({ discordId: DISCORD_ID, code: 'x', identityToken: identityToken() })).rejects.toThrow('Invalid setup code.');
        expect(h.sbCalls[1].ops[0]).toEqual(['update', { value: { failed_attempts: 1 } }]);
    });

    it.each([
        ['zero rows', []],
        ['a null result', null],
    ])('loses the consume race cleanly on %s (two concurrent valid submissions cannot both win)', async (_label, consumed) => {
        scenario({ setting: SETUP_ROW, consumed });
        await expect(redeem()).rejects.toThrow('This setup code was just used. Restart the server to generate a new one if needed.');
    });
});

// ---------------------------------------------------------------------------
describe('auth:redeem_setup_code', () => {
    it.each([
        ['no discordId', { code: 'SETUP-ABCDEF12' }],
        ['no code', { discordId: DISCORD_ID }],
    ])('requires identity and code (%s), before any admin or code lookup', async (_label, payload) => {
        await expect(act('auth:redeem_setup_code')(payload)).rejects.toThrow('Discord identity and setup code are required.');
        expect(h.adminExists).not.toHaveBeenCalled();
        expect(h.sbCalls).toEqual([]);
    });

    it('refuses once an admin exists, before the identity or code is examined', async () => {
        h.adminExists.mockResolvedValue(true);
        await expect(act('auth:redeem_setup_code')({ discordId: DISCORD_ID, code: 'SETUP-ABCDEF12', identityToken: signIdentityGrant(DISCORD_ID, 'v') }))
            .rejects.toThrow('An administrator already exists for this organization.');
        expect(h.sbCalls).toEqual([]);
    });

    it.each([
        ['a missing identity token', undefined],
        ['a forged identity token', 'eyJmb28iOjF9.deadbeef'],
        ['an admin-setup grant presented as identity', signAdminSetupGrant(DISCORD_ID)],
    ])('refuses %s without consuming the code', async (_label, identityToken) => {
        scenario({ setting: SETUP_ROW });
        await expect(act('auth:redeem_setup_code')({ discordId: DISCORD_ID, code: 'SETUP-ABCDEF12', identityToken }))
            .rejects.toThrow('Your sign-in session has expired. Please sign in with Discord again.');
        expect(h.sbCalls).toEqual([]);
    });

    it('refuses an identity grant minted for a DIFFERENT Discord id (no grant for an unproven identity)', async () => {
        scenario({ setting: SETUP_ROW });
        await expect(act('auth:redeem_setup_code')({ discordId: DISCORD_ID, code: 'SETUP-ABCDEF12', identityToken: signIdentityGrant(OTHER_DISCORD_ID, 'v') }))
            .rejects.toThrow('Your sign-in session has expired. Please sign in with Discord again.');
        expect(h.sbCalls).toEqual([]);
    });

    it('consumes the code and returns ONLY an admin-setup grant bound to the proven id', async () => {
        scenario({ setting: SETUP_ROW });
        const out = await act('auth:redeem_setup_code')({ discordId: DISCORD_ID, code: 'SETUP-ABCDEF12', identityToken: signIdentityGrant(DISCORD_ID, 'v') });
        expect(Object.keys(out)).toEqual(['adminSetupToken']);
        expect(verifyAdminSetupGrant(out.adminSetupToken)).toEqual({ discordId: DISCORD_ID });
        expect(h.sbCalls).toEqual([{ table: 'settings', ops: SELECT_SETTING }, { table: 'settings', ops: CONSUME_SETTING }]);
    });
});

// ---------------------------------------------------------------------------
describe('auth:finalize_setup', () => {
    const CREATED = { id: 60, name: 'Cmdr', roleId: 3 };
    const identity = (discordId = DISCORD_ID, vc = 'MYRSI-SERVER1') => signIdentityGrant(discordId, vc);
    const base = () => ({ discordId: DISCORD_ID, name: 'Cmdr', avatarUrl: AVATAR, rsiHandle: 'Cmdr_Handle', identityToken: identity() });

    beforeEach(() => { h.db.createUser.mockResolvedValue({ ...CREATED }); });

    it('requires an RSI handle', async () => {
        await expect(act('auth:finalize_setup')({ ...base(), rsiHandle: '' })).rejects.toThrow('An RSI handle is required.');
        expect(h.verifyRsiHandle).not.toHaveBeenCalled();
    });

    it.each(['%', 'a/b', 'has space', 'a'.repeat(61), '<script>'])('rejects the malformed handle %j before ANY grant check, ban lookup or outbound call', async (rsiHandle) => {
        await expect(act('auth:finalize_setup')({ ...base(), rsiHandle }))
            .rejects.toThrow('That is not a valid RSI handle. Handles are letters, numbers, underscores and hyphens.');
        expect(h.db.findActiveBan).not.toHaveBeenCalled();
        expect(h.verifyRsiHandle).not.toHaveBeenCalled();
        expect(h.db.createUser).not.toHaveBeenCalled();
    });

    it.each([
        ['a missing identity grant', undefined],
        ['a forged identity grant', 'bm9wZQ==.00'],
    ])('refuses %s, and does NOT consult the ban list (no ban oracle for an unproven id)', async (_label, identityToken) => {
        await expect(act('auth:finalize_setup')({ ...base(), identityToken })).rejects.toThrow('Your sign-in session has expired. Please sign in with Discord again.');
        expect(h.db.findActiveBan).not.toHaveBeenCalled();
        expect(h.db.createUser).not.toHaveBeenCalled();
    });

    it('refuses a grant bound to another Discord id (no squatting someone else\'s id), again without a ban lookup', async () => {
        await expect(act('auth:finalize_setup')({ ...base(), discordId: OTHER_DISCORD_ID }))
            .rejects.toThrow('Your sign-in session has expired. Please sign in with Discord again.');
        expect(h.db.findActiveBan).not.toHaveBeenCalled();
    });

    it('hard-refuses a banned Discord id with the generic message, after the grant proved ownership', async () => {
        h.db.findActiveBan.mockResolvedValue({ id: 3 });
        await expect(act('auth:finalize_setup')(base())).rejects.toThrow(BAN_REFUSED);
        expect(h.db.findActiveBan).toHaveBeenCalledWith({ discordId: DISCORD_ID });
        expect(h.verifyRsiHandle).not.toHaveBeenCalled();
        expect(h.db.createUser).not.toHaveBeenCalled();
    });

    it('a ban-store fault fails closed (propagates, no account written)', async () => {
        h.db.findActiveBan.mockRejectedValue(Object.assign(new Error('unavailable'), { name: 'BanCheckUnavailable' }));
        await expect(act('auth:finalize_setup')(base())).rejects.toThrow('unavailable');
        expect(h.db.createUser).not.toHaveBeenCalled();
    });

    it('verifies the handle against the SERVER code inside the grant (client code ignored) and creates a verified member', async () => {
        const out = await act('auth:finalize_setup')({ ...base(), verificationCode: 'CLIENT-CHOSEN', isAdmin: true });
        expect(h.verifyRsiHandle).toHaveBeenCalledWith('Cmdr_Handle', 'MYRSI-SERVER1');
        // The client isAdmin flag is never trusted.
        expect(h.db.createUser).toHaveBeenCalledWith({
            discordId: DISCORD_ID, name: 'Cmdr', avatarUrl: AVATAR, rsiHandle: 'Cmdr_Handle', isAdmin: false, rsiVerified: true,
        });
        expect(out).toMatchObject({ id: 60, name: 'Cmdr', roleId: 3 });
        expect(verifyToken(out.token)).toMatchObject({ userId: 60 });
    });

    it('a failed bio verification refuses and writes nothing', async () => {
        h.verifyRsiHandle.mockResolvedValue(false);
        await expect(act('auth:finalize_setup')(base())).rejects.toThrow('Verification failed. Ensure the code is saved in your RSI bio and try again.');
        expect(h.db.createUser).not.toHaveBeenCalled();
    });

    it('an identity grant with no server code refuses rather than verifying against nothing', async () => {
        await expect(act('auth:finalize_setup')({ ...base(), identityToken: identity(DISCORD_ID, '') }))
            .rejects.toThrow('Your sign-in session has expired. Please sign in with Discord again.');
        expect(h.verifyRsiHandle).not.toHaveBeenCalled();
        expect(h.db.createUser).not.toHaveBeenCalled();
    });

    it('a valid admin-setup grant for THIS id creates an Admin (verification still runs without skip)', async () => {
        await act('auth:finalize_setup')({ ...base(), adminSetupToken: signAdminSetupGrant(DISCORD_ID) });
        expect(h.verifyRsiHandle).toHaveBeenCalledTimes(1);
        expect(h.db.createUser.mock.calls[0][0]).toMatchObject({ isAdmin: true, rsiVerified: true });
    });

    it('the admin offline bypass skips the RSI call and records the handle UNVERIFIED', async () => {
        await act('auth:finalize_setup')({ ...base(), adminSetupToken: signAdminSetupGrant(DISCORD_ID), skipVerification: true });
        expect(h.verifyRsiHandle).not.toHaveBeenCalled();
        expect(h.db.createUser.mock.calls[0][0]).toMatchObject({ isAdmin: true, rsiVerified: false });
    });

    it('an admin grant minted for ANOTHER Discord id is ignored (non-admin, logged) and the bypass does not apply', async () => {
        await act('auth:finalize_setup')({ ...base(), adminSetupToken: signAdminSetupGrant(OTHER_DISCORD_ID), skipVerification: true });
        expect(logged('warn', 'finalize_setup: invalid or mismatched admin setup grant — creating non-admin user')).toHaveLength(1);
        expect(h.verifyRsiHandle).toHaveBeenCalledTimes(1);
        expect(h.db.createUser.mock.calls[0][0]).toMatchObject({ isAdmin: false, rsiVerified: true });
    });

    it('an identity grant cannot be replayed as an admin grant', async () => {
        await act('auth:finalize_setup')({ ...base(), adminSetupToken: identity(), skipVerification: true });
        expect(h.db.createUser.mock.calls[0][0]).toMatchObject({ isAdmin: false, rsiVerified: true });
    });

    it('a member cannot use the offline bypass', async () => {
        await act('auth:finalize_setup')({ ...base(), skipVerification: true });
        expect(h.verifyRsiHandle).toHaveBeenCalledTimes(1);
        expect(h.db.createUser.mock.calls[0][0]).toMatchObject({ isAdmin: false, rsiVerified: true });
    });

    it('a null createUser result is refused with no token minted', async () => {
        h.db.createUser.mockResolvedValue(null);
        await expect(act('auth:finalize_setup')(base())).rejects.toThrow('Failed to create user.');
    });
});

// ---------------------------------------------------------------------------
describe('org:claim', () => {
    const claim = (code = 'SETUP-ABCDEF12') => act('org:claim')({ code, userId: 6 });

    it('a user-lookup fault is a retryable refusal, logged with the id only', async () => {
        const err = { message: 'boom', code: 'XX000' };
        scenario({ claimUserError: err });
        await expect(claim()).rejects.toThrow('Failed to verify user. Please try again.');
        expect(logged('error', 'claim user lookup failed')[0].fields).toEqual({ userId: 6, err });
        expect(h.adminExists).not.toHaveBeenCalled();
    });

    it('an unknown user context is refused', async () => {
        scenario({ claimUser: null });
        await expect(claim()).rejects.toThrow('User context invalid.');
        expect(h.adminExists).not.toHaveBeenCalled();
    });

    it('looks the caller up by the dispatcher-forced userId, narrowly', async () => {
        scenario({ claimUser: { id: 6 } });
        h.adminExists.mockResolvedValue(true);
        await expect(claim()).rejects.toThrow('An administrator already exists for this organization.');
        expect(h.sbCalls[0]).toEqual({ table: 'users', ops: [['select', 'id'], ['eq', 'id', 6], ['single']] });
        expect(h.sbCalls).toHaveLength(1); // code never read once an admin exists
        expect(logged('info', 'org:claim attempt')[0].fields).toEqual({ userId: 6 });
    });

    it('a wrong code promotes nobody', async () => {
        scenario({ claimUser: { id: 6 }, setting: SETUP_ROW });
        await expect(claim('SETUP-00000000')).rejects.toThrow('Invalid setup code.');
        expect(h.db.getSystemRoles).not.toHaveBeenCalled();
        expect(h.sbCalls.some((c) => c.table === 'users' && c.ops[0][0] === 'update')).toBe(false);
    });

    it('a valid code promotes the caller to the system Admin role by role id', async () => {
        scenario({ claimUser: { id: 6 }, setting: SETUP_ROW });
        await expect(claim()).resolves.toEqual({ success: true });
        expect(h.sbCalls).toEqual([
            { table: 'users', ops: [['select', 'id'], ['eq', 'id', 6], ['single']] },
            { table: 'settings', ops: SELECT_SETTING },
            { table: 'settings', ops: CONSUME_SETTING },
            { table: 'users', ops: [['update', { role_id: 4 }], ['eq', 'id', 6]] },
        ]);
    });

    it('a missing Admin role is a configuration error and writes no role', async () => {
        scenario({ claimUser: { id: 6 }, setting: SETUP_ROW });
        h.db.getSystemRoles.mockResolvedValue({ member: { id: 3 } });
        await expect(claim()).rejects.toThrow('System Configuration Error');
        expect(logged('error', 'admin role not found for org claim')).toHaveLength(1);
        expect(h.sbCalls.filter((c) => c.ops[0][0] === 'update')).toEqual([]);
    });
});
