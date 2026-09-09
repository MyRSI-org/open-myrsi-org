import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// =============================================================================
// Academy v1.2 — curriculum ordering, enrolment requests, Learning-Manager reports
// =============================================================================
// The three things this file exists to stop coming back:
//
//  1. A REORDER THAT PARTIALLY APPLIES. The shape this replaced issued one UPDATE per
//     id from Node with no transaction, so a failure on the seventh of twelve left the
//     first six moved and told the caller it failed. Ordering is the operation where a
//     half-written state looks deliberate, so the write is a single database function
//     and there is no fallback when it is missing.
//
//  2. A REORDER THAT WRITES A SUBSET. Proving submitted-ids ⊆ parent is not proving
//     they are ALL of parent: two of twenty module ids written to positions 10 and 20
//     collide with the two modules already there, which are not renumbered. The
//     function counts the siblings and rolls back if the array is not all of them.
//
//  3. A REPORT THAT LEAKS OR LIES. Reports project other people's training records to
//     a manager; every one is behind academy:manage, returns a named projection, and
//     says so when a capped scan makes its numbers a floor rather than a total.

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Blank comments length-preservingly. Every index/`includes` assertion below runs on
 *  this, so a pin can never be satisfied by the prose that explains it — the
 *  self-match trap that has produced a green-but-vacuous test in three prior phases. */
function codeOnly(s: string): string {
    let out = '', i = 0, mode: string | null = null;
    const BACKSLASH = String.fromCharCode(92);
    while (i < s.length) {
        const c = s[i], n = s[i + 1];
        if (mode === null) {
            if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
            if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
            if (c === '`' || c === "'" || c === '"') { mode = c; out += c; i++; continue; }
            out += c; i++; continue;
        }
        if (mode === 'line') { if (c === '\n') { mode = null; out += c; } else out += ' '; i++; continue; }
        if (mode === 'block') { if (c === '*' && n === '/') { mode = null; out += '  '; i += 2; continue; } out += (c === '\n' ? c : ' '); i++; continue; }
        if (c === BACKSLASH) { out += c + (s[i + 1] || ''); i += 2; continue; }
        if (c === mode) { mode = null; out += c; i++; continue; }
        out += c; i++;
    }
    return out;
}

/** Strip `--` line comments from SQL, length-preservingly, for the same reason. */
function sqlCodeOnly(s: string): string {
    return s.split('\n').map(line => {
        const i = line.indexOf('--');
        return i === -1 ? line : line.slice(0, i) + ' '.repeat(line.length - i);
    }).join('\n');
}

/** Forward slice between two anchors, refusing to run backwards. `slice(indexOf(A),
 *  indexOf(B))` with B before A yields '' and every assertion on it passes vacuously —
 *  that has silently disarmed the single highest-value pin in two earlier phases. */
function between(src: string, a: string, b: string): string {
    const i = src.indexOf(a);
    expect(i, `anchor missing: ${a}`).toBeGreaterThan(-1);
    const j = src.indexOf(b, i + a.length);
    expect(j, `anchor missing after ${a}: ${b}`).toBeGreaterThan(i);
    const slice = src.slice(i, j);
    expect(slice.length, `slice ${a} → ${b} reached no code`).toBeGreaterThan(a.length);
    return slice;
}

