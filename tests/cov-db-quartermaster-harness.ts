// Shared, dependency-free fake Supabase for the lib/db/quartermaster.ts coverage
// suites (tests/cov-db-quartermaster-*.test.ts). Owned by that unit only.
//
// Imports ONLY vitest on purpose: the suites' vi.mock factories load this module
// lazily (`await import(...)`), and one of them mocks lib/log — anything here that
// imported an app module would turn that into an import cycle.
//
// Every query builder records its full chain (method + args, in call order) and the
// terminal that settled it, so a test can pin the exact table, the explicit column
// list, every filter and every write payload. Responses are served FIFO per table
// (queue()), or by a per-table handler that inspects the recorded chain, and
// default to `{ data: null, error: null, count: null }`.
import { vi } from 'vitest';

export type Op = [method: string, args: unknown[]];
export interface Query {
    table: string;
    ops: Op[];
    /** Which terminal settled the builder; undefined = built but never awaited. */
    terminal?: 'then' | 'single' | 'maybeSingle';
}
export interface Res { data?: unknown; error?: unknown; count?: number | null }

export const h = {
    queries: [] as Query[],
    responses: {} as Record<string, Res[]>,
    handlers: {} as Record<string, (q: Query) => Res | undefined>,
    rpcCalls: [] as Array<{ fn: string; args: unknown }>,
    rpcResponses: {} as Record<string, Res[]>,
};

export const broadcastToOrg = vi.fn();
export const logSpy = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

export const uex = {
    fetchAllUexItems: vi.fn(),
    mapUexItemToQmRow: vi.fn(),
    fetchUexCategories: vi.fn(),
    fetchUexItemAttributesForCategory: vi.fn(),
};

/** Queue responses for the next settles on `table`, in order. */
export function queue(table: string, ...res: Res[]): void {
    (h.responses[table] ||= []).push(...res);
}
/** Queue responses for the next calls of rpc `fn`, in order. */
export function queueRpc(fn: string, ...res: Res[]): void {
    (h.rpcResponses[fn] ||= []).push(...res);
}

function norm(r: Res | undefined): { data: unknown; error: unknown; count: number | null } {
    return { data: r?.data ?? null, error: r?.error ?? null, count: r?.count ?? null };
}

function resolveFor(q: Query): { data: unknown; error: unknown; count: number | null } {
    const handler = h.handlers[q.table];
    if (handler) {
        const r = handler(q);
        if (r) return norm(r);
    }
    const qd = h.responses[q.table];
    if (qd && qd.length) return norm(qd.shift());
    return norm(undefined);
}

const CHAIN_METHODS = [
    'select', 'eq', 'neq', 'in', 'is', 'not', 'lt', 'gt', 'gte', 'lte', 'order', 'limit', 'range',
    'ilike', 'or', 'contains', 'update', 'insert', 'upsert', 'delete',
];

function builder(table: string) {
    const q: Query = { table, ops: [] };
    h.queries.push(q);
    const b: Record<string, unknown> = {};
    for (const m of CHAIN_METHODS) {
        b[m] = (...args: unknown[]) => { q.ops.push([m, args]); return b; };
    }
    const settle = (terminal: Query['terminal']) => {
        q.terminal = terminal;
        return Promise.resolve(resolveFor(q));
    };
    b.single = () => settle('single');
    b.maybeSingle = () => settle('maybeSingle');
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle('then').then(res, rej);
    return b;
}

export const supabase = {
    from: (table: string) => builder(table),
    rpc: (fn: string, args: unknown) => {
        h.rpcCalls.push({ fn, args });
        const qd = h.rpcResponses[fn];
        return Promise.resolve(norm(qd && qd.length ? qd.shift() : { data: null, error: null }));
    },
};

/** Same contract as lib/supabaseServer.ts: log detail, rethrow ONLY the caller message. */
export function handleSupabaseError({ error, message }: { error: unknown; message: string }): void {
    if (error) throw new Error(message);
}

export const commonMock = { supabase, handleSupabaseError, broadcastToOrg };

export function resetHarness(): void {
    h.queries = [];
    h.responses = {};
    h.handlers = {};
    h.rpcCalls = [];
    h.rpcResponses = {};
    broadcastToOrg.mockReset();
    for (const fn of Object.values(logSpy)) fn.mockReset();
    for (const fn of Object.values(uex)) fn.mockReset();
}

// ── accessors ──────────────────────────────────────────────────────────────
/** Every SETTLED query against `table`, in creation order. */
export function settled(table: string): Query[] {
    return h.queries.filter((q) => q.table === table && q.terminal);
}
/** Args of every call of `method` on `q`, in order. */
export function calls(q: Query, method: string): unknown[][] {
    return q.ops.filter(([m]) => m === method).map(([, a]) => a);
}
/** Args of the first call of `method` on `q` (undefined if never called). */
export function first(q: Query, method: string): unknown[] | undefined {
    return calls(q, method)[0];
}
/** The method names of `q`'s chain, in order (e.g. ['select','eq','order']). */
export function chain(q: Query): string[] {
    return q.ops.map(([m]) => m);
}
/** Normalise a multi-line select string to single-spaced for exact comparison. */
export function cols(s: unknown): string {
    return String(s).replace(/\s+/g, ' ').trim();
}
/** Settled queries touching ANY table, in settle-creation order, as `table:verb`. */
export function trace(): string[] {
    return h.queries.filter((q) => q.terminal).map((q) => {
        const verb = q.ops.find(([m]) => m === 'insert' || m === 'update' || m === 'delete' || m === 'upsert')?.[0] ?? 'select';
        return `${q.table}:${verb}`;
    });
}
