// Shared, dependency-free supabase/log doubles for the fleet-misc coverage suites
// (tests/cov-db-fleet-misc-*.test.ts). Owned by that unit — do not reuse from
// other suites; copy it instead.
//
// Imports ONLY vitest on purpose: the suites' vi.mock factories load this module
// lazily, and they also mock lib/log — anything here that imported an app module
// would turn that into an import cycle.
//
// The query-builder double records the WHOLE chain of every query (table, verb,
// selected column list, write payload, filters, ordering, limit, terminal) so a
// test can pin the exact SQL shape, and resolves each query through a per-test
// router keyed `table:verb`. assertExplicitColumns() enforces Security rule 1 on
// every query the code under test issued: a select must name its columns — no
// '*', no `(*)` embed, no bare `.select()`.
import { vi, expect } from 'vitest';

export type Verb = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

export interface Q {
    table: string;
    verb: Verb;
    selectCalled: boolean;
    columns?: string;
    selectOpts?: Record<string, unknown>;
    payload?: unknown;
    writeOpts?: Record<string, unknown>;
    /** [method, column, value] — `not` records value as [operator, value]. */
    filters: Array<[string, string, unknown]>;
    orders: Array<[string, unknown]>;
    limit?: number;
    terminal?: 'single' | 'maybeSingle';
}

export interface Res { data?: unknown; error?: unknown; count?: number | null }
type Route = Res | ((q: Q) => Res | Promise<Res>);

export const sb = {
    queries: [] as Q[],
    routes: {} as Record<string, Route>,
};

export function resetSb(): void {
    sb.queries = [];
    sb.routes = {};
}

/** Route `table:verb` (e.g. `platform_ships:select`) to a fixed result or a resolver. */
export function route(key: string, r: Route): void {
    sb.routes[key] = r;
}

/** Every recorded query for a table, optionally narrowed to one verb. */
export function queriesFor(table: string, verb?: Verb): Q[] {
    return sb.queries.filter((q) => q.table === table && (verb === undefined || q.verb === verb));
}

/** Value of the first filter of `method` on `column`, or undefined. */
export function filterValue(q: Q, method: string, column: string): unknown {
    return q.filters.find((f) => f[0] === method && f[1] === column)?.[2];
}

/** Rule 1: every select the code issued named an explicit, wildcard-free column list. */
export function assertExplicitColumns(): void {
    for (const q of sb.queries) {
        if (!q.selectCalled) continue;
        expect(typeof q.columns, `${q.table}:${q.verb} used a bare .select()`).toBe('string');
        expect(q.columns!.trim().length, `${q.table}:${q.verb} selected an empty column list`).toBeGreaterThan(0);
        expect(q.columns, `${q.table}:${q.verb} selected a wildcard`).not.toMatch(/\*/);
    }
}

function resolve(q: Q): Promise<{ data: unknown; error: unknown; count: number | null }> {
    return Promise.resolve().then(async () => {
        const r = sb.routes[`${q.table}:${q.verb}`];
        const out: Res = typeof r === 'function' ? await r(q) : (r ?? {});
        return { data: out.data ?? null, error: out.error ?? null, count: out.count ?? null };
    });
}

function builder(table: string) {
    const q: Q = { table, verb: 'select', selectCalled: false, filters: [], orders: [] };
    sb.queries.push(q);
    const b: Record<string, unknown> = {};
    b.select = (cols?: string, opts?: Record<string, unknown>) => {
        q.selectCalled = true;
        q.columns = cols;
        q.selectOpts = opts;
        return b;
    };
    b.insert = (v: unknown) => { q.verb = 'insert'; q.payload = v; return b; };
    b.update = (v: unknown) => { q.verb = 'update'; q.payload = v; return b; };
    b.upsert = (v: unknown, opts?: Record<string, unknown>) => { q.verb = 'upsert'; q.payload = v; q.writeOpts = opts; return b; };
    b.delete = () => { q.verb = 'delete'; return b; };
    for (const m of ['eq', 'neq', 'is', 'in', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'contains']) {
        b[m] = (col: string, val: unknown) => { q.filters.push([m, col, val]); return b; };
    }
    b.not = (col: string, op: string, val: unknown) => { q.filters.push(['not', col, [op, val]]); return b; };
    b.order = (col: string, opts?: unknown) => { q.orders.push([col, opts]); return b; };
    b.limit = (n: number) => { q.limit = n; return b; };
    b.single = () => { q.terminal = 'single'; return resolve(q); };
    b.maybeSingle = () => { q.terminal = 'maybeSingle'; return resolve(q); };
    b.then = (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => resolve(q).then(ok, fail);
    return b;
}

export const fakeSupabase = { from: (t: string) => builder(t) };

// ── log recorder ──────────────────────────────────────────────────────────
export interface LogLine { level: string; msg: string; fields?: Record<string, unknown> }
export const logs: LogLine[] = [];
const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => { logs.push({ level, msg, fields }); };
const childLogger: Record<string, unknown> = {
    debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'),
};
childLogger.child = () => childLogger;
export const logModule = { log: childLogger };

export function logged(level: string, msg: string): LogLine | undefined {
    return logs.find((l) => l.level === level && l.msg === msg);
}

// ── broadcast recorder ────────────────────────────────────────────────────
export const broadcast = vi.fn(async (_event: string, _payload?: Record<string, unknown>) => {});

export function resetAll(): void {
    resetSb();
    logs.length = 0;
    broadcast.mockClear();
}
