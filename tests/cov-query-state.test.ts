import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// api/query.ts — target=state, end to end through the router: the router's
// force-logout + maintenance enforcement, every handleState gate IN ORDER
// (session → watermark → org ban → client tier → permission → feature), and every
// subset in the switch, including the realtime *_slice subsets.
//
// Each producer test asserts three things: the subset routed to exactly ONE producer
// with the caller-scoped arguments, the response is that producer's output, and a
// secret-named field planted in the output was scrubbed (stripSecrets runs on every
// branch that reaches the shared return). Each denial asserts that nothing beyond the
// gate set was fetched (covQueryHarness producersCalled()).
//
// Real: lib/auth (HMAC tokens), lib/sessionCookie, lib/db/userFilters (roster/self
// strip), lib/clearance (wiki filtering), lib/rosterGate, lib/settingsProjection,
// lib/permissionImplications, lib/clientNamespaces. Doubles: the db layer, media
// signing, the schema-outdated flag and the logger.

vi.mock('../lib/db', async () => {
    const hh = await import('./covQueryHarness');
    return { supabase: hh.supabaseStub, ...hh.dbFns };
});
vi.mock('../lib/orgMediaDocs', async () => {
    const hh = await import('./covQueryHarness');
    return { signDocMediaForClient: (...a: unknown[]) => hh.signDoc(...a) };
});
vi.mock('../lib/db/system', async () => {
    const hh = await import('./covQueryHarness');
    return { isApiKeySchemaOutdated: () => hh.flags.schemaOutdated };
});
vi.mock('../lib/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/log')>();
    const hh = await import('./covQueryHarness');
    return {
        ...actual,
        log: { ...actual.log, child: (ctx: Record<string, unknown>) => (ctx.module === 'api.query' ? hh.queryLog : actual.log.child(ctx)) },
    };
});

import handler, { SUBSET_REQUIRED_PERMISSION, SUBSET_REQUIRED_FEATURE, emptyFeatureState } from '../api/query';
import { signToken } from '../lib/auth';
import { sessionCookieName, SESSION_COOKIE_IS_SECURE } from '../lib/sessionCookie';
import { CLIENT_DENIED_MESSAGE } from '../lib/clientNamespaces';
import { dbFns, flags, signDoc, queryLog, producersCalled, resetHarness, mockReq, mockRes, type DbFnName } from './covQueryHarness';

const COOKIE_NAME = sessionCookieName(SESSION_COOKIE_IS_SECURE);
const HOUR = 60 * 60 * 1000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

function tokenFor(userId: number, agoMs = 0): string {
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now - agoMs);
    try { return signToken({ userId }); } finally { spy.mockRestore(); }
}

// Every read permission the subset map names, plus a roster perm: a viewer who
// passes every SUBSET_REQUIRED_PERMISSION gate.
const ALL_VIEW = [...new Set(Object.values(SUBSET_REQUIRED_PERMISSION))];
const STAFF = {
    id: 6, name: 'Staff', role: 'Member', roleId: 2, discordId: 'd6', auth_user_id: 'auth-6',
    permissions: [...ALL_VIEW, 'user:view:roster'], adminNotes: 'note-6', personnelNotes: 'pn-6',
    clearanceLevel: { level: 1 }, limitingMarkers: [{ id: 'm1' }], isSystemAdmin: false, tokensValidFrom: null as string | null,
};
const MEMBER = {
    id: 8, name: 'Mem', role: 'Member', roleId: 2, discordId: 'd8', auth_user_id: 'auth-8',
    permissions: ['operations:view', 'wiki:view', 'user:view:roster'], adminNotes: 'note-8', personnelNotes: 'pn-8', isSystemAdmin: false,
};
const CLIENT = { id: 5, name: 'Cust', role: 'Client', roleId: 1, discordId: 'd5', auth_user_id: 'auth-5', permissions: ['request:create'], adminNotes: 'note-5', personnelNotes: 'pn-5', isSystemAdmin: false };
const OTHER = { id: 7, name: 'Other', role: 'Member', roleId: 2, discordId: 'd7', auth_user_id: 'auth-7', permissions: ['operations:view'], adminNotes: 'note-7', personnelNotes: 'pn-7' };
let users: Record<number, Record<string, unknown>>;

async function call(query: Record<string, unknown>, opts?: Parameters<typeof mockReq>[1]) {
    const res = mockRes();
    await handler(mockReq(query, opts), res as never);
    return res;
}
const state = (subset: unknown, userId: number | null = 6, extra: Record<string, unknown> = {}) =>
    call({ target: 'state', ...(subset !== undefined ? { subset } : {}), ...extra }, userId === null ? {} : { bearer: tokenFor(userId) });
const setCookieOf = (res: ReturnType<typeof mockRes>) => String(res.headers['Set-Cookie'] ?? '');
const userArg = (id: number) => expect.objectContaining({ id });

beforeEach(() => {
    resetHarness();
    users = { 5: { ...CLIENT }, 6: { ...STAFF }, 7: { ...OTHER }, 8: { ...MEMBER } };
    vi.stubEnv('DISCORD_CLIENT_ID', '');
    dbFns.getPlatformSettings.mockResolvedValue({});
    dbFns.getUserById.mockImplementation(async (id: number) => (users[id] ? { ...users[id] } : null));
    dbFns.findActiveBan.mockResolvedValue(null);
    dbFns.isClientCaller.mockResolvedValue(false);
    dbFns.isOptionalFeatureEnabled.mockResolvedValue(true);
    dbFns.resolveIsSystemAdminFresh.mockResolvedValue(false);
});
afterEach(() => { vi.unstubAllEnvs(); });

