// Recording fake Supabase client for the intel-alliances coverage suites
// (tests/cov-db-intel-alliances-*.test.ts).
//
// Imports ONLY vitest: the suites load this lazily from inside vi.mock factories,
// so it must not drag an app module (and its own mocks) into the factory.
//
// Every from()/rpc() call is recorded as a FakeQuery: the table, the operation
// (select/insert/update/upsert/delete), the select column list, the write
// payload and the full builder chain. Tests then pin the exact SQL shape —
// explicit column lists, filters, write payloads — instead of only the result.
//
// Responses: per-table FIFO queue (`queue`), falling back to a persistent
// per-table responder (`on`), falling back to `{ data: null, error: null }`.
// A responder may be a plain result object or a function of the recorded query.
import { vi } from 'vitest';

export type FakeOp = 'select' | 'insert' | 'update' | 'upsert' | 'delete' | 'rpc';

export interface FakeResult {
    data?: unknown;
    error?: unknown;
    count?: number | null;
}

export interface FakeQuery {
    table: string;
    op: FakeOp;
    /** Column list of the first select() — the read projection, or the RETURNING list after a write. */
    columns?: string;
    selectOptions?: unknown;
    payload?: unknown;
    writeOptions?: unknown;
    calls: Array<[string, unknown[]]>;
    /** Set once the builder is awaited — a query that was only BUILT stays false. */
    executed: boolean;
}

type Responder = FakeResult | ((q: FakeQuery) => FakeResult | undefined);

const WRITE_OPS = new Set(['insert', 'update', 'upsert', 'delete']);

function snapshot<T>(v: T): T {
    try { return v === undefined ? v : structuredClone(v); } catch { return v; }
}

export function createFakeSupabase() {
    const queries: FakeQuery[] = [];
    const queues: Record<string, Responder[]> = {};
    const persistent: Record<string, Responder> = {};

    const resolve = (q: FakeQuery): FakeResult => {
        const key = q.op === 'rpc' ? `rpc:${q.table}` : q.table;
        const queue = queues[key];
        while (queue && queue.length) {
            const r = queue.shift()!;
            const out = typeof r === 'function' ? r(q) : r;
            if (out !== undefined) return out;
        }
        const p = persistent[key];
        if (p) {
            const out = typeof p === 'function' ? p(q) : p;
            if (out !== undefined) return out;
        }
        return { data: null, error: null };
    };

    const makeBuilder = (q: FakeQuery) => {
        const builder: Record<string | symbol, unknown> = new Proxy({}, {
            get(_t, prop) {
                if (prop === 'then') {
                    return (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => {
                        q.executed = true;
                        let out: FakeResult;
                        try { out = resolve(q); } catch (e) { return onErr ? onErr(e) : Promise.reject(e); }
                        return Promise.resolve({ data: null, error: null, ...out }).then(onOk, onErr);
                    };
                }
                if (typeof prop === 'symbol') return undefined;
                return (...args: unknown[]) => {
                    q.calls.push([prop, args]);
                    if (WRITE_OPS.has(prop) && q.op === 'select' && q.columns === undefined) {
                        q.op = prop as FakeOp;
                        // Point-in-time snapshot: callers may mutate the object after sending it.
                        q.payload = snapshot(args[0]);
                        q.writeOptions = args[1];
                    } else if (prop === 'select' && q.columns === undefined) {
                        q.columns = args[0] as string;
                        q.selectOptions = args[1];
                    }
                    return builder;
                };
            },
        }) as Record<string | symbol, unknown>;
        return builder;
    };

    const client = {
        from(table: string) {
            const q: FakeQuery = { table, op: 'select', calls: [], executed: false };
            queries.push(q);
            return makeBuilder(q);
        },
        rpc(name: string, args?: unknown) {
            const q: FakeQuery = { table: name, op: 'rpc', payload: args, calls: [], executed: false };
            queries.push(q);
            return makeBuilder(q);
        },
    };

    return {
        client,
        queries,
        /** Enqueue one-shot responses for a table (or `rpc:<name>`), consumed in order. */
        queue(table: string, ...responses: Responder[]) {
            (queues[table] ||= []).push(...responses);
        },
        /** Persistent responder used once the table's queue is drained. */
        on(table: string, responder: Responder) {
            persistent[table] = responder;
        },
        reset() {
            queries.length = 0;
            for (const k of Object.keys(queues)) delete queues[k];
            for (const k of Object.keys(persistent)) delete persistent[k];
        },
        /** All recorded queries against a table, optionally narrowed to one operation. */
        find(table: string, op?: FakeOp): FakeQuery[] {
            return queries.filter((q) => q.table === table && (!op || q.op === op));
        },
    };
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>;

/** The single fake shared by a suite's vi.mock factory and its assertions. */
export const fake = createFakeSupabase();
export const broadcastSpy = vi.fn(async () => undefined);

/** Every builder call of a given method name on a query, e.g. filters(q, 'eq'). */
export function filters(q: FakeQuery, method: string): unknown[][] {
    return q.calls.filter(([m]) => m === method).map(([, a]) => a);
}

/** True when the query carries a builder call with exactly these leading args. */
export function hasCall(q: FakeQuery, method: string, ...args: unknown[]): boolean {
    return q.calls.some(([m, a]) => m === method && args.every((v, i) => JSON.stringify(a[i]) === JSON.stringify(v)));
}

/** Split a select() column list into trimmed top-level entries (embeds kept whole). */
export function columnsOf(q: FakeQuery): string[] {
    const s = q.columns ?? '';
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/** Fail-loud guard every suite applies: no recorded projection may be a wildcard. */
export function assertNoWildcardSelects(f: FakeSupabase): void {
    for (const q of f.queries) {
        if (q.columns === undefined) continue;
        if (q.columns.trim() === '' || /(^|[\s,(])\*($|[\s,)])/.test(q.columns)) {
            throw new Error(`wildcard/empty select on ${q.table}: "${q.columns}"`);
        }
    }
}
