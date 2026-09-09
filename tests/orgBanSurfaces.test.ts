import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ORG BANS — the surfaces BEYOND the dispatcher.
//
// tests/orgBanEnforcement.test.ts pins the dispatcher gate and the db layer. This
// file pins the other four places an authenticated request can reach the org:
//
//   · the READ path        (api/query.ts handleState)
//   · the BOOT payload     (api/query.ts target=initial-state)
//   · the LOGIN path       (api/actions/auth.ts — the only one that can refuse
//                           someone who has no user row at all)
//   · the SIBLING routes   (api/orgUpload.ts, server.ts import-stream)
//
// The through-line: ban:place deliberately does NOT revoke sessions, so a banned
// member keeps a VALID token. Every one of these surfaces would otherwise keep
// serving them until that token expired on its own.

const h = vi.hoisted(() => ({
    user: null as Record<string, unknown> | null,
    ban: null as { id: number; reason: string; expiresAt: string | null; bannedAt: string } | null,
    banThrows: false,
    notice: null as Record<string, unknown> | null,
    getStateCalls: 0,
    mainStateCalls: 0,
    realtimeTokens: 0,
}));

class FakeBanCheckUnavailable extends Error {
    constructor() { super('Unable to verify account status. Please try again.'); this.name = 'BanCheckUnavailable'; }
}

vi.mock('../lib/db', () => {
    // Declared INSIDE the factory: vi.mock is hoisted above every top-level
    // statement, so a module-scope builder is still in its TDZ when this runs.
    //
    // Enough of a builder to satisfy the admin-count probe at the top of
    // handleInitialState. Without it that read throws, adminCount falls to 0 and the
    // whole path short-circuits into the needsSetup payload — every ban assertion
    // below would then pass vacuously against a body that never reached the gate.
    // A THENABLE builder, so the head-count form (`.select(…, {head:true})` awaited
    // directly) and the `.maybeSingle()` form both resolve off the same object.
    const sb: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'eq', 'is', 'not', 'order', 'limit', 'maybeSingle']) sb[m] = () => sb;
    sb.then = (resolve: (v: unknown) => unknown) => resolve({ count: 1, data: { id: 4 }, error: null });
    return {
        getUserById: async () => h.user,
        findActiveBan: async () => { if (h.banThrows) throw new FakeBanCheckUnavailable(); return h.ban; },
        getBanNotice: async () => { if (h.banThrows) throw new FakeBanCheckUnavailable(); return h.notice; },
        getPlatformSettings: async () => ({}),
        getAllSettings: async () => ({ brandingConfig: { name: 'Org' }, discordConfig: {}, themeConfig: {} }),
        getState: async () => { h.getStateCalls++; return { users: [] }; },
        getMainState: async () => { h.mainStateCalls++; return { users: [] }; },
        isClientCaller: async () => false,
        isOptionalFeatureEnabled: async () => true,
        isSetupCompleted: async () => true,
        supabase: sb,
    };
});
vi.mock('../lib/auth', () => ({
    verifyToken: (t: string) => (t === 'good' ? { userId: 7, iat: 2_000_000 } : null),
    isSessionForceLoggedOut: () => false,
    isSessionRevokedByWatermark: () => false,
    signRealtimeToken: () => { h.realtimeTokens++; return 'rt'; },
}));

import handler from '../api/query';

/**
 * Strip // and /* *\/ comments, preserving length so every index stays aligned
 * with the original source. Ordering assertions here compare positions of CODE,
 * and the comments explaining these gates quote the identifiers being located —
 * without this, a test can match the sentence that describes the property instead
 * of the property.
 */