// ───────────────────────────── router enforcement ─────────────────────────────
describe('router enforcement on target=state', () => {
    it('force-logout: a token issued before the timestamp gets 401 + cleared cookie and never reaches handleState', async () => {
        dbFns.getPlatformSettings.mockResolvedValue({ force_logout_timestamp: isoAgo(30 * 60 * 1000) });
        const res = await call({ target: 'state', subset: 'notifications' }, { cookie: `${COOKIE_NAME}=${tokenFor(6, HOUR)}` });
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ message: 'Session expired. Please log in again.', force_logout: true });
        expect(setCookieOf(res)).toContain(`${COOKIE_NAME}=;`);
        expect(dbFns.getUserById).not.toHaveBeenCalled();
    });

    it('force-logout: a token issued afterwards is served', async () => {
        dbFns.getPlatformSettings.mockResolvedValue({ force_logout_timestamp: isoAgo(2 * HOUR) });
        dbFns.getUserNotificationState.mockResolvedValue({ notifications: [], unreadCount: 0 });
        const res = await call({ target: 'state', subset: 'notifications' }, { bearer: tokenFor(6, HOUR) });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ notifications: [], unreadCount: 0 });
    });

    it('force-logout: no token or a forged token passes the router but still dies at the auth gate', async () => {
        dbFns.getPlatformSettings.mockResolvedValue({ force_logout_timestamp: isoAgo(HOUR) });
        const forged = tokenFor(6).replace(/.$/, (c) => (c === '0' ? '1' : '0'));
        for (const opts of [{}, { bearer: forged }]) {
            const res = await call({ target: 'state', subset: 'notifications' }, opts);
            expect(res.statusCode).toBe(403);
            expect(res.body).toEqual({ message: 'Forbidden: Authentication required.' });
        }
        expect(dbFns.getUserById).not.toHaveBeenCalled();
    });

    const MAINT = { message: 'The organization dashboard is currently undergoing maintenance. Please try again later.' };

    it('maintenance: a non-admin is refused with 503 after a cache-free Admin re-check on the deny path', async () => {
        dbFns.getPlatformSettings.mockResolvedValue({ maintenance_mode: true });
        const res = await state('notifications', 6);
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual(MAINT);
        expect(dbFns.resolveIsSystemAdminFresh).toHaveBeenCalledWith(2);
        expect(dbFns.getUserNotificationState).not.toHaveBeenCalled();
    });

    it('maintenance: anonymous and forged-token callers are refused without a user lookup', async () => {
        dbFns.getPlatformSettings.mockResolvedValue({ maintenance_mode: true });
        for (const opts of [{}, { bearer: 'abc.def' }]) {
            const res = await call({ target: 'state', subset: 'main' }, opts);
            expect(res.statusCode).toBe(503);
            expect(res.body).toEqual(MAINT);
        }
        expect(dbFns.getUserById).not.toHaveBeenCalled();
    });

    it('maintenance: a deleted user (null row) is not an Admin, and the fresh re-check is skipped', async () => {
        dbFns.getPlatformSettings.mockResolvedValue({ maintenance_mode: true });
        users = {};
        const res = await state('notifications', 6);
        expect(res.statusCode).toBe(503);
        expect(dbFns.resolveIsSystemAdminFresh).not.toHaveBeenCalled();
    });

    it('maintenance: a user-read fault is treated as non-admin (fail closed), and logged', async () => {
        dbFns.getPlatformSettings.mockResolvedValue({ maintenance_mode: true });
        dbFns.getUserById.mockRejectedValue(new Error('read fault'));
        const res = await state('notifications', 6);
        expect(res.statusCode).toBe(503);
        expect(queryLog.warn).toHaveBeenCalledWith('maintenance admin check failed; treating as non-admin', expect.objectContaining({ err: expect.any(Error) }));
    });

    it('maintenance: the stamped system Admin passes without the fresh re-check', async () => {
        dbFns.getPlatformSettings.mockResolvedValue({ maintenance_mode: true });
        users[6].isSystemAdmin = true;
        dbFns.getUserNotificationState.mockResolvedValue({ notifications: [] });
        const res = await state('notifications', 6);
        expect(res.statusCode).toBe(200);
        expect(dbFns.resolveIsSystemAdminFresh).not.toHaveBeenCalled();
    });

    it('maintenance: an Admin whose stamp is stale passes on the fresh re-resolve', async () => {
        dbFns.getPlatformSettings.mockResolvedValue({ maintenance_mode: true });
        dbFns.resolveIsSystemAdminFresh.mockResolvedValue(true);
        dbFns.getUserNotificationState.mockResolvedValue({ notifications: [] });
        const res = await state('notifications', 6);
        expect(res.statusCode).toBe(200);
    });

    // The settings read drives both gates above and both refusals live inside its try; a
    // catch that only warned skipped both. Twin of the api/services.ts dispatcher.
    it('settings fault: a state read the gates would ALLOW is refused with the opaque maintenance 503, logged', async () => {
        dbFns.getPlatformSettings.mockRejectedValue(new Error('relation "settings" does not exist at 10.0.0.5'));
        dbFns.getUserNotificationState.mockResolvedValue({ notifications: [] });
        const res = await state('notifications', 6);
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual(MAINT);
        expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
        // Never reaches handleState.
        expect(dbFns.getUserById).not.toHaveBeenCalled();
        expect(producersCalled()).toEqual([]);
        expect(queryLog.error).toHaveBeenCalledWith('failed to check platform enforcement; refusing', expect.objectContaining({ target: 'state', err: expect.any(Error) }));
        expect(queryLog.warn).not.toHaveBeenCalledWith('failed to check platform enforcement', expect.anything());
    });

    it('settings fault: nobody is an Admin when the platform state is unreadable (stamped Admin refused too)', async () => {
        dbFns.getPlatformSettings.mockRejectedValue(new Error('read fault'));
        users[6].isSystemAdmin = true;
        const res = await state('notifications', 6);
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual(MAINT);
    });

    it('settings fault: a throw AFTER a successful read (in the Admin re-resolve) is refused the same way', async () => {
        // resolveIsSystemAdminFresh is contracted never to throw; if it ever did, the old
        // catch served the dashboard through an ACTIVE maintenance window.
        dbFns.getPlatformSettings.mockResolvedValue({ maintenance_mode: true });
        dbFns.resolveIsSystemAdminFresh.mockRejectedValue(new Error('role read failed'));
        dbFns.getUserNotificationState.mockResolvedValue({ notifications: [] });
        const res = await state('notifications', 6);
        expect(res.statusCode).toBe(503);
        expect(dbFns.getUserNotificationState).not.toHaveBeenCalled();
        expect(queryLog.error).toHaveBeenCalledWith('failed to check platform enforcement; refusing', expect.objectContaining({ target: 'state' }));
    });
});

