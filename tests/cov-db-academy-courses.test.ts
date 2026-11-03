import { describe, it, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// lib/db/academy.ts — COURSES: lifecycle, review trail, instructors
// =============================================================================
// Behaviour pins for the course half of the Academy data layer: input validation,
// the instructor/manager edit gate (BOLA), the approve/reject status machine and its
// mandatory review trail, the client-tier filter on instructor notifications, and
// the id-only realtime broadcast contract (Security rule 4).
vi.mock('../lib/db/common.js', async () => {
    const hh = await import('./cov-db-academy-harness');
    return { supabase: hh.supabaseStub, handleSupabaseError: hh.handleSupabaseError, broadcastToOrg: hh.broadcastToOrg };
});
vi.mock('../lib/db/system.js', async () => ({ awardCertification: (await import('./cov-db-academy-harness')).awardCertification }));
vi.mock('../lib/db/notifications.js', async () => ({ createNotification: (await import('./cov-db-academy-harness')).createNotification }));
vi.mock('../lib/db/clientRoleLock.js', async () => ({ requireClientRoleId: (await import('./cov-db-academy-harness')).requireClientRoleId }));
vi.mock('../lib/log.js', async () => ({ log: (await import('./cov-db-academy-harness')).logSpy }));

import {
    sb, on, once, resetHarness, queriesOn, writesOn, broadcasts, notifications, assertNoWildcardSelects,
    argOf, argsOf, colsOf, eqsOf, payloadOf, requireClientRoleId, createNotification,
    seedCourse, seedCourseInstructor, courseRow, COURSE_COLS, COURSE_GUARD_COLS, CLIENT_ROLE_ID,
} from './cov-db-academy-harness';
import {
    createCourse, updateCourse, deleteCourse, setCourseCertification, submitCourseForApproval,
    approveCourse, listCourseReviews, rejectCourse, setCourseArchived, setCourseAccess,
    addCourseInstructor, addCourseInstructors, removeCourseInstructor,
} from '../lib/db/academy';
import { SecurityDenial } from '../lib/errors';

beforeEach(() => resetHarness());

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Every query that was not a pure guard read on the given table. */
const courseUpdates = () => writesOn('academy_courses', 'update') as Array<Record<string, unknown>>;

describe('createCourse', () => {
    it('rejects a blank title before touching the database', async () => {
        await expect(createCourse(10, { title: '   ' })).rejects.toThrow('Course title is required.');
        await expect(createCourse(10, {})).rejects.toThrow('Course title is required.');
        expect(sb.queries).toEqual([]);
        expect(broadcasts()).toEqual([]);
    });

    it('creates a gated cohort draft by default, makes the creator the first instructor, broadcasts the id only', async () => {
        on('academy_courses', { kind: 'insert' }, { data: courseRow({ id: 'c9', title: 'Gunnery' }) });
        const out = await createCourse(10, {
            title: '  Gunnery  ', description: '  basics  ', icon: '  fa-gun ',
            imageUrl: 'https://cdn.example.com/a.png',
        });
        const [ins] = queriesOn('academy_courses', 'insert');
        expect(payloadOf(ins)).toEqual({
            title: 'Gunnery', description: 'basics', icon: 'fa-gun', image_url: 'https://cdn.example.com/a.png',
            status: 'draft', access: 'gated', delivery: 'cohort', created_by: 10,
        });
        expect(colsOf(ins)).toBe(COURSE_COLS);
        expect(ins.terminal).toBe('single');
        expect(writesOn('academy_course_instructors', 'insert')).toEqual([{ course_id: 'c9', user_id: 10, assigned_by: 10 }]);
        expect(broadcasts()).toEqual([{ courseId: 'c9' }]);
        expect(out).toMatchObject({ id: 'c9', title: 'Gunnery', status: 'draft', instructors: [], modules: [], outcomes: [] });
        assertNoWildcardSelects();
    });

    it('a self-paced course is open-access; unsafe image urls and blank optional text are nulled', async () => {
        on('academy_courses', { kind: 'insert' }, { data: courseRow({ delivery: 'self_paced', access: 'open' }) });
        await createCourse(10, { title: 'SP', description: '   ', icon: '', imageUrl: 'javascript:alert(1)', delivery: 'self_paced' });
        expect(payloadOf(queriesOn('academy_courses', 'insert')[0])).toMatchObject({
            description: null, icon: null, image_url: null, access: 'open', delivery: 'self_paced',
        });
    });

    it('an unknown delivery value falls back to cohort (never trusts the client enum)', async () => {
        on('academy_courses', { kind: 'insert' }, { data: courseRow() });
        await createCourse(10, { title: 'X', delivery: 'bogus' as never });
        expect(payloadOf(queriesOn('academy_courses', 'insert')[0])).toMatchObject({ delivery: 'cohort', access: 'gated' });
    });

    it('an insert error surfaces the generic message and writes no instructor row / broadcast', async () => {
        on('academy_courses', { kind: 'insert' }, { error: { code: '23502', message: 'null value in column' } });
        await expect(createCourse(10, { title: 'X' })).rejects.toThrow('Failed to create course');
        expect(writesOn('academy_course_instructors', 'insert')).toEqual([]);
        expect(broadcasts()).toEqual([]);
    });

    it('an insert that returns no row is a failure, not a silent success', async () => {
        on('academy_courses', { kind: 'insert' }, { data: null });
        await expect(createCourse(10, { title: 'X' })).rejects.toThrow('Failed to create course');
        expect(writesOn('academy_course_instructors', 'insert')).toEqual([]);
    });
});

describe('course edit gate (assertCanEditCourse / loadCourse)', () => {
    it('an unknown course is an opaque SecurityDenial, even for a manager', async () => {
        await expect(updateCourse('nope', 10, true, { title: 'x' })).rejects.toBeInstanceOf(SecurityDenial);
        await expect(updateCourse('nope', 10, true, { title: 'x' })).rejects.toThrow('This course is not available.');
        const [guard] = queriesOn('academy_courses', 'select');
        expect(colsOf(guard)).toBe(COURSE_GUARD_COLS);
        expect(eqsOf(guard)).toEqual({ id: 'nope' });
        expect(guard.terminal).toBe('maybeSingle');
        expect(courseUpdates()).toEqual([]);
    });

    it('a course read fault (non-42P01) throws the load message rather than reading as "missing"', async () => {
        on('academy_courses', { kind: 'select', cols: COURSE_GUARD_COLS }, { error: { code: '57014', message: 'timeout' } });
        await expect(updateCourse('c1', 10, true, {})).rejects.toThrow('Failed to load course');
    });

    it('a missing table (42P01) is treated as "not available" — fail closed, opaque', async () => {
        on('academy_courses', { kind: 'select', cols: COURSE_GUARD_COLS }, { error: { code: '42P01', message: 'relation missing' } });
        await expect(updateCourse('c1', 10, true, {})).rejects.toThrow('This course is not available.');
    });

    it('a non-manager who is not an assigned instructor is denied and nothing is written', async () => {
        seedCourse();
        const err = await updateCourse('c1', 55, false, { title: 'Hijack' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('You are not an instructor of this course.');
        expect((err as SecurityDenial).auditEvent).toBe('authz.permission_denied');
        const [instrQ] = queriesOn('academy_course_instructors', 'select');
        expect(colsOf(instrQ)).toBe('id');
        expect(eqsOf(instrQ)).toEqual({ course_id: 'c1', user_id: 55 });
        expect(courseUpdates()).toEqual([]);
        expect(broadcasts()).toEqual([]);
    });

    it('an assigned instructor (non-manager) may edit', async () => {
        seedCourse();
        seedCourseInstructor('c1', 55);
        on('academy_courses', { kind: 'update' }, { data: courseRow({ title: 'New' }) });
        const out = await updateCourse('c1', 55, false, { title: ' New ' });
        expect(out.title).toBe('New');
        expect(courseUpdates()[0]).toMatchObject({ title: 'New' });
    });

    it('a manager skips the instructor lookup entirely', async () => {
        seedCourse();
        on('academy_courses', { kind: 'update' }, { data: courseRow() });
        await updateCourse('c1', 1, true, {});
        expect(queriesOn('academy_course_instructors')).toEqual([]);
    });
});

describe('updateCourse', () => {
    it('builds a patch of exactly the supplied fields, scoped to the course id', async () => {
        seedCourse();
        on('academy_courses', { kind: 'update' }, { data: courseRow({ sort_order: 3 }) });
        await updateCourse('c1', 1, true, { description: '  d  ', icon: '  ', imageUrl: 'http://insecure.example/a.png', sortOrder: 3 });
        const [upd] = queriesOn('academy_courses', 'update');
        const patch = payloadOf(upd) as Record<string, unknown>;
        expect(patch).toEqual({ updated_at: expect.stringMatching(ISO_RE), description: 'd', icon: null, image_url: null, sort_order: 3 });
        expect(eqsOf(upd)).toEqual({ id: 'c1' });
        expect(colsOf(upd)).toBe(COURSE_COLS);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('null description/icon clear the field', async () => {
        seedCourse();
        on('academy_courses', { kind: 'update' }, { data: courseRow() });
        await updateCourse('c1', 1, true, { description: null, icon: null });
        expect(courseUpdates()[0]).toMatchObject({ description: null, icon: null });
    });

    it('a blank title is refused', async () => {
        seedCourse();
        await expect(updateCourse('c1', 1, true, { title: '  ' })).rejects.toThrow('Course title is required.');
        expect(courseUpdates()).toEqual([]);
    });

    it('delivery may change while draft and re-derives access', async () => {
        seedCourse({ status: 'draft' });
        on('academy_courses', { kind: 'update' }, { data: courseRow() });
        await updateCourse('c1', 1, true, { delivery: 'self_paced' });
        expect(courseUpdates()[0]).toMatchObject({ delivery: 'self_paced', access: 'open' });
    });

    it('delivery set to cohort re-gates access', async () => {
        seedCourse({ status: 'draft', delivery: 'self_paced', access: 'open' });
        on('academy_courses', { kind: 'update' }, { data: courseRow() });
        await updateCourse('c1', 1, true, { delivery: 'cohort' });
        expect(courseUpdates()[0]).toMatchObject({ delivery: 'cohort', access: 'gated' });
    });

    it('delivery is structural: refused once the course is no longer a draft', async () => {
        seedCourse({ status: 'published' });
        await expect(updateCourse('c1', 1, true, { delivery: 'self_paced' }))
            .rejects.toThrow('Delivery mode can only be changed while the course is a draft.');
        expect(courseUpdates()).toEqual([]);
    });

    it('an update error surfaces the generic message and does not broadcast', async () => {
        seedCourse();
        on('academy_courses', { kind: 'update' }, { error: { code: 'XX', message: 'boom' } });
        await expect(updateCourse('c1', 1, true, { sortOrder: 1 })).rejects.toThrow('Failed to update course');
        expect(broadcasts()).toEqual([]);
    });

    it('an update that returns no row is a failure', async () => {
        seedCourse();
        on('academy_courses', { kind: 'update' }, { data: null });
        await expect(updateCourse('c1', 1, true, {})).rejects.toThrow('Failed to update course');
        expect(broadcasts()).toEqual([]);
    });
});

describe('deleteCourse', () => {
    it.each(['draft', 'archived'])('deletes a %s course, scoped by id', async (status) => {
        seedCourse({ status });
        await deleteCourse('c1', 1, true);
        const [del] = queriesOn('academy_courses', 'delete');
        expect(eqsOf(del)).toEqual({ id: 'c1' });
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it.each(['published', 'pending_approval'])('refuses to delete a %s course (never mid-run)', async (status) => {
        seedCourse({ status });
        await expect(deleteCourse('c1', 1, true)).rejects.toThrow('Only draft or archived courses can be deleted.');
        expect(queriesOn('academy_courses', 'delete')).toEqual([]);
    });

    it('a non-instructor cannot delete', async () => {
        seedCourse({ status: 'draft' });
        await expect(deleteCourse('c1', 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('academy_courses', 'delete')).toEqual([]);
    });

    it('a delete error surfaces the generic message', async () => {
        seedCourse({ status: 'draft' });
        on('academy_courses', { kind: 'delete' }, { error: { code: '23503', message: 'fk' } });
        await expect(deleteCourse('c1', 1, true)).rejects.toThrow('Failed to delete course');
        expect(broadcasts()).toEqual([]);
    });
});

describe('setCourseCertification (cert-award privilege gate)', () => {
    it('an unknown course is denied before the privilege check', async () => {
        await expect(setCourseCertification('nope', 9, 1, true)).rejects.toThrow('This course is not available.');
    });

    it('without canAward it is an escalation denial and nothing is written', async () => {
        seedCourse();
        const err = await setCourseCertification('c1', 9, 1, false).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).auditEvent).toBe('authz.escalation.denied');
        expect(queriesOn('certifications')).toEqual([]);
        expect(courseUpdates()).toEqual([]);
    });

    it('a certification id that does not exist is refused as an invalid target', async () => {
        seedCourse();
        const err = await setCourseCertification('c1', 404, 1, true).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('That certification does not exist.');
        const [certQ] = queriesOn('certifications');
        expect(colsOf(certQ)).toBe('id');
        expect(eqsOf(certQ)).toEqual({ id: 404 });
        expect(courseUpdates()).toEqual([]);
    });

    it('links an existing certification', async () => {
        seedCourse();
        on('certifications', { kind: 'select', cols: 'id' }, { data: { id: 9 } });
        await setCourseCertification('c1', 9, 1, true);
        const [upd] = queriesOn('academy_courses', 'update');
        expect(payloadOf(upd)).toEqual({ certification_id: 9, updated_at: expect.stringMatching(ISO_RE) });
        expect(eqsOf(upd)).toEqual({ id: 'c1' });
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('unlinking (null) skips the existence lookup', async () => {
        seedCourse();
        await setCourseCertification('c1', null, 1, true);
        expect(queriesOn('certifications')).toEqual([]);
        expect(courseUpdates()[0]).toMatchObject({ certification_id: null });
    });

    it('an update error surfaces the generic message', async () => {
        seedCourse();
        on('academy_courses', { kind: 'update' }, { error: { code: 'X' } });
        await expect(setCourseCertification('c1', null, 1, true)).rejects.toThrow('Failed to set course certification');
        expect(broadcasts()).toEqual([]);
    });
});

describe('submitCourseForApproval', () => {
    it('moves a draft to pending_approval', async () => {
        seedCourse({ status: 'draft' });
        seedCourseInstructor('c1', 55);
        await submitCourseForApproval('c1', 55, false);
        expect(courseUpdates()).toEqual([{ status: 'pending_approval', updated_at: expect.stringMatching(ISO_RE) }]);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('refuses a non-draft course', async () => {
        seedCourse({ status: 'published' });
        await expect(submitCourseForApproval('c1', 1, true)).rejects.toThrow('Only draft courses can be submitted for approval.');
        expect(courseUpdates()).toEqual([]);
    });

    it('a non-instructor cannot submit', async () => {
        seedCourse({ status: 'draft' });
        await expect(submitCourseForApproval('c1', 99, false)).rejects.toBeInstanceOf(SecurityDenial);
    });

    it('an update error surfaces the generic message', async () => {
        seedCourse({ status: 'draft' });
        on('academy_courses', { kind: 'update' }, { error: { code: 'X' } });
        await expect(submitCourseForApproval('c1', 1, true)).rejects.toThrow('Failed to submit course');
    });
});

// Seeds the instructor-notification fan-out: course instructor rows + the users read
// that drops client-tier / soft-deleted accounts.
function seedInstructorFanout(instructorIds: number[], members: Array<{ id: number; role_id: number }>): void {
    on('academy_course_instructors', { kind: 'select', cols: 'user_id' }, { data: instructorIds.map(user_id => ({ user_id })) });
    on('users', { kind: 'select', cols: 'id, role_id' }, { data: members });
}

describe('approveCourse', () => {
    it('refuses a course that is not pending approval', async () => {
        seedCourse({ status: 'draft' });
        await expect(approveCourse('c1', 1)).rejects.toThrow('Only courses pending approval can be approved.');
        expect(courseUpdates()).toEqual([]);
        expect(writesOn('academy_course_reviews', 'insert')).toEqual([]);
    });

    it('publishes, records the trail with a sanitised note, notifies non-client instructors except the approver', async () => {
        seedCourse({ status: 'pending_approval', created_by: 10, title: 'Intro to SAR' });
        // 10 = author (also an instructor row), 11 = instructor, 12 = demoted-to-Client instructor,
        // 1 = the approving manager (who is also an instructor and must not self-notify).
        seedInstructorFanout([10, 11, 12, 1], [
            { id: 1, role_id: 3 }, { id: 10, role_id: 3 }, { id: 11, role_id: 3 }, { id: 12, role_id: CLIENT_ROLE_ID },
        ]);
        await approveCourse('c1', 1, '<b>Nice</b> work');

        const [upd] = queriesOn('academy_courses', 'update');
        expect(payloadOf(upd)).toEqual({
            status: 'published', approved_by: 1, published_at: expect.stringMatching(ISO_RE), updated_at: expect.stringMatching(ISO_RE),
        });
        expect(eqsOf(upd)).toEqual({ id: 'c1' });
        expect(writesOn('academy_course_reviews', 'insert')).toEqual([
            { course_id: 'c1', decision: 'approved', note: 'Nice work', reviewed_by: 1 },
        ]);
        // Cohort course: no implicit session is created.
        expect(queriesOn('academy_sessions')).toEqual([]);

        // The instructor read is ordered + capped (list-read ratchet) and the member read
        // filters soft-deleted accounts.
        const [instrQ] = queriesOn('academy_course_instructors', 'select');
        expect(eqsOf(instrQ)).toEqual({ course_id: 'c1' });
        expect(argOf(instrQ, 'order')).toEqual(['id', { ascending: true }]);
        expect(argOf(instrQ, 'limit')).toEqual([50]);
        const [memberQ] = queriesOn('users', 'select');
        expect(argOf(memberQ, 'in')).toEqual(['id', [10, 11, 12, 1]]);
        expect(argOf(memberQ, 'is')).toEqual(['deleted_at', null]);
        expect(argOf(memberQ, 'limit')).toEqual([4]);

        expect(notifications().map(n => n.uid).sort()).toEqual([10, 11]);
        expect(notifications()[0]).toMatchObject({
            type: 'academy_course_approved', title: 'Course approved',
            body: 'Intro to SAR has been approved and published.', link: 'academy', metadata: { courseId: 'c1' },
        });
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
        assertNoWildcardSelects();
    });

    it('an empty note is stored as null', async () => {
        seedCourse({ status: 'pending_approval' });
        await approveCourse('c1', 1);
        expect(writesOn('academy_course_reviews', 'insert')).toEqual([{ course_id: 'c1', decision: 'approved', note: null, reviewed_by: 1 }]);
    });

    it('a self-paced course grows its implicit enrolment session on publish', async () => {
        seedCourse({ status: 'pending_approval', delivery: 'self_paced' });
        await approveCourse('c1', 1);
        const [probe] = queriesOn('academy_sessions', 'select');
        expect(colsOf(probe)).toBe('id');
        expect(eqsOf(probe)).toEqual({ course_id: 'c1', is_implicit: true });
        expect(writesOn('academy_sessions', 'insert')).toEqual([{
            course_id: 'c1', title: 'Self-paced', status: 'in_progress', enrollment_open: true, capacity: null, is_implicit: true, created_by: 1,
        }]);
    });

    it('the implicit session is idempotent — not re-created when one exists', async () => {
        seedCourse({ status: 'pending_approval', delivery: 'self_paced' });
        on('academy_sessions', { kind: 'select', cols: 'id' }, { data: { id: 'sImplicit' } });
        await approveCourse('c1', 1);
        expect(writesOn('academy_sessions', 'insert')).toEqual([]);
    });

    it('an implicit-session insert error surfaces its message', async () => {
        seedCourse({ status: 'pending_approval', delivery: 'self_paced' });
        on('academy_sessions', { kind: 'insert' }, { error: { code: 'X' } });
        await expect(approveCourse('c1', 1)).rejects.toThrow('Failed to create self-paced session');
    });

    it('a publish error surfaces the generic message and records no trail', async () => {
        seedCourse({ status: 'pending_approval' });
        on('academy_courses', { kind: 'update' }, { error: { code: 'X' } });
        await expect(approveCourse('c1', 1)).rejects.toThrow('Failed to approve course');
        expect(writesOn('academy_course_reviews', 'insert')).toEqual([]);
    });

    it.each(['42P01', 'PGRST205'])('a missing review table (%s) is an operator-actionable refusal, not a swallow', async (code) => {
        seedCourse({ status: 'pending_approval' });
        on('academy_course_reviews', { kind: 'insert' }, { error: { code } });
        await expect(approveCourse('c1', 1)).rejects.toThrow(/schema is re-applied \(schema\.sql\)/);
        expect(notifications()).toEqual([]);
    });

    it('any other review-insert error surfaces the trail message', async () => {
        seedCourse({ status: 'pending_approval' });
        on('academy_course_reviews', { kind: 'insert' }, { error: { code: '23503' } });
        await expect(approveCourse('c1', 1)).rejects.toThrow('Failed to record the review decision');
    });

    it('an instructor read fault notifies nobody (fail closed) but the approval stands', async () => {
        seedCourse({ status: 'pending_approval' });
        on('academy_course_instructors', { kind: 'select' }, { error: { code: 'X' } });
        await approveCourse('c1', 1);
        expect(notifications()).toEqual([]);
        expect(queriesOn('users')).toEqual([]);
        expect(courseUpdates()).toHaveLength(1);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('an unresolvable client tier notifies nobody, never "notify anyway"', async () => {
        seedCourse({ status: 'pending_approval' });
        seedInstructorFanout([11], [{ id: 11, role_id: 3 }]);
        requireClientRoleId.mockRejectedValueOnce(new Error('Role configuration unavailable'));
        await approveCourse('c1', 1);
        expect(notifications()).toEqual([]);
        expect(queriesOn('users')).toEqual([]);
    });

    it('a member-tier read fault notifies nobody', async () => {
        seedCourse({ status: 'pending_approval' });
        on('academy_course_instructors', { kind: 'select', cols: 'user_id' }, { data: [{ user_id: 11 }] });
        on('users', { kind: 'select', cols: 'id, role_id' }, { error: { code: 'X' } });
        await approveCourse('c1', 1);
        expect(notifications()).toEqual([]);
    });

    it('an author id that is not a positive number yields no recipients (no tier lookup)', async () => {
        seedCourse({ status: 'pending_approval', created_by: 0 });
        await approveCourse('c1', 1);
        expect(requireClientRoleId).not.toHaveBeenCalled();
        expect(notifications()).toEqual([]);
    });

    it('a notification failure is best-effort and never blocks the approval', async () => {
        seedCourse({ status: 'pending_approval', created_by: 10 });
        seedInstructorFanout([], [{ id: 10, role_id: 3 }]);
        createNotification.mockRejectedValue(new Error('push down'));
        await expect(approveCourse('c1', 1)).resolves.toBeUndefined();
        expect(createNotification).toHaveBeenCalledTimes(1);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });
});

describe('rejectCourse', () => {
    it('refuses a course that is not pending (no silent unpublish)', async () => {
        seedCourse({ status: 'published' });
        await expect(rejectCourse('c1', 1, 'bad')).rejects.toThrow('Only courses pending approval can be returned for revision.');
        expect(courseUpdates()).toEqual([]);
    });

    it.each([undefined, '', '   ', '<i></i>', 42])('a reason is mandatory (%s)', async (note) => {
        seedCourse({ status: 'pending_approval' });
        await expect(rejectCourse('c1', 1, note)).rejects.toThrow('A reason is required when returning a course for revision.');
        expect(writesOn('academy_course_reviews', 'insert')).toEqual([]);
        expect(courseUpdates()).toEqual([]);
    });

    it('records the trail FIRST, then returns to draft and notifies with a generic body (note never in the push)', async () => {
        seedCourse({ status: 'pending_approval', created_by: 10, title: 'Intro to SAR' });
        seedInstructorFanout([11], [{ id: 10, role_id: 3 }, { id: 11, role_id: 3 }]);
        await rejectCourse('c1', 1, '<script>x</script>Fix module 2');
        const reviewIdx = sb.queries.findIndex(q => q.table === 'academy_course_reviews');
        const updIdx = sb.queries.findIndex(q => q.table === 'academy_courses' && argOf(q, 'update'));
        expect(reviewIdx).toBeGreaterThan(-1);
        expect(reviewIdx).toBeLessThan(updIdx);
        expect(writesOn('academy_course_reviews', 'insert')).toEqual([
            { course_id: 'c1', decision: 'rejected', note: 'xFix module 2', reviewed_by: 1 },
        ]);
        expect(courseUpdates()).toEqual([{ status: 'draft', updated_at: expect.stringMatching(ISO_RE) }]);
        expect(notifications().map(n => n.uid).sort()).toEqual([10, 11]);
        for (const n of notifications()) {
            expect(n).toMatchObject({
                type: 'academy_course_rejected', title: 'Course returned for revision',
                body: 'Intro to SAR was returned to draft with reviewer feedback.', metadata: { courseId: 'c1' },
            });
            expect(JSON.stringify(n)).not.toContain('Fix module 2');
        }
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('caps the reason at 2000 characters', async () => {
        seedCourse({ status: 'pending_approval' });
        await rejectCourse('c1', 1, 'a'.repeat(2500));
        const [row] = writesOn('academy_course_reviews', 'insert') as Array<{ note: string }>;
        expect(row.note).toHaveLength(2000);
    });

    it('if the trail cannot be written the course does NOT move', async () => {
        seedCourse({ status: 'pending_approval' });
        on('academy_course_reviews', { kind: 'insert' }, { error: { code: '42P01' } });
        await expect(rejectCourse('c1', 1, 'why')).rejects.toThrow(/schema\.sql/);
        expect(courseUpdates()).toEqual([]);
        expect(notifications()).toEqual([]);
    });

    it('a status-update error surfaces the generic message', async () => {
        seedCourse({ status: 'pending_approval' });
        on('academy_courses', { kind: 'update' }, { error: { code: 'X' } });
        await expect(rejectCourse('c1', 1, 'why')).rejects.toThrow('Failed to reject course');
        expect(notifications()).toEqual([]);
    });
});

describe('listCourseReviews', () => {
    it('reads the trail newest-first with an id tiebreak, capped, and maps decisions', async () => {
        on('academy_course_reviews', { kind: 'select' }, { data: [
            { id: 2, decision: 'approved', note: null, reviewed_by: 1, created_at: 't2' },
            { id: 1, decision: 'rejected', note: 'fix', reviewed_by: 3, created_at: 't1' },
            { id: 0, decision: 'weird', note: 'n', reviewed_by: 4, created_at: 't0' },
        ] });
        const out = await listCourseReviews('c1');
        expect(out).toEqual([
            { id: 2, decision: 'approved', note: null, reviewedBy: 1, createdAt: 't2' },
            { id: 1, decision: 'rejected', note: 'fix', reviewedBy: 3, createdAt: 't1' },
            // An unknown stored decision never maps to 'approved'.
            { id: 0, decision: 'rejected', note: 'n', reviewedBy: 4, createdAt: 't0' },
        ]);
        const [q] = queriesOn('academy_course_reviews');
        expect(colsOf(q)).toBe('id, decision, note, reviewed_by, created_at');
        expect(eqsOf(q)).toEqual({ course_id: 'c1' });
        expect(argsOf(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(argOf(q, 'limit')).toEqual([50]);
    });

    it.each(['42P01', 'PGRST205'])('a missing table (%s) reads as an empty trail', async (code) => {
        on('academy_course_reviews', { kind: 'select' }, { error: { code } });
        await expect(listCourseReviews('c1')).resolves.toEqual([]);
    });

    it('any other read error throws', async () => {
        on('academy_course_reviews', { kind: 'select' }, { error: { code: '57014' } });
        await expect(listCourseReviews('c1')).rejects.toThrow('Failed to load course reviews');
    });

    it('a null data payload reads as empty', async () => {
        await expect(listCourseReviews('c1')).resolves.toEqual([]);
    });
});

describe('setCourseArchived', () => {
    it('archives', async () => {
        seedCourse({ status: 'published' });
        await setCourseArchived('c1', true);
        expect(courseUpdates()).toEqual([{ status: 'archived', updated_at: expect.stringMatching(ISO_RE) }]);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('un-archiving an archived course returns it to draft (never straight back to published)', async () => {
        seedCourse({ status: 'archived' });
        await setCourseArchived('c1', false);
        expect(courseUpdates()[0]).toMatchObject({ status: 'draft' });
    });

    it('un-archiving a non-archived course leaves its status as-is', async () => {
        seedCourse({ status: 'published' });
        await setCourseArchived('c1', false);
        expect(courseUpdates()[0]).toMatchObject({ status: 'published' });
    });

    it('an unknown course is denied', async () => {
        await expect(setCourseArchived('nope', true)).rejects.toBeInstanceOf(SecurityDenial);
        expect(courseUpdates()).toEqual([]);
    });

    it('an update error surfaces the generic message', async () => {
        seedCourse();
        on('academy_courses', { kind: 'update' }, { error: { code: 'X' } });
        await expect(setCourseArchived('c1', true)).rejects.toThrow('Failed to archive course');
    });
});

describe('setCourseAccess', () => {
    it('rejects an invalid access value before any read', async () => {
        await expect(setCourseAccess('c1', 'public' as never)).rejects.toThrow('Invalid access value.');
        expect(sb.queries).toEqual([]);
    });

    it.each(['open', 'gated'] as const)('sets access to %s', async (access) => {
        seedCourse();
        await setCourseAccess('c1', access);
        expect(courseUpdates()).toEqual([{ access, updated_at: expect.stringMatching(ISO_RE) }]);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('an unknown course is denied', async () => {
        await expect(setCourseAccess('nope', 'open')).rejects.toBeInstanceOf(SecurityDenial);
    });

    it('an update error surfaces the generic message', async () => {
        seedCourse();
        on('academy_courses', { kind: 'update' }, { error: { code: 'X' } });
        await expect(setCourseAccess('c1', 'open')).rejects.toThrow('Failed to set course access');
    });
});

describe('addCourseInstructor', () => {
    it('refuses a target that is not a live member', async () => {
        seedCourse();
        const err = await addCourseInstructor('c1', 77, 1, true).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Instructor is not a valid member.');
        const [uq] = queriesOn('users');
        expect(colsOf(uq)).toBe('id');
        expect(eqsOf(uq)).toEqual({ id: 77 });
        expect(argOf(uq, 'is')).toEqual(['deleted_at', null]);
        expect(writesOn('academy_course_instructors', 'insert')).toEqual([]);
    });

    it('inserts the assignment with the actor as assigner', async () => {
        seedCourse();
        on('users', { kind: 'select', cols: 'id' }, { data: { id: 77 } });
        await addCourseInstructor('c1', 77, 1, true);
        expect(writesOn('academy_course_instructors', 'insert')).toEqual([{ course_id: 'c1', user_id: 77, assigned_by: 1 }]);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('a duplicate (23505) is idempotent', async () => {
        seedCourse();
        on('users', { kind: 'select', cols: 'id' }, { data: { id: 77 } });
        on('academy_course_instructors', { kind: 'insert' }, { error: { code: '23505' } });
        await expect(addCourseInstructor('c1', 77, 1, true)).resolves.toBeUndefined();
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('any other insert error throws', async () => {
        seedCourse();
        on('users', { kind: 'select', cols: 'id' }, { data: { id: 77 } });
        on('academy_course_instructors', { kind: 'insert' }, { error: { code: '23503' } });
        await expect(addCourseInstructor('c1', 77, 1, true)).rejects.toThrow('Failed to add instructor');
    });

    it('a non-instructor actor is denied before the target lookup', async () => {
        seedCourse();
        await expect(addCourseInstructor('c1', 77, 99, false)).rejects.toThrow('You are not an instructor of this course.');
        expect(queriesOn('users')).toEqual([]);
    });
});

describe('addCourseInstructors (batch)', () => {
    it('an empty / non-numeric id list is a no-op returning 0', async () => {
        seedCourse();
        await expect(addCourseInstructors('c1', ['x' as never, null as never], 1, true)).resolves.toBe(0);
        expect(queriesOn('users')).toEqual([]);
        expect(broadcasts()).toEqual([]);
    });

    it('dedupes, caps at 100, validates every id in ONE query, and refuses the batch on any invalid id', async () => {
        seedCourse();
        const ids = Array.from({ length: 150 }, (_, i) => i + 1);
        on('users', { kind: 'select', cols: 'id' }, { data: ids.slice(0, 99).map(id => ({ id })) });
        const err = await addCourseInstructors('c1', [...ids, 1, 2], 1, true).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).fields).toEqual({ userId: 100 });
        const [uq] = queriesOn('users');
        expect((argOf(uq, 'in')![1] as number[])).toHaveLength(100);
        expect(argOf(uq, 'is')).toEqual(['deleted_at', null]);
        expect(writesOn('academy_course_instructors', 'insert')).toEqual([]);
    });

    it('inserts only the ids not already assigned and returns that count', async () => {
        seedCourse();
        on('users', { kind: 'select', cols: 'id' }, { data: [{ id: 5 }, { id: 6 }, { id: 7 }] });
        on('academy_course_instructors', { kind: 'select', cols: 'user_id' }, { data: [{ user_id: 6 }] });
        await expect(addCourseInstructors('c1', [5, 6, 7, 5], 1, true)).resolves.toBe(2);
        const [existingQ] = queriesOn('academy_course_instructors', 'select');
        expect(eqsOf(existingQ)).toEqual({ course_id: 'c1' });
        expect(argOf(existingQ, 'in')).toEqual(['user_id', [5, 6, 7]]);
        expect(writesOn('academy_course_instructors', 'insert')).toEqual([[
            { course_id: 'c1', user_id: 5, assigned_by: 1 },
            { course_id: 'c1', user_id: 7, assigned_by: 1 },
        ]]);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('when everyone is already assigned it inserts nothing and returns 0', async () => {
        seedCourse();
        on('users', { kind: 'select', cols: 'id' }, { data: [{ id: 5 }] });
        on('academy_course_instructors', { kind: 'select', cols: 'user_id' }, { data: [{ user_id: 5 }] });
        await expect(addCourseInstructors('c1', [5], 1, true)).resolves.toBe(0);
        expect(writesOn('academy_course_instructors', 'insert')).toEqual([]);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('a 23505 race on insert is tolerated; any other error throws', async () => {
        seedCourse();
        on('users', { kind: 'select', cols: 'id' }, { data: [{ id: 5 }] });
        once('academy_course_instructors', { kind: 'insert' }, { error: { code: '23505' } });
        await expect(addCourseInstructors('c1', [5], 1, true)).resolves.toBe(1);
        on('academy_course_instructors', { kind: 'insert' }, { error: { code: 'XX' } });
        await expect(addCourseInstructors('c1', [5], 1, true)).rejects.toThrow('Failed to add instructors');
    });

    it('a null member result makes every id invalid (fail closed)', async () => {
        seedCourse();
        await expect(addCourseInstructors('c1', [5], 1, true)).rejects.toThrow('Instructor is not a valid member.');
    });
});

describe('removeCourseInstructor', () => {
    it('deletes the pairing scoped to course + user', async () => {
        seedCourse();
        await removeCourseInstructor('c1', 77, 1, true);
        const [del] = queriesOn('academy_course_instructors', 'delete');
        expect(eqsOf(del)).toEqual({ course_id: 'c1', user_id: 77 });
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('a non-instructor is denied', async () => {
        seedCourse();
        await expect(removeCourseInstructor('c1', 77, 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('academy_course_instructors', 'delete')).toEqual([]);
    });

    it('a delete error surfaces the generic message', async () => {
        seedCourse();
        on('academy_course_instructors', { kind: 'delete' }, { error: { code: 'X' } });
        await expect(removeCourseInstructor('c1', 77, 1, true)).rejects.toThrow('Failed to remove instructor');
    });
});
