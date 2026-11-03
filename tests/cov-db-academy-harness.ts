// Shared, dependency-free fake-Supabase harness for the lib/db/academy.ts coverage
// suites (tests/cov-db-academy-*.test.ts). NOT a test file — no `.test.` in the name,
// so vitest never collects it.
//
// Imports ONLY vitest on purpose: the suites' vi.mock factories load this module
// lazily (`await import('./cov-db-academy-harness')`), and the static import in the
// test body then resolves to the SAME instance, so a test can steer and inspect what
// the module under test sees.
//
// Every query chain is RECORDED (table, every method + args, which terminal resolved
// it), so a test asserts the exact SQL shape — explicit column lists, filters, order,
// caps, insert/update payloads — rather than merely that some code ran. Responses are
// chosen by RULES matched against the completed chain at resolution time, so the
// order in which concurrent Promise.all branches happen to start does not matter.
import { vi } from 'vitest';

export type Op = [method: string, args: unknown[]];
export type Terminal = 'then' | 'single' | 'maybeSingle';
export interface Q { table: string; ops: Op[]; terminal: Terminal | null }
export interface Resp { data?: unknown; error?: unknown; count?: number }
export type Kind = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

export interface Matcher {
    kind?: Kind;
    /** Exact select-argument string (the column list). */
    cols?: string;
    /** Every listed eq(col, val) must be present on the chain. */
    eq?: Record<string, unknown>;
    terminal?: Terminal;
    where?: (q: Q) => boolean;
}
interface Rule { table: string; m: Matcher; resp: Resp | ((q: Q) => Resp); once: boolean; used: boolean }

const WRITE_KINDS: Kind[] = ['insert', 'update', 'delete', 'upsert'];

export function kindOf(q: Q): Kind {
    for (const [m] of q.ops) if ((WRITE_KINDS as string[]).includes(m)) return m as Kind;
    return 'select';
}
/** All args lists for a method, in call order. */
export function argsOf(q: Q, method: string): unknown[][] {
    return q.ops.filter(([m]) => m === method).map(([, a]) => a);
}
/** First args list for a method (undefined when the chain never called it). */
export function argOf(q: Q, method: string): unknown[] | undefined {
    return argsOf(q, method)[0];
}
export function colsOf(q: Q): string | undefined {
    return argOf(q, 'select')?.[0] as string | undefined;
}
export function eqsOf(q: Q): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [col, val] of argsOf(q, 'eq')) out[col as string] = val;
    return out;
}
export function payloadOf(q: Q): unknown {
    const k = kindOf(q);
    return k === 'select' ? undefined : argOf(q, k)?.[0];
}

function matches(q: Q, m: Matcher): boolean {
    if (m.kind && kindOf(q) !== m.kind) return false;
    if (m.cols !== undefined && colsOf(q) !== m.cols) return false;
    if (m.terminal && q.terminal !== m.terminal) return false;
    if (m.eq) {
        const e = eqsOf(q);
        for (const [k, v] of Object.entries(m.eq)) if (e[k] !== v) return false;
    }
    if (m.where && !m.where(q)) return false;
    return true;
}

export const sb = {
    queries: [] as Q[],
    rules: [] as Rule[],
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    rpcResp: [] as Resp[],
};

/** Persistent rule: answers every matching query. First registered match wins. */
export function on(table: string, m: Matcher, resp: Resp | ((q: Q) => Resp)): void {
    sb.rules.push({ table, m, resp, once: false, used: false });
}
/** One-shot rule: answers the first matching query, then retires. */
export function once(table: string, m: Matcher, resp: Resp | ((q: Q) => Resp)): void {
    sb.rules.push({ table, m, resp, once: true, used: false });
}
/** Queue an rpc() result (FIFO). Unqueued rpc calls resolve { data: null, error: null }. */
export function rpcReturns(resp: Resp): void { sb.rpcResp.push(resp); }