// ───────────────────────────── handleState gates, in order ─────────────────────────────
describe('handleState gates', () => {
    it('no credential → 403 before any user lookup', async () => {
        const res = await state('main', null);
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ message: 'Forbidden: Authentication required.' });
        expect(dbFns.getUserById).not.toHaveBeenCalled();
        expect(producersCalled()).toEqual([]);
    });

    it('an expired token and a deleted user are both unauthenticated (403), nothing fetched', async () => {
        let res = await call({ target: 'state', subset: 'main' }, { bearer: tokenFor(6, 25 * HOUR) });
        expect(res.statusCode).toBe(403);
        expect(dbFns.getUserById).not.toHaveBeenCalled();
        users = {};
        res = await state('main', 6);
        expect(res.statusCode).toBe(403);
        expect(producersCalled()).toEqual([]);
    });

    it('a user-read fault fails closed to 403, not a 500 or a served subset', async () => {
        dbFns.getUserById.mockRejectedValue(new Error('read fault'));
        const res = await state('main', 6);
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ message: 'Forbidden: Authentication required.' });
        expect(producersCalled()).toEqual([]);
        expect(queryLog.warn).toHaveBeenCalledWith('failed to resolve user for subset fetch', expect.objectContaining({ err: expect.any(Error) }));
    });

    it('a session revoked by the tokens_valid_from watermark → 401 + cleared cookie, before the ban gate', async () => {
        users[6].tokensValidFrom = isoAgo(30 * 60 * 1000);
        const res = await call({ target: 'state', subset: 'main' }, { bearer: tokenFor(6, HOUR) });
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ message: 'Session expired. Please log in again.', force_logout: true });
        expect(setCookieOf(res)).toContain('Max-Age=0');
        expect(dbFns.findActiveBan).not.toHaveBeenCalled();
        expect(producersCalled()).toEqual([]);
    });

    it('an active org ban refuses every subset — realtime slices included — before any other gate', async () => {
        dbFns.findActiveBan.mockResolvedValue({ id: 'ban-1' });
        for (const [subset, extra] of [['main', {}], ['users_slice', { ids: '7' }], ['academy_my', {}]] as const) {
            const res = await state(subset, 6, extra);
            expect(res.statusCode).toBe(403);
            expect(res.body).toEqual({ code: 'ORG_BANNED', message: 'Your access to this organization has been suspended.' });
        }
        expect(dbFns.findActiveBan).toHaveBeenCalledWith({ userId: 6, discordId: 'd6' });
        expect(dbFns.isClientCaller).not.toHaveBeenCalled();
        expect(producersCalled()).toEqual([]);
        expect(queryLog.warn).toHaveBeenCalledWith('org ban denied a read', { userId: 6, subset: 'main', banId: 'ban-1' });
    });

    it('a ban-check outage is a retryable 503 (not a ban screen), and an expected outage is not logged as a bug', async () => {
        const outage = Object.assign(new Error('bans unavailable'), { name: 'BanCheckUnavailable' });
        dbFns.findActiveBan.mockRejectedValue(outage);
        const res = await state('main', 6);
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({ code: 'BAN_CHECK_UNAVAILABLE', message: 'Unable to verify account status. Please try again.' });
        expect(producersCalled()).toEqual([]);
        expect(queryLog.error).not.toHaveBeenCalled();
    });

    it('an UNEXPECTED ban-gate throw is still a 503, and is logged at error with the subset', async () => {
        dbFns.findActiveBan.mockRejectedValue(new TypeError('Cannot read properties of undefined'));
        const res = await state('hr', 6);
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({ code: 'BAN_CHECK_UNAVAILABLE', message: 'Unable to verify account status. Please try again.' });
        expect(queryLog.error).toHaveBeenCalledWith('ban gate failed unexpectedly on the read path', expect.objectContaining({ userId: 6, subset: 'hr' }));
    });

    it('client tier: academy_my is refused with the shared message, ahead of the feature gate', async () => {
        dbFns.isClientCaller.mockResolvedValue(true);
        dbFns.isOptionalFeatureEnabled.mockResolvedValue(false);
        const res = await state('academy_my', 5);
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ message: CLIENT_DENIED_MESSAGE });
        expect(dbFns.isClientCaller).toHaveBeenCalledWith(userArg(5));
        expect(dbFns.isOptionalFeatureEnabled).not.toHaveBeenCalled();
        expect(producersCalled()).toEqual([]);
    });

    it('client tier: a non-denied subset never consults the client predicate', async () => {
        dbFns.getUserNotificationState.mockResolvedValue({ notifications: [] });
        const res = await state('notifications', 5);
        expect(res.statusCode).toBe(200);
        expect(dbFns.isClientCaller).not.toHaveBeenCalled();
    });

    it.each([[['academy_my']], [{ evil: 'academy_my' }]])('a non-string subset (%j) collapses to the reject path — never served, never client-gated', async (subset) => {
        const res = await state(subset, 6);
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ message: 'Unknown subset' });
        expect(dbFns.isClientCaller).not.toHaveBeenCalled();
        expect(producersCalled()).toEqual([]);
    });

    it.each(Object.entries(SUBSET_REQUIRED_PERMISSION))('permission gate: %s requires %s — a caller without it gets 403 before any fetch', async (subset, perm) => {
        const res = await state(subset, 5, { id: '1', ids: '1' });
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ message: 'Insufficient permissions' });
        expect(dbFns.isOptionalFeatureEnabled).not.toHaveBeenCalled();
        expect(producersCalled()).toEqual([]);
        expect(queryLog.warn).toHaveBeenCalledWith('subset permission denied', { userId: 5, subset, requiredPerm: perm });
    });

    it('permission gate honours the implication table (intel:view:clearance satisfies intel:view)', async () => {
        users[5].permissions = ['intel:view:clearance'];
        dbFns.getIntelTargetIndex.mockResolvedValue([]);
        dbFns.getIntelHubStats.mockResolvedValue({ totalReports: 0 });
        const res = await state('intel_summary', 5);
        expect(res.statusCode).toBe(200);
    });

    it.each(['constructor', '__proto__', 'toString'])('a prototype-key subset (%s) is refused at the permission gate, never served', async (subset) => {
        const res = await state(subset, 6);
        expect(res.statusCode).toBe(403);
        expect(producersCalled()).toEqual([]);
    });

    const EMPTY: Record<string, Record<string, unknown>> = {
        academy: { academyCourses: [], academySessions: [] },
        academy_my: { academyCatalog: [], academyMyEnrollments: [] },
        marketplace: { marketplaceCategories: [], marketplaceListings: [], marketplaceContracts: [] },
        marketplace_listings: { marketplaceListings: [] },
        marketplace_contracts: { marketplaceContracts: [] },
        warehouse: { warehouseCatalog: [], warehouseStock: [], warehouseRequests: [] },
        warehouse_catalog: { warehouseCatalog: [] },
        warehouse_stock: { warehouseStock: [] },
        warehouse_requests: { warehouseRequests: [] },
        government: {
            governmentsConfig: { enabled: false }, governmentConfig: null, governmentBranches: [], governmentPositions: [],
            governmentPositionHolders: [], governmentElections: [], governmentLegislation: [], governmentMotions: [],
        },
        government_structure: { governmentsConfig: { enabled: false }, governmentConfig: null, governmentBranches: [], governmentPositions: [], governmentPositionHolders: [] },
        government_elections: { governmentElections: [] },
        government_legislation: { governmentLegislation: [] },
        government_motions: { governmentMotions: [] },
    };

    it('the empty-state table covers exactly the feature-gated subsets', () => {
        expect(Object.keys(EMPTY).sort()).toEqual(Object.keys(SUBSET_REQUIRED_FEATURE).sort());
    });

    it.each(Object.entries(SUBSET_REQUIRED_FEATURE))('feature gate: %s with module %s OFF → 200 with its EMPTY shape, no data fetched', async (subset, feature) => {
        dbFns.isOptionalFeatureEnabled.mockResolvedValue(false);
        const res = await state(subset, 6);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(EMPTY[subset]);
        expect(dbFns.isOptionalFeatureEnabled).toHaveBeenCalledWith(feature);
        expect(producersCalled()).toEqual([]);
    });

    it('emptyFeatureState: unknown subsets get {}, and every call returns fresh objects (no shared mutable state)', () => {
        expect(emptyFeatureState('wiki')).toEqual({});
        const a = emptyFeatureState('government');
        (a.governmentBranches as unknown[]).push('leak');
        (a.governmentsConfig as Record<string, unknown>).enabled = true;
        expect(emptyFeatureState('government')).toEqual(EMPTY.government);
    });

    it('rejects a removed or unknown subset with 400 instead of widening to the full aggregate', async () => {
        for (const subset of ['settings', 'alliances', 'nope']) {
            const res = await state(subset, 6);
            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ message: 'Unknown subset' });
        }
        expect(producersCalled()).toEqual([]);
    });

    it('a producer fault is an opaque 500 — the error is logged with the subset, never echoed', async () => {
        dbFns.getOperationsState.mockRejectedValue(new Error('duplicate key value violates unique constraint "ops_pkey"'));
        const res = await state('operations', 6);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ message: 'Database Error' });
        expect(queryLog.error).toHaveBeenCalledWith('failed to fetch subset', expect.objectContaining({ subset: 'operations', err: expect.any(Error) }));
    });
});

