import { describe, it, expect, vi, beforeEach } from 'vitest';

// api/actions/academy.ts — handler wiring for every academy:* RPC.
//
// The predicates themselves are pinned in tests/permissionImplications.test.ts. What
// this file pins is that EACH handler feeds the RIGHT one into the RIGHT slot:
//   · M  = isManager (academy:manage)           — the BOLA bypass for instruct actions
//   · A  = isAwarder (admin:award:certification) — the second gate on certification;
//          academy:manage alone must NOT satisfy it
//   · V  = isViewer (isSystemAdmin or academy:view, with implications) — the only
//          authorisation for reading someone else's enrolment
// A handler that passed `true`, or passed M where A belongs, would silently widen a
// gate, so every flag-bearing action runs twice: once with the flag true, once false.
// Every payload also carries hostile extras (a studentId, an organizationId) that must
// not reach the db layer.

const h = vi.hoisted(() => {
    const names = [
        'createCourse', 'updateCourse', 'deleteCourse', 'submitCourseForApproval', 'setCourseCertification',
        'approveCourse', 'rejectCourse', 'setCourseArchived', 'setCourseAccess', 'addCourseInstructor',
        'addCourseInstructors', 'removeCourseInstructor', 'createModule', 'updateModule', 'deleteModule',
        'createLesson', 'updateLesson', 'deleteLesson', 'createOutcome', 'updateOutcome', 'deleteOutcome',
        'reorderModules', 'reorderLessons', 'reorderOutcomes', 'createSession', 'updateSession', 'setSessionStatus',
        'addSessionInstructor', 'removeSessionInstructor', 'selfEnroll', 'assignStudents', 'requestEnrollment',
        'withdrawEnrollmentRequest', 'decideEnrollmentRequest', 'listEnrollmentRequests', 'listMyEnrollmentRequests',
        'withdrawEnrollment', 'markLesson', 'assessOutcome', 'recommendForCertification', 'withdrawEnrollmentsBulk',
        'recommendEnrollmentsBulk', 'certifyAndComplete', 'getCourseDetail', 'listCourseReviews', 'getSessionDetail',
        'getEnrollmentDetail', 'getCatalogCourse', 'listRecommendedEnrollments', 'reportCompletions',
        'reportCourseActivity', 'reportCertificationHolders', 'reportMemberTranscript',
    ];
    const db: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const n of names) db[n] = vi.fn();
    return { db, names };
});

vi.mock('../lib/db', () => h.db);

import { academyActions } from '../api/actions/academy';

type Handler = (payload: unknown) => Promise<unknown>;
const ACTIONS = academyActions as unknown as Record<string, Handler>;
const run = (action: string, payload: unknown = {}) => ACTIONS[action](payload);
const fn = (name: string) => h.db[name];
const dbCallCount = () => h.names.reduce((n, name) => n + fn(name).mock.calls.length, 0);

beforeEach(() => {
    vi.resetAllMocks();
});

const ACTOR = 7;
const MANAGER = { permissions: ['academy:manage', 'academy:instruct', 'academy:view'] };
const INSTRUCTOR = { permissions: ['academy:instruct', 'academy:view'] };
const AWARDER = { permissions: ['admin:award:certification'] };
const HOSTILE = { studentId: 99, organizationId: 1, isManager: true };

type Flag = 'M' | 'A' | null;
// [action, payload, db fn, args(flag), which flag]
type Case = [string, Record<string, unknown>, string, (f: boolean) => unknown[], Flag];

