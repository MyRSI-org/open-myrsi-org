// Dependency-free fake Supabase + collaborator doubles for the lib/db/ops.ts and
// lib/db/operation-templates.ts coverage suites (tests/cov-db-ops-*.test.ts).
//
// Imports ONLY vitest on purpose: the suites' vi.mock factories load this module
// lazily, and one of them stands in for lib/log — anything here that imported an
// app module would turn that into an import cycle.
//
// Every query is recorded in issue order with its full builder chain, so a test
// can pin the exact table, the explicit column list, every filter, and the write
// payload. Results are served per table from a FIFO queue (`on`), then a per-table
// router (`route`), then an EMPTY default ({ data: null, error: null, count: null })
// — never a permissive one.
import { vi } from 'vitest';

export interface FakeCall { m: string; a: unknown[] }
export interface FakeQuery { table: string; calls: FakeCall[] }
export interface FakeResult { data?: unknown; error?: unknown; count?: number | null }
type Responder = FakeResult | ((q: FakeQuery) => FakeResult);

export interface LogRecord { level: string; msg: string; fields?: Record<string, unknown> }

export const fake = {
    queries: [] as FakeQuery[],
    rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
    emits: [] as Array<{ channel: string; event: string; payload: Record<string, unknown> }>,
    logs: [] as LogRecord[],
    queues: new Map<string, Responder[]>(),
    routes: new Map<string, (q: FakeQuery) => FakeResult>(),
    rpcQueue: new Map<string, FakeResult[]>(),
};

export function resetFake(): void {
    fake.queries.length = 0;
    fake.rpcs.length = 0;
    fake.emits.length = 0;
    fake.logs.length = 0;
    fake.queues.clear();
    fake.routes.clear();
    fake.rpcQueue.clear();
}

/** Queue one or more results for the next reads/writes on `table`, in order. */
export function on(table: string, ...results: Responder[]): void {
    const q = fake.queues.get(table) ?? [];
    q.push(...results);
    fake.queues.set(table, q);
}

/** Fallback responder for `table` once its queue is drained. */
export function route(table: string, fn: (q: FakeQuery) => FakeResult): void {
    fake.routes.set(table, fn);
}

export function onRpc(name: string, ...results: FakeResult[]): void {
    const q = fake.rpcQueue.get(name) ?? [];
    q.push(...results);
    fake.rpcQueue.set(name, q);
}

function resolveFor(q: FakeQuery): FakeResult {
    const queue = fake.queues.get(q.table);
    if (queue && queue.length > 0) {
        const next = queue.shift()!;
        return typeof next === 'function' ? next(q) : next;
    }
    const r = fake.routes.get(q.table);
    if (r) return r(q);
    return { data: null, error: null, count: null };
}

const CHAIN_METHODS = [
    'select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range',
    'gt', 'gte', 'lt', 'lte', 'ilike', 'like', 'contains',
    'insert', 'update', 'delete', 'upsert',
];

const WRITE_METHODS = new Set(['insert', 'update', 'upsert']);

function builder(table: string): Record<string, unknown> {
    const q: FakeQuery = { table, calls: [] };
    fake.queries.push(q);
    const b: Record<string, unknown> = {};
    for (const m of CHAIN_METHODS) {
        b[m] = (...a: unknown[]) => {
            // Snapshot write payloads at CALL time: createOperation mutates and re-sends
            // one payload object across its retries, so a stored reference would show
            // every attempt as the final shape.
            const rec = WRITE_METHODS.has(m) ? a.map((x) => (x && typeof x === 'object' ? structuredClone(x) : x)) : a;
            q.calls.push({ m, a: rec });
            return b;
        };
    }
    let settled: Promise<FakeResult> | null = null;
    const settle = () => {
        if (!settled) {
            const r = resolveFor(q);
            settled = Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null });
        }
        return settled;
    };
    b.single = () => { q.calls.push({ m: 'single', a: [] }); return settle(); };
    b.maybeSingle = () => { q.calls.push({ m: 'maybeSingle', a: [] }); return settle(); };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
    return b;
}