// ───────────────────────────── simple producers ─────────────────────────────
// [subset, producer, expected-args(viewer), output shape]. `wrap` names the response
// key an array producer is wrapped in; absent = the producer returns the state object.
type Row = { subset: string; fn: DbFnName; args: (u: { id: number }) => unknown[]; wrap?: string | [string, string] };
const SIMPLE: Row[] = [
    { subset: 'requests', fn: 'getRequestsState', args: (u) => [userArg(u.id)] },
    { subset: 'operation_templates', fn: 'listOperationTemplates', args: (u) => [userArg(u.id)], wrap: 'operationTemplates' },
    { subset: 'announcements', fn: 'getAnnouncementsState', args: (u) => [userArg(u.id)] },
    { subset: 'operations', fn: 'getOperationsState', args: (u) => [userArg(u.id)] },
    { subset: 'warrants', fn: 'getWarrantsState', args: () => [] },
    { subset: 'external_tools', fn: 'getExternalToolsState', args: (u) => [userArg(u.id)] },
    { subset: 'hr', fn: 'getHRState', args: (u) => [userArg(u.id)] },
    { subset: 'hr_jobs', fn: 'getJobPostings', args: () => [], wrap: ['hr', 'jobs'] },
    { subset: 'hr_templates', fn: 'getHRInterviewTemplates', args: () => [], wrap: ['hr', 'templates'] },
    { subset: 'hr_positions', fn: 'getPersonnelPositions', args: () => [], wrap: ['hr', 'positions'] },
    { subset: 'warehouse_catalog', fn: 'listWarehouseCatalog', args: () => [], wrap: 'warehouseCatalog' },
    { subset: 'warehouse_stock', fn: 'listWarehouseStock', args: () => [], wrap: 'warehouseStock' },
    { subset: 'warehouse_requests', fn: 'listWithdrawalRequests', args: () => [{ status: 'open' }], wrap: 'warehouseRequests' },
    // Marketplace / notifications / academy_my are scoped by the CALLER'S id.
    { subset: 'marketplace', fn: 'getMarketplaceState', args: (u) => [u.id] },
    { subset: 'marketplace_listings', fn: 'browseMarketplaceListings', args: () => [{}], wrap: 'marketplaceListings' },
    { subset: 'marketplace_contracts', fn: 'getMyMarketplaceContracts', args: (u) => [u.id], wrap: 'marketplaceContracts' },
    { subset: 'notifications', fn: 'getUserNotificationState', args: (u) => [u.id] },
    { subset: 'academy', fn: 'getAcademyStaffState', args: () => [] },
    { subset: 'academy_my', fn: 'getMyAcademyState', args: (u) => [u.id] },
    { subset: 'intel', fn: 'getIntelState', args: (u) => [userArg(u.id)] },
    { subset: 'fleet', fn: 'getFleetState', args: () => [] },
    { subset: 'fleet_catalog', fn: 'getShipCatalog', args: () => [], wrap: 'shipCatalog' },
    { subset: 'fleet_user_ships', fn: 'getUserShips', args: () => [], wrap: 'userShips' },
    { subset: 'fleet_groups', fn: 'getFleetGroups', args: () => [], wrap: 'fleetGroups' },
    { subset: 'government', fn: 'getGovernmentState', args: () => [] },
    { subset: 'government_structure', fn: 'getGovernmentStructureState', args: () => [] },
    { subset: 'government_elections', fn: 'getElectionsState', args: () => [], wrap: 'governmentElections' },
    { subset: 'government_legislation', fn: 'getLegislationState', args: () => [], wrap: 'governmentLegislation' },
    { subset: 'government_motions', fn: 'getMotionsState', args: () => [], wrap: 'governmentMotions' },
];