const C = 'c-1', S = 's-1', E = 'e-1', R = 'r-1';
const CASES: Case[] = [
    // ── Courses
    ['academy:create_course', { title: 'T', description: 'D', icon: 'i', imageUrl: 'u', delivery: 'self_paced', sortOrder: 4 }, 'createCourse',
        () => [ACTOR, { title: 'T', description: 'D', icon: 'i', imageUrl: 'u', delivery: 'self_paced' }], null],
    ['academy:update_course', { courseId: C, title: 'T', description: null, icon: null, imageUrl: null, sortOrder: 2, delivery: 'cohort', status: 'approved' }, 'updateCourse',
        (f) => [C, ACTOR, f, { title: 'T', description: null, icon: null, imageUrl: null, sortOrder: 2, delivery: 'cohort' }], 'M'],
    ['academy:delete_course', { courseId: C }, 'deleteCourse', (f) => [C, ACTOR, f], 'M'],
    ['academy:submit_course', { courseId: C }, 'submitCourseForApproval', (f) => [C, ACTOR, f], 'M'],
    ['academy:set_course_certification', { courseId: C, certificationId: 3 }, 'setCourseCertification', (f) => [C, 3, ACTOR, f], 'A'],
    ['academy:approve_course', { courseId: C, note: 'ok' }, 'approveCourse', () => [C, ACTOR, 'ok'], null],
    ['academy:reject_course', { courseId: C, note: 'fix module 2' }, 'rejectCourse', () => [C, ACTOR, 'fix module 2'], null],
    ['academy:set_course_access', { courseId: C, access: 'gated' }, 'setCourseAccess', () => [C, 'gated'], null],
    ['academy:add_course_instructor', { courseId: C, targetUserId: 3 }, 'addCourseInstructor', (f) => [C, 3, ACTOR, f], 'M'],
    ['academy:add_course_instructors', { courseId: C, targetUserIds: [3, 4] }, 'addCourseInstructors', (f) => [C, [3, 4], ACTOR, f], 'M'],
    ['academy:remove_course_instructor', { courseId: C, targetUserId: 3 }, 'removeCourseInstructor', (f) => [C, 3, ACTOR, f], 'M'],
    // ── Modules · lessons · outcomes
    ['academy:create_module', { courseId: C, title: 'M', description: 'd', sortOrder: 1 }, 'createModule',
        (f) => [C, ACTOR, f, { title: 'M', description: 'd', sortOrder: 1 }], 'M'],
    ['academy:update_module', { moduleId: 5, title: 'M', description: null, sortOrder: 2, courseId: 'other' }, 'updateModule',
        (f) => [5, ACTOR, f, { title: 'M', description: null, sortOrder: 2 }], 'M'],
    ['academy:delete_module', { moduleId: 5 }, 'deleteModule', (f) => [5, ACTOR, f], 'M'],
    ['academy:create_lesson', { moduleId: 5, title: 'L', content: '<p>x</p>', videoUrl: 'v', sortOrder: 1, estimatedMinutes: 15 }, 'createLesson',
        (f) => [5, ACTOR, f, { title: 'L', content: '<p>x</p>', videoUrl: 'v', sortOrder: 1, estimatedMinutes: 15 }], 'M'],
    ['academy:update_lesson', { lessonId: 6, title: 'L', content: null, videoUrl: null, sortOrder: 0, estimatedMinutes: null, moduleId: 99 }, 'updateLesson',
        (f) => [6, ACTOR, f, { title: 'L', content: null, videoUrl: null, sortOrder: 0, estimatedMinutes: null }], 'M'],
    ['academy:delete_lesson', { lessonId: 6 }, 'deleteLesson', (f) => [6, ACTOR, f], 'M'],
    ['academy:create_outcome', { courseId: C, title: 'O', description: 'd', sortOrder: 1, required: true }, 'createOutcome',
        (f) => [C, ACTOR, f, { title: 'O', description: 'd', sortOrder: 1, required: true }], 'M'],
    ['academy:update_outcome', { outcomeId: 8, title: 'O', description: null, sortOrder: 3, required: false }, 'updateOutcome',
        (f) => [8, ACTOR, f, { title: 'O', description: null, sortOrder: 3, required: false }], 'M'],
    ['academy:delete_outcome', { outcomeId: 8 }, 'deleteOutcome', (f) => [8, ACTOR, f], 'M'],
    // orderedIds is passed through UNVALIDATED on purpose — the db layer owns the shape check.
    ['academy:reorder_modules', { courseId: C, orderedIds: [3, 1, 2] }, 'reorderModules', (f) => [C, [3, 1, 2], ACTOR, f], 'M'],
    ['academy:reorder_lessons', { moduleId: 5, orderedIds: 'not-a-list' }, 'reorderLessons', (f) => [5, 'not-a-list', ACTOR, f], 'M'],
    ['academy:reorder_outcomes', { courseId: C, orderedIds: [8] }, 'reorderOutcomes', (f) => [C, [8], ACTOR, f], 'M'],
    // ── Sessions
    ['academy:create_session', { courseId: C, title: 'S', startsAt: 'a', endsAt: 'b', location: 'Lorville', capacity: 12, enrollmentOpen: true }, 'createSession',
        (f) => [C, ACTOR, f, { title: 'S', startsAt: 'a', endsAt: 'b', location: 'Lorville', capacity: 12, enrollmentOpen: true }], 'M'],
    ['academy:update_session', { sessionId: S, title: 'S', startsAt: null, endsAt: null, location: null, capacity: null, enrollmentOpen: false, status: 'completed' }, 'updateSession',
        (f) => [S, ACTOR, f, { title: 'S', startsAt: null, endsAt: null, location: null, capacity: null, enrollmentOpen: false }], 'M'],
    ['academy:set_session_status', { sessionId: S, status: 'in_progress' }, 'setSessionStatus', (f) => [S, 'in_progress', ACTOR, f], 'M'],
    ['academy:add_session_instructor', { sessionId: S, targetUserId: 3 }, 'addSessionInstructor', (f) => [S, 3, ACTOR, f], 'M'],
    ['academy:remove_session_instructor', { sessionId: S, targetUserId: 3 }, 'removeSessionInstructor', (f) => [S, 3, ACTOR, f], 'M'],
    // ── Enrolment · progress · assessment
    ['academy:self_enroll', { sessionId: S }, 'selfEnroll', () => [S, ACTOR], null],
    ['academy:assign_students', { sessionId: S, studentIds: [3, 4] }, 'assignStudents', (f) => [S, [3, 4], ACTOR, f], 'M'],
    ['academy:request_enrollment', { sessionId: S, message: 'please' }, 'requestEnrollment', () => [S, ACTOR, 'please'], null],
    ['academy:withdraw_enrollment_request', { requestId: R }, 'withdrawEnrollmentRequest', () => [R, ACTOR], null],
    ['academy:decide_enrollment_request', { requestId: R, decision: 'approve', reason: 'welcome' }, 'decideEnrollmentRequest',
        (f) => [R, 'approve', ACTOR, f, 'welcome'], 'M'],
    ['academy:list_enrollment_requests', { sessionId: S }, 'listEnrollmentRequests', (f) => [S, ACTOR, f], 'M'],
    ['academy:list_my_enrollment_requests', {}, 'listMyEnrollmentRequests', () => [ACTOR], null],
    ['academy:withdraw_enrollment', { enrollmentId: E }, 'withdrawEnrollment', (f) => [E, ACTOR, f], 'M'],
    ['academy:mark_lesson', { enrollmentId: E, lessonId: 6, completed: false }, 'markLesson', (f) => [E, 6, false, ACTOR, f], 'M'],
    ['academy:assess_outcome', { enrollmentId: E, outcomeId: 8, verdict: 'competent' }, 'assessOutcome', (f) => [E, 8, 'competent', ACTOR, f], 'M'],
    ['academy:recommend_certification', { enrollmentId: E }, 'recommendForCertification', (f) => [E, ACTOR, f], 'M'],
    ['academy:withdraw_enrollments_bulk', { sessionId: S, enrollmentIds: ['e-1', 'e-2'] }, 'withdrawEnrollmentsBulk', (f) => [S, ['e-1', 'e-2'], ACTOR, f], 'M'],
    ['academy:recommend_enrollments_bulk', { sessionId: S, enrollmentIds: ['e-1'] }, 'recommendEnrollmentsBulk', (f) => [S, ['e-1'], ACTOR, f], 'M'],
    ['academy:certify_and_complete', { enrollmentId: E }, 'certifyAndComplete', (f) => [E, ACTOR, f], 'A'],
    // ── Reads
    ['academy:get_course', { courseId: C }, 'getCourseDetail', () => [C], null],
    ['academy:list_course_reviews', { courseId: C }, 'listCourseReviews', () => [C], null],
    ['academy:get_session', { sessionId: S }, 'getSessionDetail', () => [S], null],
    ['academy:get_catalog_course', { courseId: C }, 'getCatalogCourse', () => [C], null],
    ['academy:list_recommended', {}, 'listRecommendedEnrollments', () => [], null],
    ['academy:report_completions', { sinceDays: 30, limit: 'lots' }, 'reportCompletions', () => [{ sinceDays: 30, limit: 'lots' }], null],
    ['academy:report_course_activity', {}, 'reportCourseActivity', () => [], null],
    ['academy:report_cert_holders', { certificationId: 3 }, 'reportCertificationHolders', () => [3], null],
    // targetUserId is a TARGET field (not overwritten by the dispatcher) — the report
    // reads somebody else's record, which is why it sits behind academy:manage.
    ['academy:report_member_transcript', { targetUserId: 3 }, 'reportMemberTranscript', () => [3], null],
];

