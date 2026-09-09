import * as db from '../../lib/db.js';
import type { AcademyOutcomeVerdict, AcademySessionStatus } from '../../types.js';
import { permissionSatisfied } from '../../lib/permissionImplications.js';

// Every handler receives the request body with the actor id (userId) and the
// authed `user` injected server-side by services.ts (userId is force-overwritten
// to the session user — never client-supplied). canManage / canAward / canView are
// derived from the actor's real permissions and composed with the dispatcher's
// single-perm gate:
//   • academy:instruct actions are BOLA-limited to the actor's assigned courses/
//     sessions in the db layer unless they hold academy:manage.
//   • academy:manage actions (approve/gating/certify) are dispatcher-gated.
//   • Awarding a certification ADDITIONALLY requires admin:award:certification.
// Single-org: no organizationId anywhere. The whole namespace is additionally
// feature-gated in the dispatcher (403 when the Academy feature is OFF).
// Exported so the three predicates are pinnable (tests/permissionImplications.test.ts)
// — they are gates, and a gate without a test is unshipped behaviour. Nothing new
// crosses the wire; the dispatcher only ever reaches `academyActions`.
type AcademyActor = { isSystemAdmin?: boolean; permissions?: string[] };
type Actor = { userId: number; user?: AcademyActor };
// NO ROLE-NAME BYPASS on either: `role` is the NAME-derived tier (lib/db/mappers.ts),
// so a permissionless custom role called "Commander" became a Learning Manager and a
// certificate awarder. Both are additionally dispatcher-gated upstream on
// academy:manage / academy:instruct, so the permission alone changes nothing reachable.
export const isManager = (u?: AcademyActor) => !!u?.permissions?.includes('academy:manage');
export const isAwarder = (u?: AcademyActor) => !!u?.permissions?.includes('admin:award:certification');
// "Is this actor STAFF for the purposes of reading someone else's enrolment" —
// getEnrollmentDetail's self-or-staff gate. academy:view is the open build's STAFF
// read (schema.sql §7: "View Academy (staff surfaces)"), and permissionSatisfied means
// an Instructor or Learning Manager who was never separately ticked academy:view counts
// too — otherwise the instructor who filed the outcome verdicts cannot open the student
// they filed them on. isManager/isAwarder stay bare: nothing implies academy:manage or
// admin:award:certification, so the double gate on certificate award is unchanged.
// Role IDENTITY rather than a bare permission, uniquely among the three. Its only
// consumer is mapped to the pseudo-permission 'user:manage:self', so this boolean is
// the ONLY authorization for a non-student viewer (lib/db/academy.ts
// getEnrollmentDetail) — and academy:view postdates the first public release, so an org
// that upgraded without running Repair has an Admin role that does not hold it yet.
// Deleting the Admin half outright would lock the org owner out of every student's
// enrolment record. isSystemAdmin is the unforgeable form of the same fact.
export const isViewer = (u?: AcademyActor) => u?.isSystemAdmin === true || permissionSatisfied(u?.permissions, 'academy:view');