describe('subset routing — one producer, caller-scoped, secrets scrubbed', () => {
    it.each(SIMPLE.map((r) => [r.subset, r] as const))('%s', async (_s, row) => {
        const rows = [{ id: 'x1', label: 'visible', row_secret: 'MUST-NOT-SHIP' }];
        const clean = [{ id: 'x1', label: 'visible' }];
        if (row.wrap) {
            dbFns[row.fn].mockResolvedValue(rows);
        } else {
            dbFns[row.fn].mockResolvedValue({ items: rows, top_api_key: 'MUST-NOT-SHIP' });
        }
        const res = await state(row.subset, 6);
        expect(res.statusCode).toBe(200);
        const expected = !row.wrap ? { items: clean }
            : typeof row.wrap === 'string' ? { [row.wrap]: clean }
                : { [row.wrap[0]]: { [row.wrap[1]]: clean } };
        expect(res.body).toEqual(expected);
        expect(producersCalled()).toEqual([row.fn]);
        expect(dbFns[row.fn]).toHaveBeenCalledTimes(1);
        expect(dbFns[row.fn]).toHaveBeenCalledWith(...row.args({ id: 6 }));
        // A subset that never loaded discordConfig must not grow one (the
        // clobber-the-real-config race).
        expect('discordConfig' in res.body).toBe(false);
    });

    it.each(['getElectionsState', 'getLegislationState', 'getMotionsState'] as const)('a failing %s degrades to an empty list at 200, not a 500', async (fn) => {
        const subset = { getElectionsState: 'government_elections', getLegislationState: 'government_legislation', getMotionsState: 'government_motions' }[fn];
        const key = { getElectionsState: 'governmentElections', getLegislationState: 'governmentLegislation', getMotionsState: 'governmentMotions' }[fn];
        dbFns[fn].mockRejectedValue(new Error('vote tally view missing'));
        const res = await state(subset, 6);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ [key]: [] });
    });

    it('warehouse bundle: all three lists, open withdrawal requests only', async () => {
        dbFns.listWarehouseCatalog.mockResolvedValue([{ id: 'c' }]);
        dbFns.listWarehouseStock.mockResolvedValue([{ id: 's' }]);
        dbFns.listWithdrawalRequests.mockResolvedValue([{ id: 'r' }]);
        const res = await state('warehouse', 6);
        expect(res.body).toEqual({ warehouseCatalog: [{ id: 'c' }], warehouseStock: [{ id: 's' }], warehouseRequests: [{ id: 'r' }] });
        expect(dbFns.listWithdrawalRequests).toHaveBeenCalledWith({ status: 'open' });
    });

    it('intel_summary: both aggregates are computed for THIS viewer (clearance ceiling)', async () => {
        dbFns.getIntelTargetIndex.mockResolvedValue([{ target: 't' }]);
        dbFns.getIntelHubStats.mockResolvedValue({ totalReports: 3 });
        const res = await state('intel_summary', 6);
        expect(res.body).toEqual({ intelTargetIndex: [{ target: 't' }], intelHubStats: { totalReports: 3 } });
        expect(dbFns.getIntelTargetIndex).toHaveBeenCalledWith(userArg(6));
        expect(dbFns.getIntelHubStats).toHaveBeenCalledWith(userArg(6));
    });
});