function codeOnly(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

// Same shape as the sibling read-path tests (tests/queryAuthGate.test.ts): the
// handler takes an express Response and a structurally-typed stub cannot satisfy
// it, so the stub is untyped here rather than cast at every call site.
function mockRes() {
    const res: any = { statusCode: 0, body: undefined, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: unknown) => { res.headers[k] = v; return res; };
    res.getHeader = () => undefined;
    return res;
}
const mockReq = (query: Record<string, unknown>): any => ({
    query, headers: { authorization: 'Bearer good' }, method: 'GET', socket: {},
});

beforeEach(() => {
    h.user = { id: 7, discordId: '123456789', role: 'Member', permissions: [], tokensValidFrom: null };
    h.ban = null;
    h.banThrows = false;
    h.notice = null;
    h.getStateCalls = 0;
    h.mainStateCalls = 0;
    h.realtimeTokens = 0;
});

describe('the READ path refuses a banned member', () => {
    it('403s a state subset with ORG_BANNED, and never reaches getState', async () => {
        h.ban = { id: 4, reason: 'Griefing', expiresAt: null, bannedAt: '2026-01-01T00:00:00Z' };
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('ORG_BANNED');
        expect(h.mainStateCalls, 'the gate must run BEFORE any org data is assembled').toBe(0);
    });

    it('refuses the realtime SLICE subsets too — the ones an open tab keeps calling', async () => {
        // A slice fetch is what an already-open tab uses to stay current. Gating the
        // bulk subsets and not these would leave a banned member watching the org
        // update in real time.
        h.ban = { id: 4, reason: 'x', expiresAt: null, bannedAt: '2026-01-01T00:00:00Z' };
        for (const subset of ['users_slice', 'operation_slice', 'warrant_slice']) {
            const res = mockRes();
            await handler(mockReq({ target: 'state', subset, ids: '1', id: '1' }), res);
            expect(res.statusCode, `${subset} was not refused`).toBe(403);
            expect(res.body.code).toBe('ORG_BANNED');
        }
    });

    it('a ban-check fault is a retryable 503, NOT a ban screen', async () => {
        h.banThrows = true;
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        expect(res.statusCode).toBe(503);
        expect(res.body.code).toBe('BAN_CHECK_UNAVAILABLE');
        expect(JSON.stringify(res.body)).not.toMatch(/banned|suspended/i);
    });

    // The negative control. Without it every assertion above would still pass if
    // the gate refused EVERYONE — a fail-closed gate that is also a full outage.
    it('lets an unbanned member straight through', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'state', subset: 'main' }), res);
        expect(res.statusCode).toBe(200);
        expect(h.mainStateCalls).toBe(1);
    });
});

