import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// =============================================================================
// lib/db/academy.ts — READS: staff bundle, catalog, detail views, LM reports
// =============================================================================
// Pins the read half: every list read is explicitly projected, ordered to a total
// order and capped; a missing table (42P01) degrades to an empty answer while any
// other read fault THROWS (never a silently-partial bundle); by-id detail reads give a
// missing id the opaque denial; the enrolment detail is self-or-staff only and denies
// BEFORE any child read; the catalog only serves published courses; and the
// Learning-Manager reports return named, field-by-field projections whose caller-
// supplied paging is clamped server-side.
vi.mock('../lib/db/common.js', async () => {
    const hh = await import('./cov-db-academy-harness');
    return { supabase: hh.supabaseStub, handleSupabaseError: hh.handleSupabaseError, broadcastToOrg: hh.broadcastToOrg };
});
vi.mock('../lib/db/system.js', async () => ({ awardCertification: (await import('./cov-db-academy-harness')).awardCertification }));
vi.mock('../lib/db/notifications.js', async () => ({ createNotification: (await import('./cov-db-academy-harness')).createNotification }));
vi.mock('../lib/db/clientRoleLock.js', async () => ({ requireClientRoleId: (await import('./cov-db-academy-harness')).requireClientRoleId }));
vi.mock('../lib/log.js', async () => ({ log: (await import('./cov-db-academy-harness')).logSpy }));

import {
    on, resetHarness, queriesOn, broadcasts, assertNoWildcardSelects,
    argOf, argsOf, colsOf, eqsOf, courseRow, sessionRow, enrollmentRow, seedSession,
    COURSE_COLS, SESSION_COLS, ENROLLMENT_COLS, MODULE_COLS, LESSON_COLS, OUTCOME_COLS, USER_REF_COLS, type Q,
} from './cov-db-academy-harness';
import {
    getAcademyStaffState, listRecommendedEnrollments, reportCertificationHolders, reportCompletions,
    reportCourseActivity, reportMemberTranscript, getMyAcademyState, getCourseDetail, getSessionDetail,
    getEnrollmentDetail, getCatalogCourse,
} from '../lib/db/academy';
import { SecurityDenial } from '../lib/errors';

beforeEach(() => resetHarness());
afterEach(() => {
    vi.restoreAllMocks();
    // Every read path in this file must stay explicit-column (Security rule 1) and must
    // never emit a realtime event.
    assertNoWildcardSelects();
    expect(broadcasts()).toEqual([]);
});

const NOT_IS_NULL = (col: string) => [col, 'is', null];

/** User refs: the users USER_REF_COLS read answers every id in this map. */
function seedRefs(refs: Record<number, { name: string; avatar_url?: string | null; rsi_handle?: string | null }>): void {
    on('users', { kind: 'select', cols: USER_REF_COLS }, (q: Q) => {
        const ids = (argOf(q, 'in')?.[1] ?? []) as number[];
        return { data: ids.filter(id => id in refs).map(id => ({ id, avatar_url: null, rsi_handle: null, ...refs[id] })) };
    });
}
/** attachEnrollmentContext inputs. */
function seedEnrollmentContext(opts: {
    sessions?: Array<{ id: string; title: string; course_id: string }>;
    progress?: Array<{ enrollment_id: string }>;
    courses?: Array<{ id: string; title: string }>;
    modules?: Array<{ id: number; course_id: string }>;
    lessons?: Array<{ module_id: number }>;
}): void {
    on('academy_sessions', { kind: 'select', cols: 'id, title, course_id' }, { data: opts.sessions ?? [] });
    on('academy_lesson_progress', { kind: 'select', cols: 'enrollment_id' }, { data: opts.progress ?? [] });
    on('academy_courses', { kind: 'select', cols: 'id, title' }, { data: opts.courses ?? [] });
    on('academy_modules', { kind: 'select', cols: 'id, course_id' }, { data: opts.modules ?? [] });
    on('academy_lessons', { kind: 'select', cols: 'module_id' }, { data: opts.lessons ?? [] });
}