// ───────────────────────────── single-row slices ─────────────────────────────
describe('id-addressed slices', () => {
    it.each(['operation_slice', 'warrant_slice', 'bulletin_slice', 'wiki_page_slice'])('%s: a missing or non-string id is a 400 before any fetch', async (subset) => {
        for (const extra of [{}, { id: ['a', 'b'] }, { id: '' }]) {
            const res = await state(subset, 6, extra);
            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ message: 'Missing id parameter' });
        }
        expect(producersCalled()).toEqual([]);
    });

    it.each([
        ['operation_slice', 'getOperationByIdLite', 'operation', true],
        ['warrant_slice', 'getWarrantByIdHydrated', 'warrant', false],
        ['bulletin_slice', 'getBulletinByIdForViewer', 'bulletin', true],
    ] as const)('%s: returns the viewer-filtered row, and null passes through (the client removes the row)', async (subset, fn, key, viewerScoped) => {
        dbFns[fn].mockResolvedValueOnce({ id: 'row-1', private_token: 'MUST-NOT-SHIP' });
        let res = await state(subset, 6, { id: 'row-1' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ [key]: { id: 'row-1' } });
        if (viewerScoped) expect(dbFns[fn]).toHaveBeenCalledWith('row-1', userArg(6));
        else expect(dbFns[fn]).toHaveBeenCalledWith('row-1');
        dbFns[fn].mockResolvedValueOnce(null);
        res = await state(subset, 6, { id: 'row-1' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ [key]: null });
    });

    it('request_detail: 400 without an id, an indistinguishable 404 when absent OR not visible, the row when visible', async () => {
        let res = await state('request_detail', 6);
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ message: 'Missing id parameter' });
        dbFns.getRequestDetail.mockResolvedValueOnce(null);
        res = await state('request_detail', 6, { id: 'req-1' });
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ message: 'Request not found' });
        dbFns.getRequestDetail.mockResolvedValueOnce({ id: 'req-1', status: 'open' });
        res = await state('request_detail', 6, { id: 'req-1' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ id: 'req-1', status: 'open' });
        expect(dbFns.getRequestDetail).toHaveBeenLastCalledWith('req-1', userArg(6));
    });
});

// ───────────────────────────── roster surfaces ─────────────────────────────
describe('roster surfaces (users_slice / user_detail / users_presence)', () => {
    it('users_slice: id validation runs BEFORE the capability gate (a client bug is never masked as a 403)', async () => {
        const cases: Array<[Record<string, unknown>, string]> = [
            [{}, 'Missing ids parameter'],
            [{ ids: { a: '1' } }, 'Missing ids parameter'],
            [{ ids: '1,abc' }, 'Invalid ids parameter'],
            [{ ids: '' }, 'Invalid ids parameter'],
            [{ ids: '-1' }, 'Invalid ids parameter'],
            [{ ids: Array.from({ length: 101 }, (_, i) => String(i + 1)).join(',') }, 'Too many ids (max 100)'],
        ];
        for (const [extra, message] of cases) {
            const res = await state('users_slice', 5, extra);
            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ message });
        }
        expect(producersCalled()).toEqual([]);
    });

    it('users_slice: a non-roster viewer gets 403 and nothing is fetched', async () => {
        const res = await state('users_slice', 5, { ids: '6,7' });
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ message: 'Insufficient permissions' });
        expect(producersCalled()).toEqual([]);
        expect(queryLog.warn).toHaveBeenCalledWith('users_slice denied', { userId: 5, requested: 2 });
    });

    it('users_slice: normalises both query forms, de-duplicates BEFORE the 100 cap, and strips each row for the viewer', async () => {
        dbFns.getUsersByIdsLite.mockResolvedValue([{ ...OTHER }]);
        dbFns.isAnyStaffOnDuty.mockResolvedValue(true);
        const res = await state('users_slice', 6, { ids: ['7', ' 9 ,7', ...Array.from({ length: 120 }, () => '9')] });
        expect(res.statusCode).toBe(200);
        expect(dbFns.getUsersByIdsLite).toHaveBeenCalledWith([7, 9]);
        expect(res.body.anyStaffOnDuty).toBe(true);
        expect(res.body.users).toHaveLength(1);
        expect(res.body.users[0]).toMatchObject({ id: 7, name: 'Other' });
        expect(res.body.users[0].adminNotes).toBeUndefined();
        expect(res.body.users[0].personnelNotes).toBeUndefined();
        expect(res.body.users[0].auth_user_id).toBeUndefined();
    });

    it('user_detail: 400 on a missing or non-numeric id', async () => {
        let res = await state('user_detail', 6);
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ message: 'Missing id parameter' });
        res = await state('user_detail', 6, { id: 'abc' });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ message: 'Invalid id parameter' });
    });

    it('user_detail: a non-roster caller may read ONLY themselves — cross-user is a 403 with no target fetch', async () => {
        const res = await state('user_detail', 5, { id: '7' });
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ message: 'Insufficient permissions' });
        expect(dbFns.getUserById).toHaveBeenCalledTimes(1); // the session resolve only
        expect(queryLog.warn).toHaveBeenCalledWith('user_detail cross-user denied', { userId: 5, targetId: 7 });
    });

    it('user_detail: self is always allowed (identity path), with admin-only notes still removed', async () => {
        const res = await state('user_detail', 5, { id: '5' });
        expect(res.statusCode).toBe(200);
        expect(res.body.id).toBe(5);
        expect(res.body.personnelNotes).toBe('pn-5');
        expect(res.body.permissions).toEqual(['request:create']);
        expect(res.body.adminNotes).toBeUndefined();
        expect(res.body.isSystemAdmin).toBeUndefined();
    });

    it('user_detail: a self record with no permissions array still strips (requester falls back to [])', async () => {
        delete users[5].permissions;
        const res = await state('user_detail', 5, { id: '5' });
        expect(res.statusCode).toBe(200);
        expect(res.body.adminNotes).toBeUndefined();
        expect(res.body.personnelNotes).toBe('pn-5');
    });

    it('user_detail: a roster viewer sees another member only through the allow-list; admin notes need admin:user:update', async () => {
        let res = await state('user_detail', 6, { id: '7' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ id: 7, name: 'Other' });
        expect(res.body.adminNotes).toBeUndefined();
        expect(res.body.personnelNotes).toBeUndefined();
        expect(res.body.auth_user_id).toBeUndefined();
        expect(res.body.permissions).toEqual([]);
        users[6].permissions = [...STAFF.permissions, 'admin:user:update'];
        res = await state('user_detail', 6, { id: '7' });
        expect(res.body.adminNotes).toBe('note-7');
    });

    it('user_detail: an unknown id is a 404', async () => {
        const res = await state('user_detail', 6, { id: '999' });
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ message: 'User not found' });
    });

    it('users_presence: 200 for every tier, but the presence LIST only for a roster viewer', async () => {
        dbFns.getUsersPresenceState.mockResolvedValue({ usersPresence: [{ userId: 7, isDuty: true, lastActiveAt: null }] });
        dbFns.isAnyStaffOnDuty.mockResolvedValue(true);
        let res = await state('users_presence', 6);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ usersPresence: [{ userId: 7, isDuty: true, lastActiveAt: null }], anyStaffOnDuty: true });

        dbFns.getUsersPresenceState.mockClear();
        res = await state('users_presence', 5);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ usersPresence: [], anyStaffOnDuty: true });
        expect(dbFns.getUsersPresenceState).not.toHaveBeenCalled();
    });
});