function resolveQuery(q: Q): Resp {
    for (const r of sb.rules) {
        if (r.table !== q.table || (r.once && r.used)) continue;
        if (!matches(q, r.m)) continue;
        if (r.once) r.used = true;
        return typeof r.resp === 'function' ? r.resp(q) : r.resp;
    }
    return { data: null, error: null };
}

const CHAIN_METHODS = ['select', 'eq', 'in', 'neq', 'not', 'is', 'order', 'limit', 'range', 'gte', 'lte', 'insert', 'update', 'delete', 'upsert'];

export const supabaseStub = {
    from(table: string) {
        const q: Q = { table, ops: [], terminal: null };
        sb.queries.push(q);
        const chain: Record<string, unknown> = {};
        for (const m of CHAIN_METHODS) {
            chain[m] = (...args: unknown[]) => { q.ops.push([m, args]); return chain; };
        }
        const settle = (t: Terminal): Resp => {
            q.terminal = t;
            const r = resolveQuery(q);
            return { data: r.data ?? null, error: r.error ?? null, ...(r.count !== undefined ? { count: r.count } : {}) };
        };
        chain.single = async () => settle('single');
        chain.maybeSingle = async () => settle('maybeSingle');
        chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
            try { return Promise.resolve(resolve(settle('then'))); } catch (e) { return reject ? reject(e) : Promise.reject(e); }
        };
        return chain;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
        sb.rpcCalls.push({ fn, args });
        const r = sb.rpcResp.shift() ?? {};
        return { data: r.data ?? null, error: r.error ?? null };
    },
};

/** Mirror of lib/supabaseServer.ts handleSupabaseError: the rethrow carries ONLY the
 *  caller's high-level message, so a test can pin which guard fired. */
export function handleSupabaseError({ error, message }: { error: unknown; message: string }): void {
    if (error) throw new Error(message);
}

export const broadcastToOrg = vi.fn(async (_event: string, _payload?: Record<string, unknown>) => undefined);
export const createNotification = vi.fn(async (_uid: number, _n: Record<string, unknown>) => null as unknown);
export const awardCertification = vi.fn(async (_uid: number, _certId: number, _by: number) => undefined);
export const CLIENT_ROLE_ID = 7;
export const requireClientRoleId = vi.fn(async () => CLIENT_ROLE_ID);
export const logSpy = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logSpy };

export function resetHarness(): void {
    sb.queries.length = 0;
    sb.rules.length = 0;
    sb.rpcCalls.length = 0;
    sb.rpcResp.length = 0;
    broadcastToOrg.mockClear();
    createNotification.mockReset();
    createNotification.mockImplementation(async () => null);
    awardCertification.mockReset();
    awardCertification.mockImplementation(async () => undefined);
    requireClientRoleId.mockReset();
    requireClientRoleId.mockImplementation(async () => CLIENT_ROLE_ID);
    for (const k of ['debug', 'info', 'warn', 'error'] as const) logSpy[k].mockClear();
}

// ── Query inspection helpers ────────────────────────────────────────────────
export function queriesOn(table: string, kind?: Kind): Q[] {
    return sb.queries.filter(q => q.table === table && (kind === undefined || kindOf(q) === kind));
}
export function writesOn(table: string, kind: Exclude<Kind, 'select'>): unknown[] {
    return queriesOn(table, kind).map(payloadOf);
}
/** Every academy_update broadcast payload, in order. */
export function broadcasts(): Array<Record<string, unknown>> {
    return broadcastToOrg.mock.calls.map(([event, payload]) => {
        if (event !== 'academy_update') throw new Error(`unexpected broadcast event ${event}`);
        return payload ?? {};
    });
}
/** Every notification created, as { uid, ...payload }. */
export function notifications(): Array<Record<string, unknown> & { uid: number }> {
    return createNotification.mock.calls.map(([uid, n]) => ({ uid, ...n }));
}
/** No select in the recorded log may be a wildcard (Security rule 1). */
export function assertNoWildcardSelects(): void {
    for (const q of sb.queries) {
        for (const args of argsOf(q, 'select')) {
            const cols = args[0];
            if (cols === undefined || cols === '' || (typeof cols === 'string' && /\*/.test(cols))) {
                throw new Error(`wildcard/bare select on ${q.table}: ${String(cols)}`);
            }
        }
    }
}