// ════════════════════════════════════════════════════════════════════════════
describe('getAcademyStaffState', () => {
    it('a missing courses table degrades to an empty bundle; any other fault throws', async () => {
        on('academy_courses', { kind: 'select' }, { error: { code: '42P01' } });
        await expect(getAcademyStaffState()).resolves.toEqual({ academyCourses: [], academySessions: [] });
        resetHarness();
        on('academy_courses', { kind: 'select' }, { error: { code: '57014' } });
        await expect(getAcademyStaffState()).rejects.toThrow('Failed to load courses');
    });

    it('hydrates instructors, session course titles and non-withdrawn enrolment counts', async () => {
        on('academy_courses', { kind: 'select', cols: COURSE_COLS }, { data: [courseRow({ id: 'c1', title: 'SAR' }), courseRow({ id: 'c2', title: 'Nav' })] });
        on('academy_course_instructors', { kind: 'select' }, { data: [
            { course_id: 'c1', user_id: 10 }, { course_id: 'c1', user_id: 11 }, { course_id: 'c1', user_id: 404 },
        ] });
        seedRefs({ 10: { name: 'Alpha', avatar_url: 'a.png', rsi_handle: 'alpha' }, 11: { name: null as unknown as string } });
        on('academy_sessions', { kind: 'select', cols: SESSION_COLS }, { data: [
            sessionRow({ id: 's1', course_id: 'c1' }), sessionRow({ id: 's2', course_id: 'cGone' }),
        ] });
        on('academy_enrollments', { kind: 'select', cols: 'session_id, status' }, { data: [
            { session_id: 's1', status: 'enrolled' }, { session_id: 's1', status: 'withdrawn' }, { session_id: 's1', status: 'completed' },
        ] });

        const out = await getAcademyStaffState();
        expect(out.academyCourses.map(c => [c.id, c.instructors])).toEqual([
            ['c1', [{ id: 10, name: 'Alpha', avatarUrl: 'a.png', rsiHandle: 'alpha' }, { id: 11, name: '', avatarUrl: '', rsiHandle: '' }]],
            ['c2', []],
        ]);
        expect(out.academySessions.map(s => [s.id, s.courseTitle, s.enrollmentCount])).toEqual([['s1', 'SAR', 2], ['s2', null, 0]]);

        const [cq] = queriesOn('academy_courses');
        expect(argsOf(cq, 'order')).toEqual([['sort_order', { ascending: true }], ['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(argOf(cq, 'limit')).toEqual([500]);
        const [iq] = queriesOn('academy_course_instructors');
        expect(colsOf(iq)).toBe('course_id, user_id');
        expect(argOf(iq, 'in')).toEqual(['course_id', ['c1', 'c2']]);
        expect(argOf(iq, 'limit')).toEqual([5000]);
        const refQ = queriesOn('users')[0];
        expect(argOf(refQ, 'in')).toEqual(['id', [10, 11, 404]]);
        const [sq] = queriesOn('academy_sessions');
        expect(argsOf(sq, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        const [eq] = queriesOn('academy_enrollments');
        expect(argOf(eq, 'in')).toEqual(['session_id', ['s1', 's2']]);
        expect(argOf(eq, 'limit')).toEqual([5000]);
    });

    it('no courses → no instructor read; no sessions → no enrolment read', async () => {
        await expect(getAcademyStaffState()).resolves.toEqual({ academyCourses: [], academySessions: [] });
        expect(queriesOn('academy_course_instructors')).toEqual([]);
        expect(queriesOn('academy_enrollments')).toEqual([]);
    });

    it('instructor rows with no user ids skip the user-ref read entirely', async () => {
        on('academy_courses', { kind: 'select', cols: COURSE_COLS }, { data: [courseRow()] });
        await getAcademyStaffState();
        expect(queriesOn('users')).toEqual([]);
    });

    it('a missing sessions table keeps the courses; any other session fault throws', async () => {
        on('academy_courses', { kind: 'select', cols: COURSE_COLS }, { data: [courseRow()] });
        on('academy_sessions', { kind: 'select' }, { error: { code: '42P01' } });
        const out = await getAcademyStaffState();
        expect(out.academyCourses).toHaveLength(1);
        expect(out.academySessions).toEqual([]);
        resetHarness();
        on('academy_sessions', { kind: 'select' }, { error: { code: 'X' } });
        await expect(getAcademyStaffState()).rejects.toThrow('Failed to load sessions');
    });
});

describe('listRecommendedEnrollments (certify queue)', () => {
    it('reads recommended, still-active enrolments oldest-recommendation first, capped', async () => {
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_COLS }, { data: [enrollmentRow({ id: 'e1', student_id: 20, recommended_at: 't1' })] });
        seedEnrollmentContext({
            sessions: [{ id: 's1', title: 'Cohort 1', course_id: 'c1' }], courses: [{ id: 'c1', title: 'SAR' }],
            progress: [{ enrollment_id: 'e1' }, { enrollment_id: 'e1' }], modules: [{ id: 5, course_id: 'c1' }],
            lessons: [{ module_id: 5 }, { module_id: 5 }, { module_id: 5 }],
        });
        seedRefs({ 20: { name: 'Ace' } });
        const out = await listRecommendedEnrollments();
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            id: 'e1', studentId: 20, recommendedAt: 't1', sessionTitle: 'Cohort 1', courseId: 'c1', courseTitle: 'SAR',
            lessonsCompleted: 2, lessonsTotal: 3, student: { id: 20, name: 'Ace', avatarUrl: '', rsiHandle: '' },
        });
        const [q] = queriesOn('academy_enrollments');
        expect(argOf(q, 'not')).toEqual(NOT_IS_NULL('recommended_at'));
        expect(argOf(q, 'in')).toEqual(['status', ['enrolled', 'in_progress']]);
        expect(argsOf(q, 'order')).toEqual([['recommended_at', { ascending: true }], ['id', { ascending: true }]]);
        expect(argOf(q, 'limit')).toEqual([500]);
    });

    it('a student whose ref is gone gets student: null', async () => {
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_COLS }, { data: [enrollmentRow()] });
        const [e] = await listRecommendedEnrollments();
        expect(e.student).toBeNull();
        expect(e.sessionTitle).toBeNull();
        expect(e.courseTitle).toBeNull();
        expect(e.lessonsTotal).toBe(0);
    });

    it('empty → [] with no context reads; 42P01 → []; other faults throw', async () => {
        await expect(listRecommendedEnrollments()).resolves.toEqual([]);
        expect(queriesOn('academy_sessions')).toEqual([]);
        on('academy_enrollments', { kind: 'select' }, { error: { code: '42P01' } });
        await expect(listRecommendedEnrollments()).resolves.toEqual([]);
        resetHarness();
        on('academy_enrollments', { kind: 'select' }, { error: { code: 'X' } });
        await expect(listRecommendedEnrollments()).rejects.toThrow('Failed to load certify queue');
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('reportCertificationHolders', () => {
    it.each([0, -1, 1.5, Number.NaN])('rejects an invalid certification id (%s) before any read', async (id) => {
        await expect(reportCertificationHolders(id)).rejects.toThrow('reportCertificationHolders: certificationId is required');
        expect(queriesOn('certifications')).toEqual([]);
    });

    it('a missing certifications table yields an empty, shaped report; other faults throw', async () => {
        on('certifications', { kind: 'select' }, { error: { code: '42P01' } });
        await expect(reportCertificationHolders(9)).resolves.toEqual({ certification: { id: 9, name: '', icon: null, imageUrl: null }, holders: [] });
        resetHarness();
        on('certifications', { kind: 'select' }, { error: { code: 'X' } });
        await expect(reportCertificationHolders(9)).rejects.toThrow('Failed to load certification');
    });

    it('an unknown certification is an opaque denial', async () => {
        const err = await reportCertificationHolders(9).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Certification not found.');
        expect(queriesOn('user_certifications')).toEqual([]);
    });

    it('projects holders field-by-field, newest award first, naming the awarder', async () => {
        on('certifications', { kind: 'select' }, { data: { id: 9, name: 'Medic I', icon: null, image_url: 'https://x/y.png' } });
        on('user_certifications', { kind: 'select' }, { data: [
            { user_id: 20, awarded_at: 't2', awarded_by: 1 },
            { user_id: 21, awarded_at: null, awarded_by: null },
            { user_id: 404, awarded_at: 't0', awarded_by: 405 },
        ] });
        seedRefs({ 1: { name: 'Boss' }, 20: { name: 'Ace', avatar_url: 'a.png', rsi_handle: 'ace' }, 21: { name: 'Bee' } });
        const out = await reportCertificationHolders(9);
        expect(out).toEqual({
            certification: { id: 9, name: 'Medic I', icon: null, imageUrl: 'https://x/y.png' },
            holders: [
                { userId: 20, name: 'Ace', avatarUrl: 'a.png', rsiHandle: 'ace', awardedAt: 't2', awardedByName: 'Boss' },
                { userId: 21, name: 'Bee', avatarUrl: '', rsiHandle: '', awardedAt: null, awardedByName: null },
                { userId: 404, name: '', avatarUrl: '', rsiHandle: '', awardedAt: 't0', awardedByName: null },
            ],
        });
        const [cq] = queriesOn('certifications');
        expect(colsOf(cq)).toBe('id, name, icon, image_url');
        expect(eqsOf(cq)).toEqual({ id: 9 });
        const [hq] = queriesOn('user_certifications');
        expect(colsOf(hq)).toBe('user_id, awarded_at, awarded_by');
        expect(eqsOf(hq)).toEqual({ certification_id: 9 });
        expect(argsOf(hq, 'order')).toEqual([['awarded_at', { ascending: false }], ['user_id', { ascending: true }]]);
        expect(argOf(hq, 'limit')).toEqual([5000]);
    });

    it('no holders / missing holders table → empty list; other holder faults throw', async () => {
        on('certifications', { kind: 'select' }, { data: { id: 9, name: 'M', icon: 'i', image_url: null } });
        await expect(reportCertificationHolders(9)).resolves.toEqual({ certification: { id: 9, name: 'M', icon: 'i', imageUrl: null }, holders: [] });
        expect(queriesOn('users')).toEqual([]);
        on('user_certifications', { kind: 'select' }, { error: { code: '42P01' } });
        await expect(reportCertificationHolders(9)).resolves.toMatchObject({ holders: [] });
        resetHarness();
        on('certifications', { kind: 'select' }, { data: { id: 9, name: 'M', icon: null, image_url: null } });
        on('user_certifications', { kind: 'select' }, { error: { code: 'X' } });
        await expect(reportCertificationHolders(9)).rejects.toThrow('Failed to load certification holders');
    });
});

describe('reportCompletions (clamped paging)', () => {
    const NOW = Date.parse('2026-06-01T00:00:00.000Z');
    const sinceFor = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
    const completionsQuery = () => queriesOn('academy_enrollments')[0];

    it.each([
        [undefined, 90, 200],
        [{}, 90, 200],
        [{ sinceDays: 'abc', limit: 'xyz' }, 90, 200],
        [{ sinceDays: 0, limit: 0 }, 1, 1],
        [{ sinceDays: -5, limit: -5 }, 1, 1],
        [{ sinceDays: 99999, limit: 99999 }, 730, 500],
        [{ sinceDays: 7.9, limit: 12.9 }, 7, 12],
        [{ sinceDays: '30', limit: '50' }, 30, 50],
    ])('opts %j → %d days, limit %d', async (opts, days, limit) => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
        await expect(reportCompletions(opts as never)).resolves.toEqual([]);
        const q = completionsQuery();
        expect(argOf(q, 'gte')).toEqual(['completed_at', sinceFor(days)]);
        expect(argOf(q, 'limit')).toEqual([limit]);
    });

    it('filters completed rows with a completion stamp, newest first, and projects named rows', async () => {
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_COLS }, { data: [
            enrollmentRow({ id: 'e1', student_id: 20, status: 'completed', completed_at: 't1', certified_by: 1 }),
            enrollmentRow({ id: 'e2', student_id: 21, session_id: 'sGone', status: 'completed', completed_at: 't0', certified_by: null }),
            enrollmentRow({ id: 'e3', student_id: 404, status: 'completed', completed_at: 't-1', certified_by: 405 }),
        ] });
        seedEnrollmentContext({ sessions: [{ id: 's1', title: 'Cohort 1', course_id: 'c1' }], courses: [{ id: 'c1', title: 'SAR' }] });
        seedRefs({ 1: { name: 'Boss' }, 20: { name: 'Ace', rsi_handle: 'ace' }, 21: { name: 'Bee' } });
        const out = await reportCompletions();
        expect(out).toEqual([
            { enrollmentId: 'e1', studentId: 20, studentName: 'Ace', rsiHandle: 'ace', courseTitle: 'SAR', sessionTitle: 'Cohort 1', completedAt: 't1', certifiedByName: 'Boss' },
            { enrollmentId: 'e2', studentId: 21, studentName: 'Bee', rsiHandle: '', courseTitle: '', sessionTitle: '', completedAt: 't0', certifiedByName: null },
            { enrollmentId: 'e3', studentId: 404, studentName: '', rsiHandle: '', courseTitle: 'SAR', sessionTitle: 'Cohort 1', completedAt: 't-1', certifiedByName: null },
        ]);
        const q = completionsQuery();
        expect(colsOf(q)).toBe(ENROLLMENT_COLS);
        expect(eqsOf(q)).toEqual({ status: 'completed' });
        expect(argOf(q, 'not')).toEqual(NOT_IS_NULL('completed_at'));
        expect(argsOf(q, 'order')).toEqual([['completed_at', { ascending: false }], ['id', { ascending: false }]]);
    });

    it('42P01 → []; other faults throw', async () => {
        on('academy_enrollments', { kind: 'select' }, { error: { code: '42P01' } });
        await expect(reportCompletions()).resolves.toEqual([]);
        resetHarness();
        on('academy_enrollments', { kind: 'select' }, { error: { code: 'X' } });
        await expect(reportCompletions()).rejects.toThrow('Failed to load completions');
    });
});

