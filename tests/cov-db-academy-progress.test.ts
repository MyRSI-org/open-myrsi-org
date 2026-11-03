import { describe, it, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// lib/db/academy.ts — PROGRESS, ASSESSMENT, RECOMMENDATION, CERTIFICATION
// =============================================================================
// Pins the sign-off ladder: a lesson / outcome must belong to the enrolment's course
// (cross-course BOLA), students may tick their own lessons but can NEVER write a
// competency verdict, a recommendation needs every REQUIRED outcome competent, and
// certification is the double gate (academy:manage at the dispatcher + cert-award
// authority here) with the D12 client-tier refusal failing closed on BOTH legs, and an
// idempotent award.
vi.mock('../lib/db/common.js', async () => {
    const hh = await import('./cov-db-academy-harness');
    return { supabase: hh.supabaseStub, handleSupabaseError: hh.handleSupabaseError, broadcastToOrg: hh.broadcastToOrg };
});
vi.mock('../lib/db/system.js', async () => ({ awardCertification: (await import('./cov-db-academy-harness')).awardCertification }));
vi.mock('../lib/db/notifications.js', async () => ({ createNotification: (await import('./cov-db-academy-harness')).createNotification }));
vi.mock('../lib/db/clientRoleLock.js', async () => ({ requireClientRoleId: (await import('./cov-db-academy-harness')).requireClientRoleId }));
vi.mock('../lib/log.js', async () => ({ log: (await import('./cov-db-academy-harness')).logSpy }));

import {
    on, resetHarness, queriesOn, writesOn, broadcasts, notifications, assertNoWildcardSelects,
    argOf, colsOf, eqsOf, payloadOf, requireClientRoleId, awardCertification, logSpy, CLIENT_ROLE_ID,
    seedCourse, seedSession, seedEnrollment, seedCourseInstructor, seedSessionInstructor, USER_REF_COLS, type Q,
} from './cov-db-academy-harness';
import { markLesson, assessOutcome, recommendForCertification, certifyAndComplete } from '../lib/db/academy';
import { SecurityDenial } from '../lib/errors';

beforeEach(() => resetHarness());

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Lesson 8 → module 5 → course `courseId`. */
function seedLessonChain(courseId = 'c1'): void {
    on('academy_lessons', { kind: 'select', cols: 'module_id', eq: { id: 8 } }, { data: { module_id: 5 } });
    on('academy_modules', { kind: 'select', cols: 'course_id', eq: { id: 5 } }, { data: { course_id: courseId } });
}
function seedOutcomeOwner(courseId = 'c1'): void {
    on('academy_outcomes', { kind: 'select', cols: 'course_id', eq: { id: 3 } }, { data: { course_id: courseId } });
}
/** allRequiredOutcomesCompetent inputs. */
function seedOutcomeState(outcomes: Array<{ id: number; required?: boolean | null }>, results: Array<{ outcome_id: number; verdict: string }>): void {
    on('academy_outcomes', { kind: 'select', cols: 'id, required' }, { data: outcomes });
    on('academy_outcome_results', { kind: 'select', cols: 'outcome_id, verdict' }, { data: results });
}
function seedCtx(title = 'Intro to SAR'): void {
    on('academy_sessions', { kind: 'select', cols: 'course_id' }, { data: { course_id: 'c1' } });
    on('academy_courses', { kind: 'select', cols: 'title' }, { data: { title } });
}
function seedManagers(ids: number[]): void {
    on('permissions', { kind: 'select', cols: 'id' }, { data: [{ id: 900 }] });
    on('role_permissions', { kind: 'select', cols: 'role_id' }, { data: [{ role_id: 3 }] });
    on('users', { kind: 'select', cols: 'id', where: (q: Q) => argOf(q, 'in')?.[0] === 'role_id' }, { data: ids.map(id => ({ id })) });
}

/** Non-student actors that may act on an enrolment: [label, actorId, canManage, seed]. */
const STAFF_ACTORS: ReadonlyArray<readonly [string, number, boolean, () => void]> = [
    ['a manager', 1, true, () => undefined],
    ['a session instructor', 55, false, () => seedSessionInstructor('s1', 55)],
    ['a course instructor', 56, false, () => seedCourseInstructor('c1', 56)],
];

// ════════════════════════════════════════════════════════════════════════════
describe('markLesson', () => {
    it('a lesson from ANOTHER course is refused (cross-course BOLA), nothing written', async () => {
        seedEnrollment({ student_id: 20 }); seedLessonChain('cOther'); seedCourse({ id: 'cOther' }); seedSession();
        const err = await markLesson('e1', 8, true, 20, false).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Lesson does not belong to this enrolment.');
        expect(queriesOn('academy_lesson_progress')).toEqual([]);
    });

    it('a stranger (not self, not manager, not instructor) is refused after checking both instructor tables', async () => {
        seedEnrollment({ student_id: 20 }); seedLessonChain(); seedCourse(); seedSession();
        const err = await markLesson('e1', 8, true, 99, false).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Not authorised to mark this lesson.');
        expect(eqsOf(queriesOn('academy_session_instructors')[0])).toEqual({ session_id: 's1', user_id: 99 });
        expect(eqsOf(queriesOn('academy_course_instructors')[0])).toEqual({ course_id: 'c1', user_id: 99 });
        expect(queriesOn('academy_lesson_progress')).toEqual([]);
    });

    it('the student marks their own lesson; an "enrolled" enrolment advances to in_progress', async () => {
        seedEnrollment({ student_id: 20, status: 'enrolled' }); seedLessonChain(); seedCourse(); seedSession();
        await markLesson('e1', 8, true, 20, false);
        expect(queriesOn('academy_session_instructors')).toEqual([]);
        expect(writesOn('academy_lesson_progress', 'insert')).toEqual([{ enrollment_id: 'e1', lesson_id: 8, completed_by: 20 }]);
        const [upd] = queriesOn('academy_enrollments', 'update');
        expect(payloadOf(upd)).toEqual({ status: 'in_progress' });
        expect(eqsOf(upd)).toEqual({ id: 'e1' });
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
    });

    it('an in_progress enrolment is not re-stamped', async () => {
        seedEnrollment({ student_id: 20, status: 'in_progress' }); seedLessonChain(); seedCourse(); seedSession();
        await markLesson('e1', 8, true, 20, false);
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
    });

    it.each(STAFF_ACTORS)('%s may override, recorded as completed_by the actor', async (_label, actor, canManage, seed) => {
        seedEnrollment({ student_id: 20, status: 'in_progress' }); seedLessonChain(); seedCourse(); seedSession();
        seed();
        await markLesson('e1', 8, true, actor, canManage);
        expect(writesOn('academy_lesson_progress', 'insert')).toEqual([{ enrollment_id: 'e1', lesson_id: 8, completed_by: actor }]);
    });

    it('re-marking (23505) is idempotent; any other insert error throws', async () => {
        seedEnrollment({ student_id: 20, status: 'in_progress' }); seedLessonChain(); seedCourse(); seedSession();
        on('academy_lesson_progress', { kind: 'insert' }, (q) => ({ error: { code: (payloadOf(q) as { completed_by: number }).completed_by === 20 ? '23505' : '23503' } }));
        await expect(markLesson('e1', 8, true, 20, false)).resolves.toBeUndefined();
        await expect(markLesson('e1', 8, true, 1, true)).rejects.toThrow('Failed to mark lesson');
    });

    it('un-marking deletes the (enrolment, lesson) row; errors surface', async () => {
        seedEnrollment({ student_id: 20 }); seedLessonChain(); seedCourse(); seedSession();
        await markLesson('e1', 8, false, 20, false);
        const [del] = queriesOn('academy_lesson_progress', 'delete');
        expect(eqsOf(del)).toEqual({ enrollment_id: 'e1', lesson_id: 8 });
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
        on('academy_lesson_progress', { kind: 'delete' }, { error: { code: 'X' } });
        await expect(markLesson('e1', 8, false, 20, false)).rejects.toThrow('Failed to unmark lesson');
    });

    it('an unknown enrolment / lesson is denied opaquely', async () => {
        await expect(markLesson('nope', 8, true, 20, false)).rejects.toThrow('This enrolment is not available.');
        seedEnrollment();
        await expect(markLesson('e1', 404, true, 20, false)).rejects.toThrow('This course is not available.');
        expect(queriesOn('academy_lesson_progress')).toEqual([]);
    });
});

describe('assessOutcome', () => {
    it('an invalid verdict is refused before any read', async () => {
        await expect(assessOutcome('e1', 3, 'excellent' as never, 1, true)).rejects.toThrow('Invalid verdict.');
        expect(queriesOn('academy_enrollments')).toEqual([]);
    });

    it('an outcome from another course is refused', async () => {
        seedEnrollment(); seedOutcomeOwner('cOther'); seedCourse({ id: 'cOther' }); seedSession();
        await expect(assessOutcome('e1', 3, 'competent', 1, true)).rejects.toThrow('Outcome does not belong to this enrolment.');
        expect(queriesOn('academy_outcome_results')).toEqual([]);
    });

    it('the STUDENT can never assess themselves', async () => {
        seedEnrollment({ student_id: 20 }); seedOutcomeOwner(); seedCourse(); seedSession();
        const err = await assessOutcome('e1', 3, 'competent', 20, false).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Only an instructor can assess competency.');
        expect(queriesOn('academy_outcome_results')).toEqual([]);
    });

    it.each(STAFF_ACTORS)('%s upserts the verdict on the (enrolment, outcome) key', async (_label, actor, canManage, seed) => {
        seedEnrollment(); seedOutcomeOwner(); seedCourse(); seedSession();
        seed();
        await assessOutcome('e1', 3, 'not_yet_competent', actor, canManage);
        const [up] = queriesOn('academy_outcome_results', 'upsert');
        expect(argOf(up, 'upsert')).toEqual([
            { enrollment_id: 'e1', outcome_id: 3, verdict: 'not_yet_competent', assessed_by: actor, assessed_at: expect.stringMatching(ISO_RE) },
            { onConflict: 'enrollment_id,outcome_id' },
        ]);
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
    });

    it('an upsert error surfaces the generic message', async () => {
        seedEnrollment(); seedOutcomeOwner(); seedCourse(); seedSession();
        on('academy_outcome_results', { kind: 'upsert' }, { error: { code: 'X' } });
        await expect(assessOutcome('e1', 3, 'competent', 1, true)).rejects.toThrow('Failed to assess outcome');
        expect(broadcasts()).toEqual([]);
    });
});

describe('recommendForCertification', () => {
    it('only an instructor / manager may recommend (the student cannot)', async () => {
        seedEnrollment({ student_id: 20 }); seedSession();
        await expect(recommendForCertification('e1', 20, false)).rejects.toThrow('Only an instructor can recommend for certification.');
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
    });

    it('refuses until every REQUIRED outcome is competent (optional ones ignored)', async () => {
        seedEnrollment(); seedSession(); seedSessionInstructor('s1', 55);
        seedOutcomeState([{ id: 1, required: true }, { id: 2, required: null }, { id: 3, required: false }],
            [{ outcome_id: 1, verdict: 'competent' }, { outcome_id: 2, verdict: 'not_yet_competent' }]);
        await expect(recommendForCertification('e1', 55, false)).rejects.toThrow('All required outcomes must be assessed competent before recommending.');
        const [oq] = queriesOn('academy_outcomes');
        expect(eqsOf(oq)).toEqual({ course_id: 'c1' });
        const [rq] = queriesOn('academy_outcome_results');
        expect(eqsOf(rq)).toEqual({ enrollment_id: 'e1' });
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
    });

    it('records the recommendation and notifies managers by student name', async () => {
        seedEnrollment({ student_id: 20 }); seedSession(); seedCourseInstructor('c1', 56); seedCtx(); seedManagers([1, 2]);
        seedOutcomeState([{ id: 1 }, { id: 3, required: false }], [{ outcome_id: 1, verdict: 'competent' }]);
        on('users', { kind: 'select', cols: USER_REF_COLS }, { data: [{ id: 20, name: 'Ace', avatar_url: null, rsi_handle: 'ace' }] });
        await recommendForCertification('e1', 56, false);
        const [upd] = queriesOn('academy_enrollments', 'update');
        expect(payloadOf(upd)).toEqual({ recommended_by: 56, recommended_at: expect.stringMatching(ISO_RE) });
        expect(eqsOf(upd)).toEqual({ id: 'e1' });
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
        expect(notifications().map(n => n.uid)).toEqual([1, 2]);
        expect(notifications()[0]).toMatchObject({
            type: 'academy_recommended', title: 'Ready for certification', link: 'academy',
            body: 'Ace has been recommended for certification in Intro to SAR.',
            metadata: { courseId: 'c1', sessionId: 's1', enrollmentId: 'e1', studentId: 20 },
        });
        const refQ = queriesOn('users').find(q => colsOf(q) === USER_REF_COLS)!;
        expect(argOf(refQ, 'in')).toEqual(['id', [20]]);
        assertNoWildcardSelects();
    });

    it('with no required outcomes, falls back to "A student" when the ref is missing', async () => {
        seedEnrollment({ student_id: 20 }); seedSession(); seedCtx(); seedManagers([1]);
        await recommendForCertification('e1', 1, true);
        expect(queriesOn('academy_outcome_results')).toEqual([]);
        expect(notifications()[0].body).toBe('A student has been recommended for certification in Intro to SAR.');
    });

    it('a missing user-ref TABLE (42P01) degrades to "A student"; any other ref fault throws', async () => {
        seedEnrollment({ student_id: 20 }); seedSession(); seedCtx(); seedManagers([1]);
        on('users', { kind: 'select', cols: USER_REF_COLS }, { error: { code: '42P01' } });
        await recommendForCertification('e1', 1, true);
        expect(notifications()[0].body).toBe('A student has been recommended for certification in Intro to SAR.');
        resetHarness();
        seedEnrollment({ student_id: 20 }); seedSession(); seedCtx(); seedManagers([1]);
        on('users', { kind: 'select', cols: USER_REF_COLS }, { error: { code: '57014' } });
        await expect(recommendForCertification('e1', 1, true)).rejects.toThrow('Failed to load academy user refs');
    });

    it('no managers / no context → recorded, nobody notified', async () => {
        seedEnrollment(); seedSession(); seedCtx();
        await recommendForCertification('e1', 1, true);
        expect(queriesOn('academy_enrollments', 'update')).toHaveLength(1);
        expect(notifications()).toEqual([]);
        resetHarness();
        seedEnrollment(); seedSession(); seedManagers([1]);
        await recommendForCertification('e1', 1, true);
        expect(notifications()).toEqual([]);
    });

    it('an update error surfaces the generic message', async () => {
        seedEnrollment(); seedSession();
        on('academy_enrollments', { kind: 'update' }, { error: { code: 'X' } });
        await expect(recommendForCertification('e1', 1, true)).rejects.toThrow('Failed to recommend for certification');
        expect(notifications()).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('certifyAndComplete', () => {
    const base = (enr: Partial<Record<string, unknown>> = {}, course: Partial<Record<string, unknown>> = {}) => {
        seedEnrollment({ student_id: 20, status: 'in_progress', ...enr });
        seedSession();
        seedCourse({ status: 'published', ...course });
    };
    const seedStudent = (role_id: number) =>
        on('users', { kind: 'select', cols: 'id, role_id' }, { data: { id: 20, role_id } });

    it('refuses a withdrawn enrolment', async () => {
        base({ status: 'withdrawn' });
        await expect(certifyAndComplete('e1', 1, true)).rejects.toThrow('Cannot certify a withdrawn enrolment.');
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
    });

    it('an already-completed enrolment is a no-op broadcast (no re-award, no tier read)', async () => {
        base({ status: 'completed' }, { certification_id: 9 });
        await certifyAndComplete('e1', 1, true);
        expect(awardCertification).not.toHaveBeenCalled();
        expect(requireClientRoleId).not.toHaveBeenCalled();
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
        expect(notifications()).toEqual([]);
    });

    it('refuses until every required outcome is competent', async () => {
        base();
        seedOutcomeState([{ id: 1 }], []);
        await expect(certifyAndComplete('e1', 1, true)).rejects.toThrow('All required outcomes must be competent before certifying.');
        expect(requireClientRoleId).not.toHaveBeenCalled();
    });

    it('FAILS CLOSED on an unresolvable client tier', async () => {
        base();
        requireClientRoleId.mockRejectedValueOnce(new Error('Role configuration unavailable'));
        await expect(certifyAndComplete('e1', 1, true)).rejects.toThrow('Role configuration unavailable');
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
    });

    it('a student-tier READ FAULT is a refusal, never "not a customer"', async () => {
        base();
        on('users', { kind: 'select', cols: 'id, role_id' }, { error: { code: '57014' } });
        await expect(certifyAndComplete('e1', 1, true)).rejects.toThrow('Failed to resolve student tier');
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
        expect(awardCertification).not.toHaveBeenCalled();
    });

    it('an unresolvable student row is an invalid-target denial', async () => {
        base();
        const err = await certifyAndComplete('e1', 1, true).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Could not resolve the student on this enrolment.');
        const tierQ = queriesOn('users')[0];
        expect(colsOf(tierQ)).toBe('id, role_id');
        expect(eqsOf(tierQ)).toEqual({ id: 20 });
        // deleted_at deliberately NOT filtered: the question is "is this a customer?".
        expect(argOf(tierQ, 'is')).toBeUndefined();
    });

    it('a CLIENT student cannot be certified — refused before the privilege gate, nothing pushed', async () => {
        base({}, { certification_id: 9 });
        seedStudent(CLIENT_ROLE_ID);
        const err = await certifyAndComplete('e1', 1, /* canAward */ false).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Client accounts cannot be certified. Withdraw the enrolment instead.');
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
        expect(notifications()).toEqual([]);
    });

    it('a course certification without cert-award authority is an escalation denial', async () => {
        base({}, { certification_id: 9 });
        seedStudent(3);
        const err = await certifyAndComplete('e1', 1, false).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).auditEvent).toBe('authz.escalation.denied');
        expect((err as SecurityDenial).fields).toEqual({ enrollmentId: 'e1', certId: 9 });
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
    });

    it('a cert-less course completes WITHOUT cert-award authority and tells the student', async () => {
        base();
        seedStudent(3); seedCtx();
        await certifyAndComplete('e1', 7, false);
        const [upd] = queriesOn('academy_enrollments', 'update');
        expect(payloadOf(upd)).toEqual({ status: 'completed', certified_by: 7, completed_at: expect.stringMatching(ISO_RE) });
        expect(eqsOf(upd)).toEqual({ id: 'e1' });
        expect(queriesOn('user_certifications')).toEqual([]);
        expect(awardCertification).not.toHaveBeenCalled();
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
        expect(notifications()).toEqual([{
            uid: 20, type: 'academy_completed', title: 'Course completed', body: "You've completed Intro to SAR.", link: 'academy',
            metadata: { courseId: 'c1', sessionId: 's1', enrollmentId: 'e1', certId: null },
        }]);
    });

    it('awards a certification the student does not hold, logs it, and names it in the notice', async () => {
        base({}, { certification_id: 9 });
        seedStudent(3); seedCtx();
        on('certifications', { kind: 'select', cols: 'name' }, { data: { name: 'Medic I' } });
        await certifyAndComplete('e1', 7, true);
        const [heldQ] = queriesOn('user_certifications');
        expect(colsOf(heldQ)).toBe('user_id');
        expect(eqsOf(heldQ)).toEqual({ user_id: 20, certification_id: 9 });
        expect(awardCertification).toHaveBeenCalledWith(20, 9, 7);
        expect(logSpy.info).toHaveBeenCalledWith('academy certification awarded', { studentId: 20, certId: 9, awardedBy: 7, enrollmentId: 'e1' });
        expect(eqsOf(queriesOn('certifications')[0])).toEqual({ id: 9 });
        expect(notifications()[0]).toMatchObject({
            body: "You've completed Intro to SAR and earned the Medic I certification.",
            metadata: { courseId: 'c1', sessionId: 's1', enrollmentId: 'e1', certId: 9 },
        });
    });

    it('does NOT re-award a certification already held (idempotent)', async () => {
        base({}, { certification_id: 9 });
        seedStudent(3);
        on('user_certifications', { kind: 'select' }, { data: { user_id: 20 } });
        await certifyAndComplete('e1', 7, true);
        expect(awardCertification).not.toHaveBeenCalled();
        expect(logSpy.info).not.toHaveBeenCalled();
        // No cert name resolved + no context → the fully generic body.
        expect(notifications()[0].body).toBe("You've completed your course.");
    });

    it('a completion write error surfaces the generic message and awards nothing', async () => {
        base({}, { certification_id: 9 });
        seedStudent(3);
        on('academy_enrollments', { kind: 'update' }, { error: { code: 'X' } });
        await expect(certifyAndComplete('e1', 7, true)).rejects.toThrow('Failed to complete enrolment');
        expect(awardCertification).not.toHaveBeenCalled();
        expect(notifications()).toEqual([]);
    });
});