const TRUE_USER: Record<'M' | 'A', object> = { M: MANAGER, A: AWARDER };
// The "false" user for each flag is the CLOSEST miss: an instructor for M, and a full
// Learning Manager for A — academy:manage must not stand in for the award permission.
const FALSE_USER: Record<'M' | 'A', object> = { M: INSTRUCTOR, A: MANAGER };

describe('every academy handler forwards exactly its fields, with the right gate in the right slot', () => {
    it.each(CASES)('%s → %s', async (action, payload, dbFn, args, flag) => {
        const runs: Array<[object, boolean]> = flag ? [[TRUE_USER[flag], true], [FALSE_USER[flag], false]] : [[MANAGER, true]];
        for (const [user, expected] of runs) {
            vi.resetAllMocks();
            const result = { marker: action };
            fn(dbFn).mockResolvedValueOnce(result);
            await expect(run(action, { ...HOSTILE, ...payload, userId: ACTOR, user })).resolves.toBe(result);
            expect(fn(dbFn).mock.calls).toStrictEqual([args(expected)]);
            expect(dbCallCount()).toBe(1);
        }
    });

    it('a missing user object fails every gate closed', async () => {
        fn('deleteCourse').mockResolvedValue(undefined);
        fn('certifyAndComplete').mockResolvedValue(undefined);
        fn('getEnrollmentDetail').mockResolvedValue(null);
        await run('academy:delete_course', { userId: ACTOR, courseId: C });
        await run('academy:certify_and_complete', { userId: ACTOR, enrollmentId: E });
        await run('academy:get_enrollment', { userId: ACTOR, enrollmentId: E });
        expect(fn('deleteCourse').mock.calls).toStrictEqual([[C, ACTOR, false]]);
        expect(fn('certifyAndComplete').mock.calls).toStrictEqual([[E, ACTOR, false]]);
        expect(fn('getEnrollmentDetail').mock.calls).toStrictEqual([[E, ACTOR, false]]);
    });

    it('a db refusal propagates unchanged', async () => {
        fn('certifyAndComplete').mockRejectedValueOnce(new Error('You do not have permission to award certifications.'));
        await expect(run('academy:certify_and_complete', { userId: ACTOR, user: MANAGER, enrollmentId: E }))
            .rejects.toThrow('You do not have permission to award certifications.');
        fn('rejectCourse').mockRejectedValueOnce(new Error('A rejection needs a note.'));
        await expect(run('academy:reject_course', { userId: ACTOR, courseId: C })).rejects.toThrow('A rejection needs a note.');
    });
});