describe('reportCourseActivity', () => {
    it('42P01 / empty → the empty report; other faults throw', async () => {
        await expect(reportCourseActivity()).resolves.toEqual({ courses: [], totalEnrollments: 0, truncated: false });
        expect(queriesOn('academy_sessions')).toEqual([]);
        on('academy_courses', { kind: 'select' }, { error: { code: '42P01' } });
        await expect(reportCourseActivity()).resolves.toEqual({ courses: [], totalEnrollments: 0, truncated: false });
        resetHarness();
        on('academy_courses', { kind: 'select' }, { error: { code: 'X' } });
        await expect(reportCourseActivity()).rejects.toThrow('Failed to load course activity');
    });

    it('aggregates per course, skipping implicit pools and orphans; awaiting reconciles with the certify queue', async () => {
        on('academy_courses', { kind: 'select' }, { data: [
            { id: 'c1', title: 'Nav', status: 'published', delivery: null },
            { id: 'c2', title: 'SAR', status: 'draft', delivery: 'self_paced' },
        ] });
        on('academy_sessions', { kind: 'select' }, { data: [
            { id: 's1', course_id: 'c1', is_implicit: false }, { id: 's2', course_id: 'c1', is_implicit: null },
            { id: 'sImp', course_id: 'c2', is_implicit: true }, { id: 'sOrphan', course_id: 'cGone', is_implicit: false },
        ] });
        on('academy_enrollments', { kind: 'select' }, { data: [
            { session_id: 's1', status: 'enrolled', recommended_at: 't' },
            { session_id: 's1', status: 'in_progress', recommended_at: 't' },
            { session_id: 's2', status: 'in_progress', recommended_at: null },
            { session_id: 's2', status: 'completed', recommended_at: 't' },
            { session_id: 's2', status: 'withdrawn', recommended_at: null },
            { session_id: 'sImp', status: 'enrolled', recommended_at: null },
            { session_id: 'sOrphan', status: 'enrolled', recommended_at: 't' },
            { session_id: 'sUnknown', status: 'enrolled', recommended_at: null },
        ] });
        const out = await reportCourseActivity();
        expect(out).toEqual({
            courses: [
                { courseId: 'c1', courseTitle: 'Nav', status: 'published', delivery: 'cohort', sessions: 2, enrolled: 1, inProgress: 2, completed: 1, awaitingCertification: 2 },
                { courseId: 'c2', courseTitle: 'SAR', status: 'draft', delivery: 'self_paced', sessions: 0, enrolled: 1, inProgress: 0, completed: 0, awaitingCertification: 0 },
            ],
            totalEnrollments: 8,
            truncated: false,
        });
        const [cq] = queriesOn('academy_courses');
        expect(colsOf(cq)).toBe('id, title, status, delivery');
        expect(argsOf(cq, 'order')).toEqual([['title', { ascending: true }], ['id', { ascending: true }]]);
        const [sq] = queriesOn('academy_sessions');
        expect(colsOf(sq)).toBe('id, course_id, is_implicit');
        expect(argOf(sq, 'limit')).toEqual([5000]);
        const [eq] = queriesOn('academy_enrollments');
        expect(colsOf(eq)).toBe('session_id, status, recommended_at');
        expect(argOf(eq, 'order')).toEqual(['id', { ascending: true }]);
        expect(argOf(eq, 'limit')).toEqual([5000]);
    });

    it('a scan that hits the 5000 cap is flagged truncated (numbers are a floor)', async () => {
        on('academy_courses', { kind: 'select' }, { data: [{ id: 'c1', title: 'Nav', status: 'published', delivery: 'cohort' }] });
        on('academy_enrollments', { kind: 'select' }, { data: Array.from({ length: 5000 }, () => ({ session_id: 'x', status: 'enrolled', recommended_at: null })) });
        await expect(reportCourseActivity()).resolves.toMatchObject({ totalEnrollments: 5000, truncated: true });
    });
});

