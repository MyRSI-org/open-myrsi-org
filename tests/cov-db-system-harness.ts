// Shared harness for the lib/db/system.ts coverage suites (tests/cov-db-system-*.test.ts).
//
// Imports ONLY vitest: the suites' vi.mock factories load this module lazily (dynamic
// import inside the factory), so it must not pull an app module into the graph.
//
// The fake Supabase client RECORDS every query chain — table, every builder call and its
// arguments, and whether the chain was ever awaited — and resolves each awaited chain
// through a rule table. Tests assert the exact SQL shape (explicit column lists, filters,
// write payloads) against `db.queries`, never just "something was called".
import { vi } from 'vitest';

export type Op = [string, unknown[]];
export interface Q { table: string; ops: Op[]; awaited: boolean }
export interface Res { data?: unknown; error?: unknown; count?: number | null }
type ResOrFn = Res | ((q: Q) => Res);
interface Rule { table: string; res: ResOrFn; when?: (q: Q) => boolean; once: boolean; used: boolean }

const CHAIN_METHODS = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'is', 'in', 'not', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'or', 'filter', 'match', 'contains',
    'order', 'limit', 'range', 'single', 'maybeSingle',
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const snap = (v: unknown): unknown => { try { return structuredClone(v); } catch { return v; } };

export const db = {
    queries: [] as Q[],
    rules: [] as Rule[],
    rpcCalls: [] as Array<{ fn: string; args: unknown }>,
    rpcResults: [] as Res[],

    reset() {
        this.queries = [];
        this.rules = [];
        this.rpcCalls = [];
        this.rpcResults = [];
    },
    /** Persistent rule; the most recently registered matching rule wins. */
    on(table: string, res: ResOrFn, when?: (q: Q) => boolean) {
        this.rules.push({ table, res, when, once: false, used: false });
    },
    /** One-shot rule; one-shot rules are consumed FIFO and take priority over persistent ones. */
    once(table: string, res: ResOrFn, when?: (q: Q) => boolean) {
        this.rules.push({ table, res, when, once: true, used: false });
    },
    /** Every query against `table`, in issue order. */
    q(table: string): Q[] {
        return this.queries.filter((x) => x.table === table);
    },
    /** Queries against `table` whose chain contains op(...args) (args compared by JSON). */
    where(table: string, op: string, ...args: unknown[]): Q[] {
        return this.q(table).filter((x) => has(x, op, ...args));
    },
};

/** Does the chain contain a call op(...args)? Only the given leading args are compared. */
export function has(q: Q, op: string, ...args: unknown[]): boolean {
    return q.ops.some(([m, a]) => m === op && args.every((v, i) => same(a[i], v)));
}
/** The argument lists of every `op` call in the chain. */
export function args(q: Q, op: string): unknown[][] {
    return q.ops.filter(([m]) => m === op).map(([, a]) => a);
}
/** First argument of the first `op` call (e.g. the select column list or the write payload). */
export function arg0(q: Q, op: string): unknown {
    return args(q, op)[0]?.[0];
}

function resolveRule(q: Q): Res {
    for (const r of db.rules) {
        if (!r.once || r.used || r.table !== q.table) continue;
        if (r.when && !r.when(q)) continue;
        r.used = true;
        return typeof r.res === 'function' ? r.res(q) : r.res;
    }
    for (let i = db.rules.length - 1; i >= 0; i--) {
        const r = db.rules[i];
        if (r.once || r.table !== q.table) continue;
        if (r.when && !r.when(q)) continue;
        return typeof r.res === 'function' ? r.res(q) : r.res;
    }
    return { data: null, error: null };
}