// ── Behavioural harness ──────────────────────────────────────────────────────
// Same shape as tests/academySecurity.test.ts, plus per-table call recording so the
// server-side CLAMPS (limit / order) can be asserted rather than assumed.
const h = vi.hoisted(() => {
    const rows = new Map<string, unknown>();
    const lists = new Map<string, unknown[]>();
    const counts = new Map<string, number>();
    const writes: Array<{ table: string; op: string; arg: unknown }> = [];
    const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
    const makeBuilder = (table: string) => {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'neq', 'not', 'is', 'order', 'limit', 'range', 'gte', 'lte', 'upsert']) {
            b[m] = (...args: unknown[]) => { calls.push({ table, method: m, args }); return b; };
        }
        for (const m of ['insert', 'update', 'delete']) b[m] = (arg: unknown) => { writes.push({ table, op: m, arg }); return b; };
        b.maybeSingle = async () => ({ data: rows.get(table) ?? null, error: null });
        b.single = async () => ({ data: rows.get(table) ?? null, error: null });
        b.then = (resolve2: (v: unknown) => unknown) => resolve2({ data: lists.get(table) ?? [], error: null, count: counts.get(table) ?? 0 });
        return b;
    };
    const rpcCalls: Array<{ fn: string; args: unknown }> = [];
    const rpcResult = { data: null as unknown, error: null as unknown };
    const supabaseStub = {
        from: (t: string) => makeBuilder(t),
        rpc: async (fn: string, args: unknown) => { rpcCalls.push({ fn, args }); return { data: rpcResult.data, error: rpcResult.error }; },
    };
    return { rows, lists, counts, writes, calls, supabaseStub, rpcCalls, rpcResult };
});

vi.mock('../lib/db/common.js', () => ({
    supabase: h.supabaseStub,
    handleSupabaseError: ({ error, message }: { error: unknown; message?: string }) => {
        if (error) throw new Error(message || 'db error');
    },
    broadcastToOrg: () => Promise.resolve(),
    getSystemRoles: async () => ({}),
    safeFetch: async (query: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
        const { data, error } = await query; return error ? fallback : (data ?? fallback);
    },
}));
vi.mock('../lib/db/system.js', () => ({
    awardCertification: async () => undefined,
    getOrgFeatures: async () => ({ academy: { enabled: true } }),
}));
vi.mock('../lib/db/notifications.js', () => ({ createNotification: async () => null }));

import {
    reorderModules, reorderLessons, reorderOutcomes,
    createModule, updateModule, requestEnrollment,
    reportCompletions, reportMemberTranscript, reportCourseActivity, listEnrollmentRequests,
} from '../lib/db/academy';
import { SecurityDenial } from '../lib/errors';

const COURSE_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
    h.rows.clear(); h.lists.clear(); h.counts.clear();
    h.writes.length = 0; h.calls.length = 0;
    h.rpcCalls.length = 0; h.rpcResult.data = null; h.rpcResult.error = null;
    // A live, editable course so assertCanEditCourse passes with canManage=true.
    h.rows.set('academy_courses', { id: COURSE_ID, title: 'Ops 101', status: 'draft', access: 'gated', delivery: 'cohort' });
});

const ACADEMY_SRC = codeOnly(read('lib/db/academy.ts'));
const SCHEMA_SRC = sqlCodeOnly(read('schema.sql'));
const SERVICES_SRC = codeOnly(read('api/services.ts'));
const ACTIONS_SRC = codeOnly(read('api/actions/academy.ts'));