export const supabaseFake = {
    from: (table: string) => builder(table),
    rpc: (name: string, args: Record<string, unknown>) => {
        fake.rpcs.push({ name, args });
        const queue = fake.rpcQueue.get(name);
        const r = queue && queue.length > 0 ? queue.shift()! : { data: null, error: null };
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
};

// ── Query inspection helpers ───────────────────────────────────────────────

export const queriesOn = (table: string): FakeQuery[] => fake.queries.filter((q) => q.table === table);
export const argsOf = (q: FakeQuery, m: string): unknown[][] => q.calls.filter((c) => c.m === m).map((c) => c.a);
export const has = (q: FakeQuery, m: string): boolean => q.calls.some((c) => c.m === m);
/** Column list of the FIRST select() on the query ('' when none). */
export const cols = (q: FakeQuery): string => String(argsOf(q, 'select')[0]?.[0] ?? '');
/** eq filters as [column, value] pairs in call order. */
export const eqs = (q: FakeQuery): Array<[unknown, unknown]> => argsOf(q, 'eq').map((a) => [a[0], a[1]]);
/** The write payload (first arg of insert/update/upsert). */
export const payload = (q: FakeQuery): unknown => {
    const w = q.calls.find((c) => c.m === 'insert' || c.m === 'update' || c.m === 'upsert');
    return w?.a[0];
};
export const writeKind = (q: FakeQuery): 'insert' | 'update' | 'upsert' | 'delete' | 'read' => {
    for (const c of q.calls) {
        if (c.m === 'insert' || c.m === 'update' || c.m === 'upsert' || c.m === 'delete') return c.m;
    }
    return 'read';
};
export const writesOn = (table: string, kind?: 'insert' | 'update' | 'upsert' | 'delete'): FakeQuery[] =>
    queriesOn(table).filter((q) => (kind ? writeKind(q) === kind : writeKind(q) !== 'read'));
export const readsOn = (table: string): FakeQuery[] => queriesOn(table).filter((q) => writeKind(q) === 'read');

// ── Module doubles ─────────────────────────────────────────────────────────

/** lib/db/common double. handleSupabaseError + safeFetch mirror the real semantics:
 *  handleSupabaseError throws the caller's high-level message; safeFetch catches its
 *  own rethrow, so ANY query error resolves to the fallback. */
export const commonMock = {
    supabase: supabaseFake,
    handleSupabaseError: ({ error, message }: { error: unknown; message: string }) => {
        if (error) throw new Error(message);
    },
    safeFetch: async <T>(query: PromiseLike<{ data: T | null; error: unknown }>, fallback: T): Promise<T> => {
        try {
            const { data, error } = await query;
            if (error) return fallback;
            return data as T;
        } catch {
            return fallback;
        }
    },
    broadcastToOrg: (event: string, payload: Record<string, unknown> = {}) => {
        fake.emits.push({ channel: 'db-changes', event, payload });
        return Promise.resolve();
    },
    broadcastToChannel: (channel: string, event: string, payload: Record<string, unknown> = {}) => {
        fake.emits.push({ channel, event, payload });
        return Promise.resolve();
    },
};

function makeLogger(context: Record<string, unknown>): Record<string, unknown> {
    const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
        fake.logs.push({ level, msg, fields: { ...context, ...(fields || {}) } });
    };
    return {
        debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'),
        child: (c: Record<string, unknown>) => makeLogger({ ...context, ...c }),
    };
}

/** lib/log double: records every record so soft-fail warnings are assertable. */
export const logMock = { log: makeLogger({}), refreshLogLevel: () => undefined, redactFields: (f: Record<string, unknown>) => f };

export const warnings = (re: RegExp): LogRecord[] => fake.logs.filter((l) => l.level === 'warn' && re.test(l.msg));

export const fed = {
    bumpOperationVersion: vi.fn(async (_id: string) => undefined as unknown),
    pushOperationToAllies: vi.fn(async (_id: string, _reason: string) => undefined as unknown),
    scheduleAlliedPush: vi.fn((_id: string) => undefined),
};

export const collab = {
    sendPushToUsers: vi.fn(async (_ids: number[], _msg: Record<string, unknown>) => undefined as unknown),
    getUserById: vi.fn(async (_id: number) => null as unknown),
    getActorLabel: vi.fn(async (id: number) => `User#${id}`),
    createNotification: vi.fn(async (_uid: number, _n: Record<string, unknown>) => undefined as unknown),
    recordSecurityEvent: vi.fn(async (_e: Record<string, unknown>) => undefined),
    generateAARSummary: vi.fn(async (_input: Record<string, unknown>) => ({ summary: 'S', lessonsLearned: 'L' }) as Record<string, unknown>),
};

export function resetCollaborators(): void {
    for (const f of Object.values(fed)) f.mockClear();
    for (const f of Object.values(collab)) f.mockClear();
    fed.bumpOperationVersion.mockImplementation(async () => undefined);
    fed.pushOperationToAllies.mockImplementation(async () => undefined);
    fed.scheduleAlliedPush.mockImplementation(() => undefined);
    collab.sendPushToUsers.mockImplementation(async () => undefined);
    collab.getUserById.mockImplementation(async () => null);
    collab.getActorLabel.mockImplementation(async (id: number) => `User#${id}`);
    collab.createNotification.mockImplementation(async () => undefined);
    collab.recordSecurityEvent.mockImplementation(async () => undefined);
    collab.generateAARSummary.mockImplementation(async () => ({ summary: 'S', lessonsLearned: 'L' }));
}

/** Every op-scoped mutation's realtime fan-out: ONE id-only operation_update. */
export const opUpdates = (): Array<Record<string, unknown>> =>
    fake.emits.filter((e) => e.channel === 'db-changes' && e.event === 'operation_update').map((e) => e.payload);

/** A unique operation uuid per call, so the verifyOperationAccess cache never bleeds. */
let opSeq = 0;
export function newOpId(): string {
    opSeq += 1;
    return `00000000-0000-4000-8000-${String(opSeq).padStart(12, '0')}`;
}

/** Let fire-and-forget promise chains (void x().catch(...)) settle. */
export const flush = () => new Promise((r) => setTimeout(r, 0));