export const fakeSupabase = {
    from(table: string) {
        const q: Q = { table, ops: [], awaited: false };
        db.queries.push(q);
        const chain: Record<string, unknown> = {};
        for (const m of CHAIN_METHODS) {
            // Snapshot the arguments: a caller that mutates its payload AFTER the call (the
            // migration-retry paths delete a key and re-send) must not rewrite history.
            chain[m] = (...a: unknown[]) => { q.ops.push([m, a.map(snap)]); return chain; };
        }
        chain.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => {
            q.awaited = true;
            let out: Res;
            try {
                out = resolveRule(q);
            } catch (e) {
                return Promise.reject(e).then(onOk, onErr);
            }
            // supabase-js always carries a count field (null unless one was requested).
            return Promise.resolve({ data: null, error: null, count: null, ...out }).then(onOk, onErr);
        };
        return chain;
    },
    rpc(fn: string, a: unknown) {
        db.rpcCalls.push({ fn, args: a });
        const out = db.rpcResults.shift() ?? { data: null, error: null };
        return Promise.resolve({ data: null, error: null, ...out });
    },
};

export const logSpy = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: () => logSpy,
};

const DEFAULT_ROLES = {
    client: { id: 1, name: 'Client' },
    member: { id: 2, name: 'Member' },
    dispatcher: { id: 3, name: 'Dispatcher' },
    admin: { id: 4, name: 'Admin' },
};

const SENSITIVE: Record<string, string[]> = {
    discordConfig: ['clientSecret', 'botToken'],
    radioConfig: ['apiKey', 'apiSecret'],
    aiConfig: ['apiKey'],
};
const mapFields = (key: string, cfg: unknown, fn: (v: string) => string) => {
    if (!cfg || typeof cfg !== 'object') return cfg;
    const out: Record<string, unknown> = { ...(cfg as Record<string, unknown>) };
    for (const f of SENSITIVE[key] ?? []) if (typeof out[f] === 'string' && out[f]) out[f] = fn(out[f] as string);
    return out;
};
const fakeEncrypt = (v: string) => `enc:${v}`;
const fakeDecrypt = (v: string) => (v.startsWith('enc:') ? v.slice(4) : v);

export const mocks = {
    handleSupabaseError: vi.fn(),
    safeFetch: vi.fn(),
    broadcastToOrg: vi.fn(),
    broadcastToChannel: vi.fn(),
    getSystemRoles: vi.fn(),
    cacheInvalidate: vi.fn(),
    sendPushToAll: vi.fn(),
    sendPushToStaff: vi.fn(),
    sendPushToPermission: vi.fn(),
    drainStaleOperationReminders: vi.fn(),
    liftBansOnSystemAdmins: vi.fn(),
    backfillOptionalModuleRoleDefaults: vi.fn(),
    assertRoleIsNotClient: vi.fn(),
    enforceClientRolePermissionLock: vi.fn(),
    encryptSecret: vi.fn(),
    decryptSecret: vi.fn(),
    encryptConfigSecrets: vi.fn(),
    decryptConfigSecrets: vi.fn(),
    hasPreviousKey: vi.fn(),
    inventorySecretCiphertexts: vi.fn(),
    recordSecurityEvent: vi.fn(),
    seedNewOrganization: vi.fn(),
    verifyFeaturedTestimonialIdsBelongToOrg: vi.fn(),
    sendDiscordChannelMessage: vi.fn(),
    buildMentionContent: vi.fn(),
};