describe('academy:get_enrollment — isViewer is the only authorisation for a non-student read', () => {
    it.each([
        ['a system admin with no academy permission', { isSystemAdmin: true, permissions: [] }, true],
        ['an academy:view holder', { permissions: ['academy:view'] }, true],
        ['an instructor never ticked academy:view (implied)', { permissions: ['academy:instruct'] }, true],
        ['a Learning Manager never ticked academy:view (implied)', { permissions: ['academy:manage'] }, true],
        ['a member with only enrolment permissions', { permissions: ['academy:enroll'] }, false],
        ['an awarder without any academy read', { permissions: ['admin:award:certification'] }, false],
        ['a truthy-but-not-true isSystemAdmin', { isSystemAdmin: 'true', permissions: [] }, false],
        ['a user with no permissions array', {}, false],
    ])('%s → %s', async (_label, user, expected) => {
        fn('getEnrollmentDetail').mockResolvedValueOnce({ id: E });
        await expect(run('academy:get_enrollment', { userId: ACTOR, user, enrollmentId: E, studentId: 99 })).resolves.toStrictEqual({ id: E });
        expect(fn('getEnrollmentDetail').mock.calls).toStrictEqual([[E, ACTOR, expected]]);
    });
});

describe('coercions the handlers own', () => {
    it('id lists that are not arrays become [] — never a string or object handed to .in()', async () => {
        for (const n of ['addCourseInstructors', 'assignStudents', 'withdrawEnrollmentsBulk', 'recommendEnrollmentsBulk']) fn(n).mockResolvedValue(undefined);
        await run('academy:add_course_instructors', { userId: ACTOR, user: MANAGER, courseId: C, targetUserIds: '3,4' });
        await run('academy:assign_students', { userId: ACTOR, user: MANAGER, sessionId: S, studentIds: { 0: 3 } });
        await run('academy:withdraw_enrollments_bulk', { userId: ACTOR, user: MANAGER, sessionId: S });
        await run('academy:recommend_enrollments_bulk', { userId: ACTOR, user: MANAGER, sessionId: S, enrollmentIds: null });
        expect(fn('addCourseInstructors').mock.calls[0][1]).toStrictEqual([]);
        expect(fn('assignStudents').mock.calls[0][1]).toStrictEqual([]);
        expect(fn('withdrawEnrollmentsBulk').mock.calls[0][1]).toStrictEqual([]);
        expect(fn('recommendEnrollmentsBulk').mock.calls[0][1]).toStrictEqual([]);
    });

    it('a decision is "approve" only when exactly that; anything else is a denial', async () => {
        fn('decideEnrollmentRequest').mockResolvedValue(undefined);
        for (const decision of ['approve', 'APPROVE', 'approved', undefined, 'deny']) {
            await run('academy:decide_enrollment_request', { userId: ACTOR, user: INSTRUCTOR, requestId: R, decision });
        }
        expect(fn('decideEnrollmentRequest').mock.calls.map((c) => c[1])).toStrictEqual(['approve', 'deny', 'deny', 'deny', 'deny']);
    });

    it('mark_lesson marks complete unless completed is literally false', async () => {
        fn('markLesson').mockResolvedValue(undefined);
        for (const completed of [undefined, true, false, 0, null]) {
            await run('academy:mark_lesson', { userId: ACTOR, user: INSTRUCTOR, enrollmentId: E, lessonId: 6, completed });
        }
        expect(fn('markLesson').mock.calls.map((c) => c[2])).toStrictEqual([true, true, false, true, true]);
    });

    it('set_course_archived coerces to a boolean', async () => {
        fn('setCourseArchived').mockResolvedValue(undefined);
        await run('academy:set_course_archived', { userId: ACTOR, courseId: C, archived: 'yes' });
        await run('academy:set_course_archived', { userId: ACTOR, courseId: C });
        expect(fn('setCourseArchived').mock.calls).toStrictEqual([[C, true], [C, false]]);
    });

    it('set_course_certification: an absent certification clears it (null); 0 is kept', async () => {
        fn('setCourseCertification').mockResolvedValue(undefined);
        await run('academy:set_course_certification', { userId: ACTOR, user: AWARDER, courseId: C });
        await run('academy:set_course_certification', { userId: ACTOR, user: AWARDER, courseId: C, certificationId: null });
        await run('academy:set_course_certification', { userId: ACTOR, user: AWARDER, courseId: C, certificationId: 0 });
        expect(fn('setCourseCertification').mock.calls.map((c) => c[1])).toStrictEqual([null, null, 0]);
    });
});

describe('module surface', () => {
    it('every exported academy handler is exercised by this file', () => {
        const covered = new Set([...CASES.map(([a]) => a), 'academy:get_enrollment', 'academy:set_course_archived']);
        expect(Object.keys(ACTIONS).sort()).toStrictEqual([...covered].sort());
    });
});
