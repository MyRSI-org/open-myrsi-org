// Recording supabase fake for the lib/db/government coverage suites
// (tests/cov-db-government-*.test.ts). Owned by that unit — not a shared helper.
//
// Imports ONLY vitest: the suites' vi.mock factories load this module lazily, so
// anything here that imported an app module would create an import cycle.
//
// Every `supabase.from(table)` chain is recorded as one FakeQuery: the operation, the
// exact column list selected (whitespace-normalised so a multi-line embed select can be
// compared as a string), the write payload, and every filter/modifier call in order. A
// test routes responses per `table:op` (a queue — the last entry is sticky) and then
// asserts on exactly which queries ran, with which columns and filters.
import { vi } from 'vitest';

export type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete';

export interface FakeQuery {
    table: string;
    op: Op;
    /** Columns passed to a read `.select(...)`, whitespace-collapsed. */
    columns?: string;
    /** Options passed to a read `.select(cols, opts)` (count / head). */
    selectOpts?: { count?: string; head?: boolean };
    /** Columns of a `.select(...)` chained after a write (the RETURNING list). */
    returning?: string;
    /** insert / update / upsert payload. */
    values?: unknown;
    /** upsert options. */
    writeOpts?: unknown;
    /** Every filter / modifier call, in order, e.g. ['eq', ['id', 3]]. */
    chain: Array<[string, unknown[]]>;
    terminal: 'await' | 'single' | 'maybeSingle' | null;
}

export interface FakeResult { data?: unknown; error?: unknown; count?: number | null }
export type Responder = FakeResult | ((q: FakeQuery) => FakeResult | undefined);

export const fake = {
    queries: [] as FakeQuery[],
    routes: new Map<string, Responder[]>(),
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    rpcResult: { data: null, error: null } as FakeResult,
    safeFetchFallbacks: [] as string[],
};

export const broadcastToOrg = vi.fn();

export function resetFake(): void {
    fake.queries = [];
    fake.routes = new Map();
    fake.rpcCalls = [];
    fake.rpcResult = { data: null, error: null };
    fake.safeFetchFallbacks = [];
    broadcastToOrg.mockReset();
}

/** Queue one or more responses for `table:op`. The last queued response is sticky. */
export function on(table: string, op: Op, ...responses: Responder[]): void {
    const key = `${table}:${op}`;
    const q = fake.routes.get(key) ?? [];
    q.push(...responses);
    fake.routes.set(key, q);
}

function respond(q: FakeQuery): FakeResult {
    const queue = fake.routes.get(`${q.table}:${q.op}`);
    let r: Responder | undefined;
    if (queue && queue.length > 0) r = queue.length > 1 ? queue.shift() : queue[0];
    const out = typeof r === 'function' ? r(q) : r;
    return { data: null, error: null, count: null, ...(out ?? {}) };
}

const norm = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : undefined);

const CHAIN_METHODS = ['eq', 'neq', 'is', 'in', 'not', 'lt', 'lte', 'gt', 'gte', 'order', 'limit', 'range'];

function builder(table: string) {
    const q: FakeQuery = { table, op: 'select', chain: [], terminal: null };
    fake.queries.push(q);
    const b: Record<string, unknown> = {};
    b.select = (cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (q.op === 'select') { q.columns = norm(cols); q.selectOpts = opts; } else { q.returning = norm(cols); }
        return b;
    };
    b.insert = (v: unknown) => { q.op = 'insert'; q.values = v; return b; };
    b.update = (v: unknown) => { q.op = 'update'; q.values = v; return b; };
    b.upsert = (v: unknown, opts?: unknown) => { q.op = 'upsert'; q.values = v; q.writeOpts = opts; return b; };
    b.delete = () => { q.op = 'delete'; return b; };
    for (const m of CHAIN_METHODS) b[m] = (...args: unknown[]) => { q.chain.push([m, args]); return b; };
    b.single = () => { q.terminal = 'single'; return Promise.resolve(respond(q)); };
    b.maybeSingle = () => { q.terminal = 'maybeSingle'; return Promise.resolve(respond(q)); };
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        q.terminal = 'await';
        return Promise.resolve(respond(q)).then(resolve, reject);
    };
    return b;
}

export const supabase = {
    from: (table: string) => builder(table),
    rpc: (fn: string, args: Record<string, unknown>) => {
        fake.rpcCalls.push({ fn, args });
        return Promise.resolve({ data: null, error: null, ...fake.rpcResult });
    },
};

/** The shape lib/db/common exports, for `vi.mock('../lib/db/common', ...)`. */
export function commonModule() {
    return {
        supabase,
        // Mirrors lib/supabaseServer.ts: the caller's message, never the DB detail.
        handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
            if (error) throw new Error(message);
        },
        broadcastToOrg,
        broadcastToChannel: vi.fn(),
        // Mirrors lib/db/common.ts safeFetch: any error (fallback-listed code or not)
        // ends in the fallback; a clean null result is returned as-is.
        safeFetch: async <T>(query: PromiseLike<{ data: T | null; error: unknown }>, fallback: T, label: string): Promise<T> => {
            try {
                const { data, error } = await query;
                if (error) { fake.safeFetchFallbacks.push(label); return fallback; }
                return data as T;
            } catch {
                fake.safeFetchFallbacks.push(label);
                return fallback;
            }
        },
        getSystemRoles: vi.fn(async () => ({})),
    };
}

// ── query lookups ────────────────────────────────────────────────────────

export function queries(table: string, op?: Op): FakeQuery[] {
    return fake.queries.filter((q) => q.table === table && (op === undefined || q.op === op));
}

export function only(table: string, op: Op): FakeQuery {
    const found = queries(table, op);
    if (found.length !== 1) throw new Error(`expected exactly one ${table}:${op} query, saw ${found.length}`);
    return found[0];
}

/** The `.eq()` filters of a query as a plain object (later calls win). */
export function eqs(q: FakeQuery): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [m, args] of q.chain) if (m === 'eq') out[args[0] as string] = args[1];
    return out;
}

/** Every chain call of a given method, e.g. calls(q, 'is') → [['ended_at', null]]. */
export function calls(q: FakeQuery, method: string): unknown[][] {
    return q.chain.filter(([m]) => m === method).map(([, args]) => args);
}

/** Every write (insert/update/upsert/delete) issued, in order, as `table:op`. */
export function writeLog(): string[] {
    return fake.queries.filter((q) => q.op !== 'select').map((q) => `${q.table}:${q.op}`);
}

/** No column list may be a wildcard — Security rule 1, asserted on every suite. */
export function assertNoWildcards(): void {
    for (const q of fake.queries) {
        for (const cols of [q.columns, q.returning]) {
            if (cols !== undefined && /(^|[\s,(])\*([\s,)]|$)/.test(cols)) {
                throw new Error(`wildcard select on ${q.table}: ${cols}`);
            }
        }
        if (q.op === 'select' && q.columns === undefined && q.terminal !== null) {
            throw new Error(`bare .select() on ${q.table}`);
        }
    }
}

/** The slices carried on every government_update broadcast, in order. */
export function govBroadcasts(): Array<Record<string, unknown>> {
    return broadcastToOrg.mock.calls
        .filter((c) => c[0] === 'government_update')
        .map((c) => c[1] as Record<string, unknown>);
}
