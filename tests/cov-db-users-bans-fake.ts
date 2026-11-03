// Shared, dependency-free Supabase double for the users-bans coverage suites
// (tests/cov-db-users-bans-*.test.ts): lib/db/users.ts, lib/db/bans.ts,
// lib/db/securityEvents.ts and lib/db/notifications.ts.
//
// Imports ONLY vitest on purpose: the suites' vi.mock factories load this module
// lazily (`await import('./cov-db-users-bans-fake')`), and importing an app module
// here would turn that into an import cycle through the mocked lib/db/common.
//
// Every query records its FULL chain (table, every builder call and its arguments,
// the write op and the terminal), so a test can pin the exact SQL shape: the
// explicit column list (never '*'), every filter, the order + cap, and the exact
// insert / update payload. Results are resolved per query by a test-supplied
// handler, then by a per-table FIFO queue, then default to { data: null, error: null }.
import { vi } from 'vitest';

export interface SbCall { method: string; args: unknown[] }
export type SbOp = 'select' | 'insert' | 'update' | 'delete' | 'upsert';
export interface SbQuery {
    table: string;
    calls: SbCall[];
    op: SbOp;
    terminal: 'single' | 'maybeSingle' | 'await' | null;
}
export interface SbResult { data?: unknown; error?: unknown; count?: number | null }
type RoleSlot = { id: number; name: string } | undefined;
/** One log line safeFetchFake emitted, shaped like the real safeFetch's log call. */
export interface SafeFetchLog { level: 'warn' | 'error'; msg: string; fields: Record<string, unknown> }

export const sb = {
    queries: [] as SbQuery[],
    handler: null as null | ((q: SbQuery) => SbResult | undefined),
    queues: {} as Record<string, SbResult[]>,
    broadcasts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    rpcCalls: [] as Array<{ fn: string; args: unknown }>,
    rpcResult: { data: null, error: null } as SbResult,
    systemRoles: {} as { client?: RoleSlot; member?: RoleSlot; dispatcher?: RoleSlot; admin?: RoleSlot },
    systemRolesThrows: null as Error | null,
    handledErrors: [] as Array<{ message: string; error: unknown }>,
    safeFetchLogs: [] as SafeFetchLog[],
};

export function resetSb(): void {
    sb.queries = [];
    sb.handler = null;
    sb.queues = {};
    sb.broadcasts = [];
    sb.rpcCalls = [];
    sb.rpcResult = { data: null, error: null };
    sb.systemRoles = {};
    sb.systemRolesThrows = null;
    sb.handledErrors = [];
    sb.safeFetchLogs = [];
}

/** Queue results for a table, consumed in call order. */
export function queue(table: string, ...results: SbResult[]): void {
    (sb.queues[table] ||= []).push(...results);
}

function resolveQuery(q: SbQuery): SbResult {
    if (sb.handler) {
        const r = sb.handler(q);
        if (r !== undefined) return { data: null, error: null, ...r };
    }
    const qq = sb.queues[q.table];
    if (qq && qq.length) return { data: null, error: null, ...qq.shift() };
    return { data: null, error: null };
}

const FILTERS = ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range', 'gt', 'gte',
    'lt', 'lte', 'ilike', 'like', 'match', 'filter', 'contains'];
const WRITES: SbOp[] = ['insert', 'update', 'delete', 'upsert'];

function build(table: string): Record<string, unknown> {
    const q: SbQuery = { table, calls: [], op: 'select', terminal: null };
    sb.queries.push(q);
    const chain: Record<string, unknown> = {};
    for (const m of FILTERS) {
        chain[m] = (...args: unknown[]) => { q.calls.push({ method: m, args }); return chain; };
    }
    for (const m of WRITES) {
        chain[m] = (...args: unknown[]) => {
            q.calls.push({ method: m, args });
            if (q.op === 'select') q.op = m;
            return chain;
        };
    }
    const settle = (terminal: SbQuery['terminal']): Promise<SbResult> => {
        q.terminal = terminal;
        return new Promise((resolve, reject) => {
            try { resolve(resolveQuery(q)); } catch (e) { reject(e); }
        });
    };
    chain.single = () => { q.calls.push({ method: 'single', args: [] }); return settle('single'); };
    chain.maybeSingle = () => { q.calls.push({ method: 'maybeSingle', args: [] }); return settle('maybeSingle'); };
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle('await').then(res, rej);
    return chain;
}

export const supabaseFake = {
    from: (table: string) => build(table),
    rpc: (fn: string, args: unknown) => {
        sb.rpcCalls.push({ fn, args });
        return Promise.resolve({ data: null, error: null, ...sb.rpcResult });
    },
};

