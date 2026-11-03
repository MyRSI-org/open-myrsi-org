import { describe, it, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// lib/db/academy.ts — ENROLMENT REQUESTS (ask-first path for gated courses)
// =============================================================================
// The load-bearing rules pinned here:
//  - the approver fan-out is ONCE-EVER per (session, student) pairing, decided by an
//    existence question over historical rows, and an unreadable history SUPPRESSES the
//    fan-out (an amplifier fails closed toward silence);
//  - every approver half is passed through the client-tier filter, and an unresolvable
//    tier notifies nobody;
//  - a decision is a CAS on the pending status, and an approval claims its seat through
//    the same atomic academy_claim_seat() as self-enrol (fail closed when absent);
//  - request reads/writes are self-scoped (member) or session-authority-scoped (staff).
vi.mock('../lib/db/common.js', async () => {
    const hh = await import('./cov-db-academy-harness');
    return { supabase: hh.supabaseStub, handleSupabaseError: hh.handleSupabaseError, broadcastToOrg: hh.broadcastToOrg };
});
vi.mock('../lib/db/system.js', async () => ({ awardCertification: (await import('./cov-db-academy-harness')).awardCertification }));
vi.mock('../lib/db/notifications.js', async () => ({ createNotification: (await import('./cov-db-academy-harness')).createNotification }));
vi.mock('../lib/db/clientRoleLock.js', async () => ({ requireClientRoleId: (await import('./cov-db-academy-harness')).requireClientRoleId }));
vi.mock('../lib/log.js', async () => ({ log: (await import('./cov-db-academy-harness')).logSpy }));

import {
    sb, on, resetHarness, queriesOn, writesOn, broadcasts, notifications, rpcReturns, assertNoWildcardSelects,
    argOf, argsOf, colsOf, eqsOf, payloadOf, requireClientRoleId, logSpy, CLIENT_ROLE_ID,
    seedCourse, seedSession, seedSessionInstructor, REQUEST_COLS, type Q,
} from './cov-db-academy-harness';
import {
    requestEnrollment, withdrawEnrollmentRequest, decideEnrollmentRequest,
    listEnrollmentRequests, listMyEnrollmentRequests,
} from '../lib/db/academy';
import { SecurityDenial } from '../lib/errors';

beforeEach(() => resetHarness());

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function requestRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        id: 'r1', session_id: 's1', student_id: 20, status: 'pending', message: null, decided_by: null,
        decision_reason: null, decided_at: null, created_at: '2026-02-01T00:00:00Z', ...over,
    };
}
const gatedPublished = (over: Partial<Record<string, unknown>> = {}) =>
    seedCourse({ status: 'published', access: 'gated', created_by: 10, ...over });

/** Approver sources: course instructors, session instructors, academy:manage role holders.
 *  `members` is the live-user table the tier filter reads (id → role_id). */
function seedApprovers(opts: {
    courseInstructors?: number[]; sessionInstructors?: number[]; managers?: number[];
    members: Record<number, number>;
}): void {
    on('academy_course_instructors', { kind: 'select', cols: 'user_id' }, { data: (opts.courseInstructors ?? []).map(user_id => ({ user_id })) });
    on('academy_session_instructors', { kind: 'select', cols: 'user_id' }, { data: (opts.sessionInstructors ?? []).map(user_id => ({ user_id })) });
    on('permissions', { kind: 'select', cols: 'id', eq: { name: 'academy:manage' } }, { data: { id: 900 } });
    on('role_permissions', { kind: 'select', cols: 'role_id' }, { data: [{ role_id: 4 }, { role_id: 4 }] });
    on('users', { kind: 'select', cols: 'id', where: (q: Q) => argOf(q, 'in')?.[0] === 'role_id' }, { data: (opts.managers ?? []).map(id => ({ id })) });
    on('users', { kind: 'select', cols: 'id, role_id' }, (q: Q) => {
        const ids = (argOf(q, 'in')?.[1] ?? []) as number[];
        return { data: ids.filter(id => id in opts.members).map(id => ({ id, role_id: opts.members[id] })) };
    });
}

/** The announce-history existence probe (notified_at IS NOT NULL). */
const historyProbe = (): Q => queriesOn('academy_enrollment_requests', 'select')[0];