describe('reportMemberTranscript', () => {
    const seedMember = () => on('users', { kind: 'select', cols: 'id' }, { data: { id: 20 } });

    it.each([0, -2, 2.5, Number.NaN])('rejects an invalid target id (%s) before any read', async (id) => {
        await expect(reportMemberTranscript(id)).rejects.toThrow('reportMemberTranscript: targetUserId is required');
        expect(queriesOn('users')).toEqual([]);
    });

    it('a target that is not a live member is refused before ANY training row is read', async () => {
        const err = await reportMemberTranscript(20).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Member is not a valid member.');
        const [uq] = queriesOn('users');
        expect(eqsOf(uq)).toEqual({ id: 20 });
        expect(argOf(uq, 'is')).toEqual(['deleted_at', null]);
        expect(queriesOn('academy_enrollments')).toEqual([]);
    });

    it('builds per-enrolment rows with outcome verdicts and the held certifications', async () => {
        seedMember();
        seedRefs({ 20: { name: 'Ace', rsi_handle: 'ace' } });
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_COLS }, { data: [
            enrollmentRow({ id: 'e1', session_id: 's1', status: 'completed', completed_at: 't9' }),
            enrollmentRow({ id: 'e2', session_id: 'sGone', status: 'enrolled' }),
        ] });
        seedEnrollmentContext({
            sessions: [{ id: 's1', title: 'Cohort 1', course_id: 'c1' }], courses: [{ id: 'c1', title: 'SAR' }],
            progress: [{ enrollment_id: 'e1' }], modules: [{ id: 5, course_id: 'c1' }], lessons: [{ module_id: 5 }, { module_id: 5 }],
        });
        on('academy_outcome_results', { kind: 'select' }, { data: [{ enrollment_id: 'e1', outcome_id: 1, verdict: 'competent' }] });
        on('academy_outcomes', { kind: 'select', cols: 'id, course_id, title' }, { data: [
            { id: 1, course_id: 'c1', title: 'Triage' }, { id: 2, course_id: 'c1', title: 'Extraction' },
        ] });
        on('certifications', { kind: 'select', cols: 'id, name' }, { data: [{ id: 9, name: 'Medic I' }] });
        on('user_certifications', { kind: 'select' }, { data: [{ certification_id: 9, awarded_at: 't5' }, { certification_id: 77, awarded_at: null }] });

        const out = await reportMemberTranscript(20);
        expect(out.member).toEqual({ id: 20, name: 'Ace', avatarUrl: '', rsiHandle: 'ace' });
        expect(out.rows).toEqual([
            {
                enrollmentId: 'e1', courseTitle: 'SAR', sessionTitle: 'Cohort 1', status: 'completed', enrolledAt: '2026-01-03T00:00:00Z',
                completedAt: 't9', lessonsCompleted: 1, lessonsTotal: 2,
                outcomes: [{ title: 'Triage', verdict: 'competent' }, { title: 'Extraction', verdict: null }],
            },
            {
                enrollmentId: 'e2', courseTitle: '', sessionTitle: '', status: 'enrolled', enrolledAt: '2026-01-03T00:00:00Z',
                completedAt: null, lessonsCompleted: 0, lessonsTotal: 0, outcomes: [],
            },
        ]);
        expect(out.certifications).toEqual([{ id: 9, name: 'Medic I', awardedAt: 't5' }, { id: 77, name: '', awardedAt: null }]);

        const [eq] = queriesOn('academy_enrollments');
        expect(eqsOf(eq)).toEqual({ student_id: 20 });
        expect(argsOf(eq, 'order')).toEqual([['enrolled_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(argOf(eq, 'limit')).toEqual([500]);
        const [rq] = queriesOn('academy_outcome_results');
        expect(argOf(rq, 'in')).toEqual(['enrollment_id', ['e1', 'e2']]);
        const oq = queriesOn('academy_outcomes').find(q => colsOf(q) === 'id, course_id, title')!;
        expect(argOf(oq, 'in')).toEqual(['course_id', ['c1']]);
        expect(argsOf(oq, 'order')).toEqual([['sort_order', { ascending: true }], ['id', { ascending: true }]]);
        const [hq] = queriesOn('user_certifications');
        expect(eqsOf(hq)).toEqual({ user_id: 20 });
        expect(argOf(hq, 'in')).toEqual(['certification_id', [9]]);
        expect(argsOf(hq, 'order')).toEqual([['awarded_at', { ascending: false }], ['certification_id', { ascending: true }]]);
    });

    it('enrolments with no resolvable course skip the outcomes read; no cert defs → no holdings read', async () => {
        seedMember();
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_COLS }, { data: [enrollmentRow({ id: 'e1', session_id: 'sGone' })] });
        const out = await reportMemberTranscript(20);
        expect(out.member).toEqual({ id: 20, name: '', avatarUrl: '', rsiHandle: '' });
        expect(out.rows).toHaveLength(1);
        expect(out.rows[0].outcomes).toEqual([]);
        expect(queriesOn('academy_outcomes')).toEqual([]);
        expect(queriesOn('user_certifications')).toEqual([]);
        expect(out.certifications).toEqual([]);
    });

    it('a course with no outcomes defined yields an empty outcome list on its row', async () => {
        seedMember();
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_COLS }, { data: [enrollmentRow({ id: 'e1', session_id: 's1' })] });
        seedEnrollmentContext({ sessions: [{ id: 's1', title: 'Cohort 1', course_id: 'c1' }], courses: [{ id: 'c1', title: 'SAR' }] });
        on('academy_outcomes', { kind: 'select', cols: 'id, course_id, title' }, { data: [{ id: 1, course_id: 'cOther', title: 'Elsewhere' }] });
        const out = await reportMemberTranscript(20);
        expect(out.rows.map(r => [r.enrollmentId, r.courseTitle, r.outcomes])).toEqual([['e1', 'SAR', []]]);
    });

    it('no enrolments → empty rows, still lists certifications', async () => {
        seedMember();
        on('certifications', { kind: 'select', cols: 'id, name' }, { data: [{ id: 9, name: 'Medic I' }] });
        const out = await reportMemberTranscript(20);
        expect(out.rows).toEqual([]);
        expect(queriesOn('academy_outcome_results')).toEqual([]);
        expect(out.certifications).toEqual([]);
        expect(queriesOn('user_certifications')).toHaveLength(1);
    });

    it('a missing enrolments table → empty transcript; other faults throw', async () => {
        seedMember();
        on('academy_enrollments', { kind: 'select' }, { error: { code: '42P01' } });
        await expect(reportMemberTranscript(20)).resolves.toEqual({ member: { id: 20, name: '', avatarUrl: '', rsiHandle: '' }, rows: [], certifications: [] });
        resetHarness();
        seedMember();
        on('academy_enrollments', { kind: 'select' }, { error: { code: 'X' } });
        await expect(reportMemberTranscript(20)).rejects.toThrow('Failed to load transcript');
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('getMyAcademyState', () => {
    it('serves ONLY published courses and the caller\'s own enrolments', async () => {
        on('academy_courses', { kind: 'select', cols: COURSE_COLS }, { data: [courseRow({ status: 'published' })] });
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_COLS }, { data: [enrollmentRow({ student_id: 20 })] });
        seedEnrollmentContext({ sessions: [{ id: 's1', title: 'Cohort 1', course_id: 'c1' }], courses: [{ id: 'c1', title: 'SAR' }], modules: [] });
        const out = await getMyAcademyState(20);
        expect(out.academyCatalog.map(c => c.id)).toEqual(['c1']);
        expect(out.academyMyEnrollments[0]).toMatchObject({ id: 'e1', courseTitle: 'SAR', sessionTitle: 'Cohort 1', lessonsTotal: 0 });
        const [cq] = queriesOn('academy_courses').filter(q => colsOf(q) === COURSE_COLS);
        expect(eqsOf(cq)).toEqual({ status: 'published' });
        expect(argsOf(cq, 'order')).toEqual([['title', { ascending: true }], ['id', { ascending: true }]]);
        expect(argOf(cq, 'limit')).toEqual([500]);
        const [eq] = queriesOn('academy_enrollments');
        expect(eqsOf(eq)).toEqual({ student_id: 20 });
        expect(argsOf(eq, 'order')).toEqual([['enrolled_at', { ascending: false }], ['id', { ascending: false }]]);
        // No modules → the lessons read is skipped.
        expect(queriesOn('academy_lessons')).toEqual([]);
    });

    it('missing tables degrade; other faults throw', async () => {
        on('academy_courses', { kind: 'select' }, { error: { code: '42P01' } });
        await expect(getMyAcademyState(20)).resolves.toEqual({ academyCatalog: [], academyMyEnrollments: [] });
        resetHarness();
        on('academy_courses', { kind: 'select' }, { error: { code: 'X' } });
        await expect(getMyAcademyState(20)).rejects.toThrow('Failed to load catalog');
        resetHarness();
        on('academy_courses', { kind: 'select' }, { data: [courseRow()] });
        on('academy_enrollments', { kind: 'select' }, { error: { code: '42P01' } });
        const out = await getMyAcademyState(20);
        expect(out.academyCatalog).toHaveLength(1);
        expect(out.academyMyEnrollments).toEqual([]);
        resetHarness();
        on('academy_enrollments', { kind: 'select' }, { error: { code: 'X' } });
        await expect(getMyAcademyState(20)).rejects.toThrow('Failed to load enrolments');
    });

    it('no enrolments → no context reads', async () => {
        await expect(getMyAcademyState(20)).resolves.toEqual({ academyCatalog: [], academyMyEnrollments: [] });
        expect(queriesOn('academy_sessions')).toEqual([]);
        expect(queriesOn('academy_lesson_progress')).toEqual([]);
    });

    it('attachEnrollmentContext: sessions with no course id skip the course/lesson reads', async () => {
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_COLS }, { data: [enrollmentRow()] });
        await getMyAcademyState(20);
        const [sq] = queriesOn('academy_sessions');
        expect(colsOf(sq)).toBe('id, title, course_id');
        expect(argOf(sq, 'in')).toEqual(['id', ['s1']]);
        expect(argOf(sq, 'limit')).toEqual([5000]);
        const [pq] = queriesOn('academy_lesson_progress');
        expect(argOf(pq, 'in')).toEqual(['enrollment_id', ['e1']]);
        expect(queriesOn('academy_modules')).toEqual([]);
        expect(queriesOn('academy_courses').filter(q => colsOf(q) === 'id, title')).toEqual([]);
    });

    it('attachEnrollmentContext: lessons are totalled per course across modules', async () => {
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_COLS }, { data: [
            enrollmentRow({ id: 'e1', session_id: 's1' }), enrollmentRow({ id: 'e2', session_id: 's2' }),
        ] });
        seedEnrollmentContext({
            sessions: [{ id: 's1', title: 'A', course_id: 'c1' }, { id: 's2', title: 'B', course_id: 'c2' }],
            courses: [{ id: 'c1', title: 'SAR' }],
            modules: [{ id: 5, course_id: 'c1' }, { id: 6, course_id: 'c1' }, { id: 7, course_id: 'c2' }],
            lessons: [{ module_id: 5 }, { module_id: 6 }, { module_id: 7 }, { module_id: 999 }],
            progress: [{ enrollment_id: 'e2' }],
        });
        const { academyMyEnrollments } = await getMyAcademyState(20);
        expect(academyMyEnrollments.map(e => [e.id, e.courseTitle, e.lessonsTotal, e.lessonsCompleted])).toEqual([
            ['e1', 'SAR', 2, 0], ['e2', null, 1, 1],
        ]);
        const [mq] = queriesOn('academy_modules');
        expect(argOf(mq, 'in')).toEqual(['course_id', ['c1', 'c2']]);
        const [lq] = queriesOn('academy_lessons');
        expect(argOf(lq, 'in')).toEqual(['module_id', [5, 6, 7]]);
    });
});

