import { describe, it, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// lib/db/academy.ts — SESSIONS + ENROLMENT (seat claiming, assignment, withdrawal)
// =============================================================================
// Pins the cohort half: the session-run gate (manager OR session instructor OR course
// instructor), the session status machine, seat claiming through the atomic
// academy_claim_seat() function (fail CLOSED when it is absent — never fall back to the
// racy count-then-insert), the instructor batch-assign path with its all-or-nothing
// client-tier refusal, and the bulk withdraw / recommend helpers that are session-scoped
// so a spoofed id from another session is a silent no-op.
vi.mock('../lib/db/common.js', async () => {
    const hh = await import('./cov-db-academy-harness');
    return { supabase: hh.supabaseStub, handleSupabaseError: hh.handleSupabaseError, broadcastToOrg: hh.broadcastToOrg };
});
vi.mock('../lib/db/system.js', async () => ({ awardCertification: (await import('./cov-db-academy-harness')).awardCertification }));
vi.mock('../lib/db/notifications.js', async () => ({ createNotification: (await import('./cov-db-academy-harness')).createNotification }));
vi.mock('../lib/db/clientRoleLock.js', async () => ({ requireClientRoleId: (await import('./cov-db-academy-harness')).requireClientRoleId }));
vi.mock('../lib/log.js', async () => ({ log: (await import('./cov-db-academy-harness')).logSpy }));

import {
    sb, on, once, resetHarness, queriesOn, writesOn, broadcasts, notifications, rpcReturns, assertNoWildcardSelects,
    argOf, colsOf, eqsOf, payloadOf, requireClientRoleId, createNotification, CLIENT_ROLE_ID,
    seedCourse, seedSession, seedEnrollment, seedCourseInstructor, seedSessionInstructor, sessionRow,
    SESSION_COLS, SESSION_GUARD_COLS, ENROLLMENT_GUARD_COLS, type Q,
} from './cov-db-academy-harness';
import {
    createSession, updateSession, setSessionStatus, addSessionInstructor, removeSessionInstructor,
    withdrawEnrollmentsBulk, recommendEnrollmentsBulk, selfEnroll, assignStudents, withdrawEnrollment,
} from '../lib/db/academy';
import { SecurityDenial } from '../lib/errors';

beforeEach(() => resetHarness());

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** academyCourseContext(sessionId) resolves to this course id + title. */
function seedCourseContext(sessionId = 's1', courseId = 'c1', title = 'Intro to SAR'): void {
    on('academy_sessions', { kind: 'select', cols: 'course_id', eq: { id: sessionId } }, { data: { course_id: courseId } });
    on('academy_courses', { kind: 'select', cols: 'title', eq: { id: courseId } }, { data: { title } });
}
/** usersWithPermission('academy:manage') resolves to these user ids. */
function seedManagers(ids: number[]): void {
    on('permissions', { kind: 'select', cols: 'id', eq: { name: 'academy:manage' } }, { data: [{ id: 900 }] });
    on('role_permissions', { kind: 'select', cols: 'role_id' }, { data: [{ role_id: 3 }, { role_id: 3 }, { role_id: 4 }] });
    on('users', { kind: 'select', cols: 'id', where: (q: Q) => argOf(q, 'in')?.[0] === 'role_id' }, { data: ids.map(id => ({ id })) });
}

// ════════════════════════════════════════════════════════════════════════════
describe('session-run gate (assertCanRunSession / loadSession)', () => {
    it('an unknown session is an opaque SecurityDenial', async () => {
        const err = await updateSession('nope', 1, true, {}).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('This session is not available.');
        const [g] = queriesOn('academy_sessions');
        expect(colsOf(g)).toBe(SESSION_GUARD_COLS);
        expect(eqsOf(g)).toEqual({ id: 'nope' });
        expect(writesOn('academy_sessions', 'update')).toEqual([]);
    });

    it('a session read fault throws rather than reading as "missing"; 42P01 is "not available"', async () => {
        on('academy_sessions', { kind: 'select', cols: SESSION_GUARD_COLS }, { error: { code: '57014' } });
        await expect(updateSession('s1', 1, true, {})).rejects.toThrow('Failed to load session');
        resetHarness();
        on('academy_sessions', { kind: 'select', cols: SESSION_GUARD_COLS }, { error: { code: '42P01' } });
        await expect(updateSession('s1', 1, true, {})).rejects.toThrow('This session is not available.');
    });

    it('denies a user who is neither session nor course instructor, checking both', async () => {
        seedSession();
        const err = await updateSession('s1', 99, false, { title: 'x' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('You are not an instructor of this session.');
        expect(eqsOf(queriesOn('academy_session_instructors')[0])).toEqual({ session_id: 's1', user_id: 99 });
        expect(eqsOf(queriesOn('academy_course_instructors')[0])).toEqual({ course_id: 'c1', user_id: 99 });
        expect(writesOn('academy_sessions', 'update')).toEqual([]);
    });

    it('a session instructor passes without the course-instructor lookup', async () => {
        seedSession(); seedSessionInstructor('s1', 55);
        await updateSession('s1', 55, false, {});
        expect(queriesOn('academy_course_instructors')).toEqual([]);
        expect(writesOn('academy_sessions', 'update')).toHaveLength(1);
    });

    it("the course's instructor passes", async () => {
        seedSession(); seedCourseInstructor('c1', 56);
        await updateSession('s1', 56, false, {});
        expect(writesOn('academy_sessions', 'update')).toHaveLength(1);
    });

    it('enrollment_open null reads as open (only an explicit false closes it)', async () => {
        seedSession({ enrollment_open: null });
        seedCourse({ status: 'published', access: 'open' });
        await selfEnroll('s1', 20);
        expect(sb.rpcCalls).toHaveLength(1);
    });
});

describe('createSession', () => {
    it('only a published course can run a session', async () => {
        seedCourse({ status: 'draft' });
        await expect(createSession('c1', 1, true, { title: 'S' })).rejects.toThrow('Only published courses can be run as a session.');
        expect(queriesOn('academy_sessions')).toEqual([]);
    });

    it('requires a title; a non-instructor is denied', async () => {
        seedCourse({ status: 'published' });
        await expect(createSession('c1', 1, true, { title: ' ' })).rejects.toThrow('Session title is required.');
        await expect(createSession('c1', 99, false, { title: 'S' })).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('academy_sessions')).toEqual([]);
    });

    it('inserts a scheduled session, normalising inputs, and seats the creator as session instructor', async () => {
        seedCourse({ status: 'published' });
        on('academy_sessions', { kind: 'insert' }, { data: sessionRow({ id: 's7', title: 'Cohort 7', capacity: 3 }) });
        const out = await createSession('c1', 1, true, {
            title: ' Cohort 7 ', startsAt: '2026-12-01T00:00:00Z', endsAt: '', location: '  Lorville ', capacity: 3.7, enrollmentOpen: false,
        });
        const [ins] = queriesOn('academy_sessions', 'insert');
        expect(payloadOf(ins)).toEqual({
            course_id: 'c1', title: 'Cohort 7', status: 'scheduled', starts_at: '2026-12-01T00:00:00Z', ends_at: null,
            location: 'Lorville', capacity: 3, enrollment_open: false, created_by: 1,
        });
        expect(colsOf(ins)).toBe(SESSION_COLS);
        expect(writesOn('academy_session_instructors', 'insert')).toEqual([{ session_id: 's7', user_id: 1, assigned_by: 1 }]);
        expect(broadcasts()).toEqual([{ sessionId: 's7' }]);
        expect(out).toMatchObject({ id: 's7', courseId: 'c1', title: 'Cohort 7', capacity: 3, courseTitle: null, enrollmentCount: 0, instructors: [] });
        assertNoWildcardSelects();
    });

    it.each([0, -4, null, undefined])('a capacity of %s means uncapped (null); enrolment defaults open', async (capacity) => {
        seedCourse({ status: 'published' });
        on('academy_sessions', { kind: 'insert' }, { data: sessionRow() });
        await createSession('c1', 1, true, { title: 'S', capacity });
        expect(payloadOf(queriesOn('academy_sessions', 'insert')[0])).toMatchObject({
            capacity: null, enrollment_open: true, starts_at: null, ends_at: null, location: null,
        });
    });

    it('an insert error / empty return fail with the generic message and seat nobody', async () => {
        seedCourse({ status: 'published' });
        once('academy_sessions', { kind: 'insert' }, { error: { code: 'X' } });
        await expect(createSession('c1', 1, true, { title: 'S' })).rejects.toThrow('Failed to create session');
        await expect(createSession('c1', 1, true, { title: 'S' })).rejects.toThrow('Failed to create session');
        expect(writesOn('academy_session_instructors', 'insert')).toEqual([]);
        expect(broadcasts()).toEqual([]);
    });
});

describe('updateSession', () => {
    it('patches exactly the supplied fields with an updated_at stamp, scoped by id', async () => {
        seedSession();
        await updateSession('s1', 1, true, {
            title: ' New ', startsAt: '', endsAt: '2026-12-31T00:00:00Z', location: null, capacity: 12.9, enrollmentOpen: 0 as unknown as boolean,
        });
        const [upd] = queriesOn('academy_sessions', 'update');
        expect(payloadOf(upd)).toEqual({
            updated_at: expect.stringMatching(ISO_RE), title: 'New', starts_at: null, ends_at: '2026-12-31T00:00:00Z',
            location: null, capacity: 12, enrollment_open: false,
        });
        expect(eqsOf(upd)).toEqual({ id: 's1' });
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
    });

    it('a non-positive capacity clears the cap; location is trimmed', async () => {
        seedSession();
        await updateSession('s1', 1, true, { capacity: 0, location: '  Area18 ' });
        expect(writesOn('academy_sessions', 'update')[0]).toMatchObject({ capacity: null, location: 'Area18' });
        await updateSession('s1', 1, true, { capacity: null, location: '' });
        expect(writesOn('academy_sessions', 'update')[1]).toMatchObject({ capacity: null, location: null });
    });

    it('refuses a blank title', async () => {
        seedSession();
        await expect(updateSession('s1', 1, true, { title: '' })).rejects.toThrow('Session title is required.');
        expect(writesOn('academy_sessions', 'update')).toEqual([]);
    });

    it('an update error surfaces the generic message', async () => {
        seedSession();
        on('academy_sessions', { kind: 'update' }, { error: { code: 'X' } });
        await expect(updateSession('s1', 1, true, {})).rejects.toThrow('Failed to update session');
        expect(broadcasts()).toEqual([]);
    });
});

describe('setSessionStatus (status machine)', () => {
    it.each([
        ['scheduled', 'in_progress'], ['scheduled', 'cancelled'], ['in_progress', 'completed'], ['in_progress', 'cancelled'],
    ] as const)('allows %s → %s', async (from, to) => {
        seedSession({ status: from });
        await setSessionStatus('s1', to, 1, true);
        expect(writesOn('academy_sessions', 'update')).toEqual([{ status: to, updated_at: expect.stringMatching(ISO_RE) }]);
        expect(eqsOf(queriesOn('academy_sessions', 'update')[0])).toEqual({ id: 's1' });
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
    });

    it.each([
        ['scheduled', 'completed'], ['in_progress', 'scheduled'], ['completed', 'in_progress'], ['cancelled', 'scheduled'], ['weird', 'in_progress'],
    ] as const)('refuses %s → %s', async (from, to) => {
        seedSession({ status: from });
        await expect(setSessionStatus('s1', to as never, 1, true)).rejects.toThrow(`Cannot move a ${from} session to ${to}.`);
        expect(writesOn('academy_sessions', 'update')).toEqual([]);
    });

    it('a non-instructor cannot move status; an update error surfaces', async () => {
        seedSession({ status: 'scheduled' });
        await expect(setSessionStatus('s1', 'in_progress', 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        on('academy_sessions', { kind: 'update' }, { error: { code: 'X' } });
        await expect(setSessionStatus('s1', 'in_progress', 1, true)).rejects.toThrow('Failed to update session status');
    });
});

describe('session instructors', () => {
    it('add: the target must be a live member', async () => {
        seedSession();
        await expect(addSessionInstructor('s1', 77, 1, true)).rejects.toThrow('Instructor is not a valid member.');
        expect(writesOn('academy_session_instructors', 'insert')).toEqual([]);
    });

    it('add: inserts with the actor as assigner; 23505 is idempotent; other errors throw', async () => {
        seedSession();
        on('users', { kind: 'select', cols: 'id' }, { data: { id: 77 } });
        await addSessionInstructor('s1', 77, 1, true);
        expect(writesOn('academy_session_instructors', 'insert')).toEqual([{ session_id: 's1', user_id: 77, assigned_by: 1 }]);
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
        once('academy_session_instructors', { kind: 'insert' }, { error: { code: '23505' } });
        await expect(addSessionInstructor('s1', 77, 1, true)).resolves.toBeUndefined();
        on('academy_session_instructors', { kind: 'insert' }, { error: { code: '23503' } });
        await expect(addSessionInstructor('s1', 77, 1, true)).rejects.toThrow('Failed to add session instructor');
    });

    it('add/remove: a non-instructor is denied', async () => {
        seedSession();
        await expect(addSessionInstructor('s1', 77, 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        await expect(removeSessionInstructor('s1', 77, 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('users')).toEqual([]);
        expect(queriesOn('academy_session_instructors', 'delete')).toEqual([]);
    });

    it('remove: deletes the pairing scoped to session + user; errors surface', async () => {
        seedSession();
        await removeSessionInstructor('s1', 77, 1, true);
        expect(eqsOf(queriesOn('academy_session_instructors', 'delete')[0])).toEqual({ session_id: 's1', user_id: 77 });
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
        on('academy_session_instructors', { kind: 'delete' }, { error: { code: 'X' } });
        await expect(removeSessionInstructor('s1', 77, 1, true)).rejects.toThrow('Failed to remove session instructor');
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('withdrawEnrollmentsBulk', () => {
    it('a non-instructor is denied', async () => {
        seedSession();
        await expect(withdrawEnrollmentsBulk('s1', ['e1'], 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('academy_enrollments')).toEqual([]);
    });

    it('an empty / junk id list is a no-op returning 0', async () => {
        seedSession();
        await expect(withdrawEnrollmentsBulk('s1', ['', 5 as unknown as string, null as unknown as string], 1, true)).resolves.toBe(0);
        expect(queriesOn('academy_enrollments')).toEqual([]);
        expect(broadcasts()).toEqual([]);
    });

    it('a session-scoped, deduped, capped update that skips already-withdrawn rows; returns rows touched', async () => {
        seedSession();
        on('academy_enrollments', { kind: 'update' }, { data: [{ id: 'e1' }, { id: 'e2' }] });
        const ids = [...Array.from({ length: 600 }, (_, i) => `e${i}`), 'e1'];
        await expect(withdrawEnrollmentsBulk('s1', ids, 1, true)).resolves.toBe(2);
        const [upd] = queriesOn('academy_enrollments', 'update');
        expect(payloadOf(upd)).toEqual({ status: 'withdrawn' });
        expect(eqsOf(upd)).toEqual({ session_id: 's1' });
        expect((argOf(upd, 'in')![1] as string[])).toHaveLength(500);
        expect(argOf(upd, 'neq')).toEqual(['status', 'withdrawn']);
        expect(colsOf(upd)).toBe('id');
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
    });

    it('a null return counts as 0; an error surfaces', async () => {
        seedSession();
        await expect(withdrawEnrollmentsBulk('s1', ['e1'], 1, true)).resolves.toBe(0);
        on('academy_enrollments', { kind: 'update' }, { error: { code: 'X' } });
        await expect(withdrawEnrollmentsBulk('s1', ['e1'], 1, true)).rejects.toThrow('Failed to withdraw enrolments');
    });
});

describe('recommendEnrollmentsBulk', () => {
    it('a non-instructor is denied; an empty list is { 0, 0 }', async () => {
        seedSession();
        await expect(recommendEnrollmentsBulk('s1', ['e1'], 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        await expect(recommendEnrollmentsBulk('s1', [], 1, true)).resolves.toEqual({ recommended: 0, skipped: 0 });
        expect(queriesOn('academy_enrollments')).toEqual([]);
    });

    it('only active enrolments IN THIS SESSION count; none active → all skipped, no write', async () => {
        seedSession();
        on('academy_enrollments', { kind: 'select', cols: 'id, status' }, { data: [{ id: 'e1', status: 'withdrawn' }, { id: 'e2', status: 'completed' }] });
        await expect(recommendEnrollmentsBulk('s1', ['e1', 'e2', 'eForeign'], 1, true)).resolves.toEqual({ recommended: 0, skipped: 3 });
        const [q] = queriesOn('academy_enrollments', 'select');
        expect(eqsOf(q)).toEqual({ session_id: 's1' });
        expect(argOf(q, 'in')).toEqual(['id', ['e1', 'e2', 'eForeign']]);
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
        expect(queriesOn('academy_outcomes')).toEqual([]);
    });

    it('with no required outcomes every active enrolment is recommended; managers get ONE batched notice', async () => {
        seedSession();
        seedCourseContext();
        seedManagers([1, 2]);
        on('academy_enrollments', { kind: 'select', cols: 'id, status' }, { data: [{ id: 'e1', status: 'enrolled' }, { id: 'e2', status: 'in_progress' }] });
        on('academy_outcomes', { kind: 'select', cols: 'id, required' }, { data: [{ id: 1, required: false }] });
        await expect(recommendEnrollmentsBulk('s1', ['e1', 'e2'], 55, true)).resolves.toEqual({ recommended: 2, skipped: 0 });
        expect(eqsOf(queriesOn('academy_outcomes')[0])).toEqual({ course_id: 'c1' });
        expect(queriesOn('academy_outcome_results')).toEqual([]);
        const [upd] = queriesOn('academy_enrollments', 'update');
        expect(payloadOf(upd)).toEqual({ recommended_by: 55, recommended_at: expect.stringMatching(ISO_RE) });
        expect(eqsOf(upd)).toEqual({ session_id: 's1' });
        expect(argOf(upd, 'in')).toEqual(['id', ['e1', 'e2']]);
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
        expect(notifications().map(n => n.uid)).toEqual([1, 2]);
        expect(notifications()[0]).toMatchObject({
            type: 'academy_recommended', title: 'Ready for certification', link: 'academy',
            body: '2 students recommended for certification in Intro to SAR.',
            metadata: { courseId: 'c1', sessionId: 's1', count: 2 },
        });
        // usersWithPermission: capped + ordered at every hop, soft-deleted users excluded.
        const [pq] = queriesOn('permissions');
        expect(argOf(pq, 'limit')).toEqual([50]);
        const [rpq] = queriesOn('role_permissions');
        expect(argOf(rpq, 'in')).toEqual(['permission_id', [900]]);
        expect(argOf(rpq, 'order')).toEqual(['role_id', { ascending: true }]);
        expect(argOf(rpq, 'limit')).toEqual([2000]);
        const [uq] = queriesOn('users');
        expect(argOf(uq, 'in')).toEqual(['role_id', [3, 4]]);
        expect(argOf(uq, 'is')).toEqual(['deleted_at', null]);
        expect(argOf(uq, 'limit')).toEqual([500]);
        assertNoWildcardSelects();
    });

    it('with required outcomes only fully-competent enrolments qualify; the singular body is used for one', async () => {
        seedSession();
        seedCourseContext();
        seedManagers([1]);
        on('academy_enrollments', { kind: 'select', cols: 'id, status' }, { data: [
            { id: 'e1', status: 'enrolled' }, { id: 'e2', status: 'enrolled' }, { id: 'e3', status: 'enrolled' },
        ] });
        on('academy_outcomes', { kind: 'select', cols: 'id, required' }, { data: [{ id: 1, required: true }, { id: 2, required: null }, { id: 3, required: false }] });
        on('academy_outcome_results', { kind: 'select' }, { data: [
            { enrollment_id: 'e1', outcome_id: 1, verdict: 'competent' }, { enrollment_id: 'e1', outcome_id: 2, verdict: 'competent' },
            { enrollment_id: 'e2', outcome_id: 1, verdict: 'competent' }, { enrollment_id: 'e2', outcome_id: 2, verdict: 'not_yet_competent' },
        ] });
        await expect(recommendEnrollmentsBulk('s1', ['e1', 'e2', 'e3'], 55, true)).resolves.toEqual({ recommended: 1, skipped: 2 });
        const [rq] = queriesOn('academy_outcome_results');
        expect(colsOf(rq)).toBe('enrollment_id, outcome_id, verdict');
        expect(argOf(rq, 'in')).toEqual(['enrollment_id', ['e1', 'e2', 'e3']]);
        expect(argOf(rq, 'limit')).toEqual([5000]);
        expect(argOf(queriesOn('academy_enrollments', 'update')[0], 'in')).toEqual(['id', ['e1']]);
        expect(notifications()[0].body).toBe('1 student recommended for certification in Intro to SAR.');
    });

    it('when nobody is fully competent nothing is written and nobody is notified', async () => {
        seedSession();
        seedManagers([1]);
        on('academy_enrollments', { kind: 'select', cols: 'id, status' }, { data: [{ id: 'e1', status: 'enrolled' }] });
        on('academy_outcomes', { kind: 'select', cols: 'id, required' }, { data: [{ id: 1, required: true }] });
        await expect(recommendEnrollmentsBulk('s1', ['e1'], 1, true)).resolves.toEqual({ recommended: 0, skipped: 1 });
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
        expect(notifications()).toEqual([]);
        expect(broadcasts()).toEqual([]);
    });

    it('no course context or no managers → the recommendation stands but nobody is notified', async () => {
        seedSession();
        on('academy_enrollments', { kind: 'select', cols: 'id, status' }, { data: [{ id: 'e1', status: 'enrolled' }] });
        seedManagers([1]);
        await expect(recommendEnrollmentsBulk('s1', ['e1'], 1, true)).resolves.toEqual({ recommended: 1, skipped: 0 });
        expect(notifications()).toEqual([]);
        resetHarness();
        seedSession(); seedCourseContext();
        on('academy_enrollments', { kind: 'select', cols: 'id, status' }, { data: [{ id: 'e1', status: 'enrolled' }] });
        await expect(recommendEnrollmentsBulk('s1', ['e1'], 1, true)).resolves.toEqual({ recommended: 1, skipped: 0 });
        expect(notifications()).toEqual([]);
        expect(queriesOn('role_permissions')).toEqual([]);
    });

    it('a permission that maps to no role short-circuits before the users read', async () => {
        seedSession(); seedCourseContext();
        on('academy_enrollments', { kind: 'select', cols: 'id, status' }, { data: [{ id: 'e1', status: 'enrolled' }] });
        on('permissions', { kind: 'select', cols: 'id' }, { data: [{ id: 900 }] });
        on('role_permissions', { kind: 'select' }, { data: [] });
        await recommendEnrollmentsBulk('s1', ['e1'], 1, true);
        expect(queriesOn('users')).toEqual([]);
        expect(notifications()).toEqual([]);
    });

    it('a course whose session course row vanished yields no context (no notice)', async () => {
        seedSession(); seedManagers([1]);
        on('academy_sessions', { kind: 'select', cols: 'course_id' }, { data: { course_id: 'c1' } });
        on('academy_enrollments', { kind: 'select', cols: 'id, status' }, { data: [{ id: 'e1', status: 'enrolled' }] });
        await recommendEnrollmentsBulk('s1', ['e1'], 1, true);
        expect(notifications()).toEqual([]);
    });

    it('an update error surfaces the generic message', async () => {
        seedSession();
        on('academy_enrollments', { kind: 'select', cols: 'id, status' }, { data: [{ id: 'e1', status: 'enrolled' }] });
        on('academy_enrollments', { kind: 'update' }, { error: { code: 'X' } });
        await expect(recommendEnrollmentsBulk('s1', ['e1'], 1, true)).rejects.toThrow('Failed to recommend enrolments');
        expect(notifications()).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('selfEnroll (academy_claim_seat)', () => {
    const openCourse = () => seedCourse({ status: 'published', access: 'open' });

    it('an unknown session / course is denied opaquely', async () => {
        await expect(selfEnroll('nope', 20)).rejects.toThrow('This session is not available.');
        seedSession({ course_id: 'gone' });
        await expect(selfEnroll('s1', 20)).rejects.toThrow('This course is not available.');
        expect(sb.rpcCalls).toEqual([]);
    });

    it.each([
        [{ status: 'draft', access: 'open' }],
        [{ status: 'published', access: 'gated' }],
        [{ status: 'archived', access: 'open' }],
    ])('refuses a course that is not published+open (%o) with an audited denial', async (course) => {
        seedSession(); seedCourse(course);
        const err = await selfEnroll('s1', 20).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('This course is not open for self-enrolment.');
        expect((err as SecurityDenial).auditEvent).toBe('authz.permission_denied');
        expect(sb.rpcCalls).toEqual([]);
    });

    it.each([
        [{ enrollment_open: false }], [{ status: 'completed' }], [{ status: 'cancelled' }],
    ])('refuses a session that is not accepting (%o)', async (session) => {
        seedSession(session); openCourse();
        await expect(selfEnroll('s1', 20)).rejects.toThrow('This session is not accepting enrolments.');
        expect(sb.rpcCalls).toEqual([]);
    });

    it('claims the seat through the atomic function, never a bare insert, then notifies the student', async () => {
        seedSession(); openCourse(); seedCourseContext();
        await selfEnroll('s1', 20);
        expect(sb.rpcCalls).toEqual([{ fn: 'academy_claim_seat', args: { p_session_id: 's1', p_student_id: 20, p_source: 'self' } }]);
        expect(queriesOn('academy_enrollments')).toEqual([]);
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
        expect(notifications()).toEqual([{
            uid: 20, type: 'academy_enrolled', title: 'Enrolled in a course', body: "You're enrolled in Intro to SAR.",
            link: 'academy', metadata: { courseId: 'c1', sessionId: 's1' },
        }]);
    });

    it('no course context → enrolled, but no notification', async () => {
        seedSession(); openCourse();
        await selfEnroll('s1', 20);
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
        expect(notifications()).toEqual([]);
    });

    it.each(['42883', 'PGRST202'])('FAILS CLOSED when the claim function is missing (%s)', async (code) => {
        seedSession(); openCourse();
        rpcReturns({ error: { code, message: 'function academy_claim_seat does not exist' } });
        await expect(selfEnroll('s1', 20)).rejects.toThrow('Enrolment is unavailable until the database schema is re-applied (schema.sql). Ask an administrator to run it.');
        expect(queriesOn('academy_enrollments')).toEqual([]);
        expect(broadcasts()).toEqual([]);
        expect(notifications()).toEqual([]);
    });

    it.each([
        ['ERROR:  This session is full.', 'This session is full.'],
        ['This session is not accepting enrolments.', 'This session is not accepting enrolments.'],
        ['P0001: Session not found', 'Session not found'],
    ])('surfaces the function RAISE %j as %j', async (raw, shown) => {
        seedSession(); openCourse();
        rpcReturns({ error: { code: 'P0001', message: raw } });
        await expect(selfEnroll('s1', 20)).rejects.toThrow(shown);
        expect(broadcasts()).toEqual([]);
    });

    it('a raw engine error is NOT echoed — only the generic message', async () => {
        seedSession(); openCourse();
        rpcReturns({ error: { code: '23505', message: 'duplicate key value violates unique constraint "academy_enrollments_session_student"' } });
        const err = await selfEnroll('s1', 20).catch((e: unknown) => e as Error);
        expect((err as Error).message).toBe('Failed to enrol');
        rpcReturns({ error: { code: 'XX' } });
        await expect(selfEnroll('s1', 20)).rejects.toThrow('Failed to enrol');
    });
});

describe('assignStudents', () => {
    const seedMembers = (rows: Array<{ id: number; role_id: number }>) =>
        on('users', { kind: 'select', cols: 'id, role_id' }, { data: rows });

    it('a non-instructor is denied', async () => {
        seedSession();
        await expect(assignStudents('s1', [20], 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('users')).toEqual([]);
    });

    it('an empty / junk list returns 0 without resolving the tier', async () => {
        seedSession();
        await expect(assignStudents('s1', ['x' as never], 1, true)).resolves.toBe(0);
        expect(requireClientRoleId).not.toHaveBeenCalled();
        expect(queriesOn('users')).toEqual([]);
    });

    it('FAILS CLOSED on an unresolvable client tier — no member read, no insert', async () => {
        seedSession();
        requireClientRoleId.mockRejectedValueOnce(new Error('Role configuration unavailable'));
        await expect(assignStudents('s1', [20], 1, true)).rejects.toThrow('Role configuration unavailable');
        expect(queriesOn('users')).toEqual([]);
        expect(writesOn('academy_enrollments', 'insert')).toEqual([]);
    });

    it('refuses the whole batch when any id is not a live member', async () => {
        seedSession();
        seedMembers([{ id: 20, role_id: 3 }]);
        const err = await assignStudents('s1', [20, 21, 20], 1, true).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Student is not a valid member.');
        expect((err as SecurityDenial).fields).toEqual({ userId: 21 });
        const [uq] = queriesOn('users');
        expect(argOf(uq, 'in')).toEqual(['id', [20, 21]]);
        expect(argOf(uq, 'is')).toEqual(['deleted_at', null]);
        expect(writesOn('academy_enrollments', 'insert')).toEqual([]);
    });

    it('a null member result makes every id invalid', async () => {
        seedSession();
        await expect(assignStudents('s1', [20], 1, true)).rejects.toThrow('Student is not a valid member.');
    });

    it('refuses ALL-OR-NOTHING when a client account is targeted, naming the ids; no row, no notification', async () => {
        seedSession(); seedCourseContext();
        seedMembers([{ id: 20, role_id: 3 }, { id: 21, role_id: CLIENT_ROLE_ID }]);
        const err = await assignStudents('s1', [20, 21], 1, true).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Client accounts cannot be enrolled in courses (user id 21). Remove them and retry.');
        expect((err as SecurityDenial).fields).toEqual({ userIds: [21] });
        expect(writesOn('academy_enrollments', 'insert')).toEqual([]);
        expect(notifications()).toEqual([]);
    });

    it('the refusal message pluralises for several client ids', async () => {
        seedSession();
        seedMembers([{ id: 21, role_id: CLIENT_ROLE_ID }, { id: 22, role_id: CLIENT_ROLE_ID }]);
        await expect(assignStudents('s1', [21, 22], 1, true)).rejects.toThrow('(user ids 21, 22)');
    });

    it('inserts only newcomers, with source/assigner/status, and notifies only them', async () => {
        seedSession(); seedCourseContext();
        seedMembers([{ id: 20, role_id: 3 }, { id: 21, role_id: 3 }, { id: 22, role_id: 3 }]);
        on('academy_enrollments', { kind: 'select', cols: 'student_id' }, { data: [{ student_id: 21 }] });
        await expect(assignStudents('s1', [20, 21, 22], 5, false).catch(e => e)).resolves.toBeInstanceOf(SecurityDenial);
        // ↑ a non-instructor (5) is denied; now as a session instructor:
        seedSessionInstructor('s1', 5);
        await expect(assignStudents('s1', [20, 21, 22], 5, false)).resolves.toBe(2);
        const [existingQ] = queriesOn('academy_enrollments', 'select');
        expect(eqsOf(existingQ)).toEqual({ session_id: 's1' });
        expect(argOf(existingQ, 'in')).toEqual(['student_id', [20, 21, 22]]);
        expect(writesOn('academy_enrollments', 'insert')).toEqual([[
            { session_id: 's1', student_id: 20, source: 'assigned', assigned_by: 5, status: 'enrolled' },
            { session_id: 's1', student_id: 22, source: 'assigned', assigned_by: 5, status: 'enrolled' },
        ]]);
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
        expect(notifications().map(n => n.uid)).toEqual([20, 22]);
        expect(notifications()[0]).toMatchObject({ type: 'academy_enrolled', body: "You've been enrolled in Intro to SAR.", metadata: { courseId: 'c1', sessionId: 's1' } });
    });

    it('caps the batch at 200 ids', async () => {
        seedSession();
        const ids = Array.from({ length: 250 }, (_, i) => i + 1);
        seedMembers(ids.map(id => ({ id, role_id: 3 })));
        await assignStudents('s1', ids, 1, true);
        expect((argOf(queriesOn('users')[0], 'in')![1] as number[])).toHaveLength(200);
        expect((writesOn('academy_enrollments', 'insert')[0] as unknown[])).toHaveLength(200);
    });

    it('when everyone is already enrolled: no insert, broadcast, return 0', async () => {
        seedSession();
        seedMembers([{ id: 20, role_id: 3 }]);
        on('academy_enrollments', { kind: 'select', cols: 'student_id' }, { data: [{ student_id: 20 }] });
        await expect(assignStudents('s1', [20], 1, true)).resolves.toBe(0);
        expect(writesOn('academy_enrollments', 'insert')).toEqual([]);
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
        expect(notifications()).toEqual([]);
    });

    it('a 23505 race is tolerated; other insert errors throw; no context → no notification', async () => {
        seedSession();
        seedMembers([{ id: 20, role_id: 3 }]);
        once('academy_enrollments', { kind: 'insert' }, { error: { code: '23505' } });
        await expect(assignStudents('s1', [20], 1, true)).resolves.toBe(1);
        expect(notifications()).toEqual([]);
        on('academy_enrollments', { kind: 'insert' }, { error: { code: '23503' } });
        await expect(assignStudents('s1', [20], 1, true)).rejects.toThrow('Failed to assign students');
    });

    it('a notification failure does not fail the assignment', async () => {
        seedSession(); seedCourseContext();
        seedMembers([{ id: 20, role_id: 3 }]);
        createNotification.mockRejectedValue(new Error('down'));
        await expect(assignStudents('s1', [20], 1, true)).resolves.toBe(1);
    });
});

describe('withdrawEnrollment', () => {
    it('an unknown enrolment is an opaque denial; a read fault throws', async () => {
        const err = await withdrawEnrollment('nope', 20, false).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('This enrolment is not available.');
        const [g] = queriesOn('academy_enrollments');
        expect(colsOf(g)).toBe(ENROLLMENT_GUARD_COLS);
        expect(eqsOf(g)).toEqual({ id: 'nope' });
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_GUARD_COLS }, { error: { code: '57014' } });
        await expect(withdrawEnrollment('e1', 20, false)).rejects.toThrow('Failed to load enrolment');
    });

    it('a missing enrolment table (42P01) is "not available"', async () => {
        on('academy_enrollments', { kind: 'select', cols: ENROLLMENT_GUARD_COLS }, { error: { code: '42P01' } });
        await expect(withdrawEnrollment('e1', 20, false)).rejects.toThrow('This enrolment is not available.');
    });

    it('a student withdraws themselves with no session-authority lookup', async () => {
        seedEnrollment({ student_id: 20 });
        await withdrawEnrollment('e1', 20, false);
        expect(queriesOn('academy_sessions')).toEqual([]);
        const [upd] = queriesOn('academy_enrollments', 'update');
        expect(payloadOf(upd)).toEqual({ status: 'withdrawn' });
        expect(eqsOf(upd)).toEqual({ id: 'e1' });
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
    });

    it('someone else needs session authority', async () => {
        seedEnrollment({ student_id: 20 }); seedSession();
        await expect(withdrawEnrollment('e1', 99, false)).rejects.toThrow('You are not an instructor of this session.');
        expect(queriesOn('academy_enrollments', 'update')).toEqual([]);
        seedSessionInstructor('s1', 55);
        await withdrawEnrollment('e1', 55, false);
        expect(queriesOn('academy_enrollments', 'update')).toHaveLength(1);
    });

    it('an update error surfaces the generic message', async () => {
        seedEnrollment({ student_id: 20 });
        on('academy_enrollments', { kind: 'update' }, { error: { code: 'X' } });
        await expect(withdrawEnrollment('e1', 20, false)).rejects.toThrow('Failed to withdraw enrolment');
        expect(broadcasts()).toEqual([]);
    });
});