// ════════════════════════════════════════════════════════════════════════════
describe('requestEnrollment — gates', () => {
    it('an unpublished course is the opaque "not available" denial', async () => {
        seedSession(); seedCourse({ status: 'draft' });
        const err = await requestEnrollment('s1', 20).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('This course is not available.');
        expect(queriesOn('academy_enrollment_requests')).toEqual([]);
    });

    it.each([[{ enrollment_open: false }], [{ status: 'completed' }], [{ status: 'cancelled' }]])(
        'a session not accepting (%o) is refused', async (session) => {
            seedSession(session); gatedPublished();
            await expect(requestEnrollment('s1', 20)).rejects.toThrow('This session is not accepting enrolments.');
            expect(queriesOn('academy_enrollment_requests')).toEqual([]);
        });

    it('an OPEN course needs no request — refused so the two paths cannot drift', async () => {
        seedSession(); seedCourse({ status: 'published', access: 'open' });
        await expect(requestEnrollment('s1', 20)).rejects.toThrow('This course is open — enrol directly rather than requesting a seat.');
        expect(queriesOn('academy_enrollments')).toEqual([]);
    });

    it('an existing live enrolment refuses the request', async () => {
        seedSession(); gatedPublished();
        on('academy_enrollments', { kind: 'select', cols: 'id, status' }, { data: { id: 'e1', status: 'in_progress' } });
        await expect(requestEnrollment('s1', 20)).rejects.toThrow('You are already enrolled in this session.');
        const [eq] = queriesOn('academy_enrollments');
        expect(eqsOf(eq)).toEqual({ session_id: 's1', student_id: 20 });
        expect(queriesOn('academy_enrollment_requests')).toEqual([]);
    });
});