describe('getCourseDetail', () => {
    it('a read fault throws; a missing course (or table) is the opaque denial', async () => {
        on('academy_courses', { kind: 'select' }, { error: { code: 'X' } });
        await expect(getCourseDetail('c1')).rejects.toThrow('Failed to load course');
        resetHarness();
        on('academy_courses', { kind: 'select' }, { error: { code: '42P01' } });
        await expect(getCourseDetail('c1')).rejects.toThrow('This course is not available.');
        resetHarness();
        await expect(getCourseDetail('c1')).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('academy_modules')).toEqual([]);
    });

    it('assembles instructors, certification ref, ordered module/lesson tree and outcomes', async () => {
        on('academy_courses', { kind: 'select', cols: COURSE_COLS }, { data: courseRow({ certification_id: 9 }) });
        on('academy_course_instructors', { kind: 'select' }, { data: [{ course_id: 'c1', user_id: 10 }] });
        seedRefs({ 10: { name: 'Alpha' } });
        on('certifications', { kind: 'select' }, { data: { id: 9, name: 'Medic I', icon: null, image_url: null } });
        on('academy_modules', { kind: 'select', cols: MODULE_COLS }, { data: [
            { id: 5, course_id: 'c1', title: 'M1', description: null, sort_order: 10, created_at: 't' },
            { id: 6, course_id: 'c1', title: 'M2', description: null, sort_order: 20, created_at: 't' },
        ] });
        on('academy_lessons', { kind: 'select', cols: LESSON_COLS }, { data: [
            { id: 80, module_id: 5, title: 'L1', content: null, video_url: null, sort_order: 10, estimated_minutes: 5, created_at: 't' },
            { id: 81, module_id: 5, title: 'L2', content: null, video_url: null, sort_order: 20, estimated_minutes: null, created_at: 't' },
        ] });
        on('academy_outcomes', { kind: 'select', cols: OUTCOME_COLS }, { data: [
            { id: 1, course_id: 'c1', title: 'O1', description: null, sort_order: 10, required: false, created_at: 't' },
        ] });
        const c = await getCourseDetail('c1');
        expect(c.instructors).toEqual([{ id: 10, name: 'Alpha', avatarUrl: '', rsiHandle: '' }]);
        expect(c.certification).toEqual({ id: 9, name: 'Medic I', icon: null, imageUrl: null });
        expect(c.modules.map(m => [m.id, m.lessons.map(l => l.id)])).toEqual([[5, [80, 81]], [6, []]]);
        expect(c.outcomes).toEqual([{ id: 1, courseId: 'c1', title: 'O1', description: null, sortOrder: 10, required: false }]);
        const [cq] = queriesOn('academy_courses');
        expect(eqsOf(cq)).toEqual({ id: 'c1' });
        expect(cq.terminal).toBe('maybeSingle');
        const [certQ] = queriesOn('certifications');
        expect(colsOf(certQ)).toBe('id, name, icon, image_url');
        const [mq] = queriesOn('academy_modules');
        expect(argsOf(mq, 'order')).toEqual([['sort_order', { ascending: true }], ['id', { ascending: true }]]);
        expect(argOf(mq, 'limit')).toEqual([500]);
        const [lq] = queriesOn('academy_lessons');
        expect(argOf(lq, 'in')).toEqual(['module_id', [5, 6]]);
        expect(argOf(lq, 'limit')).toEqual([5000]);
        const [oq] = queriesOn('academy_outcomes');
        expect(eqsOf(oq)).toEqual({ course_id: 'c1' });
        expect(argsOf(oq, 'order')).toEqual([['sort_order', { ascending: true }], ['id', { ascending: true }]]);
    });

    it('no certification → no cert read; a dangling certification id leaves it null; no modules → no lesson read', async () => {
        on('academy_courses', { kind: 'select', cols: COURSE_COLS }, { data: courseRow() });
        const plain = await getCourseDetail('c1');
        expect(queriesOn('certifications')).toEqual([]);
        expect(queriesOn('academy_lessons')).toEqual([]);
        expect(plain).toMatchObject({ certification: null, modules: [], outcomes: [], instructors: [] });
        resetHarness();
        on('academy_courses', { kind: 'select', cols: COURSE_COLS }, { data: courseRow({ certification_id: 9 }) });
        await expect(getCourseDetail('c1')).resolves.toMatchObject({ certificationId: 9, certification: null });
    });
});