describe('the BOOT payload withholds org state and carries the notice', () => {
    it('drops the session, skips getState AND skips the realtime token', async () => {
        // Nulling currentUser is the mechanism — not a separate branch. If that ever
        // regressed to "attach the notice and carry on", a banned member would boot
        // into the full bundle with a signed realtime token for the private channel.
        h.notice = { banId: 4, reason: 'Griefing', expiresAt: null, bannedAt: '2026-01-01T00:00:00Z', appealStatus: null, canAppeal: true };
        const res = mockRes();
        await handler(mockReq({ target: 'initial-state' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.banNotice).toMatchObject({ banId: 4, reason: 'Griefing' });
        expect(res.body.currentUser, 'the banned session must not boot into org state').toBeUndefined();
        expect(h.getStateCalls).toBe(0);
        expect(h.realtimeTokens, 'no private-channel token for a banned member').toBe(0);
    });

    it('a ban-check fault boots LOGGED OUT, with no notice — never an accusation', async () => {
        h.banThrows = true;
        const res = mockRes();
        await handler(mockReq({ target: 'initial-state' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.banNotice).toBeUndefined();
        expect(res.body.currentUser).toBeUndefined();
        expect(h.getStateCalls).toBe(0);
    });

    it('an unbanned member still gets the full boot bundle', async () => {
        const res = mockRes();
        await handler(mockReq({ target: 'initial-state' }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.banNotice).toBeUndefined();
        expect(h.getStateCalls).toBe(1);
        expect(h.realtimeTokens).toBe(1);
    });
});

describe('the LOGIN path — source contract', () => {
    const src = codeOnly(readFileSync(resolve(__dirname, '..', 'api', 'actions', 'auth.ts'), 'utf8'));
    // Anchored on the HANDLER, not the bare action name — the name also appears as
    // the audit `action:` field inside the helper above it.
    const callback = src.slice(src.indexOf("'auth:discord_callback': async"), src.indexOf("'auth:finalize_setup': async"));

    it('checks the ban ABOVE the admin-claim block, so a banned member cannot burn the setup code', () => {
        expect(callback.indexOf('loadOrgBanForLogin')).toBeGreaterThan(-1);
        expect(callback.indexOf('loadOrgBanForLogin')).toBeLessThan(callback.indexOf('validateClaimCode'));
    });

    it('checks the ban ABOVE findUserByDiscordId, so a banned+deleted member is not reactivated', () => {
        // deleteUser retains discord_id "for ban-evasion detection", and the login
        // path REACTIVATES a soft-deleted row. A ban check after that point would
        // un-delete the account of someone the org has locked out.
        expect(callback.indexOf('loadOrgBanForLogin')).toBeLessThan(callback.indexOf('findUserByDiscordId'));
        expect(callback.indexOf('loadOrgBanForLogin')).toBeLessThan(callback.indexOf('reactivateUser'));
    });

    it('the appeal session carries a token and NO user object', () => {
        const issue = src.slice(src.indexOf('async function issueBanAppealSession'), src.indexOf("export const authActions"));
        expect(issue).toMatch(/return \{ isNewUser: false, banned: true, banNotice: notice, token: signToken/);
        expect(issue, 'a user object here would be handed to a banned caller').not.toMatch(/\buser: (safeUser|user)\b/);
        // includeDeleted FALSE: a deleted member has no account to appeal as, and
        // reactivating one here would undo the deletion for someone locked out.
        expect(issue).toMatch(/findUserByDiscordId\(discordId, false\)/);
    });

    it('finalize_setup checks the ban AFTER the identity grant, or it is an existence oracle', () => {
        // payload.discordId is client-supplied and unverified until verifyIdentityGrant.
        // Checking a ban first would answer "is this Discord id banned from your org?"
        // for any id the caller types, on a PUBLIC action.
        const finalize = src.slice(src.indexOf("'auth:finalize_setup': async"), src.indexOf("'auth:redeem_setup_code': async"));
        const grant = finalize.indexOf('verifyIdentityGrant');
        const banCheck = finalize.indexOf('loadOrgBanForLogin');
        expect(grant).toBeGreaterThan(-1);
        expect(banCheck).toBeGreaterThan(-1);
        expect(banCheck).toBeGreaterThan(grant);
        // And it reads the VERIFIED id off the grant, not the raw payload.
        expect(finalize).toMatch(/loadOrgBanForLogin\(identity\.discordId\)/);
    });

    it('every login-path refusal is the SAME generic message', () => {
        const region = src.slice(src.indexOf('const BAN_LOGIN_REFUSED'), src.indexOf("'auth:redeem_setup_code': async"));
        const thrown = [...region.matchAll(/throw new Error\(([^)]+)\)/g)].map((m) => m[1].trim());
        const banRelated = thrown.filter((t) => t.includes('BAN_LOGIN_REFUSED'));
        expect(banRelated.length, 'the ban refusals should not be spelled out inline').toBeGreaterThanOrEqual(3);
        expect(new Set(banRelated).size).toBe(1);
    });
});

describe('the sibling routes carry the gate too', () => {
    it('api/orgUpload.ts gates BELOW its null-user guard', () => {
        const src = readFileSync(resolve(__dirname, '..', 'api', 'orgUpload.ts'), 'utf8');
        const nullGuard = src.indexOf(`if (!user) { res.status(401)`);
        const gate = src.indexOf('ORG BAN GATE');
        expect(nullGuard).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(-1);
        // Above the guard, `user.discordId` is a read off a possibly-null user — a 500
        // on every upload rather than a gate.
        expect(gate).toBeGreaterThan(nullGuard);
        const body = src.slice(gate, src.indexOf('MAINTENANCE MODE', gate));
        expect(body).toMatch(/await findActiveBan\(/);
        expect(body).toContain('503');
        expect(body).toMatch(/name !== 'BanCheckUnavailable'/);
    });

    it('server.ts import-stream gates ABOVE the admin check', () => {
        const src = readFileSync(resolve(__dirname, '..', 'server.ts'), 'utf8');
        const gate = src.indexOf('ORG BAN GATE');
        const adminGate = src.indexOf('user.isSystemAdmin !== true');
        expect(gate).toBeGreaterThan(-1);
        expect(adminGate).toBeGreaterThan(-1);
        // The import replaces `roles` wholesale; the refusal must not depend on role
        // state this route is about to rewrite.
        expect(gate).toBeLessThan(adminGate);
        const body = src.slice(gate, adminGate);
        expect(body).toMatch(/await findActiveBan\(/);
        expect(body).toContain('503');
    });

    it('the two ordering-invariant comments were AMENDED, not left to lie', () => {
        // Both files used to claim the client-tier denial was the highest-precedence
        // gate on their path. The ban gate now sits above it on both.
        const services = readFileSync(resolve(__dirname, '..', 'api', 'services.ts'), 'utf8');
        const query = readFileSync(resolve(__dirname, '..', 'api', 'query.ts'), 'utf8');
        expect(services).not.toContain('HIGHEST-PRECEDENCE GATE ON THIS PATH');
        expect(query).not.toMatch(/FIRST, above BOTH gates below/);
        // …and the replacement still asserts the ONE-invariant property, which is the
        // thing the original comment existed to protect.
        expect(services).toMatch(/ONE ordering invariant/);
        expect(query).toMatch(/ONE ordering invariant/);
    });
});

describe('the client is told, and told once', () => {
    const api = readFileSync(resolve(__dirname, '..', 'services', 'apiService.ts'), 'utf8');
    const session = codeOnly(readFileSync(resolve(__dirname, '..', 'contexts', 'SessionContext.tsx'), 'utf8'));

    it('ORG_BANNED is matched on the STATUS and the code, not on either alone', () => {
        // The code alone would let any handler that returned that string trip the
        // screen; 403 alone is an ordinary permission denial.
        expect(api).toMatch(/response\.status === 403 && code === 'ORG_BANNED'/);
    });

    it('the notifier is one-shot — a banned tab makes many failing calls', () => {
        const fn = api.slice(api.indexOf('private noteOrgBanned'), api.indexOf('private handleResponseError'));
        expect(fn).toMatch(/if \(this\.orgBannedNotified\) return;/);
    });

    it('SessionContext branches on banned BEFORE anything dereferences user', () => {
        // THE defect this file exists to prevent: the banned result has no `user`, so
        // the non-new-user branch (`user.role === 'Admin'`) throws before the banned
        // handling is ever reached — landing in the catch, setting a generic
        // "Authentication failed", and leaving the member no route to the appeal form.
        const cb = session.slice(session.indexOf('apiService.discordCallback(code'), session.indexOf('} catch (error: any)'));
        const banned = cb.indexOf('if (banned)');
        const isNew = cb.indexOf('if (isNewUser)');
        const deref = cb.indexOf('user.role');
        expect(banned).toBeGreaterThan(-1);
        expect(isNew).toBeGreaterThan(-1);
        expect(deref).toBeGreaterThan(-1);
        expect(banned).toBeLessThan(isNew);
        expect(banned).toBeLessThan(deref);
        // And it must RETURN, not fall through into the branch it just skipped.
        expect(cb.slice(banned, isNew)).toMatch(/\breturn;/);
    });

    it('refreshUser sets AND clears the notice, so a lifted ban is not sticky', () => {
        const fn = session.slice(session.indexOf('const refreshUser = useCallback'), session.indexOf('Ordering guard for currentUser'));
        // `?? null` rather than a truthiness guard: without the clear, a member whose
        // ban was lifted stays on the banned screen until they reload.
        expect(fn).toMatch(/setBanNotice\(data\.banNotice \?\? null\)/);
    });
});

describe('the ban is observed on READS, not only on mutations', () => {
    // The gap this pins. noteOrgBanned() used to be called from exactly one place —
    // inside rpc(), the MUTATION path. Every read helper (getStateSubset, getUserDetail,
    // getUsersSlice, …) routes its failures through handleResponseError, which handles
    // 401 and nothing else, so the 403 ORG_BANNED that api/query.ts returns was thrown
    // away as a generic fetch error.
    //
    // The member who loses by that is the one who is WATCHING rather than clicking: a
    // tactical board open, the activity heartbeat idle because it is gated on recent
    // interaction. banNotice stayed null, so BannedView never mounted and — the part
    // that matters — SessionContext never dropped the realtime auth, leaving an
    // already-joined broadcast channel streaming op-board element content and
    // system_broadcast text on a JWT minted before the ban. supabase-js does not
    // re-push access_token unless its VALUE changes and the realtime token runs 8 hours,
    // so nothing else was going to close that.
    const api = readFileSync(resolve(__dirname, '..', 'services', 'apiService.ts'), 'utf8');

    it('the check lives in trackedFetch, the one funnel every request goes through', () => {
        const fn = api.slice(api.indexOf('private async trackedFetch'), api.indexOf('* True once a request has been proven'));
        expect(fn.length, 'trackedFetch was renamed or restructured').toBeGreaterThan(100);
        expect(fn, 'a read 403 ORG_BANNED is being discarded again').toMatch(/ORG_BANNED/);
        expect(fn).toMatch(/this\.noteOrgBanned\(\)/);
        // clone(), or the caller downstream gets a consumed body.
        expect(fn, 'reading the body here without clone() breaks every 403 caller').toMatch(/response\.clone\(\)/);
    });

    it('exactly TWO bare fetch( calls exist, and both are deliberate', () => {
        // A read helper that calls fetch( directly silently opts out of the ban check,
        // the build-id check and the cookie-proof inference. Rather than ban the call
        // outright, this is an INVENTORY: two sites are deliberate and documented, and a
        // third fails here so adding one is a decision rather than an accident.
        //
        //   1. trackedFetch's own call — the funnel itself.
        //   2. scheduleCookieProbe — deliberately raw, with no Authorization header and
        //      no handleResponseError, because it exists to learn whether the COOKIE
        //      alone authenticates. Routing a probe 401 through the error handler would
        //      log the user out for failing an experiment.
        const code = codeOnly(api);
        const sites = [...code.matchAll(/(?<![.\w])fetch\(/g)].map((m) => code.slice(0, m.index).split('\n').length);
        expect(sites.length, `bare fetch( at lines ${sites.join(', ')} — a third site bypasses trackedFetch`).toBe(2);
        // And they are the two expected ones, not two new ones. Matched by the nearest
        // preceding method declaration rather than by parsing a signature — `private
        // async trackedFetch` and `private scheduleCookieProbe` do not share a shape.
        const owners = [...code.matchAll(/(?<![.\w])fetch\(/g)].map((m) => {
            const before = code.slice(0, m.index);
            const decl = [...before.matchAll(/private (?:async )?(\w+)\s*\(/g)].pop();
            return decl ? decl[1] : '(none)';
        });
        expect(owners.sort()).toEqual(['scheduleCookieProbe', 'trackedFetch']);
    });

    it('the realtime teardown is keyed on banNotice, which is what that 403 sets', () => {
        const session = codeOnly(readFileSync(resolve(__dirname, '..', 'contexts', 'SessionContext.tsx'), 'utf8'));
        const i = session.indexOf('registerRealtimeAuth(realtimeToken');
        expect(i).toBeGreaterThan(-1);
        expect(session.slice(session.lastIndexOf('useEffect', i), session.indexOf('}, [', i))).toContain('!banNotice');
    });
});
