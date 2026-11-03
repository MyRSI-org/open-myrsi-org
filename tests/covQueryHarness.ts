// Shared, dependency-free harness for the api/query.ts coverage suites
// (tests/cov-query-boot.test.ts, tests/cov-query-state.test.ts).
//
// Imports ONLY vitest on purpose: the suites' vi.mock factories load this module
// lazily, and one of them mocks lib/log — anything here that imported an app module
// (lib/auth → lib/log) would turn that into an import cycle.
//
// Every lib/db export api/query.ts touches is a stable vi.fn so a test can assert
// exactly which producers ran, with which arguments — the "denied before any fetch"
// property is asserted by checking that NO producer outside the session/gate set
// was called.
import { vi, type Mock } from 'vitest';

export const DB_FN_NAMES = [
    // session / boot / gates
    'isSetupCompleted', 'getAllSettings', 'getPlatformSettings', 'getUserById', 'getBanNotice',
    'findActiveBan', 'isClientCaller', 'isOptionalFeatureEnabled', 'resolveIsSystemAdminFresh',
    // feed
    'verifyApiKey', 'getPublicFeedData',
    // state producers
    'getState', 'getMainState', 'getRequestsState', 'getUsersByIdsLite', 'isAnyStaffOnDuty',
    'getOperationByIdLite', 'listOperationTemplates', 'getRequestDetail', 'getAnnouncementsState',
    'getDiscordState', 'getOperationsState', 'getWarrantsState', 'getWarrantByIdHydrated',
    'getExternalToolsState', 'getHRState', 'isHrRecruiter', 'isHrStaff', 'redactApplicantsForViewer',
    'getHRApplications', 'redactInterviewsForViewer', 'getAllHRInterviews', 'redactTransfersForViewer',
    'getTransferRequests', 'getJobPostings', 'getHRInterviewTemplates', 'getPersonnelPositions',
    'getWikiPages', 'getWikiPageById', 'getUsersPresenceState', 'listWarehouseCatalog',
    'listWarehouseStock', 'listWithdrawalRequests', 'getMarketplaceState', 'browseMarketplaceListings',
    'getMyMarketplaceContracts', 'getUserNotificationState', 'getAcademyStaffState', 'getMyAcademyState',
    'getIntelState', 'getIntelTargetIndex', 'getIntelHubStats', 'getBulletinByIdForViewer',
    'getFleetState', 'getShipCatalog', 'getUserShips', 'getFleetGroups', 'getGovernmentState',
    'getGovernmentStructureState', 'getElectionsState', 'getLegislationState', 'getMotionsState',
] as const;
export type DbFnName = typeof DB_FN_NAMES[number];

export const dbFns = Object.fromEntries(DB_FN_NAMES.map((n) => [n, vi.fn()])) as unknown as Record<DbFnName, Mock>;

/** The gate/session calls a denied request is ALLOWED to make before it refuses. */
export const GATE_FNS: readonly DbFnName[] = [
    'getPlatformSettings', 'getUserById', 'findActiveBan', 'isClientCaller', 'isOptionalFeatureEnabled', 'resolveIsSystemAdminFresh',
];

/** Every db call made by the request, minus the gate set — empty means "nothing was fetched". */
export function producersCalled(): string[] {
    return DB_FN_NAMES.filter((n) => !GATE_FNS.includes(n) && dbFns[n].mock.calls.length > 0);
}

// ── Supabase query-builder stub ───────────────────────────────────────────
// Records the chain per query so tests can pin the SQL shape (e.g. pending /
// soft-deleted users never count as the bootstrap Admin), and resolves per table.
export interface SbQuery { table: string; calls: Array<[string, unknown[]]> }
export const sb = {
    tables: {} as Record<string, (q: SbQuery) => unknown>,
    queries: [] as SbQuery[],
};
export const supabaseStub = {
    from(table: string) {
        const q: SbQuery = { table, calls: [] };
        sb.queries.push(q);
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is', 'not', 'order', 'limit', 'in', 'maybeSingle']) {
            chain[m] = (...args: unknown[]) => { q.calls.push([m, args]); return chain; };
        }
        chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
            try {
                const handler = sb.tables[table];
                return resolve(handler ? handler(q) : { data: null, error: null });
            } catch (e) {
                return reject(e);
            }
        };
        return chain;
    },
};

/** signDocMediaForClient stand-in: marks the doc so a test can see it was signed. */
export const signDoc = vi.fn();
export const flags = { schemaOutdated: false };

/** Spy logger standing in for api/query.ts's `api.query` child logger. */
export const queryLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

export function resetHarness(): void {
    for (const n of DB_FN_NAMES) dbFns[n].mockReset();
    signDoc.mockReset();
    signDoc.mockImplementation(async (doc: unknown, opts?: { longLived?: boolean }) => ({ signed: true, longLived: opts?.longLived === true, doc }));
    for (const fn of Object.values(queryLog)) fn.mockReset();
    flags.schemaOutdated = false;
    sb.queries = [];
    sb.tables = {
        // An Admin system role exists and one live Admin holds it → "set up".
        roles: () => ({ data: { id: 4 }, error: null }),
        users: () => ({ count: 1, error: null }),
        settings: () => ({ data: [], error: null }),
    };
}

// ── req / res doubles ─────────────────────────────────────────────────────
export interface MockRes {
    statusCode: number;
    body: any;
    headers: Record<string, string | string[]>;
    status(c: number): MockRes;
    json(b: unknown): MockRes;
    setHeader(k: string, v: string | string[]): MockRes;
    append(k: string, v: string): MockRes;
}
export function mockRes(): MockRes {
    const res = { statusCode: 0, body: undefined, headers: {} } as MockRes;
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; return res; };
    res.append = (k, v) => {
        const prev = res.headers[k];
        res.headers[k] = prev === undefined ? v : [...(Array.isArray(prev) ? prev : [prev]), v];
        return res;
    };
    return res;
}
export function mockReq(query: Record<string, unknown>, opts: { bearer?: string; authorization?: string; cookie?: string; method?: string } = {}): any {
    const headers: Record<string, string> = {};
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (opts.authorization !== undefined) headers.authorization = opts.authorization;
    if (opts.cookie) headers.cookie = opts.cookie;
    return { method: opts.method ?? 'GET', query, headers };
}