describe('getSessionDetail', () => {
    it('a read fault throws; a missing session (or table) is the opaque denial', async () => {
        on('academy_sessions', { kind: 'select' }, { error: { code: 'X' } });
        await expect(getSessionDetail('s1')).rejects.toThrow('Failed to load session');
        resetHarness();
        on('academy_sessions', { kind: 'select' }, { error: { code: '42P01' } });
        await expect(getSessionDetail('s1')).rejects.toThrow('This session is not available.');
        resetHarness();
        await expect(getSessionDetail('s1')).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('academy_enrollments')).toEqual([]);
    });

    it('hydrates instructors (dropping vanished users) and the roster with student refs; count excludes withdrawn', async () => {
        on('academy_sessions', { kind: 'select', cols: SESSION_COLS }, { data: sessionRow() });
        on('academy_session_instructors', { kind: 'select' }, { data: [{ user_id: 10 }, { user_id: 404 }] });
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_COLS }, { data: [
            enrollmentRow({ id: 'e1', student_id: 20 }), enrollmentRow({ id: 'e2', student_id: 21, status: 'withdrawn' }),
        ] });
        seedRefs({ 10: { name: 'Alpha' }, 20: { name: 'Ace' } });
        const { session, enrollments } = await getSessionDetail('s1');
        expect(session.instructors).toEqual([{ id: 10, name: 'Alpha', avatarUrl: '', rsiHandle: '' }]);
        expect(enrollments.map(e => [e.id, e.student?.name ?? null])).toEqual([['e1', 'Ace'], ['e2', null]]);
        expect(session.enrollmentCount).toBe(1);
        const [iq] = queriesOn('academy_session_instructors');
        expect(colsOf(iq)).toBe('user_id');
        expect(eqsOf(iq)).toEqual({ session_id: 's1' });
        expect(argOf(iq, 'limit')).toEqual([500]);
        const [eq] = queriesOn('academy_enrollments');
        expect(eqsOf(eq)).toEqual({ session_id: 's1' });
        expect(argsOf(eq, 'order')).toEqual([['enrolled_at', { ascending: true }], ['id', { ascending: true }]]);
        expect(argOf(eq, 'limit')).toEqual([500]);
    });

    it('an empty session has no instructors and a zero count', async () => {
        on('academy_sessions', { kind: 'select', cols: SESSION_COLS }, { data: sessionRow() });
        const { session, enrollments } = await getSessionDetail('s1');
        expect(session.instructors).toEqual([]);
        expect(enrollments).toEqual([]);
        expect(session.enrollmentCount).toBe(0);
        expect(queriesOn('users')).toEqual([]);
    });
});