// ════════════════════════════════════════════════════════════════════════════
describe('curriculum ordering is atomic', () => {
    it('the reorder path writes through the database function and nothing else', async () => {
        await reorderModules(COURSE_ID, [3, 1, 2], 7, true);
        expect(h.rpcCalls).toHaveLength(1);
        expect(h.rpcCalls[0].fn).toBe('academy_apply_order');
        expect(h.rpcCalls[0].args).toEqual({ p_entity: 'modules', p_parent: COURSE_ID, p_ids: [3, 1, 2] });
        // The whole point: no per-id UPDATE survived the port.
        expect(h.writes).toEqual([]);
    });

    it('the reorder section of the source contains no table write at all', () => {
        // Ends at SessionInput, NOT at reorderOutcomes: a slice that stops before the
        // last of the three reorder functions leaves that one unpinned, which is exactly
        // what the red-check caught on the first pass.
        const section = between(ACADEMY_SRC, 'const MAX_REORDER = 200;', 'export interface SessionInput');
        expect(section).toContain("supabase.rpc('academy_apply_order'");
        expect(section).not.toContain('.update(');
        expect(section).not.toContain('sort_order');
        // A Promise.all over ids is the exact non-atomic shape being refused.
        expect(section).not.toContain('Promise.all');
    });

    it('lessons reorder resolves the owning course and passes the module as the parent', async () => {
        h.rows.set('academy_modules', { course_id: COURSE_ID });
        await reorderLessons(42, [9, 8], 7, true);
        expect(h.rpcCalls[0].args).toEqual({ p_entity: 'lessons', p_parent: '42', p_ids: [9, 8] });
    });

    it('outcomes reorder targets its own entity', async () => {
        await reorderOutcomes(COURSE_ID, [5], 7, true);
        expect(h.rpcCalls[0].args).toEqual({ p_entity: 'outcomes', p_parent: COURSE_ID, p_ids: [5] });
    });

    for (const code of ['42883', 'PGRST202']) {
        it(`fails closed when the function is missing (${code}) rather than falling back`, async () => {
            h.rpcResult.error = { code, message: 'function does not exist' };
            await expect(reorderModules(COURSE_ID, [1, 2], 7, true)).rejects.toThrow(/schema\.sql is re-applied/i);
            expect(h.writes, 'a missing function must not fall back to per-id updates').toEqual([]);
        });
    }

    it('a subset submission surfaces as "send every sibling", not a silent partial write', async () => {
        h.rpcResult.error = { code: 'P0001', message: 'ACADEMY_ORDER_INCOMPLETE: 2 ids submitted for 20 siblings' };
        await expect(reorderModules(COURSE_ID, [1, 2], 7, true)).rejects.toThrow(/complete list/i);
    });

    it('a foreign or duplicated id is a security denial', async () => {
        h.rpcResult.error = { code: 'P0001', message: 'ACADEMY_ORDER_FOREIGN: 1 of 2 ids belong to this parent' };
        await expect(reorderModules(COURSE_ID, [1, 999], 7, true)).rejects.toBeInstanceOf(SecurityDenial);
    });

    it('an unrelated database fault is not dressed up as one of those', async () => {
        h.rpcResult.error = { code: '08006', message: 'connection failure' };
        await expect(reorderModules(COURSE_ID, [1], 7, true)).rejects.toThrow(/Failed to reorder/);
    });
});

describe('the ordered id list is rejected, never repaired', () => {
    const bad: Array<[string, unknown]> = [
        ['an empty list', []],
        ['a non-array', 'nope'],
        ['a null', null],
        ['over the 200 cap', Array.from({ length: 201 }, (_, i) => i + 1)],
        ['a duplicate id', [1, 2, 1]],
        ['a non-integer', [1, 2.5]],
        ['a zero id', [0, 1]],
        ['a negative id', [-1]],
        ['a string id', [1, '2']],
    ];
    for (const [label, input] of bad) {
        it(`refuses ${label} without reaching the database`, async () => {
            await expect(reorderModules(COURSE_ID, input, 7, true)).rejects.toThrow();
            expect(h.rpcCalls, `${label} must not reach the write`).toEqual([]);
            expect(h.writes).toEqual([]);
        });
    }

    it('an unauthorised caller never reaches the write, valid list or not', async () => {
        h.lists.set('academy_course_instructors', []);
        await expect(reorderModules(COURSE_ID, [1, 2], 7, false)).rejects.toBeInstanceOf(SecurityDenial);
        expect(h.rpcCalls).toEqual([]);
    });
});