// ── Common fixtures ─────────────────────────────────────────────────────────
export const COURSE_GUARD_COLS = 'id, title, status, access, delivery, certification_id, created_by';
export const SESSION_GUARD_COLS = 'id, course_id, status, capacity, enrollment_open';
export const ENROLLMENT_GUARD_COLS = 'id, session_id, student_id, status';
export const COURSE_COLS = 'id, title, description, icon, image_url, status, access, delivery, certification_id, created_by, approved_by, published_at, sort_order, created_at, updated_at';
export const SESSION_COLS = 'id, course_id, title, status, starts_at, ends_at, location, capacity, enrollment_open, is_implicit, created_by, created_at, updated_at';
export const ENROLLMENT_COLS = 'id, session_id, student_id, source, status, assigned_by, recommended_by, recommended_at, certified_by, completed_at, enrolled_at';
export const MODULE_COLS = 'id, course_id, title, description, sort_order, created_at';
export const LESSON_COLS = 'id, module_id, title, content, video_url, sort_order, estimated_minutes, created_at';
export const OUTCOME_COLS = 'id, course_id, title, description, sort_order, required, created_at';
export const USER_REF_COLS = 'id, name, avatar_url, rsi_handle';
export const REQUEST_COLS = 'id, session_id, student_id, status, message, decided_by, decision_reason, decided_at, created_at';

export function courseGuardRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return { id: 'c1', title: 'Intro to SAR', status: 'draft', access: 'gated', delivery: 'cohort', certification_id: null, created_by: 10, ...over };
}
export function sessionGuardRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return { id: 's1', course_id: 'c1', status: 'scheduled', capacity: null, enrollment_open: true, ...over };
}
export function enrollmentGuardRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return { id: 'e1', session_id: 's1', student_id: 20, status: 'enrolled', ...over };
}
export function courseRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        id: 'c1', title: 'Intro to SAR', description: 'desc', icon: 'i', image_url: null, status: 'draft', access: 'gated',
        delivery: 'cohort', certification_id: null, created_by: 10, approved_by: null, published_at: null, sort_order: 0,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', ...over,
    };
}
export function sessionRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        id: 's1', course_id: 'c1', title: 'Cohort 1', status: 'scheduled', starts_at: null, ends_at: null, location: null,
        capacity: null, enrollment_open: true, is_implicit: false, created_by: 10,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
    };
}
export function enrollmentRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        id: 'e1', session_id: 's1', student_id: 20, source: 'self', status: 'enrolled', assigned_by: null, recommended_by: null,
        recommended_at: null, certified_by: null, completed_at: null, enrolled_at: '2026-01-03T00:00:00Z', ...over,
    };
}

/** Course guard (loadCourse) answers with this row. */
export function seedCourse(over: Partial<Record<string, unknown>> = {}): void {
    on('academy_courses', { kind: 'select', cols: COURSE_GUARD_COLS }, { data: courseGuardRow(over) });
}
export function seedSession(over: Partial<Record<string, unknown>> = {}): void {
    on('academy_sessions', { kind: 'select', cols: SESSION_GUARD_COLS }, { data: sessionGuardRow(over) });
}
export function seedEnrollment(over: Partial<Record<string, unknown>> = {}): void {
    on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_GUARD_COLS }, { data: enrollmentGuardRow(over) });
}
/** isCourseInstructor(courseId, userId) → true for this pairing. */
export function seedCourseInstructor(courseId: string, userId: number): void {
    on('academy_course_instructors', { kind: 'select', cols: 'id', eq: { course_id: courseId, user_id: userId } }, { data: { id: 1 } });
}
export function seedSessionInstructor(sessionId: string, userId: number): void {
    on('academy_session_instructors', { kind: 'select', cols: 'id', eq: { session_id: sessionId, user_id: userId } }, { data: { id: 1 } });
}