describe('getEnrollmentDetail (self or staff)', () => {
    const seedEnr = (student_id = 20) =>
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_COLS }, { data: enrollmentRow({ student_id }) });

    it('a read fault throws; a missing enrolment (or table) is the opaque denial', async () => {
        on('academy_enrollments', { kind: 'select' }, { error: { code: 'X' } });
        await expect(getEnrollmentDetail('e1', 20, false)).rejects.toThrow('Failed to load enrolment');
        resetHarness();
        on('academy_enrollments', { kind: 'select' }, { error: { code: '42P01' } });
        await expect(getEnrollmentDetail('e1', 20, false)).rejects.toThrow('This enrolment is not available.');
        resetHarness();
        await expect(getEnrollmentDetail('e1', 20, false)).rejects.toBeInstanceOf(SecurityDenial);
    });

    it("another member's enrolment is denied BEFORE any progress/result/course read", async () => {
        seedEnr(21);
        const err = await getEnrollmentDetail('e1', 20, false).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Not authorised to view this enrolment.');
        expect(queriesOn('academy_lesson_progress')).toEqual([]);
        expect(queriesOn('academy_outcome_results')).toEqual([]);
        expect(queriesOn('academy_sessions')).toEqual([]);
        expect(queriesOn('users')).toEqual([]);
    });

    it.each([
        ['the student themselves', 20, false],
        ['an academy:view holder', 99, true],
    ] as const)('%s gets progress, results, the student ref and the course tree', async (_label, actor, canView) => {
        seedEnr(20);
        on('academy_lesson_progress', { kind: 'select' }, { data: [{ id: 1, enrollment_id: 'e1', lesson_id: 80, completed_by: 20, completed_at: 't' }] });
        on('academy_outcome_results', { kind: 'select' }, { data: [{ id: 2, enrollment_id: 'e1', outcome_id: 1, verdict: 'competent', assessed_by: 10, assessed_at: 't' }] });
        seedRefs({ 20: { name: 'Ace' } });
        seedSession();
        on('academy_courses', { kind: 'select', cols: COURSE_COLS }, { data: courseRow({ title: 'SAR' }) });
        const { enrollment, course } = await getEnrollmentDetail('e1', actor, canView);
        expect(enrollment.lessonProgress).toEqual([{ id: 1, enrollmentId: 'e1', lessonId: 80, completedBy: 20, completedAt: 't' }]);
        expect(enrollment.outcomeResults).toEqual([{ id: 2, enrollmentId: 'e1', outcomeId: 1, verdict: 'competent', assessedBy: 10, assessedAt: 't' }]);
        expect(enrollment.student).toEqual({ id: 20, name: 'Ace', avatarUrl: '', rsiHandle: '' });
        expect(course).toMatchObject({ id: 'c1', title: 'SAR' });
        const [pq] = queriesOn('academy_lesson_progress');
        expect(colsOf(pq)).toBe('id, enrollment_id, lesson_id, completed_by, completed_at');
        expect(eqsOf(pq)).toEqual({ enrollment_id: 'e1' });
        const [rq] = queriesOn('academy_outcome_results');
        expect(colsOf(rq)).toBe('id, enrollment_id, outcome_id, verdict, assessed_by, assessed_at');
        expect(eqsOf(rq)).toEqual({ enrollment_id: 'e1' });
    });

    it('missing child rows hydrate as empty, and a vanished student ref as null', async () => {
        seedEnr(20); seedSession();
        on('academy_courses', { kind: 'select', cols: COURSE_COLS }, { data: courseRow() });
        const { enrollment } = await getEnrollmentDetail('e1', 20, false);
        expect(enrollment.lessonProgress).toEqual([]);
        expect(enrollment.outcomeResults).toEqual([]);
        expect(enrollment.student).toBeNull();
    });
});