// ───────────────────────────── HR redaction slices ─────────────────────────────
describe('HR per-array slices route rows through the viewer redaction', () => {
    it('hr_applicants: redacted with the viewer\'s recruiter flag — raw rows never ship', async () => {
        const raw = [{ id: 'a1', vettingData: 'PII' }];
        dbFns.getHRApplications.mockResolvedValue(raw);
        dbFns.isHrRecruiter.mockReturnValue(false);
        dbFns.redactApplicantsForViewer.mockReturnValue([{ id: 'a1' }]);
        const res = await state('hr_applicants', 6);
        expect(res.body).toEqual({ hr: { applicants: [{ id: 'a1' }] } });
        expect(dbFns.isHrRecruiter).toHaveBeenCalledWith(userArg(6));
        expect(dbFns.redactApplicantsForViewer).toHaveBeenCalledWith(raw, false);
    });

    it('hr_interviews: redacted with the viewer\'s recruiter flag', async () => {
        const raw = [{ id: 'i1', notes: 'private' }];
        dbFns.getAllHRInterviews.mockResolvedValue(raw);
        dbFns.isHrRecruiter.mockReturnValue(true);
        dbFns.redactInterviewsForViewer.mockReturnValue([{ id: 'i1', notes: 'private' }]);
        const res = await state('hr_interviews', 6);
        expect(res.body).toEqual({ hr: { interviews: [{ id: 'i1', notes: 'private' }] } });
        expect(dbFns.redactInterviewsForViewer).toHaveBeenCalledWith(raw, true);
    });

    it('hr_transfers: redacted on the WIDER staff predicate, scoped to the viewer\'s id', async () => {
        const raw = [{ id: 't1', userId: 7 }, { id: 't2', userId: 6 }];
        dbFns.getTransferRequests.mockResolvedValue(raw);
        dbFns.isHrStaff.mockReturnValue(false);
        dbFns.redactTransfersForViewer.mockReturnValue([{ id: 't2', userId: 6 }]);
        const res = await state('hr_transfers', 6);
        expect(res.body).toEqual({ hr: { transfers: [{ id: 't2', userId: 6 }] } });
        expect(dbFns.isHrStaff).toHaveBeenCalledWith(userArg(6));
        expect(dbFns.redactTransfersForViewer).toHaveBeenCalledWith(raw, false, 6);
    });
});