export const academyActions = {
    // ── Courses ──────────────────────────────────────────────────────────────
    'academy:create_course': async ({ userId, title, description, icon, imageUrl, delivery }: Actor & { title?: string; description?: string | null; icon?: string | null; imageUrl?: string | null; delivery?: 'cohort' | 'self_paced' }) =>
        db.createCourse(userId, { title, description, icon, imageUrl, delivery }),
    'academy:update_course': async ({ userId, user, courseId, title, description, icon, imageUrl, sortOrder, delivery }: Actor & { courseId: string; title?: string; description?: string | null; icon?: string | null; imageUrl?: string | null; sortOrder?: number; delivery?: 'cohort' | 'self_paced' }) =>
        db.updateCourse(courseId, userId, isManager(user), { title, description, icon, imageUrl, sortOrder, delivery }),
    'academy:delete_course': async ({ userId, user, courseId }: Actor & { courseId: string }) =>
        db.deleteCourse(courseId, userId, isManager(user)),
    'academy:submit_course': async ({ userId, user, courseId }: Actor & { courseId: string }) =>
        db.submitCourseForApproval(courseId, userId, isManager(user)),
    'academy:set_course_certification': async ({ userId, user, courseId, certificationId }: Actor & { courseId: string; certificationId?: number | null }) =>
        db.setCourseCertification(courseId, certificationId ?? null, userId, isAwarder(user)),
    'academy:approve_course': async ({ userId, courseId, note }: Actor & { courseId: string; note?: unknown }) =>
        db.approveCourse(courseId, userId, note),
    // The note is REQUIRED here and the db layer refuses without it: a course bouncing
    // back to draft with no statement of what was wrong is the defect this exists to fix.
    'academy:reject_course': async ({ userId, courseId, note }: Actor & { courseId: string; note?: unknown }) =>
        db.rejectCourse(courseId, userId, note),
    'academy:set_course_archived': async ({ courseId, archived }: Actor & { courseId: string; archived?: boolean }) =>
        db.setCourseArchived(courseId, !!archived),
    'academy:set_course_access': async ({ courseId, access }: Actor & { courseId: string; access: 'open' | 'gated' }) =>
        db.setCourseAccess(courseId, access),
    'academy:add_course_instructor': async ({ userId, user, courseId, targetUserId }: Actor & { courseId: string; targetUserId: number }) =>
        db.addCourseInstructor(courseId, targetUserId, userId, isManager(user)),
    'academy:add_course_instructors': async ({ userId, user, courseId, targetUserIds }: Actor & { courseId: string; targetUserIds?: number[] }) =>
        db.addCourseInstructors(courseId, Array.isArray(targetUserIds) ? targetUserIds : [], userId, isManager(user)),
    'academy:remove_course_instructor': async ({ userId, user, courseId, targetUserId }: Actor & { courseId: string; targetUserId: number }) =>
        db.removeCourseInstructor(courseId, targetUserId, userId, isManager(user)),

    // ── Modules · Lessons · Outcomes ───────────────────────────────────────────
    'academy:create_module': async ({ userId, user, courseId, title, description, sortOrder }: Actor & { courseId: string; title?: string; description?: string | null; sortOrder?: number }) =>
        db.createModule(courseId, userId, isManager(user), { title, description, sortOrder }),
    'academy:update_module': async ({ userId, user, moduleId, title, description, sortOrder }: Actor & { moduleId: number; title?: string; description?: string | null; sortOrder?: number }) =>
        db.updateModule(moduleId, userId, isManager(user), { title, description, sortOrder }),
    'academy:delete_module': async ({ userId, user, moduleId }: Actor & { moduleId: number }) =>
        db.deleteModule(moduleId, userId, isManager(user)),
    'academy:create_lesson': async ({ userId, user, moduleId, title, content, videoUrl, sortOrder, estimatedMinutes }: Actor & { moduleId: number; title?: string; content?: string | null; videoUrl?: string | null; sortOrder?: number; estimatedMinutes?: number | null }) =>
        db.createLesson(moduleId, userId, isManager(user), { title, content, videoUrl, sortOrder, estimatedMinutes }),
    'academy:update_lesson': async ({ userId, user, lessonId, title, content, videoUrl, sortOrder, estimatedMinutes }: Actor & { lessonId: number; title?: string; content?: string | null; videoUrl?: string | null; sortOrder?: number; estimatedMinutes?: number | null }) =>
        db.updateLesson(lessonId, userId, isManager(user), { title, content, videoUrl, sortOrder, estimatedMinutes }),
    'academy:delete_lesson': async ({ userId, user, lessonId }: Actor & { lessonId: number }) =>
        db.deleteLesson(lessonId, userId, isManager(user)),
    'academy:create_outcome': async ({ userId, user, courseId, title, description, sortOrder, required }: Actor & { courseId: string; title?: string; description?: string | null; sortOrder?: number; required?: boolean }) =>
        db.createOutcome(courseId, userId, isManager(user), { title, description, sortOrder, required }),
    'academy:update_outcome': async ({ userId, user, outcomeId, title, description, sortOrder, required }: Actor & { outcomeId: number; title?: string; description?: string | null; sortOrder?: number; required?: boolean }) =>
        db.updateOutcome(outcomeId, userId, isManager(user), { title, description, sortOrder, required }),
    'academy:delete_outcome': async ({ userId, user, outcomeId }: Actor & { outcomeId: number }) =>
        db.deleteOutcome(outcomeId, userId, isManager(user)),

    // Reordering is ONE action carrying the whole intended order, not N sortOrder
    // nudges. orderedIds stays `unknown` on the way through: the db layer is the only
    // place that decides what a valid ordered list is, so there is one definition of
    // it rather than a handler-shaped one and a db-shaped one that can drift.
    'academy:reorder_modules': async ({ userId, user, courseId, orderedIds }: Actor & { courseId: string; orderedIds?: unknown }) =>
        db.reorderModules(courseId, orderedIds, userId, isManager(user)),
    'academy:reorder_lessons': async ({ userId, user, moduleId, orderedIds }: Actor & { moduleId: number; orderedIds?: unknown }) =>
        db.reorderLessons(moduleId, orderedIds, userId, isManager(user)),
    'academy:reorder_outcomes': async ({ userId, user, courseId, orderedIds }: Actor & { courseId: string; orderedIds?: unknown }) =>
        db.reorderOutcomes(courseId, orderedIds, userId, isManager(user)),

    // ── Sessions (cohorts) ─────────────────────────────────────────────────────
    'academy:create_session': async ({ userId, user, courseId, title, startsAt, endsAt, location, capacity, enrollmentOpen }: Actor & { courseId: string; title?: string; startsAt?: string | null; endsAt?: string | null; location?: string | null; capacity?: number | null; enrollmentOpen?: boolean }) =>
        db.createSession(courseId, userId, isManager(user), { title, startsAt, endsAt, location, capacity, enrollmentOpen }),
    'academy:update_session': async ({ userId, user, sessionId, title, startsAt, endsAt, location, capacity, enrollmentOpen }: Actor & { sessionId: string; title?: string; startsAt?: string | null; endsAt?: string | null; location?: string | null; capacity?: number | null; enrollmentOpen?: boolean }) =>
        db.updateSession(sessionId, userId, isManager(user), { title, startsAt, endsAt, location, capacity, enrollmentOpen }),
    'academy:set_session_status': async ({ userId, user, sessionId, status }: Actor & { sessionId: string; status: AcademySessionStatus }) =>
        db.setSessionStatus(sessionId, status, userId, isManager(user)),
    'academy:add_session_instructor': async ({ userId, user, sessionId, targetUserId }: Actor & { sessionId: string; targetUserId: number }) =>
        db.addSessionInstructor(sessionId, targetUserId, userId, isManager(user)),
    'academy:remove_session_instructor': async ({ userId, user, sessionId, targetUserId }: Actor & { sessionId: string; targetUserId: number }) =>
        db.removeSessionInstructor(sessionId, targetUserId, userId, isManager(user)),

    // ── Enrolment · progress · assessment ──────────────────────────────────────
    'academy:self_enroll': async ({ userId, sessionId }: Actor & { sessionId: string }) =>
        db.selfEnroll(sessionId, userId),
    'academy:assign_students': async ({ userId, user, sessionId, studentIds }: Actor & { sessionId: string; studentIds?: number[] }) =>
        db.assignStudents(sessionId, Array.isArray(studentIds) ? studentIds : [], userId, isManager(user)),

    // ── Enrolment requests (the ask-first path for gated sessions) ─────────────
    // The student is ALWAYS the caller: userId is dispatcher-forced (ACTOR_ID_FIELDS)
    // and there is no studentId in the payload to forge, so a member cannot lodge a
    // request in someone else's name.
    'academy:request_enrollment': async ({ userId, sessionId, message }: Actor & { sessionId: string; message?: unknown }) =>
        db.requestEnrollment(sessionId, userId, message),
    'academy:withdraw_enrollment_request': async ({ userId, requestId }: Actor & { requestId: string }) =>
        db.withdrawEnrollmentRequest(requestId, userId),
    // academy:instruct — and the db layer additionally proves the actor may run THIS
    // session (assertCanRunSession), so holding instruct on the org does not let a
    // stranger approve seats on a course they have nothing to do with.
    'academy:decide_enrollment_request': async ({ userId, user, requestId, decision, reason }: Actor & { requestId: string; decision: 'approve' | 'deny'; reason?: unknown }) =>
        db.decideEnrollmentRequest(requestId, decision === 'approve' ? 'approve' : 'deny', userId, isManager(user), reason),
    'academy:list_enrollment_requests': async ({ userId, user, sessionId }: Actor & { sessionId: string }) =>
        db.listEnrollmentRequests(sessionId, userId, isManager(user)),
    'academy:list_my_enrollment_requests': async ({ userId }: Actor) =>
        db.listMyEnrollmentRequests(userId),
    'academy:withdraw_enrollment': async ({ userId, user, enrollmentId }: Actor & { enrollmentId: string }) =>
        db.withdrawEnrollment(enrollmentId, userId, isManager(user)),
    'academy:mark_lesson': async ({ userId, user, enrollmentId, lessonId, completed }: Actor & { enrollmentId: string; lessonId: number; completed?: boolean }) =>
        db.markLesson(enrollmentId, lessonId, completed !== false, userId, isManager(user)),
    'academy:assess_outcome': async ({ userId, user, enrollmentId, outcomeId, verdict }: Actor & { enrollmentId: string; outcomeId: number; verdict: AcademyOutcomeVerdict }) =>
        db.assessOutcome(enrollmentId, outcomeId, verdict, userId, isManager(user)),
    'academy:recommend_certification': async ({ userId, user, enrollmentId }: Actor & { enrollmentId: string }) =>
        db.recommendForCertification(enrollmentId, userId, isManager(user)),
    'academy:withdraw_enrollments_bulk': async ({ userId, user, sessionId, enrollmentIds }: Actor & { sessionId: string; enrollmentIds?: string[] }) =>
        db.withdrawEnrollmentsBulk(sessionId, Array.isArray(enrollmentIds) ? enrollmentIds : [], userId, isManager(user)),
    'academy:recommend_enrollments_bulk': async ({ userId, user, sessionId, enrollmentIds }: Actor & { sessionId: string; enrollmentIds?: string[] }) =>
        db.recommendEnrollmentsBulk(sessionId, Array.isArray(enrollmentIds) ? enrollmentIds : [], userId, isManager(user)),
    'academy:certify_and_complete': async ({ userId, user, enrollmentId }: Actor & { enrollmentId: string }) =>
        db.certifyAndComplete(enrollmentId, userId, isAwarder(user)),

    // ── Reads ──────────────────────────────────────────────────────────────────
    'academy:get_course': async ({ courseId }: Actor & { courseId: string }) =>
        db.getCourseDetail(courseId),
    /**
     * The approve/reject trail for one course.
     *
     * Gated academy:instruct, NOT academy:view. The notes are staff commentary on
     * someone's work — a reviewer telling an author what is wrong with their course —
     * and academy:view is the wider read tier that exists so members can browse the
     * catalogue. The author sees their own feedback because authoring a course
     * requires academy:instruct in the first place.
     */
    'academy:list_course_reviews': async ({ courseId }: Actor & { courseId: string }) =>
        db.listCourseReviews(courseId),
    'academy:get_session': async ({ sessionId }: Actor & { sessionId: string }) =>
        db.getSessionDetail(sessionId),
    'academy:get_enrollment': async ({ userId, user, enrollmentId }: Actor & { enrollmentId: string }) =>
        db.getEnrollmentDetail(enrollmentId, userId, isViewer(user)),
    'academy:get_catalog_course': async ({ courseId }: Actor & { courseId: string }) =>
        db.getCatalogCourse(courseId),
    'academy:list_recommended': async () =>
        db.listRecommendedEnrollments(),

    // ── Learning-Manager reports (academy:manage) ─────────────────────────────
    // All four are READS of the sign-off trail. The permission map entries are the
    // authorization; the argument checks in the db layer are shape validation and an
    // existence probe, not access control.
    'academy:report_completions': async ({ sinceDays, limit }: Actor & { sinceDays?: unknown; limit?: unknown }) =>
        db.reportCompletions({ sinceDays, limit }),
    'academy:report_course_activity': async () =>
        db.reportCourseActivity(),
    'academy:report_cert_holders': async ({ certificationId }: Actor & { certificationId: number }) =>
        db.reportCertificationHolders(certificationId),
    // targetUserId is deliberately NOT an ACTOR_ID_FIELD — this report exists to read
    // somebody else's record, which is why it sits behind academy:manage.
    'academy:report_member_transcript': async ({ targetUserId }: Actor & { targetUserId: number }) =>
        db.reportMemberTranscript(targetUserId),
};
