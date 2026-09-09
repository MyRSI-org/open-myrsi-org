import { describe, it, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// Academy (LMS) — security regressions (single-org)
// =============================================================================
// Behaviour-true-ish Supabase stub: each .from(table) returns a chainable builder
// whose terminal maybeSingle()/single() resolve to a per-table seeded ROW, and
// whose bare-await resolves to a per-table seeded LIST + COUNT. Tests seed
// h.rows / h.lists / h.counts to steer the academy guards under test.
// academy.ts imports supabase/handleSupabaseError/broadcastToOrg from './common.js'
// and awardCertification/getOrgFeatures from './system.js', createNotification from
// './notifications.js' — all mocked here (SecurityDenial comes from the real errors).
//
// Single-org: the multi-tenant "requires organizationId (fail closed)" cases are GONE
// (there is no org param). What remains — the cert-award escalation double gate,
// self-enrol gating + capacity, and resource-BOLA — are the load-bearing controls.
const h = vi.hoisted(() => {
    const rows = new Map<string, unknown>();
    const lists = new Map<string, unknown[]>();
    const counts = new Map<string, number>();
    const rowErrors = new Map<string, unknown>();
    // Phase 3 item 5 / TG-4: `insert` returns the chainable builder, so
    // `await expect(fn()).rejects` proves NOTHING about whether a row was written. Record
    // every write op explicitly and assert on THAT.
    const writes: Array<{ table: string; op: string; arg: unknown }> = [];
    const makeBuilder = (table: string) => {
        const b: Record<string, unknown> = {};
        const chain = () => b;
        for (const m of ['select', 'eq', 'in', 'neq', 'not', 'is', 'order', 'limit', 'range', 'upsert']) b[m] = chain;
        for (const m of ['insert', 'update', 'delete']) b[m] = (arg: unknown) => { writes.push({ table, op: m, arg }); return b; };
        // rowErrors lets a test drive a READ FAULT on one table. Needed because a guard
        // that destructures only `data` reads a fault as "the check passed" — the
        // fail-open E9 pins against.
        b.maybeSingle = async () => ({ data: rows.get(table) ?? null, error: rowErrors.get(table) ?? null });
        b.single = async () => ({ data: rows.get(table) ?? null, error: rowErrors.get(table) ?? null });
        b.then = (resolve: (v: unknown) => unknown) => resolve({ data: lists.get(table) ?? [], error: null, count: counts.get(table) ?? 0 });
        return b;
    };
    // Capacity is no longer counted in TS — it is decided inside academy_claim_seat,
    // under FOR UPDATE. rpcResult lets a test drive what the function decided, and
    // rpcCalls proves the claim went through it rather than through a bare insert.
    const rpcCalls: Array<{ fn: string; args: unknown }> = [];
    const rpcResult = { data: null as unknown, error: null as unknown };
    const supabaseStub = {
        from: (t: string) => makeBuilder(t),
        rpc: async (fn: string, args: unknown) => { rpcCalls.push({ fn, args }); return { data: rpcResult.data, error: rpcResult.error }; },
    };
    // Award stub lives inside vi.hoisted so it's initialised before the hoisted
    // vi.mock factory below references it.
    const awardCertification = vi.fn(async () => undefined);
    // Phase 3 item 5: the academy notification body carries the course TITLE, which is
    // the content a Client is denied — so the client-target guards must be asserted to
    // stop BEFORE this fires, not merely to reject.
    const createNotification = vi.fn(async () => null);
    return { rows, lists, counts, rowErrors, writes, supabaseStub, rpcCalls, rpcResult, awardCertification, createNotification, sysRoles: {} as Record<string, { id: number }> };
});

vi.mock('../lib/db/common.js', () => ({
    supabase: h.supabaseStub,
    handleSupabaseError: ({ error }: { error: unknown }) => { if (error) throw error; },
    broadcastToOrg: () => Promise.resolve(),
    // Phase 3 item 5: lib/db/academy.ts now imports requireClientRoleId from
    // './clientRoleLock.js', which imports { supabase, getSystemRoles } from './common.js'
    // BY NAME. Without this key the named import resolves against a mock that does not
    // define it and the whole file fails to LINK — a module-graph failure that reads like
    // a clientRoleLock bug, not a missing stub. Steerable via h.sysRoles so the
    // fail-closed case (an unresolvable Client slot) can be driven by setting it to {}.
    getSystemRoles: async () => h.sysRoles,
    safeFetch: async (query: PromiseLike<{ data: unknown; error: unknown }>, fallback: unknown) => {
        const { data, error } = await query; return error ? fallback : (data ?? fallback);
    },
}));
// Stub the award path — the escalation tests deny BEFORE it would ever be called;
// the idempotency test asserts it is NOT called for an already-completed enrolment.
vi.mock('../lib/db/system.js', () => ({
    awardCertification: h.awardCertification,
    getOrgFeatures: async () => ({ academy: { enabled: true } }),
}));
vi.mock('../lib/db/notifications.js', () => ({ createNotification: h.createNotification }));

import {
    setCourseCertification, certifyAndComplete, updateCourse, selfEnroll, assignStudents,
} from '../lib/db/academy';
import { SecurityDenial } from '../lib/errors';

beforeEach(() => {
    h.rows.clear(); h.lists.clear(); h.counts.clear(); h.rowErrors.clear(); h.writes.length = 0;
    h.rpcCalls.length = 0; h.rpcResult.data = null; h.rpcResult.error = null;
    h.awardCertification.mockClear();
    h.createNotification.mockClear();
    // Resolvable by default; a test that needs the fail-closed branch sets h.sysRoles = {}.
    h.sysRoles = { client: { id: 1 }, member: { id: 2 } };
});

/** TG-4: the stub's `insert` returns the chainable builder, so a rejected promise proves
 *  nothing about whether a row was written. Assert on the recorded writes instead. */
const enrollmentInserts = () => h.writes.filter(w => w.table === 'academy_enrollments' && w.op === 'insert');
const enrollmentUpdates = () => h.writes.filter(w => w.table === 'academy_enrollments' && w.op === 'update');

// The novel control: linking OR awarding a course certification requires
// admin:award:certification (canAward), composed on top of academy:manage.
describe('academy — certification-award escalation gate', () => {
    it('setCourseCertification denies without cert-award authority', async () => {
        h.rows.set('academy_courses', { id: 'c1', status: 'draft', access: 'gated', delivery: 'cohort', certification_id: null, created_by: 1 });
        await expect(setCourseCertification('c1', 9, 1, /* canAward */ false))
            .rejects.toThrow(/Award Certification permission/);
    });

    it('certifyAndComplete denies awarding a cert without cert-award authority', async () => {
        h.rows.set('academy_enrollments', { id: 'e1', session_id: 's1', student_id: 2, status: 'in_progress' });
        h.rows.set('academy_sessions', { id: 's1', course_id: 'c1', status: 'in_progress', capacity: null, enrollment_open: true });
        h.rows.set('academy_courses', { id: 'c1', status: 'published', access: 'gated', delivery: 'cohort', certification_id: 9, created_by: 1 });
        h.lists.set('academy_outcomes', []); // no required outcomes → allRequiredOutcomesCompetent() true
        // Seed the student. The D12 tier guard sits ABOVE this privilege gate and now
        // fails closed on an unresolvable student row, so without a seeded user this test
        // would trip that guard instead and assert nothing about cert-award authority.
        h.rows.set('users', { id: 2, role_id: 2 });
        await expect(certifyAndComplete('e1', 1, /* canAward */ false))
            .rejects.toThrow(/Award Certification permission/);
        expect(h.awardCertification).not.toHaveBeenCalled();
    });
});

// A2 idempotency (belt-and-braces): certifying an ALREADY-completed enrolment is a
// no-op — it must not re-award the certification.
describe('academy — certify idempotency', () => {
    it('certifyAndComplete no-ops (no re-award) on an already-completed enrolment', async () => {
        h.rows.set('academy_enrollments', { id: 'e1', session_id: 's1', student_id: 2, status: 'completed' });
        h.rows.set('academy_sessions', { id: 's1', course_id: 'c1', status: 'in_progress', capacity: null, enrollment_open: true });
        h.rows.set('academy_courses', { id: 'c1', status: 'published', access: 'gated', delivery: 'cohort', certification_id: 9, created_by: 1 });
        await expect(certifyAndComplete('e1', 1, /* canAward */ true)).resolves.toBeUndefined();
        expect(h.awardCertification).not.toHaveBeenCalled();
    });
});

// Resource-BOLA: a by-id write on a resource that doesn't exist (a would-be
// foreign id under multi-tenancy) is denied — loadCourse returns nothing →
// SecurityDenial, even for a manager.
describe('academy — resource BOLA', () => {
    it('updateCourse denies an unknown course', async () => {
        h.rows.set('academy_courses', null);
        await expect(updateCourse('missing-course', 1, /* canManage */ true, { title: 'x' }))
            .rejects.toBeInstanceOf(SecurityDenial);
    });
});

// Self-enrol respects course gating + session capacity (server-enforced, never just UI).
describe('academy — self-enrol gating + capacity', () => {
    it('denies self-enrol into a gated course', async () => {
        h.rows.set('academy_sessions', { id: 's1', course_id: 'c1', status: 'scheduled', capacity: null, enrollment_open: true });
        h.rows.set('academy_courses', { id: 'c1', status: 'published', access: 'gated', delivery: 'cohort', certification_id: null, created_by: 1 });
        await expect(selfEnroll('s1', 2)).rejects.toThrow(/not open for self-enrolment/);
    });

    it('claims the seat through the ATOMIC function, never a bare insert', async () => {
        // The count-then-insert this replaced could overfill a capped session by the
        // number of concurrent claimants: the UNIQUE constraint stops the same student
        // twice, not two different students racing for the last seat.
        h.rows.set('academy_sessions', { id: 's1', course_id: 'c1', status: 'scheduled', capacity: 5, enrollment_open: true });
        h.rows.set('academy_courses', { id: 'c1', status: 'published', access: 'open', delivery: 'cohort', certification_id: null, created_by: 1 });
        await selfEnroll('s1', 2);
        expect(h.rpcCalls.map((c) => c.fn)).toContain('academy_claim_seat');
        expect(h.writes.filter((w) => w.table === 'academy_enrollments' && w.op === 'insert'),
            'the enrolment must not be written outside the lock').toEqual([]);
    });

    it('surfaces the capacity refusal the function raises', async () => {
        h.rows.set('academy_sessions', { id: 's1', course_id: 'c1', status: 'scheduled', capacity: 1, enrollment_open: true });
        h.rows.set('academy_courses', { id: 'c1', status: 'published', access: 'open', delivery: 'cohort', certification_id: null, created_by: 1 });
        h.rpcResult.error = { code: 'P0001', message: 'This session is full.' };
        await expect(selfEnroll('s1', 2)).rejects.toThrow(/full/);
    });

    it('FAILS CLOSED when the claim function is missing, rather than racing', async () => {
        // The tempting fallback — revert to count-then-insert — would reinstate the
        // race on exactly the deployments nobody is watching.
        h.rows.set('academy_sessions', { id: 's1', course_id: 'c1', status: 'scheduled', capacity: 5, enrollment_open: true });
        h.rows.set('academy_courses', { id: 'c1', status: 'published', access: 'open', delivery: 'cohort', certification_id: null, created_by: 1 });
        h.rpcResult.error = { code: '42883', message: 'function does not exist' };
        await expect(selfEnroll('s1', 2)).rejects.toThrow(/schema.sql/i);
        expect(h.writes.filter((w) => w.op === 'insert')).toEqual([]);
    });
});

// =============================================================================
// Section E — CLIENT-TIER TARGET GUARDS (Phase 3 item 5)
// =============================================================================
// An org's external customers (accounts on the seeded system Client role) are refused
// the whole academy: namespace on the dispatcher and both academy read subsets on the
// read path. These two guards close the INSTRUCTOR-initiated half: the two writes that
// could push academy content AT a customer. Both notification bodies carry the course
// TITLE (and certifyAndComplete additionally the certification id), delivered through the
// self-scoped `notifications` subset a Client still receives, so a rejection that fires
// after the notification would not be a fix.
describe('academy — client-tier target guard: assignStudents', () => {
    const seedSession = () => {
        h.rows.set('academy_sessions', { id: 's1', course_id: 'c1', status: 'scheduled', capacity: null, enrollment_open: true, title: 'Intro' });
        h.rows.set('academy_courses', { id: 'c1', status: 'published', access: 'gated', delivery: 'cohort', certification_id: null, created_by: 1, title: 'Intro to SAR' });
    };

    it('E1. refuses a batch containing an account on the Client role, and writes nothing', async () => {
        seedSession();
        h.lists.set('users', [{ id: 5, role_id: 2 }, { id: 6, role_id: 1 }]);
        await expect(assignStudents('s1', [5, 6], 1, /* canManage */ true)).rejects.toBeInstanceOf(SecurityDenial);
        await expect(assignStudents('s1', [5, 6], 1, true)).rejects.toThrow(/Client accounts cannot be enrolled/);
        expect(enrollmentInserts()).toHaveLength(0);
        // The leak this guard exists for is the course TITLE in the notification body.
        expect(h.createNotification).not.toHaveBeenCalled();
    });

    it('E2. enrols non-client students normally (no over-denial)', async () => {
        seedSession();
        h.lists.set('users', [{ id: 5, role_id: 2 }, { id: 7, role_id: 2 }]);
        await expect(assignStudents('s1', [5, 7], 1, true)).resolves.toBe(2);
        expect(enrollmentInserts()).toHaveLength(1);
    });

    it('E3. fails CLOSED when the Client slot cannot be resolved', async () => {
        seedSession();
        h.sysRoles = {};
        h.lists.set('users', [{ id: 5, role_id: 2 }]);
        await expect(assignStudents('s1', [5], 1, true)).rejects.toThrow(/Repair Database/);
        expect(enrollmentInserts()).toHaveLength(0);
    });

    it('E4. TG-3 — a MIXED batch is refused WHOLE, and the message names only the offender', async () => {
        // Deliberately NOT `toAdd`'s silent-skip semantics: this function returns a count
        // the instructor is shown, so a partial success (asked for 3, got 2, told nothing)
        // is worse than a refusal under the project's fail-closed rule. The picker offers
        // the unfiltered roster and marks nothing, so the message must name the id.
        seedSession();
        h.lists.set('users', [{ id: 5, role_id: 2 }, { id: 6, role_id: 1 }, { id: 7, role_id: 2 }]);
        await expect(assignStudents('s1', [5, 6, 7], 1, true)).rejects.toThrow(/user id 6/);
        expect(enrollmentInserts()).toHaveLength(0);
        expect(h.createNotification).not.toHaveBeenCalled();
    });
});

describe('academy — client-tier target guard: certifyAndComplete (owner decision D12)', () => {
    const seedEnrollment = (studentId: number) => {
        h.rows.set('academy_enrollments', { id: 'e1', session_id: 's1', student_id: studentId, status: 'in_progress' });
        h.rows.set('academy_sessions', { id: 's1', course_id: 'c1', status: 'in_progress', capacity: null, enrollment_open: true });
        h.rows.set('academy_courses', { id: 'c1', status: 'published', access: 'gated', delivery: 'cohort', certification_id: 9, created_by: 1, title: 'Intro to SAR' });
        h.lists.set('academy_outcomes', []); // no required outcomes → allRequiredOutcomesCompetent() true
    };

    it('E5. refuses to certify a LEGACY enrolment held by an account on the Client role', async () => {
        seedEnrollment(5);
        h.rows.set('users', { id: 5, role_id: 1 });
        await expect(certifyAndComplete('e1', 1, /* canAward */ true)).rejects.toThrow(/Client accounts cannot be certified/);
        expect(h.awardCertification).not.toHaveBeenCalled();
        expect(enrollmentUpdates()).toHaveLength(0);
        // course title + certId would otherwise ride the self-scoped notifications subset.
        expect(h.createNotification).not.toHaveBeenCalled();
    });

    it('E6. certifies a non-client normally (no over-denial)', async () => {
        seedEnrollment(5);
        h.rows.set('users', { id: 5, role_id: 2 });
        await expect(certifyAndComplete('e1', 1, true)).resolves.toBeUndefined();
        expect(h.awardCertification).toHaveBeenCalledTimes(1);
        expect(enrollmentUpdates()).toHaveLength(1);
    });

    it('E7. fails CLOSED when the Client slot cannot be resolved', async () => {
        seedEnrollment(5);
        h.sysRoles = {};
        await expect(certifyAndComplete('e1', 1, true)).rejects.toThrow(/Repair Database/);
        expect(h.awardCertification).not.toHaveBeenCalled();
        expect(enrollmentUpdates()).toHaveLength(0);
    });

    // E8/E9 pin the OTHER leg of the same guard. E7 covers an unresolvable Client ROLE;
    // these two cover an unresolvable STUDENT. The guard originally destructured only
    // `data` from the student read, so both of these cases left `role_id` undefined,
    // compared unequal to the Client role id, and let the certification through — the
    // exact inversion of the guard's purpose, one line below a comment claiming it fails
    // closed. assignStudents gets this free (an empty result set makes every id invalid);
    // this path is single-row and has to say it.
    it('E8. fails CLOSED when the student row resolves to nothing', async () => {
        seedEnrollment(5);
        // No h.rows.set('users', ...) — the read comes back null.
        await expect(certifyAndComplete('e1', 1, true)).rejects.toThrow(/Could not resolve the student/);
        expect(h.awardCertification).not.toHaveBeenCalled();
        expect(enrollmentUpdates()).toHaveLength(0);
        expect(h.createNotification).not.toHaveBeenCalled();
    });

    it('E9. fails CLOSED on a READ FAULT resolving the student, rather than certifying', async () => {
        seedEnrollment(5);
        // A NON-client row alongside the fault, deliberately: under the old code the
        // discarded error left this reading as "not a customer" and the certification
        // went through, so this test goes red for the right reason. Seeding a Client row
        // here would make it go red via the tier denial instead and prove nothing about
        // error handling.
        h.rows.set('users', { id: 5, role_id: 2 });
        h.rowErrors.set('users', { message: 'connection reset' });
        await expect(certifyAndComplete('e1', 1, true)).rejects.toThrow(/connection reset|Failed to resolve student tier/);
        expect(h.awardCertification).not.toHaveBeenCalled();
        expect(enrollmentUpdates()).toHaveLength(0);
        expect(h.createNotification).not.toHaveBeenCalled();
    });
});