// ───────────────────────────── wiki (clearance + media signing) ─────────────────────────────
describe('wiki clearance filtering and media signing', () => {
    const doc = (n: string) => ({ type: 'doc', n });
    const PAGES = () => [
        { id: 'p1', classificationLevel: 0, limitingMarkers: [], content: doc('p1') },
        { id: 'p2', classificationLevel: 3, limitingMarkers: [], content: doc('p2') },
        { id: 'p3', classificationLevel: 0, limitingMarkers: [{ id: 'm2' }], content: doc('p3') },
        { id: 'p4', classificationLevel: 1, limitingMarkers: [{ id: 'm1' }] },
    ];

    it('wiki: above-clearance and missing-marker pages never ship; visible bodies are signed with the SHORT TTL', async () => {
        dbFns.getWikiPages.mockResolvedValue(PAGES());
        const res = await state('wiki', 6);
        expect(res.statusCode).toBe(200);
        expect(res.body.wikiPages.map((p: { id: string }) => p.id)).toEqual(['p1', 'p4']);
        expect(signDoc).toHaveBeenCalledTimes(1);
        expect(signDoc).toHaveBeenCalledWith(doc('p1'));
        expect(res.body.wikiPages[0].content).toEqual({ signed: true, longLived: false, doc: doc('p1') });
        expect(JSON.stringify(res.body)).not.toContain('"p2"');
    });

    it('wiki: the system Admin (role identity) sees every classification', async () => {
        users[6].isSystemAdmin = true;
        dbFns.getWikiPages.mockResolvedValue(PAGES());
        const res = await state('wiki', 6);
        expect(res.body.wikiPages.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    });

    it('wiki_page_slice: an above-clearance page comes back null and is never signed', async () => {
        dbFns.getWikiPageById.mockResolvedValue(PAGES()[1]);
        const res = await state('wiki_page_slice', 6, { id: 'p2' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ wikiPage: null });
        expect(signDoc).not.toHaveBeenCalled();
        expect(dbFns.getWikiPageById).toHaveBeenCalledWith('p2');
    });

    it('wiki_page_slice: a visible page is signed (short TTL); a contentless one and an absent one are not', async () => {
        dbFns.getWikiPageById.mockResolvedValueOnce(PAGES()[0]);
        let res = await state('wiki_page_slice', 6, { id: 'p1' });
        expect(res.body.wikiPage.content).toEqual({ signed: true, longLived: false, doc: doc('p1') });
        expect(signDoc).toHaveBeenCalledWith(doc('p1'));

        signDoc.mockClear();
        dbFns.getWikiPageById.mockResolvedValueOnce(PAGES()[3]);
        res = await state('wiki_page_slice', 6, { id: 'p4' });
        expect(res.body.wikiPage.id).toBe('p4');
        dbFns.getWikiPageById.mockResolvedValueOnce(null);
        res = await state('wiki_page_slice', 6, { id: 'gone' });
        expect(res.body).toEqual({ wikiPage: null });
        expect(signDoc).not.toHaveBeenCalled();
    });
});

// ───────────────────────────── main / discord / full state ─────────────────────────────
describe('main bundle, discord and the no-subset full state', () => {
    beforeEach(() => {
        dbFns.getMainState.mockImplementation(async () => ({ users: [{ ...MEMBER }, { ...OTHER }], serviceTypes: [{ id: 'st1' }] }));
        dbFns.getAllSettings.mockResolvedValue({
            brandingConfig: { name: 'Acme' },
            discordConfig: { clientId: 'db-client-id', botToken: 'BOT-TOKEN-SECRET', clientSecret: 'CS' },
            wikiHomeConfig: { welcomeContent: { type: 'doc' } },
            hrConfig: { probationDays: 30 },
            admin_setup_code: { code: 'SETUP-DEADBEEF' },
            intelSharingConfig: { maxShareableClearance: 3 },
            importedUnknownSetting: { anything: true },
        });
    });

    it('main: roster stripped, settings PROJECTED for this viewer, wiki home signed long-lived, secrets gone', async () => {
        const res = await state('main', 8);
        expect(res.statusCode).toBe(200);
        expect(dbFns.getMainState).toHaveBeenCalledWith(userArg(8));
        expect(dbFns.getAllSettings).toHaveBeenCalledWith({ decryptSecrets: false });
        expect(res.body.serviceTypes).toEqual([{ id: 'st1' }]);
        const other = res.body.users.find((u: { id: number }) => u.id === 7);
        expect(other.adminNotes).toBeUndefined();
        expect(other.auth_user_id).toBeUndefined();
        // Projection: hr:view-gated key withheld, unknown key dropped, wiki key kept for wiki:view.
        expect(res.body.hrConfig).toBeUndefined();
        expect(res.body.importedUnknownSetting).toBeUndefined();
        expect(res.body.admin_setup_code).toBeUndefined();
        expect(res.body.intelSharingConfig).toBeUndefined();
        expect(signDoc).toHaveBeenCalledWith({ type: 'doc' }, { longLived: true });
        expect(res.body.wikiHomeConfig.welcomeContent).toEqual({ signed: true, longLived: true, doc: { type: 'doc' } });
        expect(res.body.discordConfig.clientId).toBe('db-client-id');
        expect(res.body.discordConfig.botToken).toBeUndefined();
        expect(res.body.discordConfig.clientSecret).toBeUndefined();
        expect(res.body.schemaUpdateRequired).toBeUndefined();
    });

    it('main: without wiki:view the wiki home key is absent and nothing is signed', async () => {
        users[8].permissions = ['operations:view'];
        const res = await state('main', 8);
        expect(res.body.wikiHomeConfig).toBeUndefined();
        expect(signDoc).not.toHaveBeenCalled();
    });

    it('main: the schema-outdated operator alarm reaches ONLY an admin:db:destroy holder, and only when set', async () => {
        flags.schemaOutdated = true;
        let res = await state('main', 8);
        expect(res.body.schemaUpdateRequired).toBeUndefined();

        users[8].permissions = [...MEMBER.permissions, 'admin:db:destroy'];
        res = await state('main', 8);
        expect(res.body.schemaUpdateRequired).toBe(true);

        flags.schemaOutdated = false;
        res = await state('main', 8);
        expect(res.body.schemaUpdateRequired).toBeUndefined();
    });

    it('main: DISCORD_CLIENT_ID wins over the stored client id', async () => {
        vi.stubEnv('DISCORD_CLIENT_ID', 'env-client-id');
        const res = await state('main', 8);
        expect(res.body.discordConfig.clientId).toBe('env-client-id');
    });

    it('discord: admin console state with the client id decorated and every credential stripped', async () => {
        dbFns.getDiscordState.mockResolvedValue({
            discordConfig: { clientId: 'db-client-id', botToken: 'BOT', clientSecret: 'CS', eamChannelId: '222222222222222222' },
            discordRoleMappings: [{ roleId: 1, discordRoleId: '333' }],
        });
        const res = await state('discord', 6);
        expect(res.statusCode).toBe(200);
        expect(dbFns.getDiscordState).toHaveBeenCalledWith();
        expect(res.body.discordRoleMappings).toEqual([{ roleId: 1, discordRoleId: '333' }]);
        expect(res.body.discordConfig).toEqual(expect.objectContaining({ clientId: 'db-client-id', eamChannelId: '222222222222222222' }));
        expect(res.body.discordConfig.botToken).toBeUndefined();
        expect(res.body.discordConfig.clientSecret).toBeUndefined();
    });

    it.each([[undefined], ['']])('no subset (%j) → the permission-gated full state, roster stripped, discord decorated', async (subset) => {
        dbFns.getState.mockResolvedValue({ users: [{ ...STAFF }, { ...OTHER }], discordConfig: { clientId: 'db', botToken: 'BOT' }, geminiKey: 'g' });
        const res = await state(subset, 6);
        expect(res.statusCode).toBe(200);
        expect(dbFns.getState).toHaveBeenCalledWith(userArg(6));
        expect(producersCalled()).toEqual(['getState']);
        const other = res.body.users.find((u: { id: number }) => u.id === 7);
        expect(other.adminNotes).toBeUndefined();
        expect(other.personnelNotes).toBeUndefined();
        expect(res.body.discordConfig.clientId).toBe('db');
        expect(res.body.discordConfig.botToken).toBeUndefined();
        expect(res.body.geminiKey).toBeUndefined();
    });
});