describe('academy_apply_order (schema.sql)', () => {
    const fn = between(SCHEMA_SRC, 'CREATE OR REPLACE FUNCTION public.academy_apply_order', 'GRANT EXECUTE ON FUNCTION public.academy_apply_order');

    it('is granted to service_role — without it the function is a 42501 at runtime', () => {
        expect(SCHEMA_SRC).toContain('GRANT EXECUTE ON FUNCTION public.academy_apply_order(text, text, bigint[]) TO service_role;');
    });

    it('handles exactly the three curriculum entities and refuses anything else', () => {
        expect(fn).toContain("IF p_entity = 'modules' THEN");
        expect(fn).toContain("ELSIF p_entity = 'lessons' THEN");
        expect(fn).toContain("ELSIF p_entity = 'outcomes' THEN");
        expect(fn).toContain('ACADEMY_ORDER_ENTITY');
    });

    it('counts the parent’s children and refuses a partial list, per entity', () => {
        for (const table of ['academy_modules', 'academy_lessons', 'academy_outcomes']) {
            expect(fn, `${table} must be counted before it is rewritten`)
                .toContain(`SELECT count(*) INTO v_total FROM public.${table}`);
        }
        expect(fn.match(/ACADEMY_ORDER_INCOMPLETE/g) || []).toHaveLength(3);
        expect(fn.match(/v_total <> v_count/g) || []).toHaveLength(3);
    });

    it('re-spaces every sibling in ONE statement per entity', () => {
        expect(fn.match(/UPDATE public\.academy_(modules|lessons|outcomes)/g) || []).toHaveLength(3);
        expect(fn.match(/unnest\(p_ids\) WITH ORDINALITY/g) || []).toHaveLength(3);
        expect(fn.match(/GET DIAGNOSTICS v_written = ROW_COUNT/g) || []).toHaveLength(3);
    });

    it('re-scopes every UPDATE by the parent, so an id alone cannot move a foreign row', () => {
        expect(fn).toContain('m.course_id = p_parent::uuid');
        expect(fn).toContain('l.module_id = p_parent::bigint');
        expect(fn).toContain('x.course_id = p_parent::uuid');
    });

    it('compares rows written against ids sent, which is what rolls a foreign or duplicated id back', () => {
        expect(fn).toContain('IF v_written <> v_count THEN');
        expect(fn).toContain('ACADEMY_ORDER_FOREIGN');
    });

    it('refuses an empty array outright', () => {
        expect(fn).toContain('ACADEMY_ORDER_EMPTY');
    });

    it('spaces positions by the same step the TypeScript layer uses', () => {
        // If these drift, insert-between stops landing in the gap the comment promises.
        expect(ACADEMY_SRC).toContain('const SORT_STEP = 10;');
        expect(fn.match(/\(o\.pos \* 10\)::integer/g) || []).toHaveLength(3);
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('sort_order is validated, never coerced', () => {
    it('a new module APPENDS after the current maximum instead of piling onto 0', async () => {
        h.rows.set('academy_modules', { sort_order: 40 });
        await createModule(COURSE_ID, 7, true, { title: 'Module 5' });
        const insert = h.writes.find(w => w.table === 'academy_modules' && w.op === 'insert');
        expect((insert?.arg as { sort_order: number }).sort_order).toBe(50);
    });

    it('the first module of a course starts at the step, not at zero', async () => {
        // sort_order 0 is what an empty parent reads back as; the append must clear it.
        h.rows.set('academy_modules', { id: 1, course_id: COURSE_ID, title: 'M', sort_order: 0 });
        await createModule(COURSE_ID, 7, true, { title: 'Module 1' });
        const insert = h.writes.find(w => w.table === 'academy_modules' && w.op === 'insert');
        expect((insert?.arg as { sort_order: number }).sort_order).toBe(10);
    });

    it('an explicit position is honoured exactly', async () => {
        h.rows.set('academy_modules', { id: 1, course_id: COURSE_ID, title: 'M', sort_order: 0 });
        await createModule(COURSE_ID, 7, true, { title: 'M', sortOrder: 25 });
        const insert = h.writes.find(w => w.table === 'academy_modules' && w.op === 'insert');
        expect((insert?.arg as { sort_order: number }).sort_order).toBe(25);
    });

    for (const badOrder of [-1, 1.5, 2_000_000, Number.NaN]) {
        it(`refuses an explicit position of ${String(badOrder)} rather than substituting one`, async () => {
            await expect(createModule(COURSE_ID, 7, true, { title: 'M', sortOrder: badOrder })).rejects.toThrow(/whole number/i);
            expect(h.writes.filter(w => w.op === 'insert')).toEqual([]);
        });
        it(`refuses the same on update (${String(badOrder)})`, async () => {
            h.rows.set('academy_modules', { course_id: COURSE_ID });
            await expect(updateModule(5, 7, true, { sortOrder: badOrder })).rejects.toThrow(/whole number/i);
            expect(h.writes.filter(w => w.op === 'update')).toEqual([]);
        });
    }

    it('0 stays a legal position — it is the front of the list, not a missing value', async () => {
        h.rows.set('academy_modules', { course_id: COURSE_ID });
        await updateModule(5, 7, true, { sortOrder: 0 });
        const update = h.writes.find(w => w.op === 'update');
        expect((update?.arg as { sort_order: number }).sort_order).toBe(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('enrolment requests', () => {
    it('an OPEN course refuses the ask — there is nothing to approve', async () => {
        h.rows.set('academy_sessions', { id: 's1', course_id: COURSE_ID, status: 'scheduled', enrollment_open: true, capacity: null });
        h.rows.set('academy_courses', { id: COURSE_ID, title: 'Ops 101', status: 'published', access: 'open', delivery: 'cohort' });
        await expect(requestEnrollment('s1', 42)).rejects.toThrow(/enrol directly/i);
        expect(h.writes).toEqual([]);
    });

    it('a session that is not accepting enrolments refuses the ask', async () => {
        h.rows.set('academy_sessions', { id: 's1', course_id: COURSE_ID, status: 'cancelled', enrollment_open: true, capacity: null });
        h.rows.set('academy_courses', { id: COURSE_ID, title: 'Ops 101', status: 'published', access: 'gated', delivery: 'cohort' });
        await expect(requestEnrollment('s1', 42)).rejects.toThrow(/not accepting enrolments/i);
        expect(h.writes).toEqual([]);
    });

    it('an unpublished course is not an existence oracle', async () => {
        h.rows.set('academy_sessions', { id: 's1', course_id: COURSE_ID, status: 'scheduled', enrollment_open: true, capacity: null });
        h.rows.set('academy_courses', { id: COURSE_ID, title: 'Ops 101', status: 'draft', access: 'gated', delivery: 'cohort' });
        await expect(requestEnrollment('s1', 42)).rejects.toBeInstanceOf(SecurityDenial);
    });

    // The announcement is once-ever per pairing, and that is the ONLY thing bounding a
    // fan-out to every session instructor and academy manager. A member can re-ask
    // after a denial or a withdrawal as often as they like (deliberate), so if the
    // once-ever probe can be made to answer "never announced" the ask becomes a
    // member-triggerable notification amplifier.
    //
    // These replace a pin that asserted only `expect(section).toContain('notified_at')`
    // — true of the broken code, true of the fixed code, and true of a comment. It was
    // green while the probe read ONE row ordered by `id`, which is
    // `uuid DEFAULT gen_random_uuid()` (schema.sql:2629): a random key, so which row
    // came back was a coin toss across a member's accumulated requests.
    const gatedSession = () => {
        h.rows.set('academy_sessions', { id: 's1', course_id: COURSE_ID, status: 'scheduled', enrollment_open: true, capacity: null });
        h.rows.set('academy_courses', { id: COURSE_ID, title: 'Ops 101', status: 'published', access: 'gated', delivery: 'cohort' });
        // The row the insert's .select(...).single() reads back, so the mapper has
        // something to map. The ASSERTION is on the insert argument, not on this.
        h.rows.set('academy_enrollment_requests', {
            id: 'r1', session_id: 's1', student_id: 42, status: 'pending', message: null,
            decided_by: null, decision_reason: null, decided_at: null, created_at: '2026-01-01T00:00:00Z',
        });
    };
    const insertedRequest = () => h.writes.find((w) => w.table === 'academy_enrollment_requests' && w.op === 'insert')
        ?.arg as { notified_at: string | null } | undefined;

    it('a pairing announced before does NOT re-stamp, however many rows it has', async () => {
        gatedSession();
        // History contains a stamped row. Under the old ordering-by-random-uuid read this
        // was a coin toss; the probe now filters on the stamp, so history size and order
        // are irrelevant.
        h.lists.set('academy_enrollment_requests', [{ id: 'aaaa' }]);
        await requestEnrollment('s1', 42);
        expect(insertedRequest()?.notified_at).toBeNull();
    });

    it('a pairing never announced DOES stamp, so the first ask still notifies', async () => {
        gatedSession();
        h.lists.set('academy_enrollment_requests', []);
        await requestEnrollment('s1', 42);
        expect(insertedRequest()?.notified_at).toEqual(expect.any(String));
    });

    it('asks the question as an existence test, not by reading one row and inspecting it', async () => {
        gatedSession();
        h.lists.set('academy_enrollment_requests', []);
        await requestEnrollment('s1', 42);
        // The probe must FILTER on the stamp. A read that selects notified_at and then
        // inspects the returned row is the shape that made the answer depend on which
        // arbitrary row the database happened to return.
        const probeFilters = h.calls.filter((c) => c.table === 'academy_enrollment_requests' && c.method === 'not');
        expect(probeFilters.some((c) => c.args[0] === 'notified_at' && c.args[1] === 'is' && c.args[2] === null),
            'the once-ever probe no longer filters on notified_at').toBe(true);
    });

    it('an unreadable history SUPPRESSES the fan-out rather than re-firing it', () => {
        // Fail-closed direction matters here and is the opposite of most reads: this one
        // gates an amplifier, so "I could not tell" must never read as "never announced".
        const section = between(ACADEMY_SRC, 'export async function requestEnrollment', 'export async function withdrawEnrollmentRequest');
        expect(section).toContain('priorErr');
        expect(section).toMatch(/alreadyAnnounced\s*=\s*priorErr\s*\?\s*true/);
    });

    it('the student is the caller — no studentId is accepted from the payload', () => {
        const handlers = between(ACTIONS_SRC, "'academy:request_enrollment'", "'academy:decide_enrollment_request'");
        expect(handlers).toContain('db.requestEnrollment(sessionId, userId, message)');
        expect(handlers).not.toContain('studentId');
    });

    it('asking is self-service; deciding and the queue are not', () => {
        expect(SERVICES_SRC).toContain("'academy:request_enrollment': 'user:manage:self',");
        expect(SERVICES_SRC).toContain("'academy:withdraw_enrollment_request': 'user:manage:self',");
        expect(SERVICES_SRC).toContain("'academy:list_my_enrollment_requests': 'user:manage:self',");
        expect(SERVICES_SRC).toContain("'academy:decide_enrollment_request': 'academy:instruct',");
        expect(SERVICES_SRC).toContain("'academy:list_enrollment_requests': 'academy:instruct',");
    });

    it('holding academy:instruct is not enough — the decider must run THIS session', () => {
        const section = between(ACADEMY_SRC, 'export async function decideEnrollmentRequest', 'export async function listEnrollmentRequests');
        expect(section).toContain('assertCanRunSession(req.session_id');
        // CAS on the pending row: two approvers cannot both claim the seat.
        expect(section).toContain(".eq('status', 'pending')");
        expect(section).toContain('already been decided');
    });

    it('an approval claims its seat under the same capacity lock as any other', () => {
        const section = between(ACADEMY_SRC, 'export async function decideEnrollmentRequest', 'export async function listEnrollmentRequests');
        expect(section).toContain("supabase.rpc('academy_claim_seat'");
        expect(section).not.toContain("from('academy_enrollments').insert");
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('Learning-Manager reports', () => {
    it('every report is gated academy:manage', () => {
        for (const action of [
            'academy:report_completions', 'academy:report_course_activity',
            'academy:report_cert_holders', 'academy:report_member_transcript',
        ]) {
            expect(SERVICES_SRC, `${action} must be manager-gated`).toContain(`'${action}': 'academy:manage',`);
        }
    });

    it('the caller asks for a window; the server decides it', async () => {
        h.lists.set('academy_enrollments', []);
        await reportCompletions({ sinceDays: 99999, limit: 100000 });
        const limits = h.calls.filter(c => c.table === 'academy_enrollments' && c.method === 'limit');
        expect(limits).toHaveLength(1);
        expect(limits[0].args[0]).toBe(500);          // MAX_LIST, not the 100000 asked for
        const gte = h.calls.find(c => c.method === 'gte');
        const since = new Date(String(gte?.args[1]));
        const days = (Date.now() - since.getTime()) / 86_400_000;
        expect(days).toBeGreaterThan(729);
        expect(days).toBeLessThan(731);               // clamped to 730, not 99999
    });

    it('a nonsense window falls back to the default rather than to "everything"', async () => {
        h.lists.set('academy_enrollments', []);
        await reportCompletions({ sinceDays: 'all', limit: -5 });
        const limits = h.calls.filter(c => c.table === 'academy_enrollments' && c.method === 'limit');
        expect(limits[0].args[0]).toBe(1);             // floor, never unbounded
        const gte = h.calls.find(c => c.method === 'gte');
        const days = (Date.now() - new Date(String(gte?.args[1])).getTime()) / 86_400_000;
        expect(days).toBeGreaterThan(89);
        expect(days).toBeLessThan(91);
    });

    it('a truncated scan is reported as a floor, not presented as the total', async () => {
        h.lists.set('academy_courses', [{ id: COURSE_ID, title: 'Ops 101', status: 'published', delivery: 'cohort' }]);
        h.lists.set('academy_sessions', [{ id: 's1', course_id: COURSE_ID, is_implicit: false }]);
        h.lists.set('academy_enrollments', Array.from({ length: 5000 }, () => ({ session_id: 's1', status: 'enrolled', recommended_at: null })));
        const report = await reportCourseActivity();
        expect(report.truncated).toBe(true);
        expect(report.courses[0].enrolled).toBe(5000);
    });

    it('an untruncated scan does not cry wolf', async () => {
        h.lists.set('academy_courses', [{ id: COURSE_ID, title: 'Ops 101', status: 'published', delivery: 'cohort' }]);
        h.lists.set('academy_sessions', [{ id: 's1', course_id: COURSE_ID, is_implicit: false }]);
        h.lists.set('academy_enrollments', [
            { session_id: 's1', status: 'enrolled', recommended_at: '2026-01-01T00:00:00Z' },
            { session_id: 's1', status: 'completed', recommended_at: null },
            { session_id: 'ghost', status: 'enrolled', recommended_at: null },
        ]);
        const report = await reportCourseActivity();
        expect(report.truncated).toBe(false);
        expect(report.courses[0].sessions).toBe(1);
        expect(report.courses[0].enrolled).toBe(1);
        expect(report.courses[0].completed).toBe(1);
        // Same predicate as the sign-off queue, so the two screens agree.
        expect(report.courses[0].awaitingCertification).toBe(1);
        // An enrolment whose session belongs to no listed course is counted nowhere.
        expect(report.totalEnrollments).toBe(3);
    });

    it('an implicit self-paced pool is not counted as a scheduled session', async () => {
        h.lists.set('academy_courses', [{ id: COURSE_ID, title: 'Ops 101', status: 'published', delivery: 'self_paced' }]);
        h.lists.set('academy_sessions', [{ id: 's1', course_id: COURSE_ID, is_implicit: true }]);
        h.lists.set('academy_enrollments', []);
        const report = await reportCourseActivity();
        expect(report.courses[0].sessions).toBe(0);
    });

    it('the transcript proves its target is a real member before reading anything', async () => {
        h.rows.set('users', null);
        await expect(reportMemberTranscript(4242)).rejects.toBeInstanceOf(SecurityDenial);
        expect(h.calls.some(c => c.table === 'academy_enrollments'), 'no enrolment row may be read for an invalid target').toBe(false);
    });

    for (const badTarget of [0, -1, 1.5, Number.NaN]) {
        it(`refuses a target id of ${String(badTarget)}`, async () => {
            await expect(reportMemberTranscript(badTarget)).rejects.toThrow(/targetUserId is required/);
            expect(h.calls).toEqual([]);
        });
    }

    it('reports project named fields — no row is passed through', () => {
        const section = between(ACADEMY_SRC, 'export async function reportCertificationHolders', 'export async function getMyAcademyState');
        expect(section).not.toContain('...r,');
        expect(section).not.toContain('...row');
        expect(section).not.toContain("select('*')");
        // Identity stays roster-safe: no contact or clearance field is projected.
        for (const leak of ['email', 'discord_id', 'clearance', 'phone']) {
            expect(section, `${leak} must not appear in a report projection`).not.toContain(leak);
        }
    });
});

describe('the session-authority gate actually DENIES, and is exercised doing it', () => {
    // assertCanRunSession's deny branch was never executed by any test, and the read
    // path it gates — listEnrollmentRequests — had no test of any kind. A guard nothing
    // ever runs is a guard nobody notices losing: the enrolment queue carries other
    // members' names and their stated reasons for asking, so a silent regression here
    // hands the roster's training intentions to any academy:instruct holder in the org
    // rather than the instructors of THAT session.
    const seedSession = () => {
        h.rows.set('academy_sessions', { id: 's1', course_id: COURSE_ID, status: 'scheduled', enrollment_open: true, capacity: null });
        h.rows.set('academy_courses', { id: COURSE_ID, title: 'Ops 101', status: 'published', access: 'gated', delivery: 'cohort' });
    };

    it('refuses a holder of academy:instruct who does not run THIS session', async () => {
        seedSession();
        // No instructor rows seeded, canManage false -> every arm of the guard fails.
        await expect(listEnrollmentRequests('s1', 4242, false)).rejects.toBeInstanceOf(SecurityDenial);
    });

    it('and reads NOTHING before it refuses', async () => {
        seedSession();
        await listEnrollmentRequests('s1', 4242, false).catch(() => undefined);
        expect(h.calls.some((c) => c.table === 'academy_enrollment_requests'),
            'the queue was read before the authority check').toBe(false);
    });

    it('an academy:manage holder is let through', async () => {
        seedSession();
        h.lists.set('academy_enrollment_requests', []);
        await expect(listEnrollmentRequests('s1', 4242, true)).resolves.toEqual([]);
    });

    it('a session instructor is let through without academy:manage', async () => {
        seedSession();
        h.rows.set('academy_session_instructors', { session_id: 's1', user_id: 77 });
        h.lists.set('academy_enrollment_requests', []);
        await expect(listEnrollmentRequests('s1', 77, false)).resolves.toEqual([]);
    });

    it('the queue read is capped and totally ordered', async () => {
        seedSession();
        h.lists.set('academy_enrollment_requests', []);
        await listEnrollmentRequests('s1', 4242, true);
        const q = h.calls.filter((c) => c.table === 'academy_enrollment_requests');
        expect(q.some((c) => c.method === 'limit')).toBe(true);
        expect(q.some((c) => c.method === 'order' && c.args[0] === 'id')).toBe(true);
    });
});