/** Reset recorded state and restore every mock to its default behaviour. */
export function resetHarness() {
    db.reset();
    for (const fn of Object.values(mocks)) fn.mockReset();
    for (const fn of [logSpy.debug, logSpy.info, logSpy.warn, logSpy.error]) fn.mockReset();
    mocks.handleSupabaseError.mockImplementation(({ error, message }: { error: unknown; message: string }) => {
        if (error) throw new Error(message);
    });
    // Mirrors lib/db/common.ts: any error (or throw) resolves to the fallback.
    mocks.safeFetch.mockImplementation(async (query: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
        try {
            const { data, error } = await query;
            return error ? fallback : data;
        } catch {
            return fallback;
        }
    });
    mocks.broadcastToOrg.mockResolvedValue(undefined);
    mocks.broadcastToChannel.mockResolvedValue(undefined);
    mocks.getSystemRoles.mockResolvedValue(DEFAULT_ROLES);
    mocks.sendPushToAll.mockResolvedValue(undefined);
    mocks.sendPushToStaff.mockResolvedValue(undefined);
    mocks.sendPushToPermission.mockResolvedValue(undefined);
    mocks.drainStaleOperationReminders.mockResolvedValue(0);
    mocks.liftBansOnSystemAdmins.mockResolvedValue(0);
    mocks.backfillOptionalModuleRoleDefaults.mockResolvedValue({ status: 'already-applied', granted: 0 });
    mocks.assertRoleIsNotClient.mockResolvedValue(undefined);
    mocks.enforceClientRolePermissionLock.mockResolvedValue({ stripped: 0 });
    mocks.encryptSecret.mockImplementation(fakeEncrypt);
    mocks.decryptSecret.mockImplementation(fakeDecrypt);
    mocks.encryptConfigSecrets.mockImplementation((key: string, cfg: unknown) => mapFields(key, cfg, fakeEncrypt));
    mocks.decryptConfigSecrets.mockImplementation((key: string, cfg: unknown) => mapFields(key, cfg, fakeDecrypt));
    mocks.hasPreviousKey.mockReturnValue(false);
    mocks.inventorySecretCiphertexts.mockResolvedValue({ total: 0, underCurrent: 0, underPrevious: 0, undecryptable: 0, noKey: 0 });
    mocks.recordSecurityEvent.mockResolvedValue(undefined);
    mocks.seedNewOrganization.mockResolvedValue({ seeded: true });
    mocks.verifyFeaturedTestimonialIdsBelongToOrg.mockResolvedValue({ ok: true, invalidIds: [] });
    mocks.sendDiscordChannelMessage.mockResolvedValue(undefined);
    mocks.buildMentionContent.mockImplementation((ping: unknown) => ({ content: `mention:${JSON.stringify(ping)}` }));
}

// ── vi.mock factory bodies ────────────────────────────────────────────────
export const commonModule = () => ({
    supabase: fakeSupabase,
    handleSupabaseError: mocks.handleSupabaseError,
    safeFetch: mocks.safeFetch,
    broadcastToOrg: mocks.broadcastToOrg,
    broadcastToChannel: mocks.broadcastToChannel,
    getSystemRoles: mocks.getSystemRoles,
});
export const cacheModule = () => ({
    cache: { get: () => undefined, set: () => undefined, invalidate: mocks.cacheInvalidate, invalidatePrefix: () => undefined },
    TTL: {},
});
export const pushModule = () => ({
    sendPushToAll: mocks.sendPushToAll,
    sendPushToStaff: mocks.sendPushToStaff,
    sendPushToPermission: mocks.sendPushToPermission,
});
export const opRemindersModule = () => ({ drainStaleOperationReminders: mocks.drainStaleOperationReminders });
export const bansModule = () => ({ liftBansOnSystemAdmins: mocks.liftBansOnSystemAdmins });
export const roleDefaultsModule = () => ({ backfillOptionalModuleRoleDefaults: mocks.backfillOptionalModuleRoleDefaults });
export const clientRoleLockModule = () => ({
    assertRoleIsNotClient: mocks.assertRoleIsNotClient,
    enforceClientRolePermissionLock: mocks.enforceClientRolePermissionLock,
});
export const cryptoModule = () => ({
    encryptSecret: mocks.encryptSecret,
    decryptSecret: mocks.decryptSecret,
    encryptConfigSecrets: mocks.encryptConfigSecrets,
    decryptConfigSecrets: mocks.decryptConfigSecrets,
    hasPreviousKey: mocks.hasPreviousKey,
    SENSITIVE_FIELDS: SENSITIVE,
});
export const secretsRotationModule = () => ({ inventorySecretCiphertexts: mocks.inventorySecretCiphertexts });
export const securityEventsModule = () => ({ recordSecurityEvent: mocks.recordSecurityEvent });
export const seederModule = () => ({ seedNewOrganization: mocks.seedNewOrganization });
export const publicModule = () => ({ verifyFeaturedTestimonialIdsBelongToOrg: mocks.verifyFeaturedTestimonialIdsBelongToOrg });
export const discordModule = () => ({
    sendDiscordChannelMessage: mocks.sendDiscordChannelMessage,
    buildMentionContent: mocks.buildMentionContent,
});
export const logModule = () => ({
    log: logSpy,
    redactFields: (f: Record<string, unknown>) => f,
    refreshLogLevel: () => undefined,
});