/** Mirrors lib/supabaseServer.ts handleSupabaseError: throw ONLY the caller's message. */
export function handleSupabaseErrorFake({ error, message }: { error: unknown; message: string }): void {
    if (error) {
        sb.handledErrors.push({ message, error });
        throw new Error(message);
    }
}

/**
 * Mirrors lib/db/common.ts safeFetch, which NEVER throws: ANY read failure resolves
 * to the caller's fallback.
 *   - tolerated schema-drift codes → warn 'safeFetch returning fallback', fallback;
 *   - any other error → error 'safeFetch DB error', then handleSupabaseError throws,
 *     which safeFetch's own catch turns into error 'safeFetch fatal' + fallback;
 *   - a rejecting query → error 'safeFetch fatal' + fallback.
 * The log lines (message + fields) are recorded in sb.safeFetchLogs so a suite can
 * prove a fault was logged rather than swallowed silently.
 * tests/cov-db-users-bans-fake-parity.test.ts runs this and the REAL safeFetch over
 * the same inputs and requires identical results and log lines, so this double
 * cannot drift from the contract it stands in for.
 */
export async function safeFetchFake<T>(
    query: PromiseLike<{ data: T | null; error: { code?: string; message?: string; hint?: string; details?: string } | null }>,
    fallback: T,
    errorMessage: string,
): Promise<T> {
    try {
        const { data, error } = await query;
        if (error) {
            const fields = {
                target: errorMessage,
                code: error.code,
                errMessage: error.message,
                hint: error.hint || '',
                details: error.details || '',
            };
            if (['PGRST205', 'PGRST204', 'PGRST200', 'PGRST201', '42P01'].includes(error.code ?? '')) {
                sb.safeFetchLogs.push({ level: 'warn', msg: 'safeFetch returning fallback', fields });
                return fallback;
            }
            sb.safeFetchLogs.push({ level: 'error', msg: 'safeFetch DB error', fields });
            handleSupabaseErrorFake({ error, message: errorMessage });
        }
        return data as T;
    } catch (err) {
        sb.safeFetchLogs.push({ level: 'error', msg: 'safeFetch fatal', fields: { target: errorMessage, err } });
        return fallback;
    }
}

export const getSystemRolesFake = vi.fn(async () => {
    if (sb.systemRolesThrows) throw sb.systemRolesThrows;
    return sb.systemRoles;
});

/** The module shape a suite returns from `vi.mock('../lib/db/common', ...)`. */
export const commonMock = {
    supabase: supabaseFake,
    handleSupabaseError: handleSupabaseErrorFake,
    broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => {
        sb.broadcasts.push({ event, payload });
        return Promise.resolve();
    },
    broadcastToChannel: () => Promise.resolve(),
    getSystemRoles: getSystemRolesFake,
    getSystemRolesUncached: getSystemRolesFake,
    safeFetch: safeFetchFake,
};

// ── query inspection ──────────────────────────────────────────────────────

/** A compact `[method, ...args]` rendering of a query's chain, for exact-shape asserts. */
export function chainOf(q: SbQuery | undefined): unknown[][] {
    if (!q) throw new Error('chainOf: no such query');
    return q.calls.map((c) => [c.method, ...c.args]);
}

/** Every query issued against `table`, in order. */
export function on(table: string): SbQuery[] {
    return sb.queries.filter((q) => q.table === table);
}

/** First args of `method` on `q`, or undefined. */
export function argsOf(q: SbQuery | undefined, method: string): unknown[] | undefined {
    return q?.calls.find((c) => c.method === method)?.args;
}

/** Does `q` call `method`? */
export function has(q: SbQuery | undefined, method: string): boolean {
    return !!q?.calls.some((c) => c.method === method);
}

/** Every column list passed to .select() across all recorded queries. */
export function allSelectLists(): string[] {
    return sb.queries.flatMap((q) => q.calls.filter((c) => c.method === 'select' && typeof c.args[0] === 'string').map((c) => c.args[0] as string));
}

/** Rule 1 guard: no recorded select is a wildcard or a bare `.select()`. */
export function assertNoWildcardSelect(): void {
    for (const q of sb.queries) {
        for (const c of q.calls) {
            if (c.method !== 'select') continue;
            const cols = c.args[0];
            if (typeof cols !== 'string' || !cols.trim()) throw new Error(`bare .select() on ${q.table}`);
            if (/(^|[\s,(])\*/.test(cols)) throw new Error(`wildcard select on ${q.table}: ${cols}`);
        }
    }
}
