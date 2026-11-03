// Recording Supabase fake for the lib/db/warehouse.ts coverage suites
// (tests/cov-db-warehouse-*.test.ts). Not a test file itself.
//
// Imports ONLY vitest: the suites' vi.mock factories load this module lazily
// (`async () => (await import('./cov-db-warehouse-fake')).commonMock`), and the
// suites import it statically too — both resolve to the same instance, so the
// recorded queries / emits are visible to the assertions.
//
// Unlike the older warehouse fakes (which declare `b.in = () => b` and so can't
// tell a correct filter from a missing one), every chained call is RECORDED with
// its arguments, so a test pins the exact table, explicit column list, filters
// and write payload — and the order the queries ran in.
import { vi } from 'vitest';

export type Op = [method: string, args: unknown[]];
export interface Query { table: string; ops: Op[]; terminal?: 'then' | 'single' | 'maybeSingle' }
/** A queued response. `reject` makes the awaited query REJECT (a thrown driver error). */
export interface Resp { data?: unknown; error?: unknown; count?: number | null; reject?: unknown }

const CHAIN = [
    'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'in', 'is', 'not', 'or', 'ilike', 'gte', 'lte', 'order', 'limit', 'range',
] as const;

export const fake = {
    queries: [] as Query[],
    /** Per-table FIFO of responses; a query with nothing queued resolves `{ data: null, error: null, count: null }`. */
    queue: {} as Record<string, Resp[]>,
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    rpcQueue: [] as Resp[],
    emits: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    logs: [] as Array<{ level: string; msg: string; fields?: Record<string, unknown> }>,
};

export function resetFake(): void {
    fake.queries = [];
    fake.queue = {};
    fake.rpcCalls = [];
    fake.rpcQueue = [];
    fake.emits = [];
    fake.logs = [];
    filterContractIdsForParty.mockReset();
    filterContractIdsForParty.mockResolvedValue(new Set<string>());
    fetchUexCommodities.mockReset();
}

/** Queue responses for `table`, consumed in the order the code awaits its queries. */
export function respond(table: string, ...resps: Resp[]): void {
    (fake.queue[table] ??= []).push(...resps);
}

export function respondRpc(...resps: Resp[]): void {
    fake.rpcQueue.push(...resps);
}

/** Every query issued against `table`, in order. */
export function queriesOf(table: string): Query[] {
    return fake.queries.filter((q) => q.table === table);
}

/** The argument lists of every call to `method` on `q`. */
export function calls(q: Query, method: string): unknown[][] {
    return q.ops.filter((o) => o[0] === method).map((o) => o[1]);
}

/** The method names chained on `q`, in order (e.g. ['select', 'eq', 'order']). */
export function chain(q: Query): string[] {
    return q.ops.map((o) => o[0]);
}

/** The column list a query selected, whitespace-collapsed (template-literal selects span lines). */
export function selected(q: Query): string {
    const sel = calls(q, 'select')[0];
    if (!sel) throw new Error(`query on ${q.table} has no select()`);
    return String(sel[0]).replace(/\s+/g, ' ').trim();
}

/** Table + verb summary of the run, e.g. ['warehouse_stock:select', 'warehouse_requests:delete']. */
export function trail(): string[] {
    return fake.queries.map((q) => {
        const verb = q.ops.find((o) => ['insert', 'update', 'delete', 'upsert'].includes(o[0]))?.[0] ?? 'select';
        return `${q.table}:${verb}`;
    });
}

function builder(table: string): Record<string, unknown> {
    const q: Query = { table, ops: [] };
    fake.queries.push(q);
    const b: Record<string, unknown> = {};
    for (const m of CHAIN) {
        b[m] = (...args: unknown[]) => { q.ops.push([m, args]); return b; };
    }
    const settle = (terminal: NonNullable<Query['terminal']>): Promise<unknown> => {
        q.terminal = terminal;
        const next = fake.queue[table]?.shift();
        if (next && 'reject' in next) return Promise.reject(next.reject);
        return Promise.resolve({ data: null, error: null, count: null, ...next });
    };
    b.single = () => settle('single');
    b.maybeSingle = () => settle('maybeSingle');
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle('then').then(res, rej);
    return b;
}

export const commonMock = {
    supabase: {
        from: (table: string) => builder(table),
        rpc: (fn: string, args: Record<string, unknown>) => {
            fake.rpcCalls.push({ fn, args });
            const next = fake.rpcQueue.shift();
            return Promise.resolve({ data: null, error: null, ...next });
        },
    },
    // Mirrors lib/supabaseServer.handleSupabaseError: any error rethrows the
    // caller's generic message (never the driver detail).
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
        if (error) throw new Error(message);
    },
    broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => {
        fake.emits.push({ event, payload });
        return Promise.resolve();
    },
    broadcastToChannel: () => Promise.resolve(),
};

function makeLogger(): Record<string, unknown> {
    const logger: Record<string, unknown> = {};
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        logger[level] = (msg: string, fields?: Record<string, unknown>) => { fake.logs.push({ level, msg, fields }); };
    }
    logger.child = () => logger;
    return logger;
}

export const logMock = { log: makeLogger() };

// lib/db/marketplace.ts is another unit's module — warehouse.ts only consumes
// filterContractIdsForParty, so it is a spy here (its own behaviour is pinned in
// tests/warehouseContractLink.test.ts).
export const filterContractIdsForParty = vi.fn<(ids: string[], userId: number) => Promise<Set<string>>>();
export const marketplaceMock = { filterContractIdsForParty };

// lib/db/uex.ts does network I/O; the sync path is driven with a stubbed fetch and
// a minimal deterministic mapper that still threads the category FK lookup through.
export const fetchUexCommodities = vi.fn<() => Promise<Array<Record<string, unknown>>>>();
export function slugify(input: string): string {
    return (input || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}
export const uexMock = {
    fetchUexCommodities,
    slugify,
    mapUexCommodityToWarehouseRow: (c: Record<string, unknown>, lookup: Map<string, number>) => ({
        external_id: c.id,
        name: c.name,
        platform_category_id: c.kind ? lookup.get(slugify(String(c.kind))) ?? null : null,
    }),
};