describe('requestEnrollment — once-ever fan-out', () => {
    it('FIRST request: stamps notified_at, fans out to every non-client approver except the requester', async () => {
        seedSession(); gatedPublished();
        on('academy_enrollments', { kind: 'select', cols: 'id, status' }, { data: { id: 'e0', status: 'withdrawn' } });
        on('academy_enrollment_requests', { kind: 'insert' }, { data: requestRow({ message: 'please' }) });
        seedApprovers({
            courseInstructors: [11], sessionInstructors: [12, 20], managers: [13, 14],
            // 14 is a demoted-to-Client manager, 20 the requester (also a session instructor).
            members: { 10: 3, 11: 3, 12: 3, 13: 3, 14: CLIENT_ROLE_ID, 20: 3 },
        });
        const out = await requestEnrollment('s1', 20, '  <b>please</b>  ');

        const probe = historyProbe();
        expect(colsOf(probe)).toBe('id');
        expect(eqsOf(probe)).toEqual({ session_id: 's1', student_id: 20 });
        expect(argOf(probe, 'not')).toEqual(['notified_at', 'is', null]);
        expect(argOf(probe, 'order')).toEqual(['id', { ascending: true }]);
        expect(argOf(probe, 'limit')).toEqual([1]);

        const [ins] = queriesOn('academy_enrollment_requests', 'insert');
        expect(payloadOf(ins)).toEqual({ session_id: 's1', student_id: 20, status: 'pending', message: 'please', notified_at: expect.stringMatching(ISO_RE) });
        expect(colsOf(ins)).toBe(REQUEST_COLS);

        expect(notifications().map(n => n.uid).sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
        for (const n of notifications()) {
            expect(n).toMatchObject({
                type: 'academy_enrollment_requested', title: 'Enrolment request', link: 'academy',
                body: 'A member has asked to join a course session.', metadata: { sessionId: 's1', courseId: 'c1' },
            });
        }
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
        expect(out).toEqual({
            id: 'r1', sessionId: 's1', studentId: 20, status: 'pending', message: 'please', decidedBy: null,
            decisionReason: null, decidedAt: null, createdAt: '2026-02-01T00:00:00Z',
        });

        // Approver reads are capped + ordered; managers exclude soft-deleted users.
        const [si] = queriesOn('academy_session_instructors');
        expect(eqsOf(si)).toEqual({ session_id: 's1' });
        expect(argOf(si, 'limit')).toEqual([50]);
        const [perm] = queriesOn('permissions');
        expect(argOf(perm, 'limit')).toEqual([1]);
        expect(perm.terminal).toBe('maybeSingle');
        const [rp] = queriesOn('role_permissions');
        expect(eqsOf(rp)).toEqual({ permission_id: 900 });
        expect(argOf(rp, 'limit')).toEqual([200]);
        const mgrQ = queriesOn('users').find(q => argOf(q, 'in')?.[0] === 'role_id')!;
        expect(argOf(mgrQ, 'in')).toEqual(['role_id', [4]]);
        expect(argOf(mgrQ, 'is')).toEqual(['deleted_at', null]);
        expect(argOf(mgrQ, 'limit')).toEqual([50]);
        assertNoWildcardSelects();
    });

    it('a pairing ALREADY announced is persisted unstamped and fans out to nobody', async () => {
        seedSession(); gatedPublished();
        on('academy_enrollment_requests', { kind: 'select', cols: 'id' }, { data: [{ id: 'rOld' }] });
        on('academy_enrollment_requests', { kind: 'insert' }, { data: requestRow() });
        seedApprovers({ courseInstructors: [11], members: { 10: 3, 11: 3 } });
        await requestEnrollment('s1', 20);
        expect(writesOn('academy_enrollment_requests', 'insert')[0]).toMatchObject({ notified_at: null, message: null });
        expect(notifications()).toEqual([]);
        expect(queriesOn('academy_session_instructors')).toEqual([]);
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
    });

    it('an UNREADABLE history fails closed toward SUPPRESSION (logs, no fan-out, request still saved)', async () => {
        seedSession(); gatedPublished();
        on('academy_enrollment_requests', { kind: 'select', cols: 'id' }, { error: { code: '57014', message: 'timeout' } });
        on('academy_enrollment_requests', { kind: 'insert' }, { data: requestRow() });
        seedApprovers({ courseInstructors: [11], members: { 10: 3, 11: 3 } });
        await requestEnrollment('s1', 20);
        expect(logSpy.error).toHaveBeenCalledWith('enrolment announce-history read failed; suppressing fan-out', expect.objectContaining({ sessionId: 's1', studentId: 20 }));
        expect(writesOn('academy_enrollment_requests', 'insert')[0]).toMatchObject({ notified_at: null });
        expect(notifications()).toEqual([]);
    });

    it('a concurrent pending duplicate (23505) is a clear refusal', async () => {
        seedSession(); gatedPublished();
        on('academy_enrollment_requests', { kind: 'insert' }, { error: { code: '23505' } });
        await expect(requestEnrollment('s1', 20)).rejects.toThrow('You already have a pending request for this session.');
        expect(notifications()).toEqual([]);
        expect(broadcasts()).toEqual([]);
    });

    it('any other insert error surfaces the generic message', async () => {
        seedSession(); gatedPublished();
        on('academy_enrollment_requests', { kind: 'insert' }, { error: { code: '23503' } });
        await expect(requestEnrollment('s1', 20)).rejects.toThrow('Failed to request enrolment');
    });

    it('caps the message at 500 characters', async () => {
        seedSession(); gatedPublished();
        on('academy_enrollment_requests', { kind: 'insert' }, { data: requestRow() });
        await requestEnrollment('s1', 20, 'm'.repeat(800));
        expect(((writesOn('academy_enrollment_requests', 'insert')[0] as Record<string, unknown>).message as string)).toHaveLength(500);
    });

    it('an unknown stored status maps to pending (never to approved)', async () => {
        seedSession(); gatedPublished();
        on('academy_enrollment_requests', { kind: 'insert' }, { data: requestRow({ status: 'bogus' }) });
        await expect(requestEnrollment('s1', 20)).resolves.toMatchObject({ status: 'pending' });
    });
});

describe('requestApprovers — client-tier filter and fail-closed tier', () => {
    const firstRequest = (course: Partial<Record<string, unknown>> = {}) => {
        seedSession(); gatedPublished(course);
        on('academy_enrollment_requests', { kind: 'insert' }, { data: requestRow() });
    };

    it('an unresolvable tier (second resolution) notifies NOBODY, never "notify anyway"', async () => {
        firstRequest();
        seedApprovers({ sessionInstructors: [12], managers: [13], members: { 10: 3, 12: 3, 13: 3 } });
        requireClientRoleId.mockResolvedValueOnce(CLIENT_ROLE_ID).mockRejectedValueOnce(new Error('unresolved'));
        await requestEnrollment('s1', 20);
        expect(requireClientRoleId).toHaveBeenCalledTimes(2);
        expect(notifications()).toEqual([]);
    });

    it('no approvers anywhere → nobody notified, no tier read', async () => {
        firstRequest({ created_by: 0 });
        await requestEnrollment('s1', 20);
        expect(queriesOn('users').filter(q => colsOf(q) === 'id, role_id')).toEqual([]);
        expect(notifications()).toEqual([]);
    });

    it('a role map with no academy:manage permission still filters the other halves', async () => {
        firstRequest();
        on('academy_session_instructors', { kind: 'select', cols: 'user_id' }, { data: [{ user_id: 12 }] });
        on('users', { kind: 'select', cols: 'id, role_id' }, (q: Q) => ({
            data: ((argOf(q, 'in')?.[1] ?? []) as number[]).map(id => ({ id, role_id: id === 12 ? CLIENT_ROLE_ID : 3 })),
        }));
        await requestEnrollment('s1', 20);
        // academy:manage missing → role_permissions never read; managers asked for role_id IN ().
        expect(queriesOn('role_permissions')).toEqual([]);
        const mgrQ = queriesOn('users').find(q => argOf(q, 'in')?.[0] === 'role_id')!;
        expect(argOf(mgrQ, 'in')).toEqual(['role_id', []]);
        // 12 is client-tier → dropped; 10 (author) survives.
        expect(notifications().map(n => n.uid)).toEqual([10]);
    });

    it('the combined approver read is capped at 50', async () => {
        firstRequest();
        const many = Array.from({ length: 60 }, (_, i) => 100 + i);
        seedApprovers({ sessionInstructors: many, members: Object.fromEntries([[10, 3], ...many.map(id => [id, 3])]) });
        await requestEnrollment('s1', 20);
        const tierQs = queriesOn('users').filter(q => colsOf(q) === 'id, role_id');
        const finalTier = tierQs[tierQs.length - 1];
        expect(argOf(finalTier, 'limit')).toEqual([50]);
        expect(argOf(finalTier, 'order')).toEqual(['id', { ascending: true }]);
        // The stub ignores limit(), so this proves the belt-and-braces slice(0, 50) too.
        expect(notifications()).toHaveLength(50);
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('withdrawEnrollmentRequest (self-scoped)', () => {
    it("another member's request is indistinguishable from a missing one", async () => {
        on('academy_enrollment_requests', { kind: 'select' }, { data: { id: 'r1', student_id: 21, status: 'pending', session_id: 's1' } });
        const err = await withdrawEnrollmentRequest('r1', 20).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Request not found.');
        resetHarness();
        await expect(withdrawEnrollmentRequest('nope', 20)).rejects.toThrow('Request not found.');
        expect(writesOn('academy_enrollment_requests', 'update')).toEqual([]);
    });

    it('only a pending request can be withdrawn', async () => {
        on('academy_enrollment_requests', { kind: 'select' }, { data: { id: 'r1', student_id: 20, status: 'approved', session_id: 's1' } });
        await expect(withdrawEnrollmentRequest('r1', 20)).rejects.toThrow('Only a pending request can be withdrawn.');
        expect(writesOn('academy_enrollment_requests', 'update')).toEqual([]);
    });

    it('withdraws with a CAS on pending and broadcasts the session id', async () => {
        on('academy_enrollment_requests', { kind: 'select' }, { data: { id: 'r1', student_id: 20, status: 'pending', session_id: 's1' } });
        await withdrawEnrollmentRequest('r1', 20);
        const [sel] = queriesOn('academy_enrollment_requests', 'select');
        expect(colsOf(sel)).toBe('id, student_id, status, session_id');
        const [upd] = queriesOn('academy_enrollment_requests', 'update');
        expect(payloadOf(upd)).toEqual({ status: 'withdrawn' });
        expect(eqsOf(upd)).toEqual({ id: 'r1', status: 'pending' });
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
    });

    it('an update error surfaces the generic message', async () => {
        on('academy_enrollment_requests', { kind: 'select' }, { data: { id: 'r1', student_id: 20, status: 'pending', session_id: 's1' } });
        on('academy_enrollment_requests', { kind: 'update' }, { error: { code: 'X' } });
        await expect(withdrawEnrollmentRequest('r1', 20)).rejects.toThrow('Failed to withdraw the request');
        expect(broadcasts()).toEqual([]);
    });
});

describe('decideEnrollmentRequest', () => {
    const seedReq = (over: Partial<Record<string, unknown>> = {}) =>
        on('academy_enrollment_requests', { kind: 'select', cols: 'id, session_id, student_id, status' }, { data: { id: 'r1', session_id: 's1', student_id: 20, status: 'pending', ...over } });
    const claimWins = () => on('academy_enrollment_requests', { kind: 'update' }, { data: [{ id: 'r1' }] });
    const seedCtx = () => {
        on('academy_sessions', { kind: 'select', cols: 'course_id' }, { data: { course_id: 'c1' } });
        on('academy_courses', { kind: 'select', cols: 'title' }, { data: { title: 'Intro to SAR' } });
    };

    it('an unknown request is an opaque denial before any session read', async () => {
        await expect(decideEnrollmentRequest('nope', 'approve', 1, true)).rejects.toThrow('Request not found.');
        expect(queriesOn('academy_sessions')).toEqual([]);
    });

    it('session authority is required, and is checked BEFORE the status', async () => {
        seedReq({ status: 'approved' }); seedSession();
        await expect(decideEnrollmentRequest('r1', 'approve', 99, false)).rejects.toThrow('You are not an instructor of this session.');
        expect(writesOn('academy_enrollment_requests', 'update')).toEqual([]);
    });

    it('an already-decided request is refused', async () => {
        seedReq({ status: 'denied' }); seedSession();
        await expect(decideEnrollmentRequest('r1', 'approve', 1, true)).rejects.toThrow('This request has already been decided.');
        expect(writesOn('academy_enrollment_requests', 'update')).toEqual([]);
    });

    it('APPROVE: CAS on pending, claims the seat atomically, notifies the student with the course title', async () => {
        seedReq(); seedSession(); seedSessionInstructor('s1', 55); claimWins(); seedCtx();
        await decideEnrollmentRequest('r1', 'approve', 55, false, ' <i>welcome</i> ');
        const [upd] = queriesOn('academy_enrollment_requests', 'update');
        expect(payloadOf(upd)).toEqual({ status: 'approved', decided_by: 55, decision_reason: 'welcome', decided_at: expect.stringMatching(ISO_RE) });
        expect(eqsOf(upd)).toEqual({ id: 'r1', status: 'pending' });
        expect(colsOf(upd)).toBe('id');
        expect(sb.rpcCalls).toEqual([{ fn: 'academy_claim_seat', args: { p_session_id: 's1', p_student_id: 20, p_source: 'assigned' } }]);
        expect(queriesOn('academy_enrollments')).toEqual([]);
        expect(notifications()).toEqual([{
            uid: 20, type: 'academy_enrolled', title: 'Enrolment request approved', body: "You're enrolled in Intro to SAR.",
            link: 'academy', metadata: { sessionId: 's1', courseId: 'c1' },
        }]);
        expect(broadcasts()).toEqual([{ sessionId: 's1' }]);
    });

    it('APPROVE without course context uses the generic body and omits courseId', async () => {
        seedReq(); seedSession(); claimWins();
        await decideEnrollmentRequest('r1', 'approve', 1, true);
        expect(notifications()).toEqual([{
            uid: 20, type: 'academy_enrolled', title: 'Enrolment request approved', body: 'Your enrolment request was approved.',
            link: 'academy', metadata: { sessionId: 's1' },
        }]);
    });

    it('DENY: records the decision, claims NO seat, sends a generic decline (reason never pushed)', async () => {
        seedReq(); seedSession(); claimWins(); seedCtx();
        await decideEnrollmentRequest('r1', 'deny', 1, true, 'not enough flight hours');
        expect(writesOn('academy_enrollment_requests', 'update')[0]).toMatchObject({ status: 'denied', decision_reason: 'not enough flight hours' });
        expect(sb.rpcCalls).toEqual([]);
        expect(notifications()).toEqual([{
            uid: 20, type: 'academy_enrollment_denied', title: 'Enrolment request declined',
            body: 'Your request to join a course session was declined.', link: 'academy', metadata: { sessionId: 's1' },
        }]);
        expect(JSON.stringify(notifications())).not.toContain('flight hours');
    });

    it('an empty reason is stored as null', async () => {
        seedReq(); seedSession(); claimWins();
        await decideEnrollmentRequest('r1', 'deny', 1, true);
        expect(writesOn('academy_enrollment_requests', 'update')[0]).toMatchObject({ decision_reason: null });
    });

    it('losing the CAS race (no row claimed, or a non-array) is "already decided" — no seat, no notice', async () => {
        seedReq(); seedSession();
        on('academy_enrollment_requests', { kind: 'update' }, { data: [] });
        await expect(decideEnrollmentRequest('r1', 'approve', 1, true)).rejects.toThrow('This request has already been decided.');
        resetHarness();
        seedReq(); seedSession();
        await expect(decideEnrollmentRequest('r1', 'approve', 1, true)).rejects.toThrow('This request has already been decided.');
        expect(sb.rpcCalls).toEqual([]);
        expect(notifications()).toEqual([]);
    });

    it('a CAS write error surfaces the generic message', async () => {
        seedReq(); seedSession();
        on('academy_enrollment_requests', { kind: 'update' }, { error: { code: 'X' } });
        await expect(decideEnrollmentRequest('r1', 'deny', 1, true)).rejects.toThrow('Failed to record the decision');
    });

    it.each(['42883', 'PGRST202'])('APPROVE fails closed when the claim function is missing (%s)', async (code) => {
        seedReq(); seedSession(); claimWins();
        rpcReturns({ error: { code } });
        await expect(decideEnrollmentRequest('r1', 'approve', 1, true)).rejects.toThrow(/schema is re-applied \(schema\.sql\)/);
        expect(notifications()).toEqual([]);
        expect(broadcasts()).toEqual([]);
    });

    it('APPROVE surfaces a capacity RAISE but never a raw engine error', async () => {
        seedReq(); seedSession(); claimWins();
        rpcReturns({ error: { code: 'P0001', message: 'ERROR: This session is full.' } });
        await expect(decideEnrollmentRequest('r1', 'approve', 1, true)).rejects.toThrow('This session is full.');
        rpcReturns({ error: { code: '23514', message: 'check constraint "x" violated' } });
        await expect(decideEnrollmentRequest('r1', 'approve', 1, true)).rejects.toThrow('Failed to enrol the requester');
        rpcReturns({ error: { code: '23514' } });
        await expect(decideEnrollmentRequest('r1', 'approve', 1, true)).rejects.toThrow('Failed to enrol the requester');
        expect(notifications()).toEqual([]);
    });
});

describe('listEnrollmentRequests (staff) / listMyEnrollmentRequests (self)', () => {
    it('staff list requires session authority', async () => {
        seedSession();
        await expect(listEnrollmentRequests('s1', 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('academy_enrollment_requests')).toEqual([]);
    });

    it('staff list: pending only, oldest first with an id tiebreak, capped, mapped', async () => {
        seedSession();
        on('academy_enrollment_requests', { kind: 'select' }, { data: [requestRow(), requestRow({ id: 'r2', status: 'weird' })] });
        const out = await listEnrollmentRequests('s1', 1, true);
        expect(out.map(r => [r.id, r.status])).toEqual([['r1', 'pending'], ['r2', 'pending']]);
        const [q] = queriesOn('academy_enrollment_requests');
        expect(colsOf(q)).toBe(REQUEST_COLS);
        expect(eqsOf(q)).toEqual({ session_id: 's1', status: 'pending' });
        expect(argsOf(q, 'order')).toEqual([['created_at', { ascending: true }], ['id', { ascending: true }]]);
        expect(argOf(q, 'limit')).toEqual([500]);
    });

    it('my list is self-scoped, newest first, capped', async () => {
        on('academy_enrollment_requests', { kind: 'select' }, { data: [requestRow({ status: 'denied', decided_by: 1, decision_reason: 'r', decided_at: 't' })] });
        const out = await listMyEnrollmentRequests(20);
        expect(out).toEqual([{
            id: 'r1', sessionId: 's1', studentId: 20, status: 'denied', message: null, decidedBy: 1,
            decisionReason: 'r', decidedAt: 't', createdAt: '2026-02-01T00:00:00Z',
        }]);
        const [q] = queriesOn('academy_enrollment_requests');
        expect(eqsOf(q)).toEqual({ student_id: 20 });
        expect(argsOf(q, 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]]);
        expect(argOf(q, 'limit')).toEqual([500]);
    });

    it.each(['42P01', 'PGRST205'])('a missing table (%s) reads as empty on both lists', async (code) => {
        seedSession();
        on('academy_enrollment_requests', { kind: 'select' }, { error: { code } });
        await expect(listEnrollmentRequests('s1', 1, true)).resolves.toEqual([]);
        await expect(listMyEnrollmentRequests(20)).resolves.toEqual([]);
    });

    it('any other read error throws on both lists; null data reads empty', async () => {
        seedSession();
        await expect(listEnrollmentRequests('s1', 1, true)).resolves.toEqual([]);
        await expect(listMyEnrollmentRequests(20)).resolves.toEqual([]);
        on('academy_enrollment_requests', { kind: 'select' }, { error: { code: '57014' } });
        await expect(listEnrollmentRequests('s1', 1, true)).rejects.toThrow('Failed to load enrolment requests');
        await expect(listMyEnrollmentRequests(20)).rejects.toThrow('Failed to load your enrolment requests');
    });
});