describe('getCatalogCourse (published only)', () => {
    it.each([null, { status: 'draft' }, { status: 'pending_approval' }, { status: 'archived' }])(
        'a course that is not published (%o) is denied before the detail read', async (row) => {
            on('academy_courses', { kind: 'select', cols: 'status' }, { data: row });
            const err = await getCatalogCourse('c1').catch((e: unknown) => e);
            expect(err).toBeInstanceOf(SecurityDenial);
            expect((err as SecurityDenial).message).toBe('Course is not available.');
            expect(queriesOn('academy_courses').filter(q => colsOf(q) === COURSE_COLS)).toEqual([]);
            expect(queriesOn('academy_sessions')).toEqual([]);
        });

    it('returns the course plus its open, scheduled/in-progress sessions with live seat counts', async () => {
        on('academy_courses', { kind: 'select', cols: 'status' }, { data: { status: 'published' } });
        on('academy_courses', { kind: 'select', cols: COURSE_COLS }, { data: courseRow({ status: 'published' }) });
        on('academy_sessions', { kind: 'select', cols: SESSION_COLS }, { data: [sessionRow({ id: 's1' }), sessionRow({ id: 's2' })] });
        on('academy_enrollments', { kind: 'select' }, { data: [
            { session_id: 's1', status: 'enrolled' }, { session_id: 's1', status: 'withdrawn' }, { session_id: 's1', status: 'in_progress' },
        ] });
        const { course, sessions } = await getCatalogCourse('c1');
        expect(course.id).toBe('c1');
        expect(sessions.map(s => [s.id, s.enrollmentCount])).toEqual([['s1', 2], ['s2', 0]]);
        const [sq] = queriesOn('academy_sessions');
        expect(eqsOf(sq)).toEqual({ course_id: 'c1', enrollment_open: true });
        expect(argOf(sq, 'in')).toEqual(['status', ['scheduled', 'in_progress']]);
        expect(argsOf(sq, 'order')).toEqual([['starts_at', { ascending: true }], ['id', { ascending: true }]]);
        expect(argOf(sq, 'limit')).toEqual([100]);
        const [eq] = queriesOn('academy_enrollments');
        expect(colsOf(eq)).toBe('session_id, status');
        expect(argOf(eq, 'in')).toEqual(['session_id', ['s1', 's2']]);
        expect(argOf(eq, 'limit')).toEqual([5000]);
    });

    it('no open sessions → no seat-count read', async () => {
        on('academy_courses', { kind: 'select', cols: 'status' }, { data: { status: 'published' } });
        on('academy_courses', { kind: 'select', cols: COURSE_COLS }, { data: courseRow({ status: 'published' }) });
        await expect(getCatalogCourse('c1')).resolves.toMatchObject({ sessions: [] });
        expect(queriesOn('academy_enrollments')).toEqual([]);
    });
});
